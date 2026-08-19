const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const {
  handleConversation,
  pauseBot,
  resumeBot,
  isBotPaused,
  isResumeBotCommand,
  scheduleFollowUps,
  clearFollowUps,
  schedulePaymentReminder,
  rearmPendingReminders,
  updateBookingStatus
} = require('./services/conversationService');
const { RESET_WHATSAPP_SESSION, TEST_MODE_SELF_CHAT, ADVISOR_WHATSAPP_NUMBER } = require('./config/env');

const authPath = path.resolve(process.cwd(), '.wwebjs_auth');
if (RESET_WHATSAPP_SESSION) {
  try {
    fs.rmSync(authPath, { recursive: true, force: true });
    console.log('🧹 Sesión anterior limpiada porque RESET_WHATSAPP_SESSION=true.');
  } catch (error) {
    console.warn('⚠️ No se pudo limpiar la sesión anterior:', error.message);
  }
} else {
  console.log('ℹ️ Se conserva la sesión anterior de WhatsApp al reiniciar. Para borrarla, define RESET_WHATSAPP_SESSION=true.');
}

console.log(`🧪 Modo test self-chat: ${TEST_MODE_SELF_CHAT ? 'ACTIVADO' : 'DESACTIVADO'}`);

// Cuando el dashboard (dashboard/server.js) levanta este archivo como
// proceso hijo con IPC habilitado, process.send existe y podemos avisarle
// el estado en tiempo real (QR, listo, desconectado). Si se corre suelto
// (npm start, sin dashboard) process.send es undefined y esto no hace nada.
function ipcSend(type, data = {}) {
  if (typeof process.send === 'function') {
    try {
      process.send({ type, ...data });
    } catch (error) {
      // El proceso padre pudo haberse desconectado; no es crítico.
    }
  }
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }
});

client.on('qr', (qr) => {
  console.log('📱 Escanea este QR con WhatsApp:');
  qrcode.generate(qr, { small: true });
  ipcSend('qr', { qr });
});

// message_create se dispara tanto para tus mensajes manuales como para los
// que el propio bot envía con client.sendMessage() — no hay forma de
// distinguirlos por el evento en sí. Por eso, cada vez que EL BOT envía algo
// a un chat, lo marcamos aquí un momento; si llega un message_create fromMe
// para ese mismo chat mientras está marcado, sabemos que es nuestra propia
// respuesta (no una intervención tuya) y no debe pausar nada.
const botSendingTo = new Map(); // chatId -> cantidad de envíos del bot en curso
const BOT_SEND_GRACE_MS = 4000;

function markBotSending(chatId) {
  botSendingTo.set(chatId, (botSendingTo.get(chatId) || 0) + 1);
}
function markBotSendDone(chatId) {
  const remaining = (botSendingTo.get(chatId) || 1) - 1;
  if (remaining > 0) {
    botSendingTo.set(chatId, remaining);
    return;
  }
  // No se borra de inmediato: el evento message_create de este mismo envío
  // puede llegar con un poco de retraso respecto a cuando el Promise de
  // sendMessage se resuelve aquí.
  setTimeout(() => botSendingTo.delete(chatId), BOT_SEND_GRACE_MS);
}
function isBotCurrentlySendingTo(chatId) {
  return botSendingTo.has(chatId);
}

// Único punto para enviar mensajes salientes (respuestas directas,
// seguimientos automáticos, recordatorio de pago, resumen al asesor).
// SIEMPRE se debe usar esta función en vez de client.sendMessage()
// directo, para que el marcado de arriba funcione en todos los casos.
async function sendWhatsappMessage(chatId, content, options) {
  markBotSending(chatId);
  try {
    return await client.sendMessage(chatId, content, options);
  } finally {
    markBotSendDone(chatId);
  }
}

client.on('ready', () => {
  console.log('✅ Cliente de WhatsApp listo.');
  // Si el proceso se reinició con seguimientos o recordatorios de pago
  // pendientes (guardados en disco), los retoma con el tiempo restante.
  rearmPendingReminders(sendWhatsappMessage);
  ipcSend('ready', { info: client.info ? { pushname: client.info.pushname, wid: client.info.wid?._serialized } : null });
});

// Sin esto, si Puppeteer/WhatsApp Web pierde la conexión, el bot se queda
// callado indefinidamente hasta que alguien lo reinicie a mano.
//
// LOGOUT es un caso aparte: significa que la sesión ya no es válida (se
// desvinculó el dispositivo desde el teléfono, o WhatsApp la cerró). En ese
// caso NO hay que llamar a client.initialize() de nuevo — la sesión sigue
// muerta, así que solo repite el mismo LOGOUT (o, como pasó una vez, choca
// con la limpieza interna de whatsapp-web.js y tumba el proceso con un
// EBUSY al borrar el lockfile). Hace falta un QR nuevo: se reintenta solo
// para desconexiones recuperables (caída de red, etc.).
let reconnecting = false;
client.on('disconnected', (reason) => {
  console.warn(`⚠️ Cliente desconectado (${reason}).`);
  ipcSend('disconnected', { reason });

  if (reason === 'LOGOUT') {
    console.error(
      '❌ La sesión de WhatsApp se cerró (LOGOUT) y no es recuperable automáticamente. ' +
      'Reinicia el bot con RESET_WHATSAPP_SESSION=true para vincular un nuevo QR. No se reintentará solo.'
    );
    ipcSend('logout');
    return;
  }

  console.warn('Intentando reconectar en 10s...');
  if (reconnecting) return;
  reconnecting = true;
  setTimeout(() => {
    client.initialize()
      .catch((error) => console.error('❌ No se pudo reconectar:', error))
      .finally(() => { reconnecting = false; });
  }, 10000);
});

// A dónde se envía el "cuadro informativo" cuando el bot escala una
// conversación a un asesor humano. Si no hay un número aparte configurado
// (ADVISOR_WHATSAPP_NUMBER), se manda al propio chat del bot ("Mensajes a
// mí mismo"), ya que hoy solo hay un número/dispositivo para todo el negocio.
async function sendAdvisorSummary(summary) {
  const advisorChatId = ADVISOR_WHATSAPP_NUMBER || (client.info && client.info.wid && client.info.wid._serialized);
  if (!advisorChatId) {
    console.warn('⚠️ No se pudo determinar a quién enviar el resumen del asesor.');
    return;
  }
  try {
    await sendWhatsappMessage(advisorChatId, summary);
    console.log(`📋 Resumen del cliente enviado al asesor (${advisorChatId}).`);
  } catch (error) {
    console.error('❌ No se pudo enviar el resumen al asesor:', error);
  }
}

// Con la migración de WhatsApp a "LID", muchos chats llegan con un id tipo
// "60468928508029@lid" en vez del número de teléfono real (@c.us). Ese lid
// es un identificador interno de privacidad — armar un link wa.me con esos
// mismos dígitos NO es un número real y por eso "no está en WhatsApp".
// client.getContactLidAndPhone() resuelve el número real detrás del lid.
//
// Los resultados se cachean en memoria y en disco (data/contact-links.json)
// para no tener que resolver el mismo chat una y otra vez, y para que el
// panel pueda mostrar el link aunque el bot esté apagado en ese momento.
const CONTACT_LINKS_FILE = path.resolve(process.cwd(), 'data', 'contact-links.json');
const contactLinksCache = new Map();

function loadContactLinksFile() {
  try {
    return JSON.parse(fs.readFileSync(CONTACT_LINKS_FILE, 'utf8'));
  } catch (error) {
    return {};
  }
}
(function hydrateContactLinksCache() {
  Object.entries(loadContactLinksFile()).forEach(([chatId, link]) => contactLinksCache.set(chatId, link));
})();

function saveContactLink(chatId, link) {
  contactLinksCache.set(chatId, link);
  try {
    const links = loadContactLinksFile();
    links[chatId] = link;
    fs.mkdirSync(path.dirname(CONTACT_LINKS_FILE), { recursive: true });
    fs.writeFileSync(CONTACT_LINKS_FILE, JSON.stringify(links, null, 2), 'utf8');
  } catch (error) {
    console.warn('⚠️ No se pudo guardar data/contact-links.json:', error.message);
  }
}

async function resolveWorkingChatLink(chatId) {
  if (contactLinksCache.has(chatId)) return contactLinksCache.get(chatId);

  let link = null;
  if (!String(chatId).endsWith('@lid')) {
    const digits = String(chatId || '').replace(/\D/g, '');
    link = digits ? `https://wa.me/${digits}` : null;
  } else {
    try {
      const [resolved] = await client.getContactLidAndPhone([chatId]);
      const digits = String(resolved?.pn || '').replace(/\D/g, '');
      link = digits ? `https://wa.me/${digits}` : null;
    } catch (error) {
      console.warn(`⚠️ No se pudo resolver el número real de ${chatId}:`, error.message);
    }
  }

  if (link) saveContactLink(chatId, link);
  return link;
}

// Reemplaza la línea "💬 *Chat:* ..." del reporte (armada en
// conversationService.js con el id crudo) por un link wa.me que sí abre el
// chat de verdad, resolviendo el lid a número real cuando aplica.
async function fixAdvisorSummaryChatLink(summary, chatId) {
  const workingLink = await resolveWorkingChatLink(chatId);
  const replacement = workingLink
    ? `💬 *Chat:* ${workingLink}`
    : `💬 *Chat:* (no se pudo resolver un número; id interno: ${chatId})`;
  return summary.replace(/💬 \*Chat:\* .+/, replacement);
}

// message_create (no 'message'): 'message' de whatsapp-web.js SOLO se
// dispara para mensajes que NO son tuyos (Client.js hace `if (msg.id.fromMe)
// return;` antes de emitirlo). Con 'message' a secas, tus propios mensajes
// (fromMe=true) nunca llegaban a este handler, así que la pausa manual
// nunca se activaba. 'message_create' se dispara para ambos casos.
client.on('message_create', async (msg) => {
  const body = msg.body || '';
  console.log(`📩 Mensaje entrante: from=${msg.from}, type=${msg.type}, isGroupMsg=${msg.isGroupMsg || false}, body=${body}`);

  const shouldIgnore = body.trim() === '' || msg.from === 'status@broadcast' || msg.type === 'status';
  const isSelfMessage = msg.fromMe;
  const isGroupMessage = msg.isGroupMsg || msg.from.endsWith('@g.us');

  if (shouldIgnore) {
    console.log('⛔ Ignorado: mensaje vacío o tipo no procesado.');
    return;
  }

  if (isGroupMessage) {
    console.log('⛔ Ignorado: mensaje de grupo. El bot solo responde en chats privados.');
    return;
  }

  if (isSelfMessage && !TEST_MODE_SELF_CHAT) {
    // msg.to es el chat del cliente cuando el mensaje lo escribiste tú
    // (msg.from en ese caso es tu propio número, no sirve como chatId).
    const customerChatId = msg.to;

    // Esta es la propia respuesta automática del bot (recién enviada con
    // sendWhatsappMessage), no una intervención tuya: no debe pausar nada.
    if (isBotCurrentlySendingTo(customerChatId)) {
      console.log(`↩️ Ignorado: es una respuesta automática del bot para ${customerChatId}, no una intervención manual.`);
      return;
    }

    if (isResumeBotCommand(body)) {
      resumeBot(customerChatId);
      console.log(`✅ Bot reactivado manualmente para ${customerChatId}.`);
    } else {
      pauseBot(customerChatId);
      console.log(`⏸️ Bot pausado para ${customerChatId}: tomaste el chat manualmente.`);
    }
    return;
  }

  if (msg.type !== 'chat' && msg.type !== 'ptt' && msg.type !== 'audio') {
    console.log('⛔ Ignorado: solo se responden mensajes de texto.');
    return;
  }

  const paused = isBotPaused(msg.from);
  console.log(`🔎 Chequeo de pausa: msg.from=${msg.from} | ¿pausado?=${paused}`);
  if (paused) {
    console.log(`⛔ Ignorado: bot pausado manualmente para ${msg.from}.`);
    return;
  }

  const text = body.trim();
  const result = handleConversation(msg.from, text);
  const { reply, pdfPath, imagePath, escalatedToAdvisor, advisorSummary, final, awaitingComprobante } = result;
  console.log(`🔁 Respuesta seleccionada: ${reply || 'none'} | pdfPath: ${pdfPath || 'none'} | imagePath: ${imagePath || 'none'}`);

  // No se espera esta resolución (no debe frenar la respuesta al cliente):
  // así, con el tiempo, el panel tiene el link real de cada cliente listado
  // en "Clientes", no solo de los que llegaron a escalar.
  resolveWorkingChatLink(msg.from).catch(() => {});

  if (escalatedToAdvisor && advisorSummary) {
    const fixedSummary = await fixAdvisorSummaryChatLink(advisorSummary, msg.from);
    await sendAdvisorSummary(fixedSummary);
    ipcSend('escalated', { chatId: msg.from });
  }

  // Seguimiento automático (24h/3d/7d) si la conversación sigue abierta, y
  // recordatorio de pago si quedó esperando el comprobante. Antes esta
  // lógica existía en conversationService.js pero nunca se llamaba desde
  // aquí, así que nunca se enviaba nada.
  if (awaitingComprobante) {
    schedulePaymentReminder(msg.from, sendWhatsappMessage);
  }
  if (final) {
    clearFollowUps(msg.from);
  } else {
    scheduleFollowUps(msg.from, sendWhatsappMessage);
  }

  if (reply && !imagePath) {
    try {
      await sendWhatsappMessage(msg.from, reply);
      console.log(`✅ Respondido a ${msg.from}`);
    } catch (error) {
      console.error('❌ No se pudo enviar la respuesta:', error);
    }
  }

  if (pdfPath) {
    try {
      const media = MessageMedia.fromFilePath(pdfPath);
      await sendWhatsappMessage(msg.from, media, { caption: 'Adjunto nuestro catálogo en PDF.' });
      console.log(`✅ PDF enviado a ${msg.from}`);
    } catch (error) {
      console.error('❌ No se pudo enviar el PDF:', error);
    }
  }

  if (imagePath) {
    try {
      const media = MessageMedia.fromFilePath(imagePath);
      await sendWhatsappMessage(msg.from, media, { caption: reply || 'Adjunto una imagen.' });
      console.log(`✅ Imagen enviada a ${msg.from}`);
    } catch (error) {
      console.error('❌ No se pudo enviar la imagen:', error);
    }
  }
});

client.on('auth_failure', (message) => {
  console.error('❌ Error de autenticación:', message);
  ipcSend('auth_failure', { message });
});

// Comandos que el dashboard puede enviarle a este proceso por IPC (solo
// existe process.on('message') cuando lo lanzó el dashboard como hijo).
process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'resumeChat' && msg.chatId) {
    resumeBot(msg.chatId);
    console.log(`✅ Bot reactivado desde el panel para ${msg.chatId}.`);
    ipcSend('chatResumed', { chatId: msg.chatId });
  }
  // El panel no toca data/bot-state.json directamente (para no pisarse con
  // este proceso, que lo guarda periodicamente); por eso el pago/asistencia
  // que marca el asesor en la pestaña Agenda se manda por IPC hasta acá.
  if (msg.type === 'updateBookingStatus' && msg.bookingId) {
    const updated = updateBookingStatus(msg.bookingId, msg.patch || {});
    if (updated) console.log(`✅ Reserva ${msg.bookingId} actualizada desde el panel (pago=${updated.payment}, asistencia=${updated.attendanceConfirmed}).`);
    ipcSend('bookingStatusUpdated', { bookingId: msg.bookingId, ok: Boolean(updated) });
  }
});

// Cuando el estado llega a LOGOUT, whatsapp-web.js intenta limpiar la
// sesión internamente (LocalAuth.logout(), Client.js) SIN pasar por
// nuestro manejador de 'disconnected' de arriba. En Windows, Chrome a
// veces no libera el archivo del todo rápido, y ese borrado falla con
// EBUSY. La sesión de todas formas ya quedó inválida (por eso avisamos
// arriba que hace falta un QR nuevo); dejar que esto tumbe el proceso solo
// agrega un crash extra y, peor, puede ser justo lo que deja el lockfile
// en mal estado para el siguiente arranque. Se ignora puntualmente.
function isBenignLockfileCleanupError(reason) {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.includes('EBUSY') && message.toLowerCase().includes('lockfile');
}

// Red de seguridad: otros errores internos de whatsapp-web.js/Puppeteer
// pueden escapar como excepción no capturada y tumbar el proceso con una
// traza cruda. Esto al menos deja un log claro antes de salir; con
// `node --watch` el proceso vuelve a levantar solo en el siguiente cambio
// de archivo, y con un gestor de procesos (pm2, servicio de Windows) se
// reiniciaría solo.
process.on('uncaughtException', (error) => {
  if (isBenignLockfileCleanupError(error)) {
    console.warn('⚠️ No se pudo borrar el lockfile durante la limpieza interna de la sesión (no crítico):', error.message);
    return;
  }
  console.error('❌ Error no capturado, cerrando el proceso:', error);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  if (isBenignLockfileCleanupError(reason)) {
    console.warn('⚠️ No se pudo borrar el lockfile durante la limpieza interna de la sesión (no crítico):', reason instanceof Error ? reason.message : reason);
    return;
  }
  console.error('❌ Promesa rechazada sin capturar, cerrando el proceso:', reason);
  process.exit(1);
});

client.initialize().catch((error) => {
  console.error('❌ Error al iniciar cliente:', error);
});

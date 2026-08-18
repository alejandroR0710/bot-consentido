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
  rearmPendingReminders
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
});

// Único punto para enviar mensajes salientes que no son la respuesta directa
// a un mensaje entrante (seguimientos automáticos, recordatorio de pago).
const sendWhatsappMessage = (chatId, text) => client.sendMessage(chatId, text);

client.on('ready', () => {
  console.log('✅ Cliente de WhatsApp listo.');
  // Si el proceso se reinició con seguimientos o recordatorios de pago
  // pendientes (guardados en disco), los retoma con el tiempo restante.
  rearmPendingReminders(sendWhatsappMessage);
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

  if (reason === 'LOGOUT') {
    console.error(
      '❌ La sesión de WhatsApp se cerró (LOGOUT) y no es recuperable automáticamente. ' +
      'Reinicia el bot con RESET_WHATSAPP_SESSION=true para vincular un nuevo QR. No se reintentará solo.'
    );
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
    await client.sendMessage(advisorChatId, summary);
    console.log(`📋 Resumen del cliente enviado al asesor (${advisorChatId}).`);
  } catch (error) {
    console.error('❌ No se pudo enviar el resumen al asesor:', error);
  }
}

client.on('message', async (msg) => {
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

  if (isBotPaused(msg.from)) {
    console.log(`⛔ Ignorado: bot pausado manualmente para ${msg.from}.`);
    return;
  }

  const text = body.trim();
  const result = handleConversation(msg.from, text);
  const { reply, pdfPath, imagePath, escalatedToAdvisor, advisorSummary, final, awaitingComprobante } = result;
  console.log(`🔁 Respuesta seleccionada: ${reply || 'none'} | pdfPath: ${pdfPath || 'none'} | imagePath: ${imagePath || 'none'}`);

  if (escalatedToAdvisor && advisorSummary) {
    await sendAdvisorSummary(advisorSummary);
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
      await client.sendMessage(msg.from, reply);
      console.log(`✅ Respondido a ${msg.from}`);
    } catch (error) {
      console.error('❌ No se pudo enviar la respuesta:', error);
    }
  }

  if (pdfPath) {
    try {
      const media = MessageMedia.fromFilePath(pdfPath);
      await client.sendMessage(msg.from, media, { caption: 'Adjunto nuestro catálogo en PDF.' });
      console.log(`✅ PDF enviado a ${msg.from}`);
    } catch (error) {
      console.error('❌ No se pudo enviar el PDF:', error);
    }
  }

  if (imagePath) {
    try {
      const media = MessageMedia.fromFilePath(imagePath);
      await client.sendMessage(msg.from, media, { caption: reply || 'Adjunto una imagen.' });
      console.log(`✅ Imagen enviada a ${msg.from}`);
    } catch (error) {
      console.error('❌ No se pudo enviar la imagen:', error);
    }
  }
});

client.on('auth_failure', (message) => {
  console.error('❌ Error de autenticación:', message);
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

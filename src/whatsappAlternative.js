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
let reconnecting = false;
client.on('disconnected', (reason) => {
  console.warn(`⚠️ Cliente desconectado (${reason}). Intentando reconectar en 10s...`);
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

client.initialize().catch((error) => {
  console.error('❌ Error al iniciar cliente:', error);
});

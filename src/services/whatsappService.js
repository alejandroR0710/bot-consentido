const fs = require('fs/promises');
const path = require('path');
const {
  DisconnectReason,
  useMultiFileAuthState,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const makeWASocket = require('@whiskeysockets/baileys').default;
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { extractTextFromMessage } = require('../utils/messageUtils');
const {
  handleConversation,
  scheduleFollowUps,
  clearFollowUps,
  schedulePaymentReminder,
  clearPaymentReminder,
  rearmPendingReminders,
} = require('./conversationService');
const { AUTH_DIR, BOT_NAME, ADVISOR_WHATSAPP_NUMBER } = require('../config/env');

let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

function scheduleReconnect(startBot) {
  if (reconnectTimer || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot().catch(console.error);
  }, 3000);
}
async function resetAuth(authPath) {
  try { await fs.rm(authPath, { recursive: true, force: true }); } catch (err) { console.error(err); }
}
function getMessageMeta(messageContent) {
  if (!messageContent) return { hasMedia: false, mediaType: null };
  if (messageContent.imageMessage) return { hasMedia: true, mediaType: 'image' };
  if (messageContent.documentMessage) return { hasMedia: true, mediaType: 'document' };
  if (messageContent.videoMessage) return { hasMedia: true, mediaType: 'video' };
  if (messageContent.ephemeralMessage?.message) return getMessageMeta(messageContent.ephemeralMessage.message);
  return { hasMedia: false, mediaType: null };
}
function normalizeAdvisorJid(sock) {
  if (ADVISOR_WHATSAPP_NUMBER) {
    const digits = String(ADVISOR_WHATSAPP_NUMBER).replace(/\D/g, '');
    return digits ? `${digits}@s.whatsapp.net` : null;
  }
  return sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
}

async function startBot() {
  const authPath = path.resolve(process.cwd(), AUTH_DIR);
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: [BOT_NAME, 'Chrome', '1.0.0'],
    syncFullHistory: false,
  });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('📱 Escanea el siguiente QR:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      reconnectAttempts = 0;
      console.log('✅ Bot conectado correctamente.');
      const sendMessage = async (chatId, messageText) => sock.sendMessage(chatId, { text: messageText });
      rearmPendingReminders(sendMessage);
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === 405 || statusCode === DisconnectReason.badSession || statusCode === DisconnectReason.connectionReplaced) {
        await resetAuth(authPath);
      }
      if (statusCode !== DisconnectReason.loggedOut) scheduleReconnect(startBot);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const message of messages) {
      try {
        if (!message.message || message.key.fromMe) continue;
        const from = message.key.remoteJid;
        if (!from || from === 'status@broadcast' || from.endsWith('@g.us')) continue;
        const type = Object.keys(message.message)[0];
        const ignoredTypes = [
          'protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo',
          'notification_template', 'e2e_notification', 'reactionMessage',
          'pollUpdateMessage', 'historySyncNotification',
        ];
        if (ignoredTypes.includes(type)) continue;

        const text = extractTextFromMessage(message.message) || '';
        const meta = getMessageMeta(message.message);
        // IMPORTANTE: no ignorar una imagen/documento sin caption. Puede ser un comprobante.
        if (!text.trim() && !meta.hasMedia) continue;

        const reply = handleConversation(from, text, meta) || {};
        const sendMessage = async (chatId, messageText) => sock.sendMessage(chatId, { text: messageText });

        if (reply.reply) await sendMessage(from, reply.reply);
        if (reply.pdfPath) {
          try {
            const pdfBuffer = await fs.readFile(reply.pdfPath);
            await sock.sendMessage(from, { document: pdfBuffer, fileName: path.basename(reply.pdfPath), mimetype: 'application/pdf' });
          } catch (err) { console.error('❌ No se pudo enviar PDF:', err.message); }
        }
        if (reply.imagePath) {
          try {
            const imageBuffer = await fs.readFile(reply.imagePath);
            await sock.sendMessage(from, { image: imageBuffer });
          } catch (err) { console.error('❌ No se pudo enviar imagen:', err.message); }
        }

        // Antes el servicio producia advisorSummary pero whatsappService no lo enviaba.
        if (reply.escalatedToAdvisor && reply.advisorSummary) {
          const advisorJid = normalizeAdvisorJid(sock);
          if (advisorJid) await sendMessage(advisorJid, reply.advisorSummary);
          else console.warn('⚠️ No se pudo resolver el chat del asesor. Configura ADVISOR_WHATSAPP_NUMBER.');
        }

        if (reply.awaitingComprobante) {
          schedulePaymentReminder(from, sendMessage);
        } else if (reply.final) {
          clearFollowUps(from);
          clearPaymentReminder(from);
        } else {
          scheduleFollowUps(from, sendMessage);
        }
      } catch (err) {
        console.error('❌ Error procesando mensaje:', err);
      }
    }
  });
}

module.exports = { startBot };

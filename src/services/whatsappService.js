const fs = require('fs/promises');
const path = require('path');
const { DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const makeWASocket = require('@whiskeysockets/baileys').default;
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const { extractTextFromMessage } = require('../utils/messageUtils');
const {
    handleConversation,
    scheduleFollowUps,
    clearFollowUps,
    schedulePaymentReminder,
    clearPaymentReminder
} = require('./conversationService');
const { AUTH_DIR, BOT_NAME } = require('../config/env');

let reconnectTimer = null;
let reconnectAttempts = 0;

const MAX_RECONNECT_ATTEMPTS = 5;

function scheduleReconnect(startBot) {
    if (reconnectTimer || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {

        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.log("⚠️ Se alcanzó el máximo de reconexiones.");
        }

        return;
    }

    reconnectAttempts++;

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;

        console.log(`🔄 Reconectando... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

        startBot().catch(console.error);

    }, 3000);
}

async function resetAuth(authPath) {

    try {

        await fs.rm(authPath, {
            recursive: true,
            force: true
        });

        console.log("🧹 Sesión eliminada.");

    } catch (err) {

        console.error(err);

    }

}

async function startBot() {

    const authPath = path.resolve(process.cwd(), AUTH_DIR);

    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const sock = makeWASocket({

        auth: state,

        logger: pino({
            level: "silent"
        }),

        browser: [BOT_NAME, "Chrome", "1.0.0"],

        syncFullHistory: false

    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {

        const {
            connection,
            lastDisconnect,
            qr
        } = update;

        if (qr) {

            console.log("📱 Escanea el siguiente QR:\n");

            qrcode.generate(qr, {
                small: true
            });

        }

        if (connection === "connecting") {

            console.log("🔄 Conectando...");

        }

        if (connection === "open") {

            reconnectAttempts = 0;

            console.log("✅ Bot conectado correctamente.");

        }

        if (connection === "close") {

            const statusCode = lastDisconnect?.error?.output?.statusCode;

            console.log("❌ Conexión cerrada:", statusCode);

            if (
                statusCode === 405 ||
                statusCode === DisconnectReason.badSession ||
                statusCode === DisconnectReason.connectionReplaced
            ) {

                await resetAuth(authPath);

            }

            if (statusCode !== DisconnectReason.loggedOut) {

                scheduleReconnect(startBot);

            }

        }

    });

    sock.ev.on("messages.upsert", async ({ messages }) => {

        for (const message of messages) {

            try {

                if (!message.message)
                    continue;

                if (message.key.fromMe)
                    continue;

                const from = message.key.remoteJid;

                if (!from)
                    continue;

                // Ignorar estados
                if (from === "status@broadcast")
                    continue;

                // Ignorar grupos
                if (from.endsWith("@g.us"))
                    continue;

                // Tipo de mensaje
                const type = Object.keys(message.message)[0];

                // Ignorar eventos internos
                const ignoredTypes = [
                    "protocolMessage",
                    "senderKeyDistributionMessage",
                    "messageContextInfo",
                    "notification_template",
                    "e2e_notification",
                    "reactionMessage",
                    "pollUpdateMessage",
                    "historySyncNotification"
                ];

                if (ignoredTypes.includes(type))
                    continue;

                // Extraer texto
                const text = extractTextFromMessage(message.message);

                // Si no contiene texto, ignorar
                if (!text || !text.trim())
                    continue;

                console.log("====================================");
                console.log("📩 Nuevo mensaje");
                console.log("De :", from);
                console.log("Tipo :", type);
                console.log("Texto :", text);
                console.log("====================================");

                const reply = handleConversation(from, text);

                const sendMessage = async (chatId, messageText) => {
                    await sock.sendMessage(chatId, { text: messageText });
                };

                if (reply.reply) {
                    await sendMessage(from, reply.reply);
                }

                if (reply.pdfPath) {
                    try {
                        const pdfBuffer = await fs.readFile(reply.pdfPath);
                        await sock.sendMessage(from, {
                            document: pdfBuffer,
                            fileName: path.basename(reply.pdfPath),
                            mimetype: 'application/pdf'
                        });
                        console.log('✅ PDF enviado:', reply.pdfPath);
                    } catch (err) {
                        console.error('❌ No se pudo enviar el PDF:', reply.pdfPath, err);
                    }
                }

                if (reply.imagePath) {
                    try {
                        const imageBuffer = await fs.readFile(reply.imagePath);
                        await sock.sendMessage(from, { image: imageBuffer });
                        console.log('✅ Imagen enviada:', reply.imagePath);
                    } catch (err) {
                        console.error('❌ No se pudo enviar la imagen:', reply.imagePath, err);
                    }
                }

                if (reply.awaitingComprobante) {
                    schedulePaymentReminder(from, sendMessage);
                } else if (reply.final) {
                    clearFollowUps(from);
                    clearPaymentReminder(from);
                } else {
                    scheduleFollowUps(from, sendMessage);
                }

                if (!reply.reply && !reply.pdfPath && !reply.imagePath) {
                    continue;
                }

                console.log("✅ Respuesta enviada.");

            } catch (err) {

                console.error("❌ Error procesando mensaje:", err);

            }

        }

    });

}

module.exports = {
    startBot
};
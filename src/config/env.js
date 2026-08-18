const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const parseBoolean = (value) => ['true', '1', 'yes', 'on'].includes(String(value || '').toLowerCase());

module.exports = {
  BOT_NAME: process.env.BOT_NAME || 'MiBot',
  DEFAULT_RESPONSE: process.env.DEFAULT_RESPONSE || 'Gracias por tu mensaje. Responderé pronto.',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  AUTH_DIR: process.env.AUTH_DIR || 'auth_info',
  RESET_WHATSAPP_SESSION: parseBoolean(process.env.RESET_WHATSAPP_SESSION ?? 'false'),
  TEST_MODE_SELF_CHAT: parseBoolean(process.env.TEST_MODE_SELF_CHAT ?? 'true'),
  GROUP_INVITE_URL: process.env.GROUP_INVITE_URL || 'https://chat.whatsapp.com/DWXXjF5RQCo5tXPnSocQK6?mode=gi_t',
  // Opcional: si en el futuro tienes un número/dispositivo aparte para
  // asesores, defínelo aquí (formato "57300...@c.us"). Si se deja vacío, el
  // resumen del cliente se envía a tu propio chat ("Mensajes a mí mismo"),
  // ya que hoy solo hay un número/dispositivo para todo.
  ADVISOR_WHATSAPP_NUMBER: process.env.ADVISOR_WHATSAPP_NUMBER || ''
};

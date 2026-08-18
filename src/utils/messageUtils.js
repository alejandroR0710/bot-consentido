function extractTextFromMessage(message) {
  if (!message) {
    return '';
  }

  if (message.conversation) {
    return message.conversation;
  }

  if (message.extendedTextMessage?.text) {
    return message.extendedTextMessage.text;
  }

  if (message.imageMessage?.caption) {
    return message.imageMessage.caption;
  }

  if (message.videoMessage?.caption) {
    return message.videoMessage.caption;
  }

  if (message.documentMessage?.caption) {
    return message.documentMessage.caption;
  }

  if (message.ephemeralMessage?.message) {
    return extractTextFromMessage(message.ephemeralMessage.message);
  }

  return '';
}

module.exports = {
  extractTextFromMessage
};

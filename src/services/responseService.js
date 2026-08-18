// Añade nuevas reglas aquí para ampliar las respuestas automáticas.
const responseRules = [
  {
    keywords: ['hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'hey', 'hi'],
    response: '¡Hola! ¿En qué puedo ayudarte hoy?'
  },
  {
    keywords: ['precio', 'costo', 'cuanto cuesta', 'precio del servicio', 'valor'],
    response: 'Podemos adaptar un plan a tus necesidades. Cuéntame un poco más para orientarte mejor.'
  },
  {
    keywords: ['horario', 'atencion', 'abierto', 'cuando atienden'],
    response: 'Atendemos en horarios flexibles. Si me dices tu zona o tu necesidad, te ayudo mejor.'
  },
  {
    keywords: ['gracias', 'thank you', 'muchas gracias'],
    response: '¡De nada! Estoy aquí para ayudarte.'
  },
  {
    keywords: ['ayuda', 'soporte', 'problema', 'reclamo'],
    response: 'Voy a ayudarte con tu solicitud. Describe brevemente el problema para orientarte mejor.'
  }
];

function getAutoReply(messageText) {
  if (!messageText) {
    return null;
  }

  const normalized = messageText
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const matchedRule = responseRules.find((rule) =>
    rule.keywords.some((keyword) => {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'i');
      return regex.test(normalized);
    })
  );

  if (!matchedRule) {
    console.log('🔎 No se encontró regla para:', normalized);
    return null;
  }

  return matchedRule.response;
}

module.exports = {
  responseRules,
  getAutoReply
};
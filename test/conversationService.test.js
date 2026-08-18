// Pruebas de comportamiento/lógica del bot (node --test, sin dependencias
// nuevas). No verifican el tono exacto de cada mensaje guardado: verifican
// que el flujo tome la rama correcta (saluda vs. escala, guarda vs. ignora,
// etc.), para detectar regresiones futuras en la lógica sin frenar cambios
// de redacción.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// Aísla el archivo de estado de estas pruebas del archivo real de
// producción (data/bot-state.json) ANTES de requerir conversationService,
// porque la ruta se resuelve al cargar el módulo.
const TEST_STATE_FILE = path.resolve(__dirname, '.tmp-test-state.json');
process.env.BOT_STATE_FILE = TEST_STATE_FILE;
fs.rmSync(TEST_STATE_FILE, { force: true });

const {
  handleConversation,
  pauseBot,
  resumeBot,
  isBotPaused,
  isResumeBotCommand
} = require('../src/services/conversationService');
const { GROUP_INVITE_URL } = require('../src/config/env');

test.after(() => {
  fs.rmSync(TEST_STATE_FILE, { force: true });
});

// Formato parecido a un chat real (dígitos + "@c.us") para que las
// aserciones sobre el link wa.me sean deterministas: un id de prueba sin
// ningún dígito haría que buildChatLink no generara el link.
function uniqueChatId(label) {
  const digits = String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
  return `${label}_57${digits}@c.us`;
}

test('saludo inicial pide el nombre', () => {
  const chat = uniqueChatId('saludo');
  const r = handleConversation(chat, 'hola');
  assert.match(r.reply, /nombre/i);
});

test('grupo al inicio de la conversacion envia la invitacion al grupo', () => {
  const chat = uniqueChatId('grupo');
  const r = handleConversation(chat, 'grupo');
  assert.ok(r.reply.includes(GROUP_INVITE_URL));
});

test('grupal (modalidad de clase) NO se confunde con el pedido de grupo', () => {
  const chat = uniqueChatId('grupal');
  const r = handleConversation(chat, 'grupal');
  assert.ok(!(r.reply || '').includes(GROUP_INVITE_URL));
});

test('mensaje sin ninguna coincidencia no envia un mensaje generico repetitivo', () => {
  const chat = uniqueChatId('silencio');
  const r = handleConversation(chat, 'xzqwplkjasdfghqwerty123');
  assert.equal(r.reply, null);
});

test('personalizado: responde con confirmacion antes de escalar, y escala solo con "1"', () => {
  const chat = uniqueChatId('personalizado');
  handleConversation(chat, 'hola');
  handleConversation(chat, 'Lili');
  handleConversation(chat, 'talleres');
  const infoReply = handleConversation(chat, 'quiero algo completamente personalizado');
  assert.ok(!infoReply.escalatedToAdvisor, 'no debe escalar antes de confirmar');
  assert.match(infoReply.reply, /reservar tu cupo/i);

  const confirmReply = handleConversation(chat, '1');
  assert.equal(confirmReply.escalatedToAdvisor, true);
  assert.ok(confirmReply.advisorSummary.includes('https://wa.me/'));
});

test('personalizado: "aun tengo preguntas" no escala y regresa al menu', () => {
  const chat = uniqueChatId('personalizado_no');
  handleConversation(chat, 'hola');
  handleConversation(chat, 'Marco');
  handleConversation(chat, 'talleres');
  handleConversation(chat, 'quiero algo completamente personalizado');
  const r = handleConversation(chat, 'aun tengo algunas preguntas');
  assert.ok(!r.escalatedToAdvisor);
  assert.match(r.reply, /1\.\s*Talleres/i);
});

test('un saludo a mitad de flujo no se guarda como respuesta ni avanza el flujo', () => {
  const chat = uniqueChatId('saludo_mitad');
  handleConversation(chat, 'hola');
  handleConversation(chat, 'Rita');
  const pregunta = handleConversation(chat, 'club creativo');
  const interrupcion = handleConversation(chat, 'hola');
  assert.equal(interrupcion.reply, `¡Hola de nuevo! 😊 ${pregunta.reply}`);
});

test('pedir "menu principal" a mitad de flujo lleva al menu en vez de interpretarse como respuesta', () => {
  const chat = uniqueChatId('menu_mitad');
  handleConversation(chat, 'hola');
  handleConversation(chat, 'Andres');
  handleConversation(chat, '1'); // talleres
  handleConversation(chat, '2'); // ya hago velas -> avanzado
  handleConversation(chat, '2'); // contenido -> pide presupuesto
  const r = handleConversation(chat, 'Menu principal');
  assert.match(r.reply, /1\.\s*Talleres/i);
});

test('decir que se equivoco de opcion repite la pregunta en vez de guardarla como dato', () => {
  const chat = uniqueChatId('correccion');
  handleConversation(chat, 'hola');
  handleConversation(chat, 'Andres');
  handleConversation(chat, '1'); // talleres
  handleConversation(chat, '2'); // ya hago velas -> avanzado
  const pregunta = handleConversation(chat, '2'); // contenido -> pide presupuesto
  const r = handleConversation(chat, 'Le di al número q no era');
  assert.equal(r.reply, `¡Sin problema! 😊 ${pregunta.reply}`);
});

test('escalar dos veces seguidas para el mismo chat no repite el aviso al asesor (cooldown)', () => {
  const chat = uniqueChatId('cooldown');
  const primera = handleConversation(chat, 'quiero comprar al por mayor');
  assert.equal(primera.escalatedToAdvisor, true);
  assert.ok(primera.advisorSummary);

  const segunda = handleConversation(chat, 'quiero comprar al por mayor');
  assert.equal(segunda.escalatedToAdvisor, true);
  assert.equal(segunda.advisorSummary, null);
});

test('pausar y reactivar el bot por chat', () => {
  const chat = uniqueChatId('pausa');
  assert.equal(isBotPaused(chat), false);
  pauseBot(chat);
  assert.equal(isBotPaused(chat), true);
  resumeBot(chat);
  assert.equal(isBotPaused(chat), false);
});

test('isResumeBotCommand reconoce las palabras clave de reactivacion', () => {
  assert.equal(isResumeBotCommand('bot on'), true);
  assert.equal(isResumeBotCommand('Activar Bot'), true);
  assert.equal(isResumeBotCommand('hola, como estan?'), false);
});

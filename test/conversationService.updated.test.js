const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

process.env.BOT_STATE_FILE = path.resolve(__dirname, '.tmp-bot-state.json');
fs.rmSync(process.env.BOT_STATE_FILE, { force: true });

const { handleConversation } = require('../src/services/conversationService');
function chat(label) { return `${label}_${Date.now()}_${Math.floor(Math.random()*100000)}@s.whatsapp.net`; }
function start(c, name='Lili') { handleConversation(c, 'hola'); handleConversation(c, name); }

test.after(() => fs.rmSync(process.env.BOT_STATE_FILE, { force: true }));

test('flujo 1: principiante recibe MasterClass Basico sin preguntas de ciudad o presupuesto', () => {
  const c = chat('basic'); start(c);
  handleConversation(c, '1');
  const r = handleConversation(c, '1');
  assert.match(r.reply, /MasterClass Basico/i);
  assert.match(r.reply, /250/);
  assert.doesNotMatch(r.reply, /ciudad|presupuesto/i);
});

test('flujo 1: avanzado describe las tres tecnicas correctas y vale 300 mil', () => {
  const c = chat('advanced'); start(c);
  handleConversation(c, '1');
  const r = handleConversation(c, '2');
  assert.match(r.reply, /masaje/i);
  assert.match(r.reply, /cera gel/i);
  assert.match(r.reply, /Chantilly/i);
  assert.match(r.reply, /300/);
});

test('flujo 2: experiencia informa primero y pregunta ocasion', () => {
  const c = chat('experience'); start(c);
  const r = handleConversation(c, '2');
  assert.match(r.reply, /120/);
  assert.match(r.reply, /Momento Con Sentido/i);
  assert.match(r.reply, /ocasion/i);
});

test('flujo 2: cumpleaños ofrece decoracion y torta despues de personas, fecha y jornada', () => {
  const c = chat('birthday'); start(c);
  handleConversation(c, '2');
  handleConversation(c, 'cumpleaños de mi mama');
  handleConversation(c, '4 personas');
  const askJornada = handleConversation(c, '26 de septiembre');
  assert.match(askJornada.reply, /jornada/i);
  const r = handleConversation(c, '1'); // jornada: manana
  assert.match(r.reply, /Decoracion/i);
  assert.match(r.reply, /Torta/i);
});

test('flujo 3: insumos tiene cuatro rutas', () => {
  const c = chat('supplies'); start(c);
  const r = handleConversation(c, '3');
  assert.match(r.reply, /Fragancias/i);
  assert.match(r.reply, /Quiero hacer un pedido/i);
  assert.match(r.reply, /asesoria/i);
});

test('flujo 3: mensajero lo solicita el cliente y pide nombre, placa y codigo', () => {
  const c = chat('courier'); start(c);
  handleConversation(c, '3');
  handleConversation(c, '3');
  handleConversation(c, '2 kg de cera');
  handleConversation(c, '1');
  const r = handleConversation(c, '2');
  assert.match(r.reply, /no solicita el domicilio/i);
  assert.match(r.reply, /nombre del conductor/i);
});

test('comprobante puede llegar como imagen sin texto', () => {
  const c = chat('receipt'); start(c);
  handleConversation(c, '1');
  handleConversation(c, '1');
  // Forzamos intencion de pago, luego nombre de reserva.
  handleConversation(c, 'quiero reservar');
  handleConversation(c, 'Lili Rojas');
  const r = handleConversation(c, '', { hasMedia: true, mediaType: 'image' });
  assert.equal(r.escalatedToAdvisor, true);
  assert.match(r.reply, /comprobante/i);
});

// Persistencia mínima en disco (un archivo JSON) para que sesiones, perfiles
// de contacto, chats pausados y recordatorios pendientes sobrevivan a un
// reinicio del proceso. No es una base de datos: para el volumen de un solo
// negocio, un archivo JSON con guardado periódico es suficiente y evita
// depender de infraestructura extra.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
// BOT_STATE_FILE permite apuntar a un archivo aparte (ej. en las pruebas
// automatizadas), para nunca leer ni sobrescribir los datos reales del
// negocio por accidente.
const STATE_FILE = process.env.BOT_STATE_FILE || path.join(DATA_DIR, 'bot-state.json');

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn('⚠️ No se pudo guardar el estado en disco:', err.message);
  }
}

module.exports = { loadState, saveState };

// Panel de administración web del bot. Corre como proceso APARTE del bot
// (lo arranca/detiene como hijo con IPC), así que el dashboard sigue vivo
// aunque el bot se caiga o lo reinicies. Acceso solo local por defecto
// (http://localhost:PUERTO), con login usuario/clave.
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const express = require('express');
const session = require('express-session');
const QRCode = require('qrcode');

const {
  DASHBOARD_USER,
  DASHBOARD_PASSWORD,
  DASHBOARD_PORT,
  DASHBOARD_SESSION_SECRET
} = require('../src/config/env');
const { formatDateEs, isPastIsoDate } = require('../src/utils/dateEs');

const ROOT_DIR = path.resolve(__dirname, '..');
const BOT_ENTRY = path.join(ROOT_DIR, 'src', 'index.js');
const STATE_FILE = path.join(ROOT_DIR, 'data', 'bot-state.json');
const ENV_FILE = path.join(ROOT_DIR, '.env');
const LOCKFILE = path.join(ROOT_DIR, '.wwebjs_auth', 'session', 'lockfile');
const SCHEDULE_DATES_FILE = path.join(ROOT_DIR, 'data', 'schedule-dates.json');
const CONTACT_LINKS_FILE = path.join(ROOT_DIR, 'data', 'contact-links.json');

// El único taller que sigue usando una lista fija de "próximas fechas" es
// el Básico grupal. Avanzado y Personalizado son clases personalizadas: ya
// no se les fija fecha aquí, se agendan por disponibilidad real (ver
// BOOKING_WORKSHOP_LABELS y /api/bookings más abajo).
const WORKSHOP_LABELS = {
  basicGroup: 'MasterClass Básico (grupal)'
};

// Talleres que usan la agenda por disponibilidad (cupo compartido de 2 por
// día+jornada, calculado en conversationService.js). Solo para mostrar
// etiquetas legibles en el calendario del panel.
const BOOKING_WORKSHOP_LABELS = {
  advanced: 'MasterClass Avanzado',
  basicPersonalized: 'MasterClass Básico Personalizado'
};

if (!DASHBOARD_PASSWORD) {
  console.error('❌ Falta DASHBOARD_PASSWORD en tu .env. Define un usuario/clave antes de levantar el panel.');
  process.exit(1);
}
if (!DASHBOARD_SESSION_SECRET) {
  console.error('❌ Falta DASHBOARD_SESSION_SECRET en tu .env (cualquier texto largo al azar).');
  process.exit(1);
}

// =============================================================================
// ESTADO DEL PROCESO DEL BOT (hijo con IPC)
// =============================================================================

let botProcess = null;
let botStatus = 'stopped'; // stopped | starting | qr | ready | disconnected | logout
let lastQr = null;
let lastInfo = null;
let lastDisconnectReason = null;

const LOG_LIMIT = 2000;
const logBuffer = [];

function appendLog(text) {
  logBuffer.push({ text, ts: Date.now() });
  if (logBuffer.length > LOG_LIMIT) logBuffer.shift();
}

function clearStaleLockfile() {
  try {
    if (fs.existsSync(LOCKFILE)) {
      fs.unlinkSync(LOCKFILE);
      appendLog('[panel] Se encontró y eliminó un lockfile residual antes de iniciar.');
    }
  } catch (error) {
    appendLog(`[panel] No se pudo revisar/borrar el lockfile: ${error.message}`);
  }
}

function startBot() {
  if (botProcess) {
    appendLog('[panel] Ya hay un proceso del bot corriendo, no se inicia otro.');
    return;
  }
  clearStaleLockfile();
  botStatus = 'starting';
  lastQr = null;
  lastDisconnectReason = null;
  appendLog('[panel] Iniciando el bot...');

  const child = fork(BOT_ENTRY, [], {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  botProcess = child;

  const pipeToLog = (stream) => {
    stream.on('data', (chunk) => {
      String(chunk).split('\n').filter((l) => l.trim().length > 0).forEach(appendLog);
    });
  };
  pipeToLog(child.stdout);
  pipeToLog(child.stderr);

  child.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'qr':
        botStatus = 'qr';
        lastQr = msg.qr;
        appendLog('[panel] Se generó un nuevo código QR para vincular.');
        break;
      case 'ready':
        botStatus = 'ready';
        lastQr = null;
        lastInfo = msg.info || null;
        appendLog('[panel] El bot quedó conectado y listo.');
        break;
      case 'disconnected':
        botStatus = 'disconnected';
        lastDisconnectReason = msg.reason || null;
        appendLog(`[panel] El bot se desconectó (${msg.reason}).`);
        break;
      case 'logout':
        botStatus = 'logout';
        appendLog('[panel] La sesión de WhatsApp se cerró (LOGOUT). Hace falta un QR nuevo.');
        break;
      case 'auth_failure':
        appendLog(`[panel] Falló la autenticación: ${msg.message}`);
        break;
      case 'escalated':
        appendLog(`[panel] Conversación escalada a asesor: ${msg.chatId}`);
        break;
      case 'chatResumed':
        appendLog(`[panel] Chat reactivado manualmente desde el panel: ${msg.chatId}`);
        break;
      default:
        break;
    }
  });

  child.on('exit', (code, signal) => {
    appendLog(`[panel] El proceso del bot terminó (código=${code}, señal=${signal || 'ninguna'}).`);
    botProcess = null;
    botStatus = 'stopped';
    lastQr = null;
  });

  child.on('error', (error) => {
    appendLog(`[panel] Error al iniciar el proceso del bot: ${error.message}`);
  });
}

function stopBot() {
  if (!botProcess) {
    appendLog('[panel] No hay ningún proceso del bot corriendo.');
    return;
  }
  appendLog('[panel] Deteniendo el bot...');
  botProcess.kill();
}

function restartBot() {
  if (!botProcess) {
    startBot();
    return;
  }
  appendLog('[panel] Reiniciando el bot...');
  const finish = () => setTimeout(startBot, 1500);
  botProcess.once('exit', finish);
  botProcess.kill();
}

function sendToBot(message) {
  if (!botProcess) return false;
  botProcess.send(message);
  return true;
}

// =============================================================================
// LECTURA DE DATOS PERSISTIDOS (data/bot-state.json) — SOLO LECTURA. El
// dashboard nunca escribe ese archivo directamente: solo el proceso del bot
// lo hace, para no pisarse entre los dos procesos.
// =============================================================================

// Debe coincidir con PAUSE_TTL_MS de conversationService.js (24h). Se
// duplica aquí a propósito, en vez de importar ese archivo, para no correr
// una segunda copia de toda la lógica del bot (con su propio guardado
// periódico) dentro del proceso del dashboard.
const PAUSE_TTL_MS = 24 * 60 * 60 * 1000;

function readBotState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return {};
  }
}

// chatId -> link wa.me ya resuelto (whatsappAlternative.js lo guarda ahí
// cada vez que resuelve un contacto, incluidos los que llegan como @lid).
function readContactLinks() {
  try {
    return JSON.parse(fs.readFileSync(CONTACT_LINKS_FILE, 'utf8'));
  } catch (error) {
    return {};
  }
}

// Link wa.me para abrir el chat directo. Los ids @lid (identificador
// interno de privacidad de WhatsApp) solo se pueden resolver a un número
// real mientras el bot está conectado (whatsappAlternative.js los cachea
// en data/contact-links.json); los que ya son un número normal se arman
// directo, sin depender de esa caché.
function buildChatLink(chatId, links) {
  if (links[chatId]) return links[chatId];
  if (chatId.endsWith('@lid')) return null;
  const digits = chatId.replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}` : null;
}

// =============================================================================
// EDICIÓN SEGURA DE .env — solo las llaves que el panel expone. Nunca toca
// DASHBOARD_* ni ninguna otra que no esté en esta lista.
// =============================================================================

const EDITABLE_ENV_KEYS = [
  'TEST_MODE_SELF_CHAT',
  'RESET_WHATSAPP_SESSION',
  'ADVISOR_WHATSAPP_NUMBER',
  'GROUP_INVITE_URL',
  'DEFAULT_RESPONSE',
  'BOT_NAME'
];

// El .env en Windows suele tener finales de línea \r\n. split('\n') a secas
// deja un "\r" colgando al final de cada línea, y como el "." de las
// regex NO matchea \r, ni la lectura ni el reemplazo encontraban nada
// (todo salía vacío). Por eso se parte con /\r?\n/ y se normaliza antes
// de tocar el texto.
function readEnvFile() {
  const text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const values = {};
  text.split(/\r?\n/).forEach((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2];
  });
  return values;
}

function writeEnvUpdates(updates) {
  const original = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const usesCRLF = original.includes('\r\n');
  let text = original.replace(/\r\n/g, '\n');
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) {
      text = text.replace(re, line);
    } else {
      text += `${text.endsWith('\n') || text === '' ? '' : '\n'}${line}\n`;
    }
  }
  if (usesCRLF) text = text.replace(/\n/g, '\r\n');
  fs.writeFileSync(ENV_FILE, text, 'utf8');
}

// =============================================================================
// FECHAS DE AGENDAMIENTO (data/schedule-dates.json) — knowledgeBase.js las
// carga como override al iniciar el bot. Formato: { basicGroup: [...],
// advanced: [...], basicPersonalized: [...] }.
// =============================================================================

function readScheduleDates() {
  try {
    const raw = fs.readFileSync(SCHEDULE_DATES_FILE, 'utf8');
    const data = JSON.parse(raw);
    const result = {};
    Object.keys(WORKSHOP_LABELS).forEach((key) => { result[key] = Array.isArray(data[key]) ? data[key] : []; });
    return result;
  } catch (error) {
    const empty = {};
    Object.keys(WORKSHOP_LABELS).forEach((key) => { empty[key] = []; });
    return empty;
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function writeScheduleDates(workshopKey, dates) {
  if (!WORKSHOP_LABELS[workshopKey]) throw new Error(`Taller desconocido: ${workshopKey}`);
  const current = readScheduleDates();
  const clean = [...new Set(dates.filter((d) => typeof d === 'string' && ISO_DATE_RE.test(d)))].sort();
  current[workshopKey] = clean;
  fs.mkdirSync(path.dirname(SCHEDULE_DATES_FILE), { recursive: true });
  fs.writeFileSync(SCHEDULE_DATES_FILE, JSON.stringify(current, null, 2), 'utf8');
  return current[workshopKey];
}

// =============================================================================
// SERVIDOR WEB
// =============================================================================

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: DASHBOARD_SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 12 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No autenticado' });
  return res.redirect('/login.html');
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === DASHBOARD_USER && password === DASHBOARD_PASSWORD) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Usuario o clave incorrectos' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/login.html', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use((req, res, next) => {
  // styles.css lo pide el navegador como recurso de /login.html (un
  // <link>), no como navegación de página. Como esta puerta redirigia TODO
  // lo que no fuera /login.html o /api/login de vuelta a /login.html, el
  // navegador recibia el HTML de la propia página de login en vez del CSS
  // al pedir "styles.css" (y lo descartaba por no ser CSS válido): por eso
  // el login se veía sin ningún estilo pese a que el archivo sí lo tenía.
  if (req.path === '/login.html' || req.path === '/api/login' || req.path === '/styles.css') return next();
  return requireAuth(req, res, next);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', (req, res) => {
  res.json({
    status: botStatus,
    running: Boolean(botProcess),
    pid: botProcess ? botProcess.pid : null,
    info: lastInfo,
    hasQr: Boolean(lastQr),
    disconnectReason: lastDisconnectReason
  });
});

app.get('/api/qr', async (req, res) => {
  if (!lastQr) return res.status(404).json({ error: 'No hay QR activo' });
  try {
    const dataUrl = await QRCode.toDataURL(lastQr, { width: 300, margin: 1 });
    res.json({ dataUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/start', (req, res) => { startBot(); res.json({ ok: true }); });
app.post('/api/stop', (req, res) => { stopBot(); res.json({ ok: true }); });
app.post('/api/restart', (req, res) => { restartBot(); res.json({ ok: true }); });

app.get('/api/logs', (req, res) => {
  const since = Number(req.query.since) || 0;
  const lines = since ? logBuffer.filter((l) => l.ts > since) : logBuffer.slice(-300);
  res.json({ lines });
});

app.get('/api/paused-chats', (req, res) => {
  const state = readBotState();
  const rawPausedChats = state.pausedChats;
  // Compatibilidad con el formato viejo (Set serializado como arreglo, sin
  // fecha de pausa) además del nuevo (objeto chatId -> timestamp).
  const entries = Array.isArray(rawPausedChats)
    ? rawPausedChats.map((chatId) => [chatId, Date.now()])
    : Object.entries(rawPausedChats || {});
  const contactProfiles = state.contactProfiles || {};
  const links = readContactLinks();
  const now = Date.now();
  const list = entries.map(([chatId, pausedAt]) => ({
    chatId,
    chatLink: buildChatLink(chatId, links),
    nombre: contactProfiles[chatId]?.nombre || null,
    pausedAt,
    msRemaining: Math.max(0, PAUSE_TTL_MS - (now - pausedAt))
  })).sort((a, b) => b.pausedAt - a.pausedAt);
  res.json({ chats: list, botRunning: Boolean(botProcess) });
});

app.post('/api/paused-chats/:chatId/resume', (req, res) => {
  const { chatId } = req.params;
  const sent = sendToBot({ type: 'resumeChat', chatId });
  if (!sent) return res.status(409).json({ error: 'El bot no está corriendo; inícialo primero.' });
  res.json({ ok: true });
});

app.get('/api/contacts', (req, res) => {
  const state = readBotState();
  const contactProfiles = state.contactProfiles || {};
  const links = readContactLinks();
  const list = Object.entries(contactProfiles)
    .map(([chatId, p]) => ({ chatId, chatLink: buildChatLink(chatId, links), ...p }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  res.json({ contacts: list });
});

app.get('/api/escalations', (req, res) => {
  const state = readBotState();
  const links = readContactLinks();
  const list = (state.escalationHistory || []).map((e) => ({ ...e, chatLink: e.chatId ? buildChatLink(e.chatId, links) : null }));
  res.json({ escalations: list });
});

// Agenda de Avanzado/Personalizado (cupo compartido, calculado y guardado
// por conversationService.js en cada reserva confirmada). Solo lectura,
// igual que el resto de datos de bot-state.json.
app.get('/api/bookings', (req, res) => {
  const state = readBotState();
  const links = readContactLinks();
  const contactProfiles = state.contactProfiles || {};
  const list = (state.bookings || []).map((b) => ({
    ...b,
    dateLabel: formatDateEs(b.date),
    workshopLabel: BOOKING_WORKSHOP_LABELS[b.workshopKey] || b.product,
    chatLink: buildChatLink(b.chatId, links),
    nombre: contactProfiles[b.chatId]?.nombre || null
  })).sort((a, b) => a.date === b.date ? (a.schedule || '').localeCompare(b.schedule || '') : a.date.localeCompare(b.date));
  res.json({
    bookings: list,
    slotCapacity: state.bookingSlotCapacity || 2,
    workshopLabels: BOOKING_WORKSHOP_LABELS
  });
});

app.get('/api/config', (req, res) => {
  const values = readEnvFile();
  const result = {};
  EDITABLE_ENV_KEYS.forEach((key) => { result[key] = values[key] ?? ''; });
  res.json({ config: result });
});

app.post('/api/config', (req, res) => {
  const updates = {};
  for (const key of EDITABLE_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
      updates[key] = String(req.body[key]);
    }
  }
  try {
    writeEnvUpdates(updates);
    res.json({ ok: true, note: 'Los cambios solo se aplican después de reiniciar el bot.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/schedule-dates', (req, res) => {
  const dates = readScheduleDates();
  const workshops = Object.entries(WORKSHOP_LABELS).map(([key, label]) => ({
    key,
    label,
    dates: (dates[key] || []).map((iso) => ({ iso, label: formatDateEs(iso), expired: isPastIsoDate(iso) }))
  }));
  res.json({ workshops });
});

app.post('/api/schedule-dates/:workshopKey', (req, res) => {
  const { workshopKey } = req.params;
  const dates = Array.isArray(req.body?.dates) ? req.body.dates : null;
  if (!dates) return res.status(400).json({ error: 'Falta un arreglo "dates".' });
  try {
    const saved = writeScheduleDates(workshopKey, dates);
    res.json({ ok: true, dates: saved, note: 'Los cambios solo se aplican después de reiniciar el bot.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(DASHBOARD_PORT, () => {
  console.log(`🖥️  Panel de administración disponible en http://localhost:${DASHBOARD_PORT}`);
});

process.on('SIGINT', () => {
  if (botProcess) botProcess.kill();
  process.exit(0);
});

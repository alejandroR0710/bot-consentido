/**
 * conversationService.js
 * ---------------------------------------------------------------------------
 * ABBY — Asesora Virtual de Con Sentido
 * Versión GRATUITA basada en reglas (sin costo de API de IA).
 *
 * Esta versión NO usa un modelo de lenguaje: usa detección de palabras clave
 * y un flujo de estados, pero está diseñada para acercarse lo más posible al
 * espíritu del brief:
 *   - En las categorías clave se ofrece una lista numerada corta (ej. "1) 2) 3)")
 *     para que el cliente pueda responder por número o con sus propias palabras,
 *     sin perder la calidez de la conversación.
 *   - Abby DESCUBRE la necesidad antes de enviar cualquier catálogo.
 *   - Mensajes cortos, una pregunta a la vez, tono cálido y premium.
 *   - Solo transfiere a un asesor humano en las situaciones puntuales
 *     definidas por el negocio.
 *
 * LIMITACIÓN HONESTA: al no ser un modelo de lenguaje real, Abby aquí sigue
 * dependiendo de que el cliente use ciertas palabras para que lo entienda.
 * Si el cliente escribe algo muy distinto a lo esperado, puede no reconocerlo
 * a la primera (por eso existe la regla de "dos intentos fallidos -> asesor").
 * La versión con Claude real (LLM) entiende lenguaje libre de verdad; esta
 * es la alternativa sin costo mientras se decide si vale la pena ese paso.
 *
 * INTEGRACIÓN CON WHATSAPP:
 *   const { handleConversation, scheduleFollowUps, clearFollowUps } = require('./conversationService');
 *   const result = handleConversation(chatId, incomingText);
 *   await sendWhatsappMessage(chatId, result.reply);
 *   if (result.pdfPath) await sendWhatsappDocument(chatId, result.pdfPath);
 *   if (result.imagePath) await sendWhatsappImage(chatId, result.imagePath);
 *   if (result.awaitingComprobante) schedulePaymentReminder(chatId, (id, text) => sendWhatsappMessage(id, text));
 *   if (result.final) clearFollowUps(chatId);
 *   else scheduleFollowUps(chatId, (id, text) => sendWhatsappMessage(id, text));
 *
 * LIMITACIÓN HONESTA (recordatorio de pago): igual que el seguimiento de
 * 24h/3d/7d, el recordatorio de "¿aún deseas reservar?" se agenda con
 * setTimeout en memoria. Si el proceso del bot se reinicia antes de las 24h,
 * el recordatorio se pierde. Para producción real conviene mover esto a un
 * job persistente (cron, cola, etc.) en vez de setTimeout.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const { getAutoReply } = require('./responseService');
const { GROUP_INVITE_URL } = require('../config/env');
const { loadState, saveState } = require('./persistentStore');

// =============================================================================
// CONFIGURACIÓN GENERAL
// =============================================================================

const SESSION_TTL = 20 * 60 * 1000; // 20 minutos de inactividad
const CONTACT_PROFILE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 días
// process.cwd() depende de DESDE DÓNDE se lanza el proceso de Node (puede
// variar con pm2, nodemon, systemd, Docker, etc.), no de dónde vive este
// archivo. Por eso una imagen podía "existir" en public/images pero nunca
// resolverse: el bot buscaba en el directorio equivocado sin avisar. Ahora
// probamos varias rutas candidatas (relativas a este archivo y al
// directorio de arranque) y usamos la primera que exista de verdad.
const PUBLIC_DIR_CANDIDATES = [
  path.resolve(__dirname, '..', '..', 'public'),
  path.resolve(__dirname, '..', 'public'),
  path.resolve(__dirname, 'public'),
  path.resolve(process.cwd(), 'public')
].filter((value, index, array) => array.indexOf(value) === index);

function resolveExistingPublicFile(subfolder, fileName) {
  const triedPaths = [];
  const parsed = path.parse(fileName || '');
  const filenameCandidates = [fileName];

  if (parsed.name) {
    filenameCandidates.push(`${parsed.name}${parsed.ext}`);
    filenameCandidates.push(`${parsed.name}${parsed.ext}${parsed.ext}`);
    filenameCandidates.push(`${parsed.name}.jpeg.jpeg`);
    filenameCandidates.push(`${parsed.name}.jpg.jpg`);
    filenameCandidates.push(`${parsed.name}.png.png`);
  }

  const uniqueFilenameCandidates = [...new Set(filenameCandidates.filter(Boolean))];

  for (const base of PUBLIC_DIR_CANDIDATES) {
    for (const candidateName of uniqueFilenameCandidates) {
      const fullPath = path.join(base, subfolder, candidateName);
      triedPaths.push(fullPath);
      try {
        if (fs.existsSync(fullPath)) return fullPath;
      } catch (err) {
        // seguir probando el siguiente candidato
      }
    }
  }

  console.warn(`⚠️ No encontré "${fileName}" en ninguna de estas rutas:\n  - ${triedPaths.join('\n  - ')}`);
  return null;
}

function resolveExistingPublicDir(subfolder) {
  for (const base of PUBLIC_DIR_CANDIDATES) {
    const fullPath = path.join(base, subfolder);
    try {
      if (fs.existsSync(fullPath)) return fullPath;
    } catch (err) {
      // seguir probando el siguiente candidato
    }
  }
  return null;
}

function getContentImagePath(fileName) {
  return resolveExistingPublicFile('images', fileName);
}

const BUSINESS_INFO = {
  nombre: 'Con Sentido',
  descripcion:
    'un espacio creativo en Bogotá donde enseñamos a emprender con velas, realizamos experiencias creativas, ofrecemos insumos para fabricación de velas, velas terminadas, regalos personalizados y un Club Creativo para niños y jóvenes',
  direccion: 'Carrera 38B #90-03 Sur, Barrio Ciudad Montes, Bogotá',
  horario: '10:00 a.m. – 9:00 p.m.',
  whatsapp: '321-303-5263',
  instagram: 'Consentido Velas',
  facebook: 'Consentido Velas',
  tiktok: 'Consentido Velas',
  envios: 'Hacemos envíos nacionales, y domicilios en Bogotá con costo adicional.',
  mediosPago: 'Efectivo, Nequi y Bre-B.'
};

// =============================================================================
// ALMACENAMIENTO EN MEMORIA
// =============================================================================

const sessionStore = new Map();
const contactProfileStore = new Map();
const followUpTimers = new Map();
const paymentReminderTimers = new Map();

// Bookkeeping serializable (fechas/índices, no los setTimeout en sí) para
// poder reprogramar estos avisos si el proceso se reinicia. Ver sección de
// PERSISTENCIA EN DISCO al final del archivo.
const followUpArmedAt = new Map();
const followUpFiredStages = new Map();
const paymentReminderArmedAt = new Map();

// =============================================================================
// UTILIDADES DE TEXTO
// =============================================================================

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeFilename(text) {
  return normalizeText(text).replace(/\s+/g, '');
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesAny(normalizedText, keywords) {
  return keywords.some((keyword) =>
    new RegExp(`\\b${escapeRegex(normalizeText(keyword))}\\b`, 'i').test(normalizedText)
  );
}

function findFirstMatch(normalizedText, categoryKeywordMap) {
  for (const [category, keywords] of Object.entries(categoryKeywordMap)) {
    if (matchesAny(normalizedText, keywords)) return category;
  }
  return null;
}

// Permite que, en las categorías clave, el cliente responda con el número de
// la lista ("2") además de con sus propias palabras ("ya hago velas").
function matchesNumberedOption(messageText, optionOrder) {
  const trimmed = String(messageText || '').trim();
  if (!/^\d{1,2}$/.test(trimmed)) return null;
  const num = parseInt(trimmed, 10);
  if (num >= 1 && num <= optionOrder.length) return optionOrder[num - 1];
  return null;
}

function findChoice(messageText, categoryKeywordMap, optionOrder) {
  if (optionOrder) {
    const byNumber = matchesNumberedOption(messageText, optionOrder);
    if (byNumber) return byNumber;
  }
  return findFirstMatch(normalizeText(messageText), categoryKeywordMap);
}

// Selector reutilizable "1) Sí / 2) No" para los puntos del bot donde se
// pregunta si el cliente desea agendar/reservar. Acepta el número (1/2) o
// palabras (sí/no y variantes), igual que el resto de las listas numeradas.
const yesNoKeywordMap = {
  si: ['si', 'sí', 'claro', 'de una', 'dale', 'quiero'],
  no: ['no', 'no gracias', 'ahora no', 'todavia no', 'todavía no', 'despues', 'después', 'aun no', 'aún no', 'pregunta', 'preguntas', 'duda', 'dudas']
};
const YES_NO_ORDER = ['si', 'no'];

function findYesNo(messageText) {
  return findChoice(messageText, yesNoKeywordMap, YES_NO_ORDER);
}

// =============================================================================
// SALUDO
// =============================================================================

const greetingKeywords = ['hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'hey', 'hi', 'ola'];

function isGreeting(text) {
  return matchesAny(normalizeText(text), greetingKeywords);
}

function getWelcomeMessage() {
  return '¡Hola! 🌿 Bienvenido(a) a Con Sentido. Soy Abby, tu asesora virtual, y estoy feliz de ayudarte hoy. Antes de continuar, ¿me regalas tu nombre?';
}

// Menú principal reutilizado cuando el cliente termina un sub-flujo (ej.
// respondió "No" a una pregunta de agendar/reservar) y vuelve al punto de
// partida en vez de que la conversación simplemente termine ahí.
function getMainMenuMessage(chatId) {
  const nombre = getClientName(chatId);
  return [
    `${nombre ? `¿Qué más te gustaría conocer, ${nombre}?` : '¿Qué más te gustaría conocer?'} 🌿`,
    '1. Talleres para aprender a hacer velas',
    '2. Experiencias creativas',
    '3. Insumos para fabricar velas',
    '4. Velas y regalos listos',
    '5. Recordatorios para eventos',
    '6. Club Creativo',
    'Puedes responderme con el número o simplemente contarme con tus palabras 😊.'
  ].join('\n');
}

function goToMainMenu(chatId) {
  setSession(chatId, 'awaiting_interest');
  return { reply: getMainMenuMessage(chatId) };
}

// Antes, un cliente pidiendo explícitamente "menú"/"menú principal" en medio
// de un flujo activo no era reconocido por nada: caía como respuesta
// (equivocada) a la pregunta pendiente de ese flujo.
const MENU_REQUEST_KEYWORDS = [
  'menu', 'menu principal', 'menu inicial', 'volver al menu', 'ver el menu', 'inicio'
];

function isMenuRequest(text) {
  return matchesAny(normalizeText(text), MENU_REQUEST_KEYWORDS);
}

// Detecta cuando el cliente indica, con sus propias palabras, que se
// equivocó de opción/número (ej. "le di al número que no era", "me
// equivoqué", "me confundí"). Antes, esa frase se guardaba tal cual como si
// fuera la respuesta real a la pregunta pendiente (ej. terminó guardada
// como "presupuesto" en el perfil del cliente).
const CORRECTION_PATTERNS = [
  /\bequivoqu/, // equivoqué / equivoque / equivocación / equivocado
  /\bconfund/, // confundí / confundido / confusión
  /\bno era\b/, // "...no era" (con o sin objeto después: "no era esa", "que no era")
  /\bpor error\b/,
  /\b(toque|presione|di click|clickee|hice click) mal\b/
];

function isCorrectionMessage(text) {
  const normalized = normalizeText(text);
  return CORRECTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

// =============================================================================
// SOLICITUD DE ACCESO AL GRUPO
// =============================================================================

// Se dispara solo cuando el mensaje ARRANCA con "grupo" (o derivados/errores
// de ortografía como "grupos", "grup"), no cuando la palabra aparece en medio
// de otra frase. El \b final es clave: sin él, "grupal"/"grupales" (que se
// usan para la modalidad GRUPAL de las clases, algo totalmente distinto al
// grupo de WhatsApp) también hacían match por empezar con el prefijo "grup".
function isGroupRequest(text) {
  return /^grupos?\b/.test(normalizeText(text));
}

function getGroupInviteMessage() {
  return [
    '🌿 ¡Hola! Bienvenid@ a Con Sentido. 🕯️',
    '',
    'Qué alegría saber que quieres hacer parte de nuestra comunidad Consentidas.',
    '',
    'Este es un espacio exclusivo para quienes aman el mundo de las velas artesanales o desean aprender desde cero. Aquí compartimos:',
    '',
    '✨ Tips y técnicas exclusivas.',
    '🎥 Avisos de nuestros lives antes que en redes.',
    '🎓 Información sobre talleres presenciales y virtuales.',
    '🛍️ Novedades, insumos y promociones especiales.',
    '💡 Ideas para emprender con velas.',
    '❤️ Un ambiente de aprendizaje y apoyo entre todos.',
    '',
    'Para unirte solo haz clic en el siguiente enlace:',
    '',
    GROUP_INVITE_URL,
    '',
    '📌 Para mantener la comunidad organizada, el grupo se abre en horarios específicos para preguntas y conversaciones. El resto del tiempo compartiremos contenido de valor, novedades y anuncios importantes.',
    '',
    '¡Nos encantará tenerte con nosotros! Bienvenid@ a la familia Con Sentido. 💛🕯️'
  ].join('\n');
}

// =============================================================================
// PREGUNTAS FRECUENTES (FAQ) — se responden en cualquier momento sin romper
// el flujo activo, tal como lo haría una asesora real.
// =============================================================================

const faqKeywordMap = {
  horario: ['horario', 'a que hora abren', 'a que hora cierran', 'hora de atencion'],
  direccion: ['direccion', 'ubicacion', 'donde quedan', 'donde estan', 'como llegar'],
  redes: ['instagram', 'facebook', 'tiktok', 'redes sociales'],
  pago: ['medios de pago', 'como pago', 'formas de pago', 'aceptan nequi', 'bre b', 'brebe', 'aceptan tarjeta'],
  envios: ['envio', 'envios', 'domicilio', 'domicilios', 'envian a otras ciudades', 'hacen envios']
};

function getFaqAnswer(category) {
  switch (category) {
    case 'horario':
      return `Nuestro horario de atención es ${BUSINESS_INFO.horario} 🕒.`;
    case 'direccion':
      return `Nos encuentras en ${BUSINESS_INFO.direccion} 📍.`;
    case 'redes':
      return `Nos encuentras como "${BUSINESS_INFO.instagram}" en Instagram, Facebook y TikTok 💛.`;
    case 'pago':
      return `Aceptamos ${BUSINESS_INFO.mediosPago}`;
    case 'envios':
      return BUSINESS_INFO.envios;
    default:
      return null;
  }
}

function checkFaq(text) {
  const normalized = normalizeText(text);
  const category = findFirstMatch(normalized, faqKeywordMap);
  if (!category) return null;
  return getFaqAnswer(category);
}

// =============================================================================
// CATÁLOGO DE PDFs POR CATEGORÍA
// =============================================================================

const PDF_PATTERNS = {
  talleres_basico: ['masterclass basico', 'taller basico', 'curso basico'],
  talleres_avanzado: ['masterclass avanzado', 'taller avanzado', 'curso avanzado'],
  talleres_personalizado: ['masterclass personalizado', 'taller personalizado', 'curso personalizado'],
  insumos_fragancias: ['fragancias'],
  insumos_generales: ['insumos generales', 'catalogo insumos', 'insumos'],
  velas_aromaticas: ['velas aromaticas', 'aromaticas'],
  velas_decorativas: ['velas decorativas', 'decorativas'],
  velas_bouquets: ['bouquet', 'bouquets'],
  velas_difusores: ['difusores'],
  velas_aguas_de_lino: ['aguas de lino'],
  velas_kits_regalo: ['kits de regalo', 'kits'],
  velas_regalos_personalizados: ['regalos personalizados', 'regalo personalizado'],
  club_creativo: ['club creativo', 'club ninos', 'club niños']
};

function getPdfForCategory(category) {
  const pdfDir = resolveExistingPublicDir('pdf');
  if (!pdfDir) {
    console.warn('⚠️ No encontré la carpeta public/pdf en ninguna ruta candidata:', PUBLIC_DIR_CANDIDATES.map((b) => path.join(b, 'pdf')));
    return null;
  }

  let files;
  try {
    files = fs.readdirSync(pdfDir).filter((f) => f.toLowerCase().endsWith('.pdf'));
  } catch (err) {
    return null;
  }

  const normalizedFiles = files.map((file) => ({ file, norm: normalizeFilename(file) }));
  const patterns = PDF_PATTERNS[category] || [category];

  for (const pattern of patterns) {
    const normPattern = normalizeFilename(pattern);
    const match = normalizedFiles.find((nf) => nf.norm.includes(normPattern));
    if (match) return path.join(pdfDir, match.file);
  }
  return null;
}

// =============================================================================
// PERFIL DE CONTACTO (persistente, 30 días)
// =============================================================================

function getContactProfile(chatId) {
  const profile = contactProfileStore.get(chatId);
  if (!profile) return null;
  if (Date.now() - profile.updatedAt > CONTACT_PROFILE_TTL) {
    contactProfileStore.delete(chatId);
    return null;
  }
  return profile;
}

function ensureContactProfile(chatId) {
  let profile = getContactProfile(chatId);
  if (!profile) {
    profile = {
      nombre: null,
      ciudad: null,
      productoInteres: null,
      presupuesto: null,
      status: null,
      tags: [],
      catalogsSent: {},
      updatedAt: Date.now()
    };
  }
  return profile;
}

function updateContactProfile(chatId, updates) {
  const profile = ensureContactProfile(chatId);
  Object.assign(profile, updates, { updatedAt: Date.now() });
  contactProfileStore.set(chatId, profile);
  return profile;
}

function addTag(chatId, tag) {
  const profile = ensureContactProfile(chatId);
  if (!profile.tags.includes(tag)) profile.tags.push(tag);
  profile.updatedAt = Date.now();
  contactProfileStore.set(chatId, profile);
}

function hasCatalogBeenSent(chatId, category) {
  const profile = getContactProfile(chatId);
  return Boolean(profile && profile.catalogsSent && profile.catalogsSent[category]);
}

function markCatalogSent(chatId, category) {
  const profile = ensureContactProfile(chatId);
  profile.catalogsSent[category] = true;
  profile.updatedAt = Date.now();
  contactProfileStore.set(chatId, profile);
}

function getPdfIfNotSentBefore(chatId, category) {
  if (hasCatalogBeenSent(chatId, category)) {
    return { pdfPath: null, alreadySent: true };
  }
  const pdfPath = getPdfForCategory(category);
  if (pdfPath) markCatalogSent(chatId, category);
  return { pdfPath, alreadySent: false };
}

// Evita prometer "el PDF" cuando en realidad no hay un archivo para adjuntar
// (ej. si aún no se subió el PDF de esa categoría al servidor). El mensaje
// solo menciona "PDF" si de verdad hay un archivo que se está enviando.
function describeCatalogDelivery(pdfPath, alreadySent, label) {
  if (alreadySent) return `Ya te habíamos compartido ${label} antes 📄.`;
  if (pdfPath) return `Aquí tienes ${label} en PDF.`;
  return `Ya te comparto ${label}.`;
}

function getClientName(chatId) {
  const profile = getContactProfile(chatId);
  return profile && profile.nombre ? profile.nombre.split(' ')[0] : null;
}

// Regla 5: capturar presupuesto aproximado sin que se sienta como formulario.
// Si el cliente no lo tiene claro, se registra como "Por definir" y la
// conversación sigue fluyendo con normalidad (no se insiste ni se bloquea).
function captureBudgetAnswer(chatId, messageText) {
  const raw = messageText.trim();
  const normalized = normalizeText(raw);
  const noSabe = matchesAny(normalized, ['no se', 'no tengo', 'no estoy seguro', 'no lo se', 'aun no se', 'ninguno']);
  const presupuesto = noSabe || !raw ? 'Por definir' : raw;
  updateContactProfile(chatId, { presupuesto });
  return presupuesto;
}

// =============================================================================
// SESIÓN DE CONVERSACIÓN
// =============================================================================

function getSession(chatId) {
  const session = sessionStore.get(chatId);
  if (!session) return null;
  if (Date.now() - session.updatedAt > SESSION_TTL) {
    sessionStore.delete(chatId);
    return null;
  }
  return session;
}

function setSession(chatId, state, dataUpdates = {}) {
  const existing = sessionStore.get(chatId);
  const data = { ...(existing?.data || {}), ...dataUpdates };
  sessionStore.set(chatId, {
    state,
    data,
    misunderstandCount: existing?.misunderstandCount || 0,
    updatedAt: Date.now()
  });
}

function resetMisunderstandCount(chatId) {
  const session = sessionStore.get(chatId);
  if (session) {
    session.misunderstandCount = 0;
    sessionStore.set(chatId, session);
  }
}

function clearSession(chatId) {
  sessionStore.delete(chatId);
}

// =============================================================================
// PAUSA MANUAL DEL BOT (control humano)
// =============================================================================
// Cuando tú (el negocio) tomas el chat manualmente desde tu WhatsApp en
// cualquier punto del flujo, el bot debe dejar de responder en ESE chat
// hasta que tú mismo lo reactives escribiendo una palabra clave. No se
// reactiva solo por inactividad ni porque el cliente vuelva a saludar: es
// un apagado explícito y una reactivación explícita.
const pausedChats = new Set();

const BOT_RESUME_KEYWORDS = ['bot on', 'activar bot', 'reactivar bot', 'encender bot'];

function pauseBot(chatId) {
  pausedChats.add(chatId);
  // Se limpian sesión y seguimientos automáticos: si el bot vuelve a
  // activarse más adelante, arranca en limpio en vez de retomar un estado
  // de flujo que quedó desactualizado mientras un humano atendía.
  clearSession(chatId);
  clearFollowUps(chatId);
  clearPaymentReminder(chatId);
}

function resumeBot(chatId) {
  pausedChats.delete(chatId);
}

function isBotPaused(chatId) {
  return pausedChats.has(chatId);
}

function isResumeBotCommand(text) {
  return matchesAny(normalizeText(text), BOT_RESUME_KEYWORDS);
}

// =============================================================================
// SEGUIMIENTO AUTOMÁTICO (24h / 3 días / 7 días)
// =============================================================================

const FOLLOW_UP_MESSAGES = [
  { delay: 24 * 60 * 60 * 1000, text: 'Hola, ¿pudiste revisar la información que te enviamos?' },
  { delay: 3 * 24 * 60 * 60 * 1000, text: 'Esta semana tenemos disponibilidad para talleres y experiencias. Si tienes alguna duda, con gusto te ayudamos.' },
  { delay: 7 * 24 * 60 * 60 * 1000, text: 'Queríamos saber si aún estás interesado(a). Si necesitas orientación, aquí estamos.' }
];

function markFollowUpStageFired(chatId, index) {
  if (!followUpFiredStages.has(chatId)) followUpFiredStages.set(chatId, new Set());
  followUpFiredStages.get(chatId).add(index);
}

function clearFollowUps(chatId) {
  const timers = followUpTimers.get(chatId);
  if (timers) {
    timers.forEach((t) => clearTimeout(t));
    followUpTimers.delete(chatId);
  }
  followUpArmedAt.delete(chatId);
  followUpFiredStages.delete(chatId);
}

function scheduleFollowUps(chatId, sendMessage) {
  clearFollowUps(chatId);
  if (typeof sendMessage !== 'function') return;
  followUpArmedAt.set(chatId, Date.now());
  const timers = FOLLOW_UP_MESSAGES.map(({ delay, text }, index) =>
    setTimeout(() => {
      sendMessage(chatId, text);
      markFollowUpStageFired(chatId, index);
    }, delay)
  );
  followUpTimers.set(chatId, timers);
}

// Recordatorio específico de "¿aún deseas reservar?" cuando el cliente entró
// a la etapa de pago (le compartimos los medios de pago) pero no envió el
// comprobante en 24 horas.
const PAYMENT_REMINDER_DELAY_MS = 24 * 60 * 60 * 1000;

function buildPaymentReminderText(chatId) {
  const nombre = getClientName(chatId);
  const profile = getContactProfile(chatId);
  const producto = profile?.productoInteres && /masterclass|taller/i.test(profile.productoInteres)
    ? 'tu cupo para el MasterClass'
    : 'tu reserva';
  return [
    `Hola${nombre ? `, ${nombre}` : ''}. 😊 Paso por aquí para saber si aún deseas confirmar ${producto}. Si tienes alguna duda o necesitas ayuda con el proceso de pago, con gusto te acompaño.`,
    'Aceptamos Efectivo, Nequi y Bre-B.'
  ].join('\n');
}

function clearPaymentReminder(chatId) {
  const timer = paymentReminderTimers.get(chatId);
  if (timer) {
    clearTimeout(timer);
    paymentReminderTimers.delete(chatId);
  }
  paymentReminderArmedAt.delete(chatId);
}

function schedulePaymentReminder(chatId, sendMessage) {
  clearPaymentReminder(chatId);
  if (typeof sendMessage !== 'function') return;
  paymentReminderArmedAt.set(chatId, Date.now());
  const text = buildPaymentReminderText(chatId);
  const timer = setTimeout(() => sendMessage(chatId, text), PAYMENT_REMINDER_DELAY_MS);
  paymentReminderTimers.set(chatId, timer);
}

// Si el proceso se reinició mientras había seguimientos o recordatorios de
// pago pendientes, esta función los reprograma con el tiempo restante
// (usando lo que se guardó en disco). Los que ya se hubieran vencido
// mientras el bot estaba apagado se envían de una vez, en lugar de
// perderse en silencio. Se llama una sola vez, cuando el cliente de
// WhatsApp queda listo.
function rearmPendingReminders(sendMessage) {
  if (typeof sendMessage !== 'function') return;
  const now = Date.now();

  for (const [chatId, armedAt] of followUpArmedAt.entries()) {
    const firedStages = followUpFiredStages.get(chatId) || new Set();
    const timers = [];
    FOLLOW_UP_MESSAGES.forEach(({ delay, text }, index) => {
      if (firedStages.has(index)) return;
      const remaining = armedAt + delay - now;
      if (remaining <= 0) {
        sendMessage(chatId, text);
        markFollowUpStageFired(chatId, index);
      } else {
        timers.push(
          setTimeout(() => {
            sendMessage(chatId, text);
            markFollowUpStageFired(chatId, index);
          }, remaining)
        );
      }
    });
    if (timers.length) followUpTimers.set(chatId, timers);
    if ((followUpFiredStages.get(chatId)?.size || 0) >= FOLLOW_UP_MESSAGES.length) {
      followUpArmedAt.delete(chatId);
      followUpFiredStages.delete(chatId);
    }
  }

  for (const [chatId, armedAt] of paymentReminderArmedAt.entries()) {
    const remaining = armedAt + PAYMENT_REMINDER_DELAY_MS - now;
    const text = buildPaymentReminderText(chatId);
    if (remaining <= 0) {
      sendMessage(chatId, text);
      paymentReminderArmedAt.delete(chatId);
    } else {
      paymentReminderTimers.set(chatId, setTimeout(() => sendMessage(chatId, text), remaining));
    }
  }
}

// =============================================================================
// REGLAS DE ESCALAMIENTO A ASESOR HUMANO
// =============================================================================
// Solo cuando ocurra alguna de estas situaciones (Regla 9 del brief más
// reciente): reservar, pagar, comprobante, cotización, producto personalizado,
// mayorista, solicita persona, o dos intentos fallidos seguidos.
//
// IMPORTANTE: "fecha"/"disponibilidad" YA NO disparan escalamiento automático.
// Se retiraron de la lista de disparadores al resolver la contradicción entre
// el brief inicial y la Regla 9 más reciente: preguntas como "¿tienen
// disponibilidad el sábado?" ahora las conversa Abby con normalidad; cada
// flujo sigue preguntando la fecha como parte de su propio guion cuando
// corresponde.

const ESCALATION_KEYWORDS = {
  comprobante: ['comprobante', 'soporte de pago'],
  cotizacion: ['cotizacion', 'cotización', 'cotizar'],
  producto_personalizado: ['pedido personalizado', 'producto personalizado', 'a la medida', 'hecho a la medida'],
  mayorista: ['mayorista', 'al por mayor', 'por mayor'],
  contacto_humano: ['asesor', 'persona', 'humano', 'hablar con alguien']
};

// NUEVO: preguntas de "etapa de decisión" (dónde reservo, cómo pago, quiero
// separar mi cupo, cómo hago el abono...) ya NO escalan directo a un asesor.
// Abby las resuelve sola: comparte los medios de pago y pasa al cliente a
// "Esperando comprobante". El envío del comprobante (o pedir hablar con
// alguien) sigue escalando a un asesor humano, como antes.
const PAYMENT_INTENT_KEYWORDS = [
  'donde reservo', 'dónde reservo', 'como reservo', 'cómo reservo',
  'como pago', 'cómo pago', 'como hago el pago', 'cómo hago el pago',
  'como hago el abono', 'cómo hago el abono', 'como abono', 'cómo abono',
  'quiero separar mi cupo', 'separar cupo', 'separar mi cupo', 'apartar cupo',
  'quiero reservar', 'reservar', 'reserva', 'medios de pago', 'medio de pago',
  'pagar', 'pago', 'transferencia', 'consignacion'
];

function isPaymentIntent(text) {
  return matchesAny(normalizeText(text), PAYMENT_INTENT_KEYWORDS);
}

const PAYMENT_METHODS = [
  'Nequi: 315 304 7547',
  'Bre-B (llave): 0090622675',
  'Efectivo (si prefieres acercarte a nuestra sede).'
];

// Candidato claro para knowledgeBase.js: el valor del abono ($80.000) está
// hardcodeado aquí porque hoy solo se conoce para el MasterClass. Si mañana
// cada producto tiene su propio valor de reserva, este es el lugar a mover
// a la base de conocimiento en vez de tenerlo fijo en el código.
function handlePaymentIntent(chatId) {
  updateContactProfile(chatId, { status: 'Esperando comprobante' });
  setSession(chatId, 'esperando_comprobante', { since: Date.now() });

  const profile = getContactProfile(chatId);
  const esTaller = /masterclass|taller/i.test(profile?.productoInteres || '');

  const introLine = esTaller
    ? 'Para reservar tu cupo solo debes realizar un abono de $80.000. El saldo restante lo cancelarás el día del taller.'
    : 'Para confirmar tu reserva o pedido, puedes iniciar el pago por cualquiera de estos medios; un asesor te confirmará el valor exacto y el saldo pendiente.';

  return {
    reply: [
      '¡Perfecto! 🌿',
      introLine,
      'Puedes realizar el pago por cualquiera de estos medios:',
      `• ${PAYMENT_METHODS[0]}`,
      `• ${PAYMENT_METHODS[1]}`,
      `• ${PAYMENT_METHODS[2]}`,
      'Cuando realices el pago, envíanos el comprobante por este mismo chat con tu nombre completo y confirmaremos tu reserva. 😊'
    ].join('\n'),
    final: true,
    awaitingComprobante: true
  };
}

function detectQuantityOver20(normalizedText) {
  const match = normalizedText.match(/\b(\d{1,4})\s*(unidades|unidad)\b/);
  if (match) {
    const quantity = parseInt(match[1], 10);
    if (quantity > 20) return 'cantidad_mayor_20';
  }
  return null;
}

function detectEscalationTrigger(text, currentState) {
  const normalized = normalizeText(text);

  for (const [trigger, keywords] of Object.entries(ESCALATION_KEYWORDS)) {
    if (matchesAny(normalized, keywords)) return trigger;
  }

  const quantityTrigger = detectQuantityOver20(normalized);
  if (quantityTrigger) return quantityTrigger;

  return null;
}

// Antes, CUALQUIER disparador de esta lista (comprobante, cotización,
// producto a la medida, mayorista, pedir un humano, +20 unidades) caía en
// escalateToAdvisor(chatId) SIN mensaje: el cliente recibía el mismo texto
// genérico para los 6 casos, y ese mismo texto genérico terminaba como
// "Motivo" en el reporte del asesor — sin decir realmente POR QUÉ se
// escaló. Con este mapa, cada disparador tiene su propio mensaje (visible
// para el cliente y para el asesor en "📝 Motivo").
const ESCALATION_TRIGGER_MESSAGES = {
  comprobante: 'Claro, un asesor de nuestro equipo revisará tu comprobante de pago y confirmará tu reserva.',
  cotizacion: 'Con gusto. Un asesor de nuestro equipo te preparará la cotización que necesitas.',
  producto_personalizado: '¡Qué buena idea! Un asesor de nuestro equipo te ayudará a coordinar tu pedido a la medida.',
  mayorista: 'Un asesor de nuestro equipo te atenderá para hablar de precios y condiciones al por mayor.',
  contacto_humano: 'Claro que sí. Un asesor de nuestro equipo continuará tu atención en un momento.',
  cantidad_mayor_20: 'Para un pedido de esta cantidad, un asesor de nuestro equipo te ayudará a coordinar los detalles y el mejor precio.'
};

// Cuadro informativo para que el asesor humano, al recibirlo, solo tenga que
// leer esto (no toda la conversación) para saber quién es el cliente y por
// dónde seguir. Se envía aparte, no como parte de la respuesta al cliente.
// Enlace wa.me: al tocarlo desde tu chat de reportes, abre directo la
// conversación con el cliente (WhatsApp solo reconoce el número en dígitos,
// sin "@c.us" ni símbolos).
function buildChatLink(chatId) {
  const digits = String(chatId || '').replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}` : (chatId || 'Sin definir');
}

function buildAdvisorSummary(chatId, profile, sessionData, reasonMessage) {
  const lines = [
    '📋 *CLIENTE PARA ATENDER*',
    '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬',
    `👤 *Nombre:* ${profile?.nombre || 'Sin nombre'}`,
    `💬 *Chat:* ${buildChatLink(chatId)}`,
    `🎯 *Interés:* ${profile?.productoInteres || 'Sin definir'}`
  ];

  // Solo se muestran los campos que de verdad se preguntaron/capturaron;
  // ya no se pregunta presupuesto ni modalidad en todos los flujos, así que
  // mostrar "Sin definir" ahí era ruido en vez de información útil.
  if (profile?.ciudad) lines.push(`📍 *Ciudad:* ${profile.ciudad}`);
  if (profile?.presupuesto) lines.push(`💰 *Presupuesto:* ${profile.presupuesto}`);
  if (sessionData?.modalidad) lines.push(`🧩 *Modalidad:* ${sessionData.modalidad}`);
  if (profile?.tags?.length) lines.push(`🏷️ *Etiquetas:* ${profile.tags.join(', ')}`);

  lines.push('▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬');
  lines.push(`📝 *Motivo:* ${reasonMessage}`);
  return lines.join('\n');
}

// Evita que un cliente repitiendo la misma palabra gatillo (ej. "asesor")
// varias veces seguidas genere varios reportes duplicados en tu chat: el
// cliente igual recibe su respuesta cada vez, pero el reporte al asesor
// solo se reenvía si ya pasó este tiempo desde el último para ese chat.
const ADVISOR_NOTIFICATION_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutos
const lastAdvisorNotificationAt = new Map();

function shouldNotifyAdvisorNow(chatId) {
  const last = lastAdvisorNotificationAt.get(chatId);
  const now = Date.now();
  if (last && now - last < ADVISOR_NOTIFICATION_COOLDOWN_MS) return false;
  lastAdvisorNotificationAt.set(chatId, now);
  return true;
}

function escalateToAdvisor(chatId, closingMessage) {
  const session = getSession(chatId);
  const profile = getContactProfile(chatId);
  const nombre = getClientName(chatId);
  clearSession(chatId);
  clearFollowUps(chatId);
  clearPaymentReminder(chatId);

  const base =
    closingMessage ||
    `${nombre ? nombre + ', un' : 'Un'} asesor de nuestro equipo continuará tu atención de manera personalizada muy pronto 🙌.`;

  const advisorSummary = shouldNotifyAdvisorNow(chatId)
    ? buildAdvisorSummary(chatId, profile, session?.data, base)
    : null;

  return {
    reply: base,
    final: true,
    escalatedToAdvisor: true,
    advisorSummary,
    contactData: {
      nombre: profile?.nombre || null,
      ciudad: profile?.ciudad || null,
      productoInteres: profile?.productoInteres || null,
      presupuesto: profile?.presupuesto || null,
      status: profile?.status || null,
      tags: profile?.tags || [],
      ...(session?.data || {})
    }
  };
}

// Preguntas de aclaración legítimas que NO deben contar como intento fallido:
// si el cliente pregunta "¿cuál es la diferencia?" o "¿cuánto cuesta?" en
// medio de una elección, Abby responde con contexto real en vez de repetir
// la misma pregunta tal cual (lo que suena robótico).
const differenceQuestionKeywords = [
  'cual es la diferencia', 'cuál es la diferencia', 'que diferencia', 'qué diferencia',
  'en que se diferencian', 'en qué se diferencian', 'no entiendo la diferencia', 'diferencia entre'
];

const priceQuestionKeywords = [
  'precio', 'precios', 'cuanto cuesta', 'cuánto cuesta', 'cuanto vale', 'cuánto vale', 'valor', 'costo', 'cuestan'
];

function isAskingForDifference(text) {
  return matchesAny(normalizeText(text), differenceQuestionKeywords);
}

function isAskingAboutPrice(text) {
  return matchesAny(normalizeText(text), priceQuestionKeywords);
}

// Explicaciones cortas por estado, para cuando el cliente pregunta "¿cuál es
// la diferencia?" en vez de elegir directamente entre las opciones.
const DIFFERENCE_EXPLANATIONS = {
  talleres_awaiting_level: 'Claro: el MasterClass Básico es para quienes nunca han hecho velas y quieren aprender desde cero; el Avanzado es para quienes ya saben hacerlas y buscan técnicas nuevas; y el Personalizado se diseña completamente a tu medida.',
  awaiting_velas_clarify: 'Claro: las velas ya hechas son piezas terminadas listas para regalar o decorar; si aprendes a fabricarlas, te enseñamos el proceso paso a paso en un taller.',
  awaiting_fabricar_clarify: 'Claro: el taller es una clase guiada para aprender desde cero; los insumos son los materiales (cera, pabilo, fragancias, moldes) para que tú misma(o) las fabriques si ya sabes cómo.',
  talleres_basico_awaiting_modalidad: 'Claro: en la modalidad grupal compartes la sesión con otras personas; en la personalizada trabajas solo tú (o tu grupo cerrado), a tu ritmo y horario.',
  talleres_avanzado_awaiting_info_choice: 'Claro: puedo mostrarte las próximas fechas disponibles, o contarte con detalle qué incluye el contenido del MasterClass Avanzado.',
  insumos_awaiting_tipo: 'Claro: las fragancias son los aromas para tus velas; los insumos generales incluyen cera, pabilos, colorantes, aditivos y moldes.',
  insumos_awaiting_precio_pedido: 'Claro: si quieres precios, te comparto la lista actualizada; si prefieres hacer un pedido, te conecto directo con un asesor para formalizarlo.',
  velas_awaiting_uso: 'Claro: si es para regalar, te ayudo a elegir presentación y detalles especiales; si es uso personal, nos enfocamos en tus gustos y espacio.'
};

// Reconocimientos cortos cuando el cliente pregunta por precio en medio de
// una elección de categoría, para no repetir la pregunta tal cual (Regla 10).
const PRICE_ACKNOWLEDGE = {
  talleres_awaiting_level: 'Con gusto te comparto los valores en cuanto sepa cuál te interesa 😊.',
  talleres_basico_awaiting_modalidad: 'Claro, los precios varían un poco según la modalidad 😊.',
  insumos_awaiting_tipo: '¡Con gusto! Los precios varían según lo que busques 😊.',
  velas_awaiting_categoria: 'Con gusto te doy el valor exacto según la categoría 😊.',
  velas_awaiting_uso: 'Claro, eso también puede variar un poco según el uso 😊.'
};

function handleUnrecognized(chatId, messageText, retryMessage) {
  const session = sessionStore.get(chatId);
  const stateKey = session?.state;

  // Preguntas legítimas de aclaración: se responden con contenido real y NO
  // cuentan como intento fallido (el cliente sí está participando).
  if (isAskingForDifference(messageText) && DIFFERENCE_EXPLANATIONS[stateKey]) {
    return { reply: `${DIFFERENCE_EXPLANATIONS[stateKey]} ${retryMessage}` };
  }
  if (isAskingAboutPrice(messageText) && PRICE_ACKNOWLEDGE[stateKey]) {
    return { reply: `${PRICE_ACKNOWLEDGE[stateKey]} ${retryMessage}` };
  }

  const count = (session?.misunderstandCount || 0) + 1;

  if (session) {
    session.misunderstandCount = count;
    session.updatedAt = Date.now();
    sessionStore.set(chatId, session);
  }

  if (count >= 2) {
    return escalateToAdvisor(
      chatId,
      'No quiero hacerte perder tiempo 🙏. Te comunico con un asesor de nuestro equipo para que te ayude directamente.'
    );
  }

  return { reply: retryMessage };
}

// =============================================================================
// DETECCIÓN DEL INTERÉS PRINCIPAL (reemplaza al menú numerado)
// =============================================================================
// Categorías específicas primero (señales fuertes). Si solo se detecta la
// palabra genérica "vela(s)" sin más contexto, Abby pregunta para descubrir
// la necesidad — tal como pide el ejemplo del brief.

const specificInterestKeywordMap = {
  talleres: ['taller', 'talleres', 'curso', 'cursos', 'aprender a hacer velas', 'masterclass', 'emprender con velas', 'clase de velas'],
  insumos: ['insumos', 'fragancias', 'cera', 'ceras', 'pabilo', 'pabilos', 'colorante', 'colorantes', 'aditivo', 'aditivos', 'molde', 'moldes', 'fabricar velas', 'materiales para velas'],
  velasRegalos: ['bouquet', 'bouquets', 'difusor', 'difusores', 'agua de lino', 'aguas de lino', 'kit de regalo', 'kits de regalo', 'vela aromatica', 'velas aromaticas', 'vela decorativa', 'velas decorativas', 'regalo personalizado', 'regalos personalizados'],
  experiencias: ['experiencia creativa', 'experiencias creativas', 'vivir una experiencia', 'plan para compartir', 'plan en pareja', 'plan con amigas'],
  club: ['club creativo', 'club de ninos', 'club de niños', 'taller para ninos', 'taller para niños'],
  recordatorios: ['recordatorios', 'recuerdos de matrimonio', 'recuerdos de bautizo', 'recuerdos de comunion', 'souvenirs', 'detalles para invitados', 'detalles para mis invitados']
};

const genericVelaKeywords = ['vela', 'velas'];

// Orden mostrado en el menú numerado del interés principal (Paso 3).
const MAIN_INTEREST_ORDER = ['talleres', 'experiencias', 'insumos', 'velasRegalos', 'recordatorios', 'club'];

function detectMainInterest(text, optionOrder) {
  if (optionOrder) {
    const byNumber = matchesNumberedOption(text, optionOrder);
    if (byNumber) return { type: byNumber };
  }
  const normalized = normalizeText(text);
  const specific = findFirstMatch(normalized, specificInterestKeywordMap);
  if (specific) return { type: specific };
  if (matchesAny(normalized, genericVelaKeywords)) return { type: 'ambiguousVelas' };
  return null;
}

// =============================================================================
// 1. TALLERES
// =============================================================================

const tallerLevelKeywordMap = {
  nunca: ['nunca he hecho velas', 'nunca', 'principiante', 'nunca he hecho', 'no se hacer'],
  yaHago: ['ya hago velas', 'ya hago', 'tecnicas nuevas', 'ya se hacer', 'ya tengo experiencia'],
  soloExperiencia: ['solo quiero vivir una experiencia', 'solo experiencia', 'solo probar', 'sin comprometerme'],
  personalizado: ['personalizado', 'a mi medida', 'uno a uno', 'clase privada']
};

// Orden mostrado en la lista numerada (soloExperiencia no se lista: se
// detecta solo por texto, como una salida natural si el cliente aclara que
// en realidad quiere una experiencia y no un curso).
const TALLERES_LEVEL_ORDER = ['nunca', 'yaHago', 'personalizado'];

// "personalizado" (masculino) queda fuera a propósito: dentro del flujo del
// MasterClass Básico esa palabra se redirige al MasterClass Personalizado
// (ver isTalleresPersonalizadoProductRequest), no a esta modalidad femenina.
const modalidadKeywordMap = {
  grupal: ['grupal', 'en grupo'],
  personalizada: ['personalizada', 'individual', 'uno a uno']
};
const MODALIDAD_ORDER = ['grupal', 'personalizada'];

const infoChoiceKeywordMap = {
  fechas: ['fecha', 'fechas', 'cuando'],
  contenido: ['contenido', 'que incluye', 'que aprendo']
};
const INFO_CHOICE_ORDER = ['fechas', 'contenido'];

function startTalleres(chatId, messageText) {
  const modalidadShortcut = messageText ? detectModalidadShortcut(messageText) : null;
  if (modalidadShortcut) {
    resetMisunderstandCount(chatId);
    return startTalleresBasicoConModalidad(chatId, modalidadShortcut);
  }

  addTag(chatId, 'Curso');
  setSession(chatId, 'talleres_awaiting_level');
  const nombre = getClientName(chatId);
  return {
    reply: [
      `¡Qué alegría que quieras aprender, ${nombre || ''}! 🎓`.replace('  ', ' '),
      '1. Nunca he hecho velas, quiero aprender desde cero',
      '2. Ya hago velas y busco técnicas nuevas',
      '3. Quiero algo completamente personalizado',
      'Cuéntame cuál te late más, con el número o con tus palabras 😊.'
    ].join('\n')
  };
}

// Atajo de modalidad: si el cliente menciona directamente "grupal" o la
// forma femenina inequívoca de "personalizada" (evitamos a propósito el
// masculino "personalizado", que ya significa el MasterClass Personalizado,
// un producto totalmente distinto), asumimos que ya eligió el MasterClass
// Básico y saltamos directo a pedir la ciudad, sin repetir la pregunta.
const MODALIDAD_SHORTCUT_KEYWORDS = {
  grupal: ['grupal', 'en grupo', 'modalidad grupal'],
  personalizada: ['modalidad personalizada', 'atencion personalizada', 'atención personalizada', 'clase personalizada', 'personalizada']
};

function detectModalidadShortcut(text) {
  return findFirstMatch(normalizeText(text), MODALIDAD_SHORTCUT_KEYWORDS);
}

function startTalleresBasicoConModalidad(chatId, modalidad) {
  addTag(chatId, 'Curso');
  updateContactProfile(chatId, { productoInteres: 'MasterClass Básico' });
  setSession(chatId, 'talleres_basico_awaiting_ciudad', { modalidad });
  return { reply: '¡Perfecto! Te cuento del MasterClass Básico entonces. ¿En qué ciudad te encuentras?' };
}

function handleTalleresAwaitingLevel(chatId, messageText) {
  const level = findChoice(messageText, tallerLevelKeywordMap, TALLERES_LEVEL_ORDER);

  if (!level) {
    // No eligió un nivel explícito, pero si nombra la modalidad directamente
    // (ej. "grupal" o "modalidad personalizada"), no hace falta preguntar de
    // nuevo: ya sabemos que quiere el MasterClass Básico.
    const modalidadShortcut = detectModalidadShortcut(messageText);
    if (modalidadShortcut) {
      resetMisunderstandCount(chatId);
      return startTalleresBasicoConModalidad(chatId, modalidadShortcut);
    }
    return handleUnrecognized(chatId, messageText, 'Cuéntame con tus palabras: ¿nunca has hecho velas, ya sabes hacerlas, o buscas algo personalizado? 😊');
  }
  resetMisunderstandCount(chatId);

  if (level === 'nunca') {
    // Si en el mismo mensaje ya mencionó la modalidad (ej. "nunca he hecho
    // velas, prefiero grupal"), saltamos directo a pedir la ciudad.
    const modalidadShortcut = detectModalidadShortcut(messageText);
    if (modalidadShortcut) {
      return startTalleresBasicoConModalidad(chatId, modalidadShortcut);
    }

    updateContactProfile(chatId, { productoInteres: 'MasterClass Básico' });
    setSession(chatId, 'talleres_basico_awaiting_modalidad');
    return {
      reply: [
        'Te recomiendo nuestro MasterClass Básico. Aprenderás desde cero: tipos de cera, fragancias, pabilos, cálculo de costos y la elaboración de varios tipos de velas.',
        'Incluye materiales, brunch, certificado y fotografías.',
        '¿Prefieres una modalidad grupal (1) o personalizada (2)?'
      ].join('\n')
    };
  }

  if (level === 'yaHago') {
    updateContactProfile(chatId, { productoInteres: 'MasterClass Avanzado' });
    const { pdfPath, alreadySent } = getPdfIfNotSentBefore(chatId, 'talleres_avanzado');
    setSession(chatId, 'talleres_avanzado_awaiting_info_choice');
    return {
      reply: [
        'Entonces seguramente disfrutarás nuestro MasterClass Avanzado, donde trabajamos técnicas especiales y proyectos premium.',
        describeCatalogDelivery(pdfPath, alreadySent, 'todos los detalles del MasterClass Avanzado'),
        '¿Te gustaría conocer las fechas disponibles (1) o prefieres que te cuente más del contenido (2)?'
      ].join('\n'),
      pdfPath
    };
  }

  if (level === 'personalizado') {
    return sendTalleresPersonalizadoInfo(chatId);
  }

  // soloExperiencia -> las experiencias se manejan completamente separadas de los cursos
  return startExperiencias(chatId);
}

// Sin preguntas de ciudad ni presupuesto: al ser un producto a la medida, se
// manda toda la info (con su imagen) y se confirma con el cliente si desea
// reservar antes de pasarlo a un asesor (no se transfiere directo).
const PERSONALIZADO_CONFIRM_QUESTION = [
  '¿Deseas reservar tu cupo?',
  '',
  '🟢 1. Sí, deseo reservar.',
  '💬 2. Aún tengo algunas preguntas.'
].join('\n');

function sendTalleresPersonalizadoInfo(chatId) {
  updateContactProfile(chatId, { productoInteres: 'MasterClass Personalizado' });
  const { pdfPath } = getPdfIfNotSentBefore(chatId, 'talleres_personalizado');
  const imagePath = getContentImagePath('personalized_class.jpeg');

  setSession(chatId, 'talleres_personalizado_awaiting_confirm');

  return {
    reply: [
      '🤍 ¿Te gustaría aprender con una atención mucho más personalizada?',
      'En esta modalidad tú eliges el día y el horario que mejor se adapten a ti. Tendrás un acompañamiento cercano para aprender con tranquilidad y resolver todas tus dudas.',
      'Puedes reservar tu cupo con $80.000, y el saldo lo cancelas el día del taller.',
      '',
      'Me encantará ayudarte a organizar tu MasterClass. 🌿',
      'Para revisar la disponibilidad y coordinar el día y horario que mejor se adapten a ti, uno de nuestros asesores continuará la atención.',
      'Antes de transferirte, solo quiero confirmar:',
      '',
      PERSONALIZADO_CONFIRM_QUESTION
    ].join('\n'),
    pdfPath,
    imagePath
  };
}

function handleTalleresPersonalizadoAwaitingConfirm(chatId, messageText) {
  const choice = findYesNo(messageText);
  if (!choice) {
    return handleUnrecognized(chatId, messageText, PERSONALIZADO_CONFIRM_QUESTION);
  }
  resetMisunderstandCount(chatId);

  if (choice === 'si') {
    return escalateToAdvisor(
      chatId,
      '¡Perfecto! Lo más pronto posible uno de nuestros asesores continuará contigo para coordinar la fecha, el horario y finalizar tu reserva. 😊'
    );
  }

  // "Aún tengo algunas preguntas": no se transfiere, Abby sigue atendiendo
  // con normalidad (vuelve al menú para que siga preguntando lo que necesite).
  return goToMainMenu(chatId);
}

// Dentro del flujo de MasterClass, "personalizado" (masculino) o "clases
// personalizadas" siempre se refieren al MasterClass Personalizado —un
// producto aparte del MasterClass Básico—, nunca a la modalidad femenina
// "personalizada" (grupal/personalizada) del Básico. Antes, si el cliente
// escribía "personalizado" mientras se le preguntaba la modalidad del
// Básico, se confundía con esa modalidad en vez de mostrarle la info del
// MasterClass Personalizado.
const TALLERES_PERSONALIZADO_PRODUCT_KEYWORDS = [
  'masterclass personalizado', 'taller personalizado', 'curso personalizado',
  'clases personalizadas', 'clase personalizada', 'personalizado'
];

function isTalleresPersonalizadoProductRequest(text) {
  return matchesAny(normalizeText(text), TALLERES_PERSONALIZADO_PRODUCT_KEYWORDS);
}

function handleTalleresBasicoAwaitingModalidad(chatId, messageText) {
  const modalidad = findChoice(messageText, modalidadKeywordMap, MODALIDAD_ORDER);
  if (!modalidad) {
    return handleUnrecognized(chatId, messageText, '¿Prefieres una modalidad grupal (1) o personalizada (2)?');
  }
  resetMisunderstandCount(chatId);

  const { pdfPath, alreadySent } = getPdfIfNotSentBefore(chatId, 'talleres_basico');
  setSession(chatId, 'talleres_basico_awaiting_ciudad', { modalidad });

  return {
    reply: [
      describeCatalogDelivery(pdfPath, alreadySent, 'toda la información del MasterClass Básico'),
      '¿En qué ciudad te encuentras?'
    ].join('\n'),
    pdfPath
  };
}

// Contenido fijo por modalidad del MasterClass Básico. Cuando se separe la
// base de conocimiento (precios, fechas, imágenes) de la lógica, este bloque
// es un candidato directo para vivir en knowledgeBase.js: hoy la fecha del
// 19 de julio y los valores están *hardcodeados* aquí, así que actualizarlos
// exige tocar código en vez de solo la base de conocimiento.
const TALLERES_BASICO_MODALIDAD_CONTENT = {
  personalizada: {
    imageFileName: 'personalized_class.jpeg',
    text: [
      '🤍 ¿Te gustaría aprender con una atención mucho más personalizada?',
      'En esta modalidad tú eliges el día y el horario que mejor se adapten a ti. Tendrás un acompañamiento cercano para aprender con tranquilidad y resolver todas tus dudas.',
      'Puedes reservar tu cupo con $80.000, y el saldo lo cancelas el día del taller.'
    ].join('\n')
  },
  grupal: {
    imageFileName: 'group_class.jpeg',
    text: [
      '🤍 Si llevas tiempo diciendo "algún día voy a aprender a hacer velas"… quizá este sea el momento de empezar.',
      'Nuestra próxima Masterclass Básica será:',
      '🗓️ Domingo 19 de julio',
      '🕘 9:00 a.m. a 3:00 p.m.',
      '💰 Valor: $250.000 por persona.',
      'Puedes separar tu cupo con $80.000, y cancelar el saldo el día del taller.',
      'Será un día para aprender, crear, hacer nuevas amistades y descubrir todo lo que eres capaz de hacer con tus propias manos. 🕯️🤍'
    ].join('\n')
  }
};

const AGENDAR_CUPO_QUESTION = '¿Deseas agendar tu cupo? 1️⃣ Sí  2️⃣ No';

function handleTalleresBasicoAwaitingCiudad(chatId, messageText) {
  const ciudad = messageText.trim();
  updateContactProfile(chatId, { ciudad });

  const session = getSession(chatId);
  const modalidad = session?.data?.modalidad;
  const content = TALLERES_BASICO_MODALIDAD_CONTENT[modalidad] || TALLERES_BASICO_MODALIDAD_CONTENT.grupal;
  const imagePath = getContentImagePath(content.imageFileName);

  setSession(chatId, 'talleres_basico_awaiting_agendar_confirm', { modalidad });
  return {
    reply: `${content.text}\n${AGENDAR_CUPO_QUESTION}`,
    imagePath
  };
}

function handleTalleresBasicoAwaitingAgendarConfirm(chatId, messageText) {
  const choice = findYesNo(messageText);
  if (!choice) {
    return handleUnrecognized(chatId, messageText, AGENDAR_CUPO_QUESTION);
  }
  resetMisunderstandCount(chatId);

  if (choice === 'si') {
    return escalateToAdvisor(chatId, '¡Genial! Un asesor de nuestro equipo se comunicará contigo para confirmar tu cupo en el MasterClass Básico.');
  }

  return goToMainMenu(chatId);
}

function handleTalleresAvanzadoAwaitingInfoChoice(chatId, messageText) {
  const choice = findChoice(messageText, infoChoiceKeywordMap, INFO_CHOICE_ORDER);
  if (!choice) {
    return handleUnrecognized(chatId, messageText, '¿Te muestro las fechas disponibles (1) o prefieres conocer más del contenido (2)?');
  }
  resetMisunderstandCount(chatId);

  if (choice === 'fechas') {
    return escalateToAdvisor(chatId, 'Un asesor de nuestro equipo te compartirá las próximas fechas disponibles del MasterClass Avanzado.');
  }

  setSession(chatId, 'talleres_avanzado_awaiting_fechas_o_personalizada');
  return {
    reply: [
      'El MasterClass Avanzado está diseñado para personas que ya tienen conocimientos básicos y desean ampliar su catálogo con productos premium.',
      '',
      'Durante el taller aprenderás tres técnicas especializadas:',
      '',
      '✨ Velas de masajes.',
      '',
      '🫧 Velas en cera gel.',
      '',
      '🍰 Velas estilo Chantilly con acabado tipo postre.',
      '',
      'Todos los proyectos se realizan paso a paso, con acompañamiento personalizado, materiales incluidos, certificado de asistencia y brunch.',
      '',
      'Valor grupal: $250.000 por persona.',
      'Valor personalizado: $300.000 por persona.',
      '',
      '¿Te gustaría conocer las próximas fechas disponibles o prefieres la modalidad personalizada?'
    ].join('\n'),
    imagePath: getContentImagePath('avanzado_masterclass.jpeg')
  };
}

// "Fechas" escala directo (como en la pregunta anterior); "modalidad
// personalizada" redirige al MasterClass Personalizado. La palabra
// "personalizada" aquí solo se evalúa dentro de este estado puntual (no en
// el detector global de talleres), para no repetir el conflicto ya
// resuelto antes con la modalidad femenina del MasterClass Básico.
function handleTalleresAvanzadoAwaitingFechasOPersonalizada(chatId, messageText) {
  const normalized = normalizeText(messageText);

  if (matchesAny(normalized, ['personalizada', 'personalizado', 'modalidad personalizada'])) {
    resetMisunderstandCount(chatId);
    return sendTalleresPersonalizadoInfo(chatId);
  }

  if (matchesAny(normalized, ['fecha', 'fechas', 'cuando', 'disponibilidad'])) {
    resetMisunderstandCount(chatId);
    return escalateToAdvisor(chatId, 'Un asesor de nuestro equipo te compartirá las próximas fechas disponibles del MasterClass Avanzado.');
  }

  return handleUnrecognized(chatId, messageText, '¿Te gustaría conocer las próximas fechas disponibles o prefieres la modalidad personalizada?');
}

// =============================================================================
// 2. EXPERIENCIAS CREATIVAS (separadas de los cursos)
// =============================================================================

function startExperiencias(chatId) {
  addTag(chatId, 'Experiencia');
  updateContactProfile(chatId, { productoInteres: 'Experiencia creativa' });
  setSession(chatId, 'experiencia_awaiting_personas');
  return {
    reply: 'Nuestras experiencias están pensadas para compartir un momento especial mientras crean una vela. ✨ ¿Para cuántas personas sería?'
  };
}

function handleExperienciaAwaitingPersonas(chatId, messageText) {
  const personas = messageText.trim();
  setSession(chatId, 'experiencia_awaiting_ocasion', { personas });
  return { reply: '¿Celebran alguna ocasión especial? (cumpleaños, aniversario, algo entre amigos, en pareja, empresarial...)' };
}

function handleExperienciaAwaitingOcasion(chatId, messageText) {
  const ocasion = messageText.trim();
  setSession(chatId, 'experiencia_awaiting_presupuesto', { ocasion });
  return { reply: '¡Qué lindo! ¿Tienes un presupuesto aproximado pensado para la experiencia?' };
}

function handleExperienciaAwaitingPresupuesto(chatId, messageText) {
  captureBudgetAnswer(chatId, messageText);
  setSession(chatId, 'experiencia_awaiting_fecha');
  return { reply: '¡Perfecto! ¿Qué fecha tienen en mente?' };
}

function handleExperienciaAwaitingFecha(chatId, messageText) {
  const fecha = messageText.trim();
  setSession(chatId, 'experiencia_awaiting_fecha', { fecha });
  return escalateToAdvisor(
    chatId,
    'Perfecto. Uno de nuestros asesores revisará disponibilidad y preparará una propuesta personalizada para tu experiencia.'
  );
}

// =============================================================================
// 3. INSUMOS (Fragancias vs. Insumos generales)
// =============================================================================

const insumoTipoKeywordMap = {
  fragancias: ['fragancias', 'fragancia', 'aromas'],
  generales: ['ceras', 'cera', 'pabilos', 'pabilo', 'colorantes', 'colorante', 'aditivos', 'aditivo', 'moldes', 'molde', 'insumos generales', 'catalogo completo']
};
const INSUMO_TIPO_ORDER = ['fragancias', 'generales'];

const precioPedidoKeywordMap = {
  precios: ['precios', 'precio'],
  pedido: ['pedido', 'realizar pedido', 'hacer pedido']
};
const PRECIO_PEDIDO_ORDER = ['precios', 'pedido'];

function startInsumos(chatId) {
  addTag(chatId, 'Insumos');
  setSession(chatId, 'insumos_awaiting_tipo');
  return {
    reply: [
      '¡Con gusto! 🕯️',
      '1. Fragancias',
      '2. Insumos en general (ceras, pabilos, colorantes, moldes)',
      'Cuéntame cuál te interesa, con el número o con tus palabras 😊.'
    ].join('\n')
  };
}

function handleInsumosAwaitingTipo(chatId, messageText) {
  const tipo = findChoice(messageText, insumoTipoKeywordMap, INSUMO_TIPO_ORDER);
  if (!tipo) {
    return handleUnrecognized(chatId, messageText, 'Cuéntame, ¿te interesan las fragancias (1) o los insumos en general (2)?');
  }
  resetMisunderstandCount(chatId);

  const category = tipo === 'fragancias' ? 'insumos_fragancias' : 'insumos_generales';
  updateContactProfile(chatId, { productoInteres: tipo === 'fragancias' ? 'Insumos - Fragancias' : 'Insumos generales' });
  const { pdfPath, alreadySent } = getPdfIfNotSentBefore(chatId, category);
  setSession(chatId, 'insumos_awaiting_precio_pedido', { tipo });

  return {
    reply: [
      describeCatalogDelivery(pdfPath, alreadySent, 'el catálogo'),
      '¿Deseas conocer precios (1) o prefieres realizar un pedido (2)?'
    ].join('\n'),
    pdfPath
  };
}

function handleInsumosAwaitingPrecioPedido(chatId, messageText) {
  const choice = findChoice(messageText, precioPedidoKeywordMap, PRECIO_PEDIDO_ORDER);
  if (!choice) {
    return handleUnrecognized(chatId, messageText, '¿Quieres conocer precios (1) o prefieres realizar un pedido (2)?');
  }
  resetMisunderstandCount(chatId);

  setSession(chatId, 'insumos_awaiting_presupuesto', { pedido: choice === 'pedido' });

  if (choice === 'pedido') {
    return { reply: 'Con gusto te ayudamos a formalizarlo. ¿Tienes un presupuesto aproximado para este pedido?' };
  }

  return {
    reply: 'Nuestros insumos son de alta calidad y rendimiento, pensados para que tus velas queden parejas y con buen aroma desde el primer intento. Antes de darte la lista de precios actualizada, cuéntame: ¿tienes un presupuesto aproximado en mente?'
  };
}

function handleInsumosAwaitingPresupuesto(chatId, messageText) {
  captureBudgetAnswer(chatId, messageText);
  const session = getSession(chatId);
  const esPedido = Boolean(session?.data?.pedido);

  if (esPedido) {
    return escalateToAdvisor(chatId, 'Un asesor de nuestro equipo te ayudará a formalizar tu pedido de insumos.');
  }

  setSession(chatId, 'insumos_awaiting_crosssell_talleres');
  return { reply: 'En un momento un asesor te compartirá la lista de precios actualizada. Por cierto, ¿ya conoces nuestros talleres para aprender a fabricar tus propias velas?' };
}

function handleInsumosAwaitingCrosssellTalleres(chatId, messageText) {
  const normalized = normalizeText(messageText);
  const quiere = matchesAny(normalized, ['si', 'sí', 'claro', 'de una', 'dale', 'quiero', 'cuentame', 'cuéntame']);

  if (quiere) {
    return startTalleres(chatId);
  }

  clearSession(chatId);
  return {
    reply: 'Perfecto 🌿. Si tienes otra pregunta sobre los insumos, ¿en qué más te puedo ayudar?',
    final: true
  };
}

// =============================================================================
// 4. VELAS Y REGALOS LISTOS
// =============================================================================

const velasCategoriaKeywordMap = {
  aromaticas: ['vela aromatica', 'velas aromaticas', 'aromaticas'],
  decorativas: ['vela decorativa', 'velas decorativas', 'decorativas'],
  bouquets: ['bouquet', 'bouquets'],
  difusores: ['difusor', 'difusores'],
  aguasDeLino: ['agua de lino', 'aguas de lino'],
  kitsRegalo: ['kit de regalo', 'kits de regalo', 'kit', 'kits'],
  regalosPersonalizados: ['regalo personalizado', 'regalos personalizados']
};

const VELAS_PDF_KEY = {
  aromaticas: 'velas_aromaticas',
  decorativas: 'velas_decorativas',
  bouquets: 'velas_bouquets',
  difusores: 'velas_difusores',
  aguasDeLino: 'velas_aguas_de_lino',
  kitsRegalo: 'velas_kits_regalo',
  regalosPersonalizados: 'velas_regalos_personalizados'
};

const VELAS_CATEGORIA_ORDER = ['aromaticas', 'decorativas', 'bouquets', 'difusores', 'aguasDeLino', 'kitsRegalo', 'regalosPersonalizados'];

const usoKeywordMap = {
  regalar: ['regalar', 'regalo', 'es para regalar', 'para obsequiar'],
  personal: ['personal', 'uso personal', 'para mi', 'para mi casa']
};
const USO_ORDER = ['regalar', 'personal'];

function startVelasListas(chatId) {
  addTag(chatId, 'Velas y Regalos');
  setSession(chatId, 'velas_awaiting_categoria');
  return {
    reply: [
      '¡Con gusto! 🎁 ¿Qué tipo de vela o regalo tienes en mente?',
      '1. Velas aromáticas',
      '2. Velas decorativas',
      '3. Bouquet',
      '4. Difusores',
      '5. Aguas de lino',
      '6. Kit de regalo',
      '7. Regalo personalizado',
      'Puedes responder con el número o con tus palabras 😊.'
    ].join('\n')
  };
}

function handleVelasAwaitingCategoria(chatId, messageText) {
  const categoria = findChoice(messageText, velasCategoriaKeywordMap, VELAS_CATEGORIA_ORDER);
  if (!categoria) {
    return handleUnrecognized(chatId, messageText, 'Cuéntame un poco más: ¿buscas velas aromáticas, decorativas, un bouquet, difusores, aguas de lino o un kit de regalo?');
  }
  resetMisunderstandCount(chatId);

  updateContactProfile(chatId, { productoInteres: `Velas/Regalos - ${categoria}` });
  const { pdfPath, alreadySent } = getPdfIfNotSentBefore(chatId, VELAS_PDF_KEY[categoria]);
  setSession(chatId, 'velas_awaiting_uso', { categoria });

  return {
    reply: [
      describeCatalogDelivery(pdfPath, alreadySent, 'el catálogo'),
      '¿Es para regalar (1) o para uso personal (2)?'
    ].join('\n'),
    pdfPath
  };
}

function handleVelasAwaitingUso(chatId, messageText) {
  const uso = findChoice(messageText, usoKeywordMap, USO_ORDER);
  if (!uso) {
    return handleUnrecognized(chatId, messageText, '¿Es para regalar (1) o para uso personal (2)?');
  }
  resetMisunderstandCount(chatId);

  if (uso === 'personal') {
    setSession(chatId, 'velas_awaiting_presupuesto_personal');
    return { reply: '¡Perfecto! ¿Tienes un presupuesto aproximado en mente para orientarte mejor?' };
  }

  setSession(chatId, 'velas_awaiting_ocasion');
  return { reply: '¡Qué lindo detalle! ¿Para qué ocasión es el regalo?' };
}

function handleVelasAwaitingPresupuestoPersonal(chatId, messageText) {
  captureBudgetAnswer(chatId, messageText);
  clearSession(chatId);
  return {
    reply: '¡Listo! Con esa información puedo orientarte mejor. ¿Te gustaría que te recomiende algunas opciones dentro de ese rango?',
    final: true
  };
}

function handleVelasAwaitingOcasion(chatId, messageText) {
  const ocasion = messageText.trim();
  updateContactProfile(chatId, { productoInteres: `Regalo - ${ocasion}` });
  setSession(chatId, 'velas_awaiting_presupuesto_regalo', { ocasion });
  return { reply: '¡Qué lindo! ¿Tienes un presupuesto aproximado pensado para el regalo?' };
}

const TARJETA_EMPAQUE_QUESTION = 'Para hacerlo aún más especial, ¿te gustaría agregar una tarjeta personalizada y empaque de regalo? 1️⃣ Sí  2️⃣ No';
const CONTACTO_ASESOR_QUESTION = '¿Deseas que un asesor te contacte ahora? 1️⃣ Sí  2️⃣ No';

function handleVelasAwaitingPresupuestoRegalo(chatId, messageText) {
  captureBudgetAnswer(chatId, messageText);
  setSession(chatId, 'velas_awaiting_crosssell_regalo');
  return { reply: TARJETA_EMPAQUE_QUESTION };
}

function handleVelasAwaitingCrosssellRegalo(chatId, messageText) {
  const choice = findYesNo(messageText);
  if (!choice) {
    return handleUnrecognized(chatId, messageText, TARJETA_EMPAQUE_QUESTION);
  }
  resetMisunderstandCount(chatId);
  if (choice === 'si') addTag(chatId, 'Tarjeta y empaque regalo');

  setSession(chatId, 'velas_awaiting_contacto_asesor');
  return {
    reply: [
      choice === 'si' ? '¡Genial! Ya quedó anotado 🎁.' : 'Perfecto 🌿.',
      'Si quieres cotizar o hacer el pedido, te conecto con un asesor.',
      CONTACTO_ASESOR_QUESTION
    ].join('\n')
  };
}

function handleVelasAwaitingContactoAsesor(chatId, messageText) {
  const choice = findYesNo(messageText);
  if (!choice) {
    return handleUnrecognized(chatId, messageText, CONTACTO_ASESOR_QUESTION);
  }
  resetMisunderstandCount(chatId);

  if (choice === 'si') {
    return escalateToAdvisor(chatId, '¡Listo! Un asesor de nuestro equipo te contactará para cotizar o confirmar tu pedido.');
  }

  return goToMainMenu(chatId);
}

// =============================================================================
// 5. RECORDATORIOS PARA EVENTOS (no se envía catálogo primero)
// =============================================================================

function startRecordatorios(chatId) {
  addTag(chatId, 'Eventos');
  setSession(chatId, 'recordatorio_awaiting_evento');
  return { reply: '¡Qué especial! 💐 ¿Qué vas a celebrar? (matrimonio, baby shower, primera comunión, bautizo, 15 años, cumpleaños, evento empresarial...)' };
}

function handleRecordatorioAwaitingEvento(chatId, messageText) {
  const evento = messageText.trim();
  updateContactProfile(chatId, { productoInteres: `Recordatorio - ${evento}` });
  setSession(chatId, 'recordatorio_awaiting_unidades', { evento });
  return { reply: '¿Cuántas unidades necesitas aproximadamente?' };
}

function handleRecordatorioAwaitingUnidades(chatId, messageText) {
  const unidades = messageText.trim();
  setSession(chatId, 'recordatorio_awaiting_fecha', { unidades });
  return { reply: '¿Para qué fecha los necesitas?' };
}

function handleRecordatorioAwaitingFecha(chatId, messageText) {
  const fecha = messageText.trim();
  setSession(chatId, 'recordatorio_awaiting_diseno', { fecha });
  return { reply: '¿Ya tienes un diseño en mente, o prefieres que nosotros te propongamos uno?' };
}

function handleRecordatorioAwaitingDiseno(chatId, messageText) {
  const normalized = normalizeText(messageText);
  const tieneDiseno = matchesAny(normalized, ['ya tengo', 'tengo diseno', 'tengo diseño', 'tengo uno']);
  const disenoInfo = tieneDiseno ? 'Ya tiene diseño propio' : 'Necesita que se lo diseñemos';

  setSession(chatId, 'recordatorio_awaiting_presupuesto', { disenoInfo });
  return { reply: '¡Genial! ¿Tienes un presupuesto aproximado en mente para los recordatorios?' };
}

function handleRecordatorioAwaitingPresupuesto(chatId, messageText) {
  captureBudgetAnswer(chatId, messageText);
  setSession(chatId, 'recordatorio_awaiting_crosssell');
  return { reply: 'Para completar el evento, ¿también te gustaría cotizar centros de mesa o regalos para tus invitados?' };
}

function handleRecordatorioAwaitingCrosssell(chatId, messageText) {
  const normalized = normalizeText(messageText);
  const quiere = matchesAny(normalized, ['si', 'sí', 'claro', 'de una', 'dale', 'quiero']);
  if (quiere) addTag(chatId, 'Centros de mesa / regalos invitados');

  const session = getSession(chatId);
  const disenoInfo = session?.data?.disenoInfo || '';

  return escalateToAdvisor(
    chatId,
    `¡Gracias por toda la información! Un asesor de nuestro equipo continuará contigo para confirmar los detalles de tus recordatorios${disenoInfo ? ` (${disenoInfo})` : ''}${quiere ? ' y de los centros de mesa / regalos para invitados' : ''}.`
  );
}

// =============================================================================
// 6. CLUB CREATIVO PARA NIÑOS Y JÓVENES
// =============================================================================

function startClubCreativo(chatId) {
  addTag(chatId, 'Club');
  setSession(chatId, 'club_awaiting_edad');
  return { reply: '¡Nos encanta que preguntes por el Club Creativo! 🎨 ¿Qué edad tiene el niño o la niña?' };
}

function handleClubAwaitingEdad(chatId, messageText) {
  const edad = messageText.trim();
  updateContactProfile(chatId, { productoInteres: 'Club Creativo' });
  setSession(chatId, 'club_awaiting_jornada', { edad });
  return { reply: '¿En qué jornada les gustaría participar (mañana, tarde, fines de semana)?' };
}

function handleClubAwaitingJornada(chatId, messageText) {
  const jornada = messageText.trim();
  setSession(chatId, 'club_awaiting_acudiente_nombre', { jornada });
  return { reply: '¿Cuál es el nombre del acudiente?' };
}

function handleClubAwaitingAcudienteNombre(chatId, messageText) {
  const acudiente = messageText.trim();
  setSession(chatId, 'club_awaiting_acudiente_telefono', { acudiente });
  return { reply: '¿A qué número de teléfono podemos comunicarnos con el acudiente?' };
}

function handleClubAwaitingAcudienteTelefono(chatId, messageText) {
  const telefono = messageText.trim();
  const { pdfPath, alreadySent } = getPdfIfNotSentBefore(chatId, 'club_creativo');
  setSession(chatId, 'club_awaiting_presupuesto', { telefono });

  return {
    reply: [
      describeCatalogDelivery(pdfPath, alreadySent, 'toda la información del Club Creativo'),
      '¿Tienes un presupuesto aproximado en mente para el Club Creativo?'
    ].join('\n'),
    pdfPath
  };
}

const CLUB_RESERVAR_CUPO_QUESTION = '¡Perfecto! ¿Deseas reservar un cupo? 1️⃣ Sí  2️⃣ No';

function handleClubAwaitingPresupuesto(chatId, messageText) {
  captureBudgetAnswer(chatId, messageText);
  setSession(chatId, 'club_awaiting_reserva');
  return { reply: CLUB_RESERVAR_CUPO_QUESTION };
}

function handleClubAwaitingReserva(chatId, messageText) {
  const choice = findYesNo(messageText);
  if (!choice) {
    return handleUnrecognized(chatId, messageText, CLUB_RESERVAR_CUPO_QUESTION);
  }
  resetMisunderstandCount(chatId);

  if (choice === 'si') {
    return escalateToAdvisor(chatId, '¡Genial! Un asesor de nuestro equipo se comunicará contigo para confirmar el cupo en el Club Creativo.');
  }

  return goToMainMenu(chatId);
}

// =============================================================================
// VELAS AMBIGUAS ("quiero velas") — Abby descubre antes de enviar catálogo
// =============================================================================

const velasClarifyKeywordMap = {
  comprarHechas: ['regalar', 'decorar', 'decoracion', 'ya hechas', 'comprar', 'obsequiar'],
  aprenderFabricar: ['aprender', 'fabricar', 'yo mismo', 'hacerlas yo', 'tomar un taller', 'curso']
};
const VELAS_CLARIFY_ORDER = ['comprarHechas', 'aprenderFabricar'];

function startVelasClarify(chatId) {
  setSession(chatId, 'awaiting_velas_clarify');
  return {
    reply: '¡Con gusto! 😊 ¿Las buscas ya hechas para regalar o decorar (1), o te gustaría aprender a fabricarlas tú mismo(a) (2)?'
  };
}

function handleAwaitingVelasClarify(chatId, messageText) {
  const choice = findChoice(messageText, velasClarifyKeywordMap, VELAS_CLARIFY_ORDER);
  if (!choice) {
    return handleUnrecognized(chatId, messageText, '¿Buscas velas ya hechas para regalar/decorar (1), o quieres aprender a fabricarlas tú mismo(a) (2)?');
  }
  resetMisunderstandCount(chatId);

  if (choice === 'comprarHechas') {
    return startVelasListas(chatId);
  }

  // aprenderFabricar: ¿taller o insumos?
  setSession(chatId, 'awaiting_fabricar_clarify');
  return { reply: '¿Te gustaría tomar un taller para aprender desde cero (1), o ya sabes hacerlas y buscas los insumos para fabricarlas (2)?' };
}

const fabricarClarifyKeywordMap = {
  taller: ['taller', 'aprender', 'curso', 'clase'],
  insumos: ['insumos', 'ya se', 'ya se hacer', 'ya hago', 'materiales']
};
const FABRICAR_CLARIFY_ORDER = ['taller', 'insumos'];

function handleAwaitingFabricarClarify(chatId, messageText) {
  const choice = findChoice(messageText, fabricarClarifyKeywordMap, FABRICAR_CLARIFY_ORDER);
  if (!choice) {
    return handleUnrecognized(chatId, messageText, '¿Prefieres tomar un taller para aprender (1), o ya sabes hacerlas y necesitas los insumos (2)?');
  }
  resetMisunderstandCount(chatId);
  return choice === 'taller' ? startTalleres(chatId) : startInsumos(chatId);
}

// =============================================================================
// ENRUTADOR DE INTERÉS PRINCIPAL
// =============================================================================

function startFlowForInterest(chatId, interestType, messageText) {
  switch (interestType) {
    case 'talleres':
      return startTalleres(chatId, messageText);
    case 'experiencias':
      return startExperiencias(chatId);
    case 'insumos':
      return startInsumos(chatId);
    case 'velasRegalos':
      return startVelasListas(chatId);
    case 'recordatorios':
      return startRecordatorios(chatId);
    case 'club':
      return startClubCreativo(chatId);
    case 'ambiguousVelas':
      return startVelasClarify(chatId);
    default:
      return null;
  }
}

// =============================================================================
// TABLA DE MANEJADORES POR ESTADO
// =============================================================================

const STATE_HANDLERS = {
  talleres_awaiting_level: handleTalleresAwaitingLevel,
  talleres_basico_awaiting_modalidad: handleTalleresBasicoAwaitingModalidad,
  talleres_basico_awaiting_ciudad: handleTalleresBasicoAwaitingCiudad,
  talleres_basico_awaiting_agendar_confirm: handleTalleresBasicoAwaitingAgendarConfirm,
  talleres_avanzado_awaiting_info_choice: handleTalleresAvanzadoAwaitingInfoChoice,
  talleres_avanzado_awaiting_fechas_o_personalizada: handleTalleresAvanzadoAwaitingFechasOPersonalizada,
  talleres_personalizado_awaiting_confirm: handleTalleresPersonalizadoAwaitingConfirm,

  experiencia_awaiting_personas: handleExperienciaAwaitingPersonas,
  experiencia_awaiting_ocasion: handleExperienciaAwaitingOcasion,
  experiencia_awaiting_presupuesto: handleExperienciaAwaitingPresupuesto,
  experiencia_awaiting_fecha: handleExperienciaAwaitingFecha,

  insumos_awaiting_tipo: handleInsumosAwaitingTipo,
  insumos_awaiting_precio_pedido: handleInsumosAwaitingPrecioPedido,
  insumos_awaiting_presupuesto: handleInsumosAwaitingPresupuesto,
  insumos_awaiting_crosssell_talleres: handleInsumosAwaitingCrosssellTalleres,

  velas_awaiting_categoria: handleVelasAwaitingCategoria,
  velas_awaiting_uso: handleVelasAwaitingUso,
  velas_awaiting_presupuesto_personal: handleVelasAwaitingPresupuestoPersonal,
  velas_awaiting_ocasion: handleVelasAwaitingOcasion,
  velas_awaiting_presupuesto_regalo: handleVelasAwaitingPresupuestoRegalo,
  velas_awaiting_crosssell_regalo: handleVelasAwaitingCrosssellRegalo,
  velas_awaiting_contacto_asesor: handleVelasAwaitingContactoAsesor,

  recordatorio_awaiting_evento: handleRecordatorioAwaitingEvento,
  recordatorio_awaiting_unidades: handleRecordatorioAwaitingUnidades,
  recordatorio_awaiting_fecha: handleRecordatorioAwaitingFecha,
  recordatorio_awaiting_diseno: handleRecordatorioAwaitingDiseno,
  recordatorio_awaiting_presupuesto: handleRecordatorioAwaitingPresupuesto,
  recordatorio_awaiting_crosssell: handleRecordatorioAwaitingCrosssell,

  club_awaiting_edad: handleClubAwaitingEdad,
  club_awaiting_jornada: handleClubAwaitingJornada,
  club_awaiting_acudiente_nombre: handleClubAwaitingAcudienteNombre,
  club_awaiting_acudiente_telefono: handleClubAwaitingAcudienteTelefono,
  club_awaiting_presupuesto: handleClubAwaitingPresupuesto,
  club_awaiting_reserva: handleClubAwaitingReserva,

  awaiting_velas_clarify: handleAwaitingVelasClarify,
  awaiting_fabricar_clarify: handleAwaitingFabricarClarify
};

// =============================================================================
// PUNTO DE ENTRADA PRINCIPAL
// =============================================================================

function handleConversation(chatId, messageText) {
  clearFollowUps(chatId);

  const session = getSession(chatId);
  const currentState = session ? session.state : null;
  const hasActiveFlow = Boolean(currentState) && currentState !== 'awaiting_name';

  // 0) Solicitud de acceso al grupo: solo cuando NO hay un flujo activo. Si
  // hay una conversación en curso (ej. le estamos preguntando la modalidad
  // grupal/personalizada de un taller) y responde "grupo"/"en grupo", eso
  // debe seguir su curso normal en vez de interpretarse como pedido del
  // enlace al grupo de WhatsApp.
  if (!hasActiveFlow && isGroupRequest(messageText)) {
    return { reply: getGroupInviteMessage() };
  }

  // 1) Preguntas frecuentes. Si NO hay flujo activo, se responden solas.
  //    Si SÍ hay flujo activo, se combinan con la respuesta del flujo en vez
  //    de reemplazarla: antes, un mensaje como "nunca he hecho velas... y vi
  //    sus redes" hacía que Abby solo contestara lo de redes y perdiera por
  //    completo el "nunca he hecho velas" (la respuesta real del flujo).
  const faqAnswer = checkFaq(messageText);
  if (faqAnswer && !hasActiveFlow) {
    return { reply: faqAnswer };
  }

  const result = resolveFlow(chatId, messageText, session, currentState);

  const finalResult =
    faqAnswer && result && result.reply
      ? { ...result, reply: `${faqAnswer}\n\n${result.reply}` }
      : result;

  // Recordamos la última pregunta que se le hizo al cliente (mientras el
  // flujo siga activo) para poder repetirla tal cual si en el siguiente
  // mensaje solo saluda en vez de responderla (ver punto 2d de resolveFlow).
  if (finalResult && finalResult.reply && !finalResult.final) {
    const updatedSession = getSession(chatId);
    if (updatedSession) {
      setSession(chatId, updatedSession.state, { lastPrompt: finalResult.reply });
    }
  }

  return finalResult;
}

function resolveFlow(chatId, messageText, session, currentState) {
  // 2) Disparadores explícitos de escalamiento a asesor humano (máxima prioridad).
  if (!isGreeting(messageText)) {
    const trigger = detectEscalationTrigger(messageText, currentState);
    if (trigger) {
      return escalateToAdvisor(chatId, ESCALATION_TRIGGER_MESSAGES[trigger]);
    }
  }

  // 2b) Cliente ya está en la etapa de espera del comprobante de pago.
  if (currentState === 'esperando_comprobante') {
    const normalized = normalizeText(messageText);
    if (matchesAny(normalized, ['comprobante', 'ya pague', 'ya pagué', 'ya envie', 'ya envié', 'listo ya pague', 'listo ya pagué'])) {
      clearPaymentReminder(chatId);
      return escalateToAdvisor(chatId, '¡Gracias! Un asesor de nuestro equipo confirmará tu reserva en cuanto revise tu comprobante.');
    }
    if (isPaymentIntent(messageText)) {
      // Ya le compartimos los medios de pago: recordamos brevemente en vez
      // de repetir toda la información de nuevo (Regla 10: no sonar robótica).
      return { reply: 'Cuando tengas listo el comprobante, lo puedes enviar aquí mismo junto con tu nombre completo y confirmamos tu reserva 😊.' };
    }
    // Cualquier otro mensaje mientras espera el comprobante sigue su curso normal.
  }

  // 2c) Intención de pago/reserva en cualquier otro momento de la conversación
  // (ej. "¿dónde reservo?", "¿cómo pago?", "quiero separar mi cupo"): Abby
  // resuelve sola en vez de escalar, compartiendo los medios de pago.
  if (currentState !== 'esperando_comprobante' && !isGreeting(messageText) && isPaymentIntent(messageText)) {
    return handlePaymentIntent(chatId);
  }

  // 2d) Si el cliente solo saluda ("hola", "buenas"...) en medio de un flujo
  // activo, NO se debe interpretar como respuesta a la pregunta pendiente.
  // Antes, ese saludo se guardaba tal cual como si fuera un dato real
  // (ciudad, presupuesto, fecha...) o incluso disparaba un escalamiento a
  // asesor sin sentido (caso real: el cliente escribió "hola" mientras se le
  // pedía el presupuesto del MasterClass Personalizado y el bot respondió
  // como si ya hubiera confirmado el agendamiento). Ahora se saluda de
  // vuelta y se repite la pregunta pendiente tal cual, sin tocar los datos
  // capturados ni sumar al contador de intentos fallidos.
  if (currentState && currentState !== 'awaiting_name' && isGreeting(messageText)) {
    const pendingQuestion = session?.data?.lastPrompt;
    if (pendingQuestion) {
      return { reply: `¡Hola de nuevo! 😊 ${pendingQuestion}` };
    }
  }

  // 2e) Comando explícito de "menú"/"menú principal"/"volver al menú" en
  // cualquier punto de un flujo activo. Caso real: un cliente escribió
  // "Menú principal" mientras se le preguntaba por el catálogo de insumos,
  // y el bot lo interpretó como un "no" a esa pregunta en vez de llevarlo
  // al menú principal.
  if (currentState && currentState !== 'awaiting_name' && isMenuRequest(messageText)) {
    resetMisunderstandCount(chatId);
    return goToMainMenu(chatId);
  }

  // 2f) El cliente indica que se equivocó de opción/número ("le di al
  // número que no era", "me equivoqué", "me confundí"...) en medio de un
  // flujo activo. En vez de guardar esa frase como si fuera la respuesta
  // real a la pregunta pendiente, se repite la pregunta para que pueda
  // responder de nuevo.
  if (currentState && currentState !== 'awaiting_name' && isCorrectionMessage(messageText)) {
    const pendingQuestion = session?.data?.lastPrompt;
    if (pendingQuestion) {
      resetMisunderstandCount(chatId);
      return { reply: `¡Sin problema! 😊 ${pendingQuestion}` };
    }
  }

  // 3) Capturando el nombre del cliente (primer paso tras el saludo).
  if (currentState === 'awaiting_name') {
    const nombre = messageText.trim();
    updateContactProfile(chatId, { nombre });
    setSession(chatId, 'awaiting_interest');
    return {
      reply: [
        `¡Un gusto, ${nombre.split(' ')[0]}! 🌿 Cuéntame, ¿qué te gustaría conocer hoy?`,
        '1. Talleres para aprender a hacer velas',
        '2. Experiencias creativas',
        '3. Insumos para fabricar velas',
        '4. Velas y regalos listos',
        '5. Recordatorios para eventos',
        '6. Club Creativo',
        'Puedes responderme con el número o simplemente contarme con tus palabras 😊.'
      ].join('\n')
    };
  }

  // 3b) Dentro del flujo de MasterClass (Básico/Avanzado en curso), si el
  // cliente pide "personalizado" o "clases personalizadas" en cualquier
  // paso, lo llevamos directo a la info del MasterClass Personalizado en
  // vez de dejar que el paso actual (ej. la pregunta de modalidad) lo
  // malinterprete.
  if (
    currentState &&
    currentState.startsWith('talleres_') &&
    !currentState.startsWith('talleres_personalizado_') &&
    isTalleresPersonalizadoProductRequest(messageText)
  ) {
    resetMisunderstandCount(chatId);
    return sendTalleresPersonalizadoInfo(chatId);
  }

  // 4) Si hay una sesión activa dentro de un flujo, delegar al manejador de ese estado.
  if (session && STATE_HANDLERS[session.state]) {
    return STATE_HANDLERS[session.state](chatId, messageText);
  }

  // 5) Esperando la elección del interés principal (post-saludo).
  if (currentState === 'awaiting_interest') {
    const interest = detectMainInterest(messageText, MAIN_INTEREST_ORDER);
    if (!interest) {
      return handleUnrecognized(chatId, messageText, 'Cuéntame un poco más de lo que buscas: ¿talleres, experiencias, insumos, velas y regalos, recordatorios o el Club Creativo?');
    }
    resetMisunderstandCount(chatId);
    const result = startFlowForInterest(chatId, interest.type, messageText);
    if (result) return result;
  }

  // 6) Sin sesión: saludo -> pedir nombre.
  if (isGreeting(messageText)) {
    setSession(chatId, 'awaiting_name');
    return { reply: getWelcomeMessage() };
  }

  // 7) Sin sesión pero el usuario ya escribió directamente su interés.
  const directInterest = detectMainInterest(messageText);
  if (directInterest) {
    const result = startFlowForInterest(chatId, directInterest.type, messageText);
    if (result) return result;
  }

  // 8) Nada de lo anterior aplicó: respuesta genérica de respaldo (puede
  // ser null si tampoco hay una regla de responseService.js que coincida;
  // en ese caso no se envía nada en vez de un mensaje genérico repetitivo).
  const fallback = getAutoReply(messageText);
  return { reply: fallback };
}

// =============================================================================
// PERSISTENCIA EN DISCO
// =============================================================================
// Todo lo anterior (sesiones, perfiles, chats pausados, seguimientos) vive
// en Maps/Sets en memoria: un reinicio del proceso los borraba sin aviso.
// Aquí se guarda una foto periódica en disco y se recupera al arrancar, sin
// tocar ninguna de las reglas de conversación de arriba.
function serializeState() {
  return {
    sessions: Object.fromEntries(sessionStore),
    contactProfiles: Object.fromEntries(contactProfileStore),
    pausedChats: [...pausedChats],
    followUpArmedAt: Object.fromEntries(followUpArmedAt),
    followUpFiredStages: Object.fromEntries(
      [...followUpFiredStages.entries()].map(([chatId, set]) => [chatId, [...set]])
    ),
    paymentReminderArmedAt: Object.fromEntries(paymentReminderArmedAt)
  };
}

function persistState() {
  saveState(serializeState());
}

function hydrateState() {
  const state = loadState();

  for (const [chatId, session] of Object.entries(state.sessions || {})) {
    sessionStore.set(chatId, session);
  }
  for (const [chatId, profile] of Object.entries(state.contactProfiles || {})) {
    contactProfileStore.set(chatId, profile);
  }
  (state.pausedChats || []).forEach((chatId) => pausedChats.add(chatId));
  for (const [chatId, armedAt] of Object.entries(state.followUpArmedAt || {})) {
    followUpArmedAt.set(chatId, armedAt);
  }
  for (const [chatId, stages] of Object.entries(state.followUpFiredStages || {})) {
    followUpFiredStages.set(chatId, new Set(stages));
  }
  for (const [chatId, armedAt] of Object.entries(state.paymentReminderArmedAt || {})) {
    paymentReminderArmedAt.set(chatId, armedAt);
  }
}

hydrateState();

const PERSIST_INTERVAL_MS = 30 * 1000;
const persistTimer = setInterval(persistState, PERSIST_INTERVAL_MS);
// unref(): este timer no debe mantener el proceso vivo por sí solo (ej. en
// pruebas automatizadas que requieren este módulo y terminan enseguida).
if (typeof persistTimer.unref === 'function') persistTimer.unref();

function persistAndExit() {
  persistState();
  process.exit(0);
}
process.on('SIGINT', persistAndExit);
process.on('SIGTERM', persistAndExit);

module.exports = {
  handleConversation,
  clearSession,
  scheduleFollowUps,
  clearFollowUps,
  schedulePaymentReminder,
  clearPaymentReminder,
  getContactProfile,
  pauseBot,
  resumeBot,
  isBotPaused,
  isResumeBotCommand,
  rearmPendingReminders
};
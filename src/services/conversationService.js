/**
 * conversationService.js - revision comercial Con Sentido
 * Alcance implementado con detalle: Flujo 1 Talleres, Flujo 2 Experiencia,
 * Flujo 3 Insumos y Flujo 4 (menu + bouquets). Los flujos 5 y 6 quedan
 * disponibles con una respuesta base para no romper el menu mientras se terminan.
 */
const fs = require('fs');
const path = require('path');
const { loadState, saveState } = require('./persistentStore');
const KB = require('../config/knowledgeBase');
const { isWeekday, toIsoDate, formatDateEs } = require('../utils/dateEs');
const { isWorkshopSlotAllowed, isExperienceTextSlotBlocked } = require('../utils/schedulingRules');

const SESSION_TTL = 20 * 60 * 1000;
const CONTACT_PROFILE_TTL = 30 * 24 * 60 * 60 * 1000;
const FOLLOW_UP_MESSAGES = [
  { delay: 24 * 60 * 60 * 1000, text: 'Hola, ¿pudiste revisar la informacion que te envie? Si quieres, te ayudo a continuar. 🌿' },
  { delay: 3 * 24 * 60 * 60 * 1000, text: 'Paso por aqui por si aun quieres continuar con tu consulta en Con Sentido. Estoy pendiente para ayudarte. 😊' },
];
const PAYMENT_REMINDER_DELAY_MS = 24 * 60 * 60 * 1000;
// Cuanto tiempo se mantiene apagado el bot en un chat despues de que
// respondes manualmente, si el cliente no vuelve a escribir. Pasado ese
// tiempo sin actividad, el bot se reactiva solo para ese chat (no hace
// falta escribir "bot on"). Si el cliente escribe antes de que se cumpla,
// sigue apagado.
const PAUSE_TTL_MS = 24 * 60 * 60 * 1000;

const sessionStore = new Map();
const contactProfileStore = new Map();
const pausedChats = new Map(); // chatId -> timestamp de la ultima pausa/actividad
const followUpTimers = new Map();
const paymentReminderTimers = new Map();
const followUpArmedAt = new Map();
const paymentReminderArmedAt = new Map();
const lastAdvisorNotificationAt = new Map();
// Historial simple de mensajes cliente/bot por chat, para poder leer la
// conversacion desde el panel (sobre todo en Escalamientos). No incluye
// los mensajes manuales que tu escribes cuando pausas el bot: esos ya se
// ven directo en WhatsApp.
const CONVERSATION_LOG_LIMIT = 200; // mensajes por chat
const conversationLogs = new Map();

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function money(value) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value);
}
function firstName(chatId) {
  const p = getContactProfile(chatId);
  return p?.nombre ? p.nombre.split(/\s+/)[0] : null;
}
// Detecta un nombre declarado explicitamente ("soy Beatriz", "me llamo
// Juan", "mi nombre es Ana"), venga solo o mezclado con otra cosa en el
// mismo mensaje (ej. "1, soy Beatriz" tambien responde una pregunta del
// flujo). Sin esto, ese texto se guardaria completo como "nombre"
// (incluyendo el "soy"), o el "soy Beatriz" se perderia si el mensaje
// tenia mas de una palabra.
function extractDeclaredName(text) {
  const n = normalizeText(text);
  const m = n.match(/\b(?:soy|me llamo|mi nombre es)\s+([a-z]+)/);
  if (!m) return null;
  return m[1].charAt(0).toUpperCase() + m[1].slice(1);
}
function isYes(text) {
  const n = normalizeText(text);
  return /^(1|si|claro|dale|de una|quiero|ok|okay|listo)\b/.test(n) || n.includes('quiero reservar') || n.includes('quiero coordinar');
}
function isNoOrQuestion(text) {
  const n = normalizeText(text);
  return /^(2|no)\b/.test(n) || n.includes('duda') || n.includes('pregunta');
}
// Antes exigia que el mensaje fuera SOLO el numero (nada mas). Se
// flexibiliza a "empieza con el numero" (ej. "1, soy Beatriz" o
// "2 por favor") para no perder respuestas reales que traen algo mas
// pegado, sin arriesgarse a leer de mas: el \b despues del numero exige
// que no sean mas digitos pegados (ej. "1234567890" no matchea "12").
function numbered(text, max) {
  const m = String(text || '').trim().match(/^(\d{1,2})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= max ? n : null;
}
function containsAny(text, words) {
  const n = normalizeText(text);
  return words.some((w) => n.includes(normalizeText(w)));
}
// Como containsAny es un simple ".includes()", palabras cortas de una sola
// palabra pueden matchear como subcadena de otras sin relacion (ej. la
// palabra clave "persona" tambien "matcheaba" dentro de "personas",
// "personalizada", etc.). Para esos casos puntuales se usa esta variante
// con limite de palabra completa.
function containsWord(text, words) {
  const n = normalizeText(text);
  return words.some((w) => new RegExp(`\\b${normalizeText(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(n));
}
function isGreeting(text) {
  return (
    containsAny(text, [
      'hola', 'holi', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches',
      'buen dia', 'saludos', 'quiubo', 'qiubo', 'que mas',
    ]) ||
    // "hi"/"hey"/"ola" son cortas y aparecen como subcadena de un monton de
    // palabras en español (ej. "hi" dentro de "hice", "dirigir"), por eso
    // van con limite de palabra completa en vez de containsAny.
    containsWord(text, ['hey', 'hi', 'hello', 'ola'])
  );
}
function isMenuRequest(text) {
  return containsAny(text, ['menu', 'menu principal', 'volver al menu', 'inicio']);
}
function isCorrection(text) {
  return containsAny(text, ['me equivoque', 'me confundi', 'no era esa', 'por error']);
}
function isPaymentIntent(text) {
  return containsAny(text, [
    'donde reservo', 'como reservo', 'quiero reservar', 'separar cupo', 'separar mi cupo',
    'como pago', 'medios de pago', 'quiero pagar', 'hacer el abono', 'abono'
  ]);
}
function isComprobanteText(text) {
  return containsAny(text, ['comprobante', 'soporte de pago', 'ya pague', 'ya envie el pago', 'adjunto pago']);
}
function isHumanRequest(text) {
  return containsAny(text, ['asesor', 'hablar con alguien', 'humano']) || containsWord(text, ['persona']);
}
// Pregunta puntual sobre El Rinconcito del Migao (salon de onces dentro de
// Con Sentido). Se responde de una vez, sin importar en que parte del
// flujo este el cliente, y sin cambiar de estado (sigue donde iba).
function isMigaoQuestion(text) {
  // 'migao' ya cubre 'migaos' (plural correcto) por ser subcadena; se
  // agrega 'migados' aparte porque es una variante/error comun que no
  // comparte esa raiz.
  return containsAny(text, ['migao', 'migados', 'rinconcito']);
}
function migaoInfo() {
  return [
    `¡Claro que sí! 🕯️🥐 *${KB.business.name}* y *El Rinconcito del Migao* funcionan juntos en el mismo espacio: aquí encuentras nuestras velas artesanales y también puedes disfrutar de los migaos y las demás opciones del menú del salón de onces.`,
    `🕘 Atendemos todos los días de ${KB.business.hours}, de domingo a domingo, tanto en ${KB.business.name} como en El Rinconcito del Migao.`,
  ].join('\n');
}

function getSession(chatId) {
  const s = sessionStore.get(chatId);
  if (!s) return null;
  if (Date.now() - s.updatedAt > SESSION_TTL) {
    sessionStore.delete(chatId);
    return null;
  }
  return s;
}
function setSession(chatId, state, data = {}) {
  const prev = sessionStore.get(chatId);
  sessionStore.set(chatId, {
    state,
    data: { ...(prev?.data || {}), ...data },
    misunderstandCount: prev?.misunderstandCount || 0,
    updatedAt: Date.now(),
  });
}
function clearSession(chatId) { sessionStore.delete(chatId); }
function getContactProfile(chatId) {
  const p = contactProfileStore.get(chatId);
  if (!p) return null;
  if (Date.now() - p.updatedAt > CONTACT_PROFILE_TTL) {
    contactProfileStore.delete(chatId);
    return null;
  }
  return p;
}
function logMessage(chatId, from, text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  const log = conversationLogs.get(chatId) || [];
  log.push({ from, text: clean, timestamp: Date.now() });
  if (log.length > CONVERSATION_LOG_LIMIT) log.splice(0, log.length - CONVERSATION_LOG_LIMIT);
  conversationLogs.set(chatId, log);
}
function getConversationLog(chatId) {
  return (conversationLogs.get(chatId) || []).slice();
}
function ensureProfile(chatId) {
  let p = getContactProfile(chatId);
  if (!p) {
    p = {
      nombre: null,
      ciudad: null,
      productoInteres: null,
      status: 'Nuevo contacto',
      tags: [],
      catalogsSent: {},
      reservationName: null,
      updatedAt: Date.now(),
    };
    contactProfileStore.set(chatId, p);
  }
  return p;
}
function updateProfile(chatId, patch) {
  const p = ensureProfile(chatId);
  Object.assign(p, patch, { updatedAt: Date.now() });
  contactProfileStore.set(chatId, p);
  return p;
}
function addTag(chatId, tag) {
  const p = ensureProfile(chatId);
  if (!p.tags.includes(tag)) p.tags.push(tag);
  p.updatedAt = Date.now();
  contactProfileStore.set(chatId, p);
}

const PUBLIC_DIRS = [
  path.resolve(__dirname, '..', '..', 'public'),
  path.resolve(process.cwd(), 'public'),
];
function getPdfForCategory(category) {
  const patterns = {
    insumos_fragancias: ['fragancia'],
    insumos_generales: ['insumo'],
    velas_bouquets: ['bouquet'],
  }[category] || [category];
  for (const base of PUBLIC_DIRS) {
    const dir = path.join(base, 'pdf');
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf'));
    const match = files.find((f) => patterns.some((p) => normalizeText(f).replace(/\s/g, '').includes(normalizeText(p).replace(/\s/g, ''))));
    if (match) return path.join(dir, match);
  }
  return null;
}
function getPdfIfNotSentBefore(chatId, category) {
  const p = ensureProfile(chatId);
  if (p.catalogsSent?.[category]) return { pdfPath: null, alreadySent: true };
  const pdfPath = getPdfForCategory(category);
  if (pdfPath) {
    p.catalogsSent[category] = true;
    p.updatedAt = Date.now();
    contactProfileStore.set(chatId, p);
  }
  return { pdfPath, alreadySent: false };
}

// Busca la imagen en public/images/. Contempla el archivo tal cual y la
// variante con extension duplicada (ej. "group_class.jpeg.jpeg"), que es
// como quedaron guardadas las imagenes actuales del proyecto. Tambien
// contempla que la segunda extension no sea igual a la primera (ej.
// "experience.jpg.jpeg"), que fue como quedo guardada esa en particular.
function getImagePath(fileName) {
  const parsed = path.parse(fileName);
  const candidates = [
    fileName,
    `${parsed.name}${parsed.ext}${parsed.ext}`,
    `${parsed.name}${parsed.ext}.jpeg`,
    `${parsed.name}${parsed.ext}.jpg`,
  ];
  for (const base of PUBLIC_DIRS) {
    const dir = path.join(base, 'images');
    for (const candidate of candidates) {
      const fullPath = path.join(dir, candidate);
      if (fs.existsSync(fullPath)) return fullPath;
    }
  }
  return null;
}

function getWelcomeMessage() {
  return '¡Hola! 🌿 Bienvenido(a) a Con Sentido. Soy Abby, tu asesora virtual, y estoy feliz de ayudarte hoy. Antes de continuar, ¿me regalas tu nombre?';
}
function mainMenu(chatId, opts = {}) {
  const name = firstName(chatId);
  const greeting = opts.greeting || (name ? `¡Un gusto, ${name}!` : '¡Qué gusto tenerte por aqui!');
  return [
    `${greeting} 🌿 Cuéntame, ¿qué te gustaría conocer hoy?`,
    '1. Talleres para aprender a hacer velas',
    '2. Experiencia Con Sentido',
    '3. Insumos para fabricar velas',
    '4. Velas y regalos listos',
    '5. Recordatorios para eventos',
    '6. Club Creativo',
    'Puedes responderme con el numero o simplemente contarme con tus palabras 😊.',
  ].join('\n');
}
function goMain(chatId, opts) {
  setSession(chatId, 'awaiting_interest');
  return { reply: mainMenu(chatId, opts) };
}

function detectInterest(text) {
  const num = numbered(text, 6);
  if (num) return ['talleres', 'experiencia', 'insumos', 'regalos', 'recordatorios', 'club'][num - 1];
  if (containsAny(text, ['taller', 'curso', 'masterclass', 'aprender velas'])) return 'talleres';
  if (containsAny(text, ['experiencia', 'plan con amigas', 'plan en pareja', 'hacer una vela juntos'])) return 'experiencia';
  if (containsAny(text, ['insumo', 'fragancia', 'cera', 'pabilo', 'molde', 'colorante'])) return 'insumos';
  if (containsAny(text, ['bouquet', 'vela aromatica', 'vela decorativa', 'difusor', 'kit de regalo', 'regalo'])) return 'regalos';
  if (containsAny(text, ['recordatorio', 'matrimonio', 'baby shower', '15 anos', 'bautizo'])) return 'recordatorios';
  if (containsAny(text, ['club creativo', 'ninos', 'niños', 'ilustracion infantil'])) return 'club';
  return null;
}

// Si el cliente ya nombra el taller especifico (no solo "taller"/"curso"
// generico), se salta la pregunta "cual se parece mas a lo que buscas" y
// se le manda directo la info + imagen de ese taller.
function detectWorkshopShortcut(text) {
  if (containsAny(text, ['masterclass basico', 'taller basico', 'curso basico', 'basico grupal', 'clases grupales', 'clase grupal', 'en grupo'])) return 'basic';
  if (containsAny(text, ['masterclass avanzado', 'taller avanzado', 'curso avanzado', 'nivel avanzado'])) return 'advanced';
  if (containsAny(text, ['masterclass personalizado', 'taller personalizado', 'curso personalizado', 'clases personalizadas', 'clase personalizada'])) return 'personalized';
  return null;
}

function startTalleres(chatId) {
  addTag(chatId, 'Talleres');
  updateProfile(chatId, { status: 'Interesado en taller' });
  setSession(chatId, 'taller_level');
  const n = firstName(chatId);
  return {
    reply: [
      `¡Qué bueno que quieras aprender${n ? `, ${n}` : ''}! 🎓`,
      'Para recomendarte el taller indicado, cuéntame cuál se parece más a lo que buscas:',
      '1. 🌱 Nunca he hecho velas y quiero aprender desde cero.',
      '2. ✨ Ya hago velas y quiero aprender técnicas nuevas.',
      '3. 🤍 Quiero aprender desde cero, pero prefiero una clase personalizada.',
    ].join('\n'),
  };
}
function workshopLevel(text) {
  const n = numbered(text, 3);
  if (n) return ['basic', 'advanced', 'personalized'][n - 1];
  if (containsAny(text, ['nunca', 'desde cero', 'principiante'])) return 'basic';
  if (containsAny(text, ['ya hago', 'tengo experiencia', 'tecnicas nuevas', 'avanzado'])) return 'advanced';
  if (containsAny(text, ['personalizado', 'personalizada', 'privada', 'uno a uno'])) return 'personalized';
  if (containsAny(text, ['solo experiencia', 'con mi novio', 'con mi pareja', 'solo hacer una vela'])) return 'experience';
  return null;
}
function basicInfo(chatId) {
  const w = KB.workshops.basicGroup;
  updateProfile(chatId, { productoInteres: w.name, status: 'Taller recomendado' });
  setSession(chatId, 'basic_dates_confirm');
  return {
    reply: [
      `¡Perfecto! 🌿 Entonces nuestro *${w.name}* es el indicado para ti.`,
      'No necesitas conocimientos previos. La idea es que aprendas bases solidas y no salgas con vacios para emprender.',
      '',
      'Durante el taller elaboraras 3 proyectos:',
      ...w.techniques.map((x) => `• ${x}`),
      '',
      'Ademas aprenderas sobre ceras, fragancias, pabilos, colorantes, temperaturas, costos, precios de venta y bases para emprender.',
      `Trabajamos con grupos de maximo ${w.maxPeople} personas, por eso el acompañamiento es cercano y semipersonalizado.`,
      `Incluye: ${w.includes.join(', ')}.`,
      `🕘 Horario: ${w.schedule}`,
      `💰 Inversion: ${money(w.price)} por persona`,
      `🔐 Reserva: ${money(w.deposit)} y pagas el saldo el dia del taller.`,
      '',
      '¿Quieres conocer las proximas fechas disponibles?',
      '1. Si, ver proximas fechas',
      '2. Tengo una pregunta',
    ].join('\n'),
    imagePath: getImagePath('group_class.jpeg'),
  };
}
function showBasicDates(chatId) {
  const dates = KB.workshops.basicGroup.dates || []; // ISO ("2026-08-30")
  if (!dates.length) {
    updateProfile(chatId, { status: 'Fecha consultada' });
    return escalate(chatId, 'Quiero darte una fecha realmente disponible. 🌿 Voy a pasarte con alguien de nuestro equipo para revisar las proximas fechas del MasterClass Basico.');
  }
  setSession(chatId, 'basic_date_pick', { dates });
  return { reply: ['Estas son nuestras proximas fechas disponibles:', ...dates.map((iso, i) => `${i + 1}. 📅 ${formatDateEs(iso)}`), `${dates.length + 1}. Ninguna me funciona`].join('\n') };
}
function advancedInfo(chatId) {
  const w = KB.workshops.advanced;
  updateProfile(chatId, { productoInteres: w.name, status: 'Taller recomendado' });
  setSession(chatId, 'advanced_schedule');
  return {
    reply: [
      `¡Entonces nuestro *${w.name}* puede ser justo lo que buscas! ✨`,
      'Esta diseñado para personas que ya conocen las bases y quieren ampliar su catalogo con productos diferentes y de mayor valor comercial.',
      '',
      'Aprenderas 3 tecnicas especializadas:',
      '🌿 Velas de masaje.',
      '💎 Velas en cera gel.',
      '🍰 Velas estilo Chantilly con acabado tipo postre.',
      '',
      'Todo se realiza paso a paso y con acompañamiento cercano.',
      `Incluye: ${w.includes.join(', ')}.`,
      `💰 Inversion: ${money(w.price)}`,
      `${w.days}`,
      'Horarios:',
      `1. ☀️ ${w.schedules[0]}`,
      `2. 🌙 ${w.schedules[1]}`,
      '',
      '¿Que jornada prefieres?',
    ].join('\n'),
    imagePath: getImagePath('avanzado_masterclass.jpeg'),
  };
}
function personalizedInfo(chatId) {
  const w = KB.workshops.basicPersonalized;
  updateProfile(chatId, { productoInteres: w.name, status: 'Taller recomendado' });
  setSession(chatId, 'personalized_schedule');
  return {
    reply: [
      `Claro. 🤍 Nuestro *${w.name}* es para quienes prefieren aprender desde cero con una atencion mucho mas cercana.`,
      `Aprenderas: ${w.techniques.join(', ')}.`,
      'Tambien veremos ceras, fragancias, pabilos, colorantes, procesos, costos, precios de venta y bases para emprender.',
      `Incluye: ${w.includes.join(', ')}.`,
      `💰 Inversion: ${money(w.price)}`,
      `${w.days}`,
      'Horarios:',
      `1. ☀️ ${w.schedules[0]}`,
      `2. 🌙 ${w.schedules[1]}`,
      '',
      '¿Que jornada te funciona mejor?',
    ].join('\n'),
    imagePath: getImagePath('personalized_class.jpeg'),
  };
}
function parseSchedule(text) {
  const n = numbered(text, 2);
  if (n === 1 || containsAny(text, ['manana', 'mañana', '9 a 1'])) return 'Mañana';
  if (n === 2 || containsAny(text, ['tarde', '3 a 7'])) return 'Tarde';
  return null;
}
// Las listas de fechas se muestran numeradas ("1. 📅 Domingo 30 de
// agosto"), pero a diferencia de las demas opciones numeradas del bot
// (que ya reconocen texto libre via containsAny), aca no hay palabras
// clave fijas posibles porque la fecha cambia cada vez. Se reconoce si
// el cliente escribe el dia+mes (ej. "30 de agosto") o el texto completo
// formateado, en vez de tener que escribir el numero de la lista.
function matchDateChoice(text, dates) {
  for (let i = 0; i < dates.length; i++) {
    const iso = dates[i];
    const label = formatDateEs(iso); // "Domingo 30 de agosto"
    if (containsAny(text, [label])) return i + 1;
    const parts = label.split(' de ');
    const dayNum = parts[0].split(' ').pop(); // "30"
    const monthWord = parts[1];
    if (monthWord && containsWord(text, [dayNum]) && containsAny(text, [monthWord])) return i + 1;
  }
  return null;
}
function isNoneOfTheseOption(text) {
  return containsAny(text, ['ninguna me funciona', 'ninguna me sirve', 'ninguna sirve', 'ninguna', 'no me sirve', 'no me funciona']);
}
function reserveQuestion(chatId, product, extraData = {}) {
  updateProfile(chatId, { productoInteres: product, status: 'Reserva en proceso' });
  setSession(chatId, 'reservation_confirm', { ...extraData, product });
  return { reply: ['¿Deseas reservar?', '1. 🟢 Si, quiero reservar', '2. 💬 Aun tengo una pregunta'].join('\n') };
}

function startExperience(chatId) {
  const e = KB.experience;
  addTag(chatId, 'Experiencia');
  updateProfile(chatId, { productoInteres: e.name, status: 'Interesado en experiencia' });
  setSession(chatId, 'experience_occasion');
  return {
    reply: [
      `¡Qué lindo que quieras vivir una *${e.name}*! ✨`,
      `Es un espacio de ${e.duration.toLowerCase()} pensado para crear, compartir y guardar un recuerdo bonito con las personas que quieres.`,
      '',
      'Los recibimos con una bebida fria o caliente y preparamos un *Momento Con Sentido*: una dinamica de conversacion con preguntas y recuerdos adaptados al vinculo que compartan.',
      'Tambien conoceran un poco sobre las ceras, cada persona elaborara su propia vela artesanal y terminaremos disfrutando el Migao de su eleccion.',
      'Incluye fotografias y un pequeño video de recuerdo.',
      '',
      `💰 Valor: ${money(e.pricePerPerson)} por persona`,
      `👥 Desde ${e.minPeople} personas`,
      '',
      'Más que hacer una vela, queremos que se lleven un recuerdo bonito de las personas con quienes decidieron compartir la experiencia. 🤍',
      '',
      'Para personalizarla, cuéntame: ¿que ocasion quieren compartir o celebrar?',
    ].join('\n'),
    imagePath: getImagePath('experience.jpg'),
  };
}
function isBirthday(text) { return containsAny(text, ['cumple', 'cumpleanos', 'cumpleaños']); }
// Si el cliente aun no tiene fecha en mente, no tiene sentido preguntarle
// la jornada (no hay contra que validarla), asi que se salta ese paso.
function isNoDateYet(text) {
  return containsAny(text, ['aun no', 'no se', 'no sé', 'sin fecha', 'no tengo fecha', 'por definir']);
}
// Compartido entre "acaba de decir que aun no tiene fecha" y "ya eligio
// fecha + jornada": ambos caminos llegan aqui si es cumpleaños.
function experienceBirthdayExtrasPrompt(chatId, extraData) {
  setSession(chatId, 'experience_birthday_extras', extraData);
  return {
    reply: [
      'Para cumpleaños tambien podemos preparar adicionales 🎂:',
      `1. 🎈 Decoracion especial: +${money(KB.experience.birthdayExtras.decoration)}`,
      `2. 🍰 Porcion de torta con velita: +${money(KB.experience.birthdayExtras.cakePerPerson)} por persona`,
      '3. Ambos',
      '4. Ninguno',
      '¿Te gustaria agregar alguno?',
    ].join('\n'),
  };
}
function experienceSummary(chatId) {
  const s = getSession(chatId);
  const d = s?.data || {};
  const people = Number(d.people) || 0;
  const base = people * KB.experience.pricePerPerson;
  let extras = 0;
  if (d.decoration) extras += KB.experience.birthdayExtras.decoration;
  if (d.cake) extras += people * KB.experience.birthdayExtras.cakePerPerson;
  const total = base + extras;
  setSession(chatId, 'experience_reserve_confirm', { total });
  return {
    reply: [
      'Perfecto. 🌿 Entonces tenemos:',
      `✨ ${KB.experience.name}`,
      `👥 ${people} persona${people === 1 ? '' : 's'}`,
      `🎉 Ocasion: ${d.occasion || 'Por definir'}`,
      `📅 Fecha: ${d.date || 'Por definir'}`,
      d.schedule ? `🕘 Jornada: ${d.schedule}` : null,
      d.decoration ? `🎈 Decoracion: +${money(KB.experience.birthdayExtras.decoration)}` : null,
      d.cake ? `🍰 Torta: +${money(KB.experience.birthdayExtras.cakePerPerson)} por persona` : null,
      `💰 Total estimado: ${money(total)}`,
      '',
      '¿Quieres que revisemos disponibilidad para reservarla?',
      '1. Si, quiero reservar',
      '2. Tengo una pregunta',
    ].filter(Boolean).join('\n'),
  };
}

function startSupplies(chatId) {
  addTag(chatId, 'Insumos');
  updateProfile(chatId, { productoInteres: 'Insumos', status: 'Interesado en insumos' });
  setSession(chatId, 'supplies_type');
  return {
    reply: [
      `¡Claro${firstName(chatId) ? `, ${firstName(chatId)}` : ''}! 🕯️ En Con Sentido tenemos diferentes insumos para crear tus velas.`,
      '¿Que estas buscando?',
      '1. 🌸 Fragancias para velas',
      '2. 🕯️ Ceras, pabilos, moldes y otros insumos',
      '3. 🛍️ Quiero hacer un pedido',
      '4. 🤔 Necesito asesoria porque no se que comprar',
    ].join('\n'),
  };
}
function sendSupplyCatalog(chatId, category, label) {
  const { pdfPath, alreadySent } = getPdfIfNotSentBefore(chatId, category);
  setSession(chatId, 'supplies_after_catalog');
  return {
    reply: [
      alreadySent ? `Ya te habia compartido ${label}. 📄` : `Te comparto ${label}. 📄`,
      'Cuando lo revises, puedes escribirme los productos, presentaciones y cantidades que necesitas en un solo mensaje. Yo te ayudo a organizar el pedido.',
    ].join('\n'),
    pdfPath,
  };
}
function startOrderCapture(chatId) {
  updateProfile(chatId, { status: 'Pedido en construccion' });
  setSession(chatId, 'supplies_order_text', { cart: [] });
  return { reply: ['Perfecto. 🛍️ Escribeme los productos que necesitas en un solo mensaje, junto con sus cantidades y presentaciones.', 'Ejemplo: “2 kg de cera de soya APF, 5 metros de pabilo M y una fragancia Cereza Roja de 120 ml.”'].join('\n') };
}
function supplyDeliveryMenu(chatId) {
  setSession(chatId, 'supplies_delivery');
  return {
    reply: [
      '¿Como deseas recibir tu pedido?',
      '1. 📍 Recoger en Con Sentido',
      '2. 🏍️ Enviar un mensajero solicitado por ti',
      '3. 📦 Envio nacional',
    ].join('\n'),
  };
}

function startGifts(chatId) {
  addTag(chatId, 'Velas y Regalos');
  updateProfile(chatId, { productoInteres: 'Velas y regalos', status: 'Interesado en regalo' });
  setSession(chatId, 'gifts_category');
  return {
    reply: [
      `¡Claro${firstName(chatId) ? `, ${firstName(chatId)}` : ''}! 🎁 En Con Sentido tenemos detalles hechos a mano para regalar, decorar o simplemente consentirte.`,
      '¿Que estas buscando?',
      '1. 🌸 Bouquets de velas',
      '2. 🕯️ Velas aromaticas',
      '3. ✨ Velas decorativas',
      '4. 🎁 Regalos y kits',
      '5. 🌿 Difusores y aromas para el hogar',
      '6. 🤍 No se que elegir, ayudame a encontrar un regalo',
    ].join('\n'),
  };
}
function startBouquet(chatId) {
  updateProfile(chatId, { productoInteres: 'Bouquets de velas' });
  setSession(chatId, 'bouquet_occasion');
  return {
    reply: [
      '¡Qué buena eleccion! 🌸 Nuestros bouquets de velas son detalles hechos a mano, pensados para regalar algo diferente y con intencion.',
      '¿Para que ocasion lo estas buscando?',
      '1. 🎂 Cumpleaños',
      '2. 💕 Aniversario o pareja',
      '3. 🌷 Para mama, amiga o alguien especial',
      '4. 🎓 Grado o logro especial',
      '5. ✨ Otra ocasion',
    ].join('\n'),
  };
}

function paymentMethodsText() {
  return KB.payment.methods.map((m) => `• ${m.name}: ${m.value}`).join('\n');
}
function startPayment(chatId) {
  const s = getSession(chatId);
  const d = s?.data || {};
  updateProfile(chatId, { status: 'Reserva en proceso' });
  setSession(chatId, 'reservation_name', d);
  return { reply: '¡Perfecto! 🌿 Antes de realizar el pago, indícame por favor el *nombre completo de la persona a nombre de quien quedara la reserva o pedido*.' };
}
function sendPaymentInstructions(chatId) {
  const p = getContactProfile(chatId);
  const s = getSession(chatId);
  const d = s?.data || {};
  const product = p?.productoInteres || 'tu reserva';
  const deposit = d.fullPayment ? d.total : KB.payment.reservationDeposit;
  updateProfile(chatId, { status: 'Esperando comprobante' });
  setSession(chatId, 'waiting_receipt', d);
  return {
    reply: [
      `Perfecto. La reserva/pedido quedara a nombre de *${p?.reservationName || 'la persona indicada'}*.`,
      `Para continuar con ${product}, realiza ${d.fullPayment ? 'el pago' : `un abono de ${money(deposit)}`}.`,
      '',
      'Medios de pago:',
      paymentMethodsText(),
      '',
      'Cuando realices el pago, envia el comprobante por este mismo chat. No confirmaremos la reserva o pedido hasta que el equipo valide el ingreso. 📎',
    ].join('\n'),
    awaitingComprobante: true,
  };
}
function receiptReceived(chatId) {
  clearPaymentReminder(chatId);
  updateProfile(chatId, { status: 'Comprobante recibido - pendiente de validacion' });
  return escalate(chatId, `¡Gracias! 🌿 Recibi tu comprobante. Tengo registrada la reserva/pedido a nombre de *${getContactProfile(chatId)?.reservationName || getContactProfile(chatId)?.nombre || 'la persona indicada'}*. Voy a enviarlo al equipo para validar el pago y confirmar.`);
}

// Ultimo mensaje del CLIENTE (no del bot) en el historial de conversacion,
// para poder mostrarle al asesor que fue lo que la persona realmente
// pregunto/escribio, en vez de solo el motivo interno del escalamiento.
function lastCustomerMessage(chatId) {
  const log = getConversationLog(chatId);
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].from === 'cliente') return log[i].text;
  }
  return null;
}
function truncate(text, max) {
  const t = String(text || '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
const SUMMARY_DIVIDER = '▬▬▬▬▬▬▬▬▬▬▬▬▬▬';

function buildAdvisorSummary(chatId, reason) {
  const p = getContactProfile(chatId);
  const s = getSession(chatId);
  const d = s?.data || {};
  const lastMessage = lastCustomerMessage(chatId);
  const lines = [
    '📋 *CLIENTE PARA ATENDER*',
    `👤 *Nombre:* ${p?.nombre || 'Sin nombre'}`,
    // IMPORTANTE: el emoji y formato de esta linea ("💬 *Chat:* ...") tiene
    // que coincidir exacto con el regex de fixAdvisorSummaryChatLink() en
    // whatsappAlternative.js, que la reemplaza por un link ya resuelto
    // (los @lid no traen el numero real en el propio id). Si se cambia
    // aca, hay que cambiar tambien ese regex, o el reemplazo deja de
    // funcionar en silencio (paso antes: quedaba el id crudo sin resolver).
    `💬 *Chat:* https://wa.me/${String(chatId).replace(/\D/g, '')}`,
    SUMMARY_DIVIDER,
    `💭 *Escribió:* "${lastMessage ? truncate(lastMessage, 300) : '(sin mensaje de texto)'}"`,
    SUMMARY_DIVIDER,
    `🎯 *Interés:* ${p?.productoInteres || 'Sin definir'}`,
    `📌 *Estado:* ${p?.status || 'Sin definir'}`,
  ];
  if (p?.reservationName) lines.push(`🧾 *Reserva/Pedido a nombre de:* ${p.reservationName}`);
  if (d.schedule) lines.push(`🕘 *Jornada:* ${d.schedule}`);
  if (d.date) lines.push(`📅 *Fecha:* ${d.date}`);
  if (d.people) lines.push(`👥 *Personas:* ${d.people}`);
  if (d.occasion) lines.push(`🎉 *Ocasión:* ${d.occasion}`);
  if (d.orderText) lines.push(`🛍️ *Pedido:* ${d.orderText}`);
  if (d.delivery) lines.push(`🚚 *Entrega:* ${d.delivery}`);
  if (d.courierName) lines.push(`🏍️ *Mensajero:* ${d.courierName} | Placa: ${d.courierPlate || '-'} | Codigo: ${d.courierCode || '-'}`);
  lines.push(`📝 *Motivo del traspaso:* ${reason}`);
  return lines.join('\n');
}
// Historial de escalamientos (para el panel de administración). No existía
// ningún registro histórico: solo se veía el reporte que llegaba por
// WhatsApp en el momento, sin poder repasar despues cuántos/cuáles hubo.
const ESCALATION_HISTORY_LIMIT = 300;
const escalationHistory = [];

function recordEscalation(chatId, message) {
  const p = getContactProfile(chatId);
  escalationHistory.unshift({
    chatId,
    nombre: p?.nombre || null,
    productoInteres: p?.productoInteres || null,
    motivo: message,
    timestamp: Date.now(),
  });
  if (escalationHistory.length > ESCALATION_HISTORY_LIMIT) escalationHistory.length = ESCALATION_HISTORY_LIMIT;
}

function escalate(chatId, message) {
  const now = Date.now();
  const last = lastAdvisorNotificationAt.get(chatId) || 0;
  const notify = now - last > 10 * 60 * 1000;
  if (notify) lastAdvisorNotificationAt.set(chatId, now);
  const advisorSummary = notify ? buildAdvisorSummary(chatId, message) : null;
  recordEscalation(chatId, message);
  clearFollowUps(chatId);
  clearPaymentReminder(chatId);
  clearSession(chatId);
  return { reply: message, final: true, escalatedToAdvisor: true, advisorSummary, contactData: getContactProfile(chatId) };
}

// Agenda de talleres personalizados (Avanzado + Basico Personalizado). A
// diferencia del Basico grupal (fechas fijas cargadas desde el panel), aqui
// se negocia con el cliente un dia habil (lunes a viernes) real, respetando
// un cupo compartido por dia+jornada entre ambos talleres: comparten el
// mismo calendario porque compiten por la misma disponibilidad del equipo.
const BOOKING_SLOT_CAPACITY = 2;
const BOOKING_LOOKAHEAD_DAYS = 45; // hasta donde se buscan huecos disponibles
const BOOKING_OPTIONS_TO_OFFER = 3; // cuantas fechas se muestran al cliente a la vez
const BOOKING_MAX_DATES_SHOWN = 9; // si se agotan estas sin que ninguna sirva, se escala
// { id, chatId, product, workshopKey, schedule, date (ISO), createdAt,
//   payment ('pendiente'|'abono'|'completo'), attendanceConfirmed }
const bookings = [];
// El pago y la asistencia no los sabe el bot (se confirman por fuera, con
// el asesor/comprobante); por eso no son parte del flujo automatico, sino
// algo que se marca a mano desde el panel una vez que el asesor lo verifica.
const PAYMENT_STATUSES = ['pendiente', 'abono', 'completo'];

function countBookings(date, schedule) {
  return bookings.filter((b) => b.date === date && b.schedule === schedule).length;
}
function isSlotAvailable(date, schedule) {
  return countBookings(date, schedule) < BOOKING_SLOT_CAPACITY;
}
// Busca los proximos dias habiles (lunes a viernes) con cupo libre para la
// jornada indicada, a partir de mañana. excludeDates evita repetir fechas
// ya mostradas cuando el cliente pide mas opciones.
function nextAvailableDates(schedule, howMany = BOOKING_OPTIONS_TO_OFFER, excludeDates = []) {
  const results = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() + 1);
  for (let i = 0; i < BOOKING_LOOKAHEAD_DAYS && results.length < howMany; i++) {
    const iso = toIsoDate(cursor);
    if (isWeekday(iso) && isWorkshopSlotAllowed(iso, schedule) && !excludeDates.includes(iso) && isSlotAvailable(iso, schedule)) {
      results.push(iso);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return results;
}
function addBooking({ chatId, product, workshopKey, schedule, date }) {
  const booking = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    chatId,
    product,
    workshopKey,
    schedule,
    date,
    createdAt: Date.now(),
    payment: 'pendiente',
    depositAmount: null, // cuanto abono, en pesos; lo anota el asesor a mano
    attendanceConfirmed: false,
  };
  bookings.push(booking);
  persistNow(); // el panel de calendario lee data/bot-state.json.
  return booking;
}
function getBookings() {
  return bookings.slice();
}
// Lo llama el panel (via IPC, ver whatsappAlternative.js) cuando el asesor
// marca a mano que el cliente abono (y cuanto), pago completo, o confirmo
// que va a asistir.
function updateBookingStatus(bookingId, patch = {}) {
  const booking = bookings.find((b) => b.id === bookingId);
  if (!booking) return null;
  if (patch.payment !== undefined && PAYMENT_STATUSES.includes(patch.payment)) {
    booking.payment = patch.payment;
  }
  if (patch.depositAmount === null) {
    booking.depositAmount = null; // se puede dejar vacio explicitamente
  } else if (patch.depositAmount !== undefined) {
    // Un monto invalido (negativo, no numerico) se ignora sin tocar el
    // valor que ya habia, en vez de borrarlo.
    const amount = Number(patch.depositAmount);
    if (Number.isFinite(amount) && amount >= 0) booking.depositAmount = amount;
  }
  if (patch.attendanceConfirmed !== undefined) {
    booking.attendanceConfirmed = Boolean(patch.attendanceConfirmed);
  }
  persistNow();
  return booking;
}

// Ofrece hasta BOOKING_OPTIONS_TO_OFFER fechas disponibles para la jornada
// elegida. Si ya no queda ninguna en el horizonte de busqueda, se coordina
// directo con un asesor en vez de dejar al cliente sin opciones.
function offerBookingDates(chatId, { product, workshopKey, schedule, excludeDates = [] }) {
  const dates = nextAvailableDates(schedule, BOOKING_OPTIONS_TO_OFFER, excludeDates);
  if (!dates.length) {
    updateProfile(chatId, { status: 'Sin cupos disponibles - coordinar con asesor' });
    return escalate(chatId, 'En este momento no tengo cupos disponibles en los proximos dias para esa jornada. 🌿 Voy a pasarte con alguien de nuestro equipo para buscar una fecha que te sirva.');
  }
  setSession(chatId, 'workshop_date_pick', { product, workshopKey, schedule, dates, excludeDates });
  return {
    reply: [
      `Perfecto, ya tengo registrada tu preferencia: *${schedule}*.`,
      '',
      'Estos son los proximos dias habiles con cupo disponible:',
      ...dates.map((iso, i) => `${i + 1}. 📅 ${formatDateEs(iso)}`),
      `${dates.length + 1}. Ninguna me funciona`,
    ].join('\n'),
  };
}

function handleState(chatId, text, meta = {}) {
  const s = getSession(chatId);
  const state = s?.state;
  const d = s?.data || {};

  if (state === 'awaiting_name') {
    const raw = String(text || '').trim();
    if (!raw) return { reply: '¿Me regalas tu nombre para continuar? 🌿' };
    // Si el cliente vuelve a saludar aqui ("Hola" dos veces seguidas), no se
    // debe guardar el saludo como si fuera su nombre real.
    if (isGreeting(raw)) return { reply: '¡Hola de nuevo! 😊 Antes de continuar, ¿me regalas tu nombre?' };
    // Si contesta "soy Beatriz"/"me llamo Juan" en vez de solo el nombre,
    // se guarda solo el nombre (no la frase completa con "soy" incluido).
    updateProfile(chatId, { nombre: extractDeclaredName(raw) || raw });
    return goMain(chatId);
  }
  if (state === 'awaiting_interest') {
    // El atajo por taller especifico se revisa antes que la categoria
    // generica: frases como "clases personalizadas" no traen ninguna de
    // las palabras que detectInterest usa para "talleres" (taller/curso/
    // masterclass), asi que dependiendo solo de esa deteccion generica
    // nunca se llegaba a ofrecer el taller correcto.
    const shortcut = detectWorkshopShortcut(text);
    if (shortcut) {
      addTag(chatId, 'Talleres');
      if (shortcut === 'basic') return basicInfo(chatId);
      if (shortcut === 'advanced') return advancedInfo(chatId);
      if (shortcut === 'personalized') return personalizedInfo(chatId);
    }
    const i = detectInterest(text);
    if (!i) return { reply: 'Cuéntame un poco más: ¿buscas talleres, una experiencia, insumos, velas y regalos, recordatorios o el Club Creativo?' };
    if (i === 'talleres') return startTalleres(chatId);
    if (i === 'experiencia') return startExperience(chatId);
    if (i === 'insumos') return startSupplies(chatId);
    if (i === 'regalos') return startGifts(chatId);
    if (i === 'recordatorios') return startPendingFlow(chatId, 'Recordatorios para eventos');
    if (i === 'club') return startPendingFlow(chatId, 'Club Creativo');
  }

  if (state === 'taller_level') {
    const level = workshopLevel(text);
    if (level === 'basic') return basicInfo(chatId);
    if (level === 'advanced') return advancedInfo(chatId);
    if (level === 'personalized') return personalizedInfo(chatId);
    if (level === 'experience') return startExperience(chatId);
    return retry(chatId, 'Cuéntame cuál aplica mejor: 1) empiezas desde cero, 2) ya haces velas, o 3) prefieres una clase personalizada.');
  }
  if (state === 'basic_dates_confirm') {
    if (isYes(text)) return showBasicDates(chatId);
    if (isNoOrQuestion(text)) return { reply: 'Claro. Escríbeme tu pregunta y con gusto te ayudo. 🌿' };
    return retry(chatId, '¿Quieres conocer las proximas fechas? 1. Si  2. Tengo una pregunta');
  }
  if (state === 'basic_date_pick') {
    const dates = d.dates || []; // ISO
    if (isNoneOfTheseOption(text)) return personalizedInfo(chatId);
    const n = numbered(text, dates.length + 1) || matchDateChoice(text, dates);
    if (!n) return retry(chatId, 'Elige una de las fechas por numero, escribiendo la fecha, o con la opcion “Ninguna me funciona”.');
    if (n === dates.length + 1) return personalizedInfo(chatId);
    const date = dates[n - 1];
    setSession(chatId, 'reservation_confirm', { product: KB.workshops.basicGroup.name, workshopKey: 'basicGroup', date });
    updateProfile(chatId, { status: 'Fecha seleccionada' });
    return { reply: [`Perfecto. 🌿 Seleccionaste *${formatDateEs(date)}*.`, '¿Quieres reservar tu cupo?', '1. Si, quiero reservar', '2. Tengo una pregunta'].join('\n') };
  }
  if (state === 'advanced_schedule' || state === 'personalized_schedule') {
    const schedule = parseSchedule(text);
    if (!schedule) return retry(chatId, '¿Que jornada prefieres? 1. Mañana  2. Tarde');
    const workshopKey = state === 'advanced_schedule' ? 'advanced' : 'basicPersonalized';
    const product = KB.workshops[workshopKey].name;
    updateProfile(chatId, { status: 'Jornada seleccionada' });
    // Avanzado y Personalizado ya no usan una lista fija: se calculan los
    // proximos dias habiles (lunes a viernes) con cupo libre en la agenda
    // compartida (ver bookings mas arriba).
    return offerBookingDates(chatId, { product, workshopKey, schedule });
  }
  if (state === 'workshop_date_pick') {
    const dates = d.dates || [];
    if (isNoneOfTheseOption(text)) {
      const excludeDatesNone = [...(d.excludeDates || []), ...dates];
      if (excludeDatesNone.length >= BOOKING_MAX_DATES_SHOWN) {
        updateProfile(chatId, { status: 'Fecha no disponible - coordinar con asesor' });
        return escalate(chatId, 'Quiero darte una fecha que sí te funcione. 🌿 Voy a pasarte con alguien de nuestro equipo para coordinar el día que mejor te sirva.');
      }
      return offerBookingDates(chatId, { product: d.product, workshopKey: d.workshopKey, schedule: d.schedule, excludeDates: excludeDatesNone });
    }
    const n = numbered(text, dates.length + 1) || matchDateChoice(text, dates);
    if (!n) return retry(chatId, 'Elige una de las fechas por numero, escribiendo la fecha, o con la opcion “Ninguna me funciona”.');
    if (n === dates.length + 1) {
      // En vez de escalar de inmediato, se le siguen ofreciendo mas fechas
      // (hay calendario abierto de por medio); solo se escala si ya se le
      // mostraron muchas y ninguna sirvio.
      const excludeDates = [...(d.excludeDates || []), ...dates];
      if (excludeDates.length >= BOOKING_MAX_DATES_SHOWN) {
        updateProfile(chatId, { status: 'Fecha no disponible - coordinar con asesor' });
        return escalate(chatId, 'Quiero darte una fecha que sí te funcione. 🌿 Voy a pasarte con alguien de nuestro equipo para coordinar el día que mejor te sirva.');
      }
      return offerBookingDates(chatId, { product: d.product, workshopKey: d.workshopKey, schedule: d.schedule, excludeDates });
    }
    const date = dates[n - 1];
    // Revalida el cupo por si alguien mas lo tomo mientras el cliente elegia.
    if (!isSlotAvailable(date, d.schedule)) {
      return offerBookingDates(chatId, { product: d.product, workshopKey: d.workshopKey, schedule: d.schedule, excludeDates: [...(d.excludeDates || []), date] });
    }
    updateProfile(chatId, { status: 'Fecha seleccionada' });
    setSession(chatId, 'personalized_reserve_confirm', { product: d.product, workshopKey: d.workshopKey, schedule: d.schedule, date });
    return { reply: [`Perfecto. 🌿 Seleccionaste *${formatDateEs(date)}*.`, '¿Deseas coordinar y reservar tu clase?', '1. Si, quiero coordinarla', '2. Tengo una pregunta'].join('\n') };
  }
  if (state === 'personalized_reserve_confirm') {
    if (isYes(text)) {
      if (!d.date) {
        // Red de seguridad: si por algun motivo no quedo fecha en sesion,
        // se coordina directo con un asesor en vez de fallar.
        updateProfile(chatId, { status: 'Coordinar fecha con asesor' });
        return escalate(chatId, '¡Perfecto! 🌿 Voy a pasarte con alguien de nuestro equipo para revisar la disponibilidad del dia, coordinar el horario y continuar con tu reserva.');
      }
      // Revalida el cupo justo antes de confirmar, por si se agoto mientras
      // el cliente decidia si reservaba o no.
      if (!isSlotAvailable(d.date, d.schedule)) {
        return offerBookingDates(chatId, { product: d.product, workshopKey: d.workshopKey, schedule: d.schedule, excludeDates: [d.date] });
      }
      addBooking({ chatId, product: d.product, workshopKey: d.workshopKey, schedule: d.schedule, date: d.date });
      updateProfile(chatId, { status: 'Reservado - coordinar con asesor' });
      return escalate(chatId, `¡Perfecto! 🌿 Tu clase quedo agendada para el *${formatDateEs(d.date)}* en jornada de *${d.schedule}*. Voy a pasarte con alguien de nuestro equipo para confirmar los ultimos detalles y continuar con tu reserva.`);
    }
    if (isNoOrQuestion(text)) return { reply: 'Claro. Escríbeme tu pregunta y con gusto te ayudo antes de coordinar. 😊' };
    return retry(chatId, '¿Deseas coordinar y reservar tu clase? 1. Si  2. Tengo una pregunta');
  }
  if (state === 'reservation_confirm' || state === 'experience_reserve_confirm') {
    if (isYes(text)) {
      // El Basico grupal no pasa por el flujo de agenda por disponibilidad
      // (no tiene cupo compartido, son fechas fijas), pero igual queda
      // registrado en la Agenda del panel para que se vea quien se quiere
      // inscribir a cada fecha, igual que Avanzado/Personalizado.
      if (d.workshopKey === 'basicGroup' && d.date) {
        addBooking({ chatId, product: d.product, workshopKey: 'basicGroup', schedule: null, date: d.date });
      }
      return startPayment(chatId);
    }
    if (isNoOrQuestion(text)) return { reply: 'Claro. Escríbeme tu pregunta y con gusto te ayudo. 😊' };
    return retry(chatId, '¿Deseas reservar? 1. Si  2. Tengo una pregunta');
  }

  if (state === 'experience_occasion') {
    setSession(chatId, 'experience_people', { occasion: String(text).trim(), birthday: isBirthday(text) });
    return { reply: '¡Qué bonito! 🤍 ¿Para cuántas personas seria la experiencia?' };
  }
  if (state === 'experience_people') {
    const m = String(text).match(/\d+/);
    const people = m ? Number(m[0]) : NaN;
    if (!Number.isFinite(people) || people < KB.experience.minPeople) return retry(chatId, `La experiencia se realiza desde ${KB.experience.minPeople} personas. ¿Para cuantas personas seria?`);
    setSession(chatId, 'experience_date', { people });
    return { reply: 'Perfecto. ¿Ya tienes una fecha en mente? Puedes escribirme la fecha o decirme “aun no”.' };
  }
  if (state === 'experience_date') {
    const date = String(text).trim();
    // Si aun no tiene fecha, no hay contra que validar jornada: se salta
    // directo a lo que seguia antes de agregar esta pregunta.
    if (isNoDateYet(date)) {
      if (d.birthday) return experienceBirthdayExtrasPrompt(chatId, { date });
      setSession(chatId, 'experience_summary', { date });
      return experienceSummary(chatId);
    }
    setSession(chatId, 'experience_schedule', { date });
    return {
      reply: [
        `Perfecto, anote *${date}*.`,
        '¿Que jornada prefieres para ese dia?',
        '1. ☀️ Mañana (9am a 1pm aprox.)',
        '2. 🌙 Tarde (3pm a 7pm aprox.)',
      ].join('\n'),
    };
  }
  if (state === 'experience_schedule') {
    const schedule = parseSchedule(text);
    if (!schedule) return retry(chatId, '¿Que jornada prefieres? 1. Mañana  2. Tarde');
    if (isExperienceTextSlotBlocked(d.date, schedule)) {
      return retry(chatId, 'Para ese dia y jornada no tenemos disponibilidad 🙏 (no agendamos martes en la tarde, ni sabados antes de las 3pm). ¿Prefieres otro dia o la otra jornada?');
    }
    if (d.birthday) return experienceBirthdayExtrasPrompt(chatId, { schedule });
    setSession(chatId, 'experience_summary', { schedule });
    return experienceSummary(chatId);
  }
  if (state === 'experience_birthday_extras') {
    const n = numbered(text, 4);
    let decoration = false; let cake = false;
    if (n === 1 || containsAny(text, ['decoracion'])) decoration = true;
    else if (n === 2 || containsAny(text, ['torta'])) cake = true;
    else if (n === 3 || containsAny(text, ['ambos', 'los dos'])) { decoration = true; cake = true; }
    else if (!(n === 4 || containsAny(text, ['ninguno', 'sin adicionales']))) return retry(chatId, 'Elige: 1) decoracion, 2) torta, 3) ambos o 4) ninguno.');
    setSession(chatId, 'experience_summary', { decoration, cake });
    return experienceSummary(chatId);
  }

  if (state === 'supplies_type') {
    const n = numbered(text, 4);
    if (n === 1 || containsAny(text, ['fragancia', 'aroma'])) return sendSupplyCatalog(chatId, 'insumos_fragancias', 'el catalogo de fragancias');
    if (n === 2 || containsAny(text, ['cera', 'pabilo', 'molde', 'colorante', 'insumos'])) return sendSupplyCatalog(chatId, 'insumos_generales', 'el catalogo de insumos');
    if (n === 3 || containsAny(text, ['pedido', 'comprar'])) return startOrderCapture(chatId);
    if (n === 4 || containsAny(text, ['asesoria', 'no se que comprar', 'estoy empezando'])) {
      setSession(chatId, 'supplies_advice');
      return { reply: 'Claro que si. 🤍 Para recomendarte correctamente, cuéntame primero: ¿que tipo de vela quieres elaborar?' };
    }
    return retry(chatId, 'Elige: 1) fragancias, 2) otros insumos, 3) hacer pedido o 4) necesito asesoria.');
  }
  if (state === 'supplies_after_catalog') {
    if (containsAny(text, ['pedido', 'quiero', 'necesito', 'kg', 'gramos', 'metros', 'ml'])) {
      setSession(chatId, 'supplies_order_confirm', { orderText: String(text).trim() });
      return { reply: [`Anote tu pedido asi:\n${String(text).trim()}`, '', '¿Esta correcto?', '1. Si, continuar', '2. Quiero modificarlo'].join('\n') };
    }
    return startOrderCapture(chatId);
  }
  if (state === 'supplies_advice') {
    const kind = String(text).trim();
    updateProfile(chatId, { status: 'Requiere asesoria de insumos' });
    setSession(chatId, 'supplies_advice_continue', { candleType: kind });
    return { reply: ['Perfecto. Para orientarte sin venderte de mas, dime si ya tienes alguno de estos materiales: cera, pabilo, fragancia y molde/envase.', 'Puedes responderme en un solo mensaje con lo que ya tienes.'].join('\n') };
  }
  if (state === 'supplies_advice_continue') {
    return escalate(chatId, 'Gracias. 🌿 Como aqui la recomendacion depende de la tecnica y los materiales que ya tienes, voy a pasarte con alguien del equipo para darte una recomendacion precisa y evitar que compres algo que no necesitas.');
  }
  if (state === 'supplies_order_text') {
    const orderText = String(text).trim();
    setSession(chatId, 'supplies_order_confirm', { orderText });
    return { reply: [`Anote tu pedido asi:\n${orderText}`, '', '¿Esta correcto?', '1. Si, continuar', '2. Quiero modificarlo'].join('\n') };
  }
  if (state === 'supplies_order_confirm') {
    if (isYes(text)) return supplyDeliveryMenu(chatId);
    if (isNoOrQuestion(text)) return startOrderCapture(chatId);
    return retry(chatId, '¿El pedido esta correcto? 1. Si, continuar  2. Quiero modificarlo');
  }
  if (state === 'supplies_delivery') {
    const n = numbered(text, 3);
    if (n === 1 || containsAny(text, ['recoger', 'paso por'])) {
      setSession(chatId, 'supplies_payment_confirm', { delivery: 'Recogida en Con Sentido', fullPayment: true });
      return { reply: [`Perfecto. Puedes recoger en ${KB.business.address}.`, '¿Quieres continuar con el pago?', '1. Si', '2. Tengo una pregunta'].join('\n') };
    }
    if (n === 2 || containsAny(text, ['mensajero', 'picap', 'rappi', 'indrive', 'uber'])) {
      setSession(chatId, 'courier_name', { delivery: 'Mensajero solicitado por el cliente', fullPayment: true });
      return { reply: ['Perfecto. Para evitar inconvenientes, *Con Sentido no solicita el domicilio*.', 'Espera a que te avisemos que tu pedido está listo: en ese momento pides el mensajero desde tu propia aplicación (no antes).', 'Cuando lo tengas asignado, envíame el *nombre del conductor*.'].join('\n') };
    }
    if (n === 3 || containsAny(text, ['envio nacional', 'otra ciudad', 'transportadora'])) {
      setSession(chatId, 'national_shipping_data', { delivery: 'Envio nacional', packaging: KB.supplies.packagingNational, fullPayment: true });
      return { reply: [`Para envio nacional agregamos ${money(KB.supplies.packagingNational)} por embalaje. El valor del transporte depende de la ciudad y la transportadora.`, 'Enviame en un solo mensaje: nombre completo, ciudad, direccion y telefono de quien recibe.'].join('\n') };
    }
    return retry(chatId, 'Elige: 1) recoger, 2) mensajero solicitado por ti o 3) envio nacional.');
  }
  if (state === 'courier_name') { setSession(chatId, 'courier_plate', { courierName: String(text).trim() }); return { reply: 'Gracias. ¿Cual es la placa del mensajero?' }; }
  if (state === 'courier_plate') { setSession(chatId, 'courier_code', { courierPlate: String(text).trim() }); return { reply: 'Perfecto. Ahora enviame el codigo o numero del servicio.' }; }
  if (state === 'courier_code') {
    setSession(chatId, 'supplies_payment_confirm', { courierCode: String(text).trim() });
    return { reply: ['Listo. Nosotros entregaremos el pedido unicamente al mensajero cuyos datos coincidan. El mensajero debe indicar el nombre o codigo de la compra al recoger.', '¿Quieres continuar con el pago?', '1. Si', '2. Tengo una pregunta'].join('\n') };
  }
  if (state === 'national_shipping_data') {
    setSession(chatId, 'supplies_payment_confirm', { shippingData: String(text).trim() });
    return { reply: ['Perfecto. Ya registre los datos de envio y el embalaje de $2.000.', '¿Quieres continuar con el pago?', '1. Si', '2. Tengo una pregunta'].join('\n') };
  }
  if (state === 'supplies_payment_confirm') {
    if (isYes(text)) return startPayment(chatId);
    if (isNoOrQuestion(text)) return { reply: 'Claro. Escríbeme tu pregunta y la resolvemos antes de pagar. 😊' };
    return retry(chatId, '¿Quieres continuar con el pago? 1. Si  2. Tengo una pregunta');
  }

  if (state === 'gifts_category') {
    const n = numbered(text, 6);
    if (n === 1 || containsAny(text, ['bouquet', 'ramo de velas'])) return startBouquet(chatId);
    if (n >= 2 && n <= 5) {
      updateProfile(chatId, { status: 'Categoria de regalos - pendiente de flujo detallado' });
      return escalate(chatId, 'Esta categoria aun la estamos terminando de automatizar para recomendarte bien. 🌿 Voy a pasarte con alguien del equipo para mostrarte las opciones disponibles.');
    }
    if (n === 6 || containsAny(text, ['no se que elegir', 'ayudame'])) {
      setSession(chatId, 'gift_helper_for_whom');
      return { reply: 'Claro. 🤍 ¿Para quien es el regalo y que ocasion quieres celebrar?' };
    }
    return retry(chatId, 'Elige una opcion del 1 al 6 o cuéntame con tus palabras que regalo buscas.');
  }
  if (state === 'gift_helper_for_whom') {
    setSession(chatId, 'gift_helper_budget', { giftContext: String(text).trim() });
    return { reply: ['Perfecto. ¿Que presupuesto aproximado tienes para el regalo?', '1. Hasta $40.000', '2. Entre $40.000 y $70.000', '3. Mas de $70.000', '4. Prefiero ver opciones'].join('\n') };
  }
  if (state === 'gift_helper_budget') {
    updateProfile(chatId, { status: 'Regalo por recomendar' });
    return escalate(chatId, 'Gracias. 🌿 Con esos datos el equipo puede mostrarte solo opciones que encajen con la ocasion y tu presupuesto. Te paso con alguien para ayudarte a elegir.');
  }
  if (state === 'bouquet_occasion') {
    const occasion = String(text).trim();
    setSession(chatId, 'bouquet_budget', { bouquetOccasion: occasion });
    return { reply: ['Perfecto. ¿Tienes un presupuesto aproximado para el regalo?', '1. Hasta $40.000', '2. Entre $40.000 y $70.000', '3. Mas de $70.000', '4. Prefiero ver opciones'].join('\n') };
  }
  if (state === 'bouquet_budget') {
    const { pdfPath } = getPdfIfNotSentBefore(chatId, 'velas_bouquets');
    setSession(chatId, 'bouquet_choice', { bouquetBudget: String(text).trim() });
    return { reply: ['Perfecto. 🌸 Te comparto las opciones de bouquets disponibles.', 'Cuando veas uno que te guste, escríbeme el nombre o referencia y seguimos con tu pedido.'].join('\n'), pdfPath };
  }
  if (state === 'bouquet_choice') {
    setSession(chatId, 'bouquet_card', { bouquetChoice: String(text).trim() });
    return { reply: ['¡Perfecto! 🌿 Lo agrego a tu pedido.', '¿Quieres incluir una tarjeta con mensaje personalizado?', '1. Si, agregar tarjeta', '2. No, continuar'].join('\n') };
  }
  if (state === 'bouquet_card') {
    if (isYes(text)) { setSession(chatId, 'bouquet_card_text', { addCard: true }); return { reply: 'Escríbeme el mensaje que quieres poner en la tarjeta. ✨' }; }
    if (isNoOrQuestion(text)) { setSession(chatId, 'bouquet_finish', { addCard: false }); return { reply: ['¿Quieres agregar otro detalle o finalizamos?', '1. Agregar otro producto', '2. Finalizar pedido'].join('\n') }; }
    return retry(chatId, '¿Quieres incluir tarjeta? 1. Si  2. No');
  }
  if (state === 'bouquet_card_text') {
    setSession(chatId, 'bouquet_finish', { cardText: String(text).trim() });
    return { reply: ['Listo, ya tengo el mensaje. 🤍', '¿Quieres agregar otro detalle o finalizamos?', '1. Agregar otro producto', '2. Finalizar pedido'].join('\n') };
  }
  if (state === 'bouquet_finish') {
    const n = numbered(text, 2);
    if (n === 1 || containsAny(text, ['agregar'])) return startGifts(chatId);
    if (n === 2 || containsAny(text, ['finalizar', 'terminar'])) {
      setSession(chatId, 'supplies_delivery', { orderText: `Bouquet: ${d.bouquetChoice || ''}`, fullPayment: true });
      return supplyDeliveryMenu(chatId);
    }
    return retry(chatId, 'Elige 1) agregar otro producto o 2) finalizar pedido.');
  }

  if (state === 'reservation_name') {
    const fullName = String(text || '').trim();
    if (fullName.split(/\s+/).length < 2) return { reply: 'Para evitar confusiones en la reserva, ¿me compartes por favor nombre y apellido?' };
    updateProfile(chatId, { reservationName: fullName });
    return sendPaymentInstructions(chatId);
  }
  if (state === 'waiting_receipt') {
    if (meta.hasMedia || isComprobanteText(text)) return receiptReceived(chatId);
    if (isPaymentIntent(text)) return { reply: 'Cuando tengas listo el comprobante, envialo por este mismo chat. La reserva o pedido se confirma despues de validar el ingreso. 🌿' };
    return { reply: 'Estoy pendiente de tu comprobante. Si tienes una duda antes de enviarlo, escribemela y te ayudo. 😊' };
  }

  return null;
}

function startPendingFlow(chatId, product) {
  updateProfile(chatId, { productoInteres: product, status: 'Pendiente de automatizacion detallada' });
  return escalate(chatId, `Gracias por tu interes en ${product}. 🌿 Este flujo aun no esta cerrado en la version que estamos ajustando, asi que te paso con alguien del equipo para atenderte correctamente.`);
}
function retry(chatId, prompt) {
  const s = getSession(chatId);
  const count = (s?.misunderstandCount || 0) + 1;
  if (s) { s.misunderstandCount = count; s.updatedAt = Date.now(); sessionStore.set(chatId, s); }
  if (count >= 2) return escalate(chatId, 'No quiero hacerte perder tiempo. 🙏 Voy a pasarte con alguien de nuestro equipo para ayudarte directamente.');
  return { reply: prompt };
}

function handleConversationInner(chatId, text, meta = {}) {
  clearFollowUps(chatId);
  const session = getSession(chatId);
  const state = session?.state;

  if (isBotPaused(chatId)) return { reply: null, final: true };
  if (state && state !== 'awaiting_name' && isMenuRequest(text)) return goMain(chatId);
  if (state && state !== 'awaiting_name' && isCorrection(text)) return { reply: session?.data?.lastPrompt ? `¡Sin problema! 😊 ${session.data.lastPrompt}` : '¡Sin problema! Dime nuevamente que opcion deseas.' };
  if (state && state !== 'awaiting_name' && isGreeting(text)) return { reply: session?.data?.lastPrompt ? `¡Hola de nuevo! 😊 ${session.data.lastPrompt}` : '¡Hola de nuevo! 😊 Continuemos donde ibamos.' };
  if (isHumanRequest(text)) return escalate(chatId, 'Claro. 🌿 Voy a pasarte con alguien de nuestro equipo para continuar tu atencion.');
  if (isMigaoQuestion(text)) return { reply: migaoInfo() };
  if (state === 'waiting_receipt' && (meta.hasMedia || isComprobanteText(text))) return receiptReceived(chatId);
  if (state && state !== 'waiting_receipt' && isPaymentIntent(text)) return startPayment(chatId);
  // Quedo pendiente pedir el nombre (saludo + necesidad en el mismo
  // mensaje inicial, ver mas abajo). Si esta respuesta es una sola
  // palabra (y no un numero), se toma como su nombre y se retoma la
  // pregunta que se le habia hecho (lastPrompt). Pero si trae varias
  // palabras, o es un numero, seguramente esta respondiendo esa pregunta
  // en vez de dar su nombre: se revisa como respuesta normal (abajo) y se
  // insiste una sola vez con el nombre despues de esa respuesta; si en
  // esa segunda oportunidad tampoco da un nombre claro, se deja de
  // insistir para no fastidiar.
  let insistOnNameAfter = false;
  if (state && session?.data?.needsName && !getContactProfile(chatId)?.nombre) {
    const trimmed = String(text || '').trim();
    const declaredName = extractDeclaredName(text);
    if (declaredName) {
      // Trae el nombre declarado con "soy"/"me llamo"/"mi nombre es",
      // solo o junto con la respuesta al flujo (ej. "1, soy Beatriz"): se
      // guarda el nombre y el mensaje completo sigue de largo hacia el
      // flujo normal (mas abajo), para no perder la respuesta si tambien
      // venia ahi.
      updateProfile(chatId, { nombre: declaredName });
      setSession(chatId, state, { needsName: false, nameInsisted: false });
    } else {
      const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
      const looksLikeName = wordCount === 1 && !/^\d+$/.test(trimmed);
      if (looksLikeName) {
        updateProfile(chatId, { nombre: trimmed });
        setSession(chatId, state, { needsName: false, nameInsisted: false });
        return { reply: session.data.lastPrompt ? `¡Un gusto, ${trimmed}! 😊 ${session.data.lastPrompt}` : `¡Un gusto, ${trimmed}! 😊` };
      }
      if (session.data.nameInsisted) {
        setSession(chatId, state, { needsName: false });
      } else {
        insistOnNameAfter = true;
      }
    }
  }

  if (!state) {
    const greeting = isGreeting(text);
    const shortcut = detectWorkshopShortcut(text);
    const interest = detectInterest(text);
    // Si el primer mensaje trae un saludo Y de una vez lo que necesita
    // ("Hola, quiero información de talleres"), no tiene sentido hacerlo
    // esperar a dar su nombre antes de contarle lo que pidio: se le
    // saluda y se le manda la info de una vez. El nombre se pide despues,
    // en su siguiente respuesta (needsName abajo), para no retrasar la
    // info pero igual poder personalizar la atencion.
    if (greeting && (shortcut || interest)) {
      const profile = getContactProfile(chatId);
      setSession(chatId, 'awaiting_interest', profile?.nombre ? {} : { needsName: true });
      const result = handleState(chatId, text, meta) || { reply: null };
      const greetLine = profile?.nombre ? `¡Hola de nuevo, ${firstName(chatId)}! 🌿` : '¡Hola! 🌿';
      const combined = result.reply ? { ...result, reply: `${greetLine}\n${result.reply}` } : result;
      // Igual que hace el cierre normal de handleConversationInner (mas
      // abajo): se guarda como lastPrompt para poder retomarlo si toca
      // pedir el nombre en la siguiente respuesta, o si el cliente saluda/
      // se corrige a mitad de flujo.
      if (combined.reply && !combined.final) {
        const updated = getSession(chatId);
        if (updated) setSession(chatId, updated.state, { lastPrompt: combined.reply });
      }
      return combined;
    }
    if (greeting) {
      // Si ya hubo una conversacion previa con este chat (le sabemos el
      // nombre), no se le vuelve a pedir el nombre como si fuera la
      // primera vez: se le saluda de nuevo y se pregunta directo en que
      // mas se le puede ayudar.
      const profile = getContactProfile(chatId);
      if (profile?.nombre) return goMain(chatId, { greeting: `¡Hola de nuevo, ${firstName(chatId)}!` });
      setSession(chatId, 'awaiting_name');
      return { reply: getWelcomeMessage() };
    }
    if (interest) { setSession(chatId, 'awaiting_interest'); return handleState(chatId, text, meta); }
    // A proposito NO se responde nada mas aqui (ni siquiera en el primer
    // mensaje de un chat nuevo): este numero tambien recibe conversaciones
    // personales, y una respuesta generica sin reconocer nada especifico
    // del negocio ya habia causado que el bot le hablara de mas a un
    // contacto personal. Ver isGreeting/detectInterest arriba para lo que
    // si dispara respuesta.
    return { reply: null };
  }

  const result = handleState(chatId, text, meta) || { reply: null };
  if (result.reply && !result.final) {
    // lastPrompt se guarda SIN la insistencia del nombre a proposito: si
    // mas adelante se retoma este mismo prompt (al capturar el nombre, al
    // saludar o corregirse a mitad de flujo), no tiene sentido repetir
    // "¿me regalas tu nombre?" cuando eso ya se resolvio o ya no aplica.
    const updated = getSession(chatId);
    if (updated) setSession(chatId, updated.state, { lastPrompt: result.reply, ...(insistOnNameAfter ? { nameInsisted: true } : {}) });
    if (insistOnNameAfter) {
      return { ...result, reply: `${result.reply}\n\nPor cierto, ¿me regalas tu nombre? Así te doy una atención más personalizada. 😊` };
    }
  }
  return result;
}

// Envoltorio de handleConversationInner que ademas guarda el mensaje del
// cliente y la respuesta del bot en el historial de conversacion (para
// leerlo despues en el panel). Se hace aca en un solo lugar en vez de en
// cada "return" de la funcion de arriba, que tiene varios.
function handleConversation(chatId, text, meta = {}) {
  logMessage(chatId, 'cliente', meta.hasMedia && !String(text || '').trim() ? '📎 (imagen o archivo adjunto)' : text);
  const result = handleConversationInner(chatId, text, meta);
  if (result) {
    let botText = result.reply;
    if (!botText && result.imagePath) botText = '📎 (imagen enviada)';
    else if (!botText && result.pdfPath) botText = '📎 (PDF enviado)';
    if (botText) logMessage(chatId, 'bot', botText);
  }
  return result;
}

function clearFollowUps(chatId) {
  const timers = followUpTimers.get(chatId) || [];
  timers.forEach(clearTimeout);
  followUpTimers.delete(chatId);
  followUpArmedAt.delete(chatId);
}
function scheduleFollowUps(chatId, sendMessage) {
  clearFollowUps(chatId);
  if (typeof sendMessage !== 'function') return;
  followUpArmedAt.set(chatId, Date.now());
  const timers = FOLLOW_UP_MESSAGES.map((f) => setTimeout(() => sendMessage(chatId, f.text), f.delay));
  followUpTimers.set(chatId, timers);
}
function clearPaymentReminder(chatId) {
  const t = paymentReminderTimers.get(chatId);
  if (t) clearTimeout(t);
  paymentReminderTimers.delete(chatId);
  paymentReminderArmedAt.delete(chatId);
}
function schedulePaymentReminder(chatId, sendMessage) {
  clearPaymentReminder(chatId);
  if (typeof sendMessage !== 'function') return;
  paymentReminderArmedAt.set(chatId, Date.now());
  const name = firstName(chatId);
  const text = `Hola${name ? `, ${name}` : ''}. 😊 Paso por aqui para saber si aun deseas continuar con tu reserva o pedido. Si necesitas ayuda con el pago, con gusto te acompaño.`;
  paymentReminderTimers.set(chatId, setTimeout(() => sendMessage(chatId, text), PAYMENT_REMINDER_DELAY_MS));
}
function rearmPendingReminders(sendMessage) {
  if (typeof sendMessage !== 'function') return;
  const now = Date.now();
  for (const [chatId, armedAt] of paymentReminderArmedAt.entries()) {
    const remaining = armedAt + PAYMENT_REMINDER_DELAY_MS - now;
    const text = `Hola${firstName(chatId) ? `, ${firstName(chatId)}` : ''}. 😊 ¿Aun deseas continuar con tu reserva o pedido?`;
    paymentReminderTimers.set(chatId, setTimeout(() => sendMessage(chatId, text), Math.max(0, remaining)));
  }
}
// Cada vez que respondes manualmente, se (re)marca la hora de pausa — si
// sigues respondiendo activamente, el chat se mantiene apagado; si pasan
// PAUSE_TTL_MS sin que vuelvas a escribir ahi, se reactiva solo.
function pauseBot(chatId) {
  pausedChats.set(chatId, Date.now());
  clearSession(chatId);
  clearFollowUps(chatId);
  clearPaymentReminder(chatId);
  persistNow(); // el panel lee data/bot-state.json; sin esto tardaba hasta 30s en reflejar el cambio.
}
function resumeBot(chatId) {
  pausedChats.delete(chatId);
  persistNow();
}
function isBotPaused(chatId) {
  const pausedAt = pausedChats.get(chatId);
  if (!pausedAt) return false;
  if (Date.now() - pausedAt > PAUSE_TTL_MS) {
    pausedChats.delete(chatId);
    return false;
  }
  return true;
}
function isResumeBotCommand(text) { return containsAny(text, ['bot on', 'activar bot', 'reactivar bot', 'encender bot']); }

function serializeState() {
  return {
    sessions: Object.fromEntries(sessionStore),
    contactProfiles: Object.fromEntries(contactProfileStore),
    pausedChats: Object.fromEntries(pausedChats),
    paymentReminderArmedAt: Object.fromEntries(paymentReminderArmedAt),
    escalationHistory,
    bookings,
    // El panel lee esto para saber cuantos cupos por dia+jornada mostrar,
    // sin tener que duplicar el numero a mano en dos archivos.
    bookingSlotCapacity: BOOKING_SLOT_CAPACITY,
    conversationLogs: Object.fromEntries(conversationLogs),
  };
}
function hydrateState() {
  const state = loadState();
  Object.entries(state.sessions || {}).forEach(([k, v]) => sessionStore.set(k, v));
  Object.entries(state.contactProfiles || {}).forEach(([k, v]) => contactProfileStore.set(k, v));
  const rawPausedChats = state.pausedChats;
  if (Array.isArray(rawPausedChats)) {
    // Formato viejo (Set serializado como arreglo, sin timestamp): se
    // migra asumiendo que la pausa acaba de ocurrir.
    rawPausedChats.forEach((k) => pausedChats.set(k, Date.now()));
  } else {
    Object.entries(rawPausedChats || {}).forEach(([k, v]) => pausedChats.set(k, v));
  }
  Object.entries(state.paymentReminderArmedAt || {}).forEach(([k, v]) => paymentReminderArmedAt.set(k, v));
  if (Array.isArray(state.escalationHistory)) escalationHistory.push(...state.escalationHistory);
  if (Array.isArray(state.bookings)) bookings.push(...state.bookings);
  Object.entries(state.conversationLogs || {}).forEach(([k, v]) => { if (Array.isArray(v)) conversationLogs.set(k, v); });
}
hydrateState();
function persistNow() { saveState(serializeState()); }
// isBotPaused() limpia una pausa vencida de forma "perezosa" (solo cuando
// el cliente vuelve a escribir ahi). Si nunca vuelve a escribir, se queda
// vencida para siempre en pausedChats y el panel la sigue mostrando en
// "Chats pausados" con "ya mismo" sin que desaparezca nunca. Este barrido
// periodico la limpia igual, aunque nadie vuelva a escribir.
function sweepExpiredPauses() {
  const now = Date.now();
  let changed = false;
  for (const [chatId, pausedAt] of pausedChats.entries()) {
    if (now - pausedAt > PAUSE_TTL_MS) {
      pausedChats.delete(chatId);
      changed = true;
    }
  }
  return changed;
}
const persistTimer = setInterval(() => {
  sweepExpiredPauses();
  persistNow();
}, 30000);
if (persistTimer.unref) persistTimer.unref();

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
  rearmPendingReminders,
  getBookings,
  updateBookingStatus,
  getConversationLog,
};

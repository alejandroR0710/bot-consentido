/**
 * Utilidades de fecha en español, en formato ISO ("YYYY-MM-DD") <-> texto
 * legible ("Domingo 30 de agosto"). Se centraliza aquí porque ya se
 * necesitaba en 3 lugares distintos (knowledgeBase.js, conversationService.js,
 * dashboard/server.js) y mantenerla duplicada arriesgaba que se desincronizaran.
 */
const WEEKDAYS_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function parseIsoDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDateEs(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = parseIsoDate(isoDate);
  const currentYear = new Date().getFullYear();
  const yearSuffix = y !== currentYear ? ` de ${y}` : '';
  return `${WEEKDAYS_ES[date.getDay()]} ${d} de ${MONTHS_ES[m - 1]}${yearSuffix}`;
}

function isPastIsoDate(isoDate) {
  const date = parseIsoDate(isoDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

function toIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 0 = domingo, 6 = sabado (como Date#getDay()).
function isWeekday(isoDate) {
  const day = parseIsoDate(isoDate).getDay();
  return day >= 1 && day <= 5;
}

module.exports = { WEEKDAYS_ES, MONTHS_ES, formatDateEs, isPastIsoDate, toIsoDate, isWeekday, parseIsoDate };

/**
 * Reglas de disponibilidad del negocio, compartidas por los distintos
 * flujos de agenda (Avanzado, Personalizado, Experiencia y Basico grupal)
 * y por el panel. Se centralizan aca para no repetir la logica en cada
 * lugar y que quede un solo sitio donde ajustarlas si cambian.
 *
 * Reglas vigentes:
 * - Avanzado / Personalizado / Experiencia: no se agenda martes en la
 *   jornada de tarde (3pm-7pm).
 * - Experiencia (solo ella): tampoco se agenda sabado en la jornada de
 *   manana (9am-1pm, es decir, antes de las 3pm). Sabado en la tarde si.
 * - Basico grupal: es un solo bloque fijo de 9am a 3pm (sin jornada); como
 *   ese horario siempre pisa la tarde, los martes quedan bloqueados por
 *   completo para esta modalidad. El sabado NO esta restringido aqui.
 */
const { parseIsoDate } = require('./dateEs');

const TUESDAY = 2;
const SATURDAY = 6;
const NFD_MARKS_RE = new RegExp('[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f) + ']', 'g');

function stripAccents(text) {
  return String(text || '').normalize('NFD').replace(NFD_MARKS_RE, '');
}

function isTuesdayAfternoon(isoDate, schedule) {
  return parseIsoDate(isoDate).getDay() === TUESDAY && schedule === 'Tarde';
}
function isSaturdayBeforeThree(isoDate, schedule) {
  return parseIsoDate(isoDate).getDay() === SATURDAY && schedule === 'Mañana';
}

// Avanzado / Personalizado: agenda dinamica de lunes a viernes (eso ya lo
// filtra isWeekday en dateEs.js); aca solo se agrega el bloqueo del martes
// en la tarde.
function isWorkshopSlotAllowed(isoDate, schedule) {
  return !isTuesdayAfternoon(isoDate, schedule);
}

// Experiencia: mismo bloqueo de martes en la tarde, mas el de sabado antes
// de las 3pm. A diferencia de los talleres, la Experiencia si puede caer
// sabado (o cualquier otro dia): solo se bloquean estas dos combinaciones.
function isExperienceSlotAllowed(isoDate, schedule) {
  return !isTuesdayAfternoon(isoDate, schedule) && !isSaturdayBeforeThree(isoDate, schedule);
}

// Variante de lo anterior para cuando la fecha de la Experiencia es texto
// libre del cliente (no un ISO parseable), que es como se captura hoy. Se
// detecta el dia por palabras clave ("martes"/"sabado") en vez de parsear
// la fecha; si el cliente no menciona el dia en su texto, no se bloquea
// (el asesor humano que atiende despues es quien hace la validacion final).
function isExperienceTextSlotBlocked(dateText, schedule) {
  const text = stripAccents(String(dateText || '').toLowerCase());
  if (schedule === 'Tarde' && /\bmartes\b/.test(text)) return true;
  if (schedule === 'Mañana' && /\bsabado\b/.test(text)) return true;
  return false;
}

// Basico grupal: bloque fijo 9am-3pm sin jornada. Se bloquea el martes
// completo; el sabado no tiene restriccion para esta modalidad.
function isFixedBlockDateBlocked(isoDate) {
  return parseIsoDate(isoDate).getDay() === TUESDAY;
}

module.exports = {
  isWorkshopSlotAllowed,
  isExperienceSlotAllowed,
  isExperienceTextSlotBlocked,
  isFixedBlockDateBlocked,
};

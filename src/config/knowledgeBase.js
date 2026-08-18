/**
 * knowledgeBase.js
 * Datos comerciales de Con Sentido separados de la logica conversacional.
 * Editar este archivo cuando cambien precios, horarios o medios de pago.
 *
 * Las FECHAS de agendamiento de los talleres NO se editan aqui: se
 * administran desde el panel (npm run dashboard -> pestaña "Fechas de
 * agendamiento"), que las guarda en data/schedule-dates.json. Ese archivo,
 * si existe, sobreescribe los "dates" de abajo al cargar este modulo.
 */
const fs = require('fs');
const path = require('path');
const { formatDateEs, isPastIsoDate } = require('../utils/dateEs');

const KB = {
  business: {
    name: 'Con Sentido',
    address: 'Carrera 38B #90-03 Sur, Barrio Ciudad Montes, Bogota',
    hours: '10:00 a.m. a 9:00 p.m.',
    whatsapp: '321-303-5263',
    socialHandle: 'Consentido Velas',
    nationalShipping: true,
    localDeliveryPolicy:
      'Con Sentido no solicita mensajeros por aplicaciones. Si deseas envio local, debes pedir el mensajero desde tu propia aplicacion y enviarnos nombre del conductor, placa y codigo del servicio.',
  },

  payment: {
    methods: [
      { name: 'Nequi', value: process.env.NEQUI_NUMBER || '3153047547' },
      { name: 'Llave', value: process.env.PAYMENT_KEY || '0090622675' },
    ],
    reservationDeposit: 80000,
  },

  workshops: {
    basicGroup: {
      name: 'MasterClass Basico',
      price: 250000,
      deposit: 80000,
      schedule: '9:00 a.m. a 3:00 p.m.',
      frequency: 'Uno o dos domingos al mes, segun programacion.',
      maxPeople: 10,
      includes: ['Materiales', 'Brunch', 'Certificado de asistencia'],
      techniques: ['Vela de molde', 'Vela aromatica en vaso', 'Wax Melts'],
      topics: [
        'Tipos de ceras y sus usos',
        'Fragancias y porcentajes',
        'Pabilos',
        'Colorantes',
        'Temperaturas y procesos',
        'Costos y precios de venta',
        'Bases para comenzar a emprender',
      ],
      // Si queda vacio, Abby deriva al equipo en vez de ofrecer fechas.
      // Editar desde el panel (pestaña "Fechas de agendamiento"), no aquí.
      dates: [],
    },
    basicPersonalized: {
      name: 'MasterClass Basico Personalizado',
      price: 300000,
      deposit: 80000,
      days: 'Lunes a viernes, sujeto a disponibilidad.',
      schedules: ['9:00 a.m. a 1:00 p.m.', '3:00 p.m. a 7:00 p.m.'],
      includes: ['Materiales', 'Brunch', 'Certificado de asistencia'],
      techniques: ['Vela de molde', 'Vela aromatica en vaso', 'Wax Melts'],
      // Personalizado: no usa lista fija de fechas. El bot pregunta
      // disponibilidad real (lunes a viernes) y agenda contra el cupo
      // compartido en conversationService.js (bookings).
    },
    advanced: {
      name: 'MasterClass Avanzado',
      price: 300000,
      deposit: 80000,
      days: 'Lunes a viernes, sujeto a disponibilidad.',
      schedules: ['9:00 a.m. a 1:00 p.m.', '3:00 p.m. a 7:00 p.m.'],
      includes: ['Materiales', 'Brunch', 'Certificado de asistencia'],
      techniques: [
        'Velas de masaje',
        'Velas en cera gel',
        'Velas estilo Chantilly con acabado tipo postre',
      ],
      // Avanzado: mismo esquema de agenda por disponibilidad que
      // Personalizado (comparten el mismo cupo, ver conversationService.js).
    },
  },

  experience: {
    name: 'Experiencia Con Sentido',
    pricePerPerson: 120000,
    minPeople: 2,
    duration: 'Aproximadamente 3 horas',
    deposit: 80000,
    includes: [
      'Bebida fria o caliente de bienvenida',
      'Momento Con Sentido: dinamica de conversacion adaptada al vinculo de los asistentes',
      'Breve explicacion sobre ceras y sus usos',
      'Elaboracion de una vela artesanal por cada participante',
      'Migao a eleccion de cada participante en El Rinconcito del Migao',
      'Fotografias de la experiencia',
      'Pequeno video de recuerdo',
    ],
    birthdayExtras: {
      decoration: 20000,
      cakePerPerson: 10000,
    },
  },

  supplies: {
    packagingNational: 2000,
    catalogs: {
      fragrances: 'insumos_fragancias',
      general: 'insumos_generales',
    },
  },

  gifts: {
    bouquetBudgetBands: [
      { key: 'hasta40', label: 'Hasta $40.000' },
      { key: '40a70', label: 'Entre $40.000 y $70.000' },
      { key: 'mas70', label: 'Mas de $70.000' },
      { key: 'ver', label: 'Prefiero ver opciones' },
    ],
  },
};

// data/schedule-dates.json guarda fechas reales en formato ISO
// ("2026-08-30"), no el texto que se le muestra al cliente. Así se puede
// comparar contra "hoy" y dejar de ofrecer automaticamente una fecha que
// ya paso, sin que alguien tenga que acordarse de borrarla a mano.
//
// Aplica las fechas guardadas desde el panel (si existen) por encima de los
// valores de arriba. Solo aplica a basicGroup: Avanzado y Personalizado ya
// no usan lista fija (ver conversationService.js, flujo de agenda por
// disponibilidad). Las fechas ya vencidas se excluyen aquí mismo, asi que
// el bot nunca las llega a ofrecer.
try {
  const overridesPath = path.resolve(__dirname, '..', '..', 'data', 'schedule-dates.json');
  if (fs.existsSync(overridesPath)) {
    const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
    // Solo basicGroup usa lista fija de fechas; aunque el archivo aun tenga
    // entradas viejas de "advanced"/"basicPersonalized" (de antes del
    // cambio a agenda por disponibilidad), se ignoran a proposito.
    const isoDates = overrides.basicGroup;
    if (KB.workshops.basicGroup && Array.isArray(isoDates)) {
      KB.workshops.basicGroup.dates = isoDates
        .filter((iso) => typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) && !isPastIsoDate(iso))
        .sort()
        .map(formatDateEs);
    }
  }
} catch (error) {
  console.warn('⚠️ No se pudo cargar data/schedule-dates.json:', error.message);
}

module.exports = KB;

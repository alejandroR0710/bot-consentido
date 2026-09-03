// Frontend del panel: vanilla JS, sin build step. Todo por fetch() a las
// rutas /api/* del servidor (dashboard/server.js).

const STATUS_LABELS = {
  stopped: 'Apagado',
  starting: 'Iniciando…',
  qr: 'Esperando QR',
  ready: 'Conectado',
  disconnected: 'Desconectado',
  logout: 'Sesión cerrada (LOGOUT)'
};

let lastLogTs = 0;

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return document.querySelectorAll(sel); }

// ---------- tabs ----------
$all('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $all('.tab-btn').forEach((b) => b.classList.remove('active'));
    $all('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ---------- logout ----------
$('#logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

// ---------- control buttons ----------
async function callAction(url) {
  const res = await fetch(url, { method: 'POST' });
  if (res.status === 401) { window.location.href = '/login.html'; return; }
  await refreshStatus();
}
$('#startBtn').addEventListener('click', () => callAction('/api/start'));
$('#stopBtn').addEventListener('click', () => callAction('/api/stop'));
$('#restartBtn').addEventListener('click', () => callAction('/api/restart'));

// ---------- status + qr ----------
async function refreshStatus() {
  const res = await fetch('/api/status');
  if (res.status === 401) { window.location.href = '/login.html'; return; }
  const data = await res.json();

  const pill = $('#statusPill');
  pill.textContent = STATUS_LABELS[data.status] || data.status;
  pill.className = `status-pill status-${data.status}`;

  $('#statusText').textContent = STATUS_LABELS[data.status] || data.status;
  $('#statusPid').textContent = data.pid || '—';
  $('#statusInfo').textContent = data.info ? (data.info.pushname || data.info.wid || '—') : '—';

  $('#startBtn').disabled = data.running;
  $('#stopBtn').disabled = !data.running;

  const qrCard = $('#qrCard');
  if (data.hasQr) {
    qrCard.hidden = false;
    const qrRes = await fetch('/api/qr');
    if (qrRes.ok) {
      const { dataUrl } = await qrRes.json();
      $('#qrImage').src = dataUrl;
    }
  } else {
    qrCard.hidden = true;
  }
}

// ---------- logs ----------
async function refreshLogs() {
  const res = await fetch(`/api/logs?since=${lastLogTs}`);
  if (res.status === 401) return;
  const { lines } = await res.json();
  if (!lines.length) return;
  const view = $('#logView');
  const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
  lines.forEach((l) => {
    lastLogTs = Math.max(lastLogTs, l.ts);
    view.textContent += (view.textContent ? '\n' : '') + l.text;
  });
  if ($('#autoScroll').checked && atBottom) view.scrollTop = view.scrollHeight;
}

// Celda "Chat" reutilizada en Pausados/Clientes/Escalamientos: link real
// para abrir la conversación, o un aviso si todavía no se pudo resolver
// (solo pasa con ids @lid mientras el bot no se ha conectado con ellos).
function chatLinkCell(chatId, chatLink) {
  return chatLink
    ? `<a href="${chatLink}" target="_blank" rel="noopener">Abrir chat ↗</a>`
    : `<span class="muted" title="${chatId}">Se resuelve cuando el bot esté conectado</span>`;
}

// ---------- conversaciones (TODOS los chats que atendio el bot) ----------
async function refreshConversations() {
  const res = await fetch('/api/conversations');
  if (res.status === 401) return;
  const { conversations } = await res.json();
  const tbody = $('#conversationsTable tbody');
  tbody.innerHTML = '';
  $('#conversationsEmpty').hidden = conversations.length > 0;
  conversations.forEach((c) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${c.nombre || 'Sin nombre'}</td>
      <td class="link-cell">${chatLinkCell(c.chatId, c.chatLink)}</td>
      <td>${c.status || '—'}</td>
      <td>${c.messageCount}</td>
      <td>${c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString('es-CO') : '—'}</td>
      <td></td>
    `;
    const convCell = tr.lastElementChild;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'link-btn';
    btn.textContent = 'Ver conversación';
    btn.addEventListener('click', () => openConversationModal(c.chatId, c.nombre));
    convCell.appendChild(btn);
    tbody.appendChild(tr);
  });
}

// ---------- chats pausados ----------
function formatDuration(ms) {
  if (ms <= 0) return 'ya mismo';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function refreshPaused() {
  const res = await fetch('/api/paused-chats');
  if (res.status === 401) return;
  const { chats, botRunning } = await res.json();
  const tbody = $('#pausedTable tbody');
  tbody.innerHTML = '';
  $('#pausedEmpty').hidden = chats.length > 0;
  chats.forEach((c) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${c.nombre || '—'}</td>
      <td class="link-cell">${chatLinkCell(c.chatId, c.chatLink)}</td>
      <td>${new Date(c.pausedAt).toLocaleString('es-CO')}</td>
      <td>${formatDuration(c.msRemaining)}</td>
      <td></td>
      <td></td>
    `;
    const convCell = tr.children[4];
    if (c.chatId) {
      const convBtn = document.createElement('button');
      convBtn.type = 'button';
      convBtn.className = 'link-btn';
      convBtn.textContent = 'Ver conversación';
      convBtn.addEventListener('click', () => openConversationModal(c.chatId, c.nombre));
      convCell.appendChild(convBtn);
    } else {
      convCell.textContent = '—';
    }

    const actionCell = tr.lastElementChild;
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary';
    btn.textContent = 'Reactivar ahora';
    btn.disabled = !botRunning;
    btn.title = botRunning ? '' : 'Inicia el bot primero';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Reactivando…';
      try {
        const res = await fetch(`/api/paused-chats/${encodeURIComponent(c.chatId)}/resume`, { method: 'POST' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          actionCell.innerHTML = `<span class="error-text">${data.error || 'No se pudo reactivar.'}</span>`;
          return;
        }
        // Confirmación inmediata en vez de esperar la siguiente consulta
        // al servidor (que podía tardar y hacía parecer que no pasó nada).
        actionCell.innerHTML = '<span class="success-text">✅ Reactivado</span>';
        setTimeout(() => { tr.remove(); if (!$('#pausedTable tbody').children.length) $('#pausedEmpty').hidden = false; }, 1200);
      } catch (error) {
        actionCell.innerHTML = '<span class="error-text">Error de conexión.</span>';
      }
    });
    actionCell.appendChild(btn);
    tbody.appendChild(tr);
  });
}

// ---------- clientes ----------
async function refreshContacts() {
  const res = await fetch('/api/contacts');
  if (res.status === 401) return;
  const { contacts } = await res.json();
  const tbody = $('#contactsTable tbody');
  tbody.innerHTML = '';
  $('#contactsEmpty').hidden = contacts.length > 0;
  contacts.forEach((c) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${c.nombre || '—'}</td>
      <td class="link-cell">${chatLinkCell(c.chatId, c.chatLink)}</td>
      <td>${c.productoInteres || '—'}</td>
      <td>${c.status || '—'}</td>
      <td>${c.ciudad || '—'}</td>
      <td>${(c.tags || []).join(', ') || '—'}</td>
      <td></td>
    `;
    const convCell = tr.lastElementChild;
    if (c.chatId) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link-btn';
      btn.textContent = 'Ver conversación';
      btn.addEventListener('click', () => openConversationModal(c.chatId, c.nombre));
      convCell.appendChild(btn);
    } else {
      convCell.textContent = '—';
    }
    tbody.appendChild(tr);
  });
}

// ---------- escalamientos ----------
async function refreshEscalations() {
  const res = await fetch('/api/escalations');
  if (res.status === 401) return;
  const { escalations } = await res.json();
  const tbody = $('#escalationsTable tbody');
  tbody.innerHTML = '';
  $('#escalationsEmpty').hidden = escalations.length > 0;
  escalations.forEach((e) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(e.timestamp).toLocaleString('es-CO')}</td>
      <td>${e.nombre || '—'}</td>
      <td class="link-cell">${chatLinkCell(e.chatId, e.chatLink)}</td>
      <td>${e.productoInteres || '—'}</td>
      <td>${e.motivo || '—'}</td>
      <td></td>
    `;
    const convCell = tr.lastElementChild;
    if (e.chatId) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link-btn';
      btn.textContent = 'Ver conversación';
      btn.addEventListener('click', () => openConversationModal(e.chatId, e.nombre));
      convCell.appendChild(btn);
    } else {
      convCell.textContent = '—';
    }
    tbody.appendChild(tr);
  });
}

// ---------- modal de conversación ----------
function renderConversationMessages(messages) {
  const container = $('#conversationMessages');
  container.innerHTML = '';
  $('#conversationEmpty').hidden = messages.length > 0;
  messages.forEach((m) => {
    const row = document.createElement('div');
    row.className = `chat-bubble-row from-${m.from}`;
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.textContent = m.text;
    const time = document.createElement('span');
    time.className = 'chat-bubble-time';
    time.textContent = new Date(m.timestamp).toLocaleString('es-CO');
    bubble.appendChild(time);
    row.appendChild(bubble);
    container.appendChild(row);
  });
  if (messages.length) container.scrollTop = container.scrollHeight;
}

async function openConversationModal(chatId, nombre) {
  const modal = $('#conversationModal');
  $('#conversationModalTitle').textContent = `Conversación${nombre ? ` — ${nombre}` : ''}`;
  renderConversationMessages([]);
  modal.hidden = false;
  const res = await fetch(`/api/conversations/${encodeURIComponent(chatId)}`);
  if (res.status === 401) { window.location.href = '/login.html'; return; }
  const { messages } = await res.json();
  renderConversationMessages(messages || []);
}

function closeConversationModal() { $('#conversationModal').hidden = true; }
$('#conversationModalClose').addEventListener('click', closeConversationModal);
$('#conversationModal').addEventListener('click', (e) => {
  if (e.target.id === 'conversationModal') closeConversationModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#conversationModal').hidden) closeConversationModal();
});

// ---------- fechas de agendamiento ----------
const WEEKDAYS_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// El <input type="date"> entrega "YYYY-MM-DD". Se construye con
// año/mes/día por separado (en vez de `new Date(iso)`) para que quede en
// hora local y no se corra un día por huso horario. El año solo se
// muestra si es distinto al actual, para que fechas cercanas se lean
// igual de naturales que las que ya se escribían a mano.
function formatDateEs(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const currentYear = new Date().getFullYear();
  const yearSuffix = y !== currentYear ? ` de ${y}` : '';
  return `${WEEKDAYS_ES[date.getDay()]} ${d} de ${MONTHS_ES[m - 1]}${yearSuffix}`;
}

async function loadScheduleDates() {
  const res = await fetch('/api/schedule-dates');
  if (res.status === 401) return;
  const { workshops } = await res.json();
  const container = $('#scheduleWorkshops');
  container.innerHTML = '';

  workshops.forEach((w) => {
    let dates = [...w.dates];

    const block = document.createElement('div');
    block.className = 'schedule-workshop';
    const todayIso = new Date().toISOString().slice(0, 10);
    block.innerHTML = `
      <h3>${w.label} <span class="workshop-saved" hidden>Guardado ✓</span></h3>
      <div class="date-chip-list"></div>
      <div class="date-add-row">
        <input type="date" min="${todayIso}" />
        <button class="btn btn-secondary" type="button">Agregar</button>
      </div>
      <p class="error-text workshop-date-error" hidden></p>
    `;
    const chipList = block.querySelector('.date-chip-list');
    const input = block.querySelector('input');
    const addBtn = block.querySelector('button');
    const savedLabel = block.querySelector('.workshop-saved');
    const dateError = block.querySelector('.workshop-date-error');

    function renderChips() {
      chipList.innerHTML = '';
      if (!dates.length) {
        const empty = document.createElement('span');
        empty.className = 'muted';
        empty.textContent = 'Sin fechas cargadas: el bot pasa directo a coordinar con un asesor.';
        chipList.appendChild(empty);
        return;
      }
      dates.forEach((date, idx) => {
        const chip = document.createElement('span');
        chip.className = date.expired ? 'date-chip date-chip-expired' : 'date-chip';
        chip.textContent = date.expired ? `${date.label} (ya pasó)` : date.label;
        chip.title = date.expired ? 'El bot ya no ofrece esta fecha por estar vencida. Puedes quitarla.' : '';
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.setAttribute('aria-label', 'Quitar fecha');
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', () => { dates.splice(idx, 1); save(); });
        chip.appendChild(removeBtn);
        chipList.appendChild(chip);
      });
    }

    async function save() {
      renderChips();
      const res2 = await fetch(`/api/schedule-dates/${w.key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dates: dates.map((d) => d.iso) })
      });
      if (res2.ok) {
        savedLabel.hidden = false;
        setTimeout(() => { savedLabel.hidden = true; }, 2500);
      }
    }

    addBtn.addEventListener('click', () => {
      if (!input.value) return;
      dateError.hidden = true;
      // El Basico grupal es un bloque fijo de 9am a 3pm, y ese horario
      // siempre choca con la restriccion de "no agendar martes en la
      // tarde" (regla del negocio), asi que los martes no se pueden
      // cargar aqui.
      const [y, m, dayNum] = input.value.split('-').map(Number);
      const weekday = new Date(y, m - 1, dayNum).getDay();
      if (weekday === 2) {
        dateError.textContent = 'Los martes no se pueden agendar (el horario fijo de este taller choca con la tarde).';
        dateError.hidden = false;
        return;
      }
      if (dates.some((d) => d.iso === input.value)) { input.value = ''; return; }
      dates.push({ iso: input.value, label: formatDateEs(input.value), expired: false });
      dates.sort((a, b) => a.iso.localeCompare(b.iso));
      input.value = '';
      save();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); }
    });

    renderChips();
    container.appendChild(block);
  });
}

// ---------- agenda (Avanzado / Personalizado) ----------
// Mismo utilitario de fecha local que en "fechas de agendamiento": se arma
// año/mes/día a mano para no correrse un día por huso horario.
function toIsoDateLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

let calCursorDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let calSelectedIso = null;
let calBookingsByDate = {};
let calSlotCapacity = 2;

function buildBookingsByDate(bookings) {
  const map = {};
  bookings.forEach((b) => {
    if (!map[b.date]) map[b.date] = [];
    map[b.date].push(b);
  });
  return map;
}

function renderCalendar() {
  const grid = $('#calendarGrid');
  grid.innerHTML = '';
  const year = calCursorDate.getFullYear();
  const month = calCursorDate.getMonth();
  $('#calMonthLabel').textContent = `${MONTHS_ES[month][0].toUpperCase()}${MONTHS_ES[month].slice(1)} de ${year}`;

  WEEKDAYS_ES.forEach((wd) => {
    const el = document.createElement('div');
    el.className = 'calendar-weekday';
    el.textContent = wd.slice(0, 3);
    grid.appendChild(el);
  });

  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay(); // 0 = domingo, igual que WEEKDAYS_ES
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayIso = toIsoDateLocal(new Date());

  for (let i = 0; i < startOffset; i++) {
    const filler = document.createElement('div');
    filler.className = 'calendar-day is-empty';
    grid.appendChild(filler);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day);
    const iso = toIsoDateLocal(date);
    const dow = date.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const dayBookings = calBookingsByDate[iso] || [];

    const cell = document.createElement('div');
    cell.className = 'calendar-day';
    if (isWeekend) cell.classList.add('is-weekend');
    if (iso < todayIso) cell.classList.add('is-past');
    if (dayBookings.length) cell.classList.add('has-bookings');
    if (iso === calSelectedIso) cell.classList.add('is-selected');

    const num = document.createElement('div');
    num.className = 'calendar-day-num';
    num.textContent = String(day);
    cell.appendChild(num);

    if (dayBookings.length) {
      const badges = document.createElement('div');
      badges.className = 'calendar-day-badges';

      // El Basico grupal no tiene cupo compartido por jornada (son fechas
      // fijas, sin limite de 2): se muestra aparte, solo como conteo de
      // inscritos, para no mezclarlo con el cupo de Avanzado/Personalizado.
      const scheduleBookings = dayBookings.filter((b) => b.workshopKey !== 'basicGroup');
      const groupBookings = dayBookings.filter((b) => b.workshopKey === 'basicGroup');

      const bySchedule = {};
      scheduleBookings.forEach((b) => { bySchedule[b.schedule] = (bySchedule[b.schedule] || 0) + 1; });
      Object.entries(bySchedule).forEach(([schedule, count]) => {
        const badge = document.createElement('span');
        badge.className = count >= calSlotCapacity ? 'calendar-badge is-full' : 'calendar-badge';
        badge.textContent = `${schedule}: ${count}/${calSlotCapacity}`;
        badges.appendChild(badge);
      });
      if (groupBookings.length) {
        const badge = document.createElement('span');
        badge.className = 'calendar-badge calendar-badge-group';
        badge.textContent = `🎓 Básico grupal: ${groupBookings.length}`;
        badges.appendChild(badge);
      }
      cell.appendChild(badges);
      cell.addEventListener('click', () => {
        calSelectedIso = iso;
        renderCalendar();
        renderDayDetail(iso);
      });
    }

    grid.appendChild(cell);
  }
}

// Pago y asistencia no los sabe el bot (se confirman por fuera, con el
// asesor); por eso se marcan a mano aquí. El servidor los guarda mandandole
// un IPC al proceso del bot (igual que "Reactivar" en Chats pausados), asi
// que sigue siendo el bot el unico que escribe data/bot-state.json.
const PAYMENT_LABELS = { pendiente: 'Pendiente', abono: 'Abonó', completo: 'Pago completo' };

async function saveBookingStatus(bookingId, patch) {
  try {
    const res = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    return res.ok;
  } catch (error) {
    return false;
  }
}

function renderDayDetail(iso) {
  const dayBookings = calBookingsByDate[iso] || [];
  $('#calDayTitle').textContent = `Reservas del ${formatDateEs(iso)}`;
  const tbody = $('#calDayTable tbody');
  tbody.innerHTML = '';
  $('#calDayEmpty').hidden = dayBookings.length > 0;
  dayBookings.forEach((b) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${b.schedule || (b.workshopKey === 'basicGroup' ? 'Grupal (9am-3pm)' : '—')}</td>
      <td>${b.workshopLabel || b.product || '—'}</td>
      <td>${b.nombre || '—'}</td>
      <td class="link-cell">${chatLinkCell(b.chatId, b.chatLink)}</td>
      <td>${new Date(b.createdAt).toLocaleString('es-CO')}</td>
      <td class="payment-cell"></td>
      <td class="amount-cell"></td>
      <td class="attendance-cell"></td>
    `;

    const amountCell = tr.querySelector('.amount-cell');
    // El monto abonado solo tiene sentido si el estado es "Abonó": para
    // Pendiente o Pago completo no se muestra el campo, solo un guion.
    function paintAmountCell() {
      amountCell.innerHTML = '';
      if (b.payment !== 'abono') {
        const dash = document.createElement('span');
        dash.className = 'muted';
        dash.textContent = '—';
        amountCell.appendChild(dash);
        return;
      }
      const amountInput = document.createElement('input');
      amountInput.type = 'number';
      amountInput.min = '0';
      amountInput.step = '1000';
      amountInput.placeholder = '0';
      amountInput.className = 'amount-input';
      if (b.depositAmount !== null && b.depositAmount !== undefined) amountInput.value = b.depositAmount;
      amountInput.addEventListener('change', async () => {
        const raw = amountInput.value.trim();
        const prev = b.depositAmount;
        const next = raw === '' ? null : Number(raw);
        amountInput.disabled = true;
        const ok = await saveBookingStatus(b.id, { depositAmount: next });
        amountInput.disabled = false;
        if (ok) {
          b.depositAmount = next;
        } else {
          amountInput.value = prev !== null && prev !== undefined ? prev : '';
        }
      });
      amountCell.appendChild(amountInput);
    }
    paintAmountCell();

    const select = document.createElement('select');
    select.className = `payment-select payment-${b.payment || 'pendiente'}`;
    Object.entries(PAYMENT_LABELS).forEach(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      if ((b.payment || 'pendiente') === value) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', async () => {
      const prev = b.payment || 'pendiente';
      const next = select.value;
      select.disabled = true;
      const ok = await saveBookingStatus(b.id, { payment: next });
      select.disabled = false;
      if (ok) {
        b.payment = next;
        select.className = `payment-select payment-${next}`;
        paintAmountCell();
      } else {
        select.value = prev;
      }
    });
    tr.querySelector('.payment-cell').appendChild(select);

    const attBtn = document.createElement('button');
    attBtn.type = 'button';
    function paintAttendance() {
      attBtn.className = b.attendanceConfirmed ? 'btn btn-secondary attendance-btn is-confirmed' : 'btn btn-ghost attendance-btn';
      attBtn.textContent = b.attendanceConfirmed ? '✅ Asistirá' : 'Confirmar asistencia';
    }
    paintAttendance();
    attBtn.addEventListener('click', async () => {
      const next = !b.attendanceConfirmed;
      attBtn.disabled = true;
      const ok = await saveBookingStatus(b.id, { attendanceConfirmed: next });
      attBtn.disabled = false;
      if (ok) { b.attendanceConfirmed = next; paintAttendance(); }
    });
    tr.querySelector('.attendance-cell').appendChild(attBtn);

    tbody.appendChild(tr);
  });
}

async function loadBookings() {
  const res = await fetch('/api/bookings');
  if (res.status === 401) return;
  const { bookings, slotCapacity } = await res.json();
  calSlotCapacity = slotCapacity || 2;
  calBookingsByDate = buildBookingsByDate(bookings);
  $('#agendaCapacityNote').textContent = `Cupo por día y jornada: ${calSlotCapacity}`;
  renderCalendar();
  if (calSelectedIso) renderDayDetail(calSelectedIso);
}

$('#calPrevBtn').addEventListener('click', () => {
  calCursorDate = new Date(calCursorDate.getFullYear(), calCursorDate.getMonth() - 1, 1);
  renderCalendar();
});
$('#calNextBtn').addEventListener('click', () => {
  calCursorDate = new Date(calCursorDate.getFullYear(), calCursorDate.getMonth() + 1, 1);
  renderCalendar();
});

// ---------- configuración ----------
async function loadConfig() {
  const res = await fetch('/api/config');
  if (res.status === 401) return;
  const { config } = await res.json();
  const form = $('#configForm');
  form.TEST_MODE_SELF_CHAT.checked = String(config.TEST_MODE_SELF_CHAT).toLowerCase() === 'true';
  form.RESET_WHATSAPP_SESSION.checked = String(config.RESET_WHATSAPP_SESSION).toLowerCase() === 'true';
  form.ADVISOR_WHATSAPP_NUMBER.value = config.ADVISOR_WHATSAPP_NUMBER || '';
  form.GROUP_INVITE_URL.value = config.GROUP_INVITE_URL || '';
  form.BOT_NAME.value = config.BOT_NAME || '';
}

$('#configForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const payload = {
    TEST_MODE_SELF_CHAT: form.TEST_MODE_SELF_CHAT.checked ? 'true' : 'false',
    RESET_WHATSAPP_SESSION: form.RESET_WHATSAPP_SESSION.checked ? 'true' : 'false',
    ADVISOR_WHATSAPP_NUMBER: form.ADVISOR_WHATSAPP_NUMBER.value.trim(),
    GROUP_INVITE_URL: form.GROUP_INVITE_URL.value.trim(),
    BOT_NAME: form.BOT_NAME.value.trim()
  };
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (res.ok) {
    const saved = $('#configSaved');
    saved.hidden = false;
    setTimeout(() => { saved.hidden = true; }, 4000);
  }
});

// ---------- arranque ----------
async function refreshAll() {
  await refreshStatus();
  await refreshLogs();
  await refreshConversations();
  await refreshPaused();
  await refreshContacts();
  await refreshEscalations();
}

loadConfig();
loadScheduleDates();
loadBookings();
refreshAll();
setInterval(refreshStatus, 4000);
setInterval(refreshLogs, 2500);
setInterval(refreshConversations, 15000);
setInterval(refreshPaused, 15000);
setInterval(refreshContacts, 20000);
setInterval(refreshEscalations, 20000);
setInterval(loadBookings, 20000);

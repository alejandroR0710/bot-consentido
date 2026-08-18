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
    `;
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
    `;
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
    `;
    tbody.appendChild(tr);
  });
}

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
    `;
    const chipList = block.querySelector('.date-chip-list');
    const input = block.querySelector('input');
    const addBtn = block.querySelector('button');
    const savedLabel = block.querySelector('.workshop-saved');

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
  await refreshPaused();
  await refreshContacts();
  await refreshEscalations();
}

loadConfig();
loadScheduleDates();
refreshAll();
setInterval(refreshStatus, 4000);
setInterval(refreshLogs, 2500);
setInterval(refreshPaused, 15000);
setInterval(refreshContacts, 20000);
setInterval(refreshEscalations, 20000);

let state = {
  authed: false,
  admin: false,
  family: null,
  currentMeetingId: null,
  currentMeeting: null,
  meetings: [],
  adminMeetings: [],
  adminFamilies: [],
  events: [],
  families: [],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Fehler');
    err.code = data.code;
    throw err;
  }
  return data;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function formatDateLong(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
}

function mapsLink(address) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address);
}

const STATUS_LABELS = { active: 'Aktiv', inactive: 'Inaktiv', past: 'Vorbei' };

// ===== Datumsfelder: Anzeige/Eingabe immer TT.MM.JJJJ, Speicherung als ISO (YYYY-MM-DD) =====
function parseDisplayDate(str) {
  if (!str || !str.trim()) return '';
  const m = str.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${mo}-${d}`;
}

function readDateField(id, fieldLabel) {
  const raw = $(id).value;
  const iso = parseDisplayDate(raw);
  if (iso === null) throw new Error(`Ungültiges Datum bei "${fieldLabel}" – bitte TT.MM.JJJJ verwenden`);
  return iso;
}

function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Sofortiges Feedback im Browser, Server validiert dieselben Regeln nochmal
// verbindlich: An-/Abreise max. 7 Tage vor/nach dem Treffen.
function readStayDateField(id, fieldLabel) {
  const iso = readDateField(id, fieldLabel);
  if (!iso || !state.currentMeeting) return iso;
  const min = addDays(state.currentMeeting.startDate, -7);
  const max = addDays(state.currentMeeting.endDate, 7);
  if (iso < min || iso > max) {
    throw new Error(`${fieldLabel} muss zwischen ${formatDate(min)} und ${formatDate(max)} liegen (max. 7 Tage vor/nach dem Treffen)`);
  }
  return iso;
}

// Anreise darf nicht nach der Abreise liegen (Gleichstand = ein Tag = erlaubt).
function checkStayOrder(arrivalIso, departureIso) {
  if (arrivalIso && departureIso && arrivalIso > departureIso) {
    throw new Error('Anreise muss vor oder gleich der Abreise liegen');
  }
}

// Events muessen immer im Zeitraum des Treffens liegen.
function readEventDateField(id, fieldLabel) {
  const iso = readDateField(id, fieldLabel);
  if (state.currentMeeting && (iso < state.currentMeeting.startDate || iso > state.currentMeeting.endDate)) {
    throw new Error(`${fieldLabel} muss zwischen ${formatDate(state.currentMeeting.startDate)} und ${formatDate(state.currentMeeting.endDate)} liegen (Zeitraum des Treffens)`);
  }
  return iso;
}

function attachDateMask(input) {
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, 8);
    let out = digits;
    if (digits.length > 4) out = `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
    else if (digits.length > 2) out = `${digits.slice(0, 2)}.${digits.slice(2)}`;
    input.value = out;
  });
}

// Ergaenzt einen Kalender-Button neben dem maskierten TT.MM.JJJJ-Textfeld.
// Nutzt einen unsichtbaren nativen type="date"-Picker nur zur Auswahl, damit
// die Anzeige weiterhin immer TT.MM.JJJJ bleibt (unabhaengig von OS/Browser-Locale).
function attachDatePicker(input) {
  const wrap = document.createElement('span');
  wrap.className = 'date-input-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  input.classList.add('has-date-picker');

  const hidden = document.createElement('input');
  hidden.type = 'date';
  hidden.className = 'date-picker-hidden';
  hidden.tabIndex = -1;
  wrap.appendChild(hidden);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'date-picker-btn';
  btn.setAttribute('aria-label', 'Kalender öffnen');
  btn.textContent = '📅';
  wrap.appendChild(btn);

  btn.addEventListener('click', () => {
    const iso = parseDisplayDate(input.value);
    hidden.value = iso || '';
    if (hidden.showPicker) {
      hidden.showPicker();
    } else {
      hidden.focus();
      hidden.click();
    }
  });

  hidden.addEventListener('change', () => {
    if (hidden.value) {
      input.value = formatDate(hidden.value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

[
  '#my-arrival', '#my-departure', '#meeting-start', '#meeting-end', '#event-date',
  '#participant-arrival', '#participant-departure', '#meeting-filter-from', '#meeting-filter-to',
  '#signup-arrival', '#signup-departure'
].forEach(sel => {
  attachDateMask($(sel));
  attachDatePicker($(sel));
});

// ===== Uhrzeit: immer 24h-Format (HH:MM), unabhaengig von OS/Browser-Locale =====
function parseDisplayTime(str) {
  if (!str || !str.trim()) return '';
  const m = str.trim().match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, h, mi] = m;
  if (h > 23 || mi > 59) return null;
  return `${h}:${mi}`;
}

function readTimeField(id, fieldLabel) {
  const iso = parseDisplayTime($(id).value);
  if (iso === null) throw new Error(`Ungültige Uhrzeit bei "${fieldLabel}" – bitte HH:MM (24h) verwenden`);
  return iso;
}

function attachTimeMask(input) {
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, 4);
    let out = digits;
    if (digits.length > 2) out = `${digits.slice(0, 2)}:${digits.slice(2)}`;
    input.value = out;
  });
}

// Analog zu attachDatePicker, aber fuer Uhrzeiten: der native type="time"-Picker
// liefert seinen Wert immer als 24h "HH:MM", unabhaengig davon wie er selbst
// angezeigt wird - genau das landet unveraendert im sichtbaren Textfeld.
function attachTimePicker(input) {
  const wrap = document.createElement('span');
  wrap.className = 'date-input-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  input.classList.add('has-date-picker');

  const hidden = document.createElement('input');
  hidden.type = 'time';
  hidden.className = 'date-picker-hidden';
  hidden.tabIndex = -1;
  wrap.appendChild(hidden);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'date-picker-btn';
  btn.setAttribute('aria-label', 'Uhrzeit wählen');
  btn.textContent = '🕒';
  wrap.appendChild(btn);

  btn.addEventListener('click', () => {
    hidden.value = parseDisplayTime(input.value) || '';
    if (hidden.showPicker) {
      hidden.showPicker();
    } else {
      hidden.focus();
      hidden.click();
    }
  });

  hidden.addEventListener('change', () => {
    if (hidden.value) {
      input.value = hidden.value.slice(0, 5);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

attachTimeMask($('#event-time'));
attachTimePicker($('#event-time'));

// ===== Auth =====
async function checkAuth() {
  const me = await api('/me');
  state.authed = me.authed;
  state.admin = me.admin;
  state.family = me.family;
  state.currentMeetingId = me.currentMeeting ? me.currentMeeting.id : null;
  state.currentMeeting = me.currentMeeting;
  render();
}

// ----- Login-Tabs (Registrieren / Account) -----
$$('.login-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.login-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    const tab = btn.dataset.loginTab;
    $('#register-form').classList.toggle('hidden', tab !== 'register');
    $('#account-login-form').classList.toggle('hidden', tab !== 'account');
  });
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('#register-token').value;
  const name = $('#register-name').value;
  const username = $('#register-username').value;
  const password = $('#register-password').value;
  const confirm = $('#register-password-confirm').value;
  $('#register-error').textContent = '';
  if (password !== confirm) {
    $('#register-error').textContent = 'Passwörter stimmen nicht überein';
    return;
  }
  try {
    await api('/register', { method: 'POST', body: JSON.stringify({ token, name, username, password }) });
    await checkAuth();
  } catch (err) {
    $('#register-error').textContent = err.message;
  }
});

$('#account-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#account-login-username').value;
  const password = $('#account-login-password').value;
  $('#account-login-error').textContent = '';
  try {
    await api('/login-account', { method: 'POST', body: JSON.stringify({ username, password }) });
    await checkAuth();
  } catch (err) {
    $('#account-login-error').textContent = err.message;
  }
});

$('#show-admin-login').addEventListener('click', () => {
  $('#admin-login-form').classList.toggle('hidden');
});

$('#admin-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#admin-code').value;
  $('#admin-login-error').textContent = '';
  try {
    await api('/admin-login', { method: 'POST', body: JSON.stringify({ code }) });
    await checkAuth();
  } catch (err) {
    $('#admin-login-error').textContent = err.message;
  }
});

async function doLogout() {
  await api('/logout', { method: 'POST' });
  state = { authed: false, admin: false, family: null, currentMeetingId: null, currentMeeting: null, meetings: [], adminMeetings: [], adminFamilies: [], events: [], families: [] };
  render();
}

$('#logout-btn').addEventListener('click', doLogout);
$('#picker-logout-btn').addEventListener('click', doLogout);

// Admin-Einstieg ohne ausgewaehltes Treffen (z. B. um das allererste Treffen
// anzulegen, wenn noch keins existiert - die normale Treffen-Auswahl waere
// sonst eine Sackgasse: es gibt ja noch nichts zum Auswaehlen).
function showAdminHome() {
  hideAllViews();
  $('#main-view').classList.remove('hidden');
  $('#whoami').textContent = 'Admin';
  $('#admin-tab-btn').classList.remove('hidden');
  $('#add-event-btn').classList.add('hidden');
  $('#switch-meeting-btn').classList.remove('hidden');
  $('#switch-meeting-btn').textContent = 'Treffen wählen';
  $('#topbar-title').textContent = 'Familienfest-Planer';
  $('#meeting-range-sub').textContent = '';
  $('#meeting-location-sub').textContent = '';
  switchTab('admin');
}

$('#picker-admin-btn').addEventListener('click', showAdminHome);

$('#switch-meeting-btn').addEventListener('click', () => {
  state.currentMeetingId = null;
  state.currentMeeting = null;
  render();
});

$('#signup-back-btn').addEventListener('click', () => {
  state.currentMeetingId = null;
  state.currentMeeting = null;
  render();
});

$('#meeting-signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  let arrivalDate, departureDate;
  try {
    arrivalDate = readStayDateField('#signup-arrival', 'Anreise');
    departureDate = readStayDateField('#signup-departure', 'Abreise');
    checkStayOrder(arrivalDate, departureDate);
  } catch (err) {
    $('#meeting-signup-error').textContent = err.message;
    return;
  }
  const size = $('#signup-size').value;
  try {
    await api('/my-family', { method: 'PUT', body: JSON.stringify({ size, arrivalDate, departureDate }) });
    await checkAuth();
  } catch (err) {
    $('#meeting-signup-error').textContent = err.message;
  }
});

// ===== Tabs =====
$$('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-panel').forEach(p => p.classList.add('hidden'));
  $('#tab-' + tab).classList.remove('hidden');
  if (tab === 'families') loadFamiliesTab();
  if (tab === 'admin') loadAdminTab();
}

// ===== Root render =====
function hideAllViews() {
  $('#login-view').classList.add('hidden');
  $('#meeting-picker-view').classList.add('hidden');
  $('#meeting-signup-view').classList.add('hidden');
  $('#main-view').classList.add('hidden');
}

function render() {
  if (!(state.authed || state.admin)) {
    hideAllViews();
    $('#login-view').classList.remove('hidden');
    return;
  }

  if (!state.currentMeetingId) {
    hideAllViews();
    $('#meeting-picker-view').classList.remove('hidden');
    loadMeetingPicker();
    return;
  }

  // Familie (nicht Admin) muss zuerst An-/Abreise fuer dieses Treffen angeben,
  // bevor sie sich fuer einzelne Events eintragen kann.
  if (!state.admin && state.currentMeeting.needsSignup) {
    hideAllViews();
    $('#meeting-signup-view').classList.remove('hidden');
    $('#signup-meeting-title').textContent = 'Meldet euch für „' + state.currentMeeting.title + '“ an';
    $('#meeting-signup-form').reset();
    $('#signup-arrival').value = formatDate(state.currentMeeting.startDate);
    $('#signup-departure').value = formatDate(state.currentMeeting.endDate);
    $('#meeting-signup-error').textContent = '';
    return;
  }

  hideAllViews();
  $('#main-view').classList.remove('hidden');

  if (state.family) {
    $('#whoami').textContent = state.family.name + (state.admin ? ' · Admin' : '');
  } else if (state.admin) {
    $('#whoami').textContent = 'Admin';
  }

  if (state.admin) {
    $('#admin-tab-btn').classList.remove('hidden');
    $('#add-event-btn').classList.remove('hidden');
  }

  $('#topbar-title').textContent = state.currentMeeting.title || 'Familientreffen';
  $('#switch-meeting-btn').textContent = 'Treffen: ' + state.currentMeeting.title;
  $('#meeting-range-sub').textContent = state.currentMeeting.startDate && state.currentMeeting.endDate
    ? `${formatDateLong(state.currentMeeting.startDate)} bis ${formatDateLong(state.currentMeeting.endDate)}`
    : 'Termin steht noch nicht fest.';
  $('#meeting-location-sub').innerHTML = state.currentMeeting.location
    ? `<a href="${mapsLink(state.currentMeeting.location)}" target="_blank" rel="noopener">📍 ${escapeHtml(state.currentMeeting.location)}</a>`
    : '';

  loadEvents();
  loadFamilies();
}

// ===== Meeting picker =====
async function loadMeetingPicker() {
  $('#picker-admin-btn').classList.toggle('hidden', !state.admin);
  state.meetings = await api('/meetings');
  const list = $('#meeting-pick-list');
  list.innerHTML = '';
  if (state.meetings.length === 0) {
    $('#meeting-pick-empty').classList.remove('hidden');
    return;
  }
  $('#meeting-pick-empty').classList.add('hidden');
  state.meetings.forEach(m => {
    const row = document.createElement('div');
    row.className = 'family-row meeting-pick-card';
    row.innerHTML = `
      <div>
        <div class="family-row-name">${escapeHtml(m.title)}</div>
        <div class="family-row-size">${formatDateLong(m.startDate)} bis ${formatDateLong(m.endDate)}</div>
        ${m.location ? `<div class="family-row-size">📍 ${escapeHtml(m.location)}</div>` : ''}
      </div>
      ${state.admin ? `<span class="status-badge ${m.status}">${STATUS_LABELS[m.status]}</span>` : ''}
    `;
    row.addEventListener('click', async () => {
      const meeting = await api('/select-meeting', { method: 'POST', body: JSON.stringify({ meetingId: m.id }) });
      state.currentMeetingId = meeting.id;
      state.currentMeeting = meeting;
      render();
    });
    list.appendChild(row);
  });
}

// ===== Events tab =====
async function loadEvents() {
  try {
    state.events = await api('/events');
    renderEvents();
  } catch (err) {
    handleMeetingError(err);
  }
}

function handleMeetingError(err) {
  if (err.code === 'NO_MEETING_SELECTED') {
    state.currentMeetingId = null;
    state.currentMeeting = null;
    render();
  } else {
    alert(err.message);
  }
}

function renderEvents() {
  const list = $('#events-list');
  list.innerHTML = '';

  if (state.events.length === 0) {
    $('#events-empty').classList.remove('hidden');
    return;
  }
  $('#events-empty').classList.add('hidden');

  const sorted = [...state.events].sort((a, b) => {
    const da = a.date + (a.time || '00:00');
    const db = b.date + (b.time || '00:00');
    return da.localeCompare(db);
  });

  sorted.forEach(ev => list.appendChild(renderEventCard(ev)));
}

function formatRegistration(r) {
  let str = `${r.adults} Erw.`;
  if (r.children) str += ` + ${r.children} Kind${r.children === 1 ? '' : 'er'}`;
  return str;
}

function renderEventCard(ev) {
  const card = document.createElement('div');
  card.className = 'event-card';

  const dateTimeStr = ev.time
    ? `${formatDateLong(ev.date)} · ${ev.time} Uhr`
    : formatDateLong(ev.date);

  const totalPeople = ev.registrations.reduce((sum, r) => sum + r.adults + r.children, 0);
  const myReg = state.family ? ev.registrations.find(r => r.familyId === state.family.id) : null;

  card.innerHTML = `
    <div class="event-top">
      <div>
        <div class="event-datetime">${dateTimeStr}</div>
        <div class="event-title">${escapeHtml(ev.title)}</div>
        ${ev.location ? `<div class="event-location"><a href="${mapsLink(ev.location)}" target="_blank" rel="noopener">📍 ${escapeHtml(ev.location)}</a></div>` : ''}
      </div>
      ${state.admin ? `<button class="event-edit-btn" data-id="${ev.id}">Bearbeiten</button>` : ''}
    </div>
    ${ev.description ? `<div class="event-description">${escapeHtml(ev.description)}</div>` : ''}
    <div class="event-bottom">
      <div class="registrations-header">
        <strong style="font-size:13px; color:#8a7d68;">Angemeldet</strong>
        <span class="registrations-total">${totalPeople} ${totalPeople === 1 ? 'Person' : 'Personen'}</span>
      </div>
      <div class="registrations-list">
        ${ev.registrations.length === 0
          ? '<span class="no-registrations">Noch niemand angemeldet</span>'
          : ev.registrations.map(r => `
              <span class="reg-chip ${state.family && r.familyId === state.family.id ? 'me' : ''}">
                ${escapeHtml(r.familyName)} · ${formatRegistration(r)}
              </span>`).join('')}
      </div>
      ${state.family ? `
        <button class="register-btn ${myReg ? 'registered' : ''}" data-id="${ev.id}">
          ${myReg ? `Angemeldet (${formatRegistration(myReg)}) — ändern` : 'Anmelden'}
        </button>` : ''}
    </div>
  `;

  const regBtn = card.querySelector('.register-btn');
  if (regBtn) regBtn.addEventListener('click', () => openRegisterModal(ev, myReg));

  if (state.admin) {
    card.querySelector('.event-edit-btn').addEventListener('click', () => openEventModal(ev));
  }

  return card;
}

// ===== Register modal =====
const registerModal = $('#register-modal');

function openRegisterModal(ev, myReg) {
  $('#register-event-id').value = ev.id;
  $('#register-event-title').textContent = ev.title;
  const mine = state.families.find(f => f.id === state.family.id);
  $('#register-adults').value = myReg ? myReg.adults : (mine ? mine.size : 1);
  $('#register-children').value = myReg ? myReg.children : 0;
  $('#register-error').textContent = '';
  $('#unregister-btn').classList.toggle('hidden', !myReg);
  registerModal.classList.remove('hidden');
  $('#register-adults').focus();
}

$('#cancel-register-btn').addEventListener('click', () => registerModal.classList.add('hidden'));

$('#event-register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#register-event-id').value;
  const adults = $('#register-adults').value;
  const children = $('#register-children').value;
  $('#register-error').textContent = '';
  try {
    await api(`/events/${id}/register`, { method: 'POST', body: JSON.stringify({ adults, children }) });
    registerModal.classList.add('hidden');
    await loadEvents();
  } catch (err) {
    $('#register-error').textContent = err.message;
  }
});

$('#unregister-btn').addEventListener('click', async () => {
  const id = $('#register-event-id').value;
  try {
    await api(`/events/${id}/unregister`, { method: 'POST' });
    registerModal.classList.add('hidden');
    await loadEvents();
  } catch (err) {
    $('#register-error').textContent = err.message;
  }
});

// ===== Event modal (admin) =====
const eventModal = $('#event-modal');

$('#add-event-btn').addEventListener('click', () => openEventModal(null));
$('#cancel-event-modal-btn').addEventListener('click', () => eventModal.classList.add('hidden'));

function openEventModal(ev) {
  $('#event-error').textContent = '';
  $('#event-form').reset();
  if (ev) {
    $('#event-modal-title').textContent = 'Programmpunkt bearbeiten';
    $('#event-id').value = ev.id;
    $('#event-title').value = ev.title;
    $('#event-date').value = formatDate(ev.date);
    $('#event-time').value = ev.time || '';
    $('#event-location').value = ev.location || '';
    $('#event-description').value = ev.description || '';
    $('#delete-event-btn').classList.remove('hidden');
  } else {
    $('#event-modal-title').textContent = 'Neuer Programmpunkt';
    $('#event-id').value = '';
    if (state.currentMeeting && state.currentMeeting.startDate) $('#event-date').value = formatDate(state.currentMeeting.startDate);
    $('#delete-event-btn').classList.add('hidden');
  }
  eventModal.classList.remove('hidden');
}

$('#event-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#event-id').value;
  $('#event-error').textContent = '';
  let datePayload, timePayload;
  try {
    datePayload = readEventDateField('#event-date', 'Datum');
    timePayload = readTimeField('#event-time', 'Uhrzeit');
  } catch (err) {
    $('#event-error').textContent = err.message;
    return;
  }
  const payload = {
    title: $('#event-title').value,
    date: datePayload,
    time: timePayload,
    location: $('#event-location').value,
    description: $('#event-description').value,
  };
  try {
    if (id) {
      await api(`/events/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/events', { method: 'POST', body: JSON.stringify(payload) });
    }
    eventModal.classList.add('hidden');
    await loadEvents();
  } catch (err) {
    $('#event-error').textContent = err.message;
  }
});

$('#delete-event-btn').addEventListener('click', async () => {
  const id = $('#event-id').value;
  if (!confirm('Diesen Programmpunkt wirklich löschen?')) return;
  try {
    await api(`/events/${id}`, { method: 'DELETE' });
    eventModal.classList.add('hidden');
    await loadEvents();
  } catch (err) {
    $('#event-error').textContent = err.message;
  }
});

// ===== Families tab =====
async function loadFamilies() {
  try {
    state.families = await api('/families');
    renderFamiliesTab();
    if (state.family) {
      $('#my-family-card').classList.remove('hidden');
      const mine = state.families.find(f => f.id === state.family.id);
      $('#my-size').value = mine ? mine.size : '';
      $('#my-arrival').value = formatDate(mine && mine.arrivalDate ? mine.arrivalDate : state.currentMeeting.startDate);
      $('#my-departure').value = formatDate(mine && mine.departureDate ? mine.departureDate : state.currentMeeting.endDate);
    }
  } catch (err) {
    handleMeetingError(err);
  }
}

async function loadFamiliesTab() {
  await loadFamilies();
}

function renderFamiliesTab() {
  const list = $('#families-list');
  list.innerHTML = '';

  if (state.families.length === 0) {
    $('#families-empty').classList.remove('hidden');
    return;
  }
  $('#families-empty').classList.add('hidden');

  const sorted = [...state.families].sort((a, b) => {
    if (!a.arrivalDate) return 1;
    if (!b.arrivalDate) return -1;
    return a.arrivalDate.localeCompare(b.arrivalDate);
  });

  sorted.forEach(f => {
    const row = document.createElement('div');
    row.className = 'family-row';
    const dates = (f.arrivalDate || f.departureDate)
      ? `${f.arrivalDate ? formatDate(f.arrivalDate) : '?'} → ${f.departureDate ? formatDate(f.departureDate) : '?'}`
      : '<span class="no-dates">Termin noch offen</span>';
    row.innerHTML = `
      <div>
        <div class="family-row-name">${escapeHtml(f.name)}</div>
        <div class="family-row-size">${f.size} ${f.size === 1 ? 'Person' : 'Personen'}</div>
      </div>
      <div class="family-row-dates">${dates}</div>
      ${state.admin ? `<button class="event-edit-btn" data-id="${f.id}">Bearbeiten</button>` : ''}
    `;
    if (state.admin) {
      row.querySelector('.event-edit-btn').addEventListener('click', () => openParticipantModal(f));
    }
    list.appendChild(row);
  });
}

$('#my-family-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  let arrivalDate, departureDate;
  try {
    arrivalDate = readStayDateField('#my-arrival', 'Anreise');
    departureDate = readStayDateField('#my-departure', 'Abreise');
    checkStayOrder(arrivalDate, departureDate);
  } catch (err) {
    alert(err.message);
    return;
  }
  const size = $('#my-size').value;
  try {
    await api('/my-family', { method: 'PUT', body: JSON.stringify({ size, arrivalDate, departureDate }) });
    $('#my-family-saved').classList.remove('hidden');
    setTimeout(() => $('#my-family-saved').classList.add('hidden'), 2000);
    await loadFamilies();
  } catch (err) {
    alert(err.message);
  }
});

// ===== Participant modal (admin) =====
const participantModal = $('#participant-modal');

function openParticipantModal(f) {
  $('#participant-error').textContent = '';
  $('#participant-family-id').value = f.id;
  $('#participant-modal-title').textContent = escapeHtml(f.name) + ' bearbeiten';
  $('#participant-size').value = f.size || 1;
  $('#participant-arrival').value = formatDate(f.arrivalDate || state.currentMeeting.startDate);
  $('#participant-departure').value = formatDate(f.departureDate || state.currentMeeting.endDate);
  participantModal.classList.remove('hidden');
}

$('#cancel-participant-modal-btn').addEventListener('click', () => participantModal.classList.add('hidden'));

$('#participant-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const familyId = $('#participant-family-id').value;
  let arrivalDate, departureDate;
  try {
    arrivalDate = readStayDateField('#participant-arrival', 'Anreise');
    departureDate = readStayDateField('#participant-departure', 'Abreise');
    checkStayOrder(arrivalDate, departureDate);
  } catch (err) {
    $('#participant-error').textContent = err.message;
    return;
  }
  const size = $('#participant-size').value;
  try {
    await api(`/admin/participants/${familyId}`, { method: 'PUT', body: JSON.stringify({ size, arrivalDate, departureDate }) });
    participantModal.classList.add('hidden');
    await loadFamilies();
  } catch (err) {
    $('#participant-error').textContent = err.message;
  }
});

// ===== Admin tab =====
async function loadAdminTab() {
  const settings = await api('/admin/settings');
  $('#settings-admin-code').value = settings.adminCode;
  $('#settings-family-token').value = settings.familyToken;
  state.adminMeetings = await api('/admin/meetings');
  renderAdminMeetings();
  state.adminFamilies = await api('/admin/families');
  renderAdminFamilies();
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#settings-error').textContent = '';
  const adminCode = $('#settings-admin-code').value;
  const familyToken = $('#settings-family-token').value;
  try {
    await api('/admin/settings', { method: 'PUT', body: JSON.stringify({ adminCode, familyToken }) });
    $('#settings-saved').classList.remove('hidden');
    setTimeout(() => $('#settings-saved').classList.add('hidden'), 2000);
  } catch (err) {
    $('#settings-error').textContent = err.message;
  }
});

// ----- Meeting management -----
function getMeetingFilterRange() {
  const from = parseDisplayDate($('#meeting-filter-from').value);
  const to = parseDisplayDate($('#meeting-filter-to').value);
  return { from: from || '', to: to || '' };
}

['#meeting-filter-from', '#meeting-filter-to'].forEach(sel => {
  $(sel).addEventListener('input', renderAdminMeetings);
});

$('#meeting-filter-clear').addEventListener('click', () => {
  $('#meeting-filter-from').value = '';
  $('#meeting-filter-to').value = '';
  renderAdminMeetings();
});

function renderAdminMeetings() {
  const list = $('#admin-meetings-list');
  list.innerHTML = '';
  const { from, to } = getMeetingFilterRange();
  const filtered = [...state.adminMeetings]
    .filter(m => (!from || m.startDate >= from) && (!to || m.startDate <= to))
    .sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''));

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state"><p>Keine Treffen gefunden.</p></div>';
    return;
  }

  filtered.forEach(m => {
    const row = document.createElement('div');
    row.className = 'admin-meeting-row';
    row.innerHTML = `
      <div class="admin-family-info">
        <span class="admin-family-name">${escapeHtml(m.title)}</span>
        <span class="admin-family-meta">${formatDate(m.startDate)} → ${formatDate(m.endDate)} · ${m.participantCount} Familien · ${m.eventCount} Programmpunkte</span>
        ${m.location ? `<span class="admin-family-meta">📍 ${escapeHtml(m.location)}</span>` : ''}
      </div>
      <span class="status-badge ${m.status}">${STATUS_LABELS[m.status]}</span>
      <div class="admin-family-actions">
        <button data-action="edit">Bearbeiten</button>
        <button data-action="delete">Löschen</button>
      </div>
    `;
    row.querySelector('[data-action="edit"]').addEventListener('click', () => openMeetingModal(m));
    row.querySelector('[data-action="delete"]').addEventListener('click', () => deleteMeeting(m));
    list.appendChild(row);
  });
}

const meetingModal = $('#meeting-modal');

$('#add-meeting-btn').addEventListener('click', () => openMeetingModal(null));
$('#cancel-meeting-modal-btn').addEventListener('click', () => meetingModal.classList.add('hidden'));

function openMeetingModal(m) {
  $('#meeting-error').textContent = '';
  $('#meeting-form').reset();
  if (m) {
    $('#meeting-modal-title').textContent = 'Treffen bearbeiten';
    $('#meeting-id').value = m.id;
    $('#meeting-title-input').value = m.title;
    $('#meeting-start').value = formatDate(m.startDate);
    $('#meeting-end').value = formatDate(m.endDate);
    $('#meeting-location').value = m.location || '';
    $('#meeting-status-input').value = m.manualStatus;
    $('#meeting-status-field').classList.toggle('hidden', m.status === 'past');
    $('#delete-meeting-btn').classList.remove('hidden');
  } else {
    $('#meeting-modal-title').textContent = 'Neues Treffen';
    $('#meeting-id').value = '';
    $('#meeting-status-input').value = 'active';
    $('#meeting-status-field').classList.remove('hidden');
    $('#delete-meeting-btn').classList.add('hidden');
  }
  meetingModal.classList.remove('hidden');
}

$('#meeting-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#meeting-error').textContent = '';
  const id = $('#meeting-id').value;
  let startDate, endDate;
  try {
    startDate = readDateField('#meeting-start', 'Start');
    endDate = readDateField('#meeting-end', 'Ende');
    if (startDate > endDate) {
      throw new Error('Startdatum muss vor oder gleich dem Enddatum liegen');
    }
  } catch (err) {
    $('#meeting-error').textContent = err.message;
    return;
  }
  const payload = {
    title: $('#meeting-title-input').value,
    startDate,
    endDate,
    location: $('#meeting-location').value,
    manualStatus: $('#meeting-status-input').value,
  };
  try {
    if (id) {
      await api(`/admin/meetings/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/admin/meetings', { method: 'POST', body: JSON.stringify(payload) });
    }
    meetingModal.classList.add('hidden');
    await loadAdminTab();
  } catch (err) {
    $('#meeting-error').textContent = err.message;
  }
});

$('#delete-meeting-btn').addEventListener('click', async () => {
  const id = $('#meeting-id').value;
  if (!confirm('Dieses Treffen wirklich löschen? Alle Programmpunkte und Anmeldungen darin gehen verloren.')) return;
  try {
    await api(`/admin/meetings/${id}`, { method: 'DELETE' });
    meetingModal.classList.add('hidden');
    await loadAdminTab();
  } catch (err) {
    $('#meeting-error').textContent = err.message;
  }
});

async function deleteMeeting(m) {
  if (!confirm(`Treffen "${m.title}" wirklich löschen? Alle Programmpunkte und Anmeldungen darin gehen verloren.`)) return;
  try {
    await api(`/admin/meetings/${m.id}`, { method: 'DELETE' });
    await loadAdminTab();
  } catch (err) {
    alert(err.message);
  }
}

// ----- Familien (global) -----
function renderAdminFamilies() {
  const list = $('#admin-families-list');
  list.innerHTML = '';
  if (state.adminFamilies.length === 0) {
    list.innerHTML = '<div class="empty-state"><p>Noch keine Familien registriert.</p></div>';
    return;
  }
  state.adminFamilies.forEach(f => {
    const row = document.createElement('div');
    row.className = 'admin-family-row';
    const accountInfo = f.account
      ? `Account: <strong>${escapeHtml(f.account.username)}</strong>`
      : '<span class="no-dates">Kein Account</span>';
    row.innerHTML = `
      <div class="admin-family-info">
        <span class="admin-family-name">${escapeHtml(f.name)}</span>
        <span class="admin-family-meta">${accountInfo}</span>
      </div>
      <div class="admin-family-actions">
        <button data-action="set-password">Passwort setzen</button>
        <button data-action="delete">Löschen</button>
      </div>
    `;
    row.querySelector('[data-action="set-password"]').addEventListener('click', () => openSetPasswordModal(f));
    row.querySelector('[data-action="delete"]').addEventListener('click', () => deleteFamily(f));
    list.appendChild(row);
  });
}

async function deleteFamily(f) {
  if (!confirm(`Familie "${f.name}" wirklich löschen? Alle Anmeldungen dieser Familie in allen Treffen werden ebenfalls entfernt.`)) return;
  try {
    await api(`/admin/families/${f.id}`, { method: 'DELETE' });
    await loadAdminTab();
  } catch (err) {
    alert(err.message);
  }
}

const setPasswordModal = $('#set-password-modal');

function openSetPasswordModal(f) {
  $('#set-password-error').textContent = '';
  $('#set-password-form').reset();
  $('#set-password-family-id').value = f.id;
  setPasswordModal.classList.remove('hidden');
}

$('#cancel-set-password-modal-btn').addEventListener('click', () => setPasswordModal.classList.add('hidden'));

$('#set-password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#set-password-family-id').value;
  const password = $('#set-password-value').value;
  $('#set-password-error').textContent = '';
  try {
    await api(`/admin/families/${id}/set-password`, { method: 'POST', body: JSON.stringify({ password }) });
    setPasswordModal.classList.add('hidden');
  } catch (err) {
    $('#set-password-error').textContent = err.message;
  }
});

// ===== Init =====
checkAuth();

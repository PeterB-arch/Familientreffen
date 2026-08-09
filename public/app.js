let state = {
  authed: false,
  admin: false,
  family: null,
  meeting: null,
  events: [],
  families: [],
  pendingSetup: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Fehler');
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

function attachDateMask(input) {
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, 8);
    let out = digits;
    if (digits.length > 4) out = `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
    else if (digits.length > 2) out = `${digits.slice(0, 2)}.${digits.slice(2)}`;
    input.value = out;
  });
}

['#my-arrival', '#my-departure', '#meeting-start', '#meeting-end', '#event-date', '#family-arrival', '#family-departure']
  .forEach(sel => attachDateMask($(sel)));

// ===== Meeting title on login screen (public, no auth needed) =====
async function loadPublicMeeting() {
  try {
    const meeting = await api('/meeting');
    if (meeting.title) $('#login-meeting-title').textContent = meeting.title;
    if (meeting.startDate && meeting.endDate) {
      $('#login-meeting-dates').textContent =
        `${formatDate(meeting.startDate)} – ${formatDate(meeting.endDate)}`;
    } else {
      $('#login-meeting-dates').textContent = 'Alle Termine an einem Ort.';
    }
  } catch (e) { /* egal, Default bleibt stehen */ }
}

// ===== Auth =====
async function checkAuth() {
  const me = await api('/me');
  state.authed = me.authed;
  state.admin = me.admin;
  state.family = me.family;
  state.pendingSetup = !!me.pendingSetup;
  render();
}

// ----- Login-Tabs (Token / Account) -----
$$('.login-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.login-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    const tab = btn.dataset.loginTab;
    $('#login-form').classList.toggle('hidden', tab !== 'token');
    $('#account-login-form').classList.toggle('hidden', tab !== 'account');
  });
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('#login-code').value;
  $('#login-error').textContent = '';
  try {
    const result = await api('/login', { method: 'POST', body: JSON.stringify({ token }) });
    if (result.needsSetup) {
      state.pendingSetup = true;
      render();
    } else {
      await checkAuth();
    }
  } catch (err) {
    $('#login-error').textContent = err.message;
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

$('#account-setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#setup-username').value;
  const password = $('#setup-password').value;
  const confirm = $('#setup-password-confirm').value;
  $('#account-setup-error').textContent = '';
  if (password !== confirm) {
    $('#account-setup-error').textContent = 'Passwörter stimmen nicht überein';
    return;
  }
  try {
    await api('/create-account', { method: 'POST', body: JSON.stringify({ username, password }) });
    await checkAuth();
  } catch (err) {
    $('#account-setup-error').textContent = err.message;
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

$('#logout-btn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  state = { authed: false, admin: false, family: null, meeting: null, events: [], families: [], pendingSetup: false };
  render();
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
function render() {
  if (state.authed || state.admin) {
    $('#login-view').classList.add('hidden');
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

    loadMeeting();
    loadEvents();
  } else {
    $('#login-view').classList.remove('hidden');
    $('#main-view').classList.add('hidden');
    $('#login-step').classList.toggle('hidden', state.pendingSetup);
    $('#account-setup-form').classList.toggle('hidden', !state.pendingSetup);
    loadPublicMeeting();
  }
}

async function loadMeeting() {
  state.meeting = await api('/meeting');
  $('#topbar-title').textContent = state.meeting.title || 'Familientreffen';
  if (state.meeting.startDate && state.meeting.endDate) {
    $('#meeting-range-sub').textContent =
      `${formatDateLong(state.meeting.startDate)} bis ${formatDateLong(state.meeting.endDate)}`;
  } else {
    $('#meeting-range-sub').textContent = 'Termin steht noch nicht fest.';
  }
}

// ===== Events tab =====
async function loadEvents() {
  state.events = await api('/events');
  renderEvents();
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

function renderEventCard(ev) {
  const card = document.createElement('div');
  card.className = 'event-card';

  const dateTimeStr = ev.time
    ? `${formatDateLong(ev.date)} · ${ev.time} Uhr`
    : formatDateLong(ev.date);

  const totalPeople = ev.registrations.reduce((sum, r) => sum + r.count, 0);
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
                ${escapeHtml(r.familyName)} · ${r.count}
              </span>`).join('')}
      </div>
      ${state.family ? `
        <button class="register-btn ${myReg ? 'registered' : ''}" data-id="${ev.id}">
          ${myReg ? `Angemeldet (${myReg.count}) — ändern` : 'Anmelden'}
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
  $('#register-count').value = myReg ? myReg.count : (state.family ? state.family.size : 1);
  $('#register-error').textContent = '';
  $('#unregister-btn').classList.toggle('hidden', !myReg);
  registerModal.classList.remove('hidden');
  $('#register-count').focus();
}

$('#cancel-register-btn').addEventListener('click', () => registerModal.classList.add('hidden'));

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#register-event-id').value;
  const count = $('#register-count').value;
  $('#register-error').textContent = '';
  try {
    await api(`/events/${id}/register`, { method: 'POST', body: JSON.stringify({ count }) });
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
    if (state.meeting && state.meeting.startDate) $('#event-date').value = formatDate(state.meeting.startDate);
    $('#delete-event-btn').classList.add('hidden');
  }
  eventModal.classList.remove('hidden');
}

$('#event-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#event-id').value;
  $('#event-error').textContent = '';
  let datePayload;
  try {
    datePayload = readDateField('#event-date', 'Datum');
  } catch (err) {
    $('#event-error').textContent = err.message;
    return;
  }
  const payload = {
    title: $('#event-title').value,
    date: datePayload,
    time: $('#event-time').value,
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
async function loadFamiliesTab() {
  state.families = await api('/families');
  renderFamiliesTab();

  if (state.family) {
    $('#my-family-card').classList.remove('hidden');
    $('#my-arrival').value = formatDate(state.family.arrivalDate);
    $('#my-departure').value = formatDate(state.family.departureDate);
  }
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
    `;
    list.appendChild(row);
  });
}

$('#my-family-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  let arrivalDate, departureDate;
  try {
    arrivalDate = readDateField('#my-arrival', 'Anreise');
    departureDate = readDateField('#my-departure', 'Abreise');
  } catch (err) {
    alert(err.message);
    return;
  }
  try {
    const updated = await api('/my-family', { method: 'PUT', body: JSON.stringify({ arrivalDate, departureDate }) });
    state.family.arrivalDate = updated.arrivalDate;
    state.family.departureDate = updated.departureDate;
    $('#my-family-saved').classList.remove('hidden');
    setTimeout(() => $('#my-family-saved').classList.add('hidden'), 2000);
    await loadFamiliesTab();
  } catch (err) {
    alert(err.message);
  }
});

// ===== Admin tab =====
async function loadAdminTab() {
  if (state.meeting) {
    $('#meeting-title-input').value = state.meeting.title || '';
    $('#meeting-start').value = formatDate(state.meeting.startDate);
    $('#meeting-end').value = formatDate(state.meeting.endDate);
  }
  const families = await api('/admin/families');
  state.adminFamilies = families;
  renderAdminFamilies();
}

$('#meeting-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  let startDate, endDate;
  try {
    startDate = readDateField('#meeting-start', 'Start');
    endDate = readDateField('#meeting-end', 'Ende');
  } catch (err) {
    alert(err.message);
    return;
  }
  const payload = {
    title: $('#meeting-title-input').value,
    startDate,
    endDate,
  };
  try {
    state.meeting = await api('/meeting', { method: 'PUT', body: JSON.stringify(payload) });
    $('#topbar-title').textContent = state.meeting.title;
    $('#meeting-saved').classList.remove('hidden');
    setTimeout(() => $('#meeting-saved').classList.add('hidden'), 2000);
    $('#meeting-range-sub').textContent = state.meeting.startDate && state.meeting.endDate
      ? `${formatDateLong(state.meeting.startDate)} bis ${formatDateLong(state.meeting.endDate)}`
      : 'Termin steht noch nicht fest.';
  } catch (err) {
    alert(err.message);
  }
});

function renderAdminFamilies() {
  const list = $('#admin-families-list');
  list.innerHTML = '';
  state.adminFamilies.forEach(f => {
    const row = document.createElement('div');
    row.className = 'admin-family-row';
    const dates = (f.arrivalDate || f.departureDate)
      ? `${f.arrivalDate ? formatDate(f.arrivalDate) : '?'} → ${f.departureDate ? formatDate(f.departureDate) : '?'}`
      : 'Termin offen';
    const accountInfo = f.account
      ? `Account: <strong>${escapeHtml(f.account.username)}</strong>`
      : '<span class="no-dates">Noch kein Account</span>';
    row.innerHTML = `
      <div class="admin-family-info">
        <span class="admin-family-name">${escapeHtml(f.name)}</span>
        <span class="admin-family-meta">${f.size} ${f.size === 1 ? 'Person' : 'Personen'} · ${dates}</span>
        <span class="admin-family-meta">${accountInfo}</span>
      </div>
      <span class="admin-family-code">${f.token}</span>
      <div class="admin-family-actions">
        <button data-action="edit" data-id="${f.id}">Bearbeiten</button>
        ${f.account ? `<button data-action="reset-account" data-id="${f.id}">Account zurücksetzen</button>` : ''}
        <button data-action="delete" data-id="${f.id}">Löschen</button>
      </div>
    `;
    row.querySelector('[data-action="edit"]').addEventListener('click', () => openFamilyModal(f));
    row.querySelector('[data-action="delete"]').addEventListener('click', () => deleteFamily(f));
    const resetBtn = row.querySelector('[data-action="reset-account"]');
    if (resetBtn) resetBtn.addEventListener('click', () => resetFamilyAccount(f));
    list.appendChild(row);
  });
}

async function deleteFamily(f) {
  if (!confirm(`Familie "${f.name}" wirklich löschen? Alle Anmeldungen dieser Familie zu Events werden ebenfalls entfernt.`)) return;
  try {
    await api(`/admin/families/${f.id}`, { method: 'DELETE' });
    await loadAdminTab();
  } catch (err) {
    alert(err.message);
  }
}

async function resetFamilyAccount(f) {
  if (!confirm(`Account von Familie "${f.name}" wirklich zurücksetzen? Benutzername/Passwort werden gelöscht, der Familien-Token bleibt gültig und kann für einen neuen Account genutzt werden.`)) return;
  try {
    await api(`/admin/families/${f.id}/reset-account`, { method: 'POST' });
    await loadAdminTab();
  } catch (err) {
    alert(err.message);
  }
}

// ===== Family modal (admin) =====
const familyModal = $('#family-modal');

$('#add-family-btn').addEventListener('click', () => openFamilyModal(null));
$('#cancel-family-modal-btn').addEventListener('click', () => familyModal.classList.add('hidden'));

function openFamilyModal(f) {
  $('#family-error').textContent = '';
  $('#family-form').reset();
  if (f) {
    $('#family-modal-title').textContent = 'Familie bearbeiten';
    $('#family-id').value = f.id;
    $('#family-name').value = f.name;
    $('#family-size').value = f.size;
    $('#family-arrival').value = formatDate(f.arrivalDate);
    $('#family-departure').value = formatDate(f.departureDate);
    $('#delete-family-btn').classList.remove('hidden');
  } else {
    $('#family-modal-title').textContent = 'Neue Familie';
    $('#family-id').value = '';
    $('#delete-family-btn').classList.add('hidden');
  }
  familyModal.classList.remove('hidden');
}

$('#family-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#family-id').value;
  let arrivalDate, departureDate;
  try {
    arrivalDate = readDateField('#family-arrival', 'Anreise');
    departureDate = readDateField('#family-departure', 'Abreise');
  } catch (err) {
    $('#family-error').textContent = err.message;
    return;
  }
  const payload = {
    name: $('#family-name').value,
    size: $('#family-size').value,
    arrivalDate,
    departureDate,
  };
  try {
    if (id) {
      await api(`/admin/families/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/admin/families', { method: 'POST', body: JSON.stringify(payload) });
    }
    familyModal.classList.add('hidden');
    await loadAdminTab();
  } catch (err) {
    $('#family-error').textContent = err.message;
  }
});

$('#delete-family-btn').addEventListener('click', async () => {
  const id = $('#family-id').value;
  const f = state.adminFamilies.find(x => x.id === id);
  if (!confirm(`Familie "${f.name}" wirklich löschen?`)) return;
  try {
    await api(`/admin/families/${id}`, { method: 'DELETE' });
    familyModal.classList.add('hidden');
    await loadAdminTab();
  } catch (err) {
    $('#family-error').textContent = err.message;
  }
});

// ===== Init =====
checkAuth();

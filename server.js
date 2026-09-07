const express = require('express');
const cookieSession = require('cookie-session');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
// Noetig hinter einem Reverse Proxy (z. B. Synology Reverse Proxy, nginx),
// damit Express X-Forwarded-* korrekt auswertet (u. a. fuer sichere Cookies).
app.set('trust proxy', 1);

// --- Home-Assistant-Add-on: Optionen aus /data/options.json laden ---
// Wenn die App als HA-Add-on laeuft, legt der Supervisor die vom Nutzer im
// Add-on-Konfigurationsreiter eingegebenen Werte in /data/options.json ab.
// Laeuft die App stattdessen "nur" per docker-compose, gibt es diese Datei
// nicht -> dann zaehlen weiterhin die Umgebungsvariablen aus docker-compose.yml.
const HA_OPTIONS_FILE = '/data/options.json';
if (fs.existsSync(HA_OPTIONS_FILE)) {
  try {
    const opts = JSON.parse(fs.readFileSync(HA_OPTIONS_FILE, 'utf8'));
    if (opts.admin_code) process.env.ADMIN_CODE = opts.admin_code;
    if (opts.family_token) process.env.FAMILY_TOKEN = opts.family_token;
    if (opts.session_secret) process.env.SESSION_SECRET = opts.session_secret;
  } catch (err) {
    console.error('Konnte /data/options.json nicht lesen:', err.message);
  }
}

// --- Speicherort der Daten ---
// /data existiert nur, wenn die App unter dem Home-Assistant-Supervisor laeuft.
// Dieser Ordner ist dauerhaft und wird bei Supervisor-Backups automatisch
// mitgesichert. Ausserhalb von HA (docker-compose) wird wie bisher der lokale
// data/-Ordner benutzt (siehe docker-compose.yml Volume-Mapping).
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// --- Konfiguration ueber Umgebungsvariablen (keine Standardwerte mehr - ---
// --- ein oeffentlich im Quellcode bekannter Default waere kein Geheimnis) ---
const ADMIN_CODE = process.env.ADMIN_CODE;
const FAMILY_TOKEN = process.env.FAMILY_TOKEN;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!ADMIN_CODE || !FAMILY_TOKEN || !SESSION_SECRET) {
  console.error(
    'Fehlende Pflicht-Umgebungsvariablen: ADMIN_CODE, FAMILY_TOKEN und ' +
    'SESSION_SECRET muessen alle gesetzt sein (z. B. per .env-Datei, siehe .env.example).'
  );
  process.exit(1);
}

// Direkter Port (z. B. fuer Familie von unterwegs, ohne HA-Login) und,
// falls gesetzt, ein zusaetzlicher Ingress-Port fuer die HA-Sidebar.
const PORT = process.env.PORT || 3000;
const INGRESS_PORT = process.env.INGRESS_PORT ? parseInt(process.env.INGRESS_PORT, 10) : null;

app.use(express.json());
app.use(cookieSession({
  name: 'ff_session',
  secret: SESSION_SECRET,
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 Tage
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax'
}));

// --- Rate-Limiting gegen Brute-Force auf Login/Registrierung ---
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 Minuten
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Versuche, bitte in 15 Minuten erneut versuchen' }
});

// --- Daten laden/speichern ---
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const initial = { families: [], meetings: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    const backupFile = `${DATA_FILE}.corrupt-${Date.now()}`;
    console.error(`data.json ist beschaedigt (${err.message}) - sichere nach ${backupFile} und starte mit leeren Daten neu.`);
    try {
      fs.renameSync(DATA_FILE, backupFile);
    } catch (renameErr) {
      console.error('Konnte beschaedigte data.json nicht sichern:', renameErr.message);
    }
    data = { families: [], meetings: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  }

  // Migration: aeltere Daten kannten nur ein einzelnes globales "meeting"
  // plus flache "events" - daraus wird der erste Eintrag in "meetings".
  if (data.meeting && !data.meetings) {
    data.meetings = [{
      id: crypto.randomUUID(),
      title: data.meeting.title || '',
      startDate: data.meeting.startDate || '',
      endDate: data.meeting.endDate || '',
      manualStatus: 'active',
      participants: (data.families || []).map(f => ({
        familyId: f.id,
        size: f.size || 1,
        arrivalDate: f.arrivalDate || '',
        departureDate: f.departureDate || ''
      })),
      events: data.events || []
    }];
    delete data.meeting;
    delete data.events;
  }
  if (!data.meetings) data.meetings = [];
  if (!data.families) data.families = [];
  if (!data.settings) data.settings = {};
  data.meetings.forEach(m => {
    if (m.location === undefined) m.location = '';
  });

  // Migration: Familien-Tokens/-eigene Groesse & Termine gibt es nicht mehr -
  // diese Infos leben jetzt pro Treffen in meeting.participants.
  data.families.forEach(f => {
    delete f.token;
    delete f.code;
    delete f.size;
    delete f.arrivalDate;
    delete f.departureDate;
  });

  // Migration: Event-Anmeldungen kannten frueher nur eine einzelne "count" -
  // jetzt getrennt nach Erwachsenen/Kindern (alte Anzahl wird als Erwachsene uebernommen).
  data.meetings.forEach(m => {
    m.events.forEach(ev => {
      ev.registrations.forEach(r => {
        if (r.adults === undefined) {
          r.adults = r.count || 0;
          r.children = 0;
          delete r.count;
        }
      });
    });
  });

  return data;
}

// Promise-Queue: haengt jeden Schreibvorgang an den vorherigen an, damit sich
// ueberlappende Aufrufe nie gegenseitig ueberschreiben. Geschrieben wird
// atomar ueber eine Temp-Datei + fs.renameSync, damit data.json bei einem
// Absturz mitten im Schreiben nicht in einem kaputten Zwischenzustand landet.
let writeQueue = Promise.resolve();
function saveData(data) {
  const payload = JSON.stringify(data, null, 2);
  writeQueue = writeQueue.then(() => {
    const tmpFile = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmpFile, payload);
    fs.renameSync(tmpFile, DATA_FILE);
  }).catch(err => {
    console.error('Fehler beim Speichern von data.json:', err.message);
  });
  return writeQueue;
}

// Trimmt Namen und begrenzt sie auf 60 Zeichen (Schutz vor uebermaessig
// langen Eingaben in Familienname/Benutzername).
function sanitizeName(str) {
  return (str || '').trim().slice(0, 60);
}

// Admin-Code/Familien-Token: in der Verwaltung gesetzte Werte (data.settings)
// haben Vorrang vor den Umgebungsvariablen-Standardwerten.
function getAdminCode(data) {
  return (data.settings && data.settings.adminCode) || ADMIN_CODE;
}

function getFamilyToken(data) {
  return (data.settings && data.settings.familyToken) || FAMILY_TOKEN;
}

// --- Passwort-Hashing (Node-eigenes scrypt, keine zusaetzliche Abhaengigkeit) ---
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const test = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  if (test.length !== stored.length) return false;
  return crypto.timingSafeEqual(test, stored);
}

function displayName(f) {
  return f.account ? f.account.username : f.name;
}

function publicFamily(f) {
  return { id: f.id, name: displayName(f) };
}

function adminFamily(f) {
  return {
    id: f.id,
    name: f.name,
    account: f.account ? { username: f.account.username } : null
  };
}

// --- Datumslogik (An-/Abreise-Fenster, Event-Zeitraum) ---
function fmtDate(iso) {
  if (!iso) return '';
  const [y, mo, d] = iso.split('-');
  return `${d}.${mo}.${y}`;
}

function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// An-/Abreise duerfen hoechstens 7 Tage vor bzw. nach dem Treffen liegen.
function validateStayDate(dateStr, meeting, label) {
  if (!dateStr) return null;
  const min = addDays(meeting.startDate, -7);
  const max = addDays(meeting.endDate, 7);
  if (dateStr < min || dateStr > max) {
    return `${label} muss zwischen ${fmtDate(min)} und ${fmtDate(max)} liegen (max. 7 Tage vor/nach dem Treffen)`;
  }
  return null;
}

// Anreise darf nicht nach der Abreise liegen (Gleichstand = ein Tag = erlaubt).
function validateStayOrder(arrivalDate, departureDate) {
  if (arrivalDate && departureDate && arrivalDate > departureDate) {
    return 'Anreise muss vor oder gleich der Abreise liegen';
  }
  return null;
}

// Events muessen immer innerhalb des Treffen-Zeitraums liegen.
function validateEventDate(dateStr, meeting) {
  if (dateStr < meeting.startDate || dateStr > meeting.endDate) {
    return `Datum muss zwischen ${fmtDate(meeting.startDate)} und ${fmtDate(meeting.endDate)} liegen (Zeitraum des Treffens)`;
  }
  return null;
}

// Status wird nie gespeichert, sondern immer live berechnet: ein Enddatum in
// der Vergangenheit ueberstimmt den manuellen Aktiv/Inaktiv-Schalter.
function meetingStatus(m) {
  const today = new Date().toISOString().slice(0, 10);
  if (m.endDate && m.endDate < today) return 'past';
  return m.manualStatus === 'inactive' ? 'inactive' : 'active';
}

// Solange eine Familie noch keinen Teilnehmer-Eintrag (An-/Abreise) fuer
// dieses Treffen hat, muss sie das zuerst nachholen, bevor sie sich fuer
// einzelne Events eintragen kann.
function needsSignup(m, req) {
  const familyId = req.session && req.session.familyId;
  if (!familyId) return false;
  return !m.participants.some(p => p.familyId === familyId);
}

function publicMeeting(m, req) {
  return {
    id: m.id,
    title: m.title,
    startDate: m.startDate,
    endDate: m.endDate,
    location: m.location || '',
    status: meetingStatus(m),
    needsSignup: needsSignup(m, req)
  };
}

function adminMeeting(m) {
  return {
    id: m.id,
    title: m.title,
    startDate: m.startDate,
    endDate: m.endDate,
    location: m.location || '',
    manualStatus: m.manualStatus,
    status: meetingStatus(m),
    participantCount: m.participants.length,
    eventCount: m.events.length
  };
}

function enrichEvent(ev, families) {
  return {
    ...ev,
    registrations: ev.registrations.map(r => {
      const fam = families.find(f => f.id === r.familyId);
      return {
        familyId: r.familyId,
        familyName: fam ? displayName(fam) : '(gelöscht)',
        adults: r.adults,
        children: r.children
      };
    })
  };
}

// --- Auth Middleware ---
function requireAuth(req, res, next) {
  if (req.session && req.session.admin) return next();
  if (req.session && req.session.familyId) {
    const data = loadData();
    if (data.families.some(f => f.id === req.session.familyId)) return next();
  }
  return res.status(401).json({ error: 'Nicht angemeldet' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(401).json({ error: 'Kein Admin-Zugriff' });
}

// Muss NACH requireAuth/requireAdmin verwendet werden. Laedt das aktuell
// gewaehlte Treffen (session.currentMeetingId) und haengt es fuer die
// nachfolgenden Handler an req an. Ein Statuswechsel wirkt bewusst nicht
// rueckwirkend auf eine bereits laufende Session (siehe Plan).
function requireMeeting(req, res, next) {
  const id = req.session && req.session.currentMeetingId;
  const data = loadData();
  const meeting = id && data.meetings.find(m => m.id === id);
  if (!meeting) {
    return res.status(409).json({ error: 'Kein Treffen ausgewählt oder Treffen existiert nicht mehr', code: 'NO_MEETING_SELECTED' });
  }
  req.currentMeeting = meeting;
  req.currentData = data;
  next();
}

// --- Auth Routen ---
// Selbstregistrierung: Der (fuer die ganze App einzige) Token gilt nur fuer
// diesen einmaligen Schritt. Familie, Benutzername und Passwort werden in
// einem Zug angelegt - danach laeuft der Login nur noch ueber Account.
app.post('/api/register', authLimiter, (req, res) => {
  const { token, password } = req.body;
  const cleanName = sanitizeName(req.body.name);
  const uname = sanitizeName(req.body.username);
  const data = loadData();
  if (!token || token.trim().toUpperCase() !== getFamilyToken(data).toUpperCase()) {
    return res.status(401).json({ error: 'Falscher Token' });
  }
  if (!cleanName) {
    return res.status(400).json({ error: 'Bitte Familiennamen angeben' });
  }
  if (uname.length < 3) {
    return res.status(400).json({ error: 'Benutzername muss mindestens 3 Zeichen haben' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben' });
  }
  const exists = data.families.some(f => f.account && f.account.username.toLowerCase() === uname.toLowerCase());
  if (exists) {
    return res.status(400).json({ error: 'Benutzername ist bereits vergeben' });
  }

  const { salt, hash } = hashPassword(password);
  const family = {
    id: crypto.randomUUID(),
    name: cleanName,
    account: { username: uname, passwordSalt: salt, passwordHash: hash }
  };
  data.families.push(family);
  saveData(data);

  req.session.familyId = family.id;
  req.session.currentMeetingId = null;
  res.json({ success: true, family: publicFamily(family) });
});

app.post('/api/login-account', authLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  }
  const data = loadData();
  const family = data.families.find(f => f.account && f.account.username.toLowerCase() === username.trim().toLowerCase());
  if (!family || !verifyPassword(password, family.account.passwordSalt, family.account.passwordHash)) {
    return res.status(401).json({ error: 'Benutzername oder Passwort falsch' });
  }
  req.session.familyId = family.id;
  req.session.currentMeetingId = null;
  res.json({ success: true, family: publicFamily(family) });
});

app.post('/api/admin-login', authLimiter, (req, res) => {
  const { code } = req.body;
  const data = loadData();
  if (code === getAdminCode(data)) {
    req.session.admin = true;
    return res.json({ success: true });
  }
  return res.status(401).json({ error: 'Falscher Admin-Code' });
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  const admin = !!(req.session && req.session.admin);
  let family = null;
  let currentMeeting = null;
  const data = loadData();
  if (req.session && req.session.familyId) {
    const f = data.families.find(x => x.id === req.session.familyId);
    if (f) family = publicFamily(f);
  }
  if (req.session && req.session.currentMeetingId) {
    const m = data.meetings.find(x => x.id === req.session.currentMeetingId);
    if (m) currentMeeting = publicMeeting(m, req);
  }
  res.json({ authed: admin || !!family, admin, family, currentMeeting });
});

// --- Treffen-Auswahl ---
app.get('/api/meetings', requireAuth, (req, res) => {
  const data = loadData();
  const admin = !!(req.session && req.session.admin);
  const meetings = data.meetings
    .filter(m => admin || meetingStatus(m) === 'active')
    .sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''))
    .map(m => publicMeeting(m, req));
  res.json(meetings);
});

app.post('/api/select-meeting', requireAuth, (req, res) => {
  const data = loadData();
  const meeting = data.meetings.find(m => m.id === req.body.meetingId);
  if (!meeting) return res.status(404).json({ error: 'Treffen nicht gefunden' });
  const admin = !!(req.session && req.session.admin);
  if (!admin && meetingStatus(meeting) !== 'active') {
    return res.status(400).json({ error: 'Dieses Treffen ist nicht aktiv' });
  }
  req.session.currentMeetingId = meeting.id;
  res.json(publicMeeting(meeting, req));
});

// --- Treffen-Verwaltung (Admin) ---
app.get('/api/admin/meetings', requireAdmin, (req, res) => {
  const data = loadData();
  const meetings = [...data.meetings]
    .sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''))
    .map(adminMeeting);
  res.json(meetings);
});

app.post('/api/admin/meetings', requireAdmin, (req, res) => {
  const data = loadData();
  const { title, startDate, endDate, location, manualStatus } = req.body;
  if (!title || !title.trim() || !startDate || !endDate) {
    return res.status(400).json({ error: 'Titel, Start- und Enddatum sind erforderlich' });
  }
  if (startDate > endDate) {
    return res.status(400).json({ error: 'Startdatum muss vor oder gleich dem Enddatum liegen' });
  }
  const meeting = {
    id: crypto.randomUUID(),
    title: title.trim(),
    startDate,
    endDate,
    location: location || '',
    manualStatus: manualStatus === 'inactive' ? 'inactive' : 'active',
    participants: [],
    events: []
  };
  data.meetings.push(meeting);
  saveData(data);
  res.json(adminMeeting(meeting));
});

app.put('/api/admin/meetings/:id', requireAdmin, (req, res) => {
  const data = loadData();
  const meeting = data.meetings.find(m => m.id === req.params.id);
  if (!meeting) return res.status(404).json({ error: 'Nicht gefunden' });
  const { title, startDate, endDate, location, manualStatus } = req.body;
  const newStart = startDate !== undefined ? startDate : meeting.startDate;
  const newEnd = endDate !== undefined ? endDate : meeting.endDate;
  if (newStart > newEnd) {
    return res.status(400).json({ error: 'Startdatum muss vor oder gleich dem Enddatum liegen' });
  }
  if (title !== undefined) meeting.title = title.trim();
  meeting.startDate = newStart;
  meeting.endDate = newEnd;
  if (location !== undefined) meeting.location = location;
  if (manualStatus !== undefined) meeting.manualStatus = manualStatus === 'inactive' ? 'inactive' : 'active';
  saveData(data);
  res.json(adminMeeting(meeting));
});

app.delete('/api/admin/meetings/:id', requireAdmin, (req, res) => {
  const data = loadData();
  data.meetings = data.meetings.filter(m => m.id !== req.params.id);
  saveData(data);
  res.json({ success: true });
});

// --- Events (treffen-bezogen) ---
app.get('/api/events', requireAuth, requireMeeting, (req, res) => {
  res.json(req.currentMeeting.events.map(ev => enrichEvent(ev, req.currentData.families)));
});

app.post('/api/events', requireAdmin, requireMeeting, (req, res) => {
  const { title, date, time, location, description } = req.body;
  if (!title || !title.trim() || !date) {
    return res.status(400).json({ error: 'Titel und Datum sind erforderlich' });
  }
  const dateError = validateEventDate(date, req.currentMeeting);
  if (dateError) return res.status(400).json({ error: dateError });
  const event = {
    id: crypto.randomUUID(),
    title: title.trim(),
    date,
    time: time || '',
    location: location || '',
    description: description || '',
    registrations: []
  };
  req.currentMeeting.events.push(event);
  saveData(req.currentData);
  res.json(enrichEvent(event, req.currentData.families));
});

app.put('/api/events/:id', requireAdmin, requireMeeting, (req, res) => {
  const event = req.currentMeeting.events.find(e => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Nicht gefunden' });
  const { title, date, time, location, description } = req.body;
  if (date !== undefined) {
    const dateError = validateEventDate(date, req.currentMeeting);
    if (dateError) return res.status(400).json({ error: dateError });
  }
  if (title !== undefined) event.title = title.trim();
  if (date !== undefined) event.date = date;
  if (time !== undefined) event.time = time;
  if (location !== undefined) event.location = location;
  if (description !== undefined) event.description = description;
  saveData(req.currentData);
  res.json(enrichEvent(event, req.currentData.families));
});

app.delete('/api/events/:id', requireAdmin, requireMeeting, (req, res) => {
  req.currentMeeting.events = req.currentMeeting.events.filter(e => e.id !== req.params.id);
  saveData(req.currentData);
  res.json({ success: true });
});

app.post('/api/events/:id/register', requireAuth, requireMeeting, (req, res) => {
  const event = req.currentMeeting.events.find(e => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Nicht gefunden' });
  if (!req.session.familyId) {
    return res.status(400).json({ error: 'Nur Familien können sich anmelden' });
  }
  // Erst wenn die Familie fuer dieses Treffen An-/Abreise hinterlegt hat,
  // darf sie sich fuer einzelne Events eintragen (siehe requireMeeting/needsSignup).
  const isParticipant = req.currentMeeting.participants.some(p => p.familyId === req.session.familyId);
  if (!isParticipant) {
    return res.status(400).json({ error: 'Bitte zuerst An- und Abreise für das Treffen angeben' });
  }
  const adults = parseInt(req.body.adults, 10) || 0;
  const children = parseInt(req.body.children, 10) || 0;
  if (adults + children < 1) {
    return res.status(400).json({ error: 'Mindestens eine Person erforderlich' });
  }
  const existing = event.registrations.find(r => r.familyId === req.session.familyId);
  if (existing) {
    existing.adults = adults;
    existing.children = children;
  } else {
    event.registrations.push({ familyId: req.session.familyId, adults, children });
  }
  saveData(req.currentData);
  res.json(enrichEvent(event, req.currentData.families));
});

app.post('/api/events/:id/unregister', requireAuth, requireMeeting, (req, res) => {
  const event = req.currentMeeting.events.find(e => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Nicht gefunden' });
  event.registrations = event.registrations.filter(r => r.familyId !== req.session.familyId);
  saveData(req.currentData);
  res.json(enrichEvent(event, req.currentData.families));
});

// --- Teilnehmer des aktuellen Treffens ("Wer kommt wann?") ---
app.get('/api/families', requireAuth, requireMeeting, (req, res) => {
  const list = req.currentMeeting.participants.map(p => {
    const fam = req.currentData.families.find(f => f.id === p.familyId);
    return {
      id: p.familyId,
      name: fam ? displayName(fam) : '(gelöscht)',
      size: p.size,
      arrivalDate: p.arrivalDate,
      departureDate: p.departureDate
    };
  });
  res.json(list);
});

app.put('/api/my-family', requireAuth, requireMeeting, (req, res) => {
  if (!req.session.familyId) {
    return res.status(400).json({ error: 'Nur Familien können ihre Termine eintragen' });
  }
  const { size, arrivalDate, departureDate } = req.body;
  const parsedSize = parseInt(size, 10);
  if (!parsedSize || parsedSize < 1) {
    return res.status(400).json({ error: 'Ungültige Personenzahl' });
  }
  const arrivalError = validateStayDate(arrivalDate, req.currentMeeting, 'Anreise');
  if (arrivalError) return res.status(400).json({ error: arrivalError });
  const departureError = validateStayDate(departureDate, req.currentMeeting, 'Abreise');
  if (departureError) return res.status(400).json({ error: departureError });
  const orderError = validateStayOrder(arrivalDate, departureDate);
  if (orderError) return res.status(400).json({ error: orderError });
  let participant = req.currentMeeting.participants.find(p => p.familyId === req.session.familyId);
  if (!participant) {
    participant = { familyId: req.session.familyId, size: parsedSize, arrivalDate: '', departureDate: '' };
    req.currentMeeting.participants.push(participant);
  }
  participant.size = parsedSize;
  participant.arrivalDate = arrivalDate || '';
  participant.departureDate = departureDate || '';
  saveData(req.currentData);
  const fam = req.currentData.families.find(f => f.id === req.session.familyId);
  res.json({ id: participant.familyId, name: fam ? displayName(fam) : '', size: participant.size, arrivalDate: participant.arrivalDate, departureDate: participant.departureDate });
});

// Admin: Groesse/An-/Abreise eines Teilnehmers im aktuell gewaehlten Treffen bearbeiten.
app.put('/api/admin/participants/:familyId', requireAdmin, requireMeeting, (req, res) => {
  const fam = req.currentData.families.find(f => f.id === req.params.familyId);
  if (!fam) return res.status(404).json({ error: 'Familie nicht gefunden' });
  const { size, arrivalDate, departureDate } = req.body;
  const parsedSize = parseInt(size, 10);
  if (!parsedSize || parsedSize < 1) {
    return res.status(400).json({ error: 'Ungültige Personenzahl' });
  }
  const arrivalError = validateStayDate(arrivalDate, req.currentMeeting, 'Anreise');
  if (arrivalError) return res.status(400).json({ error: arrivalError });
  const departureError = validateStayDate(departureDate, req.currentMeeting, 'Abreise');
  if (departureError) return res.status(400).json({ error: departureError });
  const orderError = validateStayOrder(arrivalDate, departureDate);
  if (orderError) return res.status(400).json({ error: orderError });
  let participant = req.currentMeeting.participants.find(p => p.familyId === req.params.familyId);
  if (!participant) {
    participant = { familyId: req.params.familyId, size: parsedSize, arrivalDate: '', departureDate: '' };
    req.currentMeeting.participants.push(participant);
  }
  participant.size = parsedSize;
  participant.arrivalDate = arrivalDate || '';
  participant.departureDate = departureDate || '';
  saveData(req.currentData);
  res.json({ id: participant.familyId, name: displayName(fam), size: participant.size, arrivalDate: participant.arrivalDate, departureDate: participant.departureDate });
});

// --- Familienverwaltung (global, Admin) ---
app.get('/api/admin/families', requireAdmin, (req, res) => {
  const data = loadData();
  res.json(data.families.map(adminFamily));
});

app.put('/api/admin/families/:id', requireAdmin, (req, res) => {
  const data = loadData();
  const family = data.families.find(f => f.id === req.params.id);
  if (!family) return res.status(404).json({ error: 'Nicht gefunden' });
  const { name } = req.body;
  if (name !== undefined) family.name = sanitizeName(name);
  saveData(data);
  res.json(adminFamily(family));
});

app.delete('/api/admin/families/:id', requireAdmin, (req, res) => {
  const data = loadData();
  data.families = data.families.filter(f => f.id !== req.params.id);
  data.meetings.forEach(m => {
    m.participants = m.participants.filter(p => p.familyId !== req.params.id);
    m.events.forEach(ev => {
      ev.registrations = ev.registrations.filter(r => r.familyId !== req.params.id);
    });
  });
  saveData(data);
  res.json({ success: true });
});

// Admin: neues Passwort fuer eine Familie setzen (Recovery-Weg, da der
// Token nicht mehr familienspezifisch ist). Benutzername/Historie bleiben.
app.post('/api/admin/families/:id/set-password', requireAdmin, (req, res) => {
  const data = loadData();
  const family = data.families.find(f => f.id === req.params.id);
  if (!family) return res.status(404).json({ error: 'Nicht gefunden' });
  if (!family.account) return res.status(400).json({ error: 'Familie hat keinen Account' });
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben' });
  }
  const { salt, hash } = hashPassword(password);
  family.account.passwordSalt = salt;
  family.account.passwordHash = hash;
  saveData(data);
  res.json(adminFamily(family));
});

// --- Zugangsdaten (Admin-Code, Familien-Token) ---
// In der Verwaltung gesetzte Werte ueberschreiben die Umgebungsvariablen-
// Standardwerte dauerhaft (gespeichert in data.json).
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const data = loadData();
  res.json({ adminCode: getAdminCode(data), familyToken: getFamilyToken(data) });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const data = loadData();
  const { adminCode, familyToken } = req.body;
  if (!adminCode || !adminCode.trim()) {
    return res.status(400).json({ error: 'Admin-Code darf nicht leer sein' });
  }
  if (!familyToken || !familyToken.trim()) {
    return res.status(400).json({ error: 'Familien-Token darf nicht leer sein' });
  }
  data.settings.adminCode = adminCode.trim();
  data.settings.familyToken = familyToken.trim();
  saveData(data);
  res.json({ adminCode: data.settings.adminCode, familyToken: data.settings.familyToken });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Familienfest-Planer laeuft auf Port ${PORT}`);
});

// Zusaetzlicher Listener fuer die Home-Assistant-Ingress-Sidebar, falls
// INGRESS_PORT gesetzt ist (siehe Dockerfile / config.yaml des Add-ons).
if (INGRESS_PORT && INGRESS_PORT !== PORT) {
  app.listen(INGRESS_PORT, () => {
    console.log(`Familienfest-Planer (Ingress) laeuft auf Port ${INGRESS_PORT}`);
  });
}

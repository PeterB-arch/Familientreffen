const express = require('express');
const cookieSession = require('cookie-session');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

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

// --- Konfiguration ueber Umgebungsvariablen (mit Standardwerten) ---
const ADMIN_CODE = process.env.ADMIN_CODE || 'admin2026';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// Direkter Port (z. B. fuer Familie von unterwegs, ohne HA-Login) und,
// falls gesetzt, ein zusaetzlicher Ingress-Port fuer die HA-Sidebar.
const PORT = process.env.PORT || 3000;
const INGRESS_PORT = process.env.INGRESS_PORT ? parseInt(process.env.INGRESS_PORT, 10) : null;

app.use(express.json());
app.use(cookieSession({
  name: 'ff_session',
  secret: SESSION_SECRET,
  maxAge: 30 * 24 * 60 * 60 * 1000 // 30 Tage
}));

// --- Daten laden/speichern ---
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const initial = {
      meeting: { title: '', startDate: '', endDate: '' },
      families: [],
      events: []
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!data.meeting) data.meeting = { title: '', startDate: '', endDate: '' };
  if (!data.families) data.families = [];
  if (!data.events) data.events = [];
  // Migration: aeltere Daten kannten nur "code" (Login-Code ohne Account).
  data.families.forEach(f => {
    if (!f.token && f.code) f.token = f.code;
    if (f.account === undefined) f.account = null;
  });
  return data;
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// --- Familien-Token ---
const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne 0/O/1/I zur besseren Lesbarkeit
function generateFamilyToken(existingTokens) {
  let token;
  do {
    token = Array.from({ length: 6 }, () => TOKEN_CHARS[crypto.randomInt(TOKEN_CHARS.length)]).join('');
  } while (existingTokens.includes(token));
  return token;
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

// Sobald ein Account existiert, wird ueberall (Events, "Wer kommt wann?",
// Topbar) der selbstgewaehlte Accountname statt des von Admin vergebenen
// Familiennamens angezeigt. Der Admin-Bereich sieht weiterhin beide.
function displayName(f) {
  return f.account ? f.account.username : f.name;
}

function publicFamily(f) {
  return { id: f.id, name: displayName(f), size: f.size, arrivalDate: f.arrivalDate, departureDate: f.departureDate };
}

function adminFamily(f) {
  return {
    id: f.id,
    name: f.name,
    token: f.token,
    size: f.size,
    arrivalDate: f.arrivalDate,
    departureDate: f.departureDate,
    account: f.account ? { username: f.account.username } : null
  };
}

function enrichEvent(ev, families) {
  return {
    ...ev,
    registrations: ev.registrations.map(r => {
      const fam = families.find(f => f.id === r.familyId);
      return { familyId: r.familyId, familyName: fam ? displayName(fam) : '(gelöscht)', count: r.count };
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

// --- Auth Routen ---
// Login per Familien-Token: Falls die Familie noch keinen Account hat, wird
// eine "pending"-Session gestartet, in der ein Account (Benutzername +
// Passwort) angelegt werden muss. Hat die Familie schon einen Account, loggt
// der Token direkt ein (bleibt dauerhaft als Zugang/Recovery-Weg gueltig).
app.post('/api/login', (req, res) => {
  const { token } = req.body;
  if (!token || !token.trim()) {
    return res.status(400).json({ error: 'Bitte Familien-Token angeben' });
  }
  const data = loadData();
  const family = data.families.find(f => f.token === token.trim().toUpperCase());
  if (!family) {
    return res.status(401).json({ error: 'Falscher Familien-Token' });
  }
  if (!family.account) {
    req.session.pendingFamilyId = family.id;
    return res.json({ success: true, needsSetup: true });
  }
  req.session.familyId = family.id;
  res.json({ success: true, needsSetup: false, family: publicFamily(family) });
});

// Account anlegen: nur moeglich direkt nach einem gueltigen Token-Login
// (req.session.pendingFamilyId), damit niemand ohne Token einen Account
// fuer eine fremde Familie erstellen kann.
app.post('/api/create-account', (req, res) => {
  if (!req.session || !req.session.pendingFamilyId) {
    return res.status(400).json({ error: 'Bitte zuerst mit dem Familien-Token anmelden' });
  }
  const data = loadData();
  const family = data.families.find(f => f.id === req.session.pendingFamilyId);
  if (!family) return res.status(404).json({ error: 'Nicht gefunden' });
  if (family.account) return res.status(400).json({ error: 'Für diese Familie existiert bereits ein Account' });

  const { username, password } = req.body;
  if (!username || !username.trim() || username.trim().length < 3) {
    return res.status(400).json({ error: 'Benutzername muss mindestens 3 Zeichen haben' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben' });
  }
  const uname = username.trim();
  const exists = data.families.some(f => f.account && f.account.username.toLowerCase() === uname.toLowerCase());
  if (exists) {
    return res.status(400).json({ error: 'Benutzername ist bereits vergeben' });
  }

  const { salt, hash } = hashPassword(password);
  family.account = { username: uname, passwordSalt: salt, passwordHash: hash };
  saveData(data);

  delete req.session.pendingFamilyId;
  req.session.familyId = family.id;
  res.json({ success: true, family: publicFamily(family) });
});

app.post('/api/login-account', (req, res) => {
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
  res.json({ success: true, family: publicFamily(family) });
});

app.post('/api/admin-login', (req, res) => {
  const { code } = req.body;
  if (code === ADMIN_CODE) {
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
  if (req.session && req.session.familyId) {
    const data = loadData();
    const f = data.families.find(x => x.id === req.session.familyId);
    if (f) family = publicFamily(f);
  }
  let pendingSetup = false;
  if (!admin && !family && req.session && req.session.pendingFamilyId) {
    const data = loadData();
    pendingSetup = data.families.some(f => f.id === req.session.pendingFamilyId);
  }
  res.json({ authed: admin || !!family, admin, family, pendingSetup });
});

// --- Meeting ---
app.get('/api/meeting', (req, res) => {
  const data = loadData();
  res.json(data.meeting);
});

app.put('/api/meeting', requireAdmin, (req, res) => {
  const data = loadData();
  const { title, startDate, endDate } = req.body;
  data.meeting = {
    title: (title || '').trim(),
    startDate: startDate || '',
    endDate: endDate || ''
  };
  saveData(data);
  res.json(data.meeting);
});

// --- Events ---
app.get('/api/events', requireAuth, (req, res) => {
  const data = loadData();
  res.json(data.events.map(ev => enrichEvent(ev, data.families)));
});

app.post('/api/events', requireAdmin, (req, res) => {
  const data = loadData();
  const { title, date, time, location, description } = req.body;
  if (!title || !title.trim() || !date) {
    return res.status(400).json({ error: 'Titel und Datum sind erforderlich' });
  }
  const event = {
    id: crypto.randomUUID(),
    title: title.trim(),
    date,
    time: time || '',
    location: location || '',
    description: description || '',
    registrations: []
  };
  data.events.push(event);
  saveData(data);
  res.json(enrichEvent(event, data.families));
});

app.put('/api/events/:id', requireAdmin, (req, res) => {
  const data = loadData();
  const event = data.events.find(e => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Nicht gefunden' });
  const { title, date, time, location, description } = req.body;
  if (title !== undefined) event.title = title.trim();
  if (date !== undefined) event.date = date;
  if (time !== undefined) event.time = time;
  if (location !== undefined) event.location = location;
  if (description !== undefined) event.description = description;
  saveData(data);
  res.json(enrichEvent(event, data.families));
});

app.delete('/api/events/:id', requireAdmin, (req, res) => {
  const data = loadData();
  data.events = data.events.filter(e => e.id !== req.params.id);
  saveData(data);
  res.json({ success: true });
});

app.post('/api/events/:id/register', requireAuth, (req, res) => {
  const data = loadData();
  const event = data.events.find(e => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Nicht gefunden' });
  if (!req.session.familyId) {
    return res.status(400).json({ error: 'Nur Familien können sich anmelden' });
  }
  const count = parseInt(req.body.count, 10);
  if (!count || count < 1) {
    return res.status(400).json({ error: 'Ungültige Personenzahl' });
  }
  const existing = event.registrations.find(r => r.familyId === req.session.familyId);
  if (existing) {
    existing.count = count;
  } else {
    event.registrations.push({ familyId: req.session.familyId, count });
  }
  saveData(data);
  res.json(enrichEvent(event, data.families));
});

app.post('/api/events/:id/unregister', requireAuth, (req, res) => {
  const data = loadData();
  const event = data.events.find(e => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Nicht gefunden' });
  event.registrations = event.registrations.filter(r => r.familyId !== req.session.familyId);
  saveData(data);
  res.json(enrichEvent(event, data.families));
});

// --- Familien (oeffentliche Uebersicht: An-/Abreise) ---
app.get('/api/families', requireAuth, (req, res) => {
  const data = loadData();
  res.json(data.families.map(publicFamily));
});

app.put('/api/my-family', requireAuth, (req, res) => {
  if (!req.session.familyId) {
    return res.status(400).json({ error: 'Nur Familien können ihre Termine eintragen' });
  }
  const data = loadData();
  const family = data.families.find(f => f.id === req.session.familyId);
  if (!family) return res.status(404).json({ error: 'Nicht gefunden' });
  const { arrivalDate, departureDate } = req.body;
  family.arrivalDate = arrivalDate || '';
  family.departureDate = departureDate || '';
  saveData(data);
  res.json(publicFamily(family));
});

// --- Familien-Verwaltung (Admin, inkl. Zugangs-Token) ---
app.get('/api/admin/families', requireAdmin, (req, res) => {
  const data = loadData();
  res.json(data.families.map(adminFamily));
});

app.post('/api/admin/families', requireAdmin, (req, res) => {
  const data = loadData();
  const { name, size, arrivalDate, departureDate } = req.body;
  if (!name || !name.trim() || !size || parseInt(size, 10) < 1) {
    return res.status(400).json({ error: 'Name und Personenzahl sind erforderlich' });
  }
  const family = {
    id: crypto.randomUUID(),
    name: name.trim(),
    token: generateFamilyToken(data.families.map(f => f.token)),
    size: parseInt(size, 10),
    arrivalDate: arrivalDate || '',
    departureDate: departureDate || '',
    account: null
  };
  data.families.push(family);
  saveData(data);
  res.json(adminFamily(family));
});

app.put('/api/admin/families/:id', requireAdmin, (req, res) => {
  const data = loadData();
  const family = data.families.find(f => f.id === req.params.id);
  if (!family) return res.status(404).json({ error: 'Nicht gefunden' });
  const { name, size, arrivalDate, departureDate } = req.body;
  if (name !== undefined) family.name = name.trim();
  if (size !== undefined) family.size = parseInt(size, 10) || family.size;
  if (arrivalDate !== undefined) family.arrivalDate = arrivalDate;
  if (departureDate !== undefined) family.departureDate = departureDate;
  saveData(data);
  res.json(adminFamily(family));
});

app.delete('/api/admin/families/:id', requireAdmin, (req, res) => {
  const data = loadData();
  data.families = data.families.filter(f => f.id !== req.params.id);
  data.events.forEach(ev => {
    ev.registrations = ev.registrations.filter(r => r.familyId !== req.params.id);
  });
  saveData(data);
  res.json({ success: true });
});

// Admin: Account einer Familie zuruecksetzen (z. B. Passwort vergessen und
// Familie kann/will den Token nicht nutzen) - danach greift beim naechsten
// Token-Login wieder der Account-Setup-Flow.
app.post('/api/admin/families/:id/reset-account', requireAdmin, (req, res) => {
  const data = loadData();
  const family = data.families.find(f => f.id === req.params.id);
  if (!family) return res.status(404).json({ error: 'Nicht gefunden' });
  family.account = null;
  saveData(data);
  res.json(adminFamily(family));
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

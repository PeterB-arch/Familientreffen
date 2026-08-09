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
  return data;
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// --- Familien-Codes ---
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne 0/O/1/I zur besseren Lesbarkeit
function generateFamilyCode(existingCodes) {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (existingCodes.includes(code));
  return code;
}

function publicFamily(f) {
  return { id: f.id, name: f.name, size: f.size, arrivalDate: f.arrivalDate, departureDate: f.departureDate };
}

function enrichEvent(ev, families) {
  return {
    ...ev,
    registrations: ev.registrations.map(r => {
      const fam = families.find(f => f.id === r.familyId);
      return { familyId: r.familyId, familyName: fam ? fam.name : '(gelöscht)', count: r.count };
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
app.post('/api/login', (req, res) => {
  const { code } = req.body;
  if (!code || !code.trim()) {
    return res.status(400).json({ error: 'Bitte Familien-Code angeben' });
  }
  const data = loadData();
  const family = data.families.find(f => f.code === code.trim().toUpperCase());
  if (!family) {
    return res.status(401).json({ error: 'Falscher Familien-Code' });
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
  res.json({ authed: admin || !!family, admin, family });
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

// --- Familien-Verwaltung (Admin, inkl. Zugangscodes) ---
app.get('/api/admin/families', requireAdmin, (req, res) => {
  const data = loadData();
  res.json(data.families);
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
    code: generateFamilyCode(data.families.map(f => f.code)),
    size: parseInt(size, 10),
    arrivalDate: arrivalDate || '',
    departureDate: departureDate || ''
  };
  data.families.push(family);
  saveData(data);
  res.json(family);
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
  res.json(family);
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

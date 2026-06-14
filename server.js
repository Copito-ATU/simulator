require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { BusSimulator, haversine } = require('./engine/busSimulator');
const { EventEngine } = require('./engine/eventEngine');
const firebase = require('./engine/firebaseSync');
const { planJourney, planJourneyAlternatives } = require('./engine/journeyPlanner');
const { fetchNoticias }  = require('./engine/noticiasScraper');
const QRCode   = require('qrcode');

// ── Datos ATU pre-procesados ──────────────────────────────────────────────────
const ATU_DIR = path.join(__dirname, 'data/atu');
function loadAtu(file) {
  const p = path.join(ATU_DIR, file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}
const ATU_ROUTES_MAP      = loadAtu('routes_map.json')       || [];
const ATU_PEAK_HOURS      = loadAtu('peak_hours.json')       || {};
const ATU_STATION_DEMAND  = loadAtu('station_demand.json')   || {};
const ATU_SUMMARY         = loadAtu('summary.json')          || {};
const ATU_CORREDORES      = loadAtu('corredores_stops.json') || [];
if (ATU_ROUTES_MAP.length)  console.log(`[ATU] ✓ ${ATU_ROUTES_MAP.length} rutas reales cargadas`);
if (ATU_CORREDORES.length)  console.log(`[ATU] ✓ ${ATU_CORREDORES.length} líneas de corredores (${ATU_CORREDORES.reduce((s,c)=>s+c.stops.length,0)} paradas)`);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Servir la app Flutter en /app
const flutterWebPath = path.join(__dirname, '..', 'atu_app', 'build', 'web');
app.use('/app', express.static(flutterWebPath));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const sim    = new BusSimulator();
const events = new EventEngine();

// Firebase — activa sync automáticamente si las credenciales están en .env
const fbReady = firebase.init();
if (fbReady) {
  firebase.setEnabled(true);
  firebase.writeRoutes(sim.getRoutes());
  firebase.writeMeta(sim.getBusesPublic().length);
  fetchNoticias().then(data => firebase.writeNoticias(data)).catch(() => {});
  // Sube datos ATU reales (rutas geo, horas pico, demanda por estación)
  if (ATU_ROUTES_MAP.length) {
    firebase.writeAtuData(ATU_ROUTES_MAP, ATU_PEAK_HOURS, ATU_STATION_DEMAND);
  }
  if (ATU_CORREDORES.length) {
    firebase.writeCorredores(ATU_CORREDORES);
  }
}

// ── REST ───────────────────────────────────────────────────────────────────────

app.get('/api/routes',   (req, res) => res.json(sim.getRoutes()));
app.get('/api/buses',    (req, res) => res.json(sim.getBusesPublic()));
app.get('/api/incidents',(req, res) => res.json(events.getActiveIncidents()));
app.get('/api/noticias', async (req, res) => {
  try {
    const data = await fetchNoticias();
    firebase.writeNoticias(data);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Toggle Firebase sync desde el visor web
app.post('/api/firebase/toggle', (req, res) => {
  if (!fbReady) return res.status(503).json({ ok: false, msg: 'Firebase no configurado en .env' });
  const newState = !firebase.isEnabled();
  firebase.setEnabled(newState);
  if (newState) {
    firebase.writeRoutes(sim.getRoutes());
    firebase.writeMeta(sim.getBusesPublic().length);
  }
  res.json({ ok: true, enabled: newState });
});

app.get('/api/firebase/status', (req, res) =>
  res.json({ ready: fbReady, enabled: firebase.isEnabled() }));

// ── Simulator control endpoints ───────────────────────────────────────────────
app.get('/api/sim/speed', (req, res) =>
  res.json({ multiplier: sim.getSpeedMultiplier() }));

app.post('/api/sim/speed', (req, res) => {
  const m = parseFloat(req.body.multiplier);
  if (!isFinite(m) || m <= 0) return res.status(400).json({ error: 'multiplier must be a positive number' });
  sim.setSpeedMultiplier(m);
  res.json({ ok: true, multiplier: sim.getSpeedMultiplier() });
});

app.get('/api/sim/buses/count', (req, res) => {
  const counts = sim.getBusCountByRoute();
  const routes = sim.getRoutes().map(r => ({ id: r.id, name: r.name, color: r.color, type: r.type, count: counts[r.id] || 0 }));
  res.json({ total: sim.getBusesPublic().length, routes });
});

app.post('/api/sim/buses/add', (req, res) => {
  const { routeId, count = 1 } = req.body;
  const ok = sim.addBuses(routeId, Math.min(50, Math.max(1, parseInt(count) || 1)));
  res.json({ ok, counts: sim.getBusCountByRoute() });
});

app.post('/api/sim/buses/remove', (req, res) => {
  const { routeId, count = 1 } = req.body;
  const removed = sim.removeBuses(routeId, Math.min(50, Math.max(1, parseInt(count) || 1)));
  res.json({ ok: removed > 0, removed, counts: sim.getBusCountByRoute() });
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ATU Simulator Dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh;padding:24px}
  h1{font-size:20px;font-weight:700;color:#58a6ff;margin-bottom:4px}
  .sub{font-size:12px;color:#8b949e;margin-bottom:24px}
  .card{background:#161b22;border:1px solid #21262d;border-radius:12px;padding:20px;margin-bottom:20px}
  .card h2{font-size:13px;font-weight:700;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin-bottom:16px}
  .speed-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .speed-btn{padding:8px 20px;border-radius:20px;border:1px solid #30363d;background:#21262d;color:#c9d1d9;font-weight:700;font-size:14px;cursor:pointer;transition:.15s}
  .speed-btn.active,.speed-btn:hover{background:#1f6feb;border-color:#1f6feb;color:#fff}
  .custom-speed{display:flex;align-items:center;gap:8px}
  .custom-speed input{width:70px;padding:7px 10px;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;font-size:14px;text-align:center}
  .custom-speed button{padding:7px 14px;border-radius:8px;background:#238636;border:none;color:#fff;cursor:pointer;font-weight:700}
  .stat-pill{display:inline-flex;align-items:center;gap:6px;background:#21262d;border-radius:20px;padding:6px 14px;font-size:13px;color:#8b949e}
  .stat-pill b{color:#e6edf3}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:8px 12px;color:#8b949e;font-weight:600;border-bottom:1px solid #21262d;font-size:11px;text-transform:uppercase}
  td{padding:8px 12px;border-bottom:1px solid #161b22}
  tr:hover td{background:#1c2128}
  .dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:6px}
  .type-badge{font-size:10px;padding:2px 8px;border-radius:10px;font-weight:700;background:#21262d;color:#8b949e}
  .type-badge.brt{background:#1c3a5e;color:#79c0ff}
  .type-badge.metro{background:#1c3a5e;color:#a5d6ff}
  .btn-sm{padding:4px 10px;border-radius:6px;border:none;font-weight:700;font-size:12px;cursor:pointer;transition:.12s}
  .btn-add{background:#238636;color:#fff}.btn-add:hover{background:#2ea043}
  .btn-rem{background:#6e2f2f;color:#ffa198}.btn-rem:hover{background:#8b3636}
  .count-badge{display:inline-flex;align-items:center;justify-content:center;min-width:32px;height:24px;border-radius:6px;background:#21262d;font-weight:700;font-size:13px;color:#e6edf3;margin:0 6px}
  #totalBuses{font-size:22px;font-weight:700;color:#58a6ff}
  .refresh{font-size:11px;color:#3d444d;float:right;margin-top:2px}
</style>
</head>
<body>
<h1>🚇 ATU Simulator — Dashboard</h1>
<div class="sub">Control en tiempo real · <span id="ts"></span></div>

<div class="card">
  <h2>Estado global</h2>
  <div style="display:flex;gap:16px;flex-wrap:wrap">
    <div class="stat-pill">Buses activos: <b id="totalBuses">…</b></div>
    <div class="stat-pill">Velocidad sim: <b id="curSpeed">…</b>×</div>
  </div>
</div>

<div class="card">
  <h2>Velocidad del simulador</h2>
  <div class="speed-row" id="speedBtns">
    <button class="speed-btn" data-v="0.5">0.5×</button>
    <button class="speed-btn" data-v="1">1× <span style="font-size:10px;font-weight:400;color:#8b949e">(real)</span></button>
    <button class="speed-btn" data-v="2">2×</button>
    <button class="speed-btn" data-v="5">5×</button>
    <button class="speed-btn" data-v="10">10×</button>
    <div class="custom-speed">
      <input type="number" id="customV" placeholder="Ej: 3" min="0.25" max="20" step="0.25">
      <button onclick="setCustomSpeed()">Aplicar</button>
    </div>
  </div>
</div>

<div class="card">
  <h2>Buses por ruta <span class="refresh" id="lastUpdate"></span></h2>
  <table>
    <thead><tr><th>Ruta</th><th>Tipo</th><th>Buses</th><th>Acción</th></tr></thead>
    <tbody id="routeTable"></tbody>
  </table>
</div>

<script>
const BASE = '';
let curSpeed = 1;

async function api(path, body) {
  const opts = body ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) } : {};
  const r = await fetch(BASE + path, opts);
  return r.json();
}

async function setSpeed(v) {
  curSpeed = v;
  await api('/api/sim/speed', { multiplier: v });
  document.querySelectorAll('.speed-btn').forEach(b => b.classList.toggle('active', +b.dataset.v === v));
  document.getElementById('curSpeed').textContent = v;
}

function setCustomSpeed() {
  const v = parseFloat(document.getElementById('customV').value);
  if (v > 0 && v <= 20) setSpeed(v);
}

document.getElementById('speedBtns').addEventListener('click', e => {
  const v = parseFloat(e.target.closest('[data-v]')?.dataset.v);
  if (!isNaN(v)) setSpeed(v);
});

async function refresh() {
  const [busData, speedData] = await Promise.all([
    api('/api/sim/buses/count'),
    api('/api/sim/speed'),
  ]);
  curSpeed = speedData.multiplier;
  document.getElementById('totalBuses').textContent = busData.total;
  document.getElementById('curSpeed').textContent   = speedData.multiplier;
  document.querySelectorAll('.speed-btn').forEach(b => b.classList.toggle('active', +b.dataset.v === curSpeed));

  const tbody = document.getElementById('routeTable');
  tbody.innerHTML = busData.routes.map(r => \`
    <tr>
      <td><span class="dot" style="background:\${r.color || '#555'}"></span>\${r.name}</td>
      <td><span class="type-badge \${r.type}">\${r.type.toUpperCase()}</span></td>
      <td><span class="count-badge" id="cnt-\${r.id}">\${r.count}</span></td>
      <td>
        <button class="btn-sm btn-rem" onclick="changeBuses('\${r.id}',-1)">−1</button>
        <button class="btn-sm btn-rem" onclick="changeBuses('\${r.id}',-5)" style="margin-left:4px">−5</button>
        <button class="btn-sm btn-add" onclick="changeBuses('\${r.id}',1)"  style="margin-left:8px">+1</button>
        <button class="btn-sm btn-add" onclick="changeBuses('\${r.id}',5)"  style="margin-left:4px">+5</button>
        <button class="btn-sm btn-add" onclick="changeBuses('\${r.id}',10)" style="margin-left:4px">+10</button>
      </td>
    </tr>
  \`).join('');

  document.getElementById('lastUpdate').textContent = 'Act. ' + new Date().toLocaleTimeString('es-PE');
  document.getElementById('ts').textContent = new Date().toLocaleTimeString('es-PE');
}

async function changeBuses(routeId, delta) {
  const endpoint = delta > 0 ? '/api/sim/buses/add' : '/api/sim/buses/remove';
  const data = await api(endpoint, { routeId, count: Math.abs(delta) });
  const el = document.getElementById('cnt-' + routeId);
  if (el && data.counts) el.textContent = data.counts[routeId] || 0;
  document.getElementById('totalBuses').textContent = Object.values(data.counts || {}).reduce((a,b)=>a+b,0);
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`);
});

// Página QR para escanear con el celular
app.get('/qr', async (req, res) => {
  const host = req.hostname === 'localhost' ? '192.168.0.102' : req.hostname;
  const appUrl = `http://${host}:${PORT}/app`;
  const qrDataUrl = await QRCode.toDataURL(appUrl, { width: 240, margin: 2 });
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ATU App QR</title>
<style>
  body{font-family:sans-serif;background:#0d1117;color:#e6edf3;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;gap:16px}
  h2{color:#58a6ff;margin:0}p{color:#8b949e;margin:0;font-size:13px;text-align:center}
  img{border-radius:12px;border:4px solid #21262d}
  .url{background:#21262d;padding:10px 18px;border-radius:8px;font-family:monospace;font-size:14px;color:#3fb950}
  small{color:#3d444d;font-size:11px}
</style></head>
<body>
  <h2>📱 ATU Lima</h2>
  <p>Escanea con la cámara de tu celular<br>(debe estar en la misma WiFi)</p>
  <img src="${qrDataUrl}" width="240" height="240"/>
  <div class="url">${appUrl}</div>
  <small>Se abre en el navegador · No requiere instalar nada</small>
</body></html>`);
});

// ── ATU Data endpoints ────────────────────────────────────────────────────────
// Rutas reales con polilíneas (para el mapa)
app.get('/api/routes_geo', (req, res) => {
  const limit  = parseInt(req.query.limit) || 80;
  const tipo   = req.query.tipo; // filtro opcional: PERIFERICA, DIAMETRAL, etc.
  let data = ATU_ROUTES_MAP;
  if (tipo) data = data.filter(r => r.tipo.toUpperCase().includes(tipo.toUpperCase()));
  res.json(data.slice(0, limit));
});

// Horas pico por sistema (cosac, linea1, corredores)
app.get('/api/peak_hours', (req, res) => res.json(ATU_PEAK_HOURS));

// Demanda por estación
app.get('/api/station_demand', (req, res) => res.json(ATU_STATION_DEMAND));

// Resumen estadístico
app.get('/api/atu_summary', (req, res) => res.json(ATU_SUMMARY));

// Paradas reales de Corredores Complementarios (201, 301, 401...)
app.get('/api/corredores', (req, res) => res.json(ATU_CORREDORES));
app.get('/api/corredores/:linea', (req, res) => {
  const c = ATU_CORREDORES.find(c => c.code === req.params.linea);
  if (!c) return res.status(404).json({ error: 'Línea no encontrada' });
  res.json(c);
});

// ── Traffic state endpoint ────────────────────────────────────────────────────
const _TRAFFIC_PI = { peak_am:0.25, peak_pm:0.30, shoulder:0.55, offpeak:0.70, night:0.90 };
const _TRAFFIC_V  = {
  brt:       { reg:42, irr:30, eta:1.00 },
  metro:     { reg:48, irr:48, eta:1.00 },
  diametral: { reg:25, irr: 9, eta:0.55 },
  radial:    { reg:22, irr: 8, eta:0.52 },
  periferica:{ reg:18, irr: 7, eta:0.50 },
};
function _currentPeriod() {
  const h = new Date().getHours();
  if (h >= 6  && h < 9)  return 'peak_am';
  if (h >= 17 && h < 20) return 'peak_pm';
  if ((h >= 9 && h < 11) || (h >= 14 && h < 17)) return 'shoulder';
  if (h >= 11 && h < 14) return 'offpeak';
  return 'night';
}

app.get('/api/traffic', (req, res) => {
  const period = _currentPeriod();
  const pi     = _TRAFFIC_PI[period];
  const buses  = sim.getBusesPublic();
  const speeds = Object.entries(_TRAFFIC_V).map(([type, v]) => ({
    type,
    expectedKmh: +((pi * v.reg + (1 - pi) * v.irr) * v.eta).toFixed(1),
    freeFlowKmh: +(v.reg * v.eta).toFixed(1),
    congestedKmh: +(v.irr * v.eta).toFixed(1),
  }));
  res.json({
    period,
    hour:      new Date().getHours(),
    pi,
    congestion: +(1 - pi).toFixed(2),
    speeds,
    buses: {
      total:     buses.length,
      moving:    buses.filter(b => b.status === 'moving').length,
      atStation: buses.filter(b => b.status === 'at_station').length,
    },
  });
});

app.get('/api/arrivals/:routeId/:stationId', (req, res) => {
  const arrivals = sim.getArrivals(req.params.routeId, parseInt(req.params.stationId));
  res.json(arrivals);
});

// Journey planner: origin → destination with transfers
app.get('/api/journey', (req, res) => {
  const { fromLat, fromLng, toLat, toLng } = req.query;
  if (!fromLat || !fromLng || !toLat || !toLng)
    return res.status(400).json({ error: 'Faltan parámetros: fromLat, fromLng, toLat, toLng' });
  const result = planJourney(
    parseFloat(fromLat), parseFloat(fromLng),
    parseFloat(toLat),   parseFloat(toLng),
    sim
  );
  res.json(result);
});

// 3 alternativas diversas — usado por el chatbot AgenteYATU
app.get('/api/journey/alternatives', (req, res) => {
  const { fromLat, fromLng, toLat, toLng } = req.query;
  if (!fromLat || !fromLng || !toLat || !toLng)
    return res.status(400).json({ error: 'Faltan parámetros: fromLat, fromLng, toLat, toLng' });
  const result = planJourneyAlternatives(
    parseFloat(fromLat), parseFloat(fromLng),
    parseFloat(toLat),   parseFloat(toLng),
    sim
  );
  res.json(result);
});

// Smart arrivals: filters by user walking time
app.get('/api/smart-arrivals', (req, res) => {
  const { lat, lng, routeId, stationId } = req.query;
  if (!lat || !lng || !routeId || stationId === undefined)
    return res.status(400).json({ error: 'Faltan parámetros: lat, lng, routeId, stationId' });

  const routes  = sim.getRoutes();
  const route   = routes.find(r => r.id === routeId);
  if (!route) return res.status(404).json({ error: 'Ruta no encontrada' });

  const station = route.stations.find(s => s.id === parseInt(stationId));
  if (!station) return res.status(404).json({ error: 'Estación no encontrada' });

  const WALK_SPEED_KMH = 4.8;
  const distKm         = haversine(parseFloat(lat), parseFloat(lng), station.lat, station.lng);
  const walkMin        = (distKm / WALK_SPEED_KMH) * 60;
  const walkSec        = walkMin * 60;

  const arrivals = sim.getArrivals(routeId, parseInt(stationId)).map(a => ({
    ...a,
    walkingMinutes: +walkMin.toFixed(1),
    catchable: a.seconds >= walkSec,
    marginMinutes: +((a.seconds - walkSec) / 60).toFixed(1),
  }));

  res.json({
    station,
    distanceKm:    +distKm.toFixed(3),
    walkingMinutes: +walkMin.toFixed(1),
    allArrivals:    arrivals,
    smartArrivals:  arrivals.filter(a => a.catchable),
  });
});

// ── Socket.io ──────────────────────────────────────────────────────────────────

io.on('connection', socket => {
  console.log(`[socket] conectado: ${socket.id}`);

  socket.emit('init', {
    routes:    sim.getRoutes(),
    buses:     sim.getBusesPublic(),
    incidents: events.getActiveIncidents(),
  });

  socket.on('request_arrivals', ({ routeId, stationId }) => {
    socket.emit('arrivals', {
      routeId, stationId,
      data: sim.getArrivals(routeId, stationId),
    });
  });

  socket.on('disconnect', () => console.log(`[socket] desconectado: ${socket.id}`));
});

// ── Loops ──────────────────────────────────────────────────────────────────────

setInterval(() => {
  sim.tick();
  const buses = sim.getBusesPublic();
  io.emit('buses_update', buses);
  firebase.writeBuses(buses);
}, 1000);

setInterval(() => {
  events.tick();
  const incidents = events.getActiveIncidents();
  io.emit('incidents_update', incidents);
  firebase.writeIncidents(incidents);
}, 30000);

// ── Start ──────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  const allRoutes = sim.getRoutes();
  const allBuses  = sim.getBusesPublic();
  const localIp   = '192.168.0.102';
  console.log(`\n🚇 ATU Simulator → http://localhost:${PORT}`);
  console.log(`📱 App móvil     → http://${localIp}:${PORT}/app`);
  console.log(`🔥 Firebase      → ${fbReady ? 'listo (desactivado)' : 'no configurado'}\n`);
  allRoutes.forEach(r => {
    const cnt = allBuses.filter(b => b.routeId === r.id).length;
    console.log(`   ${r.name}: ${r.stations.length} estaciones · ${cnt} vehículos`);
  });
  console.log();
});

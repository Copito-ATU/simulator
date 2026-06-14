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

// Velocidad del simulador — multiplica velocidad de movimiento y divide tiempos de espera
app.get('/api/sim/speed', (req, res) =>
  res.json({ multiplier: sim.getSpeedMultiplier() }));

app.post('/api/sim/speed', (req, res) => {
  const m = parseFloat(req.body.multiplier);
  if (!isFinite(m) || m <= 0) return res.status(400).json({ error: 'multiplier must be a positive number' });
  sim.setSpeedMultiplier(m);
  res.json({ ok: true, multiplier: sim.getSpeedMultiplier() });
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

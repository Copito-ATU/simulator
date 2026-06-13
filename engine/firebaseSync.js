const admin = require('firebase-admin');
const path  = require('path');
let db = null;

function init() {
  const keyPath = process.env.FIREBASE_KEY_PATH;
  const dbUrl   = process.env.FIREBASE_DATABASE_URL;

  if (!keyPath || !dbUrl) {
    console.log('[firebase] Credenciales no configuradas → sync desactivado (solo Socket.io)');
    return false;
  }

  try {
    const serviceAccount = require(path.resolve(process.cwd(), keyPath));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: dbUrl,
    });
    db = admin.database();
    console.log('[firebase] ✓ Conectado →', dbUrl);
    return true;
  } catch (e) {
    console.error('[firebase] Error al inicializar:', e.message);
    return false;
  }
}

function writeRoutes(routes) {
  if (!isEnabled()) return;
  const obj = {};
  routes.forEach(r => { obj[r.id] = r; });
  db.ref('/routes').set(obj).catch(e => console.error('[firebase] routes write:', e.message));
}

// Single batch update for all 282 buses — 1 write per second
function writeBuses(buses) {
  if (!isEnabled()) return;
  const updates = {};
  buses.forEach(b => { updates[`/buses/${b.id}`] = b; });
  db.ref('/').update(updates).catch(e => console.error('[firebase] buses write:', e.message));
}

function writeIncidents(incidents) {
  if (!isEnabled()) return;
  const obj = {};
  incidents.forEach(inc => { obj[inc.id] = inc; });
  db.ref('/incidents').set(obj).catch(e => console.error('[firebase] incidents write:', e.message));
}

function writeMeta(busCount) {
  if (!isEnabled()) return;
  db.ref('/meta').set({ busCount, lastUpdate: admin.database.ServerValue.TIMESTAMP })
    .catch(e => console.error('[firebase] meta write:', e.message));
}

function writeNoticias(data) {
  if (!db) return;
  db.ref('/noticias').set(data)
    .catch(e => console.error('[firebase] noticias write:', e.message));
}

function writeCorredores(corridorData) {
  if (!db) return;
  const obj = {};
  corridorData.forEach(c => { obj[c.id] = c; });
  db.ref('/corredores').set(obj)
    .catch(e => console.error('[firebase] corredores write:', e.message));
  console.log(`[firebase] ✓ ${corridorData.length} corredores subidos`);
}

function writeAtuData(routesMap, peakHours, stationDemand) {
  if (!db) return;
  // Sube solo top-80 rutas (para no exceder límites RTDB)
  const top80 = routesMap.slice(0, 80);
  const routesObj = {};
  top80.forEach(r => { routesObj[r.id] = r; });
  db.ref('/routes_geo').set(routesObj)
    .catch(e => console.error('[firebase] routes_geo write:', e.message));
  db.ref('/peak_hours').set(peakHours)
    .catch(e => console.error('[firebase] peak_hours write:', e.message));
  // Solo demanda total por estación (no byHour, para reducir tamaño)
  const demandSummary = { cosac: {}, linea1: {} };
  Object.entries(stationDemand.cosac || {}).forEach(([id, d]) => {
    demandSummary.cosac[id] = { name: d.name, total: d.total, peak: Math.max(...d.byHour) };
  });
  Object.entries(stationDemand.linea1 || {}).forEach(([id, d]) => {
    demandSummary.linea1[id] = { name: d.name, total: d.total, peak: Math.max(...d.byHour) };
  });
  db.ref('/station_demand').set(demandSummary)
    .catch(e => console.error('[firebase] station_demand write:', e.message));
  console.log('[firebase] ✓ ATU data uploaded (routes_geo, peak_hours, station_demand)');
}

let _enabled = false;

function setEnabled(val) {
  _enabled = val;
  console.log(`[firebase] sync ${_enabled ? '✓ ACTIVADO' : '✗ DESACTIVADO'}`);
}
function isEnabled() { return _enabled && db !== null; }

module.exports = { init, writeRoutes, writeBuses, writeIncidents, writeMeta, writeNoticias, writeAtuData, writeCorredores, setEnabled, isEnabled };

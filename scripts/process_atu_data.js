/**
 * Procesa los datos reales de la ATU y genera JSON optimizados
 * para el simulador y la app.
 *
 * Uso: node scripts/process_atu_data.js
 */
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../Datos_de_la_atu/RV_DATASET');
const OUT_DIR  = path.join(__dirname, '../data/atu');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Colores por tipo de ruta ──────────────────────────────────────────────────
function routeColor(tipo) {
  const t = (tipo || '').toUpperCase();
  if (t.includes('PERIFERICA'))  return '#8b5cf6';
  if (t.includes('DIAMETRAL'))   return '#3b82f6';
  if (t.includes('TRONCAL'))     return '#ef4444';
  if (t.includes('ALIMENTADOR')) return '#22c55e';
  return '#94a3b8'; // convencional → gris azulado
}

// ── Simplificar coordenadas (mantener máx N puntos) ──────────────────────────
function simplify(coords, maxPts = 60) {
  if (coords.length <= maxPts) return coords;
  const step = Math.ceil(coords.length / maxPts);
  const out = [];
  for (let i = 0; i < coords.length; i += step) out.push(coords[i]);
  const last = coords[coords.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

// ── Aplanar MultiLineString → [lng, lat][] ────────────────────────────────────
function flatten(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString')      return geometry.coordinates;
  if (geometry.type === 'MultiLineString') return geometry.coordinates.flat();
  return [];
}

// ── 1. Procesar rutas del GeoJSON ─────────────────────────────────────────────
console.log('\n📂 Leyendo prr_vf.geojson...');
const geojson = JSON.parse(
  fs.readFileSync(path.join(DATA_DIR, 'prr_vf.geojson'), 'utf8')
);
console.log(`   ${geojson.features.length} features`);

// Agrupar por código de ruta (combinar IDA + VUELTA)
const byRuta = {};
geojson.features.forEach(f => {
  const p   = f.properties;
  const key = p.ruta || p.route_name;
  if (!byRuta[key]) byRuta[key] = { ida: null, vuelta: null, p };
  if (p.sentido === 'IDA') byRuta[key].ida = f;
  else                     byRuta[key].vuelta = f;
});

const rutas = Object.entries(byRuta);
// Ordenar por flota descendente
rutas.sort((a, b) =>
  (parseInt(b[1].p.flota_operativa) || 0) - (parseInt(a[1].p.flota_operativa) || 0)
);
console.log(`   ${rutas.length} rutas únicas`);

// Limpiar nombre de vía (extraer solo el nombre sin número de cruce)
function cleanVia(str) {
  if (!str) return '';
  const part = str.replace(/^[^:]+:\s*/, ''); // quitar "DISTRITO: "
  const via = part.split('/')[0].trim();       // antes del primer "/"
  return via
    .replace(/^AVENIDA /i, 'Av. ')
    .replace(/^JIRON /i, 'Jr. ')
    .replace(/^CALLE /i, 'Ca. ')
    .replace(/^PASAJE /i, 'Pje. ')
    .slice(0, 30);
}

// Generar objetos de ruta con coords simplificadas
const routesMap = [];
rutas.forEach(([code, data]) => {
  const p     = data.p;
  const fleet = parseInt(p.flota_operativa) || 0;
  const raw   = flatten((data.ida || data.vuelta).geometry);
  if (raw.length < 4) return;

  const simplified = simplify(raw, 60);
  // GeoJSON: [lng, lat] → Leaflet: [lat, lng]
  const latlngs = simplified.map(c => [+(c[1].toFixed(6)), +(c[0].toFixed(6))]);

  const di = (p.distrito_inicio || '').replace(/\s+DE\s+/g,' ').replace('SAINT','SAN').trim();
  const df = (p.distrito_final   || '').replace(/\s+DE\s+/g,' ').replace('SAINT','SAN').trim();
  const fromVia = cleanVia(p.punto_inicio);
  const toVia   = cleanVia(p.punto_final);
  const displayName = di && df && di !== df
    ? `${di} → ${df}`
    : (di || df || code);

  routesMap.push({
    id:       `R${code}`,
    code,
    name:     `Ruta ${code}`,
    label:    displayName,
    color:    routeColor(p.tipo_de_ruta),
    tipo:     p.tipo_de_ruta || 'CONVENCIONAL',
    interval: parseInt(p.intervalo_paso) || 10,
    fleet,
    from:     fromVia || di,
    to:       toVia   || df,
    dist:     +(p.longitud_ruta || 0).toFixed(1),
    operador: (p.operador || '').replace(/\bSO?C?I?E?D?A?D?\s+AN[OÓ]NIMA\b.*$/i, '').replace(/\bSAC?\b.*$/i, '').trim(),
    carroceria: p.carroceria || 'OMNIBUS',
    categoria:  p.categoria  || 'M3',
    latlngs,
  });
});

// Guardar TODAS las rutas para el mapa (fondo)
fs.writeFileSync(
  path.join(OUT_DIR, 'routes_map.json'),
  JSON.stringify(routesMap)
);
console.log(`✅ routes_map.json — ${routesMap.length} rutas`);

// Top 40 rutas para el simulador (las de mayor flota)
const top40 = routesMap.slice(0, 40);

function extractWaypoints(latlngs, n, fromName, toName) {
  const count = n || 18;
  const step = Math.max(1, Math.floor(latlngs.length / count));
  const pts = [];
  for (let i = 0; i < latlngs.length; i += step) {
    const isFirst = pts.length === 0;
    const estName = isFirst && fromName ? fromName : `Parada ${pts.length + 1}`;
    pts.push({ id: pts.length, name: estName, lat: latlngs[i][0], lng: latlngs[i][1] });
  }
  // última parada con nombre real
  if (toName && pts.length > 0) {
    pts[pts.length - 1].name = toName;
  }
  return pts;
}

const routesSim = top40.map(r => ({
  id:        r.id,
  name:      `${r.name}: ${r.label}`,
  shortName: r.code,
  color:     r.color,
  type:      r.tipo.toLowerCase().replace(/ /g, '_'),
  interval:  r.interval,
  axis:      `${r.from} → ${r.to}`.slice(0, 60),
  operador:  r.operador,
  carroceria:r.carroceria,
  categoria: r.categoria,
  stations:  extractWaypoints(r.latlngs, 18, r.from, r.to),
  services: [{
    code:  r.code,
    label: `${r.name} — ${r.label}`,
    count: Math.min(Math.max(Math.floor(r.fleet / 3), 3), 12),
  }],
}));

fs.writeFileSync(
  path.join(OUT_DIR, 'routes_sim.json'),
  JSON.stringify(routesSim, null, 2)
);
console.log(`✅ routes_sim.json — top ${routesSim.length} rutas por flota`);

// ── 2. Horas pico desde validaciones ────────────────────────────────────────
console.log('\n📊 Procesando horas pico...');

function calcPeak(csvPath, separator = ',') {
  const byHour = new Array(24).fill(0);
  const lines  = fs.readFileSync(csvPath, 'utf8').split('\n').slice(1);
  lines.forEach(line => {
    if (!line.trim()) return;
    const p = line.split(separator);
    const h = parseInt(p[1]);
    const c = parseInt(p[p.length - 1]) || 0;
    if (h >= 0 && h < 24) byHour[h] += c;
  });
  const mx = Math.max(...byHour) || 1;
  return byHour.map(v => Math.round((v / mx) * 100));
}

const peakHours = {
  cosac:      calcPeak(path.join(DATA_DIR, 'validaciones/cosac_detalle.csv')),
  linea1:     calcPeak(path.join(DATA_DIR, 'validaciones/linea1_detalle.csv')),
  corredores: calcPeak(path.join(DATA_DIR, 'validaciones/corredoresC.csv'), ';'),
};
fs.writeFileSync(path.join(OUT_DIR, 'peak_hours.json'), JSON.stringify(peakHours));
console.log('✅ peak_hours.json');

// ── 3. Demanda por estación (COSAC + Línea 1) ─────────────────────────────────
console.log('\n🚉 Procesando demanda por estación...');

function calcStationDemand(csvPath, separator = ',') {
  const demand = {};
  const lines  = fs.readFileSync(csvPath, 'utf8').split('\n').slice(1);
  lines.forEach(line => {
    if (!line.trim()) return;
    const p    = line.split(separator);
    const h    = parseInt(p[1]);
    const stId = p[4]?.trim();
    const stNm = p[5]?.replace(/"/g, '').trim();
    const cnt  = parseInt(p[p.length - 1]) || 0;
    if (!stId || !stNm || h < 0 || h > 23) return;
    if (!demand[stId]) demand[stId] = { name: stNm, total: 0, byHour: new Array(24).fill(0) };
    demand[stId].byHour[h] += cnt;
    demand[stId].total     += cnt;
  });
  return demand;
}

const cosacDemand  = calcStationDemand(path.join(DATA_DIR, 'validaciones/cosac_detalle.csv'));
const linea1Demand = calcStationDemand(path.join(DATA_DIR, 'validaciones/linea1_detalle.csv'));

fs.writeFileSync(
  path.join(OUT_DIR, 'station_demand.json'),
  JSON.stringify({ cosac: cosacDemand, linea1: linea1Demand })
);
console.log('✅ station_demand.json');

// ── 4. Paradas de Corredores Complementarios ──────────────────────────────────
console.log('\n🚌 Procesando paradas de Corredores Complementarios...');

const CORREDOR_COLORS = {
  '201': '#a855f7', '204': '#9333ea', '206': '#7c3aed', '209': '#6d28d9',
  '301': '#ef4444', '303': '#dc2626', '305': '#b91c1c',
  '336': '#f97316', '357': '#ea580c',
  '401': '#3b82f6', '404': '#2563eb', '405': '#1d4ed8', '406': '#1e40af', '412': '#1e3a8a',
  '3180': '#10b981',
};
const CORREDOR_NAMES = {
  '201': 'Corredor 1 — Javier Prado',
  '204': 'Corredor 1 — Javier Prado',
  '206': 'Corredor 1 — Javier Prado',
  '209': 'Corredor 1 — Javier Prado',
  '301': 'Corredor 2 — Tacna/Arequipa',
  '303': 'Corredor 2 — Tacna/Arequipa',
  '305': 'Corredor 2 — Tacna/Arequipa',
  '336': 'Corredor 3',
  '357': 'Corredor 3',
  '401': 'Corredor 4 — SJL',
  '404': 'Corredor 4 — SJL',
  '405': 'Corredor 4 — SJL',
  '406': 'Corredor 4 — SJL',
  '412': 'Corredor 4 — SJL',
  '3180': 'Corredor Especial',
};

const corridorStops = {};
try {
  const corrCsv = fs.readFileSync(
    path.join(DATA_DIR, 'validaciones/corredoresC.csv'), 'utf8'
  );
  corrCsv.split('\n').slice(1).forEach(line => {
    if (!line.trim()) return;
    const p = line.split(';');
    if (p.length < 10) return;
    const linea = p[5].replace(/"/g, '').trim();
    const nomb  = p[7].replace(/"/g, '').trim();
    const desc  = p[8].replace(/"/g, '').trim();
    const sentido = p[9].replace(/"/g, '').trim();
    if (!linea || !nomb || !desc) return;
    if (!corridorStops[linea]) corridorStops[linea] = {};
    if (!corridorStops[linea][nomb]) {
      corridorStops[linea][nomb] = { name: desc, sentido };
    }
  });
} catch(e) { console.warn('  corredoresC.csv no disponible'); }

const corridorData = Object.entries(corridorStops).map(([linea, stops]) => ({
  id:    `C${linea}`,
  code:  linea,
  name:  `Línea ${linea}`,
  label: CORREDOR_NAMES[linea] || `Corredor ${linea}`,
  color: CORREDOR_COLORS[linea] || '#64748b',
  stops: Object.entries(stops).map(([code, s], i) => ({
    id: i, code, name: s.name, sentido: s.sentido,
  })),
}));

fs.writeFileSync(
  path.join(OUT_DIR, 'corredores_stops.json'),
  JSON.stringify(corridorData, null, 2)
);
console.log(`✅ corredores_stops.json — ${corridorData.length} líneas, ${
  corridorData.reduce((s,c) => s + c.stops.length, 0)
} paradas totales`);

// ── 5. Resumen de estadísticas ────────────────────────────────────────────────
const totalFleet = routesMap.reduce((s, r) => s + r.fleet, 0);
const byTipo     = {};
routesMap.forEach(r => { byTipo[r.tipo] = (byTipo[r.tipo] || 0) + 1; });

const summary = {
  totalRoutes:   routesMap.length,
  totalFleet,
  byTipo,
  topRoutes:     top40.map(r => ({ code: r.code, name: r.name, label: r.label, fleet: r.fleet, interval: r.interval })),
  peakAM:        '06:00–08:00',
  peakPM:        '17:00–19:00',
  cosacStations: Object.keys(cosacDemand).length,
  linea1Stations:Object.keys(linea1Demand).length,
  corridorLines: corridorData.length,
};

fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

console.log('\n📈 Resumen:');
console.log(`   Rutas totales:  ${summary.totalRoutes}`);
console.log(`   Flota total:    ${summary.totalFleet} buses`);
console.log(`   Estaciones COSAC:   ${summary.cosacStations}`);
console.log(`   Estaciones Línea 1: ${summary.linea1Stations}`);
console.log(`   Líneas Corredores:  ${summary.corridorLines}`);
console.log('\n✅ Procesamiento completo →', OUT_DIR);

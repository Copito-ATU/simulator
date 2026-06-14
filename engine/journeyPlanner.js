const ROUTES = require('../data/routes.json');

const WALK_KMH        = 4.8;
const BUS_KMH         = 18;
const DWELL_PER_STOP  = 1.5;
const MAX_WALK_KM     = 1.5;
const MAX_WALK_BRT    = 2.5;
const MAX_TRANSFER_KM = 0.6;
const MAX_TRANSFER_BRT= 1.0;

const SPEED_BY_TYPE = {
  brt:        42,
  metro:      48,
  diametral:  18,
  radial:     15,
  periferica: 12,
  circular:   16,
};
const SCORE_BONUS = { brt: 6, metro: 5 };

// ── Utilidades ────────────────────────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, d2r = Math.PI / 180;
  const dLat = (lat2 - lat1) * d2r, dLng = (lng2 - lng1) * d2r;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*d2r)*Math.cos(lat2*d2r)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function walkMin(km) { return (km / WALK_KMH) * 60; }
function getRoute(id) { return ROUTES.find(r => r.id === id); }

function estimateRideMin(routeId, fromIdx, toIdx) {
  const route = getRoute(routeId);
  if (!route || fromIdx === toIdx) return 0;
  const sts = route.stations;
  const s = Math.min(fromIdx, toIdx), e = Math.max(fromIdx, toIdx);
  let km = 0;
  for (let i = s; i < e; i++)
    km += haversine(sts[i].lat, sts[i].lng, sts[i+1].lat, sts[i+1].lng);
  const spd = SPEED_BY_TYPE[route.type] || BUS_KMH;
  return (km / spd) * 60 + Math.abs(toIdx - fromIdx) * DWELL_PER_STOP;
}

// ── Precalcular transbordos entre rutas (al cargar) ──────────────────────────
// Para cada par de rutas, guarda los pares de estaciones que están a ≤ MAX_TRANSFER_KM
let _transfers = null;
let _bboxes    = null;

function _buildBboxes() {
  if (_bboxes) return _bboxes;
  _bboxes = ROUTES.map(r => {
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    for (const s of r.stations) {
      if (s.lat < minLat) minLat = s.lat;
      if (s.lat > maxLat) maxLat = s.lat;
      if (s.lng < minLng) minLng = s.lng;
      if (s.lng > maxLng) maxLng = s.lng;
    }
    return { minLat, maxLat, minLng, maxLng };
  });
  return _bboxes;
}

function buildTransfers() {
  if (_transfers) return _transfers;
  const bboxes = _buildBboxes();
  const BUF = 0.02; // ~2.2 km in degrees — larger than any MAX_TRANSFER value
  _transfers = [];
  for (let i = 0; i < ROUTES.length; i++) {
    for (let j = i + 1; j < ROUTES.length; j++) {
      const bA = bboxes[i], bB = bboxes[j];
      if (bA.maxLat + BUF < bB.minLat || bA.minLat - BUF > bB.maxLat) continue;
      if (bA.maxLng + BUF < bB.minLng || bA.minLng - BUF > bB.maxLng) continue;
      const rA = ROUTES[i], rB = ROUTES[j];
      const isBrt = (r) => r.type === 'brt' || r.type === 'metro';
      const maxTr = (isBrt(rA) || isBrt(rB)) ? MAX_TRANSFER_BRT : MAX_TRANSFER_KM;
      let bestDist = Infinity, bestPair = null;
      for (const stA of rA.stations) {
        for (const stB of rB.stations) {
          const d = haversine(stA.lat, stA.lng, stB.lat, stB.lng);
          if (d < maxTr && d < bestDist) {
            bestDist = d;
            bestPair = { rA: rA.id, stA: stA.id, rB: rB.id, stB: stB.id, walkKm: d };
          }
        }
      }
      if (bestPair) _transfers.push(bestPair);
    }
  }
  console.log(`[journeyPlanner] ${_transfers.length} conexiones de transbordo pre-calculadas`);
  return _transfers;
}

// ── Estaciones cercanas al punto dado ─────────────────────────────────────────
function nearestPerRoute(lat, lng, maxKm = MAX_WALK_KM) {
  return ROUTES.flatMap(route => {
    const isBrt = route.type === 'brt' || route.type === 'metro';
    const limit  = isBrt ? Math.max(maxKm, MAX_WALK_BRT) : maxKm;
    let best = null, bestD = Infinity;
    route.stations.forEach(st => {
      const d = haversine(lat, lng, st.lat, st.lng);
      if (d < bestD) { bestD = d; best = st; }
    });
    if (bestD > limit || !best) return [];
    return [{ routeId: route.id, routeName: route.name, routeColor: route.color, routeType: route.type, station: best, walkKm: bestD }];
  }).sort((a, b) => a.walkKm - b.walkKm);
}

function nextBusAt(sim, routeId, stationId) {
  const arr = sim?.getArrivals ? sim.getArrivals(routeId, stationId) : [];
  return arr[0] || { seconds: 180, serviceCode: '—', direction: '' };
}

// ── Constructores de legs ─────────────────────────────────────────────────────
function legWalk(label, to, distKm) {
  return { type: 'walk', label, to, distKm: +distKm.toFixed(3), minutes: Math.max(1, Math.round(walkMin(distKm))) };
}
function legWait(sim, routeId, routeName, routeColor, at, stationId) {
  const nb = nextBusAt(sim, routeId, stationId);
  return { type: 'wait', at, routeId, routeName, routeColor, serviceCode: nb.serviceCode, direction: nb.direction, seconds: nb.seconds, minutes: Math.max(1, Math.round(nb.seconds / 60)) };
}
function legBus(routeId, routeName, routeColor, from, to, fromId, toId, minutes) {
  return { type: 'bus', routeId, routeName, routeColor, from, to, stops: Math.abs(toId - fromId), minutes: Math.max(1, Math.round(minutes)) };
}
function legTransfer(from, to, walkKm) {
  return { type: 'transfer', label: 'Transbordo a pie', from, to, walkKm: +walkKm.toFixed(3), minutes: Math.max(1, Math.round(walkMin(walkKm))) };
}

// ── Planificador principal ────────────────────────────────────────────────────
function planJourney(fromLat, fromLng, toLat, toLng, sim) {
  const transfers = buildTransfers();

  const origins = nearestPerRoute(fromLat, fromLng);
  const dests   = nearestPerRoute(toLat, toLng);

  if (!origins.length || !dests.length) {
    return { error: 'No hay paradas cercanas. Intenta un destino dentro de Lima Metropolitana.' };
  }

  let best = null, bestTotal = Infinity;

  function tryJourney(legs, totalMin, numTransfers) {
    const bonus = legs.filter(l => l.type === 'bus').reduce((acc, l) => {
      const r = getRoute(l.routeId); return acc + (SCORE_BONUS[r?.type] || 0);
    }, 0);
    const scored = totalMin - bonus;
    if (scored < bestTotal) {
      bestTotal = scored;
      best = { legs, totalMinutes: Math.round(totalMin), transfers: numTransfers };
    }
  }

  const TOP_O = origins.slice(0, 6);
  const TOP_D = dests.slice(0, 6);

  // ── Opción A: Ruta directa ──────────────────────────────────────────────
  for (const o of TOP_O) {
    for (const d of TOP_D) {
      if (o.routeId !== d.routeId) continue;
      if (o.station.id === d.station.id) continue;

      const ride  = estimateRideMin(o.routeId, o.station.id, d.station.id);
      const wait  = nextBusAt(sim, o.routeId, o.station.id).seconds / 60;
      const total = walkMin(o.walkKm) + wait + ride + walkMin(d.walkKm);

      const route = getRoute(o.routeId);
      tryJourney([
        legWalk('Camina a la parada', o.station.name, o.walkKm),
        legWait(sim, o.routeId, route.name, route.color, o.station.name, o.station.id),
        legBus(o.routeId, route.name, route.color, o.station.name, d.station.name, o.station.id, d.station.id, ride),
        legWalk('Camina a tu destino', 'Tu destino', d.walkKm),
      ], total, 0);
    }
  }

  // ── Opción B: Un transbordo (geográfico automático) ─────────────────────
  const originIds = new Set(TOP_O.map(o => o.routeId));
  const destIds   = new Set(TOP_D.map(d => d.routeId));

  for (const tr of transfers) {
    // tr.rA → tr.rB  o  tr.rB → tr.rA
    const pairs = [];
    if (originIds.has(tr.rA) && destIds.has(tr.rB)) pairs.push({ boarding: tr.rA, alighting: tr.rA, trStA: tr.stA, trStB: tr.stB, trWalk: tr.walkKm, connecting: tr.rB });
    if (originIds.has(tr.rB) && destIds.has(tr.rA)) pairs.push({ boarding: tr.rB, alighting: tr.rB, trStA: tr.stB, trStB: tr.stA, trWalk: tr.walkKm, connecting: tr.rA });

    for (const p of pairs) {
      const rOrigin = getRoute(p.boarding);
      const rDest   = getRoute(p.connecting);
      if (!rOrigin || !rDest) continue;

      const o = TOP_O.find(x => x.routeId === p.boarding);
      const d = TOP_D.find(x => x.routeId === p.connecting);
      if (!o || !d) continue;

      const stTrA = rOrigin.stations[p.trStA];
      const stTrB = rDest.stations[p.trStB];
      if (!stTrA || !stTrB) continue;

      // Verificar que el transbordo esté en la dirección correcta
      const dFromOriginToTransfer = haversine(o.station.lat, o.station.lng, stTrA.lat, stTrA.lng);
      const dFromTransferToDest   = haversine(stTrB.lat, stTrB.lng, d.station.lat, d.station.lng);
      // Descartar si el transbordo aleja del destino más de lo razonable
      const directDist = haversine(fromLat, fromLng, toLat, toLng);
      if (dFromTransferToDest > directDist * 2.5) continue;

      const rideA  = estimateRideMin(p.boarding,   o.station.id, p.trStA);
      const rideB  = estimateRideMin(p.connecting, p.trStB,      d.station.id);
      const waitA  = nextBusAt(sim, p.boarding,   o.station.id).seconds / 60;
      const waitB  = nextBusAt(sim, p.connecting, p.trStB).seconds / 60;
      const total  = walkMin(o.walkKm) + waitA + rideA + walkMin(p.trWalk) + waitB + rideB + walkMin(d.walkKm);

      tryJourney([
        legWalk('Camina a la parada', o.station.name, o.walkKm),
        legWait(sim, p.boarding, rOrigin.name, rOrigin.color, o.station.name, o.station.id),
        legBus(p.boarding, rOrigin.name, rOrigin.color, o.station.name, stTrA.name, o.station.id, p.trStA, rideA),
        legTransfer(stTrA.name, stTrB.name, p.trWalk),
        legWait(sim, p.connecting, rDest.name, rDest.color, stTrB.name, p.trStB),
        legBus(p.connecting, rDest.name, rDest.color, stTrB.name, d.station.name, p.trStB, d.station.id, rideB),
        legWalk('Camina a tu destino', 'Tu destino', d.walkKm),
      ], total, 1);
    }
  }

  // ── Fallback: mejor acercamiento ───────────────────────────────────────
  if (!best) {
    const o = TOP_O[0], d = TOP_D[0];
    const route = getRoute(o.routeId);
    const waitA  = nextBusAt(sim, o.routeId, o.station.id).seconds / 60;
    // Ir hasta la estación más cercana al destino en la misma ruta
    let closestStIdx = 0, closestStDist = Infinity;
    route.stations.forEach((st, idx) => {
      const dist = haversine(st.lat, st.lng, toLat, toLng);
      if (dist < closestStDist) { closestStDist = dist; closestStIdx = idx; }
    });
    const ride  = estimateRideMin(o.routeId, o.station.id, closestStIdx);
    const total = walkMin(o.walkKm) + waitA + ride + walkMin(closestStDist);
    best = {
      legs: [
        legWalk('Camina a la parada', o.station.name, o.walkKm),
        legWait(sim, o.routeId, route.name, route.color, o.station.name, o.station.id),
        legBus(o.routeId, route.name, route.color, o.station.name, route.stations[closestStIdx]?.name || 'Parada cercana', o.station.id, closestStIdx, ride),
        legWalk('Camina al destino', 'Tu destino', closestStDist),
      ],
      totalMinutes: Math.round(total),
      transfers: 0,
      note: 'Ruta de acercamiento — puede requerir conexión local en el tramo final',
    };
  }

  return best;
}

// ── Planificador con múltiples alternativas (para chatbot / picker) ───────────
function busTypeId(route) {
  if (!route) return 'omnibus';
  if (route.id === 'METRO')        return 'metropolitano';
  if (route.id === 'LINEA1')       return 'linea1';
  if (route.id?.startsWith('C'))   return 'corredor';
  const c = (route.carroceria || '').toUpperCase();
  if (c.includes('MICRO'))         return 'microbus';
  if (c.includes('MINI'))          return 'minibus';
  return 'omnibus';
}

function getPrimaryKey(journey) {
  return journey.legs.filter(l => l.type === 'bus').map(l => l.routeId).join('+');
}

function labelAlternative(alt, isFirst) {
  if (isFirst) return 'Más rápida';
  const busLegs = alt.legs.filter(l => l.type === 'bus');
  if (busLegs.some(l => l.routeId === 'METRO'))  return 'Con Metropolitano';
  if (busLegs.some(l => l.routeId === 'LINEA1')) return 'Con Línea 1';
  if (busLegs.some(l => l.routeId?.startsWith('C'))) return 'Corredor exclusivo';
  if (alt.transfers === 0)                        return 'Sin transbordo';
  return 'Alternativa';
}

function pickDiverse(candidates, maxN) {
  const seen = new Set(), result = [];
  for (const c of candidates) {
    if (result.length >= maxN) break;
    const key = getPrimaryKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    c.routeLabel = labelAlternative(c, result.length === 0);
    result.push(c);
  }
  return result;
}

function planJourneyAlternatives(fromLat, fromLng, toLat, toLng, sim) {
  const transfers = buildTransfers();
  const origins   = nearestPerRoute(fromLat, fromLng);
  const dests     = nearestPerRoute(toLat, toLng);

  if (!origins.length || !dests.length) {
    return { error: 'No hay paradas cercanas. Intenta un destino dentro de Lima Metropolitana.' };
  }

  const candidates = [];

  function tryJourney(legs, totalMin, numTransfers) {
    const bonus = legs.filter(l => l.type === 'bus').reduce((acc, l) => {
      const r = getRoute(l.routeId); return acc + (SCORE_BONUS[r?.type] || 0);
    }, 0);
    candidates.push({ legs, totalMinutes: Math.round(totalMin), _scored: totalMin - bonus, transfers: numTransfers });
  }

  const TOP_O = origins.slice(0, 8);
  const TOP_D = dests.slice(0, 8);

  // Opción A: ruta directa
  for (const o of TOP_O) {
    for (const d of TOP_D) {
      if (o.routeId !== d.routeId || o.station.id === d.station.id) continue;
      const route = getRoute(o.routeId);
      if (!route) continue;
      const ride  = estimateRideMin(o.routeId, o.station.id, d.station.id);
      const wait  = nextBusAt(sim, o.routeId, o.station.id).seconds / 60;
      const total = walkMin(o.walkKm) + wait + ride + walkMin(d.walkKm);
      tryJourney([
        legWalk('Camina a la parada', o.station.name, o.walkKm),
        legWait(sim, o.routeId, route.name, route.color, o.station.name, o.station.id),
        legBus(o.routeId, route.name, route.color, o.station.name, d.station.name, o.station.id, d.station.id, ride),
        legWalk('Camina a tu destino', 'Tu destino', d.walkKm),
      ], total, 0);
    }
  }

  // Opción B: un transbordo
  const originIds  = new Set(TOP_O.map(o => o.routeId));
  const destIds    = new Set(TOP_D.map(d => d.routeId));
  const directDist = haversine(fromLat, fromLng, toLat, toLng);

  for (const tr of transfers) {
    const pairs = [];
    if (originIds.has(tr.rA) && destIds.has(tr.rB))
      pairs.push({ boarding: tr.rA, trStA: tr.stA, trStB: tr.stB, connecting: tr.rB, trWalk: tr.walkKm });
    if (originIds.has(tr.rB) && destIds.has(tr.rA))
      pairs.push({ boarding: tr.rB, trStA: tr.stB, trStB: tr.stA, connecting: tr.rA, trWalk: tr.walkKm });

    for (const p of pairs) {
      const rOrigin = getRoute(p.boarding), rDest = getRoute(p.connecting);
      if (!rOrigin || !rDest) continue;
      const o = TOP_O.find(x => x.routeId === p.boarding);
      const d = TOP_D.find(x => x.routeId === p.connecting);
      if (!o || !d) continue;
      const stTrA = rOrigin.stations[p.trStA], stTrB = rDest.stations[p.trStB];
      if (!stTrA || !stTrB) continue;
      if (haversine(stTrB.lat, stTrB.lng, d.station.lat, d.station.lng) > directDist * 2.5) continue;

      const rideA = estimateRideMin(p.boarding, o.station.id, p.trStA);
      const rideB = estimateRideMin(p.connecting, p.trStB, d.station.id);
      const waitA = nextBusAt(sim, p.boarding, o.station.id).seconds / 60;
      const waitB = nextBusAt(sim, p.connecting, p.trStB).seconds / 60;
      const total = walkMin(o.walkKm) + waitA + rideA + walkMin(p.trWalk) + waitB + rideB + walkMin(d.walkKm);

      tryJourney([
        legWalk('Camina a la parada', o.station.name, o.walkKm),
        legWait(sim, p.boarding, rOrigin.name, rOrigin.color, o.station.name, o.station.id),
        legBus(p.boarding, rOrigin.name, rOrigin.color, o.station.name, stTrA.name, o.station.id, p.trStA, rideA),
        legTransfer(stTrA.name, stTrB.name, p.trWalk),
        legWait(sim, p.connecting, rDest.name, rDest.color, stTrB.name, p.trStB),
        legBus(p.connecting, rDest.name, rDest.color, stTrB.name, d.station.name, p.trStB, d.station.id, rideB),
        legWalk('Camina a tu destino', 'Tu destino', d.walkKm),
      ], total, 1);
    }
  }

  if (!candidates.length) {
    return { error: `No se encontró ruta entre esos puntos. Intenta con direcciones dentro de Lima Metropolitana.` };
  }

  candidates.sort((a, b) => a._scored - b._scored);
  return { alternatives: pickDiverse(candidates, 3) };
}

module.exports = { planJourney, planJourneyAlternatives, haversine };

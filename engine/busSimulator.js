const ROUTES = require('../data/routes.json');

// ── Haversine ─────────────────────────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function buildSegDists(stations) {
  const d = [];
  for (let i = 0; i < stations.length - 1; i++)
    d.push(haversine(stations[i].lat, stations[i].lng, stations[i+1].lat, stations[i+1].lng));
  return d;
}

ROUTES.forEach(r => { r._dists = buildSegDists(r.stations); });

// ── Traffic model — ATU Lima (atu-master/models/travel_time_uncertainty.py) ───
//
// PI_FREE_FLOW: probability that a given segment is in free-flow mode.
// Source: calibrated from 62 days of Waze speed data across Lima.
const PI_FREE_FLOW = {
  peak_am:  0.25,   // 06:00–09:00  heavy congestion
  peak_pm:  0.30,   // 17:00–20:00  heavy congestion
  shoulder: 0.55,   // 09:00–11:00 & 14:00–17:00
  offpeak:  0.70,   // 11:00–14:00  midday valley
  night:    0.90,   // 20:00–06:00  near free-flow
};

// Per-route-type speeds (km/h) — from waze_tramos.parquet aggregated by corridor type
// v_reg = free-flow, v_irr = congested (Waze irregular)
const V_SPEEDS = {
  brt:       { reg: 42, irr: 30 }, // Vía Expresa dedicated busway
  metro:     { reg: 48, irr: 48 }, // Línea 1 rail — traffic-independent
  diametral: { reg: 25, irr:  9 }, // Major cross-city arteries
  radial:    { reg: 22, irr:  8 }, // Secondary arteries toward centre
  periferica:{ reg: 18, irr:  7 }, // Peripheral / local streets
};

// Vehicle efficiency η (Tirachini 2013) — commercial speed / traffic speed.
// Accounts for dwell time, bus stops, door exchange.
// When v_traffic < 10 km/h (severe congestion) dwell penalty drops → η bumped +0.15.
const ETA = {
  brt:       1.00, // dedicated lane — no interference
  metro:     1.00, // rail
  diametral: 0.55,
  radial:    0.52,
  periferica:0.50,
};

// Dwell time parameters (seconds) per route type.
// base: median stop time, var: random extra, peakMult: factor at peak hours.
// Peak dwell 2-3× longer — high boarding demand per validaciones_cosac data.
const DWELL_PARAMS = {
  brt:       { base: 22, var: 12, peakMult: 1.8 },
  metro:     { base: 30, var: 10, peakMult: 1.5 },
  diametral: { base: 12, var: 15, peakMult: 2.6 },
  radial:    { base: 10, var: 12, peakMult: 2.5 },
  periferica:{ base:  8, var: 12, peakMult: 2.8 },
};

function getTimePeriod() {
  const h = new Date().getHours();
  if (h >= 6  && h < 9)  return 'peak_am';
  if (h >= 17 && h < 20) return 'peak_pm';
  if ((h >= 9 && h < 11) || (h >= 14 && h < 17)) return 'shoulder';
  if (h >= 11 && h < 14) return 'offpeak';
  return 'night';
}

// Returns km/s for the current moment given route type.
// Each call is a fresh draw from the stochastic traffic model.
function getSpeedKmS(routeType) {
  const period    = getTimePeriod();
  const pi        = PI_FREE_FLOW[period];
  const spd       = V_SPEEDS[routeType]  || V_SPEEDS.diametral;
  const eta_base  = ETA[routeType]       || 0.55;

  const freeFlow  = Math.random() < pi;
  const v_traffic = freeFlow ? spd.reg : spd.irr;

  // Tirachini dynamic adjustment: when severely congested, dwell penalty smaller
  const eta = v_traffic < 10 ? Math.min(eta_base + 0.15, 0.85) : eta_base;

  return (v_traffic * eta) / 3600;
}

// Returns dwell seconds for the current moment.
function getDwellSecs(routeType) {
  const period = getTimePeriod();
  const d      = DWELL_PARAMS[routeType] || DWELL_PARAMS.diametral;
  const mult   = (period === 'peak_am' || period === 'peak_pm') ? d.peakMult : 1.0;
  return Math.round((d.base + Math.random() * d.var) * mult);
}

// ── Bus factory ───────────────────────────────────────────────────────────────
let _nextId = 1;

function makeBuses() {
  const buses = [];
  ROUTES.forEach(route => {
    const N = route.stations.length;
    let svcOffset = 0;
    route.services.forEach(svc => {
      for (let i = 0; i < svc.count; i++) {
        const dir = i % 2 === 0 ? 'N' : 'S';
        const fraction = ((i + svcOffset * 0.37 + Math.random() * 0.2) / svc.count) % 1;
        const segIdx = Math.floor(fraction * (N - 1));
        svcOffset++;
        buses.push({
          id:             `B${String(_nextId++).padStart(2,'0')}`,
          routeId:        route.id,
          routeName:      route.name,
          routeColor:     route.color,
          routeType:      route.type,
          serviceCode:    svc.code,
          serviceLabel:   svc.label,
          segIdx:         Math.max(0, Math.min(segIdx, N - 2)),
          progress:       Math.random(),
          direction:      dir,
          dwellRemaining: 0,
          status:         'moving',
          // Current segment speed (km/s) — resampled at each stop
          _speedKmS:      getSpeedKmS(route.type),
          lat: 0, lng: 0,
        });
      }
    });
  });
  buses.forEach(b => _calcPos(b));
  return buses;
}

function _route(id) { return ROUTES.find(r => r.id === id); }

function _calcPos(bus) {
  const { stations } = _route(bus.routeId);
  const from = stations[bus.segIdx];
  const to   = stations[bus.segIdx + 1];
  if (!to) { bus.lat = from.lat; bus.lng = from.lng; return; }
  const p = bus.direction === 'N' ? bus.progress : 1 - bus.progress;
  bus.lat = from.lat + (to.lat - from.lat) * p;
  bus.lng = from.lng + (to.lng - from.lng) * p;
}

// ── Simulator ─────────────────────────────────────────────────────────────────
class BusSimulator {
  constructor() {
    this.buses = makeBuses();
    this.speedMultiplier = 1.0;
  }

  setSpeedMultiplier(m) { this.speedMultiplier = Math.max(0.25, Math.min(20, m)); }
  getSpeedMultiplier()  { return this.speedMultiplier; }

  getBusCountByRoute() {
    const counts = {};
    this.buses.forEach(b => { counts[b.routeId] = (counts[b.routeId] || 0) + 1; });
    return counts;
  }

  addBuses(routeId, count = 1) {
    const route = _route(routeId);
    if (!route) return false;
    const N   = route.stations.length;
    const svc = route.services?.[0] || { code: route.id, label: route.name };
    for (let i = 0; i < count; i++) {
      const segIdx = Math.floor(Math.random() * (N - 1));
      const bus = {
        id:             `B${String(_nextId++).padStart(3,'0')}`,
        routeId:        route.id,
        routeName:      route.name,
        routeColor:     route.color,
        routeType:      route.type,
        serviceCode:    svc.code,
        serviceLabel:   svc.label,
        segIdx:         Math.max(0, Math.min(segIdx, N - 2)),
        progress:       Math.random(),
        direction:      Math.random() < 0.5 ? 'N' : 'S',
        dwellRemaining: 0,
        status:         'moving',
        _speedKmS:      getSpeedKmS(route.type),
        lat: 0, lng: 0,
      };
      _calcPos(bus);
      this.buses.push(bus);
    }
    return true;
  }

  removeBuses(routeId, count = 1) {
    let removed = 0;
    for (let i = this.buses.length - 1; i >= 0 && removed < count; i--) {
      if (this.buses[i].routeId === routeId) { this.buses.splice(i, 1); removed++; }
    }
    return removed;
  }

  tick() {
    const mult = this.speedMultiplier;
    this.buses.forEach(bus => {
      if (bus.dwellRemaining > 0) {
        bus.dwellRemaining = Math.max(0, bus.dwellRemaining - mult);
        bus.status = 'at_station';
        if (bus.dwellRemaining > 0) return;
      }

      const route = _route(bus.routeId);
      const N     = route.stations.length;
      const dist  = route._dists[bus.segIdx] || 0.5;

      bus.status = 'moving';
      bus.progress += (bus._speedKmS * mult) / dist;

      if (bus.progress >= 1) {
        bus.progress = 0;

        if (bus.direction === 'N') {
          bus.segIdx++;
          if (bus.segIdx >= N - 1) { bus.direction = 'S'; bus.segIdx = N - 2; }
        } else {
          bus.segIdx--;
          if (bus.segIdx < 0)      { bus.direction = 'N'; bus.segIdx = 0; }
        }

        // Resample speed and dwell; dwell divided by multiplier so it scales with speed
        bus._speedKmS      = getSpeedKmS(route.type);
        bus.dwellRemaining = Math.ceil(getDwellSecs(route.type) / mult);
        bus.status         = 'at_station';
      }

      _calcPos(bus);
    });
  }

  getArrivals(routeId, stationId) {
    const route = _route(routeId);
    if (!route) return [];
    const arrivals = [];
    this.buses.filter(b => b.routeId === routeId).forEach(bus => {
      const secs = _timeToStation(bus, route, stationId);
      if (secs !== null && secs < 3600)
        arrivals.push({
          busId:        bus.id,
          serviceCode:  bus.serviceCode,
          serviceLabel: bus.serviceLabel,
          seconds:      Math.round(secs),
          minutes:      +(secs / 60).toFixed(1),
          direction:    bus.direction === 'N'
            ? route.stations[route.stations.length - 1].name
            : route.stations[0].name,
        });
    });
    return arrivals.sort((a, b) => a.seconds - b.seconds).slice(0, 8);
  }

  getRoutes() {
    return ROUTES.map(({ id, name, shortName, color, type, axis, stations }) =>
      ({ id, name, shortName: shortName ?? null, color, type, axis: axis ?? null, stations }));
  }

  getBusesPublic() {
    return this.buses.map(b => ({
      id:             b.id,
      routeId:        b.routeId,
      routeName:      b.routeName,
      routeColor:     b.routeColor,
      routeType:      b.routeType,
      serviceCode:    b.serviceCode,
      serviceLabel:   b.serviceLabel,
      lat:            b.lat,
      lng:            b.lng,
      direction:      b.direction,
      status:         b.status,
      dwellRemaining: b.dwellRemaining || 0,
    }));
  }
}

// ── Arrival prediction ────────────────────────────────────────────────────────
function _timeToStation(bus, route, targetId) {
  const { stations, _dists } = route;
  const N = stations.length;
  // Use bus's current segment speed for projection
  const speedKmS = bus._speedKmS || getSpeedKmS(route.type);
  let segIdx = bus.segIdx, progress = bus.progress, dir = bus.direction,
      dwell = bus.dwellRemaining, total = 0;

  if (dwell > 0) {
    const atId = dir === 'N' ? segIdx : segIdx + 1;
    if (atId === targetId) return 0;
    total += dwell;
    progress = 0;
  }

  for (let step = 0; step < N * 3; step++) {
    const dist   = _dists[segIdx] || 0.5;
    const remain = (1 - progress) * dist / speedKmS;
    total       += remain;
    const arrId  = dir === 'N' ? segIdx + 1 : segIdx;
    if (arrId === targetId) return total;
    if      (dir === 'N' && segIdx + 1 >= N - 1) dir = 'S';
    else if (dir === 'S' && segIdx <= 0)          dir = 'N';
    else if (dir === 'N') segIdx++;
    else segIdx--;
    total   += getDwellSecs(route.type);
    progress = 0;
    if (total > 3600) return null;
  }
  return null;
}

module.exports = { BusSimulator, haversine };

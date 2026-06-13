const stations = require('../data/stations.json');

const INCIDENT_TYPES = [
  { type: 'accident',   label: 'Accidente de tránsito', severity: 'high',   icon: '🚨', durationMin: 15, durationMax: 45 },
  { type: 'congestion', label: 'Congestión vehicular',  severity: 'medium', icon: '🚦', durationMin: 10, durationMax: 30 },
  { type: 'closure',    label: 'Cierre de vía',         severity: 'high',   icon: '🚧', durationMin: 20, durationMax: 60 },
  { type: 'breakdown',  label: 'Avería de unidad',      severity: 'low',    icon: '🔧', durationMin: 5,  durationMax: 20 },
];

// Probability of a new incident per 30-second tick (≈1 incident every ~8 min on average)
const INCIDENT_PROBABILITY = 0.065;

let _nextId = 1;

class EventEngine {
  constructor() {
    this.incidents = [];
  }

  tick() {
    // Expire old incidents
    const now = Date.now();
    this.incidents = this.incidents.filter(inc => now < inc.expiresAt);

    // Maybe generate a new incident
    if (Math.random() < INCIDENT_PROBABILITY && this.incidents.length < 4) {
      this._generateIncident();
    }
  }

  _generateIncident() {
    const type = INCIDENT_TYPES[Math.floor(Math.random() * INCIDENT_TYPES.length)];
    const station = stations[Math.floor(Math.random() * stations.length)];
    const durationMs =
      (type.durationMin + Math.floor(Math.random() * (type.durationMax - type.durationMin))) * 60000;

    // Small positional offset so incident icon doesn't sit exactly on the station
    const latOffset = (Math.random() - 0.5) * 0.003;
    const lngOffset = (Math.random() - 0.5) * 0.003;

    this.incidents.push({
      id: _nextId++,
      type: type.type,
      label: type.label,
      severity: type.severity,
      icon: type.icon,
      lat: station.lat + latOffset,
      lng: station.lng + lngOffset,
      nearStation: station.name,
      createdAt: Date.now(),
      expiresAt: Date.now() + durationMs,
      durationMinutes: Math.round(durationMs / 60000),
    });
  }

  getActiveIncidents() {
    return this.incidents;
  }
}

module.exports = { EventEngine };

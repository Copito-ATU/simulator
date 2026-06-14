'use strict';
// Metropolitano BRT Lima — servicios reales con patrones de parada verificados
// Fuente: portal.atu.gob.pe, junio 2026 (portado de models/metropolitano.py en Copito-ATU/atu)

const COORDS = {
  'Chimpu Ocllo':       { lat: -11.8632, lng: -77.0473 },
  'Los Incas':          { lat: -11.8864, lng: -77.0504 },
  'Andres Belaunde':    { lat: -11.8987, lng: -77.0514 },
  '22 de Agosto':       { lat: -11.9132, lng: -77.0528 },
  'Las Vegas':          { lat: -11.9247, lng: -77.0540 },
  'Universidad':        { lat: -11.9380, lng: -77.0551 },
  'Naranjal':           { lat: -11.9810, lng: -77.0590 },
  'Izaguirre':          { lat: -11.9895, lng: -77.0570 },
  'Pacifico':           { lat: -11.9940, lng: -77.0558 },
  'Independencia':      { lat: -11.9975, lng: -77.0552 },
  'Los Jazmines':       { lat: -12.0018, lng: -77.0548 },
  'Tomas Valle':        { lat: -12.0068, lng: -77.0535 },
  'El Milagro':         { lat: -12.0117, lng: -77.0518 },
  'Honorio Delgado':    { lat: -12.0163, lng: -77.0502 },
  'UNI':                { lat: -12.0241, lng: -77.0491 },
  'Parque del Trabajo': { lat: -12.0295, lng: -77.0443 },
  'Caqueta':            { lat: -12.0365, lng: -77.0436 },
  'Ramon Castilla':     { lat: -12.0436, lng: -77.0419 },
  'Tacna':              { lat: -12.0462, lng: -77.0377 },
  'Jiron de la Union':  { lat: -12.0489, lng: -77.0337 },
  'Colmena':            { lat: -12.0523, lng: -77.0328 },
  '2 de Mayo':          { lat: -12.0480, lng: -77.0402 },
  'Quilca':             { lat: -12.0522, lng: -77.0423 },
  'Espana':             { lat: -12.0546, lng: -77.0393 },
  'Estacion Central':   { lat: -12.0572, lng: -77.0358 },
  'Estadio Nacional':   { lat: -12.0685, lng: -77.0321 },
  'Mexico':             { lat: -12.0761, lng: -77.0292 },
  'Canada':             { lat: -12.0820, lng: -77.0268 },
  'Javier Prado':       { lat: -12.0894, lng: -77.0235 },
  'Canaval y Moreyra':  { lat: -12.0955, lng: -77.0216 },
  'Aramburu':           { lat: -12.1009, lng: -77.0209 },
  'Domingo Orue':       { lat: -12.1068, lng: -77.0204 },
  'Angamos':            { lat: -12.1110, lng: -77.0201 },
  'Ricardo Palma':      { lat: -12.1172, lng: -77.0199 },
  'Benavides':          { lat: -12.1237, lng: -77.0198 },
  '28 de Julio':        { lat: -12.1292, lng: -77.0198 },
  'Plaza de Flores':    { lat: -12.1350, lng: -77.0199 },
  'Balta':              { lat: -12.1399, lng: -77.0200 },
  'Bulevar':            { lat: -12.1485, lng: -77.0201 },
  'Union':              { lat: -12.1529, lng: -77.0197 },
  'Escuela Militar':    { lat: -12.1597, lng: -77.0190 },
  'Teran':              { lat: -12.1686, lng: -77.0186 },
  'Rosario de Villa':   { lat: -12.1730, lng: -77.0151 },
  'Matellini':          { lat: -12.1783, lng: -77.0104 },
};

// Servicios ordenados Norte→Sur. El planificador usa ambas direcciones.
const SERVICIOS = [
  // ── REGULARES (operan todo el día LV/SAB/DOM) ──────────────────────────
  {
    id: 'METRO_A', nombre: 'Metropolitano Ruta A', tipo: 'regular',
    color: '#f0a500', frecuencia: 5,
    estaciones: [
      'Naranjal','Izaguirre','Pacifico','Independencia','Los Jazmines',
      'Tomas Valle','El Milagro','Honorio Delgado','UNI','Parque del Trabajo',
      'Caqueta','Ramon Castilla','Tacna','Jiron de la Union','Colmena',
      'Estacion Central',
    ],
  },
  {
    id: 'METRO_B', nombre: 'Metropolitano Ruta B', tipo: 'regular',
    color: '#f0a500', frecuencia: 8,
    estaciones: [
      'Chimpu Ocllo','Los Incas','Andres Belaunde','22 de Agosto','Las Vegas',
      'Universidad','Naranjal','Izaguirre','Pacifico','Independencia','Los Jazmines',
      'Tomas Valle','El Milagro','Honorio Delgado','UNI','Parque del Trabajo',
      'Caqueta','2 de Mayo','Quilca','Espana','Estacion Central',
    ],
  },
  {
    id: 'METRO_C', nombre: 'Metropolitano Ruta C', tipo: 'regular',
    color: '#f0a500', frecuencia: 5,
    estaciones: [
      'Ramon Castilla','Tacna','Jiron de la Union','Colmena','Estacion Central',
      'Estadio Nacional','Mexico','Canada','Javier Prado','Canaval y Moreyra',
      'Aramburu','Domingo Orue','Angamos','Ricardo Palma','Benavides',
      '28 de Julio','Plaza de Flores','Balta','Bulevar','Union',
      'Escuela Militar','Teran','Rosario de Villa','Matellini',
    ],
  },
  {
    id: 'METRO_D', nombre: 'Metropolitano Ruta D', tipo: 'regular',
    color: '#f0a500', frecuencia: 8,
    estaciones: [
      'Naranjal','Izaguirre','Pacifico','Independencia','Los Jazmines',
      'Tomas Valle','El Milagro','Honorio Delgado','UNI','Parque del Trabajo',
      'Caqueta','2 de Mayo','Quilca','Espana','Estacion Central',
    ],
  },
  // ── EXPRESOS (mayormente hora pico, pero disponibles todo el día en app) ─
  {
    id: 'METRO_EXP1', nombre: 'Metropolitano Expreso 1', tipo: 'expreso',
    color: '#ef6c00', frecuencia: 5, peakOnly: true,
    estaciones: [
      'Estacion Central','Estadio Nacional','Javier Prado',
      'Canaval y Moreyra','Angamos','28 de Julio','Balta',
      'Union','Teran','Matellini',
    ],
  },
  {
    id: 'METRO_EXP2', nombre: 'Metropolitano Expreso 2', tipo: 'expreso',
    color: '#ef6c00', frecuencia: 10, peakOnly: true,
    estaciones: ['Naranjal','Canada','Javier Prado','Ricardo Palma','28 de Julio'],
  },
  {
    id: 'METRO_EXP3', nombre: 'Metropolitano Expreso 3', tipo: 'expreso',
    color: '#ef6c00', frecuencia: 10, peakOnly: true,
    estaciones: ['Naranjal','Angamos','28 de Julio'],
  },
  {
    id: 'METRO_EXP5', nombre: 'Metropolitano Expreso 5', tipo: 'expreso',
    color: '#ef6c00', frecuencia: 10,
    estaciones: [
      'Naranjal','Izaguirre','Tomas Valle','UNI','Caqueta',
      'Espana','Estacion Central','Canada','Javier Prado',
      'Canaval y Moreyra','Angamos','Ricardo Palma','Plaza de Flores',
    ],
  },
  {
    id: 'METRO_EXP6', nombre: 'Metropolitano Expreso 6', tipo: 'expreso',
    color: '#ef6c00', frecuencia: 10, peakOnly: true,
    estaciones: [
      'Izaguirre','Independencia','Estacion Central',
      'Javier Prado','Canaval y Moreyra','Angamos','Benavides',
    ],
  },
  {
    id: 'METRO_EXP7', nombre: 'Metropolitano Expreso 7', tipo: 'expreso',
    color: '#ef6c00', frecuencia: 10, peakOnly: true,
    estaciones: ['Tomas Valle','Estacion Central','Javier Prado','Canaval y Moreyra','Angamos'],
  },
  {
    id: 'METRO_EXP8', nombre: 'Metropolitano Expreso 8', tipo: 'expreso',
    color: '#ef6c00', frecuencia: 10, peakOnly: true,
    estaciones: [
      'Izaguirre','Independencia','Tomas Valle','UNI',
      'Estacion Central','Javier Prado','Canaval y Moreyra',
      'Angamos','Benavides','Plaza de Flores',
    ],
  },
  {
    id: 'METRO_EXP9', nombre: 'Metropolitano Expreso 9', tipo: 'expreso',
    color: '#ef6c00', frecuencia: 10, peakOnly: true,
    estaciones: ['UNI','Caqueta','Canada','Canaval y Moreyra','Angamos','Benavides'],
  },
  {
    id: 'METRO_EXP10', nombre: 'Metropolitano Expreso 10', tipo: 'expreso',
    color: '#ef6c00', frecuencia: 10, peakOnly: true,
    estaciones: [
      'Naranjal','Caqueta','Ramon Castilla','Tacna',
      'Jiron de la Union','Colmena','Espana','Estacion Central',
    ],
  },
  {
    id: 'METRO_EXP11', nombre: 'Metropolitano Expreso 11', tipo: 'expreso',
    color: '#ef6c00', frecuencia: 10, peakOnly: true,
    estaciones: [
      'Los Incas','Andres Belaunde','22 de Agosto','Las Vegas',
      'Universidad','Naranjal','Pacifico','Estacion Central',
    ],
  },
  {
    id: 'METRO_EXP12', nombre: 'Metropolitano Expreso 12', tipo: 'expreso',
    color: '#ef6c00', frecuencia: 10, peakOnly: true,
    estaciones: [
      'Estacion Central','Estadio Nacional','Javier Prado',
      'Canaval y Moreyra','Angamos','Benavides',
    ],
  },
  // ── SUPER EXPRESOS ──────────────────────────────────────────────────────
  {
    id: 'METRO_SX', nombre: 'Metropolitano Super Expreso', tipo: 'super_expreso',
    color: '#e53935', frecuencia: 5, peakOnly: true,
    estaciones: ['Naranjal','Canaval y Moreyra','Aramburu','Angamos','Benavides','28 de Julio'],
  },
  {
    id: 'METRO_SXN', nombre: 'Metropolitano Super Expreso Norte', tipo: 'super_expreso',
    color: '#e53935', frecuencia: 8,
    estaciones: ['Naranjal','Espana','Quilca','2 de Mayo','Estacion Central'],
  },
  // ── LECHUCERO (nocturno) ─────────────────────────────────────────────────
  {
    id: 'METRO_LECH', nombre: 'Metropolitano Lechucero', tipo: 'lechucero',
    color: '#5c35a0', frecuencia: 30,
    estaciones: [
      'Naranjal','Izaguirre','Tomas Valle','UNI',
      'Ramon Castilla','Jiron de la Union','Canada',
      'Angamos','Ricardo Palma','Balta','Bulevar','Matellini',
    ],
  },
];

function toRouteEntry(srv) {
  const stations = srv.estaciones.map((nombre, idx) => {
    const c = COORDS[nombre];
    if (!c) throw new Error(`Coord not found: ${nombre}`);
    return { id: idx, name: nombre, lat: c.lat, lng: c.lng };
  });
  return {
    id: srv.id,
    name: srv.nombre,
    type: 'brt',
    color: srv.color,
    carroceria: 'Articulado BRT',
    stations,
  };
}

const ALL_METRO_ROUTES = SERVICIOS.map(toRouteEntry);

// IDs de todos los servicios Metro (para filtros en journeyPlanner)
const METRO_IDS = new Set(SERVICIOS.map(s => s.id));

function isMetroRoute(routeId) {
  return METRO_IDS.has(routeId) || routeId === 'METRO' || routeId === 'METRO_EXP';
}

module.exports = { COORDS, SERVICIOS, toRouteEntry, ALL_METRO_ROUTES, METRO_IDS, isMetroRoute };

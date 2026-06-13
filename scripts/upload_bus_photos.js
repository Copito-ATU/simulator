/**
 * Descarga fotos de buses de Lima (Wikimedia Commons) y las sube a Firebase Storage.
 * Luego guarda las URLs públicas en Firebase RTDB en /bus_types
 *
 * Uso: node scripts/upload_bus_photos.js
 */
require('dotenv').config();
const admin = require('firebase-admin');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Inicializar Firebase ───────────────────────────────────────────────────────
const keyPath = process.env.FIREBASE_KEY_PATH;
const dbUrl   = process.env.FIREBASE_DATABASE_URL;
const sa = require(path.resolve(process.cwd(), keyPath));
admin.initializeApp({
  credential:    admin.credential.cert(sa),
  databaseURL:   dbUrl,
  storageBucket: 'atu-hackathon-2026.firebasestorage.app',
});
const db     = admin.database();
const bucket = admin.storage().bucket();

// ── Definición de tipos de bus con fotos ──────────────────────────────────────
const BUS_TYPES = [
  {
    id:          'omnibus',
    label:       'Ómnibus',
    description: 'Bus grande de 2 puertas, ~45 pasajeros. Los más comunes en rutas diametrales de Lima.',
    categoria:   'M3',
    carroceria:  'OMNIBUS',
    url: 'https://upload.wikimedia.org/wikipedia/commons/5/50/2017_Lima_-_Autob%C3%BAs_en_la_avenida_Alfonso_Ugarte_cerca_del_plaza_Dos_de_Mayo.jpg',
    filename: 'omnibus_m3.jpg',
  },
  {
    id:          'microbus',
    label:       'Microbús',
    description: 'Coaster o minivan ampliada, ~20 pasajeros. Rutas periféricas y alimentadoras.',
    categoria:   'M2',
    carroceria:  'MICROBUS',
    url: 'https://upload.wikimedia.org/wikipedia/commons/6/66/Ruta_OM77_Adonai_S.A._Toyota_Coaster.jpg',
    filename: 'microbus_m2.jpg',
  },
  {
    id:          'minibus',
    label:       'Minibús',
    description: 'Bus mediano ~30 pasajeros. Versión intermedia entre ómnibus y microbús.',
    categoria:   'M2-M3',
    carroceria:  'MINIBUS',
    url: 'https://upload.wikimedia.org/wikipedia/commons/c/c3/Ruta_8729_Carrocer%C3%ADas_Rivera_S.A.C._Changan_Incapower_Metrogas.png',
    filename: 'minibus_m2m3.png',
  },
  {
    id:          'metropolitano',
    label:       'Metropolitano',
    description: 'Bus articulado BRT con carril exclusivo. Recorre el eje norte-sur de Lima.',
    categoria:   'BRT',
    carroceria:  'ARTICULADO',
    url: 'https://upload.wikimedia.org/wikipedia/commons/d/d1/Lima_Peru_Metropolitano_Bus.jpg',
    filename: 'metropolitano_brt.jpg',
  },
  {
    id:          'linea1',
    label:       'Metro Línea 1',
    description: 'Tren eléctrico elevado. Une Villa El Salvador con San Juan de Lurigancho.',
    categoria:   'METRO',
    carroceria:  'TREN',
    url: 'https://upload.wikimedia.org/wikipedia/commons/8/8c/Metro_de_Lima_%28L%C3%ADnea_1%29.JPG',
    filename: 'metro_linea1.jpg',
  },
  {
    id:          'corredor',
    label:       'Corredor Complementario',
    description: 'Bus con paraderos fijos y tarifa integrada. Corredores 1-4 en ejes principales.',
    categoria:   'CORREDOR',
    carroceria:  'OMNIBUS',
    url: 'https://upload.wikimedia.org/wikipedia/commons/5/5c/Bus_articulado_en_Lima.jpg',
    filename: 'corredor_complementario.jpg',
  },
];

// ── Descargar archivo ──────────────────────────────────────────────────────────
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) => {
      const opts = {
        headers: {
          'User-Agent': 'ATU-Lima-HackatonBot/1.0 (https://atu-hackathon-2026.web.app; cocherago@gmail.com) node-https',
          'Accept': 'image/jpeg,image/png,image/*',
        }
      };
      https.get(u, opts, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.destroy(); // descartar stream anterior antes de redirigir
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} para ${u}`));
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', reject);
    };
    get(url);
  });
}

// ── Script principal ───────────────────────────────────────────────────────────
const TMP = path.join(__dirname, '../data/bus_photos_tmp');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

(async () => {
  const result = {};

  for (const bt of BUS_TYPES) {
    const localPath = path.join(TMP, bt.filename);
    const storagePath = `bus_types/${bt.filename}`;

    console.log(`\n📥 Descargando ${bt.label}...`);
    try {
      await download(bt.url, localPath);
      const stat = fs.statSync(localPath);
      console.log(`   ✓ ${(stat.size / 1024).toFixed(0)} KB`);
    } catch (e) {
      console.error(`   ✗ Error descargando: ${e.message}`);
      continue;
    }

    console.log(`☁️  Subiendo a Firebase Storage → ${storagePath}`);
    try {
      const ext = bt.filename.split('.').pop();
      const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
      await bucket.upload(localPath, {
        destination: storagePath,
        metadata: { contentType, cacheControl: 'public,max-age=31536000' },
      });
      await bucket.file(storagePath).makePublic();
      const publicUrl = `https://storage.googleapis.com/atu-hackathon-2026.firebasestorage.app/${storagePath}`;
      console.log(`   ✓ ${publicUrl}`);
      result[bt.id] = {
        id:          bt.id,
        label:       bt.label,
        description: bt.description,
        categoria:   bt.categoria,
        carroceria:  bt.carroceria,
        photoUrl:    publicUrl,
      };
    } catch (e) {
      console.error(`   ✗ Error subiendo: ${e.message}`);
      // Usar URL de Wikimedia como fallback
      result[bt.id] = {
        id:          bt.id,
        label:       bt.label,
        description: bt.description,
        categoria:   bt.categoria,
        carroceria:  bt.carroceria,
        photoUrl:    bt.url,
      };
    }
  }

  // Guardar en Firebase RTDB
  console.log('\n🔥 Guardando en Firebase RTDB → /bus_types...');
  await db.ref('/bus_types').set(result);
  console.log('✅ /bus_types actualizado con', Object.keys(result).length, 'tipos');

  // Guardar también localmente
  fs.writeFileSync(
    path.join(__dirname, '../data/bus_types.json'),
    JSON.stringify(result, null, 2)
  );
  console.log('✅ data/bus_types.json guardado localmente');

  process.exit(0);
})();

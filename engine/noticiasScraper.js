/**
 * Scraper real de ATU desde gob.pe
 * - Campañas: https://www.gob.pe/atu          (imágenes cdn.../campaign/photo/...)
 * - Noticias: https://www.gob.pe/institucion/atu/noticias (imágenes cdn.../document/file/...)
 */

const https = require('https');
const zlib  = require('zlib');

const BASE         = 'https://www.gob.pe';
const URL_CAMPANAS = BASE + '/atu';
const URL_NOTICIAS = BASE + '/institucion/atu/noticias';

const HEADERS = {
  'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept'          : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language' : 'es-PE,es;q=0.9,en-US;q=0.8',
  'Accept-Encoding' : 'gzip, deflate, br',
  'Cache-Control'   : 'no-cache',
  'Sec-Fetch-Dest'  : 'document',
  'Sec-Fetch-Mode'  : 'navigate',
  'Sec-Fetch-Site'  : 'none',
  'Upgrade-Insecure-Requests': '1',
};

const CACHE_TTL = 10 * 60 * 1000;
var _cache = { ts: 0, data: null };

// ── Fallback ──────────────────────────────────────────────────────────────────
var FALLBACK_CAMPANAS = [
  { id: 'c0', tag: 'CAMPAÑA',   title: 'Expo ATU MOTIVA — 18 y 19 de junio 2026',          body: '22 de mayo de 2026',      color: '#7c3aed', bg: '#2e1065' },
  { id: 'c1', tag: 'CAMPAÑA',   title: 'Plan Maestro de Transporte Público Lima y Callao',  body: '10 de abril de 2026',     color: '#003087', bg: '#001a52' },
  { id: 'c2', tag: 'CAMPAÑA',   title: 'Recarga al toque con Plin y Yape',                  body: '13 de febrero de 2026',   color: '#0284c7', bg: '#0c3d5e' },
];
var FALLBACK_NOTICIAS = [
  { id: 'n0', tag: 'NOTICIAS',  title: 'ATU inicia construcción del cerco perimétrico de San Marcos',       body: '3 de junio de 2026',  color: '#003087', bg: '#001a52' },
  { id: 'n1', tag: 'NOTICIAS',  title: 'ATU y PNP detectan 1064 conductores sin brevete en operativos',     body: '3 de junio de 2026',  color: '#003087', bg: '#001a52' },
  { id: 'n2', tag: 'NOTICIAS',  title: 'Gobierno aprobó subsidio al transporte público autorizado',         body: '2 de junio de 2026',  color: '#003087', bg: '#001a52' },
];

// ── HTTP ──────────────────────────────────────────────────────────────────────
function fetchUrl(url, redirects) {
  redirects = redirects || 0;
  return new Promise(function(resolve, reject) {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https.get(url, { headers: HEADERS }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        var next = res.headers.location.startsWith('http') ? res.headers.location : BASE + res.headers.location;
        res.resume();
        return fetchUrl(next, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      var enc = res.headers['content-encoding'] || '';
      var stream = res;
      if (enc.includes('br'))           stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc.includes('gzip'))    stream = res.pipe(zlib.createGunzip());
      else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
      var chunks = [];
      stream.on('data', function(c) { chunks.push(c); });
      stream.on('end',  function()  { resolve(Buffer.concat(chunks).toString('utf-8')); });
      stream.on('error', reject);
    }).on('error', reject).setTimeout(12000, function() { this.destroy(); reject(new Error('timeout')); });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function ch(s) {
  return (s || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#\d+;/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
function slugTitle(slug) {
  return (slug || '').replace(/^\d+-/, '').replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
}

// ── Noticias ──────────────────────────────────────────────────────────────────
// Clave: filename image = standard_{noticiaId}-... => mismo id en href /noticias/{id}-
// Título: data-ga-label en el <a> que contiene el href
function parseNoticias(html) {
  var results = [];
  var seenIds = {};

  // Paso 1: construir mapa noticiaId → { href, title }
  var hrefMap = {};
  var pos = 0;
  while (true) {
    var hrefIdx = html.indexOf('/institucion/atu/noticias/', pos);
    if (hrefIdx === -1) break;
    pos = hrefIdx + 1;

    // Asegurarse de que viene de href="..."
    var quoteIdx = html.lastIndexOf('"', hrefIdx);
    if (quoteIdx === -1 || html.substring(quoteIdx - 5, quoteIdx) !== 'href=') continue;

    // Extraer el href completo hasta la siguiente "
    var hrefEnd = html.indexOf('"', hrefIdx);
    if (hrefEnd === -1) continue;
    var href = html.substring(hrefIdx, hrefEnd);

    // Extraer noticiaId del href: /noticias/{id}-
    var idMatch = href.match(/\/noticias\/(\d+)-/);
    if (!idMatch) continue;
    var nid = idMatch[1];
    if (hrefMap[nid]) continue;

    // Buscar data-ga-label en la misma etiqueta <a>
    var aTagStart = html.lastIndexOf('<a ', hrefIdx);
    if (aTagStart === -1) { hrefMap[nid] = { href: href, title: slugTitle(href.split('/').pop()) }; continue; }
    var aTagEnd = html.indexOf('>', hrefEnd);
    if (aTagEnd === -1) aTagEnd = hrefEnd + 200;
    var aTag = html.substring(aTagStart, aTagEnd + 1);

    var labelMatch = aTag.match(/data-ga-label="([^"]+)"/);
    var title = labelMatch ? ch(labelMatch[1]) : slugTitle(href.split('/').pop());
    hrefMap[nid] = { href: href, title: title };
  }

  // Paso 2: encontrar imágenes CDN y cruzar por ID del filename
  var imgPos = 0;
  while (results.length < 6) {
    var cdnIdx = html.indexOf('cdn.www.gob.pe/uploads/document/file/', imgPos);
    if (cdnIdx === -1) break;
    imgPos = cdnIdx + 1;

    // Retroceder para encontrar el inicio del src="
    var srcStart = html.lastIndexOf('src="', cdnIdx);
    if (srcStart === -1) continue;
    var imgEnd = html.indexOf('"', srcStart + 5);
    if (imgEnd === -1) continue;
    var imgUrl = html.substring(srcStart + 5, imgEnd);
    if (!imgUrl.startsWith('https://')) continue;

    // Extraer noticiaId del filename: standard_{id}-
    var fnMatch = imgUrl.match(/\/standard_(\d+)-/);
    if (!fnMatch) continue;
    var noticiaId = fnMatch[1];
    if (seenIds[noticiaId]) continue;
    seenIds[noticiaId] = true;

    var entry = hrefMap[noticiaId];
    if (!entry) continue;

    // Fecha: bloque amplio stripeado para evitar entidades HTML
    var nearbyRawN = html.substring(Math.max(0, cdnIdx - 600), cdnIdx + 600);
    var nearbyN = nearbyRawN.replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    var dm = nearbyN.match(/(\d{1,2} de \w+ de \d{4})/i);

    results.push({
      tag:   'NOTICIAS',
      title: entry.title,
      body:  dm ? dm[1] : '',
      img:   imgUrl,
      url:   BASE + entry.href,
      color: '#003087',
      bg:    '#001a52',
    });
  }
  return results;
}

// ── Campañas ──────────────────────────────────────────────────────────────────
// Imagen: cdn.../campaign/photo/AAA/BBB/CCC/campaign_... → campaignId = parseInt(AAABBBCCC)
// Alt de la imagen → título. Href en el HTML con campaignId → URL.
function parseCampanas(html) {
  var results = [];
  var seenIds = {};
  var imgPos = 0;

  while (results.length < 6) {
    var cdnIdx = html.indexOf('cdn.www.gob.pe/uploads/campaign/photo/', imgPos);
    if (cdnIdx === -1) break;
    imgPos = cdnIdx + 1;

    // Retroceder para encontrar src=" o el inicio del <img>
    var srcStart = html.lastIndexOf('src="', cdnIdx);
    if (srcStart === -1) continue;
    var imgEnd = html.indexOf('"', srcStart + 5);
    if (imgEnd === -1) continue;
    var imgUrl = html.substring(srcStart + 5, imgEnd);
    if (!imgUrl.startsWith('https://')) continue;

    // Extraer campaignId de la ruta /photo/AAA/BBB/CCC/
    var pathMatch = imgUrl.match(/\/photo\/(\d{3})\/(\d{3})\/(\d{3})\//);
    if (!pathMatch) continue;
    var campaignId = String(parseInt(pathMatch[1] + pathMatch[2] + pathMatch[3], 10));
    if (seenIds[campaignId]) continue;
    seenIds[campaignId] = true;

    // Alt text: buscar alt="..." en los 300 chars antes del src
    var before300 = html.substring(Math.max(0, srcStart - 300), srcStart);
    var altMatch = before300.match(/alt="([^"]*)"/);
    var altText = altMatch ? ch(altMatch[1]) : '';

    // Href con campaignId
    var hrefSearch = html.match(new RegExp('href="([^"]*campa[^"]*/' + campaignId + '-[^"]+)"'));
    var href = hrefSearch ? hrefSearch[1] : null;
    var slug = href ? href.split('/').pop().replace(/^\d+-/, '') : '';

    // Límite del card: primer </a> después de la imagen (620-820 chars típico en gob.pe)
    var cardEnd = html.indexOf('</a>', cdnIdx);
    if (cardEnd === -1) cardEnd = cdnIdx + 1000;

    // Título: en gob.pe el card tiene estructura "cdn_filename" /> [date] [title plain text]
    // Se extrae stripando HTML del bloque afterImg, quitando el filename y la fecha.
    var afterRaw = html.substring(cdnIdx, cardEnd);
    var afterStr = afterRaw
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // Quitar prefijo hasta '" />' (cierre del tag <img/>)
    var closeSelfClose = afterStr.indexOf('" />');
    if (closeSelfClose > -1) afterStr = afterStr.substring(closeSelfClose + 4).trim();
    // Quitar fecha del inicio si existe
    var textTitle = afterStr.replace(/^\d{1,2} de \w+ de \d{4}\s*/i, '').trim();
    var title = (textTitle && textTitle.length > 5) ? textTitle
               : (altText && altText.length > 5 ? altText : slugTitle(slug));

    // Fecha: ±300 chars stripped (ventana pequeña evita contaminación de cards adyacentes)
    var nearby300 = html.substring(Math.max(0, cdnIdx - 300), cdnIdx + 300);
    var near300s  = nearby300.replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    var dm = near300s.match(/(\d{1,2} de \w+ de \d{4})/i);

    results.push({
      tag:   'CAMPAÑA',
      title: title,
      body:  dm ? dm[1] : '',
      img:   imgUrl,
      url:   href ? (href.startsWith('http') ? href : BASE + href) : BASE + '/atu',
      color: '#7c3aed',
      bg:    '#2e1065',
    });
  }
  return results;
}

// ── Principal ─────────────────────────────────────────────────────────────────
async function fetchNoticias() {
  if (_cache.data && Date.now() - _cache.ts < CACHE_TTL) return _cache.data;

  try {
    var results = await Promise.all([
      fetchUrl(URL_CAMPANAS).catch(function() { return ''; }),
      fetchUrl(URL_NOTICIAS).catch(function() { return ''; }),
    ]);
    var htmlC = results[0];
    var htmlN = results[1];

    var campanas = htmlC ? parseCampanas(htmlC) : [];
    var noticias = htmlN ? parseNoticias(htmlN) : [];

    console.log('[noticias] scraping: campanas=' + campanas.length + ' noticias=' + noticias.length);

    if (campanas.length === 0) campanas = FALLBACK_CAMPANAS;
    if (noticias.length === 0) noticias = FALLBACK_NOTICIAS;

    campanas = campanas.map(function(item, i) { return Object.assign({}, item, { id: 'c' + i }); });
    noticias = noticias.map(function(item, i) { return Object.assign({}, item, { id: 'n' + i }); });

    var data = { campanas: campanas, noticias: noticias };
    _cache = { ts: Date.now(), data: data };
    return data;
  } catch(err) {
    console.error('[noticias] error:', err.message);
    if (_cache.data) return _cache.data;
    return { campanas: FALLBACK_CAMPANAS, noticias: FALLBACK_NOTICIAS };
  }
}

module.exports = { fetchNoticias: fetchNoticias };

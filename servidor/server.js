#!/usr/bin/env node
/*
 * Tienda Almaguer: servidor en línea
 * ----------------------------------
 * - Publica la aplicación (carpeta public/).
 * - Guarda los datos de la tienda en el servidor (carpeta data/).
 * - Sincroniza todos los equipos (navegador, Chromebook, programa .exe, APK).
 *   Cada equipo envía solo lo que cambió y recibe solo lo nuevo.
 * - Protegido con el CÓDIGO DE LA TIENDA (variable STORE_KEY).
 *
 * Sin dependencias: solo Node.js 18 o superior.
 *   STORE_KEY=su-codigo PORT=8080 node server.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 60 * 1024 * 1024;
const CAPS = { audit: 2000, movements: 20000, priceHistory: 5000 };
const COLLECTIONS = ['users', 'products', 'sales', 'movements', 'priceHistory', 'audit'];

fs.mkdirSync(path.join(DATA, 'images'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'backups'), { recursive: true });

/* ---------- Código de la tienda ---------- */
let STORE_KEY = process.env.STORE_KEY || '';
const keyFile = path.join(DATA, 'store-key.txt');
if (!STORE_KEY) {
  if (fs.existsSync(keyFile)) STORE_KEY = fs.readFileSync(keyFile, 'utf8').trim();
  else {
    STORE_KEY = crypto.randomBytes(9).toString('base64url');
    fs.writeFileSync(keyFile, STORE_KEY + '\n', { mode: 0o600 });
    console.log('Código de la tienda generado: ' + STORE_KEY + '  (guardado en ' + keyFile + ')');
  }
}
const keyBuf = Buffer.from(STORE_KEY);
function keyOk(k) {
  const b = Buffer.from(String(k || ''));
  return b.length === keyBuf.length && crypto.timingSafeEqual(b, keyBuf);
}

/* ---------- Estado en disco ----------
 * state.json = { epoch, rev, units: { "<clave>": { v: valor, r: revisión } } }
 * Las fotos (img/<id>) van aparte en data/images/<id>.json para que state.json sea liviano. */
const STATE_FILE = path.join(DATA, 'state.json');
let st = { epoch: null, rev: 0, units: {}, imgRev: {} };
if (fs.existsSync(STATE_FILE)) {
  try { st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); st.imgRev = st.imgRev || {}; }
  catch (e) { console.error('No se pudo leer state.json:', e.message); process.exit(1); }
}
if (!st.epoch) st.epoch = { id: crypto.randomUUID(), ts: Date.now() };

const imgPath = (id) => path.join(DATA, 'images', String(id).replace(/[^A-Za-z0-9_-]/g, '_') + '.json');
function readImg(id) { try { return JSON.parse(fs.readFileSync(imgPath(id), 'utf8')); } catch { return null; } }
function writeAtomic(file, text) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
function saveState() {
  writeAtomic(STATE_FILE, JSON.stringify(st));
  // Una copia por día (últimos 30 días)
  const day = new Date().toISOString().slice(0, 10);
  const bk = path.join(DATA, 'backups', `state-${day}.json`);
  if (!fs.existsSync(bk)) {
    try {
      fs.copyFileSync(STATE_FILE, bk);
      const old = fs.readdirSync(path.join(DATA, 'backups')).filter((f) => /^state-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      old.slice(0, Math.max(0, old.length - 30)).forEach((f) => fs.unlinkSync(path.join(DATA, 'backups', f)));
    } catch { /* copia opcional */ }
  }
}

/* ---------- Reglas de combinación (iguales a las de la aplicación) ---------- */
const t = (x) => (x && (x.updated || x.ts || x.created)) || 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function isTomb(id) { const d = st.units['del/' + id]; return !!(d && d.v); }

/** Aplica una unidad enviada por un equipo. Devuelve true si cambió algo. */
function mergeUnit(key, v, rev) {
  const cur = st.units[key];
  if (key.startsWith('img/')) {
    const id = key.slice(4);
    if (isTomb(id)) return false;
    const old = readImg(id);
    if (old && (old.ts || 0) > (v.ts || 0)) return false;
    if (old && old.data === v.data) return false;
    if (v.data) writeAtomic(imgPath(id), JSON.stringify({ id, data: v.data, ts: v.ts || Date.now() }));
    else { try { fs.unlinkSync(imgPath(id)); } catch { /* ya no existe */ } }
    st.imgRev[id] = rev;
    return true;
  }
  if (key.startsWith('del/')) {
    const id = key.slice(4);
    const ts = Math.max(Number(v) || 0, cur ? cur.v : 0);
    if (cur && cur.v === ts) return false;
    st.units[key] = { v: ts, r: rev };
    for (const c of COLLECTIONS) if (st.units[c + '/' + id]) { st.units[c + '/' + id] = { v: null, r: rev }; }
    if (st.imgRev[id] !== undefined || readImg(id)) { try { fs.unlinkSync(imgPath(id)); } catch {} st.imgRev[id] = rev; }
    return true;
  }
  if (key === 'settings' || key === 'admin') {
    if (cur && ((cur.v && cur.v._u) || 0) > ((v && v._u) || 0)) return false;
    if (cur && same(cur.v, v)) return false;
    st.units[key] = { v, r: rev }; return true;
  }
  if (key === 'seq') {
    const n = Math.max((cur && cur.v && cur.v.sale) || 1001, (v && v.sale) || 1001);
    if (cur && cur.v && cur.v.sale === n) return false;
    st.units[key] = { v: { sale: n }, r: rev }; return true;
  }
  const slash = key.indexOf('/');
  const coll = key.slice(0, slash), id = key.slice(slash + 1);
  if (!COLLECTIONS.includes(coll) || !v || typeof v !== 'object') return false;
  if (isTomb(id)) return false;
  if (cur && cur.v && t(cur.v) > t(v)) return false;
  if (cur && same(cur.v, v)) return false;
  st.units[key] = { v, r: rev }; return true;
}

/** Recorta los registros históricos para que el archivo no crezca sin límite. */
function prune() {
  for (const [coll, cap] of Object.entries(CAPS)) {
    const keys = Object.keys(st.units).filter((k) => k.startsWith(coll + '/') && st.units[k].v);
    if (keys.length <= cap * 1.1) continue;
    keys.sort((a, b) => t(st.units[b].v) - t(st.units[a].v));
    keys.slice(cap).forEach((k) => delete st.units[k]);
  }
  // Las marcas vacías (registros borrados) se pueden olvidar después de 60 días
  const limit = Date.now() - 60 * 864e5;
  for (const k of Object.keys(st.units)) if (st.units[k].v === null && !k.startsWith('del/')) {
    const id = k.slice(k.indexOf('/') + 1); const d = st.units['del/' + id];
    if (d && d.v < limit) delete st.units[k];
  }
}

/** Todo lo que cambió después de la revisión "since". */
function changesSince(since, exclude) {
  const out = {};
  for (const [k, u] of Object.entries(st.units)) {
    if (u.r > since && !(exclude && exclude.has(k))) out[k] = u.v;
  }
  for (const [id, r] of Object.entries(st.imgRev)) {
    const k = 'img/' + id;
    if (r > since && !(exclude && exclude.has(k))) { const im = readImg(id); out[k] = im ? { id, data: im.data, ts: im.ts } : { id, data: null, ts: Date.now() }; }
  }
  return out;
}

/** Arma una copia completa en el formato de "Descargar copia" de la aplicación. */
function fullBackup() {
  const d = { version: 3, epoch: st.epoch, settings: {}, admin: {}, users: [], products: [], sales: [], movements: [], priceHistory: [], audit: [], deleted: {}, seq: { sale: 1001 } };
  for (const [k, u] of Object.entries(st.units)) {
    if (u.v === null) continue;
    if (k === 'settings' || k === 'admin' || k === 'seq') d[k] = u.v;
    else if (k.startsWith('del/')) d.deleted[k.slice(4)] = u.v;
    else { const c = k.slice(0, k.indexOf('/')); if (d[c]) d[c].push(u.v); }
  }
  d.products.forEach((p) => { const im = readImg(p.id); if (im) p.img = im.data; });
  ['sales', 'movements', 'priceHistory', 'audit'].forEach((c) => d[c].sort((a, b) => b.ts - a.ts));
  return { app: 'tienda-almaguer', version: 1, store: (d.settings && d.settings.storeName) || 'Tienda Almaguer', exportedAt: new Date().toISOString(), data: d };
}

/* ---------- Protección contra intentos de adivinar el código ---------- */
const fails = new Map();
function blocked(ip) { const f = fails.get(ip); return f && f.n >= 10 && Date.now() - f.ts < 10 * 60e3; }
function failed(ip) { const f = fails.get(ip) || { n: 0, ts: 0 }; if (Date.now() - f.ts > 10 * 60e3) f.n = 0; f.n++; f.ts = Date.now(); fails.set(ip, f); }

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.css': 'text/css' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Store-Key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '86400' };

function send(req, res, code, obj, extra) {
  let body = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...(extra || {}) };
  if (body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { body = zlib.gzipSync(body); h['Content-Encoding'] = 'gzip'; }
  h['Content-Length'] = body.length;
  res.writeHead(code, h); res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    const src = /gzip/.test(req.headers['content-encoding'] || '') ? req.pipe(zlib.createGunzip()) : req;
    src.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error('Demasiado grande'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    src.on('end', () => { try { resolve(n ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(Object.assign(new Error('JSON inválido'), { code: 400 })); } });
    src.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    const ext = path.extname(file);
    const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' };
    h['Cache-Control'] = (ext === '.html' || rel === '/sw.js' || ext === '.webmanifest') ? 'no-cache' : 'public, max-age=86400';
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && /html|javascript|json|svg|manifest/.test(h['Content-Type'])) { data = zlib.gzipSync(data); h['Content-Encoding'] = 'gzip'; }
    res.writeHead(200, h); res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // Detrás de Caddy (misma máquina) la IP real es la última de X-Forwarded-For; si no, la de la conexión.
  const sock = req.socket.remoteAddress || '';
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ip = (/^(::1|127\.|::ffff:127\.)/.test(sock) && xff.length) ? xff[xff.length - 1] : sock;
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  try {
    if (url.pathname === '/api/ping') {
      const k = req.headers['x-store-key'];
      return send(req, res, 200, { ok: true, app: 'tienda-almaguer', server: 1, auth: k ? keyOk(k) : undefined });
    }
    if (blocked(ip)) return send(req, res, 429, { error: 'Demasiados intentos. Espere 10 minutos.' });
    if (!keyOk(req.headers['x-store-key'] || url.searchParams.get('key'))) { failed(ip); return send(req, res, 401, { error: 'Código de la tienda incorrecto' }); }

    // Sincronizar: recibe lo que cambió en el equipo y devuelve lo nuevo del servidor
    if (url.pathname === '/api/sync' && req.method === 'POST') {
      const body = await readBody(req);
      const since = Number(body.since) || 0;
      const units = body.units && typeof body.units === 'object' ? body.units : {};
      // Datos borrados o restaurados en otro equipo: este equipo debe empezar de nuevo
      if (body.epoch && body.epoch !== st.epoch.id) {
        return send(req, res, 200, { reset: true, epoch: st.epoch, rev: st.rev, units: changesSince(0) });
      }
      const rev = st.rev + 1; let changed = false;
      const keys = Object.keys(units).sort((a, b) => (a.startsWith('del/') ? -1 : 0) - (b.startsWith('del/') ? -1 : 0));
      const accepted = new Set();
      for (const k of keys) {
        if (mergeUnit(k, units[k], rev)) { changed = true; accepted.add(k); }
        else {
          // Si el servidor ya tiene exactamente lo mismo, no hace falta devolverlo
          const cur = st.units[k];
          if (cur && same(cur.v, units[k])) accepted.add(k);
          if (k.startsWith('img/')) { const im = readImg(k.slice(4)); if ((im && im.data) === (units[k] && units[k].data)) accepted.add(k); }
        }
      }
      if (changed) { st.rev = rev; prune(); saveState(); }
      return send(req, res, 200, { epoch: st.epoch, rev: st.rev, units: changesSince(since, accepted) });
    }

    // Reemplazar todo (restaurar copia o borrar todo desde un equipo)
    if (url.pathname === '/api/replace' && req.method === 'POST') {
      const body = await readBody(req);
      const units = body.units && typeof body.units === 'object' ? body.units : {};
      for (const f of fs.readdirSync(path.join(DATA, 'images'))) fs.unlinkSync(path.join(DATA, 'images', f));
      st = { epoch: { id: crypto.randomUUID(), ts: Date.now() }, rev: st.rev + 1, units: {}, imgRev: {} };
      for (const k of Object.keys(units)) mergeUnit(k, units[k], st.rev);
      saveState();
      console.log(new Date().toISOString(), 'Datos reemplazados desde', ip);
      return send(req, res, 200, { epoch: st.epoch, rev: st.rev });
    }

    // Descargar copia completa (mismo formato que "Descargar copia" de la aplicación)
    if (url.pathname === '/api/backup' && req.method === 'GET') {
      const day = new Date().toISOString().slice(0, 10);
      return send(req, res, 200, fullBackup(), { 'Content-Disposition': `attachment; filename="tienda-almaguer-servidor-${day}.json"` });
    }

    return send(req, res, 404, { error: 'No encontrado' });
  } catch (e) {
    console.error(e);
    return send(req, res, e.code === 413 ? 413 : e.code === 400 ? 400 : 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => console.log(`Tienda Almaguer en línea: http://${HOST}:${PORT}  (datos en ${DATA})`));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { try { saveState(); } catch {} process.exit(0); });

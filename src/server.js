// Local web server: serves the app and a small JSON/SSE/MJPEG API over the camera.
// Requests from this machine are always allowed. Other devices on the network (a phone)
// need the access key, which they get by scanning the QR code shown in the app.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { Camera } from './camera.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const CAPTURES = process.env.CAPTURES_DIR || join(ROOT, 'captures');
const PORT = +process.env.PORT || 8765;
const LAN = process.env.LAN !== '0'; // LAN=0 keeps the server reachable from this machine only
const KEY_FILE = join(ROOT, '.remote-key');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.nef': 'application/octet-stream', '.mov': 'video/quicktime', '.mp4': 'video/mp4',
};

// Persisted so a phone that scanned once stays signed in across restarts.
const KEY = existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() : (() => {
  const k = randomBytes(18).toString('base64url');
  writeFileSync(KEY_FILE, k);
  return k;
})();

const camera = new Camera({ capturesDir: CAPTURES });
const clients = new Set();

function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
for (const type of ['state', 'prop', 'photo', 'shot']) camera.on(type, d => broadcast(type, d));
camera.on('log', m => { console.log(m); broadcast('log', m); });

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function body(req) {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : {};
}

function serveFile(req, res, base, rel) {
  const file = normalize(join(base, decodeURIComponent(rel)));
  if (!file.startsWith(base) || !existsSync(file) || statSync(file).isDirectory()) return json(res, 404, { error: 'Not found' });
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  const size = statSync(file).size;
  // Range support so videos can be scrubbed in the browser.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? +range[1] : size - +range[2];
    const end = range[1] && range[2] ? Math.min(+range[2], size - 1) : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  createReadStream(file).pipe(res);
}

// ---------- access control ----------
const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const keyMatches = k => typeof k === 'string' && k.length === KEY.length && timingSafeEqual(Buffer.from(k), Buffer.from(KEY));
const cookieKey = req => /(?:^|;\s*)nr_key=([^;]+)/.exec(req.headers.cookie || '')?.[1];

function lanUrls() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // Private ranges only: home/office Wi-Fi, not public or link-local addresses.
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push(`http://${a.address}:${PORT}/?key=${KEY}`);
    }
  }
  return out;
}

function deny(res) {
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;background:#111;color:#eee;padding:24px">' +
    '<h2>Nikon Remote</h2><p>Scan the QR code from the <b>Phone</b> button in the app on the laptop to connect this device.</p>');
}

// ---------- routes ----------
const routes = {
  'GET /api/state': () => camera.state(),
  'GET /api/photos': () => camera.listPhotos(),
  'POST /api/shoot': b => camera.shoot({ af: !!b.af }),
  'POST /api/af': async () => ({ result: await camera.autofocus() }),
  'POST /api/focus-point': b => camera.setFocusPoint(+b.x, +b.y, { focus: b.focus !== false }),
  'POST /api/movie': b => (b.on ? camera.startMovie() : camera.stopMovie()).then(() => camera.state()),
  'POST /api/liveview': b => camera.setLiveView(b.on).then(() => camera.state()),
  'POST /api/prop': b => camera.setProp(+b.code, b.value).then(() => camera.props[+b.code]),
  'POST /api/prop/step': b => camera.stepProp(+b.code, +b.delta).then(() => camera.props[+b.code]),
  'POST /api/reconnect': () => camera.reconnect().then(() => camera.state()),
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (!isLocal(req)) {
    const key = url.searchParams.get('key');
    if (keyMatches(key)) {
      // Swap the key in the URL for a cookie, so it doesn't linger in the address bar.
      res.writeHead(302, {
        'Set-Cookie': `nr_key=${KEY}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`,
        Location: path,
      });
      return res.end();
    }
    if (!keyMatches(cookieKey(req))) return deny(res);
  }

  if (path === '/api/remote') {
    if (!isLocal(req)) return json(res, 403, { error: 'Only available on the laptop' });
    return json(res, 200, { lan: LAN, urls: LAN ? lanUrls() : [] });
  }
  if (path === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(camera.state())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (path === '/api/liveview.mjpg') return camera.addViewer(res);
  if (path.startsWith('/captures/')) return serveFile(req, res, CAPTURES, path.slice('/captures/'.length));

  const handler = routes[`${req.method} ${path}`];
  if (handler) {
    try { return json(res, 200, (await handler(await body(req))) ?? { ok: true }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (req.method === 'GET') return serveFile(req, res, PUBLIC, path === '/' ? 'index.html' : path.slice(1));
  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`Nikon remote running at http://localhost:${PORT}/`);
  if (LAN) console.log('Phone access: use the Phone button in the app (Windows may ask to allow Node through the firewall — choose Private networks).');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  await camera.stopMovie().catch(() => {});
  await camera.close();
  process.exit(0);
});

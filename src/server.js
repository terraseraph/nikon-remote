// Local web server: serves the app and a small JSON/SSE/MJPEG API over the camera.
// Requests from this machine are always allowed. Other devices on the network (a phone)
// need the access key, which they get by scanning the QR code shown in the app.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Camera } from './camera.js';
import { Tunnel } from './tunnel.js';
import jpeg from 'jpeg-js';
import { advise, advisorConfig, SCENES } from './advisor.js';
import { findInspo, inspoConfig, proxyImage } from './inspo.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');
// API keys (e.g. OPENROUTER_API_KEY for the shot advisor) can live in a .env file next to package.json.
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));
const CAPTURES = normalize(process.env.CAPTURES_DIR || join(picturesDir(), 'Nikon Remote'));
// Thumbnails stay with the app so they don't show up as photos in the Pictures album.
const THUMBS = join(ROOT, '.cache', 'thumbs');
const PORT = +process.env.PORT || 8765;
const LAN = process.env.LAN !== '0'; // LAN=0 keeps the server reachable from this machine only
const KEY_FILE = join(ROOT, '.remote-key');
// Shooting presets live on the laptop so the phone and the laptop share the same list.
const PRESETS_FILE = join(ROOT, 'presets.json');

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

// The user's Pictures folder, following Windows' redirection (e.g. to OneDrive) when set.
function picturesDir() {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders', '/v', 'My Pictures'], { encoding: 'utf8' });
      const m = /My Pictures\s+REG_SZ\s+(.+)/.exec(out);
      if (m) return m[1].trim();
    } catch {}
  }
  return join(homedir(), 'Pictures');
}

const camera = new Camera({ capturesDir: CAPTURES, thumbsDir: THUMBS });
const clients = new Set();

function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
for (const type of ['state', 'prop', 'photo', 'shot']) camera.on(type, d => broadcast(type, d));
camera.on('log', m => { console.log(m); broadcast('log', m); });
// Proxies such as Cloudflare drop connections that stay silent for ~100 s; an SSE comment keeps them open.
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25_000).unref();

const tunnel = new Tunnel({ port: PORT });
tunnel.on('state', t => console.log(`Tunnel: ${t.status}${t.url ? ` ${t.url}` : ''}${t.error ? ` (${t.error})` : ''}`));

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

// A preset is a list of steps, each "wait, then take N shots this far apart", run `repeat` times
// (0 = until cancelled). Clamped so a typo can't queue thousands of shots.
const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
function cleanPresets(list) {
  if (!Array.isArray(list)) throw new Error('Presets must be a list');
  return list.slice(0, 9).map((p, i) => ({
    name: String(p?.name || `Preset ${i + 1}`).slice(0, 40),
    repeat: Math.round(clamp(p?.repeat, 0, 999, 1)),
    steps: (Array.isArray(p?.steps) && p.steps.length ? p.steps : [{}]).slice(0, 12).map(s => ({
      wait: clamp(s?.wait, 0, 3600, 0),
      shots: Math.round(clamp(s?.shots, 1, 50, 1)),
      gap: clamp(s?.gap, 0, 600, 1),
    })),
  }));
}
const DEFAULT_PRESETS = cleanPresets([
  { name: 'Single', steps: [{ wait: 0, shots: 1 }] },
  { name: 'Every 3 s', repeat: 0, steps: [{ wait: 3, shots: 1 }] },
  { name: '3 s, then 5 s', steps: [{ wait: 3, shots: 1 }, { wait: 5, shots: 1 }] },
  { name: 'Burst + single', steps: [{ wait: 0, shots: 3, gap: 0.5 }, { wait: 3, shots: 1 }] },
]);
function loadPresets() {
  try { return cleanPresets(JSON.parse(readFileSync(PRESETS_FILE, 'utf8'))); } catch { return DEFAULT_PRESETS; }
}
function savePresets(list) {
  const clean = cleanPresets(list);
  writeFileSync(PRESETS_FILE, JSON.stringify(clean, null, 2));
  broadcast('presets', clean);
  return clean;
}

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
// cloudflared also connects from 127.0.0.1, so a request carrying proxy headers came from the internet.
const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
  !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'];
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

// Pulled frames go out over the internet, where bytes per frame set the frame rate. The camera's
// JPEGs are high quality; re-encoding at 60 makes them about a third of the size (~21 KB at
// 640px) for ~26 ms of CPU. The last result is kept, so each frame is only encoded once.
let shrunk = { seq: 0, jpeg: null };
function shrink(f) {
  if (shrunk.seq !== f.seq) {
    try { shrunk = { seq: f.seq, jpeg: jpeg.encode(jpeg.decode(f.jpeg, { useTArray: true }), 60).data }; }
    catch { return f.jpeg; }
  }
  return shrunk.jpeg;
}

// The public link carries the access key too: whoever has it can use the camera.
function tunnelState() {
  const t = tunnel.state();
  return { ...t, link: t.status === 'on' && t.url ? `${t.url}/?key=${KEY}` : '' };
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
  'GET /api/advisor': () => ({ ...advisorConfig(), scenes: Object.keys(SCENES) }),
  'POST /api/advise': b => advise(camera, { scene: b.scene, notes: String(b.notes || '').slice(0, 500), model: b.model }),
  'GET /api/inspo': () => inspoConfig(),
  'POST /api/inspo': b => findInspo(camera, { request: b.request, model: b.model }),
  'POST /api/reconnect': () => camera.reconnect().then(() => camera.state()),
  'GET /api/presets': () => loadPresets(),
  'POST /api/presets': b => savePresets(b.presets),
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (!isLocal(req)) {
    const key = url.searchParams.get('key');
    if (keyMatches(key)) {
      // Swap the key in the URL for a cookie, so it doesn't linger in the address bar.
      res.writeHead(302, {
        'Set-Cookie': `nr_key=${KEY}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`, // Strict would drop it when the link is opened from another app or site
        Location: path,
      });
      return res.end();
    }
    if (!keyMatches(cookieKey(req))) return deny(res);
  }

  if (path === '/api/remote') {
    if (!isLocal(req)) return json(res, 403, { error: 'Only available on the laptop' });
    return json(res, 200, { lan: LAN, urls: LAN ? lanUrls() : [], tunnel: tunnelState() });
  }
  if (path === '/api/tunnel' && req.method === 'POST') {
    if (!isLocal(req)) return json(res, 403, { error: 'Only available on the laptop' });
    (await body(req)).on ? tunnel.start() : tunnel.stop();
    return json(res, 200, tunnelState());
  }
  if (path === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(camera.state())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (path === '/api/liveview.mjpg') return camera.addViewer(res);
  if (path === '/api/liveview.jpg') {
    const f = await camera.pullFrame(+url.searchParams.get('after') || 0);
    if (!f) { res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); }
    const out = shrink(f);
    res.writeHead(200, {
      'Content-Type': 'image/jpeg', 'Content-Length': out.length, 'Cache-Control': 'no-store', 'X-Seq': f.seq,
      ...(f.af && { 'X-AF': `${f.af.x},${f.af.y},${f.af.w},${f.af.h}` }),
    });
    return res.end(out);
  }
  if (path === '/api/inspo/img') {
    try {
      const img = await proxyImage(url.searchParams.get('u'));
      res.writeHead(200, { 'Content-Type': img.type, 'Content-Length': img.data.length, 'Cache-Control': 'private, max-age=3600' });
      return res.end(img.data);
    } catch (e) { return json(res, 404, { error: e.message }); }
  }
  if (path.startsWith('/captures/.thumbs/')) return serveFile(req, res, THUMBS, path.slice('/captures/.thumbs/'.length));
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
  tunnel.stop();
  await camera.stopMovie().catch(() => {});
  await camera.close();
  process.exit(0);
});

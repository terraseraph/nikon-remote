// Local web server: serves the app and a small JSON/SSE/MJPEG API over the camera.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Camera } from './camera.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const CAPTURES = process.env.CAPTURES_DIR || join(ROOT, 'captures');
const PORT = +process.env.PORT || 8765;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.nef': 'application/octet-stream', '.mov': 'video/quicktime', '.mp4': 'video/mp4',
};

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

function serveFile(res, base, rel) {
  const file = normalize(join(base, decodeURIComponent(rel)));
  if (!file.startsWith(base) || !existsSync(file) || statSync(file).isDirectory()) return json(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

const routes = {
  'GET /api/state': () => camera.state(),
  'GET /api/photos': () => camera.listPhotos(),
  'POST /api/shoot': b => camera.shoot({ af: !!b.af }),
  'POST /api/af': async () => ({ result: await camera.autofocus() }),
  'POST /api/liveview': b => camera.setLiveView(b.on).then(() => camera.state()),
  'POST /api/prop': b => camera.setProp(+b.code, b.value).then(() => camera.props[+b.code]),
  'POST /api/prop/step': b => camera.stepProp(+b.code, +b.delta).then(() => camera.props[+b.code]),
  'POST /api/reconnect': () => camera.reconnect().then(() => camera.state()),
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(camera.state())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (path === '/api/liveview.mjpg') return camera.addViewer(res);
  if (path.startsWith('/captures/')) return serveFile(res, CAPTURES, path.slice('/captures/'.length));

  const handler = routes[`${req.method} ${path}`];
  if (handler) {
    try { return json(res, 200, (await handler(await body(req))) ?? { ok: true }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (req.method === 'GET') return serveFile(res, PUBLIC, path === '/' ? 'index.html' : path.slice(1));
  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => console.log(`Nikon remote running at http://localhost:${PORT}/`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  await camera.close();
  process.exit(0);
});

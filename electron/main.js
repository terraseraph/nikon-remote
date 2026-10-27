// Desktop shell: runs the same local server inside Electron's main process and shows the app
// in its own window. Phones still connect to it over Wi-Fi or the tunnel as usual.
import { app, BrowserWindow, Menu, dialog, session, shell } from 'electron';
import { createServer } from 'node:net';

const PREFERRED_PORT = +process.env.PORT || 8765;
let port = PREFERRED_PORT;
// 127.0.0.1, not localhost: localhost can resolve to IPv6 first, where another program may be listening.
const appUrl = () => `http://127.0.0.1:${port}/`;

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let server = null; // the imported server module, when this process runs it

// An `npm start` server already on the port is reused instead of starting a second one. Only ours
// counts: other programs (file sharing, search tools) also answer on ports like this one.
async function ourServerOn(p) {
  try {
    const res = await fetch(`http://127.0.0.1:${p}/api/state`, { signal: AbortSignal.timeout(1500) });
    return res.ok && res.headers.get('x-app') === 'nikon-remote';
  } catch { return false; }
}

// Checked up front: the server binds as soon as it's imported, before we could catch the error.
const portFree = p => new Promise(resolve => {
  const probe = createServer().once('error', () => resolve(false)).once('listening', () => probe.close(() => resolve(true)));
  probe.listen(p, '0.0.0.0');
});

async function startServer() {
  if (await ourServerOn(PREFERRED_PORT)) return;
  // Another program has the port: use the next free one. Phones need a fresh QR scan then.
  for (port = PREFERRED_PORT; !(await portFree(port)); port++) {
    if (port >= PREFERRED_PORT + 20) throw Object.assign(new Error('no free port'), { code: 'EADDRINUSE' });
  }
  if (port !== PREFERRED_PORT) console.log(`Port ${PREFERRED_PORT} is used by another program; using ${port}`);
  process.env.PORT = String(port);
  // Keys, presets and thumbnails go in the user-data folder; the install folder is read-only.
  process.env.DATA_DIR ||= app.getPath('userData');
  server = await import('../src/server.js');
  await new Promise((resolve, reject) => {
    if (server.server.listening) return resolve();
    server.server.once('listening', resolve).once('error', reject);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 420, minHeight: 600,
    title: 'Nikon Remote', backgroundColor: '#111111', autoHideMenuBar: true,
  });
  win.loadURL(appUrl());
  // Photo credits, "Get a key" and other target=_blank links open in the default browser, not
  // inside the app. Web links only: openExternal would also launch file: and other handlers.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => (win = null));
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'fileMenu' },
    {
      label: 'View',
      submenu: [
        // Voice needs Chrome or Edge, so this opens the same app there.
        { label: 'Open in browser', accelerator: 'CmdOrCtrl+B', click: () => shell.openExternal(appUrl()) },
        // Only known when this window runs the server, not when it reuses an `npm start` one.
        ...(server ? [{ label: 'Open photos folder', click: () => shell.openPath(server.CAPTURES) }] : []),
        { type: 'separator' },
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  // Microphone and webcam are only needed for clap and webcam gestures, from our own page.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'clipboard-sanitized-write'].includes(permission) && new URL(wc.getURL()).hostname === '127.0.0.1');
  });
  try {
    await startServer();
  } catch (e) {
    dialog.showErrorBox('Nikon Remote', e.code === 'EADDRINUSE'
      ? `Ports ${PREFERRED_PORT}–${PREFERRED_PORT + 20} are all used by other programs. Close one, or set PORT to a free port.`
      : `The camera server couldn't start: ${e.message}`);
    return app.quit();
  }
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => app.quit());

// Stop recording, close the camera session and the tunnel before exiting.
let stopping = false;
app.on('before-quit', e => {
  if (!server || stopping) return;
  e.preventDefault();
  stopping = true;
  Promise.race([server.shutdown(), new Promise(r => setTimeout(r, 4000))]).finally(() => app.exit(0));
});

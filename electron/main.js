// Desktop shell: runs the same local server inside Electron's main process and shows the app
// in its own window. Phones still connect to it over Wi-Fi or the tunnel as usual.
import { app, BrowserWindow, Menu, dialog, session, shell } from 'electron';
import { createServer } from 'node:net';

const PORT = +process.env.PORT || 8765;
const URL_ = `http://localhost:${PORT}/`;

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let server = null; // the imported server module, when this process runs it

// An `npm start` server already on the port is reused instead of failing to bind a second one.
async function serverRunning() {
  try { return (await fetch(`http://127.0.0.1:${PORT}/api/state`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

// Checked up front: the server binds as soon as it's imported, before we could catch the error.
const portFree = () => new Promise(resolve => {
  const probe = createServer().once('error', () => resolve(false)).once('listening', () => probe.close(() => resolve(true)));
  probe.listen(PORT, '0.0.0.0');
});

async function startServer() {
  if (await serverRunning()) return;
  if (!(await portFree())) throw Object.assign(new Error('port in use'), { code: 'EADDRINUSE' });
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
  win.loadURL(URL_);
  // Photo credits and other links open in the default browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => (win = null));
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'fileMenu' },
    {
      label: 'View',
      submenu: [
        // Voice needs Chrome or Edge, so this opens the same app there.
        { label: 'Open in browser', accelerator: 'CmdOrCtrl+B', click: () => shell.openExternal(URL_) },
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
    cb(['media', 'clipboard-sanitized-write'].includes(permission) && new URL(wc.getURL()).hostname === 'localhost');
  });
  try {
    await startServer();
  } catch (e) {
    dialog.showErrorBox('Nikon Remote', e.code === 'EADDRINUSE'
      ? `Port ${PORT} is already used by another program. Close it, or set PORT to a free port.`
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

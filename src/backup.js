// Backup: copies every new shot to an FTP server, or to ShotDrop when it's running on this PC.
// Shots wait in a queue saved to DATA_DIR/backup-queue.json, so anything taken while the server
// was unreachable (or the app was closed) is uploaded later. Each file goes up as name.part and is
// renamed when complete, so the server (ShotDrop included) never picks up half a file.
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { Client } from 'basic-ftp';

export const SHOTDROP_API_PORT = 8787;
const MODES = ['off', 'shotdrop', 'ftp'];
const FAILED_AFTER = 3;         // tries before a shot shows as failed (it keeps retrying)
const MAX_WAIT = 5 * 60_000;    // longest gap between retries
const IDLE_CLOSE = 20_000;      // keep the connection open this long after the queue empties

const DEFAULTS = {
  mode: 'off',
  ftp: { host: '', port: 21, user: '', pass: '', dir: '/Nikon Remote', tls: false },
  shotdropPort: SHOTDROP_API_PORT,
};

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const portNum = (v, d) => (Number.isInteger(+v) && +v > 0 && +v < 65536 ? +v : d);

// ShotDrop answers /api/health on its API port and, to callers on this PC only, hands out its
// full settings, FTP login included. Returns null when it isn't running (or something else is on the port).
export async function detectShotDrop(apiPort = SHOTDROP_API_PORT) {
  const base = `http://127.0.0.1:${apiPort}`;
  const get = p => fetch(base + p, { signal: AbortSignal.timeout(1500) }).then(r => (r.ok ? r.json() : null));
  try {
    if (!(await get('/api/health'))?.ok) return null;
    const s = await get('/api/settings');
    if (!s || typeof s.libraryId !== 'string' || !s.ftp || !Array.isArray(s.ftp.users)) return null;
    const u = s.ftp.users.find(x => x.username) || s.ftp.users[0];
    return {
      apiPort, ftpPort: portNum(s.ftp.port, 2121), ftpOn: s.ftp.enabled !== false,
      user: u?.username || 'anonymous', pass: u?.password || '', library: s.libraryDir || '',
    };
  } catch { return null; }
}

export class Backup extends EventEmitter {
  constructor({ dataDir, capturesDir }) {
    super();
    this.capturesDir = capturesDir;
    this.cfgFile = join(dataDir, 'backup.json');
    this.queueFile = join(dataDir, 'backup-queue.json');
    this.cfg = this.clean(readJson(this.cfgFile) || {});
    const q = readJson(this.queueFile) || {};
    this.queue = Array.isArray(q.queue) ? q.queue.filter(i => i?.day && i?.file).map(i => ({ ...i, nextAt: 0 })) : [];
    // Uploaded shots, for the current destination only: a new destination starts over.
    this.doneFor = q.doneFor === this.targetId() ? q.doneFor : this.targetId();
    this.done = new Set(q.doneFor === this.targetId() && Array.isArray(q.done) ? q.done : []);
    this.current = null;      // the shot being uploaded
    this.error = '';          // the last connection or upload error, cleared by a success
    this.target = '';         // what the last connection reached, for the status line
    this.client = null;
    this.running = false;
    this.timer = null;
    this.idleTimer = null;
    this.kick();
  }

  // ---------- settings ----------
  clean(c) {
    const f = c.ftp || {};
    return {
      mode: MODES.includes(c.mode) ? c.mode : DEFAULTS.mode,
      ftp: {
        host: str(f.host).replace(/^s?ftps?:\/\//i, '').replace(/\/.*$/, ''),
        port: portNum(f.port, 21), user: str(f.user), pass: String(f.pass ?? '').slice(0, 200),
        dir: str(f.dir, 300) || '/', tls: !!f.tls,
      },
      shotdropPort: portNum(c.shotdropPort, SHOTDROP_API_PORT),
    };
  }

  targetId(cfg = this.cfg) {
    if (cfg.mode === 'ftp') return `ftp://${cfg.ftp.user}@${cfg.ftp.host}:${cfg.ftp.port}${cfg.ftp.dir}`;
    return cfg.mode;
  }

  // What the page shows: never the password, only whether one is saved.
  async view() {
    const shotdrop = await detectShotDrop(this.cfg.shotdropPort);
    const { pass, ...ftp } = this.cfg.ftp;
    return {
      mode: this.cfg.mode, ftp: { ...ftp, passSet: !!pass }, shotdropPort: this.cfg.shotdropPort,
      shotdrop: shotdrop && { ftpPort: shotdrop.ftpPort, ftpOn: shotdrop.ftpOn, library: shotdrop.library },
      status: this.status(),
    };
  }

  // `ftp.pass` left out (or undefined) keeps the saved password.
  merge(patch = {}) {
    const ftp = { ...this.cfg.ftp, ...(patch.ftp || {}) };
    if (patch.ftp?.pass === undefined) ftp.pass = this.cfg.ftp.pass;
    return this.clean({ ...this.cfg, ...patch, ftp });
  }
  save(patch) {
    const next = this.merge(patch);
    if (next.mode === 'ftp' && !next.ftp.host) throw new Error('Enter the FTP server\'s address');
    const moved = this.targetId(next) !== this.targetId();
    this.cfg = next;
    writeFileSync(this.cfgFile, JSON.stringify(this.cfg, null, 2));
    if (moved) { this.done.clear(); this.doneFor = this.targetId(); }
    this.disconnect();
    this.error = '';
    this.connectFails = 0;
    for (const i of this.queue) { i.nextAt = 0; i.tries = 0; i.error = ''; }
    this.persist();
    this.emitStatus();
    this.kick();
  }

  // Connects with these settings (or the saved ones) and makes the folder, without uploading anything.
  async test(patch) {
    const cfg = this.merge(patch);
    if (cfg.mode === 'off') throw new Error('Backup is off');
    const t = await this.resolve(cfg);
    const client = new Client(15_000);
    try {
      await this.login(client, t);
      if (t.dir) await client.ensureDir(t.dir);
      return { ok: true, target: t.label };
    } finally { client.close(); }
  }

  // ---------- status ----------
  status() {
    const failed = this.queue.filter(i => i.tries >= FAILED_AFTER).length;
    return {
      mode: this.cfg.mode, target: this.target || this.label(), pending: this.queue.length, failed,
      current: this.current ? this.current.file : null, error: this.error,
      phase: this.cfg.mode === 'off' ? 'off' : this.current ? 'uploading' : this.error ? 'error' : this.queue.length ? 'waiting' : 'idle',
    };
  }
  label(cfg = this.cfg) {
    return cfg.mode === 'shotdrop' ? 'ShotDrop on this PC' : cfg.mode === 'ftp' ? cfg.ftp.host : '';
  }
  emitStatus() { this.emit('status', this.status()); }

  // For the gallery badge: 'done', 'uploading', 'queued', 'failed' or null (not backed up).
  stateOf(day, file) {
    const key = `${day}/${file}`;
    if (this.done.has(key)) return 'done';
    if (this.current && this.current.day === day && this.current.file === file) return 'uploading';
    const q = this.queue.find(i => i.day === day && i.file === file);
    return q ? (q.tries >= FAILED_AFTER ? 'failed' : 'queued') : null;
  }
  emitPhoto(day, file) { this.emit('photo', { day, name: file, state: this.stateOf(day, file) }); }

  // ---------- queue ----------
  add(day, file) {
    if (this.cfg.mode === 'off' || this.done.has(`${day}/${file}`) || this.queue.some(i => i.day === day && i.file === file)) return false;
    // The folder goes with the shot, so picking another photos folder doesn't strand what's queued.
    this.queue.push({ dir: this.capturesDir, day, file, tries: 0, nextAt: 0, error: '' });
    this.persist();
    this.emitPhoto(day, file);
    this.emitStatus();
    this.kick();
    return true;
  }

  // Queues every shot in the captures folder that isn't backed up yet. Returns how many.
  addEarlier() {
    if (this.cfg.mode === 'off') throw new Error('Turn backup on first');
    let n = 0;
    const days = existsSync(this.capturesDir) ? readdirSync(this.capturesDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : [];
    for (const day of days) {
      for (const file of readdirSync(join(this.capturesDir, day)).sort()) {
        if (file.endsWith('.part') || !statSync(join(this.capturesDir, day, file)).isFile()) continue;
        if (this.add(day, file)) n++;
      }
    }
    return n;
  }

  retryNow() {
    this.connectFails = 0;
    for (const i of this.queue) i.nextAt = 0;
    this.error = '';
    this.emitStatus();
    this.kick();
  }

  persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.writeQueue(), 500);
    this.saveTimer.unref?.();
  }
  writeQueue() {
    clearTimeout(this.saveTimer);
    try {
      writeFileSync(this.queueFile, JSON.stringify({
        queue: this.queue.map(({ dir, day, file, tries, error }) => ({ dir, day, file, tries, error })),
        doneFor: this.doneFor, done: [...this.done],
      }));
    } catch (e) { this.emit('log', `Backup: couldn't save the queue (${e.message})`); }
  }

  // ---------- uploading ----------
  kick() {
    clearTimeout(this.timer);
    if (!this.running) this.loop().catch(e => this.emit('log', `Backup: ${e.message}`));
  }

  async loop() {
    this.running = true;
    try {
      while (this.cfg.mode !== 'off') {
        const now = Date.now();
        const item = this.queue.find(i => i.nextAt <= now);
        if (!item) {
          if (this.queue.length) {
            const wait = Math.max(1000, Math.min(...this.queue.map(i => i.nextAt)) - now);
            this.timer = setTimeout(() => this.kick(), wait);
            this.timer.unref?.();
          }
          break;
        }
        const local = join(item.dir || this.capturesDir, item.day, item.file);
        if (!existsSync(local)) { this.drop(item); continue; } // deleted before it went up
        this.current = item;
        this.emitPhoto(item.day, item.file);
        this.emitStatus();
        try {
          await this.upload(item, local);
          this.done.add(`${item.day}/${item.file}`);
          this.error = '';
          this.drop(item);
        } catch (e) {
          this.disconnect();
          this.current = null;
          this.error = e.message;
          if (e.connect) {
            // The server is unreachable: wait before trying again, without counting it against any shot.
            this.connectFails = (this.connectFails || 0) + 1;
            const at = Date.now() + Math.min(MAX_WAIT, 5000 * 2 ** (this.connectFails - 1));
            for (const i of this.queue) i.nextAt = Math.max(i.nextAt, at);
            this.emitPhoto(item.day, item.file);
            this.emitStatus();
            continue;
          }
          item.tries++;
          item.error = e.message;
          item.nextAt = Date.now() + Math.min(MAX_WAIT, 5000 * 2 ** (item.tries - 1));
          this.emit('log', `Backup ${item.file}: ${e.message}`);
          this.emitPhoto(item.day, item.file);
          this.emitStatus();
        }
      }
    } finally {
      this.running = false;
      this.current = null;
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.disconnect(), IDLE_CLOSE);
      this.idleTimer.unref?.();
    }
  }

  drop(item) {
    this.queue = this.queue.filter(i => i !== item);
    this.current = null;
    this.persist();
    this.emitPhoto(item.day, item.file);
    this.emitStatus();
  }

  async upload(item, local) {
    clearTimeout(this.idleTimer);
    if (!this.client || this.client.closed) {
      try {
        const t = await this.resolve(this.cfg);
        const client = new Client(30_000);
        await this.login(client, t);
        this.client = client;
        this.home = await client.pwd();
        this.remoteRoot = t.dir;
        this.target = t.label;
        this.connectFails = 0;
      } catch (e) { e.connect = true; throw e; }
    }
    const c = this.client;
    await c.cd(this.home);
    await c.ensureDir(this.remoteRoot ? posix.join(this.remoteRoot, item.day) : item.day);
    const part = `${item.file}.part`;
    await c.uploadFrom(local, part);
    try { await c.rename(part, item.file); }
    catch {
      // Some servers won't rename onto an existing file (a shot re-sent after a failure).
      await c.remove(item.file).catch(() => {});
      await c.rename(part, item.file);
    }
  }

  // Where to connect: the FTP settings, or ShotDrop's own FTP server and login.
  async resolve(cfg) {
    if (cfg.mode === 'ftp') {
      if (!cfg.ftp.host) throw new Error('No FTP server set');
      return { host: cfg.ftp.host, port: cfg.ftp.port, user: cfg.ftp.user || 'anonymous', password: cfg.ftp.pass, secure: cfg.ftp.tls, dir: cfg.ftp.dir === '/' ? '/' : cfg.ftp.dir, label: cfg.ftp.host };
    }
    const sd = await detectShotDrop(cfg.shotdropPort);
    if (!sd) throw new Error('ShotDrop isn\'t running on this PC');
    if (!sd.ftpOn) throw new Error('ShotDrop\'s FTP server is turned off');
    // ShotDrop files each upload by its own date and session, so the day folder is only for tidiness.
    return { host: '127.0.0.1', port: sd.ftpPort, user: sd.user, password: sd.pass, secure: false, dir: '', label: 'ShotDrop on this PC' };
  }

  async login(client, t) {
    try {
      await client.access({ host: t.host, port: t.port, user: t.user, password: t.password, secure: t.secure, secureOptions: { servername: t.host } });
    } catch (e) {
      client.close();
      const m = String(e.message || e);
      if (/ECONNREFUSED/.test(m)) throw new Error(`Nothing is accepting FTP at ${t.host}:${t.port}`);
      if (/ENOTFOUND|EAI_AGAIN/.test(m)) throw new Error(`Can't find ${t.host}`);
      if (/^530|login|password/i.test(m)) throw new Error('The server refused the user name or password');
      if (/timeout/i.test(m)) throw new Error(`${t.host} didn't answer`);
      throw new Error(m);
    }
  }

  disconnect() {
    this.client?.close();
    this.client = null;
  }

  stop() {
    clearTimeout(this.timer);
    clearTimeout(this.idleTimer);
    this.writeQueue();
    this.disconnect();
  }
}

function readJson(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; }
}

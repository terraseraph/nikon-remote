// High-level camera control on top of the PTP bridge: connection lifecycle, live view,
// capture, settings and auto-download of new photos. Emits 'state', 'prop', 'photo', 'shot', 'log'.
// Brand-specific operations live in drivers/, picked from the camera's DeviceInfo.
import { mkdirSync, writeFileSync, existsSync, statSync, renameSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bridge } from './bridge.js';
import { Op, OK, respName, parseDeviceInfo, parseObjectInfo } from './ptp.js';
import { PROPS, sleep } from './drivers/ptp.js';
import { pickDriver } from './drivers/index.js';
import { FrameSource } from './frames.js';
import { dayDir, freeName, photoEntry, listPhotos } from './photos.js';

export { PROPS };
// Errors that mean the USB connection itself is gone, not just that the camera refused something.
const LOST = /bridge exited|not connected|HRESULT/i;

// The biggest JPEG in a TIFF-based RAW file (NEF, ARW, DNG…), found through its IFDs and SubIFDs:
// on Nikon Z bodies, a full-size preview. Null for anything else, or a file cut short.
export function rawPreview(buf) {
  const order = buf.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const u16 = o => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = o => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const seen = new Set();
  let best = null;
  const walk = ifd => {
    for (; ifd && !seen.has(ifd); ifd = u32(ifd + 2 + u16(ifd) * 12)) {
      seen.add(ifd);
      let off = 0, len = 0;
      for (let i = 0, n = u16(ifd); i < n; i++) {
        const e = ifd + 2 + i * 12, tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        // SHORT or LONG values, inline when they fit in 4 bytes
        const at = k => (type === 3 ? u16(count > 2 ? u32(e + 8) + k * 2 : e + 8 + k * 2) : u32(count > 1 ? u32(e + 8) + k * 4 : e + 8));
        if (tag === 0x201) off = at(0);
        else if (tag === 0x202) len = at(0);
        else if (tag === 0x14a) for (let k = 0; k < count; k++) walk(at(k));
      }
      if (len > (best?.length ?? 0) && off + len <= buf.length && buf[off] === 0xff && buf[off + 1] === 0xd8) best = buf.subarray(off, off + len);
    }
  };
  try { walk(u32(4)); } catch {} // an offset past the end: keep what was found
  return best;
}

// "20261103T142233" → "2026-11-03"; today when the camera gives no date.
export function captureDay(date) {
  const m = /^(\d{4})(\d{2})(\d{2})T/.exec(date || '');
  return m ? `${m[1]}-${m[2]}-${m[3]}` : new Date().toISOString().slice(0, 10);
}

export class Camera extends FrameSource {
  constructor({ capturesDir, thumbsDir = join(capturesDir, '.thumbs') }) {
    super();
    this.capturesDir = capturesDir;
    this.thumbsDir = thumbsDir;
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(this.thumbsDir, { recursive: true });
    this.connected = false;
    this.name = null;
    this.info = null;
    this.props = {};
    this.liveView = false;     // live view actually running on the camera
    this.wantLiveView = true;  // user preference
    this.capturing = false;
    this.recordingSince = null; // ms timestamp while a movie is recording
    this.smallFrames = false;  // 640px instead of 1024px live view, while someone pulls remotely
    this.driver = null;
    this.cardInfo = new Map();   // handle → ObjectInfo, for files on the camera's card
    this.cardThumbs = new Map(); // handle → JPEG thumbnail, the latest few hundred
    this.cardCache = join(this.thumbsDir, '.card'); // full-size files opened in the viewer
    this.cardViews = new Map();  // cache file → its transfer from the camera, while one runs
    this.cardJob = null;         // progress of a download from the card
    this.bridge = new Bridge();
    this.bridge.on('log', m => this.emit('log', m));
    this.bridge.on('exit', () => this.setDisconnected('Camera bridge stopped'));
    this.connect();
    this.loop();
  }

  state() {
    return {
      connected: this.connected, name: this.name, model: this.info?.model, brand: this.driver?.brand,
      experimental: !!this.driver?.experimental, features: this.driver?.features, liveView: this.liveView,
      wantLiveView: this.wantLiveView, capturing: this.capturing, recordingSince: this.recordingSince, props: this.props, error: this.error || null,
    };
  }

  emitState() { this.emit('state', this.state()); }

  setDisconnected(error) {
    if (!this.connected && this.error === error) return;
    this.connected = false; this.liveView = false; this.recordingSince = null; this.driver?.reset(); this.error = error;
    this.cardInfo.clear(); this.cardThumbs.clear(); // handles are only valid for one session
    this.emitState();
  }

  async connect() {
    this.connecting = true;
    try { await this.doConnect(); } finally { this.connecting = false; }
  }

  async doConnect() {
    const status = await this.bridge.ready;
    if (!status.ready) return this.setDisconnected(status.error);
    try {
      this.info = parseDeviceInfo((await this.bridge.send(Op.GetDeviceInfo, [], { dir: 'read' })).data);
      this.name = status.name;
      this.driver = pickDriver(this);
      await this.driver.init();
      this.connected = true; this.error = null;
      await this.driver.drainEvents();
      await this.driver.loadProps();
      this.emit('log', `Connected to ${this.info.manufacturer} ${this.info.model} (${this.driver.constructor.name})`);
      this.emitState();
    } catch (e) {
      this.setDisconnected(e.message);
    }
  }

  async reconnect() {
    this.setDisconnected('Reconnecting…');
    await this.bridge.restart();
    await this.connect();
  }

  // Main loop: keeps live view frames flowing to viewers and polls camera events.
  async loop() {
    let lastEvents = 0, lastModeCheck = 0, lastRetry = Date.now();
    for (;;) {
      try {
        if (!this.connected) {
          if (!this.connecting && Date.now() - lastRetry > 4000) { lastRetry = Date.now(); await this.reconnect(); }
          await sleep(250);
          continue;
        }
        const streaming = this.wantLiveView && (this.viewers.size > 0 || this.pulling);
        if (streaming && !this.liveView) await this.startLiveView();
        if (!streaming && this.liveView && !this.recordingSince) await this.stopLiveView();
        if (this.liveView && this.pulling !== this.smallFrames) await this.setFrameSize(this.pulling);
        if (this.liveView && !this.capturing) await this.pumpFrame();
        if (Date.now() - lastEvents > 250) { lastEvents = Date.now(); await this.driver.pollEvents(); }
        if (Date.now() - lastModeCheck > 1000 && !this.capturing) { lastModeCheck = Date.now(); await this.driver.checkMode(); }
        await sleep(this.liveView ? 30 : 150);
      } catch (e) {
        this.emit('log', `loop: ${e.message}`);
        // Any Windows device error (e.g. 0x802A0002 after the camera is power-cycled) means the
        // handle is dead: drop it so the retry above restarts the bridge with a fresh connection.
        if (LOST.test(e.message)) this.setDisconnected('Camera connection lost — reconnecting…');
        await sleep(500);
      }
    }
  }

  async startLiveView() {
    try {
      await this.driver.startLiveView();
    } catch (e) {
      this.emit('log', `Live view: ${e.message}`); this.wantLiveView = false; return this.emitState();
    }
    await this.setFrameSize(this.pulling);
    this.liveView = true;
    this.emitState();
  }

  async stopLiveView() {
    await this.driver.stopLiveView();
    this.liveView = false;
    this.emitState();
  }

  async setLiveView(on) {
    this.wantLiveView = !!on;
    this.emitState();
  }

  async pumpFrame() {
    const f = await this.driver.getFrame();
    if (f?.stopped) { this.liveView = false; return; } // camera dropped live view
    if (f) this.pushFrame(f.jpeg, f.af || null);
  }

  // Smaller frames while someone watches over the internet, where frame size sets the frame rate.
  async setFrameSize(small) {
    this.smallFrames = small;
    await this.driver.setFrameSize(small);
  }

  // Move the AF point to a spot given as fractions (0–1) of the live view, then optionally focus.
  async setFocusPoint(fx, fy, { focus = true } = {}) {
    if (!this.liveView) throw new Error('Tap-to-focus needs live view');
    await this.driver.setFocusPoint(fx, fy);
    return { focus: focus ? await this.autofocus() : null };
  }

  async startMovie() {
    if (!this.connected) throw new Error('Camera not connected');
    if (this.recordingSince) return;
    if (!this.driver.features.movie) throw this.driver.unsupported('Video recording');
    if (!this.liveView) await this.startLiveView();
    await this.driver.startMovie();
    this.recordingSince = Date.now();
    this.emitState();
  }

  async stopMovie() {
    if (!this.recordingSince) return;
    try { await this.driver.stopMovie(); } finally {
      this.recordingSince = null;
      this.emitState();
    }
  }

  // Called by drivers with a property in canonical codes and units.
  updateProp(code, desc, emit = true) {
    this.props[code] = { name: PROPS[code], ...desc };
    if (emit) this.emit('prop', { code, ...this.props[code] });
  }

  refreshProp(code, emit) { return this.driver.refreshProp(code, emit); }

  async setProp(code, value) {
    const p = this.props[code];
    if (!p) throw new Error('Unknown property');
    if (!p.writable) throw new Error(`${p.name} is read-only in the current mode`);
    await this.driver.setProp(code, value);
  }

  // Step an enum property up/down by n positions (used by voice commands).
  async stepProp(code, delta) {
    const p = this.props[code];
    if (!p?.values) throw new Error('Not adjustable');
    const i = p.values.indexOf(p.value);
    const next = p.values[Math.max(0, Math.min(p.values.length - 1, i + delta))];
    if (next !== p.value) await this.setProp(code, next);
  }

  autofocus() { return this.driver.autofocus(); }

  async shoot({ af = false } = {}) {
    if (!this.connected) throw new Error('Camera not connected');
    if (this.capturing) throw new Error('Already capturing');
    if (this.recordingSince) throw new Error('Stop recording before taking a photo');
    this.capturing = true;
    this.emitState();
    try {
      let focus = null;
      if (af && this.liveView) focus = await this.autofocus();
      const code = await this.driver.capture({ liveView: this.liveView });
      const result = { ok: code === OK, code: respName(code), focus, at: Date.now() };
      this.emit('shot', result);
      return result;
    } finally {
      this.capturing = false;
      this.emitState();
    }
  }

  async downloadPhoto(handle) {
    const info = parseObjectInfo((await this.bridge.send(Op.GetObjectInfo, [handle], { dir: 'read' })).data);
    if (info.format === 0x3001 || !info.filename) return; // a folder, from drivers that scan for new objects
    const { day, dir } = dayDir(this.capturesDir);
    // A refused transfer is logged and skipped; a lost connection goes on up to the main loop.
    const photo = await this.saveObject(handle, info, day, dir).catch(e => { if (!e.ptp) throw e; });
    if (photo) this.emit('photo', photo);
  }

  // Copies one object into `dir`, through a .part file so a failed transfer leaves nothing behind.
  async saveObject(handle, info, day, dir) {
    const file = freeName(dir, info.filename);
    const thumb = await this.bridge.send(Op.GetThumb, [handle], { dir: 'read' });
    if (thumb.code === OK) writeFileSync(join(this.thumbsDir, `${day}_${file}.jpg`), thumb.data);
    const part = join(dir, `${file}.part`);
    try {
      const res = await this.bridge.send(Op.GetObject, [handle], { dir: 'read', file: part });
      if (res.code !== OK) throw Object.assign(new Error(respName(res.code)), { ptp: true });
      renameSync(part, join(dir, file));
    } catch (e) {
      rmSync(part, { force: true });
      this.emit('log', `Download ${file}: ${e.message}`);
      throw e;
    }
    return photoEntry(day, file, info.size);
  }

  // ---------- the camera's card ----------
  checkCard() {
    if (!this.connected) throw new Error('Camera not connected');
    if (!this.driver.features.card) throw new Error(`Browsing the card isn't supported on ${this.driver.brand} cameras yet`);
    if (this.recordingSince) throw new Error('Stop recording before browsing the card');
  }

  async cardObjectInfo(handle) {
    if (!this.cardInfo.has(handle)) {
      const res = await this.bridge.send(Op.GetObjectInfo, [handle], { dir: 'read' });
      if (res.code !== OK || !res.data) throw new Error(respName(res.code));
      this.cardInfo.set(handle, parseObjectInfo(res.data));
    }
    return this.cardInfo.get(handle);
  }

  // Files on the card, newest first, a page at a time. Handle numbers don't follow shooting order
  // (Nikon groups them by file type), so every file's info is read to sort by capture date: about
  // 8 ms each, cached after the first page. `next` is where the following page starts, null at the end.
  async cardFiles({ start = 0, limit = 40 } = {}) {
    this.checkCard();
    const res = await this.bridge.send(Op.GetObjectHandles, [0xffffffff, 0, 0], { dir: 'read' });
    if (res.code !== OK || !res.data) throw new Error(`Couldn't read the card: ${respName(res.code)}`);
    const n = res.data.readUInt32LE(0), all = [];
    for (let i = 0; i < n; i++) {
      const handle = res.data.readUInt32LE(4 + i * 4);
      let info;
      try { info = await this.cardObjectInfo(handle); }
      catch (e) { if (LOST.test(e.message)) throw e; continue; } // a file deleted on the camera meanwhile
      if (info.format !== 0x3001 && info.filename) all.push({ handle, info }); // not folders
    }
    // "YYYYMMDDThhmmss" sorts as text; undated files go last, then by handle.
    all.sort((a, b) => (b.info.captureDate || '').localeCompare(a.info.captureDate || '') || b.handle - a.handle);
    const from = Math.max(0, Math.floor(+start) || 0);
    const files = all.slice(from, from + limit).map(({ handle, info }) => {
      const day = captureDay(info.captureDate);
      const local = join(this.capturesDir, day, info.filename);
      return {
        handle, name: info.filename, size: info.size, day, date: info.captureDate,
        video: /\.(mov|mp4)$/i.test(info.filename),
        downloaded: existsSync(local) && statSync(local).size === info.size,
      };
    });
    return { files, next: from + limit < all.length ? from + limit : null, total: all.length };
  }

  async cardThumb(handle) {
    this.checkCard();
    if (!Number.isInteger(handle) || handle <= 0) throw new Error('Invalid photo');
    if (this.cardThumbs.has(handle)) return this.cardThumbs.get(handle);
    const res = await this.bridge.send(Op.GetThumb, [handle], { dir: 'read' });
    if (res.code !== OK || !res.data?.length) throw new Error(`No thumbnail: ${respName(res.code)}`);
    if (this.cardThumbs.size >= 300) this.cardThumbs.delete(this.cardThumbs.keys().next().value);
    this.cardThumbs.set(handle, res.data);
    return res.data;
  }

  // A card file at full size, for the viewer: { file } to serve, or { jpeg }. It comes from Pictures
  // when already copied, else whole from the camera into a small cache. Browsers can't show RAW
  // files, so those give their built-in full-size JPEG, or failing that the camera's smaller preview.
  async cardView(handle) {
    this.checkCard();
    if (!Number.isInteger(handle) || handle <= 0) throw new Error('Invalid photo');
    const info = await this.cardObjectInfo(handle);
    if (info.format === 0x3001 || !info.filename) throw new Error('Not a photo');
    const local = join(this.capturesDir, captureDay(info.captureDate), info.filename);
    let file = local;
    if (!existsSync(local) || statSync(local).size !== info.size) {
      file = join(this.cardCache, `${info.captureDate || handle}_${info.filename}`);
      // Two taps on the same file share one transfer.
      if (!(existsSync(file) && statSync(file).size === info.size)) {
        if (!this.cardViews.has(file)) this.cardViews.set(file, this.fetchToCache(handle, file).finally(() => this.cardViews.delete(file)));
        await this.cardViews.get(file);
      }
    }
    if (/\.(jpe?g|mov|mp4)$/i.test(info.filename)) return { file };
    const jpeg = rawPreview(readFileSync(file));
    if (jpeg) return { jpeg };
    if (this.info?.operations?.includes(Op.NikonGetLargeThumb)) {
      const res = await this.bridge.send(Op.NikonGetLargeThumb, [handle], { dir: 'read' });
      if (res.code === OK && res.data?.length) return { jpeg: res.data };
    }
    return { jpeg: await this.cardThumb(handle) };
  }

  async fetchToCache(handle, file) {
    mkdirSync(this.cardCache, { recursive: true });
    // Only the latest few are kept: videos run to hundreds of MB. One still being served stays put.
    const old = readdirSync(this.cardCache).map(f => join(this.cardCache, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const f of old.slice(4)) try { rmSync(f, { force: true }); } catch {}
    const part = `${file}.part`;
    try {
      const res = await this.bridge.send(Op.GetObject, [handle], { dir: 'read', file: part });
      if (res.code !== OK) throw new Error(respName(res.code));
      renameSync(part, file);
    } catch (e) {
      rmSync(part, { force: true });
      throw e;
    }
  }

  // Starts copying files from the card into their capture day's folder, in the background, and
  // returns at once: a full card takes longer than a request may stay open over the tunnel.
  // Pages poll cardJob for progress; files already copied (same name and size) are skipped.
  downloadFromCard(handles) {
    this.checkCard();
    if (this.cardJob && !this.cardJob.finished) throw new Error('Already downloading from the card');
    if (!Array.isArray(handles) || !handles.length) throw new Error('Pick some photos first');
    if (handles.length > 500) throw new Error('Pick up to 500 photos at a time');
    if (!handles.every(h => Number.isInteger(h) && h > 0 && h <= 0xffffffff)) throw new Error('Invalid photo list');
    const job = this.cardJob = { total: handles.length, done: 0, saved: 0, skipped: 0, failed: [], finished: false };
    (async () => {
      for (const h of handles) {
        if (!this.connected || job.lost) { job.failed.push({ handle: h, error: 'Camera disconnected' }); continue; }
        let name = `#${h}`;
        try {
          const info = await this.cardObjectInfo(h);
          name = info.filename || name;
          if (info.format === 0x3001 || !info.filename) throw new Error('Not a photo');
          const day = captureDay(info.captureDate);
          const dir = join(this.capturesDir, day);
          mkdirSync(dir, { recursive: true });
          const local = join(dir, info.filename);
          if (existsSync(local) && statSync(local).size === info.size) job.skipped++;
          else { this.emit('photo', await this.saveObject(h, info, day, dir)); job.saved++; }
        } catch (e) {
          job.failed.push({ handle: h, name, error: e.message });
          if (LOST.test(e.message)) job.lost = true;
        }
        job.done++;
      }
    })().catch(e => job.failed.push({ error: e.message })).finally(() => { job.finished = true; });
    return { ...job };
  }

  listPhotos(limit) { return listPhotos(this.capturesDir, limit); }

  async close() {
    if (this.liveView) await this.stopLiveView().catch(() => {});
    this.bridge.stop();
  }
}

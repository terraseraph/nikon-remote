// A webcam as a camera source. Node can't open a webcam without native modules, so the app's page
// on the laptop (the desktop window or a localhost tab) opens it with getUserMedia and acts as the
// camera: it holds a command stream open here (SSE), pushes live view frames, and uploads photos and
// video. This class gives the rest of the server the same surface as Camera, so the routes, phones,
// shot assist and triggers work on either. Emits 'state', 'prop', 'photo', 'shot', 'log'.
import { writeFileSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { FrameSource } from './frames.js';
import { dayDir, freeName, photoEntry } from './photos.js';

const REPLY_MS = 15_000;
const LIVE_FPS = 12, IDLE_FPS = 2; // idle still refreshes the frame shot assist looks at

export class Webcam extends FrameSource {
  constructor({ capturesDir, thumbsDir }) {
    super();
    Object.assign(this, { capturesDir, thumbsDir });
    this.host = null;          // the laptop page's command stream
    this.label = null;
    this.deviceId = null;
    this.props = {};
    this.features = { liveView: true, movie: false, autofocus: false, focusPoint: false };
    this.wantLiveView = true;
    this.capturing = false;
    this.recordingSince = null;
    this.movie = null;         // { file, day, dir } while recording
    this.pending = new Map();  // command id → { resolve, reject, timer }
    this.nextId = 1;
    this.error = 'No webcam selected';
    this.live = '';            // last frame rate/size sent to the host
    setInterval(() => this.sendLive(), 500).unref();
  }

  get connected() { return !!this.host && Object.keys(this.props).length > 0; }
  get liveView() { return this.connected && this.wantLiveView; }
  // The advisor names the camera from this.
  get info() { return { manufacturer: 'Webcam', model: this.label || '' }; }
  isWebcam = true;

  state() {
    return {
      connected: this.connected, name: this.label, model: this.label, brand: 'Webcam', experimental: false,
      features: this.features, liveView: this.liveView, wantLiveView: this.wantLiveView, capturing: this.capturing,
      recordingSince: this.recordingSince, props: this.props, error: this.connected ? null : this.error,
    };
  }
  emitState() { this.emit('state', this.state()); }

  // ---------- the host page ----------
  // A newer page takes over from an older one; the old one is told so it stops its webcam.
  attach(res, { deviceId, label }) {
    if (this.host) this.release('Another window took over the webcam');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    this.host = res;
    Object.assign(this, { deviceId, label: label || 'Webcam', props: {}, error: 'Opening the webcam…', live: '' });
    res.on('close', () => { if (this.host === res) this.detach('The webcam was closed on the laptop. Open Nikon Remote there and pick the webcam again.'); });
    this.send('hello', {});
    this.emitState();
  }

  // `forget`: the user switched back to the USB camera, so the page shouldn't reopen the webcam next time.
  release(reason, forget = false) {
    const res = this.host;
    if (!res) return;
    this.host = null; // before end(), so its close handler sees it is no longer the host
    res.write(`event: release\ndata: ${JSON.stringify({ reason, forget })}\n\n`);
    res.end();
    this.detach(reason);
  }

  detach(error) {
    this.host = null;
    this.error = error;
    this.props = {};
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('The webcam was closed')); }
    this.pending.clear();
    if (this.movie) this.finishMovie();
    this.capturing = false;
    this.emitState();
  }

  send(type, data) { this.host?.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }

  // Frames only flow while someone looks: full rate for viewers, a trickle otherwise, smaller over the tunnel.
  sendLive() {
    if (!this.host) return;
    const fps = !this.wantLiveView ? 0 : this.viewers.size || this.pulling || this.recordingSince ? LIVE_FPS : IDLE_FPS;
    const live = JSON.stringify({ fps, width: this.pulling ? 640 : 1024 });
    if (live !== this.live) { this.live = live; this.send('live', JSON.parse(live)); }
  }

  // The host's view of the device: label, properties (already in canonical form) and features.
  update({ label, props, features }) {
    if (!this.host) throw new Error('Not the webcam host');
    const first = !this.connected;
    if (label) this.label = String(label).slice(0, 80);
    if (features) this.features = { ...this.features, ...features, liveView: true };
    if (props) this.setProps(props);
    if (first || features) this.emitState();
  }

  setProps(props) {
    const fresh = {};
    for (const [code, p] of Object.entries(props).slice(0, 40)) {
      if (!p?.name || !Array.isArray(p.values)) continue;
      fresh[code] = { name: String(p.name), value: p.value, values: p.values.slice(0, 64), writable: !!p.writable };
    }
    const before = this.props;
    this.props = fresh;
    if (!Object.keys(before).length) return;
    // A new resolution can change what the webcam offers: then the whole list goes out again.
    if (Object.keys(before).join() !== Object.keys(fresh).join()) return this.emitState();
    for (const [code, p] of Object.entries(fresh)) {
      if (JSON.stringify(before[code]) !== JSON.stringify(p)) this.emit('prop', { code: +code, ...p });
    }
  }

  // Sends a command to the host page and waits for its reply (or a photo upload for that id).
  command(cmd, args = {}, timeoutMs = REPLY_MS) {
    if (!this.host) return Promise.reject(new Error('Webcam not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The webcam didn\'t answer')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send('cmd', { id, cmd, ...args });
    });
  }

  settle(id, err, value) {
    const p = this.pending.get(+id);
    if (!p) return false;
    this.pending.delete(+id);
    clearTimeout(p.timer);
    err ? p.reject(new Error(err)) : p.resolve(value);
    return true;
  }

  reply({ id, error, result, props }) {
    if (props) this.setProps(props);
    this.settle(id, error, result);
  }

  receiveFrame(buf) {
    if (!this.host || !this.wantLiveView) return;
    this.pushFrame(buf);
  }

  // ---------- the camera surface used by the routes ----------
  async setLiveView(on) { this.wantLiveView = !!on; this.sendLive(); this.emitState(); }

  async setProp(code, value) {
    const p = this.props[code];
    if (!p) throw new Error('Unknown property');
    if (!p.writable) throw new Error(`${p.name} can't be changed on this webcam`);
    await this.command('set', { code: +code, value });
  }

  async stepProp(code, delta) {
    const p = this.props[code];
    if (!p?.values) throw new Error('Not adjustable');
    const i = p.values.indexOf(p.value);
    const next = p.values[Math.max(0, Math.min(p.values.length - 1, i + delta))];
    if (next !== p.value) await this.setProp(code, next);
  }

  refreshProp() {}

  autofocus() {
    if (!this.features.autofocus) return Promise.resolve('This webcam has no autofocus control');
    return this.command('af');
  }

  async setFocusPoint(x, y, { focus = true } = {}) {
    if (!this.features.focusPoint) throw new Error('Tap-to-focus isn\'t supported on this webcam');
    return { focus: await this.command('focusPoint', { x, y, focus }) };
  }

  async shoot({ af = false } = {}) {
    if (!this.connected) throw new Error('Webcam not connected');
    if (this.capturing) throw new Error('Already capturing');
    if (this.recordingSince) throw new Error('Stop recording before taking a photo');
    this.capturing = true;
    this.emitState();
    try {
      const focus = af && this.features.autofocus ? await this.autofocus().catch(e => e.message) : null;
      await this.command('shoot');
      const result = { ok: true, code: 'OK', focus, at: Date.now() };
      this.emit('shot', result);
      return result;
    } finally {
      this.capturing = false;
      this.emitState();
    }
  }

  // The full-resolution photo for a 'shoot' command, saved like a camera download.
  savePhoto(id, buf) {
    if (!this.pending.has(+id)) throw new Error('No photo was asked for');
    const { day, dir } = dayDir(this.capturesDir);
    const file = freeName(dir, `Webcam_${stamp()}.jpg`);
    writeFileSync(join(dir, file), buf);
    this.saveThumb(day, file, buf);
    const photo = photoEntry(day, file, buf.length);
    this.emit('photo', photo);
    this.settle(id, null, photo);
    return photo;
  }

  saveThumb(day, file, src) {
    try { writeFileSync(join(this.thumbsDir, `${day}_${file}.jpg`), thumbnail(src)); }
    catch (e) { this.emit('log', `Thumbnail ${file}: ${e.message}`); }
  }

  // Video: the host records with MediaRecorder and uploads a chunk every second, appended here,
  // so a long clip never sits in the page's memory and a closed window keeps what was recorded.
  async startMovie() {
    if (!this.connected) throw new Error('Webcam not connected');
    if (this.recordingSince) return;
    if (!this.features.movie) throw new Error('Video recording isn\'t supported in this browser');
    const { ext } = await this.command('record', { on: true });
    const { day, dir } = dayDir(this.capturesDir);
    this.movie = { day, dir, file: freeName(dir, `Webcam_${stamp()}.${ext === 'mp4' ? 'mp4' : 'webm'}`) };
    writeFileSync(join(dir, this.movie.file), '');
    this.recordingSince = Date.now();
    this.sendLive();
    this.emitState();
  }

  appendMovie(buf) {
    if (!this.movie) throw new Error('Not recording');
    appendFileSync(join(this.movie.dir, this.movie.file), buf);
  }

  async stopMovie() {
    if (!this.recordingSince) return;
    try { await this.command('record', { on: false }, 60_000); } finally { this.finishMovie(); }
  }

  finishMovie() {
    const m = this.movie;
    this.movie = null;
    this.recordingSince = null;
    this.emitState();
    if (!m) return;
    const size = statSync(join(m.dir, m.file)).size;
    if (this.frame) this.saveThumb(m.day, m.file, this.frame);
    this.emit('photo', photoEntry(m.day, m.file, size));
  }

  async reconnect() { if (this.host) await this.command('reopen', {}, 20_000); }
  async close() { await this.stopMovie().catch(() => {}); this.release('The app is closing'); }
}

const pad = n => String(n).padStart(2, '0');
function stamp(d = new Date()) { return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; }

// A ~320px gallery thumbnail by averaging blocks of pixels; jpeg-js is all we have without native deps.
export function thumbnail(src, width = 320) {
  const img = jpeg.decode(src, { useTArray: true, maxMemoryUsageInMB: 1024 });
  const f = Math.max(1, Math.floor(img.width / width));
  const w = Math.floor(img.width / f), h = Math.floor(img.height / f);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < f; dy++) {
        let i = ((y * f + dy) * img.width + x * f) * 4;
        for (let dx = 0; dx < f; dx++, i += 4) { r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; }
      }
      const o = (y * w + x) * 4, n = f * f;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return jpeg.encode({ data: out, width: w, height: h }, 75).data;
}

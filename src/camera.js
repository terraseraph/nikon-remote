// High-level Nikon camera control on top of the PTP bridge: connection lifecycle, live view,
// capture, settings and auto-download of new photos. Emits 'state', 'prop', 'photo', 'shot', 'log'.
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Bridge } from './bridge.js';
import {
  Op, OK, respName, Reader, encodeValue,
  parseDeviceInfo, parsePropDesc, parseObjectInfo, parseNikonEvents,
} from './ptp.js';

// Properties surfaced in the UI. Whether each is writable depends on the mode dial.
export const PROPS = {
  0x500e: 'mode', 0x5007: 'aperture', 0xd100: 'shutter', 0x500f: 'iso', 0x5010: 'ev',
  0x5005: 'wb', 0x500b: 'metering', 0x500a: 'focus', 0x5004: 'quality', 0x5003: 'size', 0x5001: 'battery',
};

const BUSY = new Set([0x2019, 0xa001]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Camera extends EventEmitter {
  constructor({ capturesDir }) {
    super();
    this.capturesDir = capturesDir;
    this.thumbsDir = join(capturesDir, '.thumbs');
    mkdirSync(this.thumbsDir, { recursive: true });
    this.connected = false;
    this.name = null;
    this.info = null;
    this.props = {};
    this.liveView = false;     // live view actually running on the camera
    this.wantLiveView = true;  // user preference
    this.viewers = new Set();  // MJPEG responses
    this.capturing = false;
    this.frame = null;
    this.bridge = new Bridge();
    this.bridge.on('log', m => this.emit('log', m));
    this.bridge.on('exit', () => this.setDisconnected('Camera bridge stopped'));
    this.connect();
    this.loop();
  }

  state() {
    return {
      connected: this.connected, name: this.name, model: this.info?.model, liveView: this.liveView,
      wantLiveView: this.wantLiveView, capturing: this.capturing, props: this.props, error: this.error || null,
    };
  }

  emitState() { this.emit('state', this.state()); }

  setDisconnected(error) {
    if (!this.connected && this.error === error) return;
    this.connected = false; this.liveView = false; this.error = error;
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
      this.connected = true; this.error = null;
      await this.drainEvents();
      for (const code of Object.keys(PROPS)) await this.refreshProp(+code, false);
      this.emit('log', `Connected to ${this.info.manufacturer} ${this.info.model}`);
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
    let lastEvents = 0, lastRetry = Date.now();
    for (;;) {
      try {
        if (!this.connected) {
          if (!this.connecting && Date.now() - lastRetry > 4000) { lastRetry = Date.now(); await this.reconnect(); }
          await sleep(250);
          continue;
        }
        const streaming = this.wantLiveView && this.viewers.size > 0;
        if (streaming && !this.liveView) await this.startLiveView();
        if (!streaming && this.liveView) await this.stopLiveView();
        if (this.liveView && !this.capturing) await this.pumpFrame();
        if (Date.now() - lastEvents > 250) { lastEvents = Date.now(); await this.pollEvents(); }
        await sleep(this.liveView ? 30 : 150);
      } catch (e) {
        this.emit('log', `loop: ${e.message}`);
        if (/bridge exited|not connected|0x8007/i.test(e.message)) this.setDisconnected(e.message);
        await sleep(500);
      }
    }
  }

  async waitReady(timeoutMs = 5000) {
    const end = Date.now() + timeoutMs;
    let code;
    while (Date.now() < end) {
      code = (await this.bridge.send(Op.NikonDeviceReady)).code;
      if (!BUSY.has(code)) return code;
      await sleep(50);
    }
    return code;
  }

  async startLiveView() {
    const { code } = await this.bridge.send(Op.NikonStartLiveView);
    if (code !== OK && !BUSY.has(code)) { this.emit('log', `Live view: ${respName(code)}`); this.wantLiveView = false; return this.emitState(); }
    await this.waitReady();
    this.liveView = true;
    this.emitState();
  }

  async stopLiveView() {
    await this.bridge.send(Op.NikonEndLiveView);
    this.liveView = false;
    this.emitState();
  }

  async setLiveView(on) {
    this.wantLiveView = !!on;
    this.emitState();
  }

  async pumpFrame() {
    const res = await this.bridge.send(Op.NikonGetLiveViewImage, [], { dir: 'read' });
    if (res.code === 0xa00b || res.code === 0xa008) { this.liveView = false; return; } // camera dropped live view
    if (res.code !== OK || !res.data) return;
    const soi = res.data.indexOf(Buffer.from([0xff, 0xd8]));
    if (soi < 0) return;
    this.frame = res.data.subarray(soi);
    for (const viewer of this.viewers) writeFrame(viewer, this.frame);
  }

  addViewer(res) {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store', Connection: 'close',
    });
    this.viewers.add(res);
    if (this.frame) writeFrame(res, this.frame);
    res.on('close', () => this.viewers.delete(res));
  }

  async drainEvents() {
    await this.bridge.send(Op.NikonCheckEvent, [], { dir: 'read' }).catch(() => {});
  }

  async pollEvents() {
    const res = await this.bridge.send(Op.NikonCheckEvent, [], { dir: 'read' });
    if (res.code !== OK || !res.data) return;
    for (const ev of parseNikonEvents(res.data)) {
      if (ev.code === 0x4002) await this.downloadPhoto(ev.param);
      else if (ev.code === 0x4006 && PROPS[ev.param]) await this.refreshProp(ev.param);
      else if (ev.code === 0x4006 && ev.param === 0xd1a2) {} // live view status: handled by frame errors
    }
  }

  async refreshProp(code, emit = true) {
    const res = await this.bridge.send(Op.GetDevicePropDesc, [code], { dir: 'read' });
    if (res.code !== OK) return;
    const d = parsePropDesc(res.data);
    this.props[code] = { name: PROPS[code], type: d.type, writable: d.writable, value: d.current, values: d.values, range: d.range };
    if (emit) this.emit('prop', { code, ...this.props[code] });
    // Exposure mode changes which other settings are writable.
    if (emit && code === 0x500e) for (const c of [0x5007, 0xd100, 0x5010]) await this.refreshProp(c);
  }

  async setProp(code, value) {
    const p = this.props[code];
    if (!p) throw new Error('Unknown property');
    if (!p.writable) throw new Error(`${p.name} is read-only in the current mode`);
    const { code: rc } = await this.bridge.send(Op.SetDevicePropValue, [code], { dir: 'write', data: encodeValue(p.type, value) });
    await this.refreshProp(code);
    if (rc !== OK) throw new Error(respName(rc));
  }

  // Step an enum property up/down by n positions (used by voice commands).
  async stepProp(code, delta) {
    const p = this.props[code];
    if (!p?.values) throw new Error('Not adjustable');
    const i = p.values.indexOf(p.value);
    const next = p.values[Math.max(0, Math.min(p.values.length - 1, i + delta))];
    if (next !== p.value) await this.setProp(code, next);
  }

  async autofocus() {
    const { code } = await this.bridge.send(Op.NikonAfDrive);
    if (code !== OK) return respName(code);
    const done = await this.waitReady(4000);
    return done === OK ? 'OK' : respName(done);
  }

  async shoot({ af = false } = {}) {
    if (!this.connected) throw new Error('Camera not connected');
    if (this.capturing) throw new Error('Already capturing');
    this.capturing = true;
    this.emitState();
    try {
      let focus = null;
      if (af && this.liveView) focus = await this.autofocus();
      const { code } = this.liveView
        ? await this.bridge.send(Op.NikonInitiateCaptureRecInMedia, [0xffffffff, 0])
        : await this.bridge.send(Op.InitiateCapture, [0, 0]);
      if (code === OK) await this.waitReady(8000);
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
    const day = new Date().toISOString().slice(0, 10);
    const dir = join(this.capturesDir, day);
    mkdirSync(dir, { recursive: true });
    let file = info.filename;
    for (let n = 1; existsSync(join(dir, file)); n++) file = info.filename.replace(/(\.\w+)$/, `_${n}$1`);
    const thumb = await this.bridge.send(Op.GetThumb, [handle], { dir: 'read' });
    if (thumb.code === OK) writeFileSync(join(this.thumbsDir, `${day}_${file}.jpg`), thumb.data);
    const res = await this.bridge.send(Op.GetObject, [handle], { dir: 'read', file: join(dir, file) });
    if (res.code !== OK) return this.emit('log', `Download ${file}: ${respName(res.code)}`);
    const photo = photoEntry(day, file, info.size);
    this.emit('photo', photo);
  }

  listPhotos(limit = 60) {
    const out = [];
    const days = existsSync(this.capturesDir) ? readdirSync(this.capturesDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse() : [];
    for (const day of days) {
      const files = readdirSync(join(this.capturesDir, day))
        .map(f => ({ f, t: statSync(join(this.capturesDir, day, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const { f } of files) {
        out.push(photoEntry(day, f, statSync(join(this.capturesDir, day, f)).size));
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  async close() {
    if (this.liveView) await this.stopLiveView().catch(() => {});
    this.bridge.stop();
  }
}

function photoEntry(day, file, size) {
  const isJpeg = /\.jpe?g$/i.test(file);
  return {
    name: file, day, size,
    url: `/captures/${day}/${encodeURIComponent(file)}`,
    thumb: `/captures/.thumbs/${day}_${encodeURIComponent(file)}.jpg`,
    preview: isJpeg ? `/captures/${day}/${encodeURIComponent(file)}` : `/captures/.thumbs/${day}_${encodeURIComponent(file)}.jpg`,
  };
}

function writeFrame(res, jpeg) {
  res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
  res.write(jpeg);
  res.write('\r\n');
}

// High-level Nikon camera control on top of the PTP bridge: connection lifecycle, live view,
// capture, settings and auto-download of new photos. Emits 'state', 'prop', 'photo', 'shot', 'log'.
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Bridge } from './bridge.js';
import {
  Op, OK, respName, encodeValue, NikonProp,
  parseDeviceInfo, parsePropDesc, parseObjectInfo, parseNikonEvents, parseLiveViewHeader,
} from './ptp.js';

// Properties surfaced in the UI. Whether each is writable depends on the mode dial.
export const PROPS = {
  0x500e: 'mode', 0x5007: 'aperture', 0xd100: 'shutter', 0x500f: 'iso', 0x5010: 'ev',
  0x5005: 'wb', 0x500b: 'metering', 0x500a: 'focus', 0x5004: 'quality', 0x5003: 'size', 0x5001: 'battery',
};

const BUSY = new Set([0x2019]);
const INVALID_STATUS = 0xa004;
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
    this.recordingSince = null; // ms timestamp while a movie is recording
    this.frame = null;
    this.lvInfo = null;
    this.bridge = new Bridge();
    this.bridge.on('log', m => this.emit('log', m));
    this.bridge.on('exit', () => this.setDisconnected('Camera bridge stopped'));
    this.connect();
    this.loop();
  }

  state() {
    return {
      connected: this.connected, name: this.name, model: this.info?.model, liveView: this.liveView,
      wantLiveView: this.wantLiveView, capturing: this.capturing, recordingSince: this.recordingSince, props: this.props, error: this.error || null,
    };
  }

  emitState() { this.emit('state', this.state()); }

  setDisconnected(error) {
    if (!this.connected && this.error === error) return;
    this.connected = false; this.liveView = false; this.recordingSince = null; this.pcMode = this.appMode = false; this.error = error;
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
        if (!streaming && this.liveView && !this.recordingSince) await this.stopLiveView();
        if (this.liveView && !this.capturing) await this.pumpFrame();
        if (Date.now() - lastEvents > 250) { lastEvents = Date.now(); await this.pollEvents(); }
        await sleep(this.liveView ? 30 : 150);
      } catch (e) {
        this.emit('log', `loop: ${e.message}`);
        // Any Windows device error (e.g. 0x802A0002 after the camera is power-cycled) means the
        // handle is dead: drop it so the retry above restarts the bridge with a fresh connection.
        if (/bridge exited|not connected|HRESULT/i.test(e.message)) this.setDisconnected('Camera connection lost — reconnecting…');
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

  // Nikon Z bodies gate some operations behind host-control modes, switched on demand:
  //  - PC camera mode (ChangeCameraMode 1): live view can refuse to start without it.
  //  - application mode (ChangeApplicationMode 1): needed before movie recording.
  // Stills work without either. Both reset when the camera is power-cycled.
  // Returns true if the mode was switched, so the caller can retry.
  async enterMode(flag, op, reason) {
    if (this[flag] || !this.info?.operations.includes(op)) return false;
    this.emit('log', `Switching camera to ${flag === 'pcMode' ? 'PC control' : 'application'} mode to ${reason}`);
    const { code } = await this.bridge.send(op, [1]);
    await this.waitReady();
    this[flag] = code === OK;
    return this[flag];
  }

  async startLiveView() {
    let { code } = await this.bridge.send(Op.NikonStartLiveView);
    if (code === INVALID_STATUS && await this.enterMode('pcMode', Op.NikonChangeCameraMode, 'start live view')) {
      ({ code } = await this.bridge.send(Op.NikonStartLiveView));
    }
    if (code !== OK && !BUSY.has(code)) { this.emit('log', `Live view: ${respName(code)}`); this.wantLiveView = false; return this.emitState(); }
    await this.waitReady();
    // Prefer the largest live view frames (1024px on the Z50II); older bodies may not support it.
    await this.bridge.send(Op.SetDevicePropValue, [NikonProp.LiveViewImageSize], { dir: 'write', data: encodeValue(2, 3) }).catch(() => {});
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
    if (res.code === 0xa00b) { this.liveView = false; return; } // camera dropped live view
    if (res.code !== OK || !res.data) return;
    const soi = res.data.indexOf(Buffer.from([0xff, 0xd8]));
    if (soi < 0) return;
    if (soi >= 32) this.lvInfo = parseLiveViewHeader(res.data);
    this.frame = res.data.subarray(soi);
    this.frameMeta = this.afBox();
    for (const viewer of this.viewers) writeFrame(viewer, this.frame, this.frameMeta);
  }

  // Focus box as fractions of the visible live view area, for drawing over the image.
  afBox() {
    const i = this.lvInfo;
    if (!i?.display.w || !i.af.w) return null;
    const left = i.display.x - i.display.w / 2, top = i.display.y - i.display.h / 2;
    const r = n => Math.round(n * 1e4) / 1e4;
    return {
      x: r((i.af.x - i.af.w / 2 - left) / i.display.w), y: r((i.af.y - i.af.h / 2 - top) / i.display.h),
      w: r(i.af.w / i.display.w), h: r(i.af.h / i.display.h),
    };
  }

  // Move the AF point to a spot given as fractions (0–1) of the live view, then optionally focus.
  async setFocusPoint(fx, fy, { focus = true } = {}) {
    const i = this.lvInfo;
    if (!this.liveView || !i) throw new Error('Tap-to-focus needs live view');
    const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, v)));
    const x = clamp(i.display.x - i.display.w / 2 + fx * i.display.w, 0, i.sensor.w - 1);
    const y = clamp(i.display.y - i.display.h / 2 + fy * i.display.h, 0, i.sensor.h - 1);
    const { code } = await this.bridge.send(Op.NikonChangeAfArea, [x, y]);
    if (code !== OK) throw new Error('Focus point: ' + respName(code));
    return { focus: focus ? await this.autofocus() : null };
  }

  async startMovie() {
    if (!this.connected) throw new Error('Camera not connected');
    if (this.recordingSince) return;
    if (!this.liveView) await this.startLiveView();
    let { code } = await this.bridge.send(Op.NikonStartMovieRecInCard);
    if (code === INVALID_STATUS) {
      const selector = await this.bridge.send(Op.GetDevicePropValue, [NikonProp.LiveViewSelector], { dir: 'read' });
      if (selector.code === OK && selector.data[0] === 0) throw new Error('Flip the camera\'s photo/video switch to video to record');
      if (await this.enterMode('appMode', Op.NikonChangeApplicationMode, 'record video')) ({ code } = await this.bridge.send(Op.NikonStartMovieRecInCard));
    }
    if (code === INVALID_STATUS) throw new Error('Camera refused to record (check the card has space and isn\'t locked)');
    if (code !== OK) throw new Error('Record: ' + respName(code));
    this.recordingSince = Date.now();
    this.emitState();
  }

  async stopMovie() {
    if (!this.recordingSince) return;
    const { code } = await this.bridge.send(Op.NikonEndMovieRec);
    this.recordingSince = null;
    this.emitState();
    if (code !== OK) throw new Error('Stop recording: ' + respName(code));
  }

  addViewer(res) {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store', Connection: 'close',
    });
    this.viewers.add(res);
    if (this.frame) writeFrame(res, this.frame, this.frameMeta);
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
    if (this.recordingSince) throw new Error('Stop recording before taking a photo');
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
    name: file, day, size, video: /\.(mov|mp4)$/i.test(file),
    url: `/captures/${day}/${encodeURIComponent(file)}`,
    thumb: `/captures/.thumbs/${day}_${encodeURIComponent(file)}.jpg`,
    preview: isJpeg ? `/captures/${day}/${encodeURIComponent(file)}` : `/captures/.thumbs/${day}_${encodeURIComponent(file)}.jpg`,
  };
}

function writeFrame(res, jpeg, meta) {
  const af = meta ? `X-AF: ${meta.x},${meta.y},${meta.w},${meta.h}\r\n` : '';
  res.write(`--frame\r\nContent-Type: image/jpeg\r\n${af}Content-Length: ${jpeg.length}\r\n\r\n`);
  res.write(jpeg);
  res.write('\r\n');
}

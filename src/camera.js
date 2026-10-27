// High-level camera control on top of the PTP bridge: connection lifecycle, live view,
// capture, settings and auto-download of new photos. Emits 'state', 'prop', 'photo', 'shot', 'log'.
// Brand-specific operations live in drivers/, picked from the camera's DeviceInfo.
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Bridge } from './bridge.js';
import { Op, OK, respName, parseDeviceInfo, parseObjectInfo } from './ptp.js';
import { PROPS, sleep } from './drivers/ptp.js';
import { pickDriver } from './drivers/index.js';

export { PROPS };

export class Camera extends EventEmitter {
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
    this.viewers = new Set();  // MJPEG responses
    this.capturing = false;
    this.recordingSince = null; // ms timestamp while a movie is recording
    this.frame = null;
    this.frameSeq = 0;         // counts frames, so pulling viewers can ask for the next new one
    this.lastPull = 0;         // when a viewer last pulled a single frame
    this.pullWaiters = [];     // pending pulls, released one per new frame
    this.smallFrames = false;  // 640px instead of 1024px live view, while someone pulls remotely
    this.driver = null;
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
        const streaming = this.wantLiveView && (this.viewers.size > 0 || Date.now() - this.lastPull < 3000);
        if (streaming && !this.liveView) await this.startLiveView();
        if (!streaming && this.liveView && !this.recordingSince) await this.stopLiveView();
        const remote = Date.now() - this.lastPull < 3000;
        if (this.liveView && remote !== this.smallFrames) await this.setFrameSize(remote);
        if (this.liveView && !this.capturing) await this.pumpFrame();
        if (Date.now() - lastEvents > 250) { lastEvents = Date.now(); await this.driver.pollEvents(); }
        if (Date.now() - lastModeCheck > 1000 && !this.capturing) { lastModeCheck = Date.now(); await this.driver.checkMode(); }
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

  async startLiveView() {
    try {
      await this.driver.startLiveView();
    } catch (e) {
      this.emit('log', `Live view: ${e.message}`); this.wantLiveView = false; return this.emitState();
    }
    await this.setFrameSize(Date.now() - this.lastPull < 3000);
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
    if (!f) return;
    this.frame = f.jpeg;
    this.frameMeta = f.af || null;
    this.frameSeq++;
    for (const viewer of this.viewers) writeFrame(viewer, this.frame, this.frameMeta);
    this.pullWaiters[0]?.();
  }

  // Smaller frames while someone watches over the internet, where frame size sets the frame rate.
  async setFrameSize(small) {
    this.smallFrames = small;
    await this.driver.setFrameSize(small);
  }

  // For viewers on slow links: the newest frame after `after`, waiting briefly for one.
  // Pulling one frame at a time means frames can never pile up in a buffer between here
  // and the viewer, which is what makes a pushed MJPEG stream fall seconds behind.
  async pullFrame(after, timeoutMs = 2000) {
    this.lastPull = Date.now();
    if (!this.frame || this.frameSeq <= after) {
      // One waiter per new frame, so a viewer with two requests in flight gets two different frames.
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); this.pullWaiters = this.pullWaiters.filter(w => w !== done); resolve(); };
        const timer = setTimeout(done, timeoutMs);
        this.pullWaiters.push(done);
      });
    }
    return this.frame && this.frameSeq > after ? { jpeg: this.frame, seq: this.frameSeq, af: this.frameMeta } : null;
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

  addViewer(res) {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store', Connection: 'close',
    });
    this.viewers.add(res);
    if (this.frame) writeFrame(res, this.frame, this.frameMeta);
    res.on('close', () => this.viewers.delete(res));
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

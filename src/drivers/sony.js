// Sony Alpha in "PC Remote" USB mode, through Sony's SDIO PTP extensions, following the
// protocol as documented by libgphoto2. EXPERIMENTAL: written without a Sony body to test on.
//
// Sony models the camera's buttons as properties: half-press, full-press and movie record are
// "pressed" (2) and "released" (1). Settings and status come from one call that returns every
// property, which is polled. Captures wait in the camera's memory under a fixed object handle,
// and live view frames are read from another fixed handle.
import { Op, OK, respName, encodeValue, Reader } from '../ptp.js';
import { PtpDriver, PROPS, MODE_CODE, MODE_DEPENDENT, sleep, findJpeg } from './ptp.js';

const SDIO = { Connect: 0x9201, GetExtDeviceInfo: 0x9202, SetExtDevicePropValue: 0x9205, ControlDevice: 0x9207, GetAllExtDevicePropInfo: 0x9209 };
const BTN = { HalfPress: 0xd2c1, FullPress: 0xd2c2, MovieRecord: 0xd2c8 };
const PRESS = 2, RELEASE = 1;
const OBJECTS_IN_MEMORY = 0xd215; // ≥ 0x8000 when a capture is waiting to be downloaded
const CAPTURE_HANDLE = 0xffffc001;
const LIVEVIEW_HANDLE = 0xffffc002;
// Codes the canonical tables don't name are kept apart from real ones by adding 0x10000.
const lookup = table => v => table[v] ?? 0x10000 + v;
const keep = (...codes) => Object.fromEntries(codes.map(c => [c, c]));

// Canonical code → Sony property and decoder.
const MAP = {
  0x500e: { code: 0x500e, decode: lookup({ ...keep(1, 2, 3, 4), 0x8000: 0x8010, 0x8001: 0x8010 }) },
  0x5007: { code: 0x5007 },
  0xd100: { code: 0xd20d, decode: v => (v === 0 ? 0xffffffff : v) }, // num << 16 | den, as on Nikon
  0x500f: { code: 0xd21e, decode: v => ((v & 0xffffff) === 0xffffff ? 0xffff : v & 0xffffff) },
  0x5010: { code: 0x5010, decode: v => (v << 16) >> 16 },
  0x5005: { code: 0x5005, decode: lookup({ ...keep(2, 4, 6, 7, 0x8010, 0x8011, 0x8012), 0x8001: 5, 0x8002: 5, 0x8003: 5, 0x8004: 5, 0x8023: 0x8013 }) },
  0x500a: { code: 0x500a, decode: lookup({ 1: 1, 2: 0x8010, 0x8004: 0x8011, 0x8005: 0x8012 }) },
};
const BY_SONY = Object.fromEntries(Object.entries(MAP).map(([c, m]) => [m.code, +c]));

export class SonyDriver extends PtpDriver {
  brand = 'Sony';
  features = { liveView: true, focusPoint: false, movie: true, autofocus: true };
  propMap = MAP;

  async init() {
    this.raw = {};
    // The handshake: connect in three phases, reading the extension info in between.
    await this.send(SDIO.Connect, [1, 0, 0], { dir: 'read' });
    await this.send(SDIO.Connect, [2, 0, 0], { dir: 'read' });
    await this.send(SDIO.GetExtDeviceInfo, [0xc8], { dir: 'read' });
    await this.send(SDIO.Connect, [3, 0, 0], { dir: 'read' });
  }

  async drainEvents() {}
  async loadProps() { await this.readAll(false); }
  async refreshProp(code, emit = true) { await this.readAll(emit, code); }
  async checkMode() {} // the mode is part of the polled properties

  async pollEvents() {
    if (Date.now() - (this.lastPoll || 0) < 500) return;
    this.lastPoll = Date.now();
    await this.readAll(true);
    // Each download takes one capture out of memory; the count is re-read after each.
    for (let i = 0; i < 10 && (this.raw[OBJECTS_IN_MEMORY]?.current ?? 0) >= 0x8000; i++) {
      await this.cam.downloadPhoto(CAPTURE_HANDLE);
      await this.readAll(true);
    }
  }

  // Reads every property; publishes the ones that changed (or `only`, when asked for one).
  async readAll(emit, only) {
    const res = await this.send(SDIO.GetAllExtDevicePropInfo, [], { dir: 'read' });
    if (res.code !== OK || !res.data) return;
    const r = new Reader(res.data);
    const count = r.u64();
    for (let i = 0; i < count && r.o < res.data.length; i++) {
      let d;
      try { d = readSonyPropDesc(r); } catch { break; } // a layout we don't know: keep what we have
      const before = this.raw[d.code];
      this.raw[d.code] = d;
      const code = BY_SONY[d.code];
      if (code && (!before || before.current !== d.current || before.writable !== d.writable || code === only)) this.publish(code, emit);
    }
  }

  publish(code, emit) {
    const { code: prop, decode = v => v } = MAP[code];
    const d = this.raw[prop];
    const back = new Map();
    const values = d.values?.map(v => { const c = decode(v); if (!back.has(c)) back.set(c, v); return c; });
    back.set(decode(d.current), d.current);
    this.native[code] = { code: prop, type: d.type, back };
    this.cam.updateProp(code, { type: d.type, writable: d.writable, value: decode(d.current), values, range: d.range }, emit);
  }

  async setProp(code, value) {
    const n = this.native[code];
    const raw = n?.back.has(value) ? n.back.get(value) : value;
    const { code: rc } = await this.send(SDIO.SetExtDevicePropValue, [n.code], { dir: 'write', data: encodeValue(n.type, raw) });
    if (rc !== OK) throw new Error(respName(rc));
    await sleep(200);
    await this.readAll(true, code);
    // Some bodies only take these from their own dials when the dial isn't set to the app.
    if (this.cam.props[code]?.value !== value) throw new Error(`The camera didn't take that ${PROPS[code]}. Check its dial or settings`);
    if (code === MODE_CODE) for (const c of MODE_DEPENDENT) if (MAP[c]) this.publish(c, true);
  }

  button(prop, state) {
    const data = Buffer.alloc(2);
    data.writeUInt16LE(state);
    return this.send(SDIO.ControlDevice, [prop], { dir: 'write', data });
  }

  async capture() {
    await this.button(BTN.HalfPress, PRESS);
    await sleep(200);
    const { code } = await this.button(BTN.FullPress, PRESS);
    await sleep(100);
    await this.button(BTN.FullPress, RELEASE);
    await this.button(BTN.HalfPress, RELEASE);
    return code;
  }

  async autofocus() {
    const { code } = await this.button(BTN.HalfPress, PRESS);
    await sleep(700);
    await this.button(BTN.HalfPress, RELEASE);
    return code === OK ? 'OK' : respName(code);
  }

  async startLiveView() {
    const f = await this.getFrame();
    if (!f) throw new Error('No live view from the camera. Set it to PC Remote and check its screen is on');
  }

  async getFrame() {
    const res = await this.send(Op.GetObject, [LIVEVIEW_HANDLE], { dir: 'read' });
    if (res.code !== OK || !res.data) return null;
    const f = findJpeg(res.data);
    return f && { jpeg: f.jpeg };
  }

  // Movie record is one button: each press starts or stops.
  async toggleMovie() {
    const { code } = await this.button(BTN.MovieRecord, PRESS);
    await sleep(100);
    await this.button(BTN.MovieRecord, RELEASE);
    if (code !== OK) throw new Error('Record: ' + respName(code));
  }
  startMovie() { return this.toggleMovie(); }
  stopMovie() { return this.toggleMovie(); }
}

// Sony's property description: like PTP's, plus an "enabled" flag after the writable flag.
function readSonyPropDesc(r) {
  const code = r.u16(), type = r.u16(), getSet = r.u8(), enabled = r.u8();
  r.value(type); // factory default
  const current = r.value(type);
  const form = r.u8();
  const d = { code, type, writable: getSet === 1 && enabled === 1, current };
  if (form === 1) d.range = { min: r.value(type), max: r.value(type), step: r.value(type) };
  else if (form === 2) { const n = r.u16(); d.values = []; for (let i = 0; i < n; i++) d.values.push(r.value(type)); }
  return d;
}

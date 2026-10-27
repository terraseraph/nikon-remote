// Standard PTP (ISO 15740) driver: what any PTP camera can do without vendor extensions —
// read and change the standard exposure properties, fire the shutter, and download new photos.
// Brand drivers extend it. Every driver reports settings under the same "canonical" property
// codes and value units (Nikon's, which match standard PTP for most properties), so the UI,
// voice commands and shot assist work the same whatever the camera.
import { Op, OK, respName, encodeValue, parsePropDesc } from '../ptp.js';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Canonical property codes, as used by the UI. Whether each is writable depends on the mode dial.
export const PROPS = {
  0x500e: 'mode', 0x5007: 'aperture', 0xd100: 'shutter', 0x500f: 'iso', 0x5010: 'ev',
  0x5005: 'wb', 0x500b: 'metering', 0x500a: 'focus', 0x5004: 'quality', 0x5003: 'size', 0x5001: 'battery',
};
export const MODE_CODE = 0x500e;
// Exposure mode changes which of these are writable.
export const MODE_DEPENDENT = [0x5007, 0xd100, 0x5010];

// Canonical shutter speeds are Nikon's: numerator << 16 | denominator, 0xffffffff for Bulb.
export const BULB = 0xffffffff;
const SHUTTER_DENS = [8000, 6400, 5000, 4000, 3200, 2500, 2000, 1600, 1250, 1000, 800, 640, 500, 400, 320, 250, 200, 160, 125, 100, 80, 60, 50, 40, 30, 25, 20, 15, 13, 10, 8, 6, 5, 4, 3];
const SHUTTER_SECS = [0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.3, 1.6, 2, 2.5, 3.2, 4, 5, 6, 8, 10, 13, 15, 20, 25, 30, 60];
export const nearest = (list, v) => list.reduce((a, b) => (Math.abs(Math.log(b / v)) < Math.abs(Math.log(a / v)) ? b : a));
export function shutterFromSeconds(s) {
  if (!(s > 0)) return BULB;
  if (s >= 0.28) return (Math.round(nearest(SHUTTER_SECS, s) * 10) << 16 | 10) >>> 0;
  return (1 << 16 | nearest(SHUTTER_DENS, 1 / s)) >>> 0;
}

export class PtpDriver {
  brand = 'Camera';
  experimental = true;
  features = { liveView: false, focusPoint: false, movie: false, autofocus: false };
  // Skip properties DeviceInfo doesn't list. Nikon leaves its vendor properties out of that list.
  onlyListedProps = true;

  constructor(cam) {
    this.cam = cam;
    this.bridge = cam.bridge;
    this.native = {}; // canonical code → Map(canonical value → native value), for writing back
  }

  get info() { return this.cam.info; }
  send(...args) { return this.bridge.send(...args); }

  // Canonical code → { code: native code, decode(native) → canonical }. Identity unless listed.
  // Standard PTP keeps shutter speed in ExposureTime (0x500d), in units of 0.1 ms.
  propMap = { 0xd100: { code: 0x500d, decode: v => (v === BULB ? BULB : shutterFromSeconds(v / 10000)) } };

  async init() {}
  reset() {}

  // ---------- properties ----------
  async loadProps() { for (const code of Object.keys(PROPS)) await this.refreshProp(+code, false); }

  async refreshProp(code, emit = true) {
    const map = this.propMap[code] || {};
    const native = map.code ?? code;
    if (this.onlyListedProps && this.info && !this.info.properties.includes(native)) return;
    const res = await this.send(Op.GetDevicePropDesc, [native], { dir: 'read' });
    if (res.code !== OK) return;
    const d = parsePropDesc(res.data);
    const decode = map.decode || (v => v);
    const back = new Map();
    const values = d.values?.map(v => { const c = decode(v); if (!back.has(c)) back.set(c, v); return c; });
    back.set(decode(d.current), d.current);
    this.native[code] = { code: native, type: d.type, back };
    this.cam.updateProp(code, { type: d.type, writable: d.writable, value: decode(d.current), values, range: d.range }, emit);
    if (emit && code === MODE_CODE) for (const c of MODE_DEPENDENT) await this.refreshProp(c);
  }

  async setProp(code, value) {
    const n = this.native[code];
    const raw = n?.back.has(value) ? n.back.get(value) : value;
    const { code: rc } = await this.send(Op.SetDevicePropValue, [n?.code ?? code], { dir: 'write', data: encodeValue(n?.type ?? this.cam.props[code].type, raw) });
    await this.refreshProp(code);
    if (rc !== OK) throw new Error(respName(rc));
  }

  // Some bodies don't announce mode dial changes, so the core re-checks the mode every second.
  async checkMode() {
    const p = this.cam.props[MODE_CODE];
    if (!p) return;
    const map = this.propMap[MODE_CODE] || {};
    const res = await this.send(Op.GetDevicePropDesc, [map.code ?? MODE_CODE], { dir: 'read' });
    if (res.code !== OK) return;
    if ((map.decode || (v => v))(parsePropDesc(res.data).current) !== p.value) await this.refreshProp(MODE_CODE);
  }

  // ---------- events ----------
  // Without a vendor event channel, new photos are found by comparing the camera's object list.
  async drainEvents() { this.handles = await this.objectHandles(); }

  async pollEvents() {
    if (Date.now() - (this.lastScan || 0) < 2000) return;
    this.lastScan = Date.now();
    const now = await this.objectHandles();
    if (!now) return;
    const seen = new Set(this.handles || []);
    this.handles = now;
    for (const h of now) if (!seen.has(h)) await this.cam.downloadPhoto(h);
  }

  async objectHandles() {
    const res = await this.send(Op.GetObjectHandles, [0xffffffff, 0, 0], { dir: 'read' });
    if (res.code !== OK || !res.data) return null;
    const n = res.data.readUInt32LE(0), out = [];
    for (let i = 0; i < n; i++) out.push(res.data.readUInt32LE(4 + i * 4));
    return out;
  }

  // ---------- capture ----------
  async waitReady(timeoutMs = 1000) { await sleep(Math.min(timeoutMs, 500)); return OK; }

  async capture() {
    const { code } = await this.send(Op.InitiateCapture, [0, 0]);
    if (code === OK) await this.waitReady(8000);
    return code;
  }

  async autofocus() { return 'Autofocus from the app isn\'t supported on this camera yet'; }

  // ---------- live view and video: brand drivers only ----------
  unsupported(what) { return new Error(`${what} isn't supported on ${this.brand === 'Camera' ? 'this camera' : `${this.brand} cameras`} yet`); }
  async startLiveView() { throw this.unsupported('Live view'); }
  async stopLiveView() {}
  async getFrame() { return null; }
  async setFrameSize() {}
  async setFocusPoint() { throw this.unsupported('Tap-to-focus'); }
  async startMovie() { throw this.unsupported('Video recording'); }
  async stopMovie() {}
}

// Finds the JPEG in a live view buffer that wraps it in a vendor header.
export function findJpeg(buf) {
  const soi = buf.indexOf(Buffer.from([0xff, 0xd8]));
  if (soi < 0) return null;
  const eoi = buf.lastIndexOf(Buffer.from([0xff, 0xd9]));
  return { soi, jpeg: buf.subarray(soi, eoi > soi ? eoi + 2 : buf.length) };
}

// Canon EOS (DSLR and R-series mirrorless) through Canon's EOS PTP extensions, following the
// protocol as documented by libgphoto2. EXPERIMENTAL: written without a Canon body to test on.
//
// Unlike Nikon, an EOS body doesn't answer GetDevicePropDesc for its settings: after
// SetEventMode it reports every setting, and the values each may take, as records from
// GetEvent. Values are Canon step codes (8 per stop), converted here to the canonical units.
import { Op, OK, respName } from '../ptp.js';
import { PtpDriver, BULB, nearest, shutterFromSeconds, findJpeg, sleep } from './ptp.js';

const EOS = {
  SetDevicePropValueEx: 0x9110, RemoteRelease: 0x910f, SetRemoteMode: 0x9114, SetEventMode: 0x9115, GetEvent: 0x9116,
  RemoteReleaseOn: 0x9128, RemoteReleaseOff: 0x9129, GetViewFinderData: 0x9153, DoAf: 0x9154, AfCancel: 0x9155,
};
const EV = { PropValueChanged: 0xc189, AvailListChanged: 0xc18a, ObjectAddedEx: 0xc181, ObjectAddedEx64: 0xc1a7 };
const P = { CaptureDestination: 0xd11c, EVFOutputDevice: 0xd1b0, EVFRecordStatus: 0xd1b8 };
const CAPTURE_TO_CARD = 2;
const NOT_READY = 0xa102;

// Canon codes count 8 per stop, with 3 and 5 marking thirds and 4 a half stop.
const stops = (code, zero) => {
  const n = code - zero, whole = Math.floor(n / 8), frac = ((n % 8) + 8) % 8;
  return whole + ({ 3: 1 / 3, 4: 1 / 2, 5: 2 / 3 }[frac] ?? frac / 8);
};
const F_NUMBERS = [1, 1.1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6, 6.3, 6.7, 7.1, 8, 9, 9.5, 10, 11, 13, 14, 16, 18, 19, 20, 22, 25, 27, 29, 32, 36, 40, 45, 51, 57, 64];
const ISOS = [50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000, 10000, 12800, 16000, 20000, 25600, 32000, 40000, 51200, 102400, 204800];
// Codes the canonical tables don't name are kept apart from real ones by adding 0x10000.
const lookup = table => v => table[v] ?? 0x10000 + v;

// Canonical code → Canon property and decoder.
const MAP = {
  0x500e: { code: 0xd105, decode: lookup({ 0: 2, 1: 4, 2: 3, 3: 1, 4: 1, 9: 0x8010, 0x16: 0x8010 }) }, // P Tv Av M Bulb, Auto
  0x5007: { code: 0xd101, decode: v => Math.round(nearest(F_NUMBERS, Math.SQRT2 ** stops(v, 0x08)) * 100) },
  0xd100: { code: 0xd102, decode: v => (v === 0x0c ? BULB : shutterFromSeconds(30 / 2 ** stops(v, 0x10))) },
  0x500f: { code: 0xd103, decode: v => (v === 0 ? 0xffff : nearest(ISOS, 100 * 2 ** stops(v, 0x48))) },
  0x5010: { code: 0xd104, decode: v => { const s = (v << 24) >> 24; return Math.sign(s) * Math.round(stops(Math.abs(s), 0) * 1000); } },
  0x5005: { code: 0xd109, decode: lookup({ 0: 2, 1: 4, 2: 0x8010, 3: 6, 4: 5, 5: 7, 6: 0x8013, 8: 0x8011, 9: 0x8012 }) },
  0x500b: { code: 0xd107, decode: lookup({ 1: 4, 3: 3, 5: 2 }) }, // spot, evaluative, centre-weighted
  0x500a: { code: 0xd108, decode: lookup({ 0: 0x8010, 1: 0x8012, 2: 0x8011, 3: 1 }) }, // One-shot, AI Focus, AI Servo, MF
};
const BY_CANON = Object.fromEntries(Object.entries(MAP).map(([c, m]) => [m.code, +c]));

export class CanonDriver extends PtpDriver {
  brand = 'Canon';
  features = { liveView: true, focusPoint: false, movie: true, autofocus: true };
  propMap = MAP;

  async init() {
    this.raw = {};   // Canon property → current value
    this.avail = {}; // Canon property → values it may take now
    await this.send(EOS.SetRemoteMode, [1]);
    await this.send(EOS.SetEventMode, [1]);
    await this.setCanon(P.CaptureDestination, CAPTURE_TO_CARD).catch(() => {});
  }

  async setCanon(prop, value) {
    const data = Buffer.alloc(12);
    data.writeUInt32LE(12, 0); data.writeUInt32LE(prop, 4); data.writeUInt32LE(value >>> 0, 8);
    const { code } = await this.send(EOS.SetDevicePropValueEx, [], { dir: 'write', data });
    if (code !== OK) throw new Error(respName(code));
  }

  // ---------- events and properties ----------
  // The first GetEvent after SetEventMode reports everything, so draining it loads the settings.
  async drainEvents() { for (let i = 0; i < 20 && await this.readEvents(false); i++); }
  async loadProps() { for (const code of Object.keys(MAP)) this.publish(+code, false); }

  async pollEvents() { await this.readEvents(true); }

  // Reads one batch of event records; returns how many there were.
  async readEvents(live) {
    const res = await this.send(EOS.GetEvent, [], { dir: 'read' });
    if (res.code !== OK || !res.data) return 0;
    const b = res.data, changed = new Set();
    let o = 0, n = 0;
    while (o + 8 <= b.length) {
      const size = b.readUInt32LE(o), type = b.readUInt32LE(o + 4);
      if (size < 8 || type === 0 || o + size > b.length) break;
      n++;
      if (type === EV.PropValueChanged && size >= 16) {
        const prop = b.readUInt32LE(o + 8);
        if (BY_CANON[prop]) { this.raw[prop] = b.readUInt32LE(o + 12); changed.add(BY_CANON[prop]); }
      } else if (type === EV.AvailListChanged && size >= 20) {
        const prop = b.readUInt32LE(o + 8), count = b.readUInt32LE(o + 16);
        if (BY_CANON[prop]) {
          const width = count ? Math.floor((size - 20) / count) : 4, list = [];
          for (let i = 0; i < count; i++) list.push(width === 2 ? b.readUInt16LE(o + 20 + i * 2) : b.readUInt32LE(o + 20 + i * width));
          this.avail[prop] = list;
          changed.add(BY_CANON[prop]);
        }
      } else if ((type === EV.ObjectAddedEx || type === EV.ObjectAddedEx64) && live) {
        await this.cam.downloadPhoto(b.readUInt32LE(o + 8));
      }
      o += size;
    }
    if (live) for (const code of changed) this.publish(code, true);
    return n;
  }

  publish(code, emit) {
    const { code: prop, decode } = MAP[code];
    if (!(prop in this.raw)) return;
    const back = new Map();
    const values = this.avail[prop]?.map(v => { const c = decode(v); if (!back.has(c)) back.set(c, v); return c; });
    back.set(decode(this.raw[prop]), this.raw[prop]);
    this.native[code] = { code: prop, back };
    this.cam.updateProp(code, { type: 6, writable: !!values?.length, value: decode(this.raw[prop]), values }, emit);
  }

  async refreshProp(code, emit = true) { if (MAP[code]) this.publish(code, emit); }
  async checkMode() {} // the mode dial arrives as an event

  async setProp(code, value) {
    const n = this.native[code];
    if (!n?.back.has(value)) throw new Error('Not a value this camera offers');
    await this.setCanon(n.code, n.back.get(value));
    await sleep(150);
    await this.readEvents(true);
  }

  // ---------- capture and focus ----------
  async capture() {
    if (!this.info.operations.includes(EOS.RemoteReleaseOn)) {
      const { code } = await this.send(EOS.RemoteRelease);
      return code;
    }
    // 3 = press the shutter all the way (focusing on the way down), then let go.
    const { code } = await this.send(EOS.RemoteReleaseOn, [3, 0]);
    await this.send(EOS.RemoteReleaseOff, [3]);
    return code;
  }

  async autofocus() {
    const { code } = await this.send(EOS.DoAf);
    await sleep(800);
    await this.send(EOS.AfCancel).catch(() => {});
    return code === OK ? 'OK' : respName(code);
  }

  // ---------- live view ----------
  async startLiveView() { await this.setCanon(P.EVFOutputDevice, 2); await sleep(300); } // 2 = PC
  async stopLiveView() { await this.setCanon(P.EVFOutputDevice, 0).catch(() => {}); }

  async getFrame() {
    const res = await this.send(EOS.GetViewFinderData, [0x00200000, 0, 0], { dir: 'read' });
    if (res.code === NOT_READY || res.code !== OK || !res.data) return null;
    const f = findJpeg(res.data);
    return f && { jpeg: f.jpeg };
  }

  // ---------- video (needs the camera in movie mode) ----------
  async startMovie() {
    try { await this.setCanon(P.EVFRecordStatus, 4); } catch (e) { throw new Error(`Camera refused to record (${e.message}). Switch it to movie mode first`); }
  }
  async stopMovie() { await this.setCanon(P.EVFRecordStatus, 0); }
}

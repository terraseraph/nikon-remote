// Drives each camera driver with a fake bridge that answers like the camera would, so the
// brands nobody here owns are at least checked against their documented protocol. Run: npm test
import assert from 'node:assert/strict';
const imp = p => import(new URL(`../${p}`, import.meta.url));
const { CanonDriver } = await imp('src/drivers/canon.js');
const { SonyDriver } = await imp('src/drivers/sony.js');
const { PtpDriver } = await imp('src/drivers/ptp.js');
const { NikonDriver } = await imp('src/drivers/nikon.js');
const { pickDriver } = await imp('src/drivers/index.js');
const { fmt } = await imp('public/format.js');

const OK = 0x2001;
function fakeCam(info, answer) {
  const calls = [];
  const cam = {
    info, props: {}, downloads: [], emitted: [],
    bridge: { send: async (op, params = [], opts = {}) => { calls.push({ op, params, data: opts.data }); return answer(op, params, opts) || { code: OK }; } },
    updateProp(code, desc, emit) { this.props[code] = desc; if (emit) this.emitted.push(code); },
    downloadPhoto(h) { this.downloads.push(h); },
    emit() {},
  };
  return { cam, calls };
}
const show = (props, code) => fmt({ 0x500e: 'mode', 0x5007: 'aperture', 0xd100: 'shutter', 0x500f: 'iso', 0x5010: 'ev', 0x5005: 'wb', 0x500a: 'focus' }[code], props[code].value);

// ---------- driver selection ----------
const pick = (manufacturer, operations) => pickDriver({ info: { manufacturer, operations, properties: [] } }).constructor.name;
assert.equal(pick('Nikon Corporation', [0x90c7]), 'NikonDriver');
assert.equal(pick('Canon Inc.', [0x9116]), 'CanonDriver');
assert.equal(pick('Sony Corporation', [0x9201]), 'SonyDriver');
assert.equal(pick('FUJIFILM', []), 'PtpDriver');
assert.equal(pickDriver({ info: { manufacturer: 'FUJIFILM', operations: [], properties: [] } }).brand, 'Fujifilm');
assert.equal(pick('Canon Inc.', []), 'PtpDriver'); // a PowerShot without EOS ops falls back
console.log('✓ driver selection');

// ---------- Canon ----------
function rec(type, ...u32s) { const b = Buffer.alloc(8 + u32s.length * 4); b.writeUInt32LE(b.length, 0); b.writeUInt32LE(type, 4); u32s.forEach((v, i) => b.writeUInt32LE(v >>> 0, 8 + i * 4)); return b; }
const end = Buffer.from([8, 0, 0, 0, 0, 0, 0, 0]);
let canonEvents = [Buffer.concat([
  rec(0xc189, 0xd101, 0x30), rec(0xc189, 0xd102, 0x68), rec(0xc189, 0xd103, 0x48), rec(0xc189, 0xd104, 0xf8),
  rec(0xc189, 0xd105, 3), rec(0xc189, 0xd109, 8), rec(0xc189, 0xd108, 2),
  rec(0xc18a, 0xd101, 3, 3, 0x28, 0x30, 0x38), rec(0xc18a, 0xd102, 3, 4, 0x0c, 0x10, 0x68, 0x98),
  rec(0xc18a, 0xd103, 3, 4, 0, 0x48, 0x53, 0x68), rec(0xc18a, 0xd104, 3, 3, 0xf8, 0x00, 0x05),
  end,
])];
const canon = fakeCam({ manufacturer: 'Canon Inc.', model: 'Canon EOS R6', operations: [0x9116, 0x9128], properties: [] }, (op) => {
  if (op === 0x9116) return { code: OK, data: canonEvents.shift() || end };
});
const cd = new CanonDriver(canon.cam);
await cd.init();
await cd.drainEvents();
await cd.loadProps();
const cp = canon.cam.props;
assert.equal(show(cp, 0x5007), 'f/5.6');
assert.deepEqual(cp[0x5007].values.map(v => fmt('aperture', v)), ['f/4', 'f/5.6', 'f/8']);
assert.equal(show(cp, 0xd100), '1/60');
assert.deepEqual(cp[0xd100].values.map(v => fmt('shutter', v)), ['Bulb', '30″', '1/60', '1/4000']);
assert.equal(show(cp, 0x500f), 'ISO 100');
assert.deepEqual(cp[0x500f].values.map(v => fmt('iso', v)), ['Auto', 'ISO 100', 'ISO 250', 'ISO 1600']);
assert.equal(show(cp, 0x5010), '−1.0 EV');
assert.deepEqual(cp[0x5010].values.map(v => fmt('ev', v)), ['−1.0 EV', '±0.0 EV', '+0.7 EV']);
assert.equal(show(cp, 0x500e), 'M');
assert.equal(show(cp, 0x5005), 'Shade');
assert.equal(show(cp, 0x500a), 'AF-C');
assert.equal(cp[0x5007].writable, true);
assert.equal(cp[0x500e].writable, false); // no avail list: the mode dial is physical
// writing f/8 sends Canon code 0x38 through SetDevicePropValueEx
canon.calls.length = 0;
canonEvents = [Buffer.concat([rec(0xc189, 0xd101, 0x38), end])];
await cd.setProp(800, 800).catch(() => {}); // wrong code arg guard
await cd.setProp(0x5007, 800);
const set = canon.calls.find(c => c.op === 0x9110);
assert.equal(set.data.readUInt32LE(4), 0xd101);
assert.equal(set.data.readUInt32LE(8), 0x38);
assert.equal(show(cp, 0x5007), 'f/8');
assert.deepEqual(canon.cam.emitted.includes(0x5007), true);
// a new photo on the card is downloaded
canonEvents = [Buffer.concat([rec(0xc181, 0x90000123, 0, 0), end])];
await cd.pollEvents();
assert.deepEqual(canon.cam.downloads, [0x90000123]);
// live view pulls the JPEG out of the viewfinder record
const lvData = Buffer.concat([Buffer.from([0x20, 0, 0, 0, 1, 0, 0, 0]), Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]), Buffer.from([9, 9])]);
canon.cam.bridge.send = async (op) => (op === 0x9153 ? { code: OK, data: lvData } : { code: OK });
assert.deepEqual([...(await cd.getFrame()).jpeg], [0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
console.log('✓ Canon: settings decode, write, download, live view');

// ---------- Sony ----------
function sonyDesc(code, type, writable, current, values) {
  const w = type === 4 ? 2 : 4, b = [];
  const v = n => { const x = Buffer.alloc(w); w === 2 ? x.writeUInt16LE(n) : x.writeUInt32LE(n >>> 0); b.push(x); };
  const h = Buffer.alloc(6); h.writeUInt16LE(code); h.writeUInt16LE(type, 2); h[4] = writable ? 1 : 0; h[5] = 1; b.push(h);
  v(current); v(current);
  if (values) { b.push(Buffer.from([2])); const n = Buffer.alloc(2); n.writeUInt16LE(values.length); b.push(n); values.forEach(v); } else b.push(Buffer.from([0]));
  return Buffer.concat(b);
}
let sonyState = { aperture: 560, objects: 0 };
const sonyAll = () => {
  const descs = [
    sonyDesc(0x5007, 4, true, sonyState.aperture, [400, 560, 800]),
    sonyDesc(0xd20d, 6, true, (1 << 16 | 125) >>> 0, [0, (1 << 16 | 125) >>> 0, (10 << 16 | 10) >>> 0]),
    sonyDesc(0xd21e, 6, true, 0xffffff, [0xffffff, 100, 3200]),
    sonyDesc(0x500e, 4, false, 3),
    sonyDesc(0xd215, 4, false, sonyState.objects),
  ];
  const n = Buffer.alloc(8); n.writeBigUInt64LE(BigInt(descs.length));
  return Buffer.concat([n, ...descs]);
};
const sony = fakeCam({ manufacturer: 'Sony Corporation', model: 'ILCE-7M4', operations: [0x9201], properties: [] }, (op, params, opts) => {
  if (op === 0x9209) return { code: OK, data: sonyAll() };
  if (op === 0x9205) { sonyState.aperture = opts.data.readUInt16LE(0); return { code: OK }; }
});
sony.cam.downloadPhoto = function (h) { this.downloads.push(h); sonyState.objects = 0; };
const sd = new SonyDriver(sony.cam);
await sd.init();
await sd.loadProps();
const sp = sony.cam.props;
assert.equal(show(sp, 0x5007), 'f/5.6');
assert.equal(show(sp, 0xd100), '1/125');
assert.deepEqual(sp[0xd100].values.map(v => fmt('shutter', v)), ['Bulb', '1/125', '1″']);
assert.equal(show(sp, 0x500f), 'Auto');
assert.deepEqual(sp[0x500f].values.map(v => fmt('iso', v)), ['Auto', 'ISO 100', 'ISO 3200']);
assert.equal(show(sp, 0x500e), 'A');
await sd.setProp(0x5007, 800);
assert.equal(show(sp, 0x5007), 'f/8');
sonyState.objects = 0x8001;
sd.lastPoll = 0;
await sd.pollEvents();
assert.deepEqual(sony.cam.downloads, [0xffffc001]);
// the shutter is a half-press, full-press, release sequence
sony.calls.length = 0;
await sd.capture();
assert.deepEqual(sony.calls.map(c => [c.params[0], c.data.readUInt16LE(0)]), [[0xd2c1, 2], [0xd2c2, 2], [0xd2c2, 1], [0xd2c1, 1]]);
console.log('✓ Sony: settings decode, write, capture sequence, download');

// ---------- Generic PTP ----------
function ptpDesc(code, type, current, values) {
  const w = type === 4 ? 2 : 4, b = [];
  const v = n => { const x = Buffer.alloc(w); w === 2 ? x.writeUInt16LE(n) : x.writeUInt32LE(n); b.push(x); };
  const h = Buffer.alloc(5); h.writeUInt16LE(code); h.writeUInt16LE(type, 2); h[4] = 1; b.push(h);
  v(current); v(current); b.push(Buffer.from([2])); const n = Buffer.alloc(2); n.writeUInt16LE(values.length); b.push(n); values.forEach(v);
  return Buffer.concat(b);
}
let handles = [1, 2];
const gen = fakeCam({ manufacturer: 'FUJIFILM', model: 'X-T5', operations: [], properties: [0x500d, 0x5007] }, (op, params) => {
  if (op === 0x1014 && params[0] === 0x500d) return { code: OK, data: ptpDesc(0x500d, 6, 40, [40, 10000, 300000]) };
  if (op === 0x1014 && params[0] === 0x5007) return { code: OK, data: ptpDesc(0x5007, 4, 280, [280, 400]) };
  if (op === 0x1014) return { code: 0x200a };
  if (op === 0x1007) { const b = Buffer.alloc(4 + handles.length * 4); b.writeUInt32LE(handles.length); handles.forEach((h, i) => b.writeUInt32LE(h, 4 + i * 4)); return { code: OK, data: b }; }
});
const gd = new PtpDriver(gen.cam);
await gd.drainEvents();
await gd.loadProps();
assert.equal(show(gen.cam.props, 0xd100), '1/250');
assert.deepEqual(gen.cam.props[0xd100].values.map(v => fmt('shutter', v)), ['1/250', '1″', '30″']);
assert.equal(gen.cam.props[0x500f], undefined); // not listed in DeviceInfo: never asked for
gen.calls.length = 0;
await gd.setProp(0xd100, (10 << 16 | 10) >>> 0);
const w = gen.calls.find(c => c.op === 0x1016);
assert.equal(w.params[0], 0x500d);
assert.equal(w.data.readUInt32LE(0), 10000);
handles = [1, 2, 3];
await gd.pollEvents();
assert.deepEqual(gen.cam.downloads, [3]);
await assert.rejects(gd.startLiveView(), /Live view isn't supported on Fujifilm cameras yet|Live view isn't supported on this camera yet/);
console.log('✓ Generic PTP: shutter conversion, write-back, new-photo scan, clear unsupported errors');

// ---------- Nikon: same calls as before the refactor ----------
const nik = fakeCam({ manufacturer: 'Nikon Corporation', model: 'Z50_2', operations: [0x90c7, 0x90c2], properties: [] }, (op, params) => {
  if (op === 0x1014) return { code: OK, data: ptpDesc(params[0], 4, 5, [5, 6]) };
  if (op === 0x9201) return { code: 0xa004 };
});
const nd = new NikonDriver(nik.cam);
await nd.loadProps();
assert.equal(Object.keys(nik.cam.props).length, 11); // asks for every property, listed or not
nik.calls.length = 0;
await nd.startLiveView().catch(e => assert.equal(e.message, 'Invalid status'));
assert.deepEqual(nik.calls.map(c => c.op.toString(16)), ['9201', '90c2', '90c8', '9201']);
console.log('✓ Nikon: properties and live view retry unchanged');
console.log('\nall driver tests passed');

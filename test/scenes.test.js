// Scene presets against fake property lists: Nikon's values as the camera reports them, and Canon's
// decoded by the real driver from EOS event records, so both encodings meet the same rules. Run: npm test
import assert from 'node:assert/strict';
const imp = p => import(new URL(`../${p}`, import.meta.url));
const { presetAdvice, presetPlan, SCENES, CONDITIONS } = await imp('public/scenes.js');
const { CanonDriver } = await imp('src/drivers/canon.js');
const { PROPS } = await imp('src/drivers/ptp.js');
const { fmt } = await imp('public/format.js');

const named = list => Object.fromEntries(Object.entries(list).map(([code, p]) => [code, { name: PROPS[code], ...p }]));
const sh = den => (1 << 16 | den) >>> 0;

// ---------- Nikon: canonical values straight from the camera ----------
const nikon = named({
  0x500e: { value: 3, writable: true, values: [] }, // A
  0x5007: { value: 560, writable: true, values: [180, 200, 280, 400, 560, 800, 1100, 1600] },
  0xd100: { value: sh(125), writable: false, values: [0xffffffff, (10 << 16 | 10) >>> 0, ...[8, 15, 30, 60, 125, 250, 500, 1000, 2000, 4000].map(sh)] },
  0x500f: { value: 400, writable: true, values: [100, 200, 400, 800, 1600, 3200, 6400] },
  0x5010: { value: 0, writable: true, values: [-1000, -667, -333, 0, 333, 667, 1000] },
  0x5005: { value: 2, writable: true, values: [2, 4, 6, 0x8010, 0x8011] },
  0x500b: { value: 3, writable: true, values: [3, 2, 4] },
  0x500a: { value: 0x8010, writable: true, values: [0x8010, 0x8011, 1] },
});

// ---------- Canon: EOS step codes through the driver ----------
function rec(type, ...u32s) { const b = Buffer.alloc(8 + u32s.length * 4); b.writeUInt32LE(b.length, 0); b.writeUInt32LE(type, 4); u32s.forEach((v, i) => b.writeUInt32LE(v >>> 0, 8 + i * 4)); return b; }
const end = Buffer.from([8, 0, 0, 0, 0, 0, 0, 0]);
const list = (prop, ...codes) => rec(0xc18a, prop, 3, codes.length, ...codes);
let events = [Buffer.concat([
  rec(0xc189, 0xd105, 2), rec(0xc189, 0xd101, 0x30), rec(0xc189, 0xd102, 0x68), rec(0xc189, 0xd103, 0x48),
  rec(0xc189, 0xd104, 0), rec(0xc189, 0xd109, 0), rec(0xc189, 0xd107, 3), rec(0xc189, 0xd108, 0),
  list(0xd101, 0x20, 0x28, 0x30, 0x38, 0x40, 0x48),            // f/2.8 … f/16: no faster lens
  list(0xd102, 0x0c, 0x10, 0x68, 0x78, 0x80, 0x88, 0x90, 0x98), // Bulb, 30″, 1/60 … 1/4000
  list(0xd103, 0, 0x48, 0x50, 0x58, 0x60, 0x68, 0x70),          // Auto, 100 … 3200
  list(0xd104, 0xf8, 0xfb, 0xfd, 0, 3, 5, 8),                   // −1 … +1 in thirds
  list(0xd109, 0, 1, 8), list(0xd107, 3, 5, 1), list(0xd108, 0, 2),
  end,
])];
const cam = {
  info: { manufacturer: 'Canon Inc.', operations: [0x9116], properties: [] }, props: {},
  bridge: { send: async op => (op === 0x9116 ? { code: 0x2001, data: events.shift() || end } : { code: 0x2001 }) },
  updateProp(code, desc) { this.props[code] = desc; }, downloadPhoto() {}, emit() {},
};
const cd = new CanonDriver(cam);
await cd.init(); await cd.drainEvents(); await cd.loadProps();
const canon = named(cam.props);
assert.equal(fmt('aperture', canon[0x5007].value), 'f/5.6');

const get = (a, name) => a.settings.find(s => s.name === name);
const shows = (a, name) => get(a, name)?.display;

// ---------- the advice object ----------
for (const [id] of SCENES) for (const props of [nikon, canon]) for (const mods of [[], CONDITIONS]) {
  const a = presetAdvice(props, id, mods);
  assert.deepEqual(Object.keys(a).sort(), ['intent', 'mode', 'model', 'scene', 'settings', 'source', 'tips'].sort());
  assert.equal(a.source, 'preset'); assert.equal(a.model, null);
  assert.ok(['A', 'S', 'M', 'P'].includes(a.mode), id);
  assert.ok(a.intent && a.intent.split(' ').length <= 12, `${id} intent: ${a.intent}`);
  assert.ok(a.tips.length >= 2 && a.tips.length <= 4, id);
  for (const s of a.settings) {
    assert.ok(s.reason.length > 20 && /[.]$/.test(s.reason), `${id} ${s.name} needs a reason`);
    assert.ok(props[s.code].values.includes(s.value), `${id} ${s.name} must be a value the camera offers`);
    assert.equal(s.display, fmt(s.name, s.value));
    assert.equal(s.same, s.value === props[s.code].value);
    assert.equal(typeof s.writable, 'boolean');
  }
  assert.ok(!a.settings.some(s => s.name === 'mode'), 'mode is only recommended');
}
assert.equal(presetAdvice(nikon, 'nope'), null);
console.log('✓ advice shape, reasons and camera values for every scene');

// ---------- scene rules ----------
assert.equal(shows(presetAdvice(nikon, 'portrait'), 'aperture'), 'f/2');
const canonPortrait = get(presetAdvice(canon, 'portrait'), 'aperture');
assert.equal(canonPortrait.display, 'f/2.8'); // the widest the lens has
assert.match(canonPortrait.reason, /closest the lens offers to f\/2/);
assert.equal(shows(presetAdvice(nikon, 'landscape'), 'aperture'), 'f/8');
assert.equal(shows(presetAdvice(canon, 'landscape'), 'aperture'), 'f/8');
assert.equal(shows(presetAdvice(nikon, 'product'), 'aperture'), 'f/11');
assert.equal(shows(presetAdvice(nikon, 'landscape'), 'wb'), 'Daylight');

for (const props of [nikon, canon]) {
  const a = presetAdvice(props, 'action');
  assert.equal(a.mode, 'S');
  assert.equal(shows(a, 'shutter'), '1/1000');
  assert.equal(shows(a, 'focus'), 'AF-C');
  assert.equal(get(a, 'aperture'), undefined, 'shutter priority leaves the aperture to the camera');
}
assert.equal(shows(presetAdvice(canon, 'action'), 'iso'), 'Auto');     // Canon lists Auto ISO
assert.equal(shows(presetAdvice(nikon, 'action'), 'iso'), 'ISO 800');  // Nikon keeps it in a menu
assert.equal(get(presetAdvice(nikon, 'portrait'), 'shutter'), undefined, 'aperture priority leaves the shutter to the camera');
console.log('✓ portrait wide, landscape narrow, action fast');

// ---------- conditions ----------
assert.equal(shows(presetAdvice(nikon, 'event'), 'iso'), 'ISO 1600');
assert.equal(shows(presetAdvice(nikon, 'event', ['Tripod']), 'iso'), 'ISO 100');
assert.equal(shows(presetAdvice(canon, 'boudoir'), 'iso'), 'Auto');
assert.equal(shows(presetAdvice(canon, 'boudoir', ['Tripod']), 'iso'), 'ISO 100');
assert.equal(shows(presetAdvice(nikon, 'action', ['Tripod']), 'iso'), 'ISO 800', 'a tripod doesn\'t freeze the subject');
// Night assumes a tripod; handheld opens up and lifts ISO.
assert.equal(shows(presetAdvice(nikon, 'night'), 'iso'), 'ISO 100');
const handNight = presetAdvice(nikon, 'night', ['Handheld']);
assert.equal(shows(handNight, 'iso'), 'ISO 3200');
assert.equal(shows(handNight, 'aperture'), 'f/2.8');
assert.equal(shows(presetAdvice(nikon, 'portrait', ['Moody']), 'ev'), '−0.7 EV');
assert.equal(shows(presetAdvice(canon, 'portrait', ['Bright and airy']), 'ev'), '+0.7 EV');
assert.equal(shows(presetAdvice(nikon, 'portrait', ['Moody', 'Bright and airy']), 'ev'), '±0.0 EV');
const freeze = presetAdvice(nikon, 'street', ['Freeze motion']);
assert.equal(freeze.mode, 'S'); assert.equal(shows(freeze, 'shutter'), '1/1000');
assert.equal(shows(presetAdvice(nikon, 'street', ['Motion blur']), 'shutter'), '1/30');
assert.equal(shows(presetAdvice(nikon, 'street', ['Motion blur', 'Tripod']), 'shutter'), '1/15');
assert.equal(shows(presetAdvice(nikon, 'street', ['Motion blur']), 'iso'), 'ISO 100');
assert.equal(shows(presetAdvice(nikon, 'product', ['Handheld', 'No flash']), 'iso'), 'ISO 800');
assert.ok(presetPlan('boudoir', ['No flash']).tips.some(t => /window/.test(t)));
console.log('✓ tripod, handheld, moody / airy, freeze and blur');

// ---------- what the camera lacks ----------
const sparse = named({
  0x5007: { value: 400, writable: true, values: [400, 560, 800] },
  0xd100: { value: sh(60), writable: true, values: [] },  // reported, but no list to choose from
  0x5005: { value: 2, writable: true, values: [2, 0x8010] }, // no Daylight
});
const s = presetAdvice(sparse, 'landscape');
assert.deepEqual(s.settings.map(x => x.name), ['aperture']); // WB Auto is already set, Daylight isn't offered
assert.deepEqual(presetAdvice(sparse, 'action').settings.map(x => x.name), ['wb']); // no shutter list to pick 1/1000 from
assert.deepEqual(presetAdvice({}, 'portrait').settings, []);
assert.equal(get(presetAdvice(sparse, 'portrait'), 'wb').same, true);
console.log('✓ missing settings are skipped');

// Webcam support: turning a track's capabilities into camera properties and back into constraints,
// and the server side of the host protocol (commands, frames, photos, video, the host going away),
// driven by a fake host page. Run: npm test
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import jpeg from 'jpeg-js';
const imp = p => import(new URL(`../${p}`, import.meta.url));
const { capsToProps, toConstraints, stepped, CODES, shutterValue, shutterSeconds } = await imp('public/webcam-props.js');
const { fmt } = await imp('public/format.js');
const { presetAdvice } = await imp('public/scenes.js');
const { Webcam, thumbnail } = await imp('src/webcam.js');
const { PROPS } = await imp('src/drivers/ptp.js');

// ---------- stepping ranges ----------
assert.deepEqual(stepped({ min: 0, max: 10, step: 2 }), [0, 2, 4, 6, 8, 10]);
const wide = stepped({ min: -64, max: 64, step: 1 }, 7);
assert.ok(wide.length <= 22 && wide[0] === -64 && wide.at(-1) === 64 && wide.includes(7), String(wide));
assert.ok(wide.every((v, i) => !i || v > wide[i - 1]), 'sorted, no repeats');
assert.deepEqual(stepped({ min: 0, max: 1, step: 0 }, null, 3), [0, 0.5, 1]);
console.log('✓ stepping');

// ---------- a typical laptop webcam, as Chrome on Windows reports it ----------
const caps = {
  width: { min: 1, max: 1920 }, height: { min: 1, max: 1080 },
  exposureMode: ['continuous', 'manual'], exposureTime: { min: 1.220703125, max: 1250, step: 1.220703125 },
  exposureCompensation: { min: -2, max: 2, step: 0.1 },
  whiteBalanceMode: ['continuous', 'manual'], colorTemperature: { min: 2800, max: 6500, step: 10 },
  focusMode: ['continuous', 'manual'], focusDistance: { min: 0, max: 255, step: 1 },
  brightness: { min: -64, max: 64, step: 1 }, contrast: { min: 0, max: 95, step: 1 },
  saturation: { min: 0, max: 100, step: 1 }, sharpness: { min: 0, max: 7, step: 1 },
  zoom: { min: 100, max: 400, step: 1 }, pan: { min: -36000, max: 36000, step: 3600 },
};
const settings = { width: 1280, height: 720, exposureMode: 'continuous', exposureTime: 156.25, exposureCompensation: 0,
  whiteBalanceMode: 'continuous', colorTemperature: 4600, focusMode: 'continuous', focusDistance: 30,
  brightness: 0, contrast: 32, saturation: 64, sharpness: 3, zoom: 100, pan: 0 };
const { props, features } = capsToProps(caps, settings);
const by = Object.fromEntries(Object.values(props).map(p => [p.name, p]));

// Shared names sit on the same codes as a camera's, so chips, presets and the advisor find them.
for (const name of ['mode', 'shutter', 'ev', 'wb', 'focus', 'size']) assert.equal(PROPS[CODES[name]], name, name);
for (const [name, code] of Object.entries(CODES)) if (!PROPS[code]) assert.ok(code > 0xffff, `${name} can't collide with a PTP code`);
for (const p of Object.values(props)) {
  assert.ok(p.values.includes(p.value), `${p.name}: current value is one of its values`);
  assert.ok(p.values.length >= 2 && p.values.length <= 40, `${p.name}: ${p.values.length} values`);
  assert.notEqual(fmt(p.name, p.value), String(undefined));
}
assert.deepEqual(by.mode.values.map(v => fmt('mode', v)), ['P', 'M']);
assert.equal(fmt('mode', by.mode.value), 'P');
assert.equal(fmt('shutter', by.shutter.value), '1/60'); // 156.25 × 100 µs ≈ 1/64
assert.equal(fmt('shutter', by.shutter.values[0]), '1/8000');
assert.equal(fmt('shutter', by.shutter.values.at(-1)), '1/8');
assert.deepEqual([by.ev.values[0], by.ev.value, by.ev.values.at(-1)].map(v => fmt('ev', v)), ['−2.0 EV', '±0.0 EV', '+2.0 EV']);
assert.ok(by.ev.values.includes(333), 'thirds of a stop, like a camera');
assert.deepEqual(by.wb.values.map(v => fmt('wb', v)), ['Auto', 'Incandescent', 'Fluorescent', 'Daylight', 'Cloudy']);
assert.equal(fmt('kelvin', by.kelvin.value), '4600 K');
assert.deepEqual(by.focus.values.map(v => fmt('focus', v)), ['AF-C', 'Manual']);
assert.equal(by.size.value, '1280x720');
assert.equal(fmt('size', by.size.values.at(-1)), '1920 × 1080');
assert.equal(fmt('pan', 36000), '10°');
assert.ok(!by.iso && !by.torch && !by.aperture, 'only what the webcam has');
assert.deepEqual(features, { liveView: true, movie: false, autofocus: true, focusPoint: false });
console.log('✓ capabilities → properties');

// ---------- and back ----------
const back = (name, v) => toConstraints(CODES[name], v, caps);
assert.deepEqual(back('mode', 1), { exposureMode: 'manual' });
assert.deepEqual(toConstraints(CODES.mode, 1, caps, settings), { exposureMode: 'manual', exposureTime: 156.25 });
assert.deepEqual(back('mode', 2), { exposureMode: 'continuous' });
const s125 = shutterValue(1 / 125);
assert.equal(fmt('shutter', s125), '1/125');
const sh = back('shutter', s125);
assert.equal(sh.exposureMode, 'manual');
assert.ok(Math.abs(sh.exposureTime - 80) <= caps.exposureTime.step, `snapped to the webcam's step: ${sh.exposureTime}`);
assert.equal(shutterSeconds(shutterValue(2.5)), 2.5);
assert.deepEqual(back('ev', -667), { exposureCompensation: -0.7 });
assert.deepEqual(back('wb', 2), { whiteBalanceMode: 'continuous' });
assert.deepEqual(back('wb', 4), { whiteBalanceMode: 'manual', colorTemperature: 5500 });
assert.deepEqual(back('kelvin', 3200), { whiteBalanceMode: 'manual', colorTemperature: 3200 });
assert.deepEqual(back('focus', 1), { focusMode: 'manual' });
assert.deepEqual(back('focusDist', 40), { focusMode: 'manual', focusDistance: 40 });
assert.deepEqual(back('brightness', 12), { brightness: 12 });
assert.deepEqual(back('size', '1920x1080'), { width: 1920, height: 1080 });
assert.deepEqual(back('torch', 1), { torch: true });
assert.throws(() => toConstraints(0x5007, 280, caps), /Unknown/);
console.log('✓ properties → constraints');

// ISO, torch and a webcam that offers almost nothing.
const iso = capsToProps({ iso: { min: 100, max: 1600, step: 1 }, torch: true }, { iso: 400, torch: false }).props;
assert.deepEqual(Object.values(iso).find(p => p.name === 'iso').values.slice(0, 3), [100, 125, 160]);
assert.equal(fmt('torch', Object.values(iso).find(p => p.name === 'torch').value), 'Off');
assert.deepEqual(capsToProps({}, {}).props, {});
assert.deepEqual(Object.keys(capsToProps({ exposureMode: ['continuous'] }, {}).props), [String(CODES.mode)]);
assert.equal(capsToProps({ exposureMode: ['continuous'] }, {}).props[CODES.mode].writable, false);

// The scene presets run on a webcam's properties as they are.
const named = Object.fromEntries(Object.entries(props).map(([c, p]) => [c, p]));
const advice = presetAdvice(named, 'action', []);
assert.equal(advice.settings.find(s => s.name === 'shutter').display, '1/1000');
assert.ok(!advice.settings.some(s => s.name === 'aperture'));
assert.equal(presetAdvice(named, 'landscape', []).settings.find(s => s.name === 'wb').display, 'Daylight');
console.log('✓ scene presets on a webcam');

// ---------- the server side, with a fake host page ----------
const dir = mkdtempSync(join(tmpdir(), 'nr-webcam-'));
try {
  const cam = new Webcam({ capturesDir: dir, thumbsDir: dir });
  const events = [];
  for (const t of ['state', 'prop', 'photo', 'shot']) cam.on(t, d => events.push([t, d]));
  assert.equal(cam.state().connected, false);
  await assert.rejects(cam.shoot(), /not connected/);

  // The host's command stream is an SSE response; the fake reads what the server writes to it.
  const hostStream = () => {
    const res = new PassThrough();
    res.writeHead = () => {};
    res.sent = [];
    res.on('data', d => { for (const m of String(d).matchAll(/event: (\w+)\ndata: (.*)\n/g)) res.sent.push([m[1], JSON.parse(m[2])]); });
    return res;
  };
  const host = hostStream();
  cam.attach(host, { deviceId: 'abc', label: 'FHD Webcam' });
  const tick = () => new Promise(r => setImmediate(r));
  await tick();
  assert.equal(host.sent[0][0], 'hello');
  cam.update({ label: 'FHD Webcam', props, features: { ...features, movie: true } });
  assert.equal(cam.state().connected, true);
  assert.equal(cam.state().props[CODES.brightness].value, 0);

  // Setting a property goes to the host, which answers with the new value.
  const set = cam.setProp(CODES.brightness, 12);
  await tick();
  const cmd = host.sent.at(-1)[1];
  assert.deepEqual([cmd.cmd, cmd.code, cmd.value], ['set', CODES.brightness, 12]);
  cam.reply({ id: cmd.id, props: capsToProps(caps, { ...settings, brightness: 12 }).props });
  await set;
  assert.deepEqual(events.filter(e => e[0] === 'prop').map(e => [e[1].name, e[1].value]), [['brightness', 12]]);
  const step = cam.stepProp(CODES.brightness, 1);
  await tick();
  assert.equal(host.sent.at(-1)[1].value, cam.props[CODES.brightness].values.find(v => v > 12));
  cam.reply({ id: host.sent.at(-1)[1].id, error: 'Out of range' });
  await assert.rejects(step, /Out of range/);

  // Frames feed the same live view the USB camera's do.
  const img = jpeg.encode({ data: Buffer.alloc(64 * 48 * 4, 128), width: 64, height: 48 }, 80).data;
  cam.receiveFrame(img);
  const f = await cam.pullFrame(0);
  assert.equal(f.seq, 1); assert.equal(f.jpeg, img);

  // A photo: the host uploads it for the shoot command's id; it lands in today's folder with a thumbnail.
  const shot = cam.shoot();
  await tick();
  const sc = host.sent.at(-1)[1];
  assert.equal(sc.cmd, 'shoot');
  const big = jpeg.encode({ data: Buffer.alloc(1280 * 720 * 4, 200), width: 1280, height: 720 }, 90).data;
  const photo = cam.savePhoto(sc.id, big);
  assert.ok((await shot).ok);
  assert.match(photo.name, /^Webcam_\d{6}\.jpg$/);
  assert.ok(existsSync(join(dir, photo.day, photo.name)));
  const th = jpeg.decode(readFileSync(join(dir, `${photo.day}_${photo.name}.jpg`)));
  assert.deepEqual([th.width, th.height], [320, 180]);
  assert.ok(events.some(e => e[0] === 'photo') && events.some(e => e[0] === 'shot'));
  assert.throws(() => cam.savePhoto(999, big), /No photo/);

  // Video: chunks append to one file, which shows up in the gallery when recording stops.
  const rec = cam.startMovie();
  await tick();
  cam.reply({ id: host.sent.at(-1)[1].id, result: { ext: 'mp4' } });
  await rec;
  assert.ok(cam.state().recordingSince);
  await assert.rejects(cam.shoot(), /Stop recording/);
  cam.appendMovie(Buffer.from('abc')); cam.appendMovie(Buffer.from('def'));
  const stop = cam.stopMovie();
  await tick();
  cam.reply({ id: host.sent.at(-1)[1].id });
  await stop;
  const clip = events.filter(e => e[0] === 'photo').at(-1)[1];
  assert.ok(clip.video && /\.mp4$/.test(clip.name) && clip.size === 6);
  assert.equal(readFileSync(join(dir, clip.day, clip.name), 'utf8'), 'abcdef');

  // Frame rate follows whether anyone is watching.
  cam.lastPull = Date.now(); cam.live = ''; cam.sendLive();
  assert.deepEqual(host.sent.at(-1), ['live', { fps: 12, width: 640 }]);

  // The page closing drops the webcam cleanly: disconnected, and waiting commands fail.
  const pending = cam.autofocus();
  await tick();
  host.end(); host.emit('close');
  await assert.rejects(pending, /closed/);
  assert.equal(cam.state().connected, false);
  assert.match(cam.state().error, /closed/);
  cam.receiveFrame(img);
  assert.equal(cam.frameSeq, 1, 'no frames without a host');

  // A second window takes over from the first, which is told to stop.
  const a = hostStream(), b = hostStream();
  cam.attach(a, { deviceId: 'x', label: 'A' });
  cam.attach(b, { deviceId: 'y', label: 'B' });
  await tick();
  assert.ok(a.sent.some(([t]) => t === 'release'));
  assert.equal(cam.deviceId, 'y');
  cam.release('Switched to the USB camera', true);
  await tick();
  assert.deepEqual(b.sent.at(-1), ['release', { reason: 'Switched to the USB camera', forget: true }]);

  assert.equal(jpeg.decode(thumbnail(big, 640)).width, 640);
  console.log('✓ webcam host protocol');
} finally { rmSync(dir, { recursive: true, force: true }); }
process.exit(0); // the frame-rate interval is unref'd, but be explicit

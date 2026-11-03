// Browsing and copying the camera's card, against a fake camera: listing, paging, skipping files
// already copied, and what's left behind when the camera refuses a file or drops off USB. Run: npm test
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const imp = p => import(new URL(`../${p}`, import.meta.url));
const { Camera, captureDay } = await imp('src/camera.js');
const { encodeValue, Op } = await imp('src/ptp.js');

const OK = 0x2001;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A minimal NEF: IFD0 holds a small JPEG and points to a SubIFD holding a bigger one.
const SMALL = Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]), BIG = Buffer.from([0xff, 0xd8, 2, 2, 2, 2, 0xff, 0xd9]);
function tinyRaw() {
  const b = Buffer.alloc(100);
  const entry = (at, tag, v) => { b.writeUInt16LE(tag, at); b.writeUInt16LE(4, at + 2); b.writeUInt32LE(1, at + 4); b.writeUInt32LE(v, at + 8); };
  b.write('II', 0, 'latin1'); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4);
  b.writeUInt16LE(3, 8); entry(10, 0x14a, 50); entry(22, 0x201, 80); entry(34, 0x202, SMALL.length);
  b.writeUInt16LE(2, 50); entry(52, 0x201, 88); entry(64, 0x202, BIG.length);
  SMALL.copy(b, 80); BIG.copy(b, 88);
  return b;
}

function objectInfo({ filename, size = 0, format = 0x3801, date = '' }) {
  const b = Buffer.alloc(52);
  b.writeUInt32LE(0x10001, 0); b.writeUInt16LE(format, 4); b.writeUInt32LE(size, 8);
  return Buffer.concat([b, encodeValue(0xffff, filename), encodeValue(0xffff, date)]);
}

// A camera with a folder and five files, handles out of shooting order like Nikon's;
// handle 5 is refused, handle 6 drops the USB connection.
function fakeCamera(dir) {
  const objects = {
    1: { filename: 'DCIM', format: 0x3001 },
    2: { filename: 'DSC_0001.JPG', size: 3, date: '20261101T101500', data: 'one' },
    3: { filename: 'DSC_0002.NEF', size: 100, date: '20261102T090000', data: tinyRaw() },
    4: { filename: 'DSC_0003.MOV', size: 5, date: '', data: 'three' },
    5: { filename: 'DSC_0004.JPG', size: 4, date: '20261103T080000', data: 'four' },
    6: { filename: 'DSC_0005.JPG', size: 4, date: '20261103T080100', data: 'five' },
  };
  const calls = [];
  const cam = Object.create(Camera.prototype);
  Object.assign(cam, {
    capturesDir: join(dir, 'captures'), thumbsDir: join(dir, 'thumbs'),
    connected: true, recordingSince: null, driver: { brand: 'Nikon', features: { card: true } }, info: { operations: [Op.NikonGetLargeThumb] },
    cardInfo: new Map(), cardThumbs: new Map(), cardJob: null, cardCache: join(dir, 'thumbs', '.card'), cardViews: new Map(), photos: [],
    emit(type, d) { if (type === 'photo') this.photos.push(d); },
  });
  mkdirSync(cam.thumbsDir, { recursive: true });
  cam.bridge = {
    async send(op, [h] = [], opts = {}) {
      calls.push([op, h]);
      if (op === Op.GetObjectHandles) {
        const ids = Object.keys(objects).map(Number), b = Buffer.alloc(4 + ids.length * 4);
        b.writeUInt32LE(ids.length, 0); ids.forEach((id, i) => b.writeUInt32LE(id, 4 + i * 4));
        return { code: OK, data: b };
      }
      const o = objects[h];
      if (!o) return { code: 0x2009, data: null };
      if (op === Op.GetObjectInfo) return { code: OK, data: objectInfo(o) };
      if (op === Op.GetThumb) return { code: OK, data: Buffer.from(`thumb ${h}`) };
      if (op === Op.NikonGetLargeThumb) return { code: OK, data: Buffer.from(`preview ${h}`) };
      if (op === Op.GetObject) {
        writeFileSync(opts.file, o.data.slice(0, 2)); // the transfer starts…
        if (h === 5) return { code: 0x2019 };        // …and the camera gives up
        if (h === 6) throw new Error('bridge exited');
        writeFileSync(opts.file, o.data);
        return { code: OK };
      }
      return { code: 0x2005 };
    },
  };
  return { cam, calls, objects };
}
async function finished(cam) { for (let i = 0; i < 100 && !cam.cardJob.finished; i++) await sleep(5); return cam.cardJob; }

const dir = mkdtempSync(join(tmpdir(), 'card-test-'));
try {
  const { cam, calls } = fakeCamera(dir);
  const today = new Date().toISOString().slice(0, 10);

  // ---------- listing ----------
  assert.equal(captureDay('20261102T090000'), '2026-11-02');
  assert.equal(captureDay('20261102T090000.0Z'), '2026-11-02');
  assert.equal(captureDay(''), today);
  // A shot already copied (same name and size) shows as downloaded.
  mkdirSync(join(cam.capturesDir, '2026-11-01'), { recursive: true });
  writeFileSync(join(cam.capturesDir, '2026-11-01', 'DSC_0001.JPG'), 'one');
  const page1 = await cam.cardFiles({ limit: 2 });
  assert.deepEqual(page1.files.map(f => f.name), ['DSC_0005.JPG', 'DSC_0004.JPG'], 'newest first');
  assert.equal(page1.next, 2);
  assert.equal(page1.total, 5, 'folders are not counted');
  const page2 = await cam.cardFiles({ start: page1.next, limit: 10 });
  assert.deepEqual(page2.files.map(f => [f.name, f.day, f.downloaded, f.video]), [
    ['DSC_0002.NEF', '2026-11-02', false, false], ['DSC_0001.JPG', '2026-11-01', true, false], ['DSC_0003.MOV', today, false, true],
  ], 'sorted by capture date, undated last; the day comes from the capture date');
  assert.equal(page2.next, null);
  const infoCalls = calls.filter(([op]) => op === Op.GetObjectInfo).length;
  await cam.cardFiles({ limit: 10 });
  assert.equal(calls.filter(([op]) => op === Op.GetObjectInfo).length, infoCalls, 'object info is cached');
  console.log('✓ card: listing, paging, already-copied files');

  // ---------- thumbnails ----------
  assert.equal((await cam.cardThumb(3)).toString(), 'thumb 3');
  await cam.cardThumb(3);
  assert.equal(calls.filter(([op, h]) => op === Op.GetThumb && h === 3).length, 1, 'thumbnails are cached');
  await assert.rejects(cam.cardThumb(NaN), /Invalid photo/);
  await assert.rejects(cam.cardThumb(99), /No thumbnail: Photo no longer on the card/);
  console.log('✓ card: thumbnails');

  // ---------- full size, for the viewer ----------
  const { rawPreview } = await imp('src/camera.js');
  assert.deepEqual(rawPreview(tinyRaw()), BIG, 'the biggest JPEG, found through the SubIFD');
  assert.equal(rawPreview(Buffer.from('not a raw file')), null);
  assert.equal(rawPreview(tinyRaw().subarray(0, 60)), null, 'a file cut short is no crash');
  assert.deepEqual((await cam.cardView(3)).jpeg, BIG, 'RAW shows its built-in full-size JPEG');
  assert.equal((await cam.cardView(2)).file, join(cam.capturesDir, '2026-11-01', 'DSC_0001.JPG'), 'already copied: no transfer');
  const gets = () => calls.filter(([op]) => op === Op.GetObject).length;
  const before = gets();
  const [a, b] = await Promise.all([cam.cardView(4), cam.cardView(4)]);
  assert.equal(a.file, b.file);
  assert.equal(readFileSync(a.file, 'utf8'), 'three');
  await cam.cardView(4);
  assert.equal(gets() - before, 1, 'two taps share one transfer, and the next view uses the cache');
  await assert.rejects(cam.cardView(5), /Device busy/);
  assert.ok(!readdirSync(cam.cardCache).some(f => f.endsWith('.part')), 'a refused transfer leaves nothing in the cache');
  await assert.rejects(cam.cardView(1), /Not a photo/);
  console.log('✓ card: full-size view');

  // ---------- refusing what can't work ----------
  assert.throws(() => cam.downloadFromCard([]), /Pick some photos/);
  assert.throws(() => cam.downloadFromCard(['2']), /Invalid photo list/);
  assert.throws(() => cam.downloadFromCard([1.5]), /Invalid photo list/);
  assert.throws(() => cam.downloadFromCard(new Array(501).fill(2)), /up to 500/);
  cam.recordingSince = Date.now();
  await assert.rejects(cam.cardFiles(), /Stop recording/);
  cam.recordingSince = null;
  cam.driver.features.card = false;
  await assert.rejects(cam.cardFiles(), /isn't supported on Nikon/);
  cam.driver.features.card = true;
  cam.connected = false;
  assert.throws(() => cam.downloadFromCard([2]), /not connected/);
  cam.connected = true;
  console.log('✓ card: bad requests are refused');

  // ---------- copying ----------
  const started = cam.downloadFromCard([2, 3, 4, 5, 99]);
  assert.equal(started.total, 5);
  assert.throws(() => cam.downloadFromCard([2]), /Already downloading/);
  const job = await finished(cam);
  assert.equal(job.saved, 2);
  assert.equal(job.skipped, 1, 'DSC_0001 was already there');
  assert.deepEqual(job.failed.map(f => [f.handle, f.error]), [[5, 'Device busy'], [99, 'Photo no longer on the card']]);
  assert.deepEqual(readFileSync(join(cam.capturesDir, '2026-11-02', 'DSC_0002.NEF')), tinyRaw());
  assert.equal(readFileSync(join(cam.capturesDir, today, 'DSC_0003.MOV'), 'utf8'), 'three');
  assert.ok(existsSync(join(cam.thumbsDir, '2026-11-02_DSC_0002.NEF.jpg')), 'the thumbnail is kept for the gallery');
  assert.ok(!readdirSync(join(cam.capturesDir, '2026-11-03')).some(f => f.startsWith('DSC_0004')), 'a refused transfer leaves no partial file');
  assert.deepEqual(cam.photos.map(p => p.name), ['DSC_0002.NEF', 'DSC_0003.MOV'], 'copied files show up in the gallery');
  console.log('✓ card: copy, skip, and refused files');

  // ---------- losing the camera halfway ----------
  cam.downloadFromCard([6, 2, 3]);
  const lost = await finished(cam);
  assert.deepEqual(lost.failed.map(f => f.error), ['bridge exited', 'Camera disconnected', 'Camera disconnected']);
  assert.equal(lost.saved + lost.skipped, 0, 'nothing more is tried once the connection is gone');
  assert.ok(!readdirSync(join(cam.capturesDir, '2026-11-03')).some(f => f.endsWith('.part')));
  console.log('✓ card: a dropped connection stops the copy cleanly');

  // ---------- new shots still download as before ----------
  await cam.downloadPhoto(5); // refused: logged and skipped, the main loop carries on
  await assert.rejects(cam.downloadPhoto(6), /bridge exited/, 'a lost connection still reaches the main loop');
  await cam.downloadPhoto(2);
  assert.equal(readFileSync(join(cam.capturesDir, today, 'DSC_0001.JPG'), 'utf8'), 'one');
  console.log('✓ card: auto-download of new shots unchanged');

  // ---------- picking the photos folder ----------
  const { checkFolder } = await imp('src/photos.js');
  const picked = join(dir, 'elsewhere', 'Nikon');
  assert.equal(checkFolder(` ${picked} `), picked, 'created if missing, trimmed');
  assert.deepEqual(readdirSync(picked), [], 'the test file is cleaned up');
  assert.throws(() => checkFolder(''), /full path/);
  assert.throws(() => checkFolder('photos\\nikon'), /full path/);
  writeFileSync(join(dir, 'afile'), 'x');
  assert.throws(() => checkFolder(join(dir, 'afile', 'sub')), /Can't save to .*: Part of that path is a file/);
  assert.throws(() => checkFolder(join(dir, 'afile')), /Part of that path is a file/);
  if (process.platform === 'win32' && !existsSync('Q:\\')) assert.throws(() => checkFolder('Q:\\Photos'), /That drive isn't there/);
  console.log('✓ folder: checked by writing and reading back, with plain errors');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

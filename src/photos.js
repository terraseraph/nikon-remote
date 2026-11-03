// The captures folder: one folder per day, shared by every camera source, listed in the gallery.
import { mkdirSync, readdirSync, statSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, normalize, isAbsolute } from 'node:path';

// Makes sure shots can be saved in `dir`: creates it if needed, then writes, reads back and deletes
// a small file. Throws a message a person can act on.
export function checkFolder(dir) {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('Type the full path of a folder');
  dir = normalize(dir.trim());
  if (!isAbsolute(dir) || dir.length > 240) throw new Error('Use a full path, like D:\\Photos\\Nikon');
  const test = join(dir, `.nikon-remote-check-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(dir, { recursive: true });
    if (!statSync(dir).isDirectory()) throw Object.assign(new Error(), { code: 'ENOTDIR' });
    writeFileSync(test, 'ok');
    if (readFileSync(test, 'utf8') !== 'ok') throw new Error('What was written there read back differently');
  } catch (e) {
    const why = {
      EACCES: 'Windows won\'t let the app write there', EPERM: 'Windows won\'t let the app write there',
      ENOENT: 'That drive isn\'t there', EROFS: 'That drive is read-only', ENOTDIR: 'Part of that path is a file, not a folder',
      ENOSPC: 'That drive is full', EINVAL: 'That isn\'t a valid folder name', EEXIST: 'Part of that path is a file, not a folder',
    }[e.code] || e.message;
    throw new Error(`Can't save to ${dir}: ${why}`);
  } finally {
    rmSync(test, { force: true });
  }
  return dir;
}

// Today's folder, created if needed.
export function dayDir(capturesDir) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(capturesDir, day);
  mkdirSync(dir, { recursive: true });
  return { day, dir };
}

// `name`, or name_1, name_2… if a file by that name is already there.
export function freeName(dir, name) {
  let file = name;
  for (let n = 1; existsSync(join(dir, file)); n++) file = name.replace(/(\.\w+)$/, `_${n}$1`);
  return file;
}

export function photoEntry(day, file, size) {
  const isJpeg = /\.jpe?g$/i.test(file);
  return {
    name: file, day, size, video: /\.(mov|mp4|webm)$/i.test(file),
    url: `/captures/${day}/${encodeURIComponent(file)}`,
    thumb: `/captures/.thumbs/${day}_${encodeURIComponent(file)}.jpg`,
    preview: isJpeg ? `/captures/${day}/${encodeURIComponent(file)}` : `/captures/.thumbs/${day}_${encodeURIComponent(file)}.jpg`,
  };
}

export function listPhotos(capturesDir, limit = 60) {
  const out = [];
  const days = existsSync(capturesDir) ? readdirSync(capturesDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse() : [];
  for (const day of days) {
    const files = readdirSync(join(capturesDir, day))
      .filter(f => !f.endsWith('.part')) // still downloading from the card
      .map(f => ({ f, t: statSync(join(capturesDir, day, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files) {
      out.push(photoEntry(day, f, statSync(join(capturesDir, day, f)).size));
      if (out.length >= limit) return out;
    }
  }
  return out;
}

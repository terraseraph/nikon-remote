// The captures folder: one folder per day, shared by every camera source, listed in the gallery.
import { mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
      .map(f => ({ f, t: statSync(join(capturesDir, day, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files) {
      out.push(photoEntry(day, f, statSync(join(capturesDir, day, f)).size));
      if (out.length >= limit) return out;
    }
  }
  return out;
}

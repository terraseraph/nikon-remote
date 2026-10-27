// Downloads the third-party files the app needs but doesn't keep in git: MediaPipe and its models
// (gestures, pose match), the phone QR code library, and the offline voice engines (Whisper and
// Vosk). Runs after `npm install`; files already there are skipped, so delete one to update it.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Windows' own tar reads zip files; the one Git for Windows puts first on PATH doesn't.
const TAR = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODELS = 'https://storage.googleapis.com/mediapipe-models';

const FILES = {
  'public/vendor/tasks-vision/vision_bundle.mjs': `${VISION}/vision_bundle.mjs`,
  // FilesetResolver picks the SIMD build where the browser supports it, else the plain one.
  'public/vendor/tasks-vision/wasm/vision_wasm_internal.js': `${VISION}/wasm/vision_wasm_internal.js`,
  'public/vendor/tasks-vision/wasm/vision_wasm_internal.wasm': `${VISION}/wasm/vision_wasm_internal.wasm`,
  'public/vendor/tasks-vision/wasm/vision_wasm_nosimd_internal.js': `${VISION}/wasm/vision_wasm_nosimd_internal.js`,
  'public/vendor/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm': `${VISION}/wasm/vision_wasm_nosimd_internal.wasm`,
  'public/vendor/models/gesture_recognizer.task': `${MODELS}/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task`,
  'public/vendor/models/pose_landmarker_lite.task': `${MODELS}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
  'public/vendor/qrcode.min.js': 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js',
  // Vosk runs in the page as WebAssembly.
  'public/vendor/vosk/vosk.js': 'https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js',
  // Whisper runs on the laptop: whisper-server (below) with the English-only base model.
  'engines/whisper/ggml-base.en-q5_1.bin': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin',
};

// whisper-server and the libraries it loads. The ggml-cpu-* builds are per CPU generation; it picks one at start.
const WHISPER_ZIP = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip';
const WHISPER_FILES = ['whisper-server.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu-*.dll'];
// vosk-browser loads a model from a .tar.gz holding the model's folder; Vosk publishes zips.
const VOSK_MODEL = 'vosk-model-small-en-us-0.15';
const VOSK_ZIP = `https://alphacephei.com/vosk/models/${VOSK_MODEL}.zip`;

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function save(rel, buf) {
  const file = join(ROOT, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buf);
  console.log(`${rel}  ${(buf.length / 1e6).toFixed(1)} MB`);
}

// Downloads a zip to a temp folder and hands it to `use`, then cleans up.
async function withZip(url, use) {
  const tmp = mkdtempSync(join(tmpdir(), 'nikon-remote-'));
  try {
    const zip = join(tmp, 'download.zip');
    writeFileSync(zip, await download(url));
    use(zip, tmp);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

for (const [rel, url] of Object.entries(FILES)) {
  if (!existsSync(join(ROOT, rel))) save(rel, await download(url));
}

if (!existsSync(join(ROOT, 'engines/whisper/whisper-server.exe'))) {
  await withZip(WHISPER_ZIP, zip => {
    const out = join(ROOT, 'engines/whisper');
    mkdirSync(out, { recursive: true });
    execFileSync(TAR, ['-xf', zip, '-C', out, '--strip-components', '1', ...WHISPER_FILES.map(f => `Release/${f}`)]);
    console.log('engines/whisper/whisper-server.exe and libraries');
  });
}

const voskModel = `public/vendor/vosk/${VOSK_MODEL}.tar.gz`;
if (!existsSync(join(ROOT, voskModel))) {
  await withZip(VOSK_ZIP, (zip, tmp) => {
    execFileSync(TAR, ['-xf', zip, '-C', tmp]);
    mkdirSync(join(ROOT, 'public/vendor/vosk'), { recursive: true });
    execFileSync(TAR, ['-czf', join(ROOT, voskModel), '-C', tmp, VOSK_MODEL]);
    console.log(voskModel);
  });
}

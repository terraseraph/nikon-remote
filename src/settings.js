// API keys entered in the app (More › AI), saved to DATA_DIR/settings.json. The desktop app's
// users won't make a .env in their AppData folder, so this is the main way keys get set; a .env
// still works and a key saved here wins over it. advisor.js and inspo.js read process.env on
// every request, so writing the keys there takes effect without a restart.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Only these names are read from or written to the file; anything else in a request is ignored.
export const GROUPS = [
  {
    id: 'assist', name: 'Shot assist', note: 'Suggests exposure settings from the live view. Any one of these enables it.',
    keys: [
      { name: 'NOUS_API_KEY', label: 'Nous Portal', url: 'https://portal.nousresearch.com' },
      { name: 'OPENROUTER_API_KEY', label: 'OpenRouter', url: 'https://openrouter.ai/keys' },
      { name: 'ANTHROPIC_API_KEY', label: 'Anthropic', url: 'https://console.anthropic.com/settings/keys' },
    ],
  },
  {
    id: 'inspo', name: 'Inspo', note: 'Finds reference photos for a pose or shot. Any one of these enables it.',
    keys: [
      { name: 'PEXELS_API_KEY', label: 'Pexels', url: 'https://www.pexels.com/api/' },
      { name: 'UNSPLASH_ACCESS_KEY', label: 'Unsplash', url: 'https://unsplash.com/developers' },
      { name: 'SERPER_API_KEY', label: 'Serper (Google Images)', url: 'https://serper.dev' },
    ],
  },
];
const NAMES = GROUPS.flatMap(g => g.keys.map(k => k.name));

// Free requests that only succeed with a valid key. Nous and Serper have none that we can rely on
// (Nous's model list is public, a Serper search spends a credit), so those can't be tested.
const get = (url, headers) => fetch(url, { headers, signal: AbortSignal.timeout(8000) });
const CHECKS = {
  OPENROUTER_API_KEY: k => get('https://openrouter.ai/api/v1/key', { authorization: `Bearer ${k}` }),
  ANTHROPIC_API_KEY: k => get('https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
  PEXELS_API_KEY: k => get('https://api.pexels.com/v1/curated?per_page=1', { authorization: k }),
  UNSPLASH_ACCESS_KEY: k => get('https://api.unsplash.com/photos?per_page=1', { authorization: `Client-ID ${k}`, 'accept-version': 'v1' }),
};

let file = null;
let saved = {};   // what the app saved
const env = {};   // what the environment and .env had before the saved keys were laid over it

function apply() {
  for (const n of NAMES) {
    const v = saved[n] || env[n];
    if (v) process.env[n] = v; else delete process.env[n];
  }
}

// Call once, after the .env has been loaded.
export function loadSettings(dir) {
  file = join(dir, 'settings.json');
  for (const n of NAMES) env[n] = process.env[n];
  try {
    const s = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    for (const n of NAMES) if (typeof s.keys?.[n] === 'string' && s.keys[n]) saved[n] = s.keys[n];
  } catch (e) { console.log(`settings.json unreadable (${e.message}); ignoring it`); }
  apply();
}

// Never the keys themselves: the last 4 characters are enough to tell which one is in use
// (left out for short values, where 4 characters would give away too much of it).
export function settingsView() {
  return {
    groups: GROUPS.map(g => ({
      ...g,
      keys: g.keys.map(k => {
        const v = process.env[k.name];
        return { ...k, set: !!v, source: saved[k.name] ? 'app' : v ? 'env' : null, hint: v?.length >= 16 ? v.slice(-4) : '', testable: !!CHECKS[k.name] };
      }),
    })),
  };
}

// `keys` maps a name to a new value, or to '' / null to forget the saved one (the .env value,
// if any, applies again). Names left out are untouched.
export function saveSettings(keys) {
  if (!keys || typeof keys !== 'object') throw new Error('Nothing to save');
  for (const n of NAMES) {
    if (!(n in keys)) continue;
    const v = keys[n] == null ? '' : String(keys[n]).trim();
    if (v.length > 500 || /\s/.test(v)) throw new Error(`That doesn't look like a ${n} — check for spaces or extra text`);
    if (v) saved[n] = v; else delete saved[n];
  }
  writeFileSync(file, JSON.stringify({ keys: saved }, null, 2), { mode: 0o600 });
  apply();
}

// Tests the typed value, or the key in use when nothing was typed.
export async function testKey(name, value) {
  const check = Object.hasOwn(CHECKS, name) && CHECKS[name];
  if (!check) throw new Error('This key can\'t be tested');
  const key = String(value || '').trim() || process.env[name];
  if (!key) throw new Error('No key to test');
  let res;
  try { res = await check(key); }
  catch (e) { throw new Error(`Couldn't reach the service (${e.cause?.code || e.name})`); }
  if (res.ok) return { ok: true };
  if (res.status === 401 || res.status === 403) return { ok: false, error: 'Key was rejected' };
  throw new Error(`The service answered ${res.status}; try again later`);
}

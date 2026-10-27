// Pose / shot inspiration: turns a spoken or typed request ("moody couple pose against a wall")
// into photo searches and returns real photos from stock libraries — nothing is generated.
// Sources: Pexels (PEXELS_API_KEY), Unsplash (UNSPLASH_ACCESS_KEY) and Google Images via Serper
// (SERPER_API_KEY), whichever have keys. When a model is configured it sees the live view frame
// and writes sharper queries plus a one-line posing cue.
import { acceptsImages, callModel, modelConfig, parseJson } from './advisor.js';

const PER_QUERY = 8;
const MAX_RESULTS = 16;

const SYSTEM = `You help a photographer find reference photos while they shoot. They say what they want in a few words; you may also get the current live view frame.
Write image-search queries that will surface real stock photos showing that pose or shot. Rules:
- 2 or 3 queries, each 3 to 7 plain words, the kind that work on Pexels and Google Images (subject, pose, setting, light; adding "photography" or "poses" helps). No quotes or operators.
- Use the frame for context the photographer didn't say (indoors/outdoors, light, how many people) but keep their request first.
- "cue" is one short directing line the photographer could say to the model, at most 14 words.
- "orientation": "portrait" or "landscape" if the request or frame clearly suggests one, else "".
Reply with JSON only: {"queries": ["..."], "cue": "...", "orientation": ""}`;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

// Image URLs we've handed out, so the proxy below can't be used to fetch anything else.
const issued = new Set();

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { 'user-agent': 'NikonRemote/0.1', ...headers }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${new URL(url).host}: ${res.status}`);
  return res.json();
}

const SOURCES = {
  pexels: {
    enabled: () => !!process.env.PEXELS_API_KEY,
    async search(q, orientation) {
      const u = new URL('https://api.pexels.com/v1/search');
      u.search = new URLSearchParams({ query: q, per_page: PER_QUERY, ...(orientation && { orientation }) });
      const d = await getJson(u, { authorization: process.env.PEXELS_API_KEY });
      return d.photos.map(p => ({
        id: `pexels:${p.id}`, thumb: p.src.medium, full: p.src.large, w: p.width, h: p.height, alt: p.alt || '',
        credit: p.photographer, link: p.url, source: 'Pexels',
      }));
    },
  },
  unsplash: {
    enabled: () => !!process.env.UNSPLASH_ACCESS_KEY,
    async search(q, orientation) {
      const u = new URL('https://api.unsplash.com/search/photos');
      u.search = new URLSearchParams({ query: q, per_page: PER_QUERY, content_filter: 'high', ...(orientation && { orientation }) });
      const d = await getJson(u, { authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}`, 'accept-version': 'v1' });
      return d.results.map(p => ({
        id: `unsplash:${p.id}`, thumb: p.urls.small, full: p.urls.regular, w: p.width, h: p.height, alt: p.alt_description || '',
        credit: p.user?.name || '', link: `${p.links.html}?utm_source=nikon_remote&utm_medium=referral`, source: 'Unsplash',
      }));
    },
  },
  // Google Images through Serper: the widest range (Pinterest boards, photographers' portfolios).
  // The photos belong to their owners, so they're shown as references only, with a link back.
  google: {
    enabled: () => !!process.env.SERPER_API_KEY,
    async search(q, orientation) {
      const res = await fetch('https://google.serper.dev/images', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.SERPER_API_KEY },
        // SafeSearch is off (Serper's default, sent explicitly so it can't drift) for boudoir and nude
        // references; INSPO_SAFESEARCH=on filters explicit results.
        body: JSON.stringify({ q, num: PER_QUERY * 2, safe: process.env.INSPO_SAFESEARCH === 'on' ? 'active' : 'off' }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`google.serper.dev: ${res.status}`);
      const shape = p => (p.imageWidth >= p.imageHeight * 1.15 ? 'landscape' : p.imageHeight >= p.imageWidth * 1.15 ? 'portrait' : '');
      const all = ((await res.json()).images || [])
        .filter(p => p.imageUrl && (p.imageWidth || 0) >= 400 && (p.imageHeight || 0) >= 400); // icons, logos and tiny thumbnails
      // Google can't filter by orientation, so prefer the matching ones when there are enough.
      const fit = orientation ? all.filter(p => shape(p) !== (orientation === 'portrait' ? 'landscape' : 'portrait')) : all;
      return (fit.length >= 4 ? fit : all).slice(0, PER_QUERY).map(p => ({
        id: `google:${p.imageUrl}`, thumb: p.thumbnailUrl || p.imageUrl, full: p.imageUrl, fallback: p.thumbnailUrl,
        w: p.imageWidth, h: p.imageHeight, alt: p.title || '', credit: p.domain || p.source || '', link: p.link || p.imageUrl, source: 'Google',
      }));
    },
  },
};

const activeSources = () => Object.keys(SOURCES).filter(s => SOURCES[s].enabled());

export function inspoConfig() {
  const planner = plannerConfig();
  return { sources: activeSources(), planner: planner && `${planner.model} (${planner.provider})` };
}

// With a Nous Portal key, queries are written there (INSPO_MODEL picks the model, any id from
// their catalog); otherwise by the model picked for shot assist.
function plannerConfig(model) {
  if (process.env.NOUS_API_KEY) return { provider: 'nous', model: process.env.INSPO_MODEL || 'anthropic/claude-haiku-5.5' };
  return modelConfig(model);
}

// Asks the model for queries; without a model (or if it fails) the request itself is the query.
async function plan(camera, request, model) {
  const config = plannerConfig(model);
  if (!config) return { queries: [request], cue: '', orientation: '' };
  const frame = camera.liveView && camera.frame && await acceptsImages(config) ? Buffer.from(camera.frame) : null;
  try {
    const reply = parseJson(await callModel(config, SYSTEM, `Request: ${request}${frame ? '' : '\n(No live view frame available.)'}`, frame, 400));
    const queries = (Array.isArray(reply.queries) ? reply.queries : []).map(q => String(q).trim()).filter(Boolean).slice(0, 3);
    return {
      queries: queries.length ? queries : [request],
      cue: String(reply.cue || '').slice(0, 140),
      orientation: ['portrait', 'landscape'].includes(reply.orientation) ? reply.orientation : '',
    };
  } catch (e) {
    console.log(`Inspo: model failed (${e.message}); searching the request as typed`);
    return { queries: [request], cue: '', orientation: '' };
  }
}

export async function findInspo(camera, { request, model }) {
  request = String(request || '').trim().slice(0, 200);
  if (!request) throw new Error('Say or type what you\'re looking for');
  if (!activeSources().length) throw new Error('Add a Pexels, Unsplash or Serper key under More › AI on the laptop to search for reference photos');
  const { queries, cue, orientation } = await plan(camera, request, model);

  const jobs = [];
  for (const q of queries) for (const s of activeSources()) jobs.push(SOURCES[s].search(q, orientation).then(r => r, e => { console.log(`Inspo: ${e.message}`); return []; }));
  const lists = await Promise.all(jobs);
  // Interleave so the first few photos cover every query and library, not just the first one.
  const seen = new Set(), photos = [];
  for (let i = 0; photos.length < MAX_RESULTS && lists.some(l => l[i]); i++) {
    for (const l of lists) {
      const p = l[i];
      if (!p || seen.has(p.id) || photos.length >= MAX_RESULTS) continue;
      seen.add(p.id);
      photos.push(p);
      issued.add(p.full); issued.add(p.thumb); if (p.fallback) issued.add(p.fallback);
    }
  }
  if (!photos.length) throw new Error(`No photos found for “${request}” — try other words`);
  if (issued.size > 2000) { const keep = [...issued].slice(-400); issued.clear(); keep.forEach(u => issued.add(u)); }
  return { request, queries, cue, photos };
}

// Pose detection reads the image's pixels, which the browser only allows for images served with
// CORS headers. Libraries that don't send them come through here instead.
export async function proxyImage(url) {
  if (!issued.has(url)) throw new Error('Not an inspo image');
  // Many sites refuse image requests that don't look like a browser.
  const res = await fetch(url, { headers: { 'user-agent': BROWSER_UA, accept: 'image/avif,image/webp,image/*,*/*;q=0.8' }, signal: AbortSignal.timeout(10000) });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.startsWith('image/')) throw new Error(`Image fetch failed (${res.status})`);
  return { type, data: Buffer.from(await res.arrayBuffer()) };
}

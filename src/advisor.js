// Shot advisor: sends the current live view frame and the camera's settings to a vision model
// and maps its suggestions back onto values the camera actually offers.
// Uses Nous Portal (NOUS_API_KEY), OpenRouter (OPENROUTER_API_KEY) or Anthropic directly (ANTHROPIC_API_KEY);
// ADVISOR_MODEL overrides the model.
import { fmt, LABEL } from '../public/format.js';
import { PROPS } from './camera.js';

// Settings the model may change; mode is on the dial, so it can only be recommended.
const ADJUSTABLE = ['aperture', 'shutter', 'iso', 'ev', 'wb', 'metering', 'focus', 'quality'];

export const SCENES = {
  boudoir: 'Low-light boudoir: intimate indoor portraits, soft window or lamp light, flattering skin tones, shallow depth of field, little to no flash.',
  portrait: 'Outdoor portrait: natural light, subject separation from background, pleasing skin tones.',
  landscape: 'Outdoor landscape / scenery: front-to-back sharpness, good dynamic range, low noise.',
  action: 'Action / sports: moving subjects, freeze motion, reliable continuous focus tracking.',
  street: 'Street / documentary: quick, candid, moderate depth of field, handheld.',
  event: 'Indoor event / party: mixed artificial light, people moving, handheld, no tripod.',
  night: 'Night / astro: very low light, likely on a tripod, long exposures acceptable.',
  product: 'Product / still life: static subject, controlled light, maximum detail, tripod likely.',
};

const OPENROUTER_MODELS = ['anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash', 'google/gemini-3.1-flash-lite'];

// OpenAI-style chat endpoints. Nous Portal (NOUS_API_KEY) serves the same model ids as OpenRouter;
// NOUS_BASE_URL overrides its address.
const OPENAI_STYLE = {
  openrouter: { name: 'OpenRouter', key: 'OPENROUTER_API_KEY', url: () => 'https://openrouter.ai/api/v1' },
  nous: { name: 'Nous', key: 'NOUS_API_KEY', url: () => process.env.NOUS_BASE_URL || 'https://inference-api.nousresearch.com/v1' },
};
// Vision models that answer quickly; the reasoning-only ones (Sonnet, Gemini 3.8 Flash) are slower but sharper.
const NOUS_MODELS = [
  'anthropic/claude-haiku-5.5', 'openai/gpt-6-luna', 'google/gemini-3.1-flash-lite', 'deepseek/deepseek-v4.1-flash',
  'qwen/qwen3.8-flash', 'x-ai/grok-4.7', 'mistralai/mistral-large-4-0', 'nvidia/nemotron-3.5-super-vl',
  'moonshotai/kimi-k3.1-pro', 'openai/gpt-6-sol', 'anthropic/claude-sonnet-5.5', 'google/gemini-3.8-flash',
];
const ids = v => v?.split(',').map(s => s.trim()).filter(Boolean);

// Models offered in the app's picker: OpenRouter ones (ADVISOR_MODELS overrides the list, comma-separated),
// Nous Portal ones (NOUS_MODELS overrides) and Haiku via Anthropic's own API when ANTHROPIC_API_KEY is set.
// ADVISOR_MODEL picks the default.
export function advisorModels() {
  const list = [];
  // Nous first, so it's the default when both keys are set.
  if (process.env.NOUS_API_KEY) {
    for (const id of ids(process.env.NOUS_MODELS) || NOUS_MODELS) list.push({ id: `nous:${id}`, provider: 'nous', model: id, label: `${id.split('/').pop()} (Nous)` });
  }
  if (process.env.OPENROUTER_API_KEY) {
    for (const id of ids(process.env.ADVISOR_MODELS) || OPENROUTER_MODELS) list.push({ id, provider: 'openrouter', label: `${id.split('/').pop()} (OpenRouter)` });
  }
  if (process.env.ANTHROPIC_API_KEY) list.push({ id: 'claude-haiku-5-5', provider: 'anthropic', label: 'claude-haiku-5-5 (Anthropic API)' });
  const preferred = list.findIndex(m => m.id === process.env.ADVISOR_MODEL);
  if (preferred > 0) list.unshift(...list.splice(preferred, 1));
  return list;
}

// The picker id ("nous:google/…") → what callModel needs; unknown ids fall back to the default model.
export function modelConfig(id) {
  const models = advisorModels();
  const m = models.find(x => x.id === id) || models[0];
  return m && { provider: m.provider, model: m.model || m.id };
}

// A model's entry in the provider's catalog (fetched once), or undefined if it isn't listed.
const catalogs = {};
async function catalogEntry({ provider, model }) {
  const api = OPENAI_STYLE[provider];
  if (!api) return;
  catalogs[provider] ??= fetch(`${api.url()}/models`, { signal: AbortSignal.timeout(8000) })
    .then(r => r.json()).then(d => new Map(d.data.map(m => [m.id, m])))
    .catch(() => { delete catalogs[provider]; return new Map(); });
  return (await catalogs[provider]).get(model);
}

// Whether a model takes images. Anthropic's and unlisted models are assumed to; a text-only model
// just gets the request without the frame.
export async function acceptsImages(config) {
  const modes = (await catalogEntry(config))?.architecture?.input_modalities;
  return !modes || modes.includes('image');
}

export function advisorConfig() {
  const models = advisorModels();
  return { provider: models[0]?.provider || null, model: models[0]?.id || null, models };
}

const SYSTEM = `You are an expert photographer helping someone shoot with a camera tethered to a laptop.
You get one live view frame (it previews exposure, so judge brightness from it) plus the current settings and the exact values the camera offers for each.
Suggest settings for the scene the photographer describes. Rules:
- For each setting you change, use one value copied exactly from that setting's "options" list. Omit settings that should stay as they are.
- Settings marked "locked" can't be changed in the current mode; if a locked setting matters, recommend a mode in "mode" (M, A, S or P) and still give the value.
- Keep the advice practical and specific to what you see in the frame (light, subject, background, motion, noise risk).
Reply with JSON only, no prose around it:
{"intent": "<the approach in one short line, at most 12 words, e.g. 'Open up and lift ISO to keep it handheld'>", "scene": "<one or two sentences on the light and subject you see>", "mode": "<M|A|S|P or empty>", "settings": {"<setting>": "<option>", ...}, "reasons": {"<setting>": "<short why>"}, "tips": ["<short tip>", ...]}`;

function describeSettings(props) {
  const lines = [];
  const mode = Object.values(props).find(p => p.name === 'mode');
  if (mode) lines.push(`mode: ${fmt('mode', mode.value)} (set on the camera's dial)`);
  for (const name of ADJUSTABLE) {
    const p = Object.values(props).find(q => q.name === name);
    if (!p) continue;
    const options = p.values?.length ? p.values.map(v => fmt(name, v)) : [];
    lines.push(`${name}: current ${fmt(name, p.value)}${p.writable ? '' : ' [locked]'}${options.length ? `; options: ${JSON.stringify(options)}` : ''}`);
  }
  return lines.join('\n');
}

// `jpeg` is optional: without a frame the model only gets the text.
export async function callModel({ provider, model }, system, text, jpeg, maxTokens = 1200) {
  const b64 = jpeg?.toString('base64');
  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: maxTokens, system,
        messages: [{ role: 'user', content: [
          ...(b64 ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }] : []),
          { type: 'text', text },
        ] }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Anthropic: ${data.error?.message || res.statusText}`);
    return data.content.filter(c => c.type === 'text').map(c => c.text).join('');
  }
  const api = OPENAI_STYLE[provider] || OPENAI_STYLE.openrouter;
  // Reasoning models (e.g. DeepSeek) otherwise spend the whole token budget thinking before they answer;
  // the ones that can't turn it off (Sonnet 5.5, Gemini 3.8 Flash…) reject that, so they think briefly instead.
  const reasoning = (await catalogEntry({ provider, model }))?.reasoning?.mandatory ? { effort: 'low' } : { enabled: false };
  const res = await fetch(`${api.url()}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env[api.key]}`, 'x-title': 'Nikon Remote' },
    body: JSON.stringify({
      model, max_tokens: 4000, reasoning,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: [
          ...(b64 ? [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }] : []),
          { type: 'text', text },
        ] },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`${api.name}: ${data.error?.message || data.message || res.statusText}`);
  const choice = data.choices?.[0];
  if (!choice?.message?.content && choice?.finish_reason === 'length') throw new Error(`${model} ran out of tokens before answering — try again or pick another model`);
  return choice?.message?.content || '';
}

export function parseJson(text) {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error('The model didn\'t return settings — try again');
  try { return JSON.parse(m[0]); } catch { throw new Error('Couldn\'t read the model\'s reply — try again'); }
}

// Match the model's label (e.g. "f/2.8", "1/125", "ISO 3200") back to the camera's raw value.
const norm = s => String(s).toLowerCase().replace(/[\s×]/g, '').replace(/−/g, '-').replace(/″/g, '"');

export async function advise(camera, { scene, notes = '', model }) {
  const models = advisorModels();
  if (!models.length) throw new Error('Set NOUS_API_KEY (or OPENROUTER_API_KEY / ANTHROPIC_API_KEY) in .env to use the advisor');
  const config = modelConfig(model);
  if (!camera.connected) throw new Error('Camera not connected');
  if (!camera.liveView || !camera.frame) throw new Error('Turn on live view so the advisor can see the scene');

  const jpeg = Buffer.from(camera.frame);
  const text = [
    `Scene: ${SCENES[scene] || scene || 'General photography'}`,
    notes && `Photographer's notes: ${notes}`,
    `Camera: ${camera.info?.manufacturer || ''} ${camera.info?.model || ''}`,
    `Current settings:\n${describeSettings(camera.props)}`,
  ].filter(Boolean).join('\n\n');

  const reply = parseJson(await callModel(config, SYSTEM, text, jpeg));
  const settings = [];
  for (const [name, label] of Object.entries(reply.settings || {})) {
    const code = +Object.keys(PROPS).find(c => PROPS[c] === name);
    const p = camera.props[code];
    if (!p || !ADJUSTABLE.includes(name)) continue;
    const value = p.values?.find(v => norm(fmt(name, v)) === norm(label));
    if (value === undefined) continue; // not an option this camera offers
    settings.push({
      code, name, label: LABEL[name] || name, value, display: fmt(name, value),
      current: fmt(name, p.value), same: value === p.value, writable: p.writable, reason: reply.reasons?.[name] || '',
    });
  }
  return {
    model: config.model, intent: reply.intent || reply.summary || '', scene: reply.scene || '', mode: reply.mode || '',
    settings, tips: Array.isArray(reply.tips) ? reply.tips.slice(0, 6) : [],
  };
}

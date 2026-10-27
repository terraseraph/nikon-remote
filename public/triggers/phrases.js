// Every command phrase spelled out, for the offline engines that listen for a fixed list (Windows,
// Vosk). `say` is how it's spoken, `means` is the text handed to parseCommand. Keep in step with
// COMMANDS in voice.js. Reference photo requests are free text and aren't listed here.
// Plain module: the server imports it too.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

export function words(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred` + (n % 100 ? ` ${words(n % 100)}` : '');
  return `${words(Math.floor(n / 1000))} thousand` + (n % 1000 ? ` ${words(n % 1000)}` : '');
}

// ISO is said several ways: "sixteen hundred" as well as "one thousand six hundred", "one twenty five".
function isoSayings(n) {
  const s = [words(n)];
  if (n > 1000 && n < 10000 && n % 100 === 0 && n % 1000) s.push(`${words(n / 100)} hundred`);
  if (n > 100 && n < 1000 && n % 100) s.push(`${ONES[Math.floor(n / 100)]} ${words(n % 100)}`);
  return s;
}

const ISOS = [50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200,
  4000, 5000, 6400, 8000, 10000, 12800, 16000, 20000, 25600, 51200];

const SIMPLE = [
  'shoot', 'capture', 'cheese', 'snap', 'take a picture', 'take a photo', 'take a shot',
  'focus', 'auto focus', 'brighter', 'darker', 'more exposure', 'less exposure',
  'cancel', 'stop', 'never mind', 'start recording', 'record video', 'action', 'stop recording', 'cut',
  'start time lapse', 'stop time lapse', 'zoom in', 'zoom out', 'live view on', 'live view off',
  'suggest settings', 'apply settings', 'next', 'another one', 'previous', 'go back', 'bigger', 'smaller',
  'close inspo', 'match pose', 'pin that', 'unpin', 'iso up', 'iso down', 'burst',
];

export function voicePhrases() {
  const out = SIMPLE.map(say => ({ say, means: say }));
  const add = say => out.push({ say, means: say }); // number words are fine: parseCommand reads them
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 30]) { add(`timer ${words(n)}`); add(`in ${words(n)} seconds`); }
  for (let n = 2; n <= 10; n++) { add(`burst ${words(n)}`); add(`${words(n)} shots`); }
  for (let n = 1; n <= 9; n++) { add(`preset ${words(n)}`); add(`use preset ${words(n)}`); }
  for (const iso of ISOS) for (const say of isoSayings(iso)) out.push({ say: `iso ${say}`, means: `iso ${iso}` });
  return out;
}

// Free-text requests start with one of these; the engine hears the rest as dictation.
export const FREE_TEXT = ['inspo', 'show me'];

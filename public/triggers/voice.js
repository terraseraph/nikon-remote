// Voice commands via the browser's Web Speech API (Chrome / Edge).
// Note: those browsers send the audio to their own cloud speech service for recognition.

const NUMBERS = { one: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30 };
const num = w => (w == null ? NaN : /^\d+$/.test(w) ? +w : NUMBERS[w] ?? NaN);
const N = '(\\d+|' + Object.keys(NUMBERS).join('|') + ')';

// Ordered: first match wins. Each returns [label, (actions) => void].
const COMMANDS = [
  [/\b(start|begin) (a |the )?time ?lapse\b/, () => ['Start time-lapse', a => a.timelapse(true)]],
  [/\b(stop|end) (the )?time ?lapse\b/, () => ['Stop time-lapse', a => a.timelapse(false)]],
  [/\b(stop|end|finish) (the )?(recording|video|filming)\b|\bcut\b/, () => ['Stop recording', a => a.record(false)]],
  [/\b(start )?(recording|record( a)? video|filming|action)\b/, () => ['Start recording', a => a.record(true)]],
  [/\b(apply|use) (the |those |these )?(suggested )?(settings|suggestions)\b/, () => ['Apply suggestions', a => a.applyAdvice()]],
  [/\b(suggest|recommend) (some |the )?settings\b|\bwhat settings\b/, () => ['Suggest settings', a => a.advise()]],
  [/\bzoom in\b/, () => ['Zoom in', a => a.zoom('in')]],
  [/\bzoom out\b/, () => ['Zoom out', a => a.zoom('out')]],
  [/\b(stop|cancel|abort|never ?mind)\b/, () => ['Cancel', a => a.cancel()]],
  [/\blive ?view (on|off)\b/, m => [`Live view ${m[1]}`, a => a.liveView(m[1] === 'on')]],
  [new RegExp(`\\b(?:timer|in|wait) ${N}(?: seconds?)?\\b`), m => [`Timer ${num(m[1])} s`, a => a.timer(Math.min(30, num(m[1])))]],
  [new RegExp(`\\b(?:burst(?: of)? ${N}|${N} (?:shots|photos|pictures|frames))\\b`), m => {
    const n = Math.min(20, num(m[1] ?? m[2]));
    return [`Burst ×${n}`, a => a.burst(n)];
  }],
  [/\bburst\b/, () => ['Burst ×3', a => a.burst(3)]],
  [/\biso (up|higher|increase)\b/, () => ['ISO up', a => a.isoUp()]],
  [/\biso (down|lower|decrease)\b/, () => ['ISO down', a => a.isoDown()]],
  [/\biso (\d{2,5})\b/, m => [`ISO ${m[1]}`, a => a.iso(+m[1])]],
  [/\b(brighter|lighter|more exposure)\b/, () => ['Brighter (+EV)', a => a.brighter()]],
  [/\b(darker|less exposure)\b/, () => ['Darker (−EV)', a => a.darker()]],
  [/\b(focus|auto ?focus)\b/, () => ['Focus', a => a.focus()]],
  [/\b(shoot|capture|snap|cheese|fire|click|take (a |the )?(photo|picture|pic|shot))\b/, () => ['Shoot', a => a.shoot()]],
];

// What the on-screen guide and the Triggers tab list. Keep in step with COMMANDS above;
// `key` ones are the short list shown over the live view.
export const VOICE_HELP = [
  { say: 'shoot', also: ['capture', 'cheese', 'take a picture'], does: 'Take a photo', key: true },
  { say: 'timer five', also: ['in ten seconds'], does: 'Self-timer', key: true },
  { say: 'burst three', also: ['five shots'], does: 'Several shots', key: true },
  { say: 'focus', does: 'Autofocus', key: true },
  { say: 'brighter', also: ['darker'], does: 'Exposure ±', key: true },
  { say: 'ISO up', also: ['ISO down', 'ISO 800'], does: 'Change ISO' },
  { say: 'start recording', also: ['action'], does: 'Start video' },
  { say: 'stop recording', also: ['cut'], does: 'Stop video' },
  { say: 'start time-lapse', also: ['stop time-lapse'], does: 'Time-lapse' },
  { say: 'zoom in', also: ['zoom out'], does: 'Magnify live view' },
  { say: 'live view on', also: ['live view off'], does: 'Live view' },
  { say: 'suggest settings', also: ['apply settings'], does: 'Shot advisor' },
  { say: 'cancel', also: ['stop'], does: 'Stop what’s running', key: true },
];

export function parseCommand(text) {
  const t = text.toLowerCase().replace(/[.,!?]/g, '').replace(/-/g, ' ').trim();
  for (const [re, make] of COMMANDS) {
    const m = t.match(re);
    if (m) return make(m);
  }
  return null;
}

export class VoiceTrigger {
  constructor({ actions, onHeard }) {
    this.actions = actions;
    this.onHeard = onHeard;
    this.active = false;
  }

  start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return Promise.reject(new Error('Voice needs Chrome or Edge (this browser has no speech recognition)'));
    this.active = true;
    this.rec = new SR();
    this.rec.continuous = true;
    this.rec.interimResults = false;
    this.rec.lang = navigator.language || 'en-AU';
    this.rec.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue;
        const text = e.results[i][0].transcript.trim();
        const cmd = parseCommand(text);
        this.onHeard(text, cmd?.[0]);
        cmd?.[1](this.actions);
      }
    };
    // Chrome ends continuous recognition after silence; keep it alive while enabled.
    this.rec.onend = () => { if (this.active) setTimeout(() => this.active && this.rec.start(), 200); };
    return new Promise((resolve, reject) => {
      this.rec.onstart = () => resolve();
      this.rec.onerror = e => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          this.stop();
          reject(new Error('Microphone permission was blocked for this page'));
        } else if (e.error === 'network') {
          this.stop();
          reject(new Error('Voice recognition needs an internet connection'));
        }
      };
      this.rec.start();
    });
  }

  stop() {
    this.active = false;
    try { this.rec?.stop(); } catch {}
  }
}

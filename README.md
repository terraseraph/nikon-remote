# local_camera_nikon

A browser remote for a USB-connected Nikon camera, built and tested on a **Nikon Z50II**.
It runs entirely on your own machine with no drivers or installs beyond Node and one small pure-JavaScript package.

- **Live view** in the browser at 1024px, showing the camera's focus box
- **Tap to focus:** tap anywhere on the live view to move the AF point there and focus
- **Zoom** 2× or 3× around the focus point, to check framing and sharpness
- **Phone remote:** scan a QR code and use your phone on the same Wi-Fi as the remote
- **Shutter** with a delay timer, bursts and autofocus-before-shot
- **Video recording:** start and stop by button, R key, voice ("action" / "cut") or gesture
- **Exposure controls:** aperture, shutter, ISO, exposure comp, white balance, metering, quality and size.
  What's writable depends on the mode dial: everything in **M**, partial in P/A/S.
- **Auto-download:** every shot, including ones taken with the camera's own button, is copied into `Pictures/Nikon Remote/YYYY-MM-DD/` and shown in the gallery strip
- **Voice commands:** "shoot", "timer five", "burst three", "focus", "brighter", "ISO 800", "cancel", …
- **Hand gestures:** watches the Nikon's own live view (or your webcam). ✋ palm = 3 s timer, ✌️ = shoot, 👍 = timer + 3 shots, ✊ = cancel, ☝️ = focus. Each gesture can be remapped in the app.
- **Clap to shoot**, offline, with a sensitivity slider
- **Time-lapse**, a rule-of-thirds grid, countdown beeps and keyboard shortcuts

## Run it

1. Plug the camera in over USB-C and switch it on.
2. Install once, then start the server:
   ```bash
   npm install
   ```
   ```bash
   npm start
   ```
3. Open **http://localhost:8765/** in **Chrome or Edge**. Those are needed for voice; everything else works in any modern browser.

Close Nikon NX Tether, SnapBridge for Windows, or anything else that grabs the camera first: only one app can talk to it at a time.

### From your phone

Click **📱 Phone** in the app on the laptop and scan the QR code with a phone on the same Wi-Fi.

- The code carries a private access key. The phone keeps it as a cookie, so you only scan once.
- Requests from other devices without the key are refused. Delete `.remote-key` and restart to issue a new key and lock out every phone that has scanned before.
- The first time, Windows may ask to let Node through the firewall. Allow it on **Private** networks.
- Phones only allow microphone and camera access over https, so voice, clap and webcam gestures stay on the laptop. Gestures that watch the Nikon's own live view do work on the phone.
- Run with `LAN=0` to keep the server reachable from the laptop only.

### From anywhere (Cloudflare Tunnel)

To use the phone on mobile data or another network, switch on **Share over the internet** in the 📱 Phone dialog. This starts [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), which gives you a public https address with no bandwidth cap. Because the address is https, voice and clap work on the phone too. You still need to scan the QR code, which carries the access key: visitors without the key are refused, the same as on Wi-Fi.

Install it once:

```bash
winget install Cloudflare.cloudflared
```

With nothing else set up, the app starts a **quick tunnel** on a random `trycloudflare.com` address that changes every time. Quick tunnels hold back server-sent events, so when the live event stream stays silent for 5 seconds the app polls `/api/state` every second and `/api/photos` every 3 seconds instead. Cloudflare doesn't guarantee uptime for quick tunnels, and the address changes every time, so scan the new QR code after each start.

Live view over the tunnel works differently from the laptop's stream, so it stays current on a slow home upload:

- The phone **pulls** frames (`/api/liveview.jpg`) with four requests in flight, instead of receiving a pushed stream. A pushed stream piles up in Cloudflare's buffers and falls seconds behind.
- While anyone is pulling, the camera switches to its **640px** live view. It goes back to 1024px about 3 seconds after they stop.
- Pulled frames are **re-encoded at JPEG quality 60** with [`jpeg-js`](https://www.npmjs.com/package/jpeg-js), which takes them from about 70 KB to about 21 KB.

On a 4.6 Mbit/s upload this gives about 7–8 fps, up from about 1 fps with full-size pushed frames.

For a stable address, set up a **named tunnel** on a domain in your Cloudflare account:

```bash
cloudflared tunnel login
cloudflared tunnel create nikon
cloudflared tunnel route dns nikon camera.example.com
```

Then start the server with `CF_TUNNEL=nikon` and `CF_TUNNEL_URL=https://camera.example.com`. For a second layer of login, add a Cloudflare Access application for that hostname (Zero Trust → Access → Applications) that only allows your email address.

The tunnel stops when you switch it off or stop the server. The on/off switch and the link are only shown on the laptop.

### Video

The Z50II only records when its **photo/video switch** is on video. If it isn't, the app says so. Clips are downloaded into `captures/` like photos once you stop recording. Large clips pause live view for a few seconds while they copy.

### Shot advisor (AI)

Pick what you're shooting (low-light boudoir, outdoor portrait, action, landscape…), add optional notes, and press **Suggest settings** (or **A**, or say "suggest settings"). The app sends the current live view frame and the camera's settings to a vision model. The model suggests an aperture, shutter speed, ISO, exposure compensation, white balance, metering, focus mode and quality, choosing only values your camera offers. It also explains why and adds a few tips. **Apply** (or saying "apply settings") sets them on the camera. If the mode dial blocks a setting (for example, shutter speed in A mode), the app strikes it out and suggests a mode instead.

To enable it, create a `.env` file next to `package.json`, then restart the server:

```
OPENROUTER_API_KEY=sk-or-...
# optional: which model the picker starts on
ADVISOR_MODEL=anthropic/claude-haiku-5.5
```

The **Model** picker on the card switches between Claude Haiku 5.5, DeepSeek V4.1 Flash and Gemini 3.1 Flash Lite, all through OpenRouter. To offer other image-capable models, set `ADVISOR_MODELS` to a comma-separated list of OpenRouter model IDs. To also offer Haiku through Anthropic's own API, add `ANTHROPIC_API_KEY`. Each request sends one frame of about 1024px. In testing, a request took 3–8 seconds and cost well under a cent.

### Keyboard

| Key | Action |
| --- | --- |
| Space | Shoot (using the delay/shots/gap settings) |
| F | Autofocus |
| L | Live view on/off |
| G | Grid overlay |
| Z | Zoom 1× → 2× → 3× |
| R | Start/stop video recording |
| A | Ask the shot advisor for settings |
| Click/tap live view | Move focus point there and focus |
| Esc | Cancel countdown / burst / time-lapse |

### Privacy notes

- **Voice** uses the browser's built-in speech recognition. Chrome and Edge send the audio to Google's or Microsoft's speech service.
- **Gestures** run locally in the browser, but the first time you turn them on, the MediaPipe runtime and model download from jsDelivr and Google's model storage.
- **Clap** detection is fully local.
- **Shot advisor** sends the live view frame to OpenRouter (and on to the model provider) or to Anthropic, but only when you press the button. Keep that in mind for private or client sessions.

## How it works

```
browser  ──HTTP/SSE/MJPEG──▶  src/server.js (Node)  ──stdin/stdout JSON──▶  bridge/camera-bridge.ps1  ──WPD/PTP──▶  camera
```

- `bridge/camera-bridge.ps1` is a long-running PowerShell process. Its inline C# sends raw PTP operations through the Windows Portable Devices API (`WPD_COMMAND_MTP_EXT_*`), including data-in and data-out phases. Windows already has a driver for the camera, so nothing extra is installed.
- `src/ptp.js` holds the PTP and Nikon opcodes plus binary dataset parsing (DeviceInfo, DevicePropDesc, ObjectInfo, Nikon CheckEvent).
- `src/camera.js` handles the connection lifecycle and auto-reconnect, the live view loop (Nikon `0x9201`/`0x9203`), capture (`0x9207` in live view, otherwise `0x100E`), property get/set, and the event poll that auto-downloads new photos.
- `src/server.js` exposes the JSON API, the SSE event stream, the MJPEG live view and static files.
- `public/` holds the app: `app.js` for the UI and shooting sequences, `liveview.js` for the MJPEG-to-canvas reader, and `triggers/` for voice, gestures and clap.

`npm run probe` dumps every operation, event and property the connected camera supports, which is handy for adding new controls.

### API

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/state` | |
| GET | `/api/events` | SSE: `state`, `prop`, `photo`, `shot`, `log` |
| GET | `/api/liveview.mjpg` | |
| GET | `/api/liveview.jpg?after=N` | Next frame newer than `N`, re-encoded smaller; `X-Seq` and `X-AF` headers |
| GET | `/api/photos` | |
| POST | `/api/shoot` | `{ "af": true }` |
| POST | `/api/af` | |
| POST | `/api/focus-point` | `{ "x": 0.3, "y": 0.5, "focus": true }` (fractions of the frame) |
| POST | `/api/movie` | `{ "on": true }` |
| GET | `/api/remote` | Phone QR URLs and tunnel status (laptop only) |
| POST | `/api/tunnel` | `{ "on": true }` (laptop only) |
| POST | `/api/liveview` | `{ "on": true }` |
| POST | `/api/prop` | `{ "code": 20495, "value": 800 }` |
| POST | `/api/prop/step` | `{ "code": 20495, "delta": 1 }` |
| GET | `/api/advisor` | Advisor provider, model and scene list |
| POST | `/api/advise` | `{ "scene": "boudoir", "notes": "handheld" }` |
| POST | `/api/reconnect` | |

Environment variables: `PORT` (default 8765), `CAPTURES_DIR` (default `Pictures/Nikon Remote`, following OneDrive redirection on Windows), `LAN` (set to `0` for laptop-only access), and for the Cloudflare tunnel `CF_TUNNEL` (named tunnel), `CF_TUNNEL_URL` (its public address) and `CLOUDFLARED` (path to the binary if it isn't found automatically).

## Known limits

- Windows only, since the bridge uses WPD. Other Nikon Z / DSLR bodies will probably work because they share the same PTP extensions, but only the Z50II has been tested.
- Image-quality labels follow Nikon's usual numbering. Codes the app doesn't recognise show as "Quality N".
- Live view keeps the camera's sensor running, so it uses more battery. Turn it off (L) when you don't need it.
- Zoom is a digital magnifier on the 1024px live feed. The Z50II doesn't expose its in-camera magnification over USB, so this isn't a true 100% pixel view.

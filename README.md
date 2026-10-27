# Nikon Remote

[![Release](https://github.com/terraseraph/nikon-remote/actions/workflows/release.yml/badge.svg)](https://github.com/terraseraph/nikon-remote/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/terraseraph/nikon-remote)](https://github.com/terraseraph/nikon-remote/releases/latest)

**Download for Windows:** [Installer](https://github.com/terraseraph/nikon-remote/releases/latest/download/Nikon-Remote-Setup.exe) · [Portable .exe](https://github.com/terraseraph/nikon-remote/releases/latest/download/Nikon-Remote-Portable.exe) · [All releases](https://github.com/terraseraph/nikon-remote/releases)

A USB remote for your camera that runs on your own Windows PC: live view, full exposure control, an AI shot assistant, reference-photo posing guides, and hands-free triggers by voice, gesture or clap. Use it in its own **desktop window**, in **Chrome or Edge**, or from your **phone** over Wi-Fi or the internet.

Built and tested on a **Nikon Z50II**, with experimental support for **Canon EOS**, **Sony Alpha** and other PTP cameras (see [Supported cameras](#supported-cameras)). No camera drivers, SDKs or vendor software needed: it talks to the camera over the PTP driver that Windows already has.

## Features

### Camera control
- **Live view** at 1024px with the camera's focus box drawn on top
- **Tap to focus:** tap anywhere on the live view to move the AF point there and focus
- **Zoom** 2× or 3× around the focus point to check framing and sharpness
- **Rotate and flip** the preview for odd mounting angles or mirrored selfie framing
- **Exposure controls:** aperture, shutter, ISO, exposure compensation, white balance, metering, focus mode, image quality and size. What's writable follows the mode dial: everything in **M**, partial in P/A/S.
- **Video recording:** start and stop by button, key, voice ("action" / "cut") or gesture
- **Auto-download:** every shot, including ones taken with the camera's own shutter button, is copied to `Pictures/Nikon Remote/YYYY-MM-DD/` and shown in the gallery strip

### Shooting
- **Shutter** with delay timer, bursts and autofocus-before-shot
- **Shooting presets:** numbered routines of steps ("wait 3 s, then take 3 shots 0.5 s apart"), repeated a set number of times or until cancelled. Presets are shared live across every open device.
- **Ready chime** just before each shot so your subject knows when to hold still
- **Time-lapse**, rule-of-thirds grid, countdown beeps and keyboard shortcuts

### AI assistance (optional, bring your own key)
- **Shot assist:** pick a scene (portrait, low-light, action, landscape…) and conditions (handheld, tripod, moody…). **Use preset settings** works without any key: it picks sensible generic aperture, shutter, ISO, EV, white balance, metering and focus for that kind of shot, recommends a mode, and explains what each change does. **Ask AI** goes further: a vision model looks at the live view frame (plus any notes you add) and tunes the settings to the exact scene. Either way only values your camera offers are used, suggestions appear right on the exposure controls (old → new), and one **Apply** sets them all. Settings the mode dial blocks are queued and applied as soon as you turn the dial.
- **Inspo:** say or type what you're after ("moody couple pose against a wall") and get real reference photos from Pexels, Unsplash or Google Images shown over the live view. Nothing is AI-generated.
- **Pose matching:** pin a reference photo and its pose is drawn as a ghost skeleton on the person in frame, with a live match score and hints like "raise left arm".
- Works with **Nous Portal**, **OpenRouter** or **Anthropic** models. A dozen vision models to choose from in the app.

### Hands-free triggers
- **Voice commands:** "shoot", "timer five", "burst three", "focus", "brighter", "ISO 800", "preset two", "suggest settings", "inspo for golden hour portraits", "next", "match pose", "cancel"…
- **Hand gestures:** watches the Nikon's own live view (or your webcam). ✋ palm = 3 s timer, ✌️ = shoot, 👍 = timer + 3 shots, ✊ = cancel, ☝️ = focus. Each gesture can be remapped.
- **Clap to shoot**, fully offline, with a sensitivity slider

### Remote access
- **Phone remote:** scan a QR code and use your phone as the remote on the same Wi-Fi. Access is protected by a private key carried in the QR code.
- **From anywhere:** one switch starts a Cloudflare Tunnel for a public https address, so the phone works on mobile data too. Live view is tuned for slow uploads (about 7–8 fps on a 4.6 Mbit/s connection).

## Supported cameras

The app identifies the camera from what it reports over USB and picks a driver for it. The connection bar shows the brand and model, and "(experimental)" for anything untested.

| Camera | Status | What works |
| --- | --- | --- |
| **Nikon** Z and DSLR bodies | **Tested** on a Z50II | Everything |
| **Canon EOS** DSLRs and R-series | Experimental, untested | Settings, shutter, autofocus, live view, video (in movie mode), auto-download. No tap-to-focus or focus box yet. |
| **Sony Alpha** in PC Remote mode | Experimental, untested | Settings, shutter, autofocus, live view, video, auto-download. No tap-to-focus or focus box yet. |
| **Fujifilm, OM System / Olympus, Panasonic, Pentax, Leica, Sigma** and other PTP cameras | Experimental, untested | Standard PTP: settings, shutter and auto-download. No live view, so no shot assist, pose matching or live view gestures. |

The Canon and Sony drivers follow those brands' USB protocols as documented by the [libgphoto2](https://github.com/gphoto/libgphoto2) project, and `npm test` checks them against simulated cameras, but nobody has run them on real hardware yet. If you have one of these cameras, an issue saying what worked and what didn't (with the output of `npm run probe`) would help a lot.

Camera setup tips:

- **Canon:** set the camera's Wi-Fi off; USB control doesn't work while Wi-Fi is on.
- **Sony:** set **USB Connection** to **PC Remote** in the camera's menu.
- **Fujifilm:** set **Connection Setting › PC Connection Mode** to **USB Tether Shooting**.

Brand drivers live in `src/drivers/`. Each one translates its camera's settings into the same codes and units, so the UI, voice commands and shot assist don't need to know which camera is connected.

## Getting started

### Download the desktop app

The quickest way: download the latest build for Windows 10 or 11, no Node.js needed.

- [**Nikon-Remote-Setup.exe**](https://github.com/terraseraph/nikon-remote/releases/latest/download/Nikon-Remote-Setup.exe): installer with a Start menu shortcut and uninstaller
- [**Nikon-Remote-Portable.exe**](https://github.com/terraseraph/nikon-remote/releases/latest/download/Nikon-Remote-Portable.exe): a single file that runs without installing

The builds aren't code-signed yet, so Windows SmartScreen may warn the first time: choose **More info › Run anyway**. Every push to `main` rebuilds them with [GitHub Actions](.github/workflows/release.yml), and bumping `version` in `package.json` starts a new release.

To turn on the AI features, add your API keys in the app under **More › AI** (see [Setting up the AI features](#setting-up-the-ai-features)).

### Run from source

**Requirements:** Windows 10 or 11, [Node.js 20+](https://nodejs.org/), and a camera on USB.

```bash
git clone https://github.com/terraseraph/nikon-remote.git
```

```bash
cd nikon-remote
```

```bash
npm install
```

Plug the camera in over USB, switch it on, then pick one of the two ways to run it.

> Close Nikon NX Tether, SnapBridge, Canon EOS Utility, Sony Imaging Edge, Lightroom tethering, or anything else that grabs the camera first. Only one app can talk to it at a time.

#### As a desktop app

```bash
npm run app
```

Opens Nikon Remote in its own window, with the camera server running inside it. Phones can still connect to it as usual.

To build an installer and a portable `.exe` into `dist/`:

```bash
npm run dist
```

In the desktop app, keys, presets and thumbnails are stored in `%APPDATA%\Nikon Remote`; a `.env` there is read too. If an `npm start` server is already running, the window uses it instead of starting a second one.

Voice commands need Chrome's or Edge's speech service, which Electron doesn't include. Use **View › Open in browser** (Ctrl+B) to open the same session in your browser when you want voice. Everything else, including clap and gestures, works in the desktop window.

#### In the browser

```bash
npm start
```

Then open **http://localhost:8765/** in **Chrome or Edge**. Those are needed for voice; everything else works in any modern browser.

## Setting up the AI features

Everything works without any keys, including shot assist's scene presets; only its Ask AI button and inspo are switched off. To enable them, open **More › AI** in the app on the PC, paste the keys you have and press **Save keys**. They take effect straight away, on the phone too. Each key has a **Get a key** link to the provider's sign-up page, and most have a **Test** button that checks the key with the provider.

| Feature | Keys (any one is enough) |
| --- | --- |
| Shot assist | [Nous Portal](https://portal.nousresearch.com), [OpenRouter](https://openrouter.ai/keys) or [Anthropic](https://console.anthropic.com/settings/keys) |
| Inspo photo search | [Pexels](https://www.pexels.com/api/), [Unsplash](https://unsplash.com/developers) or [Serper](https://serper.dev) (Google Images) |

Keys are stored only on the PC, in `settings.json` in the data folder (`%APPDATA%\Nikon Remote` for the desktop app, next to `package.json` when run from source). The app never sends them back to the page, only their last four characters, and phones can't see or change them.

You can also keep keys in a `.env` file in the same folder: copy [`.env.example`](.env.example), fill in `NOUS_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY` or `SERPER_API_KEY`, and restart. A key saved in the app wins over the `.env` one; clearing it in the app falls back to the `.env` value.

Inspo also uses the shot assist model, when one is configured, to turn your request into better searches and a one-line posing cue.

Press **✦** (or **A**) for shot assist, or say "suggest settings" (Ask AI when it's set up and live view is on, the scene preset otherwise), and **Inspo** (or **I**, or say "inspo for …") for reference photos. An Ask AI request sends one ~1024px frame and typically takes 3–8 seconds and well under a cent.

## Using your phone

Click **📱 Phone** in the app on the PC and scan the QR code with a phone on the same Wi-Fi.

- The QR code carries a private access key. The phone keeps it as a cookie, so you only scan once.
- Requests from other devices without the key are refused. Delete `.remote-key` and restart to issue a new key and lock out every phone that scanned before.
- The first time, Windows may ask to let Node (or Nikon Remote) through the firewall. Allow it on **Private** networks.
- Phones only allow microphone and camera access over https, so on Wi-Fi, voice, clap and webcam gestures stay on the PC. Gestures that watch the Nikon's own live view work on the phone.
- Set `LAN=0` to keep the server reachable from the PC only.

### From anywhere (Cloudflare Tunnel)

Switch on **Share over the internet** in the 📱 Phone dialog. This starts [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) and gives you a public https address, so voice and clap work on the phone too. Visitors still need the access key from the QR code.

Install `cloudflared` once:

```bash
winget install Cloudflare.cloudflared
```

With no other setup you get a **quick tunnel** on a random `trycloudflare.com` address that changes on every start, so scan the new QR code each time. For a stable address, create a **named tunnel** on your own domain:

```bash
cloudflared tunnel login
```

```bash
cloudflared tunnel create nikon
```

```bash
cloudflared tunnel route dns nikon camera.example.com
```

Then set `CF_TUNNEL=nikon` and `CF_TUNNEL_URL=https://camera.example.com`. For a second login layer, add a Cloudflare Access application for that hostname that only allows your email address.

Over the tunnel the phone pulls live view frames instead of receiving a pushed stream, the camera drops to 640px live view, and frames are re-encoded at JPEG quality 60 (about 70 KB → 21 KB). That keeps live view current on a slow home upload.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Shoot (using the current drive mode or preset) |
| F | Autofocus |
| L | Live view on/off |
| G | Grid overlay |
| Z | Zoom 1× → 2× → 3× |
| O | Rotate preview |
| H | Flip preview |
| R | Start/stop video recording |
| A | Shot assist |
| I | Inspo panel |
| [ / ] | Previous / next reference photo |
| M | More settings |
| Click/tap live view | Move focus point there and focus |
| Esc | Cancel countdown, burst, preset or time-lapse |

## Notes

### Video

The Z50II only records when its **photo/video switch** is on video; the app tells you if it isn't. Clips download like photos once you stop recording, and large clips pause live view for a few seconds while they copy.

### Privacy

- **Voice** uses the browser's built-in speech recognition. Chrome and Edge send the audio to Google's or Microsoft's speech service.
- **Gestures and pose matching** run locally in the browser, but the MediaPipe runtime and models download from jsDelivr and Google's model storage the first time.
- **Clap** detection is fully local.
- **Shot assist and inspo** send the live view frame to your chosen AI provider, and search terms to the photo services, only when you ask. Keep that in mind for private or client sessions.

### Known limits

- **Windows only**, since the camera bridge uses Windows Portable Devices.
- Only the **Nikon Z50II** has been tested. Other Nikon Z and DSLR bodies share the same PTP extensions and will probably work; other brands are experimental (see [Supported cameras](#supported-cameras)). `npm run probe` lists everything a connected camera supports.
- Live view keeps the sensor running and uses more battery. Turn it off (L) when you don't need it.
- Zoom is a digital magnifier on the 1024px live feed, not a true 100% view; the Z50II doesn't expose in-camera magnification over USB.

## How it works

```
browser / Electron window ──HTTP, SSE, MJPEG──▶ src/server.js (Node) ──JSON over stdio──▶ bridge/camera-bridge.ps1 ──WPD / PTP──▶ camera
```

- `bridge/camera-bridge.ps1` is a long-running PowerShell process whose inline C# sends raw PTP operations through the Windows Portable Devices API (`WPD_COMMAND_MTP_EXT_*`), including data-in and data-out phases.
- `src/ptp.js` holds the PTP and Nikon opcodes and parses binary datasets (DeviceInfo, DevicePropDesc, ObjectInfo, Nikon CheckEvent).
- `src/camera.js` handles connection and auto-reconnect, the live view loop, the frame stream for viewers, and auto-downloading new photos. It picks a driver from `src/drivers/` for everything brand-specific:
  - `ptp.js`: standard PTP, the base for the others and the fallback for unknown cameras
  - `nikon.js`: Nikon live view (`0x9201`/`0x9203`), capture (`0x9207` in live view), AF, tap-to-focus, video and `CheckEvent`
  - `canon.js`: Canon EOS remote mode, `GetEvent` settings and downloads, viewfinder data, release on/off
  - `sony.js`: Sony SDIO handshake, button-style controls, in-memory captures and live view handles
- `src/server.js` serves the JSON API, the SSE event stream, MJPEG live view and the app itself. `src/advisor.js` and `src/inspo.js` handle the AI features and photo search; `src/tunnel.js` runs `cloudflared`.
- `electron/main.js` runs the same server inside Electron and opens it in a window.
- `public/` is the app: `app.js` for the UI and shooting sequences, `scenes.js` for the shot assist scene presets, `liveview.js` for the MJPEG-to-canvas reader, `inspo.js` and `pose.js` for references and pose matching, and `triggers/` for voice, gestures and clap.

### API

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/state` | |
| GET | `/api/events` | SSE: `state`, `prop`, `photo`, `shot`, `log`, `presets`, `config` (API keys changed) |
| GET | `/api/liveview.mjpg` | |
| GET | `/api/liveview.jpg?after=N` | Next frame newer than `N`, re-encoded smaller; `X-Seq` and `X-AF` headers |
| GET | `/api/photos` | |
| POST | `/api/shoot` | `{ "af": true }` |
| POST | `/api/af` | |
| POST | `/api/focus-point` | `{ "x": 0.3, "y": 0.5, "focus": true }` (fractions of the frame) |
| POST | `/api/movie` | `{ "on": true }` |
| POST | `/api/liveview` | `{ "on": true }` |
| POST | `/api/prop` | `{ "code": 20495, "value": 800 }` |
| POST | `/api/prop/step` | `{ "code": 20495, "delta": 1 }` |
| GET / POST | `/api/presets` | `{ "presets": [ … ] }` |
| GET | `/api/advisor` | Shot assist models and scene list |
| POST | `/api/advise` | `{ "scene": "portrait", "notes": "handheld" }` |
| GET / POST | `/api/inspo` | `{ "request": "moody couple pose" }` |
| GET | `/api/remote` | Phone QR URLs and tunnel status (PC only) |
| POST | `/api/tunnel` | `{ "on": true }` (PC only) |
| GET / POST | `/api/settings` | `{ "keys": { "PEXELS_API_KEY": "…" } }`, `""` clears one; returns only set/source/last 4 (PC only) |
| POST | `/api/settings/test` | `{ "name": "OPENROUTER_API_KEY", "value": "…" }` (PC only) |
| POST | `/api/reconnect` | |

### Configuration

API keys are best added in the app (**More › AI**). Everything else is an environment variable, usually set in `.env`. See [`.env.example`](.env.example) for the full list: API keys, `PORT` (default 8765), `LAN`, `CAPTURES_DIR` (default `Pictures/Nikon Remote`, following OneDrive redirection), `DATA_DIR` (where keys, presets and thumbnails are written), and the `CF_TUNNEL*` tunnel settings.

## License

[MIT](LICENSE)

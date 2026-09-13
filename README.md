# AFTERGLIDE

**Your Xbox. Wherever you land.**

Afterglide is an open-source, controller-first Xbox remote-play client designed
for Steam Deck. The current pre-alpha implements the complete desktop path from
Microsoft device-code sign-in through console discovery, wake, xHome session
negotiation, WebRTC video/audio, controller input, rumble, and recovery UI.

> Afterglide is an independent project. It is not affiliated with or endorsed by
> Microsoft, Xbox, Valve, or Steam.

![Afterglide home screen](docs/images/home.png)

## What works

- Microsoft device-code authentication in the system browser
- Refresh-token persistence through the operating system encryption service
- Xbox console discovery, selection, and remote wake
- Xbox xHome provisioning and authenticated SDP/ICE signaling
- H.264 WebRTC video, audio, keepalive, and connection telemetry
- Focused-window gamepad input, keyboard opt-in, and controller rumble
- Controller-first home, setup, settings, diagnostics, error, and recovery flows
- Deterministic Playwright coverage of the real Electron desktop shell

The live protocol is community maintained and can change upstream. A passing
automated suite proves Afterglide's desktop behavior; current service compatibility
still requires a Microsoft account, a remote-play-enabled Xbox, and a live smoke
test. Hardware decode and power targets must be measured on the packaged Steam
Deck build before the first supported release.

## Run it

Use Node.js 24 or newer:

```bash
npm ci
npm run dev
```

Sign in from the opening screen, enter the one-time code on Microsoft's site, and
choose a console. On Xbox, remote features must be enabled under **Settings →
Devices & connections → Remote features**.

The renderer never receives Microsoft or Xbox tokens. Afterglide persists a
refresh token only when Electron reports a real OS encryption backend; Linux's
`basic_text` fallback is rejected and leaves the session in memory only.

## Verify it

```bash
npm run verify
npm run test:e2e
npm audit --audit-level=high
```

The end-to-end suite launches Electron at the Steam Deck's 1280×800 viewport. It
uses an unpackaged-only deterministic adapter and covers first run, authentication,
console selection, controller navigation, connection stages, streaming, settings,
interruption recovery, errors, and retry.

## Build a Linux package

Run this on Linux to produce the Steam Deck artifacts:

```bash
npm run package:linux
```

The output lands in `release/`. AppImage is the current installable format; the
Flatpak gate is documented in [`packaging/flatpak/README.md`](packaging/flatpak/README.md).

## Architecture

```text
React UI + WebRTC + focused controller input
                    │
            sandboxed preload API
                    │
             Electron controller
          ┌─────────┼──────────┐
  Microsoft auth  Smartglass  xHome signaling
          └─────────┼──────────┘
              encrypted store
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/adr/0001-electron-webrtc-desktop.md`](docs/adr/0001-electron-webrtc-desktop.md),
and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Performance gates

| Measure                         | Release gate                                                       |
| ------------------------------- | ------------------------------------------------------------------ |
| Cold launch to interactive home | Under 2 seconds on Steam Deck                                      |
| Interface rendering             | Sustained 60 fps                                                   |
| Client frame loss               | Under 0.5% in a controlled 30-minute session                       |
| Decode path                     | Hardware acceleration verified in the shipped package              |
| Recovery                        | Resume or explain the failure after sleep and network interruption |

These are release gates rather than current hardware claims. Raw device evidence
will be published with the first beta.

## License

MIT. See [`LICENSE`](LICENSE). Xbox protocol behavior is adapted with attribution
from MIT-licensed Greenlight; see the third-party notices.

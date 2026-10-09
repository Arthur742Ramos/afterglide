# Afterglide Cloud

An optional Xbox Cloud Gaming app for Windows and macOS inside [Afterglide](../../README.md), derived from its base at be70e1d62182522c787312dbd8e0b62e6a4534a1. The original app remains separate. Cloud shares unchanged controller/input, network, recovery and performance modules with the root app; its interface, authentication, storage and packaging are isolated.

The first version opens directly to your cloud library: recent games, search, controller navigation, cloud launch, stream controls, bounded reconnect and diagnostics. Console remote play and Steam Deck setup are absent. The priorities are easy installation, a short sign-in-to-play path, dependable controller input and minimal client overhead.

## Run

Use Node 24 or newer. From the repository root, change to `apps/cloud` before running these commands. Install dependencies separately from the root app.

```sh
npm ci
npm run build
npm start
```

Sign in through Microsoft's device-code page. A new sign-in is required because this app uses a separate encrypted credential store. Xbox determines available games, subscription requirements and region eligibility.

To explore without login or a subscription:

```sh
npm run build
npm run start:demo
```

Demo mode is labeled and uses simulated games, video and network measurements. It does not connect to Xbox. The development demo is npm run dev:demo. Packaged builds ignore demo flags.

On Windows, after building, `./Start-Demo.ps1` starts the demo using installed Node. It stores demo preferences separately from the live client. Cloud development uses port 5174; the original app retains port 5173.

### Test from source on a Mac

These commands need validation on your Mac; automated macOS source/mock CI is separate from signed distribution. Use a clean source copy and native Mac Node 24.14.0/npm. That Node release requires macOS 13.5 or newer on both Intel and Apple Silicon ([Node platform requirements](https://github.com/nodejs/node/blob/v24.14.0/BUILDING.md#platform-list)). In Terminal:

```sh
cd afterglide/apps/cloud
node --version
node -p "process.arch"
npm ci
npm run build
npm run start:demo
```

Use `arm64` Node on Apple Silicon and `x64` Node on Intel. Install dependencies on the Mac; do not copy Windows `node_modules` or `.runtime`. `Start-Demo.ps1` is a Windows convenience launcher. The npm demo is configured for ordinary Mac Terminal, uses simulated data and needs no Microsoft sign-in or subscription. Packaged apps ignore demo flags and use the live sign-in flow.

The smallest configured drag-to-Applications build is one DMG, built on a Mac:

```sh
npm run build
npx electron-builder --mac dmg --arm64 --publish never
```

On Intel, use `--x64` instead. The existing `npm run package:mac` builds separate DMG and ZIP files for both architectures. A successful build does not establish that the app launches: the current configuration retains hardened runtime, and normal distribution needs Developer ID signing and notarization. No ready-to-download Mac build is available yet. See [Mac test details and remaining gates](docs/MAC-TESTING.md).

## Controls

- Browse with D-pad, left stick, arrows or Tab. A/Enter selects; activate the selected game again to launch it. The featured Play button launches immediately.
- B/Escape returns from Settings or Health to Library, and exits fullscreen from Library or Welcome.
- Ctrl/Cmd+F opens Library search; Ctrl/Cmd+, opens Settings, including before login. During play, the Settings menu opens local stream controls. Native Edit and zoom commands remain available.
- F11 toggles fullscreen on Windows; Control+Command+F does so on macOS. Outside a stream, the fullscreen bar always offers an exit button.
- During play, L3 + R3 or Escape opens local controls and suspends game input. Menu + View sends Xbox guide. Local controls include fullscreen, audio, fit/fill and leaving the stream.
- F3 toggles measured diagnostics, hidden by default. Settings support per-controller deadzone, trigger, button mapping and rumble preferences.
- Recovery attempts are bounded and pause while offline. Reconnect starts a new Xbox session; game state preservation is not guaranteed.

Xbox negotiates quality. There are no forced bitrate, resolution or latency promises, and no alternate-device impersonation for a quality preset. The overlay reports received resolution, FPS, RTT, loss, bitrate, decoder and frame pacing where available. RTT is a network measure, not input-to-photon latency.

## Verify and package

```sh
npm run verify
npm run test:e2e
npm run package:win
# On a Mac:
npm run package:mac
```

Windows uses a per-user NSIS installer with a Start menu shortcut and no elevation request or automatic desktop shortcut. macOS uses DMG/ZIP for Intel and Apple Silicon, with a configured drag-to-Applications layout. Package commands never publish. Signing, notarization, clean-machine install and native macOS behavior remain release gates. See [implementation boundaries](docs/CLOUD-FIRST.md), [desktop polish and platform gates](docs/DESKTOP-POLISH.md) and [local validation](VALIDATION.md).

This is an alpha source preview. The reviewed dependency changes produce zero npm audit findings; exact advisory paths, exposure and compatibility review are recorded in [dependency triage](docs/DEPENDENCY-TRIAGE.md). Live authentication, hardware and platform distribution gates still require validation.

This independent client is not affiliated with Microsoft or Xbox. Upstream MIT copyright and permission text remain in [LICENSE](LICENSE); attribution remains in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

# Development and implementation details

For the player overview and current download status, start at
[Afterglide Cloud](../README.md). These commands run from `apps/cloud` inside the
complete repository. Cloud shares source modules with the root app; its UI,
credential store and packaging are separate. The base revision is
`be70e1d62182522c787312dbd8e0b62e6a4534a1`.

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
npm run package:mac:local
```

This builds one development DMG for the native Node architecture and never notarizes or publishes. On macOS 27+ it uses the supported folder-to-image command after Electron Builder packaging/signing. The existing `npm run package:mac` builds separate DMG and ZIP files for both architectures. A successful build does not establish that the app launches: the current configuration retains hardened runtime, and normal distribution needs Developer ID signing and notarization. No public Mac binary release is available yet. See [Mac test details and remaining gates](MAC-TESTING.md).

## Controls

See the [DualSense/Xbox compatibility matrix and hands-on gates](CONTROLLER-COMPATIBILITY.md). Local PlayStation prompts describe physical controls; Xbox games retain their own button prompts. Input requires Chromium's standard mapping, and rumble depends on the exposed browser capability. Physical USB/Bluetooth validation remains outstanding.

- Browse with D-pad, left stick, arrows or Tab. A/Enter selects; activate the selected game again to launch it. The featured Play button launches immediately.
- B/Escape returns from Settings or Health to Library, and exits fullscreen from Library or Welcome.
- Ctrl/Cmd+F opens Library search; Ctrl/Cmd+, opens Settings, including before login. During play, the Settings menu opens local stream controls. Native Edit and zoom commands remain available.
- F11 toggles fullscreen on Windows; Control+Command+F does so on macOS. Outside a stream, the fullscreen bar always offers an exit button.
- During play, F10, Escape, Tab or the pointer Controls button opens local controls and suspends game input. L3 + R3 always goes to the game; map a spare controller button or paddle to F10 for controller-only access. Menu + View sends Xbox guide. Local controls include fullscreen, audio, fit/fill and leaving the stream.
- F3 toggles measured diagnostics, hidden by default. Settings support per-controller deadzone, trigger, button mapping and rumble preferences.
- Recovery attempts are bounded and pause while offline. Reconnect starts a new Xbox session; game state preservation is not guaranteed.

Xbox negotiates quality. There are no forced bitrate, resolution or latency promises, and no alternate-device impersonation for a quality preset. The overlay reports received resolution, FPS, RTT, loss, bitrate, decoder and frame pacing where available. RTT is a network measure, not input-to-photon latency.

### Smooth mode and repair diagnostics

Choose **Settings → Stream smoothness → Smooth**, or switch in Quick settings during play. The choice persists and applies without reconnecting. Smooth is the default for new or unmigrated preferences; an explicit Automatic choice is preserved. Defaults retain 1080p, responsive 4 ms input polling, fit-to-window video and a hidden performance overlay. Smooth is experimental: it starts with a 33 ms receiver hint, raises it to 67 or 100 ms after sustained packet loss, receiver drops, freezes or jitter of at least 30 ms, and steps down through 67/33/16 ms after each 15 stable seconds. Stability allows up to 20 ms jitter and 0.5% packet loss with advancing decoded frames and no new receiver drops/freezes. Jitter between 20 and 30 ms holds the level and restarts trend timing. Local presentation drops and high RTT alone do not raise buffering. Unknown measurements and suspended playback return control to the browser. Extra buffering can increase input delay; it cannot restore frames never supplied by the server.

F3 shows measured **BUFFER**, requested **REQUEST**, and retransmitted video packets per second (**RTX**). Health and exported reports also retain cumulative retransmitted bytes/packets, NACK/PLI/FIR feedback counts, receiver frame drops, receiver target/minimum buffer delays, and whether the browser accepted the hint. Acceptance is not achieved delay. Missing counters remain “Not reported”; totals may reset when a receiver is replaced. Reports group Automatic and Smooth samples separately.

For comparison, play the same scene on the same connection in each mode, then export from Health before quitting. Each export saves a uniquely named JSON file to Downloads and shows its full path; previous reports are preserved. Compare freezes, displayed FPS, frame intervals and actual buffering as well as the feel of controller response. Automated tests validate policy and reporting behavior, not improved live gameplay.

Cloud sessions retain Xbox’s default region (or the first offered region if none is marked default). HTTPS service probes remain diagnostics only: live comparisons showed that their DNS/TLS/HTTP timing could select a more distant route with substantially worse gameplay RTT. Even complete scans and large service-time differences do not override the default without validated media-route evidence.

Every launch refreshes three unauthenticated HTTPS HEAD probes per offered region, with six workers, a 1.2-second request limit and a six-second overall limit, for at most 32 distinct regions. Incomplete and unsupported results remain explicit. The probe median in Health belongs to the requested default region. Exported reports retain candidate medians and partial-scan status. Only official regional HTTPS origins are probed, without credentials or redirects.

Session creation is sent only once, avoiding duplicate game sessions after ambiguous failures. Xbox may still assign a different hosting region through fallback. Active-stream ping is the gameplay-route measurement; no claim of globally optimal region selection is made.

See the [performance measurement procedure](PERFORMANCE-CAMPAIGN.md), [operation budgets and cancellation limits](OPERATION-LIMITS.md) and [native/live-stream qualification gates](NATIVE-QUALIFICATION.md) for the evidence required before performance or distribution claims.

## Verify and package

```sh
npm run verify
npm run test:e2e
npm run package:win
# On a Mac:
npm run package:mac
```

Windows uses a per-user NSIS installer with a Start menu shortcut and no elevation request or automatic desktop shortcut. macOS uses DMG/ZIP for Intel and Apple Silicon, with a configured drag-to-Applications layout. Package commands never publish. Signing, notarization, clean-machine install and native macOS behavior remain release gates. See [implementation boundaries](CLOUD-FIRST.md), [desktop polish and platform gates](DESKTOP-POLISH.md) and [local validation](../VALIDATION.md).

This is an alpha source preview. The reviewed dependency changes produce zero npm audit findings; exact advisory paths, exposure and compatibility review are recorded in [dependency triage](DEPENDENCY-TRIAGE.md). Live authentication, hardware and platform distribution gates still require validation.

This independent client is not affiliated with Microsoft or Xbox. Upstream MIT copyright and permission text remain in [LICENSE](../LICENSE); attribution remains in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

Focused streaming disables Electron background throttling to avoid macOS occlusion interrupting presentation. Throttling returns on blur, hide, minimize, screen lock, suspend, or session exit. Native window state independently gates real-stream input and presentation metrics, even if Chromium still reports the document visible. Reports preserve both signals; visibility means rendering eligibility, not proof of physical display output. Frame cadence uses expected display timestamps when available, labels submission-time fallback, resets its rolling window across visibility changes, and excludes hidden/boundary intervals from local drop counts.

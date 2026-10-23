# Changelog

## Unreleased

### Planned 0.1.0-beta.1 — Apple Silicon

- Reserve a separate Cloud version/tag and prepare a hosted Developer ID and
  notarization pipeline that stages a draft only after native artifact checks.
  Signing prerequisites and final physical-machine qualification must pass before
  distribution.
- Include the latest merged library navigation, input-stall resilience and
  session-preservation changes. Transport loss retains the existing Xbox session
  and heartbeat; replacing it requires a warned explicit restart. Provider-side
  termination can still lose progress.
- Add packaged signed-out startup/restart checks and exact version, publisher,
  architecture, notarization and artifact identity validation. This preparation
  does not publish a binary, qualify Intel/Windows or enable automatic updates.

- Prepare a manual unsigned Cloud candidate workflow for Windows x64 and Mac
  arm64, with exact-source manifests and SHA-256 checksums. No release is
  published and signing/notarization remain required before distribution.
- Add Cloud release status, qualification criteria, privacy, support, known
  issues and separate Windows/macOS bug and feature forms.

- Create an independent xCloud-only alpha for Windows and macOS, with a
  controller-first library, search, recent games, bounded recovery and measured
  stream diagnostics. Remove console remote play and Steam Deck navigation.
- Keep a separate encrypted credential store, desktop menus/window lifecycle,
  accessible fullscreen controls and honest Xbox-negotiated quality.
- Configure Windows NSIS and separate Intel/Apple Silicon DMG/ZIP targets.
  Signing, notarization, clean-machine installation and physical controllers
  remain unqualified. Apple Silicon source/native execution and live Xbox smoke
  tests are recorded in the release qualification document; Intel execution and
  sustained packaged Windows streaming still need evidence.

## Inherited Afterglide history

The entries below describe the upstream project before the cloud-only fork.
They are not Afterglide Cloud release or compatibility claims.

### Upstream unreleased

- Preserve bounded button and trigger edges during input congestion while keeping
  analog movement fresh and giving neutral releases priority.
- Add presented-frame cadence percentiles, dropped-frame and freeze diagnostics,
  with unavailable measurements kept distinct from zero.
- Add controller-accessible in-stream audio, fit/fill, and 4 ms / 8 ms input
  polling preferences that apply without restarting the stream.
- Keep one-second telemetry off the full snapshot/render path, reuse sampled
  controller frames, and avoid duplicate active-stream gamepad polling.
- Bound automatic recovery, cancel stale retries when leaving, and detect
  operating-system resume without promising cloud-game preservation.
- Export local, identifier-free performance histories and configuration-grouped
  summaries with Electron CPU usage and supported Linux battery/thermal sensors.

Physical Steam Deck power, hardware decoding, live service recovery, and
competitor latency comparisons remain unverified; automated fixtures are not
evidence of market-leading performance.

### Upstream 0.3.0-alpha.1 - 2026-09-13

This first public prerelease makes Afterglide installable without a development
toolchain and keeps its readiness limits visible.

- Publish checksummed Linux x86_64 AppImage and tarball artifacts from a verified
  tag workflow.
- Add a no-root Steam Deck installer with desktop integration, repeatable updates,
  and clean uninstall support.
- Add an optional first-run readiness check for Xbox remote features, secure
  credential storage, and controller detection.
- Report the actual OS credential backend and explain how to enable a Linux
  keyring when persistence is unavailable.
- Check official GitHub releases in the app and link directly to compatible
  updates.
- Add last-active controller routing, explicit device selection, matching rumble,
  live diagnostics, and per-controller tuning profiles.
- Add configurable Steam Input shortcuts and controller-safe stream overlays.

Live Xbox service compatibility, packaged hardware decode, power use, and a full
Steam Deck session remain pending real-account and physical-device verification.

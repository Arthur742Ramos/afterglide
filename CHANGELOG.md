# Changelog

## Unreleased

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

## 0.3.0-alpha.1 — 2026-09-13

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

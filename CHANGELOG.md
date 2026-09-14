# Changelog

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

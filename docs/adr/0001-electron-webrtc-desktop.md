# ADR 0001: Electron and browser WebRTC for the desktop client

- Status: accepted
- Date: 2026-09-12

## Context

Afterglide began as a Rust and Slint interaction prototype. That slice proved the
controller-first product direction and a deterministic session model, but it did
not authenticate with Xbox, negotiate a remote-play session, decode media, or
provide a practical way to automate the full desktop flow.

Xbox home streaming uses HTTP session signaling, WebRTC media and data channels,
and a browser-compatible H.264 path. Greenlight demonstrates that this protocol
works in Chromium on Steam Deck and publishes its authentication and Xbox Web API
libraries under MIT licenses. Electron also has a supported Playwright driver for
desktop end-to-end testing.

## Decision

Use a narrow Electron main process, a sandboxed preload bridge, and a React/Vite
renderer:

- The main process owns Microsoft device-code authentication, OS-encrypted token
  persistence, Xbox discovery and wake, and all authenticated HTTP signaling.
- The renderer owns the `RTCPeerConnection`, media elements, focused controller
  capture, and the controller-first interface. It receives no Xbox credentials.
- Chromium selects the hardware video decoder and presents the received video
  directly. Afterglide records Chromium's feature status and live WebRTC metrics.
- A service interface separates the live Xbox adapter from an unavailable-in-
  production deterministic adapter. Playwright can exercise sign-in, discovery,
  connection, recovery, settings, and errors without real credentials.
- Controller input is sampled only while the window is focused and visible. A
  neutral frame is sent when focus is lost.

## Consequences

This replaces the Rust/Slint production scaffold. It gives Afterglide a complete
and testable vertical slice using the same media runtime as the currently proven
open-source Xbox client. The binary is larger than the earlier native shell, and
hardware decode remains a release gate that must be verified on the shipped Steam
Deck package rather than inferred from desktop tests.

The live protocol depends on unofficial, community-maintained Xbox interfaces.
Protocol changes can break sign-in or streaming, so adapters remain isolated and
errors remain explicit. A deterministic test backend validates product behavior;
it is not evidence that Microsoft's live service or a physical Deck is healthy.

# Architecture

Afterglide uses ports and adapters around an authenticated desktop boundary. The
renderer is untrusted with respect to credentials: Xbox and Microsoft tokens
never cross the preload bridge.

```text
 React interface + WebRTC media + focused input
                       │
               typed preload bridge
                       │
        Electron main process controller
          │              │             │
   Microsoft auth   Xbox Smartglass   xHome signaling
          │              │             │
          └──── OS-encrypted store ─────┘
```

## Main process

`AppController` owns the user-visible session state and emits immutable snapshots.
`PlatformService` is the port for sign-in, console discovery, wake, session
provisioning, SDP/ICE exchange, keepalive, and stop. `LivePlatformService` is the
Xbox adapter; `MockPlatformService` is compiled into development builds but can
only be selected when Electron is unpackaged and `AFTERGLIDE_E2E=1`.

The renderer can invoke only named operations. Navigation is blocked outside the
local application, new windows are denied, permission prompts are denied, and a
Content Security Policy limits code and network origins. Microsoft sign-in links
open through a hostname allowlist in the system browser.

## Authentication

Microsoft device-code authentication occurs in the main process through
`xal-node`. Only the short user-facing code and Microsoft verification URL enter
the renderer. Refresh tokens are persisted with Electron `safeStorage`, which
uses the operating system's encryption service. When encryption is unavailable,
tokens remain usable for the current process but are not written to disk.

## Streaming

The main process provisions an xHome session and handles authenticated HTTP. The
renderer creates the `RTCPeerConnection`, prefers H.264, exchanges SDP and ICE
through the main process, and attaches received tracks directly to HTML media
elements. This keeps video in Chromium's decoder and compositor path.

Four Xbox data channels are created before the offer: `chat`, `control`, `input`,
and `message`. The input channel transmits controller frames and receives rumble.
Physical input is sampled only while the window is focused and visible; losing
focus sends a neutral frame and stops capture.

## Testing boundary

Unit tests cover deterministic state, packet encoding, address handling, and
redaction. Playwright starts the actual Electron shell against a deterministic
platform adapter and covers first run, device-code sign-in, console selection,
connection stages, stream controls, settings, recovery, and failure/retry.

The deterministic backend proves the application flow and desktop wiring. A live
smoke test on a Microsoft account and physical Xbox proves current protocol
compatibility. Steam Deck hardware checks additionally record Chromium video
decode status, resolution, frame rate, packet loss, round trip time, and power.

See [ADR 0001](adr/0001-electron-webrtc-desktop.md) for the stack decision.

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
   Microsoft auth   Xbox Smartglass   xHome / xCloud
          │              │             │
          └──── OS-encrypted store ─────┘
```

## Main process

`AppController` owns the user-visible session state and emits immutable snapshots.
`PlatformService` is the port for sign-in, console and cloud-title discovery,
wake, session provisioning, SDP/ICE exchange, keepalive, and stop.
`LivePlatformService` is the Xbox adapter; `MockPlatformService` is compiled into
development builds but can only be selected when Electron is unpackaged and
`AFTERGLIDE_E2E=1`.

The renderer can invoke only named operations. Navigation is blocked outside the
local application, new windows are denied, permission prompts are denied, and a
Content Security Policy limits code and network origins. Microsoft sign-in links
open through a hostname allowlist in the system browser.

Release checks run in the main process against the project's official GitHub
releases endpoint with a bounded timeout and response size. Stable builds consider
stable releases; prerelease builds also consider newer prereleases. The renderer
receives only a version, status, publication time, and canonical release URL.
External navigation accepts that repository's exact release paths in addition to
Microsoft sign-in hosts.

## Authentication

Microsoft device-code authentication occurs in the main process through
`xal-node`. Only the short user-facing code and Microsoft verification URL enter
the renderer. Refresh tokens are persisted with Electron `safeStorage`, which
uses the operating system's encryption service. When encryption is unavailable,
tokens remain usable for the current process but are not written to disk.
The snapshot also reports the selected backend in plain language. Linux's
`basic_text` fallback is treated as session-only storage; KDE Wallet or a Secret
Service keyring is required for persistent sign-in.

## Streaming

The main process acquires separate xHome and xCloud tokens. Home sessions target
a console ID; cloud sessions target a title ID in the token's default service
region. Cloud title IDs come from the streaming service and are hydrated in
batches of 100 from the Game Pass catalog. Catalog results are cached for five
minutes. The cloud token can be absent for an ineligible account or region, which
the UI treats as an explicit unavailable state.

The renderer creates the `RTCPeerConnection`, prefers H.264, exchanges SDP and
ICE through the main process, and attaches received tracks directly to HTML
media elements. This keeps video in Chromium's decoder and compositor path.

Four Xbox data channels are created before the offer: `chat`, `control`, `input`,
and `message`. The input channel transmits controller frames and receives rumble.
Physical input is sampled only while the window is focused and visible; losing
focus sends a neutral frame and stops capture.

The renderer owns one controller-selection path shared by shell navigation,
in-stream shortcuts, Xbox input reports, and rumble. Automatic mode retains the
current device until another connected controller produces input; an explicit
device ID locks selection. A disconnect or controller switch sends a neutral Xbox
frame before any replacement input, preventing held buttons from crossing device
boundaries. Rumble targets the selected physical controller rather than the
server's virtual gamepad index.

Controller tuning has a safe default plus bounded per-device profiles. Profiles
can choose off, low, or full rumble; 4%, 8%, or 12% stick deadzones; full, short,
or quick trigger travel; and common face-button pair swaps. The main process
validates controller IDs and every enumerated profile value before persisting the
settings. The renderer's diagnostics panel reads the browser Gamepad API directly;
controller identity and live input data never cross the preload boundary.

The default input schema reserves L3 + R3 for Afterglide's in-stream controls.
Users can instead select Steam Input mode, which passes the chord to Xbox and
uses the always-local F10 shortcut that a Deck button or paddle can emit. F9 is
the corresponding local performance shortcut. Opening Afterglide's controls
sends a neutral frame and suspends game input until the controls close;
D-pad or left stick, A, and B then navigate the application. Menu + View emits
the Xbox button. Optional keyboard emulation covers both sticks, D-pad, face
buttons, bumpers, triggers, stick clicks, Menu, View, and Xbox while Escape and
F3 remain local controls.

## Network policy

Xbox service reads have bounded timeouts and retry only transient HTTP or
transport failures. Session creation, authorization, signaling writes, and stop
requests are never replayed automatically because they are not idempotent. Cloud
provisioning allows longer queues than home provisioning.

ICE gathering is bounded at four seconds, duplicate candidates are removed, and
SDP and candidate payloads are size-limited on both sides of the preload bridge.
Media must connect within 60 seconds. An established WebRTC connection gets a
three-second grace period in `disconnected`; `failed` recovers immediately.
Keepalive recovery starts after three consecutive failures, while any success
resets the count. Telemetry samples once per second and classifies network quality
from round-trip time, packet loss, and received frame rate. WebRTC controls the
incoming bitrate through its congestion-control loop.

## Testing boundary

Unit tests cover deterministic state, packet encoding, address handling, and
redaction. Playwright starts the actual Electron shell against a deterministic
platform adapter and covers first run, device-code sign-in, console selection,
connection stages, home and cloud stream controls, settings, recovery, and
failure/retry.

The deterministic backend proves the application flow and desktop wiring. A live
smoke test on a Microsoft account and physical Xbox proves current protocol
compatibility. Steam Deck hardware checks additionally record Chromium video
decode status, resolution, frame rate, packet loss, round trip time, and power.

See [ADR 0001](adr/0001-electron-webrtc-desktop.md) for the stack decision.

## Latency and input scheduling

Controller sampling targets a 4 ms interval independently of rendering, with an
optional 8 ms mode for measured power/latency comparisons. Input frames are only
sent when the SCTP send queue is empty. A bounded transition buffer preserves
short button and trigger presses across temporary congestion without queuing historical
analog positions; neutral releases take priority and remain retryable while
focus or overlay capture suspends gameplay. Input activation waits for both
channels and the message handshake. The hot path reuses sampled frame storage,
compares compact transition state without JSON serialization, and owns the local
controls chord so active gameplay does not need a second Gamepad API loop.
Receiver buffering uses the standard
interactive playout hint where supported. Health exposes interval decode and
buffer measurements, while Ping explicitly means network round trip.

Playback preferences are validated and persisted by the main process, then
applied to the existing media engine without renegotiating. Volume/mute affect
the audio element; fit/fill controls contain/cover on the video surface.
Controller profile changes also update the active engine rather than leaving
stale constructor settings behind.

## Performance evidence and recovery

The main process sanitizes renderer telemetry and retains a bounded performance
history separate from the visible snapshot. Samples arrive over one-way IPC and
do not clone or rebroadcast the full application snapshot each second. The
renderer only rerenders live values while its performance overlay is visible.
Reports survive End session but are reset by a fresh launch; automatic
reconnections retain the history. The export
IPC accepts no path from the renderer: Electron's native save dialog selects the
destination, and the main process writes only the curated report. Authentication
data, Xbox session identifiers, console names, and controller profiles are never
included. No report is uploaded automatically.

While streaming, a five-second sampler records Electron process CPU usage and,
on Linux, read-only battery/thermal sysfs values. Unsupported sources and sensor
failures are marked unavailable. Device readings carry their own timestamp so
repeated samples are not counted as independent measurements. Configuration
changes clear cached device readings. Reports group summary statistics by
resolution and polling mode and label simulated adapters explicitly.

Operating-system resume publishes one interruption for an established stream;
late events cannot turn a recovering session back into a connected one. The
renderer manages bounded recovery attempts and waits for network availability.
Retrying creates a new Xbox session and does not guarantee preservation of a
cloud game. Main-process generation checks prevent an awaited stop from starting
another stream after the user has left, and late provisioning results are
cleaned up. Recovery timing ends at playable video, not at successful signaling.

See [streaming performance](STREAMING-PERFORMANCE.md) for limitations and the
repeatable comparison protocol required before a market-leading claim.

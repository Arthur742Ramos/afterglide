# Architecture

Afterglide uses ports and adapters around a platform-independent session machine.
The core accepts events and emits commands; it never opens sockets, draws pixels,
or stores credentials.

```text
                         events
  ┌──────────┐       ┌────────────┐       ┌────────────────┐
  │ Slint UI │──────►│ Session    │──────►│ Commands       │
  │          │◄──────│ machine    │       │ wake / connect │
  └──────────┘ state └────────────┘       │ media / recover│
                                          └───────┬────────┘
                                                  │
                         ┌────────────────────────┼─────────────┐
                         ▼                        ▼             ▼
                    Xbox adapter            Media adapter  Secure store
                    auth · xHome             GStreamer      platform keyring
```

## Boundaries

### `afterglide-core`

Owns session states, recovery policy, user-facing status, and commands. It must
remain deterministic and independent of UI or async runtimes.

### Desktop application

Owns the Slint window, controller focus, view models, app lifetime, and adapter
wiring. It translates controller actions into the same semantic actions used by
touch and keyboard input.

### Xbox adapter

Will own Microsoft authentication, console discovery and wake, xHome signaling,
and gamepad packet transmission. Protocol code stays behind traits so recordings
and simulations can test the rest of the application.

### Media adapter

Will own WebRTC negotiation, GStreamer pipelines, hardware decoder selection,
frame presentation, audio, and media telemetry. The target Deck path is decoded
GPU surfaces to presentation without a round trip through CPU memory.

## Performance evidence

Benchmarks must record device model, SteamOS version, console model, access point,
radio band, resolution, frame rate, bitrate policy, and session length. Publish
raw samples with summaries so regressions can be reproduced.

## Security

Authentication material belongs in the platform keyring. Logs use structured
fields and redact identifiers at their source. UI errors are safe summaries;
diagnostics can include stable error categories without secrets.


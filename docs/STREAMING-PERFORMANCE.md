# Streaming performance and validation

Afterglide does not yet have evidence for a market-leading latency claim. Ping is
network round-trip time, not button-to-photon latency. Server simulation, encoder,
network, receiver buffer, decoder, compositor, display and controller all contribute.

## Client changes

- Controller sampling uses a 4 ms timer (250 Hz target), independent of animation
  frames. A 60 Hz animation loop has a 16.7 ms interval. Browser scheduling and
  Gamepad API updates can limit the effective rate; this is not a measured 12.7 ms
  end-to-end improvement. Keyboard transitions are sent directly from events.
- Input uses the established Xbox ordered/reliable channel contract. While the
  channel has queued bytes, fresh samples replace historical movement rather than
  adding an application backlog. This cannot remove packets already inside SCTP
  or the network. Very short taps during congestion may be coalesced.
- Focus loss and overlay entry send neutral input. If congested, the release is
  retried on queue drain and timer ticks, including while input is suspended.
- The input handshake waits for both channels, avoiding a startup ordering race.
- Supported receivers request a zero additional jitter-buffer target. This is a
  hint: Chromium retains control of jitter adaptation and audio/video sync.
- Health reports the stream's actual decoder identifier when Chromium supplies
  it, interval decode time per frame, interval video-buffer delay, and send-queue
  bytes. Missing measurements remain unavailable, never fabricated zeroes.
- Ping comes from the selected transport candidate pair. Unrelated succeeded ICE
  probes no longer overwrite the live route's measurement.

## Comparison protocol

Compare the same Xbox title, save position, server region, resolution, frame-rate
mode, controller, display refresh rate, power mode and wired network. Record exact
client versions. Test Afterglide, Greenlight and Better xCloud in alternating order
at least three times each to reduce time-of-day and service-capacity bias.

For each run, collect 10 minutes after a warm-up and report median and p95 for
ping, decode time, video-buffer delay, delivered FPS, packet loss, CPU and power.
Record video decoder identity and thermal state. Repeat on Wi-Fi and a controlled
impaired route (added latency, jitter and packet loss); do not change system-wide
network settings on a working machine merely to run this test.

Use a high-speed camera showing both the physical button actuation and the
corresponding screen change for at least 100 samples per configuration. That
measures button-to-photon latency; adding WebRTC counters together does not.
Check 100 short taps, analog diagonals, simultaneous triggers, focus loss, overlay
entry, disconnect/reconnect and controller switching. Log missed/duplicated inputs
and any stuck button. Include a 60-minute session and physical Deck battery run.

Acceptance: no stuck inputs in the disruption suite, no missed taps on a healthy
route, no regression in p95 frame delivery or power, and a repeatable latency
improvement across runs before claiming superiority. A 4 ms timer alone is not
proof of a 250 Hz hardware sampling rate or superior streaming.

## Sources

- [Better xCloud polling settings](https://github.com/redphx/better-xcloud/blob/main/src/utils/settings-storages/stream-settings-storage.ts)
  expose a 4 ms default; this is a useful parity target.
- [Greenlight input channel](https://github.com/unknownskl/greenlight/blob/main-v2/packages/player/src/client/lib/channel/input.ts)
  retains ordered input protocol 1.0.
- [W3C WebRTC receiver controls](https://www.w3.org/TR/webrtc/#dom-rtcrtpreceiver-jitterbuffertarget)
  define the jitter-buffer target as a browser hint.
- [W3C WebRTC statistics](https://www.w3.org/TR/webrtc-stats/)
  define cumulative decode/buffer counters and selected transport routes.

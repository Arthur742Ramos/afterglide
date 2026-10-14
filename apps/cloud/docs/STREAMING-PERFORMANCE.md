# Streaming performance and validation

Afterglide Cloud does not yet have evidence for a market-leading latency claim. Ping is
network round-trip time, not button-to-photon latency. Server simulation, encoder,
network, receiver buffer, decoder, compositor, display and controller all contribute.

## Client changes

- Controller sampling uses a 4 ms timer (250 Hz target), independent of animation
  frames. A 60 Hz animation loop has a 16.7 ms interval. Browser scheduling and
  Gamepad API updates can limit the effective rate; this is not a measured 12.7 ms
  end-to-end improvement. An optional 8 ms mode allows power/latency comparison.
  With no controller, polling slows to 50 ms; hidden, unfocused, or captured input
  stops polling except for a 50 ms pending-neutral retry. Keyboard transitions
  are sampled directly from events. The active stream engine also owns the local
  L3 + R3 edge, so the UI only polls separately while captured controls need a
  release-and-repress close gesture.
- Input uses the established Xbox ordered/reliable channel contract. While the
  channel has queued bytes, fresh stick samples replace historical movement.
  Button and trigger rest/press edges share an ordered buffer of 32 transitions;
  intermediate trigger travel and stick motion coalesce. The buffer has
  an oldest age of 250 ms. Exceeding either limit fails closed with a visible
  stream error rather than silently losing actions or replaying arbitrarily old
  input. This is bounded short-congestion tolerance, not a promise to preserve
  input through prolonged outages. Packets already inside SCTP or the network
  cannot be recalled.
- The hot input path reuses its sampled frame and compares a compact digital
  transition mask plus numeric frame fields. It does not allocate transition
  arrays or serialize the full controller frame on every 4 ms sample.
- Focus loss and overlay entry send neutral input. If congested, the release is
  retried on queue drain and timer ticks, including while input is suspended.
- The input handshake waits for both channels, avoiding a startup ordering race.
- Video codec preferences reorder the browser's complete capability list while
  preserving RTX retransmission, RED redundancy, FEC and other codec fallbacks.
  Previously the H264 preference filter removed RTX and RED from the offer.
  Keeping them available allows packet repair when the Xbox answer negotiates
  them; it does not force the service to support or select them.
- Cloud receivers initially retain automatic browser buffering. A zero target
  is requested only after ten continuous seconds of advancing video with
  reported jitter <=5 ms, interval loss <=0.5% and RTT <=80 ms. Waiting, hidden
  playback, a freeze, stalled decoding, stale/replaced/reset counters, missing
  measurements, a stats failure or unhealthy network measurements immediately
  restore the browser default. Interrupted sampling (>2.5 seconds) restarts
  that healthy window. These thresholds are conservative client policy, not
  measured performance gains. Both receivers use the same requested policy
  for audio/video sync; Chromium retains control of actual delay and packet
  recovery. A zero target is a low-delay hint, not a disabled jitter buffer.
- Health reports the stream's actual decoder identifier when Chromium supplies
  it, interval decode time per frame, interval video-buffer delay, and send-queue
  bytes. Exports also retain packet jitter in `jitterMs` and the requested
  `playoutMode` (`automatic` or `low-delay`). Packet jitter, receiver buffer
  delay and requested policy are separate measurements. Missing measurements
  remain unavailable, never fabricated zeroes.
- Ping comes from the selected transport candidate pair. Unrelated succeeded ICE
  probes no longer overwrite the live route's measurement.
- Frame cadence uses nearest-rank p95/p99 over up to 600 visible, observed
  consecutive-frame presentation intervals from `requestVideoFrameCallback`.
  When its `presentedFrames` counter advances by more than one, the callback
  missed observations: that gap is excluded instead of being labeled a slow
  displayed frame. `presentationCallbacksSkipped` records those missed
  observations, separately from actual drop counters. `presentationIntervalSamples`
  discloses how many intervals support the rolling percentiles. This measures
  browser presentation, not display photons. Real long consecutive-frame gaps
  remain in cadence; freeze counts still require actual browser counters.
  Hidden/spanning freeze intervals are excluded.
- Runtime playback and controller settings compare values, not snapshot object
  identity. A new telemetry snapshot does not release held buttons, restart
  polling, or renegotiate the stream.
- One-second telemetry uses one-way IPC for report retention. The renderer keeps
  the latest sample locally and only rerenders it while the performance overlay
  is visible; the main process does not clone and rebroadcast the full app
  snapshot for every sample.

## Comparison protocol

### Incoming, decoded and displayed FPS

F3 and Health show three separate rates; JSON exports retain them and their
summary distributions. Incoming uses complete video `framesReceived`, decoded
uses `framesDecoded`, and both divide counter deltas by advancing WebRTC stats
timestamps on the same receiver. Replaced/reset/stale/missing counters yield
unavailable data; a valid interval with no new frames yields measured zero.
The older `framesPerSecond` field remains Chromium's last-second decode reading
for compatibility.

Displayed uses `framesRendered` when available, otherwise the compositor
submission count in video callback `presentedFrames` over the sampling interval.
It counts frames even when a callback misses an observation. The export's
`displayedFpsSource` distinguishes `webrtc` from `video-callback`. This is browser
render/submission FPS, not physical display photons or original game-engine FPS.
Hidden playback is unavailable rather than a fabricated zero; the first sample
after returning establishes a fresh baseline. `playbackVisible` and
`playbackFocused` help interpret background/occlusion effects on a run.

If incoming FPS falls with decoded/displayed FPS, compare loss/jitter and bitrate
to distinguish a delivery interruption from a lower stream rate. If incoming is
steady but decode falls behind, inspect decode time and real drops. If incoming
and decode stay steady but display falls behind, inspect presentation and window
visibility. These are diagnostic patterns, not automatic proof of a cause.

The overlay uses an opaque instrument surface without per-metric backdrop blur,
avoiding repeated filtering of live video beneath the FPS readouts. This removes
that compositor work; improved real-game frame pacing still needs an A/B run.
Hardware capability reads wait for GPU information and refresh on GPU status
changes, avoiding an early software-only snapshot. A supported hardware feature
does not prove this particular stream used hardware decoding.

The native Chromium offer regression uses the production Cloud stream engine
in an isolated Electron profile. It checks that supported repair codecs reach
the real SDP offer and that H264 remains preferred. Deterministic tests cover
loss/jitter bursts, delayed or unavailable stats, frozen/replaced receivers,
waiting playback, recovery hysteresis and unsupported buffer-control setters.
These establish negotiation and policy behavior, not smoother Xbox gameplay
on an impaired network. The same-title A/B procedure below remains necessary
to measure changes in freeze count/duration, p95 frame delivery and latency.

Compare the same Xbox title, save position, server region, resolution, frame-rate
mode, controller, display refresh rate, power mode and wired network. Record exact
client versions. Test Afterglide Cloud, Greenlight and Better xCloud in alternating order
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

## Collecting evidence in the app

After a run, leave the stream and use Health's performance export action. The
native save dialog writes a JSON file only to the location you select. Canceling
does not save anything. The report remains available after leaving a stream;
starting a fresh, non-recovery session resets it. Automatic reconnections retain
the same report and increment its local connection number.

The report retains the latest 3,600 telemetry samples (normally about one hour),
plus the latest 100 successful recovery durations. `totalSamples`,
`retainedSamples`, and `droppedSamples` disclose eviction. Samples include the
requested resolution, polling mode, and fit/fill setting so configuration changes
are visible. Summaries separate resolution/polling configurations and report
median, p95, and p99 of the retained readings. A percentile of rolling frame
percentiles is explicitly named as such; it is not a global frame percentile.
Missing optional readings are omitted, never replaced with a measured zero.
Built-in summaries include warm-up and configuration-transition samples. For a
controlled comparison, filter raw samples by `telemetry.updatedAt` to the agreed
post-warm-up interval before calculating results; do not treat an unfiltered
export summary as a completed benchmark.

Each sample has a local `connectionNumber` identifying resets of cumulative
freeze/drop counters. Do not subtract counters across connection numbers.
Recovery durations measure interruption detection through new playable video,
including waiting and provisioning; they do not measure how long a cloud game
was paused or prove its progress survived. RTT and decode/buffer measurements
must not be added together and labeled button-to-photon latency.

Electron process CPU usage is sampled every five seconds. Linux battery readings
use `power_now`, or `current_now * voltage_now` if the power sensor is absent.
Only a discharging battery produces a consumption reading; charging power is not
treated as battery drain. Temperature is the maximum exposed CPU/GPU sensor value
from supported `amdgpu`, `k10temp`, `coretemp`, or `zenpower` devices. Unsupported
platforms, sensors, and read failures are explicit in `device.unavailable`.
Repeated device readings carry the same `observedAt`; summaries deduplicate them.
Whole-device watts include the display, radios, OS, and background processes.
The report does not claim those watts were used exclusively by Afterglide Cloud.

Reports exclude authentication data, account names, console names/IDs, server
session identifiers, network addresses, and controller IDs. They include hardware
model strings and timing information; review before sharing. Test mode is marked
`application.environment: "test"` and its media readings are simulated.

## Battery and decode A/B procedure

Use the shipped Linux AppImage, not a development browser. Record Deck model,
OS/kernel version, display refresh rate and brightness, power limit,
network, game/scene, and installed client versions alongside each report.
Disconnect external power and hold those conditions constant. Let temperature
settle before each run. Compare separate Responsive (4 ms) and Efficient (8 ms)
runs in alternating order, at least three times per mode.

Efficient halves the requested active polling frequency; it does not guarantee
half the CPU cost or a battery gain. The Gamepad API, browser scheduler, game,
and power management determine the actual result. Prefer the setting with no
unacceptable p95/p99 frame-delivery or missed-input regression, then compare
whole-device discharge power and sustained thermal behavior. Use a 60-minute
battery run before making a battery-life claim.

Check both Health's GPU feature status and the stream's decoder identity. An
enabled Chromium feature flag alone does not prove this stream used hardware
decode. Corroborate with platform GPU/video-engine tools on the packaged build;
decoder names vary by driver. Do not force unverified VA-API flags or codecs.
Record absent evidence as unverified.

Also exercise physical sleep/wake, an offline interval, Wi-Fi reconnection,
controller removal/replacement, and End session during a pending recovery.
Verify bounded retries and no restart after leaving. Recovery starts a new
streaming session: cloud capacity, queues, and game-progress preservation remain
controlled by Xbox services. Complete the same live-network disruption tests for
cloud play before advertising seamless recovery.

## Sources

- [Better xCloud polling settings](https://github.com/redphx/better-xcloud/blob/main/src/utils/settings-storages/stream-settings-storage.ts)
  expose a 4 ms default; this is a useful parity target.
- [Greenlight input channel](https://github.com/unknownskl/greenlight/blob/main-v2/packages/player/src/client/lib/channel/input.ts)
  retains ordered input protocol 1.0.
- [W3C WebRTC receiver controls](https://www.w3.org/TR/webrtc/#dom-rtcrtpreceiver-jitterbuffertarget)
  define the jitter-buffer target as a browser hint.
- [W3C WebRTC statistics](https://www.w3.org/TR/webrtc-stats/)
  define cumulative decode/buffer counters and selected transport routes.

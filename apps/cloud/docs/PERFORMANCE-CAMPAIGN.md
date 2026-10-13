# Performance and polish campaign

This campaign preserves the direct WebRTC media path, bounded input queues,
neutral input releases, sandboxed preload and encrypted credentials. Xbox controls
eligibility, stream capacity and negotiated quality. Client changes cannot promise
server latency, resolution or bitrate.

## Starting evidence

The Astra evaluation used commit `603185d81fd065a071b25771333209fae2fe5ad7`
on a shared Windows host. The production build and 124 unit tests passed.
Instrumented signed-out launches reached the sign-in screen in 1,404 ms initially
and 624 ms on repeat. Aggregate Electron working sets were 410.8 MiB and private
memory was 120.8 MiB in the signed-out idle sample. Uncompressed renderer assets
were 281,830 bytes of JavaScript and 52,716 bytes of CSS.

These are harness observations, not controlled benchmarks. Other work was active
on the host, instrumentation affects startup and there was no authenticated stream.
Do not compare a later isolated run with these numbers as proof of improvement.
The compact Settings capture used a 960x600 outer window and showed no horizontal
overflow. The attempted inline accessibility injection was blocked by CSP; no
security policy was changed to permit it.

## Bounded sequence

1. Preserve unknown telemetry through collection, display and export. Keep
   measurement retention bounded and distinguish mock data from live evidence.
2. Give authentication attempts exclusive ownership of their staged credentials;
   cancelled work cannot write or erase a newer session.
3. Cancel obsolete work and compose retries within total operation budgets.
   Bound catalog pagination and preserve cleanup of late-created sessions.
4. Require video and input readiness before reporting a playable stream. Handle
   required channel failures once and retain startup deadlines.
5. Stop unnecessary controller/UI polling while unfocused or without controllers.
   Preserve hotplug, held-button release and keyboard parity.
6. Measure startup phases and state transfers before changing their scheduling.
   Preserve ordered settings writes and unchanged-library identity.
7. Improve error, loading and artwork states, save failures and return focus.
   Verify compact layouts, larger text and 200% zoom without replacing the design.
8. Qualify actual decoding, sustained streaming and native packaging on hardware.

Authentication and playable readiness are correctness repairs and can proceed
before optimization measurements. Each change starts as a draft PR, receives an
independent source review, and merges only after checks pass on its exact commit.

## Comparable measurements

Use a dedicated host with other benchmark/build jobs stopped by their owners.
Record OS, architecture, app commit, packaged or source launch, resolution request,
actual negotiated resolution and codec, reported decoder, controller connection,
network type and session duration without private identifiers. Use the same host,
profile, catalog and conditions before and after a change.

Measure repeated cold and warm launches separately. Report distributions and
sample counts, not a single best launch. During sustained streaming, export the
existing bounded performance report and compare RTT, decode/jitter-buffer cost,
presented-frame cadence, loss and Electron CPU under identical conditions.
Missing measurements stay unavailable; RTT and frame cadence are not
button-to-photon latency, and Chromium decoder names do not prove hardware decode.
Record recoveries and changes in requested settings as separate intervals.

Controller scheduling changes need both deterministic interrupted/held-input
regressions and physical USB/Bluetooth validation. UI work needs captures at
960x600 and 1280x800, 200% zoom, error/retry/cancel flows and focus restoration.
Run source and packaged comparisons separately. Simulated Electron tests verify
client behavior, not Xbox capacity, live signaling or streaming performance.

## Remaining qualification

PR #16 records a short Apple Silicon Fortnite session at 1080p/60 with
user-confirmed audio and keyboard input. It does not establish sustained decode
performance, physical controller/rumble support or interruption recovery. Intel
Mac runtime, Windows and Apple Silicon sustained sessions, signing/notarization
and ordinary clean installation remain platform gates. This campaign does not
publish a release or require a new login, subscription or security-setting change.

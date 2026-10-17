# Client lifecycle profiling

The opt-in profiler uses disposable accounts/profiles and two workloads:

- The source UI with the synthetic 80-title catalog: foreground signed-out idle,
  Library without/with a standard controller, open/closed stream controls, Settings,
  and repeated mock connect/disconnect.
- The production `XboxStreamEngine` receiving local Chromium video/audio and input
  channels. A separate renderer generates a 640x360, 30 FPS canvas and silent audio.
  A separate cancellation case holds the observed ICE state at `gathering` until
  teardown; it does not simulate real network latency.

From `apps/cloud`, build once, then run serially on a quiet host:

```sh
npm run build
npm run profile:client -- --mode=all --duration=6000 --repetitions=3 --cycles=20 --out=artifacts/perf/baseline.json
```

Apply the change, rebuild, and repeat the identical command with `after.json`.
Linux needs a working display, such as Xvfb. Other modes are `startup`, `ui`, and
`engine`. The script prints a usage error for invalid durations/counts/modes.
It never logs in to Microsoft or contacts Xbox. Keep unrelated builds and test
processes out of accepted measurement windows.

## Interpretation

CPU comes from cumulative Electron process CPU divided by wall time, as percent
of one core. RSS sums can double-count shared pages; Linux PSS and private pages
are also recorded. GPU-process RSS is not VRAM. Per-PID engine CPU identifies the
synthetic encoder renderer; shared browser/GPU/utility cost cannot be cleanly
assigned to receiver versus source. Do not call the aggregate pure client cost.

Renderer rAF cadence measures the virtual browser's scheduling, not video display
photons. Native video telemetry comes from the real engine, while mock UI FPS/RTT
constants are excluded. Synthetic input timing measures mutation-to-sampling/send
on the receiver clock; it is not physical button-to-photon latency.

The profiler itself adds work, including rAF observation. Playwright's Electron
launcher injects test flags including `--no-sandbox`, even with sandbox-enabled
BrowserWindow preferences. These are source/Playwright fixture measurements, not
normal packaged-app or native hardware qualification. Production launch flags,
security settings, quality, authentication and packaging are unchanged.

Forced CDP GC happens outside timed CPU/frame windows. DOM and transport probes use
WeakRefs, without retaining element handles. Listener wrapper counts observe
explicit add/remove calls; native `once` or AbortSignal removal can overcount.
The ICE listener under test is explicitly removed. Native resources can need a
later task/GC to disappear after close. Avoid interpreting small warmed heap
growth as proof of a permanent leak; compare repeated lifecycle checkpoints.

Startup reports five fresh-profile launches and five repeats after a seed launch.
These are not OS-cold launches. Pre/post host CPU is sampled with the app closed;
Linux samples are accepted only when both are at most 10%.

## 2026-10-17 lifecycle campaign

The baseline is main `8fbc80dff5efbf1f10c9cdc7fcd046b4e4d7034a`; the after run
uses the same source plus the two runtime changes recorded in
`client-lifecycle-2026-10-17.json`. Compiled file inventories and the bundled engine
probe identify the actual measured artifacts. The frozen harness hash is equal
across both runs. The final checked-in profiler additionally records effective
launch arguments and process churn and excludes double-counted Linux guest CPU
counters. Those reporting corrections add observation overhead. Use the same
harness revision on both sides of any future comparison.

The host was Debian 13 x64, a 4-core CPU quota and 16 GiB memory limit, Electron
43.7.7 / Chromium 150.0.7871.250, a 1280x800 virtual X display, and software GPU
compositing/encoding with hardware video decode unavailable. Workloads ran serially
with three six-second windows per state, twenty normal UI/native sessions, and
twenty cancelled ICE setups. GC observations followed each timed window and every
five lifecycle cycles. The local source remained separate from the receiver.

| Observation                                                    | Before            | After                |
| -------------------------------------------------------------- | ----------------- | -------------------- |
| Detached Library / closed panel alive after GC                 | both, 3/3 windows | neither, 3/3 windows |
| Closed-controls JS heap, median                                | 3,995,056 bytes   | 3,929,152 bytes      |
| Pending ICE setups / timers / listeners after 20 cancellations | 20 / 20 / 20      | 0 / 0 / 0            |
| Renderer DOM nodes at that checkpoint                          | 5,610             | 10                   |
| Pending-ICE checkpoint JS heap                                 | 3,292,108 bytes   | 3,031,536 bytes      |
| Open peers / live tracks / open channels after normal sessions | 0 / 0 / 0         | 0 / 0 / 0            |

The closed-controls heap difference is about 64 KiB; the cancellation checkpoint
difference is about 254 KiB. These are focused fixture observations. Whole-app
RSS did not show a meaningful reduction. Foreground signed-out median summed RSS
was 460.4/461.4 MiB, PSS 261.8/261.2 MiB, and matched-process CPU 3.00/3.33% of one
core (before/after). These include the profiler's observation cost. The animated
mock scene used substantially more software CPU and is not the remote game.

Fresh-profile startup medians were 430/424 ms; primed repeats were 406/435 ms
(five accepted samples each). UI rAF window p95 values stayed 16.7–16.8 ms. Ten
synthetic input taps ranged 0.1–3.1/0.1–2.8 ms sampling-to-send; neither establishes
a latency improvement. Local engine samples received H264 640x360 video at about
30 FPS and silent audio, with no fixture engine errors. Receiver and synthetic
encoder CPU are reported separately in the JSON; shared process cost remains
mixed. Normal-session warmed heaps stayed around 3.0 MB at twenty cycles, with
no open transport/media resources at the recorded cleanup checkpoints.

The frozen campaign's CPU sums include matching surviving endpoint processes.
Every recorded window had stable sampled PIDs and no unmatched final PID, but a
short-lived process between samples could be omitted. Linux guest counters were
zero. The final profiler reports endpoint churn and uses the corrected host CPU
denominator. No CPU, startup, whole-app RSS or decoded-video improvement is claimed.

### Findings and focused changes

Navigation held the previous screen's focusable elements while disabled. That
kept detached Library and Quick Settings DOM reachable throughout streaming or
gameplay. Disabled navigation now drops that array; enabled scope changes retain
the element identities needed for rail/content focus restoration.

Destroying an engine closed its transports/media but did not cancel its pending
four-second ICE wait. The async connection and detached media DOM survived until
timeout. An engine lifetime signal now settles the wait immediately, removes its
listener/timer, and prevents subsequent signaling. Normal ICE completion and
timeout still continue setup. This repairs bounded temporary retention, not an
established unbounded decoder leak.

The checked-in JSON contains per-window distributions, lifecycle checkpoints,
raw report SHA-256 values, source diff, and compiled artifact hashes. The source
regressions cover Library reclamation, repeated controls reclamation, immediate
ICE cancellation without later signaling, and normal completion/timeout behavior.
Existing focus, held-button release, overlay and media tests remain required.

Live Xbox sessions, sustained hardware decoding, GPU memory, physical USB/Bluetooth
controllers, actual audio quality, Mac/Windows resource numbers, and physical input
latency remain unqualified. The separate native Mac background-only observation
had no renderer and memory/swap confounders; it is not comparable to this campaign.
No installer or release is produced by this performance campaign.

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
Mac runtime, Windows and Apple Silicon sustained sessions, ordinary clean installation remain platform gates. The October 23 Apple Silicon draft passed signing/notarization and an owner upgrade; this does not qualify later source changes or the remaining exact-artifact tests. This campaign does not
publish a release or require a new login, subscription or security-setting change.

## Catalog transfer measurement and change

The main-process controller previously sent the complete catalog on every state
update. A synthetic platform and window exercised the actual `AppController` with
100, 1,000 and 5,000 titles, then alternated fullscreen state 20 times. Before
commit `3537d3012fdcd872380535f7e58fe5bf49b2bb6f` and after commit
`330b141385df785f90c007587ff6804d77e455a1` used the same fixture and Node 24 runtime.

| Titles | Messages, before / after | Catalog entries, before / after | Serialized bytes, before / after |
| ------ | ------------------------ | ------------------------------- | -------------------------------- |
| 100    | 20 / 20                  | 2,000 / 0                       | 464,380 / 18,440                 |
| 1,000  | 20 / 20                  | 20,000 / 0                      | 4,568,440 / 18,440               |
| 5,000  | 20 / 20                  | 100,000 / 0                     | 23,128,440 / 18,440              |

The byte counts come from `structuredClone` followed by Node `v8.serialize`.
They are a payload-size proxy, not measured Chromium IPC bytes, CPU savings or
launch/stream latency. Telemetry storage already avoided snapshot broadcasts and
was not part of this measurement. The local fixture scripts and JSON reports are
saved in ignored `artifacts/campaign/state-transfer-{baseline,after}.{ts,json}`.

State events now include titles only when their array changes. `getSnapshot`
continues to return a complete baseline. Monotonic revisions prevent an old
bootstrap reply or queued account event from replacing newer state. The renderer
retains catalog identity on metadata updates and memoizes library filtering.
Unit tests cover catalog changes, account clearing, window attachment and ordering;
Electron tests exercise real IPC omission, reload and deferred bootstrap replies
with synthetic catalogs and accounts. These checks do not contact Xbox.

## Startup measurement deferred

A serial, instrumented Windows source/mock launch used a fresh isolated profile
at `31b989875dfb785cfc3857e538550ed571faf706`. A fresh profile is not an OS-cold
launch. The predeclared acceptance ceiling was 10% host CPU both before and after
each sample. CPU rose from 6% to 16%, so the 3,567 ms sign-in observation was
excluded. The repeat was deferred at 13% CPU. No accepted timing baseline or
startup improvement follows from this attempt. The ignored
`artifacts/campaign/startup-baseline.{mjs,json}` preserves the phases, source and
compiled hash; the instrumented build was restored afterward.

Continue this portion on a quiet dedicated host after other jobs have been stopped
by their owners. Run five fresh-profile and five repeat launches serially with the
same OS, runtime, source/hash, mock delay and launch mode, recording CPU before and
after each run against the same ceiling. This requires no login or subscription.
GPU flags and hardware initialization scheduling remain unchanged until accepted
measurements identify a bottleneck.

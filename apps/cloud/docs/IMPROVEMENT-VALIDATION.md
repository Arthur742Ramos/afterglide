# October 25 reliability and maintenance follow-up

The [closure report](INVESTIGATION-CLOSURE.md) adds bounded attribution controls
for the synthetic RSS-cap stop and the exact remaining build-time audit paths.

Baseline: `485f1d7186bfc34927027266329e9b582d0950fd` (merged PR #51).
This source work does not update the installed app or the October 23 signed beta
draft. No public release, Mac work or live account operation is part of this pass.

## Reproduction and behavior

A hidden Windows Electron test launched a mock game and reloaded its renderer.
On the unchanged runtime, Library reappeared with the provider session still
active and no restart/end action. The new recovery-screen assertion failed.
The ignored `artifacts/campaign/baseline-reload` contains its trace, screenshot and
DOM failure context. The regression is in `tests/e2e/cloud.spec.ts`.

Main-frame document replacement and renderer process loss now mark an established
or negotiating session as interrupted. The provider session and main heartbeat
remain held. A new renderer shows the existing progress-loss warning and explicit
new-session/end actions. No video reattachment is claimed. Pending provisioning
or a restart interrupted before handoff is cancelled; late creation is cleaned up.
Repeated notifications and stale connected events cannot restore a lost peer.

The first crash reloads local controls automatically. To avoid a crash loop,
subsequent crashes enable View > Reload controls after a crash (Ctrl/Cmd+Shift+R),
owned by the native main process. This reload does not replace the Xbox session.
Unavailable renderer IPC cannot prevent local state transitions or remote cleanup.

Tests cover reload twice, two real renderer crashes, automatic and native-menu
recovery, explicit restart/end, retained IDs, heartbeat ownership, dead-frame IPC,
duplicate restarts, and cancellation during creation or old-session cleanup.
The crash test inspects and operates the recovered renderer's actual DOM through
Electron because Playwright permanently marks its original Page handle crashed.
These fixtures do not qualify physical devices or Xbox recovery.

## Dependency provenance

Commit `aa058845c3f942b160a877479c351ba36f6d0c2e` changes only 484 root and 482
Cloud lockfile registry URLs and adds Cloud Dependabot coverage. Parsed comparison
against baseline verified every version, integrity value and other lockfile field
unchanged. Independent read-only review repeated this comparison.

A fresh October 25 audit then reported newly available advisories. A separate
update pins Electron 43.8.1 and overrides undici within its existing major lines
to 6.29.1 and 7.30.1. All unrelated package entries remain identical to the portable
locks. No force upgrade, audit suppression, builder downgrade, credential or
security-setting change is used.

- [Electron certificate mitigation](https://github.com/advisories/GHSA-jr5w-w6x2-84p9)
  affects the shipped Electron runtime; 43.8.1 contains the mitigation.
- [undici content-encoding denial of service](https://github.com/advisories/GHSA-xjj6-f33q-929c)
  and the overlapping EventSource/SRI advisories affect the build/download
  dependency trees, not the Cloud archive's seven allowlisted runtime libraries.
- [fast-uri scheme spoofing](https://github.com/advisories/GHSA-w74x-v6f9-j3xg)
  and three related normalization advisories remain in the builder's AJV tree.
  They are development-only and the app does not expose that URI normalizer to
  account or game input. The configured package proxy did not offer patched
  3.1.9 on October 25; direct public npm TLS was unavailable on this host. No
  speculative major override or builder downgrade was made. The six moderate
  audit entries include parent propagation; they are not six runtime findings.
  The high-severity audit gate remains enabled. Recheck patch availability before
  distribution.

Task-local Node 24/npm 11 tooling and a fresh cache were used. Dependency installs
use this host's configured package proxy; public npm portability also needs the
ordinary hosted fresh-install checks. Do not equate the old zero-advisory audit
with a current audit.

## Qualification boundaries

The October 23 draft contains Electron 43.7.7. Do not promote those old signed
bytes as this update: a separately authorized patched, reviewed signed artifact
and its exact-artifact qualification are required. No signed image was rebuilt,
installed, resigned or published here.

Physical USB/Bluetooth input/rumble, native screen readers and display behavior,
fresh/replacement accounts, clean signed installation and sustained live Xbox
streaming remain unverified for this source. The connected Mac is not authorized
for this task. Preserve the owner's working installation and sessions.

Local tests run serially with disposable mock profiles, hidden windows and one
test worker. Initial permitted disk capacity was about 491 GiB free. No unrelated
files were removed. The denied CIM resource query was not retried. Historical
Linux profiling already establishes that detached UI/ICE retention was repaired;
this pass makes no CPU, latency, decode or whole-app memory improvement claim.

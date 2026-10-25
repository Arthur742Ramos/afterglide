# October 25 investigation closure

This follow-up starts at `c2e79adae335ffaba1d8b1b7a061cde291d867ac`.
[PR #53](https://github.com/Arthur742Ramos/afterglide/pull/53), owned by
Arthur742Ramos, merged the provisioning-heartbeat repair and beta.2 release
preparation. It already includes PR #52. This follow-up changes no application,
dependency, account or release code and performs no installation or publication.

## Why the synthetic RSS cap did not establish an app regression

The earlier two-window synthetic engine attempt stopped at its declared
1,536 MiB aggregate working-set cap (1,554 MiB observed). Its engine was still
connected, with video playing, input active and no reported engine errors. Its
six-second preflight already localized the largest fluctuations to the Browser
(Electron main) process: about 136–484 MiB, versus about 99–101 MiB in the receiver,
96–97 MiB in the encoder and 125–129 MiB in the GPU process. The aborted attempt
did not retain its per-process samples, so its exact peak cannot be attributed
from that artifact alone.

Four short controls then isolated an offscreen rendering confounder. Each used
one hidden, non-focusable 1280×800 Electron window, local HTML, sandbox/context
isolation, no Node integration in the page, and no Afterglide, WebRTC or Playwright.
The canvas alternated two colors at 640×360 every 33 ms. Forty samples per case
were recorded at 500 ms intervals. Cases ran serially for about 20 seconds each;
the original 1,536 MiB and 135%-of-one-core caps were unchanged. The prior runtime
was extracted from the existing public-binary cache into disposable task tooling;
no installed app or runtime was replaced and no binary was downloaded.

| Case                                | Electron | Peak summed RSS, MiB | Final summed RSS, MiB | Peak main RSS, MiB | Peak main JS heap, MiB |
| ----------------------------------- | -------- | -------------------: | --------------------: | -----------------: | ---------------------: |
| Idle, offscreen                     | 43.8.1   |                325.6 |                 325.6 |              109.2 |                    4.5 |
| Canvas, offscreen                   | 43.8.1   |              1,142.5 |                 506.3 |              915.3 |                    4.0 |
| Same canvas, hidden ordinary window | 43.8.1   |                300.8 |                 300.4 |               94.6 |                    4.5 |
| Canvas, offscreen, prior runtime    | 43.7.7   |              1,090.5 |               1,090.5 |              859.2 |                    4.0 |

All cases completed within the caps; peak sampled CPU was below 50% of one core.
Both Electron builds reported Chromium 150.0.7871.250. The production
`stream-engine.ts` is byte-identical between pre-campaign `485f1d7` and this base
(SHA-256 `34646f43c034cd561eea67da6463f6bfa4b8c0720be1f165279ba5da8fe6a020`).

The large main-process working-set variation is reproducible without the app,
its streaming engine or the profiling framework, and exists on the prior runtime.
The hidden ordinary-window control stays comparatively flat. This identifies
offscreen rendering in the Windows fixture/backend as a confounder and does not
support an app-code or newly introduced runtime regression. The falling current
offscreen endpoint also cautions against calling a high-water mark an unbounded
leak. These controls do not identify Electron allocator internals or prove that
ordinary app memory is always flat.

[The compact measurement record](offscreen-memory-2026-10-25.json) preserves
the exact diagnostic harness sources, runtime/host identity, caps, raw-report
hashes and per-case summaries. Ignored local raw files are
`artifacts/perf/{idle-offscreen,canvas-offscreen,canvas-hidden,baseline-canvas-offscreen}.json`.
Summed working sets can double-count shared pages; GPU process RSS is not VRAM.
There is one short run per case on a shared Windows host, so no distribution,
statistical performance improvement or sustained gameplay claim follows.

No production optimization was made. Do not increase the cap or use these hidden
offscreen peaks as an app-leak benchmark. A production memory assessment needs an
approved dedicated host and ordinary packaged rendering, with the synthetic source
isolated or accounted for separately and actual game/decoder conditions recorded.

## Exact remaining audit exposure

The current configured-proxy audit reports zero high/critical findings and six
moderate entries in **both** root and Cloud lockfiles. These are one vulnerable
leaf library plus propagated parent entries, not six independent app findings.
Every listed lock entry has `dev: true`.

| Installed package                   | Version | Dependency path or role                                                   |
| ----------------------------------- | ------- | ------------------------------------------------------------------------- |
| `fast-uri`                          | 3.1.8   | Vulnerable leaf                                                           |
| `ajv`                               | 8.20.0  | Depends on `fast-uri ^3.0.1`                                              |
| `app-builder-lib`                   | 26.15.3 | Depends on `ajv ^8.18.0`                                                  |
| `electron-builder`                  | 26.15.3 | Development packaging command; depends on app-builder-lib and dmg-builder |
| `dmg-builder`                       | 26.15.3 | Depends on app-builder-lib                                                |
| `electron-builder-squirrel-windows` | 26.15.3 | Depends on app-builder-lib; propagated builder entry                      |

The four advisories reported for installed `fast-uri 3.1.8` are:

| Advisory / CVE                                                                            | Behavior                                | Installed 3.x affected range | Severity      |
| ----------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------- | ------------- |
| [GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg), CVE-2026-110306 | Percent-encoded scheme spoofing         | >=3.0.0, <3.1.9              | Moderate, 6.1 |
| [GHSA-xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h), CVE-2026-110095 | Incorrect relative-path equivalence     | >=3.0.0, <3.1.9              | Low, 3.7      |
| [GHSA-wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr), CVE-2026-110180 | WHATWG host canonicalization confusion  | >=3.1.3, <3.1.9              | Moderate, 4.8 |
| [GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp), CVE-2026-110725 | Suffix-reference colon scheme injection | >=3.0.0, <3.1.9              | Low, 3.7      |

The advisories identify 3.1.9 as the patched 3.x version. AJV uses this URI
implementation to resolve schema references. In the installed builder,
`out/util/config/config.js:189–207` reads its packaged `scheme.json` and passes
the build configuration to `schemaValidator.js`; that module constructs AJV and
compiles the schema. This is a build-time input surface. Untrusted schemas or
configuration still deserve scrutiny; a development dependency is not risk-free.

No `fast-uri`/AJV import was found in Cloud `src`. The Cloud packaging allowlist
contains only React, React DOM, scheduler, xal-node, commander, jose and uuid-1345.
The existing local PR #52 unpacked archive contains 542 entries and none of the
six audited packages. That archive observation is not a validation of a later
signed beta.2 artifact. The app's account, catalog, signaling and media paths do
not use the builder's URI resolver in the inspected source.

The configured registry is `https://packagefeedproxy.microsoft.io/npm/`.
An earlier install resolving `fast-uri@3.1.9` returned `ETARGET`; the fresh
normal-proxy version query returned `E404` / no matching version on October 25
(the registry also allows that response for inaccessible packages). This records
what this configured route can resolve, not global publication status. A prior
direct public-registry request failed TLS negotiation.
This follow-up does not retry that direct route, change registry/TLS/security
settings, add credentials or substitute another download source. The audit's
force-fix suggestion downgrades electron-builder to 26.13.0; that broad change
was not taken solely to silence the report.

The remaining dependency action is to obtain 3.1.9 through the normal approved
package route, then verify its integrity and compatibility with the pinned builder
using fresh root/Cloud installs, audits, tests and packaging. Recheck availability
before distribution. Dependency-update PRs #54/#55 are separate automated batches;
this follow-up neither duplicates nor merges those version changes. The existing
high-severity audit gate remains enabled, and the moderate entries are not hidden.

## Dependent actions stopped

Full sustained live/performance qualification still requires an approved device,
the exact packaged artifact, an authorized live account/session and controlled
game/network/decoder conditions. Physical input/rumble requires actual USB and
Bluetooth controllers. Native accessibility requires the corresponding screen
reader/display interaction. This Windows task does not have those resources or
Mac authorization, so those dependent actions stop here. PR #53's separate live
smoke evidence is not treated as a completed controlled sustained qualification.

Active accounts, installed apps, connected Mac and paper/Hodge workloads were
untouched. No release was installed, deployed or published by this follow-up.

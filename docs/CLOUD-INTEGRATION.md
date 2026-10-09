# Optional Cloud app and dependency review

Afterglide Cloud lives in `apps/cloud`, with its own locked dependencies, commands,
renderer, auth adapter, data directory and Windows/macOS packaging. Root commands
still run the original Afterglide app. The original identifiers, settings/token
paths, console discovery/wake/remote play, updater, installer and release workflow
are retained. No Cloud release workflow or automatic publishing is enabled.

Ten small Cloud entrypoints import the existing root controller/input, schema,
buffer, frame/media metrics, controller settings, network policy, recovery,
performance-report and device-metrics implementations. Those root modules are
unchanged. Cloud's main/preload/renderer bridge, contracts, lifecycle and credentials
remain separate. Development ports are 5173 for the original app and 5174 for Cloud.
Shared imports are bundled into Cloud output; installed Cloud packages do not need
the root app or a separate Node installation.

## Root audit gate

Installing upstream main's lockfile on 2026-10-09 reported 42 package findings:
7 moderate, 33 high and 2 critical. Root dependency fixes are necessary for the
existing high-severity CI gate; that gate has not been weakened.

- Electron stays on major 43 and moves from 43.2.0 to 43.7.7, the audit's proposed
  non-major fix for four Electron advisories.
- Pin and override the build downloader `@electron/get` to 5.1.0, already verified
  in Cloud. This removes vulnerable cache/logger dependencies. Pin the existing
  concurrently tool's `shell-quote` leaf to 1.12.0 for its critical advisory.
- Use stable `xal-node` 1.1.4 instead of 1.1.6-beta2 to remove its unused npm
  dependency and bundled advisory paths. Device-code, GSSV, web-token and individual
  stream-token methods remain available. The SDK's combined helper differs when
  both cloud offerings are unavailable, so `src/main/streaming-tokens.ts` preserves
  the original optional-cloud behavior. Console access remains available after
  both cloud requests fail; failed home access still rejects. Five regression
  tests cover standard cloud, free-to-play fallback, cloud unavailability, home
  failure and missing sign-in. They use synthetic tokens and make no network calls.
- A normal `npm audit fix` updates remaining transitive dependencies within their
  existing ranges, including brace-expansion and source-map-js. No force update,
  audit exception or registry/security-setting change is used.

After the bounded changes, the root install reports zero vulnerabilities. This
is registry evidence, not proof of live service compatibility or overall security.
The original console SDK `xbox-webapi`, app version and packaging identifiers are
unchanged. Full original-app and separate Cloud checks must pass before merge.

## Validation boundaries

Windows local tests and both CI suites use simulated Xbox services. Actual Mac
hardware, native fullscreen/Dock behavior, Keychain restoration, signed/notarized
DMGs, clean-machine installation, physical controllers and real Xbox gameplay
remain alpha gates. The Cloud workflow checks Windows and macOS source execution
and unpacked packaging; it does not publish a release or establish those gates.

The MIT license and original third-party notice text are retained. Credentials,
local runtimes, dependencies, build output, logs and screenshots are excluded from
source publication. Source checks and CI do not require Microsoft credentials,
subscriptions, Apple signing credentials or paid services.

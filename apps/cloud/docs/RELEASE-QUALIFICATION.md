# Cloud release qualification

Qualify one immutable candidate at a time. Record its version, source commit,
artifact SHA-256, host OS/architecture, controller/transport, date and tester.
Keep credentials and account identifiers out of evidence. The owner's successful
use is useful feedback; it is not blanket qualification of every target.

## Current evidence

On 2026-10-15, the owner reported several hours of play on a Mac with an Xbox
controller, very good performance and no noticed network or gameplay issues
after the previous day's improvements. This is user-reported sustained Mac and
controller evidence. The exact app revision, Mac model, controller transport and
instrumented session report were not supplied; it does not qualify Windows,
every controller combination or clean signed installation.

Main at `c85b20afde82e3a3be981766ddcba232688c95e6` passed all four CI checks.
[Cloud CI](https://github.com/Arthur742Ramos/afterglide/actions/runs/38669949787)
passed 381 units per platform, unsigned unpacked packaging and zero audit
findings. Each platform completed 64 Electron journeys: 63 direct passes and
one automatic retry, plus one opt-in native Mac skip. Windows retried Health/zoom;
macOS retried Settings return. These are simulated sessions, not live benchmarks.

[PR #16](https://github.com/Arthur742Ramos/afterglide/pull/16) records an Apple
Silicon Fortnite smoke test at 1080p/60, user-confirmed audio/keyboard, native
fullscreen and a development-signed local DMG/Keychain restore. That certificate
was Apple Development; Gatekeeper distribution assessment rejected the artifact
and it was not notarized. It is not a public-install result.

[PR #39](https://github.com/Arthur742Ramos/afterglide/pull/39) records later Mac
Gears comparisons with a 30 FPS median and no freezes in healthy windows, a
later loss burst with freezes, native fullscreen/restore and a 411-sample export.
It does not establish sustained Windows performance or eliminate network loss.

Historical evidence applies to its recorded revision and environment. Recheck
the final candidate after packaging, authentication or streaming changes.

## Required before a public Windows/Apple Silicon beta

- [ ] Automated checks pass for the exact source and artifacts. Record direct
      passes, retries and skips separately; investigate recurring UI flakes.
- [ ] Build actual NSIS and arm64 DMG/ZIP payloads. Preserve SHA-256, source
      manifest, build logs, license/notices and package inventory.
- [ ] Owner provides approved signing configuration. Verify Windows publisher
      identity and Mac Developer ID, hardened runtime, notarization and stapling.
      Keep SmartScreen, Gatekeeper and other protections enabled.
- [ ] On clean approved machines, install normally, launch from Start/Applications,
      update an older candidate, quit/reopen and uninstall. Record leftover settings,
      credential and report behavior. Verify no administrator request is needed for
      the per-user Windows install.
- [ ] In each packaged app, verify fresh device-code login, secure restoration,
      expired/revoked sign-in recovery, sign-out and replacement account. Check
      packaged Keychain prompts. A fresh login is completed by the owner.
- [ ] Check at least the advertised controller/host/USB/Bluetooth combinations:
      navigation, analog controls, prompts, held release, hotplug, preferred device,
      local overlay and supported rumble. Publish actual results in the matrix.
- [ ] Record at least a 30-minute live session per supported platform, with
      received quality, frame timing, freezes, CPU, decoder evidence and missing
      readings. Test network interruption, offline return, sleep/resume, recovery
      cancellation and clean stream exit. No input-to-photon claim without a
      separate physical measurement.
- [ ] Check native fullscreen, blur/refocus, screen lock, close/reopen, keyboard,
      controller-only use, reduced motion, compact layouts and 200% zoom. Perform
      VoiceOver/Narrator checks; automated axe results are only part of this evidence.
- [ ] Review download/status, privacy, support, known issues and update/uninstall
      instructions against the tested candidate. Publish only the qualified platforms.

Intel Mac remains outside the initial supported-binary claim until actual x64
execution and these same checks pass. See [native details](NATIVE-QUALIFICATION.md)
and [controller protocol](CONTROLLER-COMPATIBILITY.md).

## Evidence record

Use one row per check and attach redacted evidence deliberately:

| Candidate commit / artifact SHA-256 | Platform and OS             | Check               | Result (pass/fail/untested) | Evidence / limitations                  |
| ----------------------------------- | --------------------------- | ------------------- | --------------------------- | --------------------------------------- |
| Not yet qualified                   | Windows x64 / Apple Silicon | Public distribution | Untested                    | Signing and clean-device checks pending |

The candidate workflow only prepares unsigned artifacts. Public release,
credential provisioning, account access and store submission require their own
owner authorization. No checklist entry is complete until its evidence exists.

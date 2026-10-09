# Local validation — 2026-10-09

This records the initial standalone preview. Its generated logs, screenshots and
installer are local evidence and are not committed or published. The integrated
app uses the complete repository, including root modules; the new Cloud workflow
checks it separately. This record does not establish Mac distribution readiness.

Host: Windows 10.0.26200, Node 24.14.0, Electron 43.7.7. Work ran sequentially with one unit/E2E worker. Native E2E windows were hidden, unfocusable and rendered offscreen; fullscreen requests were suppressed to preserve other work.

## Results

| Check                 | Result                                                                                                                                              | Evidence                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `npm run verify`      | Passed: formatter, TypeScript, 114 unit tests in 17 files, renderer/main/preload build                                                              | `artifacts/desktop-verify.log`                  |
| Unit suite            | 114 passed, 7.70 seconds                                                                                                                            | `artifacts/desktop-verify.log`                  |
| `npx playwright test` | 24 passed, 50.9 seconds                                                                                                                             | `artifacts/desktop-e2e-final.log`               |
| Accessibility         | Zero axe WCAG 2 A/AA and 2.1 AA violations on Library, Settings, Welcome, device-code, readiness, launch error and stream controls                  | `tests/e2e/cloud.spec.ts`                       |
| Layout                | Library tested at 1280×800 and 960×600 without horizontal overflow                                                                                  | `artifacts/e2e/cloud-library.png`               |
| Visual review         | Welcome, readiness, Library/search, sign-in, launch, controls, Settings and offline recovery inspected; controller and pending-state fixes verified | `artifacts/e2e/cloud-*.png`                     |
| Windows packaging     | NSIS x64 installer and unpacked app built, publishing disabled                                                                                      | `artifacts/desktop-package-win.log`, `release/` |
| Attribution           | Packaged LICENSE and THIRD_PARTY_NOTICES.md are byte-identical to source, and source is unchanged from upstream                                     | ASAR extraction check; Git diff                 |
| Isolation             | Separate app name, appId, userData, demo data, IPC/preload/environment namespace; no Git remote or inherited release feed                           | Source and E2E identity/security check          |
| Demo launcher         | PowerShell parser check passed                                                                                                                      | `Start-Demo.ps1`                                |
| Development runner    | Patched runner started two harmless commands; both exited 0                                                                                         | `artifacts/dev-runner.log`                      |
| Packaged runtime      | Electron 43.7.7 loaded and constructed the auth SDK without network or credential access                                                            | `artifacts/package-runtime-final.json`          |
| Package contents      | Only seven required runtime libraries; npm, its unused dependencies and xbox-webapi absent; 542 archive entries                                     | `artifacts/desktop-package-check.log`           |

There is no ESLint configuration in the inherited project. Formatting and TypeScript are the available static checks; no separate lint result is claimed.

## Dependency advisory review

The high-severity audit gate now **passes**: zero vulnerabilities (including moderate/high/critical). See artifacts/audit-final.log and artifacts/audit-after-triage.json. The previous 31 high and five moderate package findings resolve to 13 distinct advisories across six leaf libraries, with inherited parent findings. [Dependency triage](docs/DEPENDENCY-TRIAGE.md) records every advisory, exact installed path/version, affected range, shipped status, bounded reachability assessment, chosen fix and test impact. Structured detail is artifacts/dependency-triage.json.

Reviewed fixes: Electron 43.7.7, shell-quote 1.12.0, stable xal-node 1.1.4 after comparison of used APIs/shared code, and pinned @electron/get 5.1.0 with matching override. The SDK change removes unused npm; the downloader change removes old cache/proxy-logger chains. No audit force update was used. A clean npm ci completed (364 installed packages, 33 seconds), followed by formatter, typecheck, 107 units, build and 17 Electron journeys. The final desktop pass then passed 114 units and 24 Electron journeys; its fresh audit is artifacts/audit-desktop.json. Both Electron and the builder resolve downloader 5.1.0. Its fresh official checksum-manifest download passed (7,610 bytes; Windows x64 artifact present), recorded in artifacts/downloader-proof.log. CI retains the audit gate.

The rebuilt archive contains only react, react-dom, scheduler, xal-node, commander, jose and uuid-1345. npm, its unused dependency tree and xbox-webapi are absent. Packaged Electron 43.7.7 loaded and constructed SDK 1.1.4 without invoking network methods or credential loading. Registry audit success and construction alone do not verify live authentication or overall release security.

## What the tests establish

The 24 Electron journeys cover first sign-in/readiness, direct Library landing, search/recent filters/paging, directional controller traversal and device choice, held-A release across screens, controller Back from sign-in/launch/error/recovery, cancellation and late replies, offline launch prevention/recovery copy, local input suspension, cloud reconnect, launch/catalog errors, unavailable accounts, preference persistence and security configuration. They run the actual Electron app with a mock platform adapter and simulated video/network telemetry. They do not establish successful Xbox streaming.

Inherited engine/unit tests cover short presses between rendering frames, congestion and bounded queues, neutral releases on blur/visibility changes/disconnect, profile/mapping and rumble preference selection, polling lifecycle, packet encoding, presentation cadence and sanitized diagnostics. New tests cover cloud-only auth/fallback, sign-out races, failed-session cleanup and overlapping launch rejection.

## CPU-only input measurement

A one-off benchmark bundled the unchanged packet encoder with esbuild and called `encodeGamepadPacketForTest` under Node 24 on this Windows host. After 10,000 warm-up calls, ten batches of 10,000 calls produced 38-byte packets. Median batch cost was **0.00106095 ms per packet**; maximum batch cost was **0.00139544 ms per packet**.

This measures serialization CPU cost only. It excludes Gamepad API sampling, timer scheduling, IPC, network, Xbox processing, decode, compositor and display. It is not input-to-photon latency and does not prove an improvement over another client. The default 4 ms polling interval is a requested timer interval; tests of its behavior use fake timers.

## Distribution and live gates

The preview installer is unsigned (`Get-AuthenticodeSignature`: NotSigned). Signing, clean-machine install/uninstall, Windows reputation handling and native fullscreen behavior need release validation. The installer was built, not installed on this shared machine.

Final installer: `release/Afterglide-Cloud-0.1.0-alpha.1-win-x64.exe`, 105,053,104 bytes. SHA-256: `52cbfab6825ad50ec0923b43998b0574502fd81195c2a4b616c7d4396b916baf` (also in `release/SHA256SUMS`). The unpacked runnable application is `release/win-unpacked/Afterglide Cloud.exe`.

macOS Intel/Apple Silicon packaging configuration and CI jobs are present, but no Mac build, execution, Keychain, signing, hardened-runtime, notarization or install check has run here.

Real Microsoft sign-in, Xbox catalog/signaling, gameplay, physical controller hotplug/rumble/mapping, Bluetooth/USB behavior and live input-to-photon latency remain unverified. A fresh login must be completed by the user through Microsoft's device-code flow. No subscriptions, paid services, account changes or public publication were performed.

## Screenshot delivery

Seven actual Electron screenshots are staged in artifacts/library as afterglide-cloud-demo-{library,search,sign-in,launch,controls,settings,reconnect}.png. Each visibly identifies demo/simulated data. The supported Library upload workflow reported that its upload action was unavailable before saving anything; no screenshot is claimed as saved to Library. The local batch is artifacts/library/upload-request.json, with the failure in upload-error.log. No alternate/duplicate write was attempted.

## Desktop follow-up evidence

The seven additional Electron journeys establish native menu-to-renderer Settings/Search behavior before and after mock sign-in, global reduced motion, synchronized fullscreen state with a controller exit, actual Windows BrowserWindow geometry restoration after restart, foreground-only navigation with a simulated Gamepad API, primary actions at 150%/200% zoom, and Chromium-emulated 2x pixel density. The density check is a Windows rendering simulation, not a Mac Retina run. Fullscreen enter/leave events and requests are simulated in hidden tests, not real OS fullscreen transitions.

The installer includes the custom per-user welcome page and configured Start menu shortcut. Its actual signature remains NotSigned even though the builder logs its signing-stage hooks. Metadata and SHA-256 are recorded in artifacts/desktop-installer.json. Package inventory again passed: 542 entries, seven required runtime libraries, unchanged attribution and no npm/xbox-webapi. The packaged auth SDK was constructed without network calls or credential reads.

Official Impeccable 4.5.2 was installed via the copy-only skill-installer workflow and its text playbooks were used. Its separate engine binary and hooks were not run. See [desktop checklist and exact platform gates](docs/DESKTOP-POLISH.md).

The refreshed seven screenshots in artifacts/library show the final desktop UI and visibly label simulated data. Read-only availability discovery through the unchanged official Library helper still returned "Library prepare_uploads is not available" with zero writes; evidence is artifacts/library/availability-desktop.json. No upload retry, alternate route or separate prepare/finalize action was attempted after that result.

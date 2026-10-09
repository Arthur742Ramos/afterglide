# Cloud-only implementation

Base: Arthur742Ramos/afterglide main be70e1d62182522c787312dbd8e0b62e6a4534a1. No repository AGENTS.md or .agents/skills files were present. Cloud now lives under apps/cloud as an optional app. The original root app and its identities, console features, data, updater and packaging are preserved. MIT license and upstream notice text are retained.

Unchanged controller/input, frame/media metrics, controller settings, network policy, recovery, device metrics and performance-report modules are imported from the root source through small Cloud entrypoints. The root app needs no new imports or runtime behavior. Cloud authentication, credential SDK, contracts, lifecycle and renderer bridge remain isolated. The stream engine still has its own signaling bridge; sharing it requires a deliberate transport interface and checks for both apps.

## Changes

- Library is the initial page; console discovery, wake, home launch, home navigation and IPC contracts are removed.
- Auth uses Msal.getGssvToken() then getStreamToken(..., "xgpuweb"), with the library's xgpuwebf2p fallback. It never calls the combined xHome-dependent method or acquires Smartglass web credentials. Cloud refresh respects lifetime and sign-out generation.
- App name, appId, Windows identity, userData directory, environment flags, preload API and IPC namespace are separate. A new Microsoft login is required. No credential imports or security-setting changes are performed.
- No upstream update feed is used; publishing is disabled. Windows/macOS package workflows use read-only repository permissions and never publish releases.
- Search, recent filtering, paging, persistent selection, refresh, cloud readiness and clear unavailable-account states support a short flow.
- Failed starts clean up provisioned sessions. Cancellation, resume and bounded recovery reuse upstream logic, including late-reply protection. Reconnection creates a new session; state preservation depends on Xbox and the game.
- Quality is automatic. Platform identity stays desktop regardless of a legacy stored display preference. The inherited resolution field remains for settings/report compatibility, and does not enforce server resolution.

## Controller flow review

- Every authentication, launch, error and recovery screen supports controller Back; cancellation rejects late provisioning replies.
- Controller selection uses focusable buttons. Directional focus prioritizes aligned rows/columns, including wrapped groups. Held A/B must be released after a screen/controller change.
- Search results remain visible while typing; all launch entry points reject offline starts. Offline recovery explains the consequences of a new Xbox session.
- Every captured demo surface labels simulated authentication, games and measurements. Pending sign-in copy waits for an actual device code before displaying expiry.
- The stable auth SDK 1.1.4 removes its unused npm dependency tree. The reviewed Electron downloader 5.1.0 replaces vulnerable build-only chains; the audit gate remains enabled. See DEPENDENCY-TRIAGE.md.

## Input and performance

The established WebRTC engine, profiles, rumble dispatch, schema, changed-frame delivery, heartbeat and queue limits remain. Responsive polling defaults to 4 ms: a requested timer interval, not a measured latency bound. Browsers and operating systems schedule actual delivery.

Telemetry is sampled once per second; its IPC path retains measurements without cloning and rebroadcasting full application state. Frame interval p95/p99, dropped frames, freezes, decode time, queue bytes and recovery duration are available when reported. These do not measure input-to-photon latency or establish an advantage over another client.

## Remaining gates

- Real Xbox sign-in, catalog, provisioning, SDP/ICE and gameplay are untested locally. The user must complete any fresh login through Microsoft's supported flow.
- Physical Xbox, DualSense, Switch Pro, Bluetooth and USB controller navigation, hotplug, mapping, rumble and focus transitions require tests on each platform.
- Windows installer construction and clean-machine install are distinct checks. Signing/reputation must be addressed through normal distribution processes.
- macOS Intel/Apple Silicon execution, Keychain, hardened runtime, signing, notarization and installation need Mac validation. Configuration alone is not proof.
- Live latency testing must record game/account/region, hardware, network, stream stats and repeatable physical input-to-photon measurement. Compare clients on equivalent routes and sessions; do not infer a network/server win from mocks.

No paid services, subscriptions, store submission, permission changes or public repository creation are included.

# Architecture

Afterglide Cloud uses Electron main-process authentication and signaling, a typed sandboxed preload bridge, and a React renderer with direct WebRTC media and controller input.

Microsoft and Xbox credentials stay in the main process and persist only through OS-backed Electron safeStorage encryption. The renderer receives device codes, catalog metadata, session IDs and public diagnostics. It never receives auth tokens.

PlatformService covers cloud authentication, catalog, session provisioning, SDP/ICE exchange, keepalive and stop. There is no console discovery, Smartglass, wake or xHome port. Cloud auth uses the library's GSSV and cloud-offering methods directly.

The controller owns session state, cancellation generations, bounded payload validation and recovery. The established stream engine delivers video directly to media elements and maintains a bounded controller transition queue. High-frequency telemetry is retained without broadcasting full snapshots, with performance UI hidden by default.

Production denies window opening, untrusted navigation and permission requests; context isolation, sandboxing, web security, restrictive CSP and trusted-sender IPC validation remain enabled. The demo/mock service and test bridge are enabled only by an unpackaged main-process test mode.

See CLOUD-FIRST.md for the project changes and outstanding platform/live validation gates.

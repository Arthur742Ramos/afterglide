# Cloud overview captures

These are unaltered PNG captures of the actual Cloud Electron app on Windows,
at 1280×800. The app ran hidden/offscreen through existing deterministic E2E
fixtures, with separate temporary data and no Microsoft credentials or Xbox
connection. Each selected image visibly labels demo/simulated data.

Capture source: `aeb9d9e3bc1d5fdfe7f058284abe2bfd4b804127` (2026-10-15).
Subsequent PR #40 changes concern the packaging guard and have no UI/runtime
source changes. Electron 43.7.7, Node 24.14.0. No pixel editing or compositing was
performed. These images do not establish Mac rendering or live streaming.

| File                | Existing journey                                                   | What it shows                                                    |
| ------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `welcome-demo.png`  | first sign-in leads directly to cloud readiness and Library        | Signed-out welcome, sign-in action and independent-client notice |
| `library-demo.png`  | accessible library and settings fit desktop sizes with no overflow | Recent game, catalog, search, navigation and demo notice         |
| `controls-demo.png` | controller play, directional local controls and return to Library  | Local controls over simulated media; Xbox input paused           |

The four selected capture journeys passed directly. A search capture was excluded
because it still showed a pending-search message. Keep future captures current,
stable and free of account details/device codes. Preserve the visible demo label
when reusing these images; do not present them as gameplay or performance proof.

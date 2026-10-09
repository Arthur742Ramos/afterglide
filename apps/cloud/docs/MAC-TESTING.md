# Mac test path - inspected 2026-10-09

The source demo is the shortest current route. Local Windows validation did not perform a Mac build, runtime test, DMG installation, Keychain sign-in or Xbox gameplay. The Cloud CI workflow separately checks macOS source/mock execution and unpacked packaging. Its results do not establish a signed/notarized DMG, hardware behavior or live Xbox compatibility. The Windows `.exe` cannot be installed on macOS.

Subsequent local validation on 2026-10-09 used an Apple Silicon Mac (arm64), macOS 27.2 and a Retina display with scale factor 2. Native Node 24.14.0/npm 11.9.0 was installed from the checksum-verified official archive, followed by a fresh `npm ci`. Formatting, type checks, 124 unit tests, the production build, 24 simulated Electron journeys and the opt-in native Mac fullscreen/window-restoration test passed. `npm audit --audit-level=high` reported zero vulnerabilities. Real Microsoft sign-in, the cloud catalog and a Fortnite stream reached 1920x1080 at 60 FPS; the user confirmed audio and keyboard input. This is a short live smoke test, not a sustained performance benchmark. The hardware panel reported disabled_software video decoding and the actual decoder identity was unavailable. Physical controllers, Intel execution and notarized distribution require separate evidence.

Live testing also caught catalog artwork/name joins failing when the response used Store IDs as object keys and omitted `StoreId` inside each product. Cloud now retains those keys. Large libraries hydrate at most four batches concurrently, retry read-only catalog requests and recover failed bulk responses in smaller pieces. Recently played titles are requested first, and each completed batch makes its named games available immediately while the remaining library loads in the background. The smaller RemoteLowJade0 field set returns the title, publisher and artwork needed by the library with less payload. Search queries Microsoft’s catalog independently, follows continuation pages and joins results against the complete authenticated cloud title list, so it can find and launch games whose background batch has not loaded. Search failures are distinct from an empty result. Session-creation POSTs remain single-attempt. Regression tests cover the live Fortnite response shape, a burst-limited large catalog, transient failures and bulk-response rejection. The image origin allowlist and renderer CSP remain unchanged.

## Source demo

Use native Node 24.14.0 and its bundled npm, a clean copy of the complete Afterglide repository, including root src and apps/cloud, Terminal and internet access for dependency/Electron downloads. Node 24.14.0's official prebuilt Mac binaries require macOS 13.5 or newer on Intel and Apple Silicon ([platform matrix](https://github.com/nodejs/node/blob/v24.14.0/BUILDING.md#platform-list)). This is the developer-tool requirement; Electron 43 itself lists Monterey/macOS 12 and newer. The product's actual minimum operating system still requires Mac validation.

From apps/cloud inside the repository:

```sh
node --version
node -p "process.arch"
npm ci
npm run build
npm run start:demo
```

Use `arm64` Node on Apple Silicon and `x64` on Intel. The demo uses the mock platform adapter and simulated games/video/network readings. No Microsoft account, Xbox subscription or Apple signing credentials are needed for this source demo path. Basic navigation can use keyboard/mouse. Controller hardware must be tested separately.

Do not transfer Windows `node_modules`, `.runtime`, `dist`, credentials or installed application data. Fresh `npm ci` selects Mac dependencies; the lockfile contains both Darwin architecture variants. It resolves packages through a public Azure DevOps npm mirror. Anonymous initial-range GETs for the two esbuild Darwin packages returned HTTP 206 on this Windows host, recorded in `artifacts/mac-dependency-route.json`; this is limited network evidence, not a complete Mac dependency installation.

Optional source checks are `npm run verify` and `npm run test:e2e`. Playwright's Electron tests use the project's Electron executable, mock authentication and hidden windows; no separate browser installation is configured. A passing Mac mock suite would still leave real fullscreen, Dock lifecycle, physical controllers and Xbox streaming to test.

On a Mac, run `npm run test:mac-native` for the separate native-window regression test. It opens a visible mock window, enters actual OS fullscreen, exits with Escape, resizes the window and verifies its placement after restart. It runs only when explicitly enabled by that command, so the ordinary background suite does not take over the display. This test caught an explicit `fullscreen: false` option disabling fullscreen capability on macOS. Windowed launches now omit that option and retain native fullscreen capability.

For live Xbox testing, quit the demo and run `npm start`. The user must complete Microsoft's device-code sign-in and meet Xbox's account, game, subscription and region requirements. Do not transfer the Windows encrypted credential store. Mac restoration uses Electron safeStorage/Keychain; source restarts restored the connected account in the local smoke test. Packaged identity prompts and clean-machine installation remain separate checks.

## Smallest drag-and-drop build

For one local development DMG matching this Mac's architecture, after `npm ci`:

```sh
npm run package:mac:local
```

The command uses the native Node architecture. Expected configured artifact names are `release/Afterglide-Cloud-0.1.0-alpha.1-mac-arm64.dmg` and the corresponding `mac-x64.dmg`. The DMG layout places the app beside an Applications shortcut. After a validated signed/notarized build, users open the DMG and drag the app to Applications; the packaged application carries Electron's runtime and does not require Node. Packaged apps use live authentication and ignore demo environment flags.

This local command retains the project's Electron Builder packaging, signing and hardened-runtime configuration, but never notarizes or publishes. On macOS 27 and newer it stages the signed app and the Applications shortcut from the configuration, then uses `diskutil image create from` to create the DMG without mounting a temporary writable volume. macOS strips .DS_Store when creating an image from a folder, so this development DMG uses Finder’s default layout rather than the configured icon coordinates. The app, Applications shortcut and volume name were checked in a read-only mount. No separate Python installation is needed. On the tested Mac, the legacy builder's clean-eject step repeatedly failed because Microsoft Defender's DLP agent held the temporary volume open, even with a longer wait. Defender and security settings were not changed. Earlier macOS versions use the ordinary Electron Builder DMG path.

The existing `npm run package:mac` builds four separate artifacts: Intel DMG/ZIP and Apple Silicon DMG/ZIP. It does not produce a universal binary. Native builds/tests on each architecture provide stronger evidence than cross-packaging on one Mac ([builder guidance](https://www.electron.build/v26/docs/mac/)).

DMG creation uses bundled architecture-specific dmgbuild tooling plus macOS utilities such as hdiutil and sips; no standalone Python installation is configured. The source demo uses prebuilt Node/Electron rather than compiling either framework. Signing/notarization requires Apple tooling, an authorized Developer ID identity and notarization credentials. Those must be supplied by the owner on an approved Mac runner; no credentials were requested or accessed here.

## Remaining platform assumptions

- `Start-Demo.ps1` and the workspace's bundled Node runtime are Windows-only conveniences. Windows NSIS/elevation/shortcut configuration is scoped to Windows targets. npm scripts use cross-env and support Mac Terminal.
- Current builder 26.15.3 skips signing when it cannot find a certificate; it does not automatically select an ad-hoc identity. The project retains `hardenedRuntime: true`. An unsigned build may be blocked or fail to launch. Signing/notarization is required for an ordinary distributed Mac install; this guide provides no Gatekeeper or hardened-runtime bypass.
- The Cloud source CI workflow explicitly disables signing identity discovery during unpacked packaging and never publishes a release. Passing source/mock tests and unpacked packaging does not establish a normally installed, signed/notarized Mac artifact. See the exact commit checks on the Cloud pull request.
- Live signaling selects `macos` on Darwin and uses Electron's `process.getSystemVersion()` and bundled Chromium version instead of the inherited Windows/Chrome constants. A regression test checks metadata on the outgoing cloud-library requests. A non-Electron test host falls back to its OS kernel release and marks an unavailable Chromium version as unknown; no live compatibility success is inferred from this fix.
- Mac battery/thermal capture is unavailable in the current sensor adapter; it reports that Linux sysfs is required. Electron process CPU and stream/network measurements are separate. This does not require installing a privileged sensor helper.
- Intel execution, clean-machine DMG installation, Dock close/reopen, packaged Keychain prompts, physical USB/Bluetooth/rumble, notarized distribution and sustained real Xbox gameplay remain gates. Local Apple Silicon source execution, native fullscreen/window restoration and a short real Fortnite stream were verified as described above.

The original Mac source guide was prepared on Windows. Public alpha source integration does not include a Cloud binary release, paid services, account changes or security-setting changes.

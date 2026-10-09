# Mac test path - inspected 2026-10-09

The source demo is the shortest current route. No Mac build, runtime test, DMG installation, Keychain sign-in or Xbox gameplay has been performed. The delivered Windows `.exe` cannot be installed on macOS.

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

For live Xbox testing, quit the demo and run `npm start`. The user must complete Microsoft's device-code sign-in and meet Xbox's account, game, subscription and region requirements. Do not transfer the Windows encrypted credential store. Mac restoration uses Electron safeStorage/Keychain and remains unverified.

## Smallest drag-and-drop build

On an Apple Silicon Mac, after `npm ci`:

```sh
npm run build
npx electron-builder --mac dmg --arm64 --publish never
```

Use `--x64` on Intel. Expected configured artifact names are `release/Afterglide-Cloud-0.1.0-alpha.1-mac-arm64.dmg` and the corresponding `mac-x64.dmg`. The DMG layout places the app beside an Applications shortcut. After a validated signed/notarized build, users open the DMG and drag the app to Applications; the packaged application carries Electron's runtime and does not require Node. Packaged apps use live authentication and ignore demo environment flags.

The existing `npm run package:mac` builds four separate artifacts: Intel DMG/ZIP and Apple Silicon DMG/ZIP. It does not produce a universal binary. Native builds/tests on each architecture provide stronger evidence than cross-packaging on one Mac ([builder guidance](https://www.electron.build/v26/docs/mac/)).

DMG creation uses bundled architecture-specific dmgbuild tooling plus macOS utilities such as hdiutil and sips; no standalone Python installation is configured. The source demo uses prebuilt Node/Electron rather than compiling either framework. Signing/notarization requires Apple tooling, an authorized Developer ID identity and notarization credentials. Those must be supplied by the owner on an approved Mac runner; no credentials were requested or accessed here.

## Remaining platform assumptions

- `Start-Demo.ps1` and the workspace's bundled Node runtime are Windows-only conveniences. Windows NSIS/elevation/shortcut configuration is scoped to Windows targets. npm scripts use cross-env and support Mac Terminal.
- Current builder 26.15.3 skips signing when it cannot find a certificate; it does not automatically select an ad-hoc identity. The project retains `hardenedRuntime: true`. An unsigned build may be blocked or fail to launch. Signing/notarization is required for an ordinary distributed Mac install; this guide provides no Gatekeeper or hardened-runtime bypass.
- The package CI workflow explicitly disables signing identity discovery and has not run. Its presence is not evidence of a launchable or notarized Mac artifact. No workflow was dispatched or repository published.
- Live signaling selects `macos` on Darwin, but `deviceInfo()` in `src/main/live-platform-service.ts` still contains the inherited static Windows version `22631.2715` and Chrome `119.0` metadata. This needs review in the real Mac signaling pass; no compatibility success or restriction workaround is inferred from it.
- Mac battery/thermal capture is unavailable in the current sensor adapter; it reports that Linux sysfs is required. Electron process CPU and stream/network measurements are separate. This does not require installing a privileged sensor helper.
- Intel/Apple Silicon execution, actual DMG installation, Dock close/reopen, Keychain prompts/restoration, native fullscreen, USB/Bluetooth/rumble, signing/notarization and real Xbox gameplay are still gates.

The local correction was documentation-only. No Mac build or install, paid runner, account change, security-setting change or publication was performed.

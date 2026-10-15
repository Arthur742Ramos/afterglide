# Get started on Mac or Windows

Afterglide Cloud brings your Xbox cloud library to a desktop app. You need a
Microsoft account with Xbox Cloud Gaming access in your region; Xbox determines
which games are available. A controller is recommended. You do not need to set
up console discovery or remote play.

## Choose your route

| Route                   | Use it for                                                 | Where to start                                   |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| Source alpha            | Run on your own Mac or Windows PC, or explore the demo     | [Build and open](#build-and-open) below          |
| Unsigned test candidate | Test a specific build on an approved qualification machine | [Download and release status](RELEASE-STATUS.md) |

There is no supported public Cloud installer yet. The root project's Linux
AppImage installs the original Afterglide app. Keep OS protections enabled;
unsigned candidates have not passed public distribution checks.

## Build and open

Install Node.js 24 or newer and Git, then use Terminal on Mac or PowerShell on
Windows. Keep the complete repository: Cloud shares modules with the root app.

```sh
git clone https://github.com/Arthur742Ramos/afterglide.git
cd afterglide/apps/cloud
npm ci
npm run build
npm start
```

Already have the checkout? Start in `apps/cloud` and run the last three commands.
On Mac, use native Node for your architecture and install dependencies on that
Mac. Do not copy `node_modules` or credential stores between machines. See
[Mac setup](MAC-TESTING.md) if you need help with the development environment.

To look around without a Microsoft login or subscription, close the app and run:

```sh
npm run start:demo
```

The demo visibly labels simulated games, sign-in, video and measurements. It
never connects to Xbox. Packaged apps ignore demo flags.

## Open a test installer

Retrieve the artifact from the recorded candidate Actions run. Extract its outer
ZIP and check `candidate.json` for the expected source commit, version and target.
Compare the installer with `SHA256SUMS` before using it. Matching checksums detect
changed bytes; they do not establish publisher trust or installation safety.

| Machine           | Candidate file                             | Open after installation                |
| ----------------- | ------------------------------------------ | -------------------------------------- |
| Windows x64       | `Afterglide-Cloud-<version>-win-x64.exe`   | **Afterglide Cloud** from Start        |
| Apple Silicon Mac | `Afterglide-Cloud-<version>-mac-arm64.dmg` | **Afterglide Cloud** from Applications |

The Windows installer offers a per-user directory chooser and Start shortcut.
On Mac, the DMG presents the app and an Applications shortcut. If Windows or
macOS blocks a candidate, stop and use the source route or report it through
[support](../SUPPORT.md); do not bypass OS protections. Developer ID signing,
notarization and clean-machine installation remain pending. Intel Mac execution
is not qualified by the Apple Silicon candidate.

For maintainers building locally, `npm run package:win` produces Windows x64 NSIS;
`npm run package:mac` targets Mac x64 and arm64 DMG/ZIP. Build on the relevant OS.
These commands do not publish a release. See [release qualification](RELEASE-QUALIFICATION.md).

## Sign in and play

1. Choose **Sign in with Microsoft**. Open Microsoft's link in your browser and
   enter the one-time code shown by the app. Your password stays in the browser.
2. Review the first-run check for cloud availability, encrypted sign-in storage
   and controller detection. Wake or connect your controller; press a button if
   it is not detected. You can continue to Library and recheck later.
3. Search or browse **Library**, choose an eligible game and select **Play**.
   During play, open local controls to adjust volume, picture fit or fullscreen.

Settings and encrypted sign-in storage belong to Afterglide Cloud, separately
from the original app. If secure storage is unavailable, follow the readiness
message; sign-in may need repeating after restart. See [privacy](../PRIVACY.md).

| Action                          | Keyboard                | Controller            |
| ------------------------------- | ----------------------- | --------------------- |
| Move through the app            | Arrow keys or Tab       | D-pad or stick        |
| Select                          | Enter                   | A                     |
| Return from Settings or Health  | Escape                  | B                     |
| Open local controls during play | Escape                  | L3 + R3 by default    |
| Search / Settings               | Ctrl/Cmd+F / Ctrl/Cmd+, | Navigate from Library |

Local controls pause game input while open. The overlay shortcut can be changed
in Settings. See [controller compatibility](CONTROLLER-COMPATIBILITY.md) for
device and transport limits.

## Update or remove

Cloud has no automatic installer update or approved public upgrade path yet.
Follow [release status](RELEASE-STATUS.md) for the next candidate. Installation,
upgrade and uninstall behavior still need clean-machine qualification.

Sign out before removing the app to clear saved sign-in material. On Windows,
use Installed apps; on Mac, quit the app and remove it from Applications.
Preferences and exported reports can remain. See [privacy](../PRIVACY.md) for
local data and [known issues](../KNOWN-ISSUES.md) for current alpha limits.

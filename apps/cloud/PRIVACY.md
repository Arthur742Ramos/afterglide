# Privacy and local data

Afterglide Cloud is an independent desktop client. Microsoft handles sign-in and
Xbox Cloud Gaming. Your Microsoft password is entered on Microsoft's site, not
in this app. Microsoft and Xbox receive the account, catalog and streaming
requests needed to provide their services, including the connection's network
address. Their own privacy terms apply to those services.

## On this computer

The app stores settings, window placement and encrypted sign-in material in its
own `Afterglide Cloud` application-data directory. It does not read the original
Afterglide app's data. Settings can include the selected game and controller
profiles keyed by the browser's controller identifier. Those identifiers are not
guaranteed to identify a unique physical controller.

Sign-in material stays in the main process and is persisted only when Electron
reports a supported OS encryption backend. The renderer does not receive tokens.
If secure storage is unavailable, Health explains the limitation. Microsoft may
require sign-in again after credentials expire or the stored session cannot be
restored.

Sign out in Settings to clear saved sign-in material and the current account's
catalog. This signs out this client; it does not delete your Microsoft account.
Preferences and reports you already exported remain. Close the app before
manually removing its application-data directory. Clean uninstall behavior is
still part of [release qualification](docs/RELEASE-QUALIFICATION.md).

## Diagnostics and exports

Stream diagnostics stay in memory in a bounded report containing the latest
3,600 telemetry samples, plus bounded recovery and region-selection history.
The report can include stream timings, received resolution, codec/decoder
readings, Electron CPU usage, hardware model strings, requested settings and
supported OS power context. It does not record raw button history. Missing
measurements remain unavailable.

Export performance report in Health saves a new JSON file to Downloads. The app
does not upload it automatically. Exports exclude authentication data, account
names, console names/IDs, server session identifiers, network addresses and
controller IDs. Hardware strings and timestamps still describe your computer
and play session: inspect the file before sharing it. You decide when to delete
exported files; they remain after you close or sign out of the app.

Afterglide Cloud has no application analytics or automatic crash-report upload
service. Electron and the operating system may produce local logs or crash
files. Review any diagnostic material before attaching it to a public issue.
Never attach credential stores, device codes, tokens or an entire app-data folder.

When launching a cloud game, the client makes bounded, unauthenticated HTTPS
probes to official regional Xbox services for diagnostics. Probes carry no authentication tokens
and do not override Xbox's default region. Streaming and catalog connections
still use the credentials required by Xbox.

See [measurement definitions](docs/STREAMING-PERFORMANCE.md) and
[support](SUPPORT.md). Report suspected credential exposure through the private
route in [SECURITY.md](SECURITY.md).

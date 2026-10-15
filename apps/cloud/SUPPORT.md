# Afterglide Cloud support

Check [download and release status](docs/RELEASE-STATUS.md) and
[known issues](KNOWN-ISSUES.md) first. Cloud is an alpha preview with no supported
public binary release yet. The original Afterglide Linux download is a different
app.

## Before reporting a problem

- Sign-in: complete Microsoft's device-code flow in your browser. Check that
  your account, region and chosen game are eligible for Xbox Cloud Gaming.
  Never send anyone your password, device code or tokens.
- No games or failed search: check connectivity, use Refresh cloud library in
  Health, then retry. Xbox service availability and capacity can change.
- Controller: wake or connect it, then inspect Settings. Game input requires
  Chromium's standard mapping. Capability detection does not prove physical
  rumble support. See the [controller matrix](docs/CONTROLLER-COMPATIBILITY.md).
- Interrupted stream: follow the recovery screen or return to Library. A
  reconnect creates a new Xbox session and may not preserve game progress.
- Poor video: compare Automatic and Smooth on the same scene and connection.
  Smooth is experimental and can add input delay. Xbox controls stream quality;
  local settings cannot guarantee a server resolution, bitrate or latency.

For a reproducible client problem, use the
[Cloud bug form](https://github.com/Arthur742Ramos/afterglide/issues/new?template=cloud-bug.yml).
Include the app version, candidate/source commit if available, OS and architecture,
game, connection type, controller model/transport and exact steps. State whether
you used a source build, unsigned candidate or distributed installer. Do not
claim a device is qualified merely because it appears in Settings.

You can deliberately export a JSON performance report from Health. Read
[privacy and local data](PRIVACY.md), review the file and remove private material
before sharing it. A screenshot should hide your account details and device code.
Bug reports are public. Use [private security reporting](SECURITY.md) for suspected
credential exposure or other security flaws.

Feature suggestions belong in the
[Cloud feature form](https://github.com/Arthur742Ramos/afterglide/issues/new?template=cloud-feature.yml).
This community project has no response-time or service-availability guarantee.

## Updates and uninstall

Cloud currently has no release feed or automatic installer update. Follow
[release status](docs/RELEASE-STATUS.md) for the approved download path when one
exists. Do not install the root project's Linux release as a Cloud update.

See [installation](docs/INSTALL.md) for the current source and candidate routes.
Sign out before uninstalling if you want to clear saved sign-in material. Exported
reports in Downloads and preferences can remain; remove them deliberately after
closing the app. Clean-machine upgrade/uninstall checks remain unqualified.

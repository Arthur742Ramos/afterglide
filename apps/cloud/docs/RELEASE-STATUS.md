# Cloud download and release status

The Apple Silicon launch-fix beta is **0.1.0-beta.2**
(`cloud-v0.1.0-beta.2`). Download and publication state are available on the
[GitHub release page](https://github.com/Arthur742Ramos/afterglide/releases/tag/cloud-v0.1.0-beta.2).
The older beta.1 draft remains separate; its installers do not contain this fix
or the [October 25 renderer-recovery update](IMPROVEMENT-VALIDATION.md) now
included in main. The beta.1 signed/notarized images and owner upgrade were
validated on October 23, but those results do not qualify these new bytes.

Beta.2 starts the session heartbeat only after Xbox reports `Provisioned`.
Previously, a keepalive sent during provisioning could return HTTP 410 and cause
Afterglide to cancel a valid launch with `OPERATION_CANCELLED`. A live owner-Mac
source-build test reached Hellblade's main menu after this change. Regression
coverage holds provisioning open beyond two heartbeat intervals before verifying
that keepalives begin after provisioning. Packaged-artifact results and exact
hashes belong in the final release notes and manifest.

This is an early beta for Apple Silicon macOS. Developer ID signing, Apple
notarization and stapling must pass for the published installers. Those checks
establish distribution trust; they do not replace clean-machine installation,
fresh/replacement-account, physical-controller, sustained recovery, accessibility,
or Intel/Windows qualification. Release notes explicitly list unperformed checks.
See the [Mac release procedure](MAC-RELEASE.md) and
[qualification checklist](RELEASE-QUALIFICATION.md).

Electron is updated to 43.8.1 and downloader dependencies to undici 6.29.1/7.30.1
to address the high-severity advisories reported during this release. The six
propagated moderate builder/fast-uri audit entries remain; no high-severity audit
exception is enabled. Both lockfiles use portable public npm registry URLs.

Windows and Intel Mac installers are outside this release. The root `v*` tags
and Linux AppImage belong to the original Afterglide app, not Cloud. Automatic
Cloud updates remain disabled; upgrades are manual. Preserve the previous app
and settings, and keep Gatekeeper and browser protections enabled.

[Install/source instructions](INSTALL.md) · [Known issues](../KNOWN-ISSUES.md) ·
[Support](../SUPPORT.md) · [Privacy](../PRIVACY.md)

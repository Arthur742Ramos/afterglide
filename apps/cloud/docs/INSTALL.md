# Windows and macOS installation

See [Cloud download and release status](RELEASE-STATUS.md) first. There is no
supported public Cloud installer yet. The root project's Linux release belongs
to the original Afterglide app. Cloud unsigned candidates are qualification
artifacts; do not disable OS protections to install them.

Use Node 24+, npm ci, npm run build, then npm start for local development.

npm run package:win creates a Windows x64 per-user NSIS installer with a directory chooser and an Afterglide Cloud shortcut. No package is published.

On macOS, npm run package:mac builds DMG and ZIP for x64 and arm64. Move the app to Applications through the standard DMG flow. Signing and notarization must be completed before general distribution.

Settings and encrypted credentials use a separate Afterglide Cloud application data directory. The app does not read original Afterglide data. First launch requires Microsoft device-code sign-in and Xbox cloud eligibility. Microsoft passwords are never entered into the client.

The unsigned local installer is a preview. Clean-machine installation, update/uninstall, macOS installation and live gameplay are separate gates.

The manual Cloud candidate workflow builds Windows x64 NSIS and Apple Silicon
DMG/ZIP test payloads, with checksums and an exact-source manifest. See
[release qualification](RELEASE-QUALIFICATION.md). It does not publish releases,
sign, notarize or enable the update feed. Intel packaging configuration is not
evidence of execution on Intel hardware.

Cloud has no automatic installer update. A supported download and manual upgrade
path will be documented before public distribution. Sign out before uninstalling
to clear saved sign-in material; preferences and exported reports can remain.
See [privacy](../PRIVACY.md), [support](../SUPPORT.md) and
[known issues](../KNOWN-ISSUES.md).

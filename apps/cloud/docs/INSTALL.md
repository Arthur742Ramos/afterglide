# Windows and macOS installation

Use Node 24+, npm ci, npm run build, then npm start for local development.

npm run package:win creates a Windows x64 per-user NSIS installer with a directory chooser and an Afterglide Cloud shortcut. No package is published.

On macOS, npm run package:mac builds DMG and ZIP for x64 and arm64. Move the app to Applications through the standard DMG flow. Signing and notarization must be completed before general distribution.

Settings and encrypted credentials use a separate Afterglide Cloud application data directory. The app does not read original Afterglide data. First launch requires Microsoft device-code sign-in and Xbox cloud eligibility. Microsoft passwords are never entered into the client.

The unsigned local installer is a preview. Clean-machine installation, update/uninstall, macOS installation and live gameplay are separate gates.

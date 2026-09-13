# Flatpak packaging

Afterglide currently produces an AppImage and compressed Linux application with
`npm run package:linux`. The application ID, desktop entry, icon, and AppStream
metadata are reserved in `data/` for the Flatpak milestone.

A Flathub manifest will be published after the packaged application passes these
checks on both LCD and OLED Steam Deck hardware:

- controller navigation in Gaming Mode;
- Microsoft device-code authentication with an encrypted Secret Service backend;
- console discovery, wake, and a 30-minute home-stream session;
- Chromium hardware video decoding inside the sandbox;
- resume behavior after sleep and a network handoff; and
- no filesystem access outside app-owned storage.

Publishing the manifest before these checks would imply a supported installation
path that the project has not yet verified.

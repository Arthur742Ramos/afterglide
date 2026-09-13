# Flatpak packaging

The application ID and AppStream metadata are reserved in `data/`. The full
manifest will land after the media spike fixes the required GStreamer plugins and
runtime permissions. Publishing an incomplete manifest would create a misleading
installation path and make hardware-decoding tests unreliable.

The first installable artifact must prove:

- controller navigation in Steam Deck Gaming Mode;
- secure browser-based authentication return flow;
- console discovery on the local network;
- VA-API decoding inside the sandbox; and
- read-only access outside app-owned storage unless explicitly requested.


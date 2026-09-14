# Afterglide Design System

## Overview

Afterglide is used in a dim living room while the player holds a Steam Deck at
arm's length. The visual system resembles a pre-dawn flight deck: near-black
architecture, crisp pale instrumentation, and a controlled cobalt signal.

The color strategy is restrained. Color communicates focus, connection, and
health; it does not decorate inactive surfaces.

## Color Palette

All source tokens use OKLCH. Platform-specific UI files may contain equivalent
converted values when their renderer does not parse OKLCH.

| Token | Value | Use |
|---|---|---|
| Background | `oklch(0.105 0 0)` | Window and streaming void |
| Surface | `oklch(0.165 0.014 258)` | Navigation and primary panels |
| Surface raised | `oklch(0.215 0.018 258)` | Selected console and overlays |
| Ink | `oklch(0.972 0.010 258)` | Primary text |
| Muted | `oklch(0.735 0.030 258)` | Secondary text |
| Primary | `oklch(0.681 0.132 258.4)` | Focus, primary actions, progress |
| Accent | `oklch(0.790 0.145 70)` | Wake and attention states |
| Success | `oklch(0.775 0.125 162)` | Online and healthy state |
| Danger | `oklch(0.665 0.190 25)` | Blocking failures and disconnect |

## Typography

Use Inter where it is bundled and `system-ui` as the fallback. The interface uses
one family in weights 400, 500, 600, and 700. Default body text is 18 px on the
Deck's 1280×800 viewport. Primary actions are at least 20 px. Supporting text is
never smaller than 14 px.

## Layout

The default viewport is 1280×800. A compact rail reserves 96 px at the left, the
main action area uses the center, and connection context sits at the lower edge.
Primary controls have at least 56×56 px touch targets and 12 px separation.

At narrower sizes the rail becomes a bottom bar. At wider docked sizes the
content width remains bounded so focus travel does not become excessive.

## Components

- **Focus halo:** a 3 px cobalt outline plus a restrained outer shadow. It must
  remain visible on every surface and never rely on color alone.
- **Primary action:** solid cobalt, pale text, 16 px radius, and a minimum height
  of 64 px. Loading preserves the button dimensions.
- **Console stage:** one broad surface containing console identity, power state,
  network health, and the Play action. It is not subdivided into nested cards.
- **Status capsule:** compact icon, label, and optional value. Green means a
  verified healthy state; amber means work or attention; red means failure.
- **Stream overlay:** an opaque-enough surface for legibility over arbitrary video.
  It disappears when idle and returns immediately on controller input.

## Motion

Use 150–220 ms state transitions with an exponential ease-out. Focus movement may
combine a short translation with the halo change. Connecting state uses a subtle
progress sweep. Reduced-motion mode replaces movement with immediate state changes
or a short crossfade. Content is always visible before animation begins.

## Voice

Use short verbs and concrete state: “Play,” “Waking your Xbox,” “Starting video,”
and “Connection lost—trying again.” Keep protocol names and raw error codes inside
diagnostics.


## Desktop polish

The desktop uses lifted blue-black surfaces to preserve separation in dim rooms.
Primary buttons use dark ink on cobalt for contrast. Supporting labels stay at
14 px where space permits, with explicit hover, pressed, and controller-focus
states. Settings switches retain compact visuals with expanded touch areas.

The navigation mark matches the application icon. Console selection uses a
light or dark sculpted console silhouette, with a single rounded stage and no
colored side stripe. Authentication uses the same rounded panel geometry and
circular step markers. Compact 960×600 windows reduce the console illustration
and stage height; the main 1280×800 composition retains generous spacing.

## Stream controls

Quick settings appear only while Afterglide has captured local controls. Use one
legible panel over the video, not nested cards. Audio, fit/fill, and input-polling
choices use the existing button and focus vocabulary; visible state and labels
must not depend on color alone. Fit preserves the full image, while Fill clearly
discloses cropping. Smaller windows scroll the panel without hiding focused
controls or the route back to play.

Recovery copy distinguishes waiting for the network from attempting a new
connection and keeps End session available. It must not promise that a cloud game
will survive a replacement session. Diagnostic values show unavailable data
explicitly; performance export remains a deliberate local save action.

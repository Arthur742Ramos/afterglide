# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

React in an Electron desktop app for Windows and macOS.

## Users

Players browsing their eligible Xbox cloud games with a controller, keyboard or
mouse. They want to choose a game and play without configuring a streaming client
or navigating a console-remote-play workflow.

## Product Purpose

Afterglide Cloud focuses exclusively on Xbox Cloud Gaming on Windows and macOS.
The main journey is install, sign in securely, find a game and play.

## Positioning

A cloud-only desktop home that combines an authenticated Xbox game library,
controller-first browsing, direct WebRTC playback and local stream controls.
Console discovery and Xbox remote play belong to the original Afterglide app.

## Operating Context

The same Library supports quickly replaying a recent game and searching a large
catalog. Players may move between mouse, keyboard and controller, visit Settings,
and return to the same search, filter, page and focus.

The desktop reference is 1280x800, with compact-window and 200 percent zoom
coverage. The app must keep primary actions reachable when content scrolls.

## Capabilities and Constraints

Recently played follows Xbox's most-recently-used order. Selecting a game previews
it; an explicit Play action must also be available at the selected game, including
search results. Empty filtered searches must offer a way to broaden the scope
without discarding the query.

Xbox determines game availability, account/region eligibility, capacity and
negotiated stream quality. Advanced tuning stays outside the main play flow.
Reconnect can start a new session and may not preserve remote game progress.

## Brand Commitments

Keep the existing Afterglide Cloud name, restrained near-black/cobalt identity,
short action labels and concrete connection states. The visual authority is
[DESIGN.md](DESIGN.md).

## Evidence on Hand

Screenshots in `docs/images` use clearly labeled simulated games and measurements.
Electron journeys exercise the desktop UI with simulated authentication, games
and streaming. Owner-reported live Mac sessions and remaining qualification
boundaries are documented in [KNOWN-ISSUES.md](KNOWN-ISSUES.md); demos and automated
checks do not prove universal live performance or hardware compatibility.

## Product Principles

1. Install, sign in securely, choose a game and play through a short, clear flow.
2. Controller-first navigation, hotplug, correct mapping, neutral input on disconnect, focus handling and rumble where supported.
3. Keep client latency small through direct WebRTC video, bounded input queues and sensible polling. Profile hardware and live streaming before claiming improvements.
4. Explain unavailable accounts, interruption and Xbox capacity failures. Provide bounded recovery and a reliable path back to Library.
5. Keep advanced tuning out of the main play flow. Show actual diagnostics on request and label simulated measurements.

## Accessibility & Inclusion

Support controller, keyboard and mouse throughout the main journey, visible focus,
reduced motion and large-text layouts. Selection and connection state must not
depend on color alone. Recovery actions must leave focus on a reachable control.

The local preview does not claim perfect controller support or universal latency improvements. Xbox determines capability and eligibility. Live account, controller hardware, macOS and signed distribution checks remain necessary.

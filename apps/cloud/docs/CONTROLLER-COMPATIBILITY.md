# DualSense and Xbox controller qualification

Afterglide Cloud reads Electron's Chromium Gamepad API. The client accepts
`mapping === "standard"`; it does not guess a raw HID layout from a device name.
An unsupported mapping remains visible in Settings with game input disabled.
The browser owns transport-specific remapping. See the
[W3C standard layout](https://www.w3.org/TR/gamepad/#remapping) and
[Chromium's Windows mapping implementation](https://github.com/chromium/chromium/blob/main/device/gamepad/gamepad_standard_mappings_win.cc).

## Compatibility matrix

| Controller / host   | Connection                | Client path                                                | Physical qualification of this revision |
| ------------------- | ------------------------- | ---------------------------------------------------------- | --------------------------------------- |
| DualSense / Windows | USB data cable            | Standard Gamepad mapping; PlayStation local prompts        | Not performed                           |
| DualSense / Windows | Bluetooth                 | Same standard path when exposed by Chromium                | Not performed                           |
| DualSense / macOS   | USB data cable            | Same standard path when exposed by Chromium                | Not performed                           |
| DualSense / macOS   | Bluetooth                 | Same standard path when exposed by Chromium                | Not performed                           |
| Xbox / Windows      | USB data cable            | Standard Gamepad mapping; Xbox local prompts               | Not performed                           |
| Xbox / Windows      | Bluetooth-capable model   | Same standard path when exposed by Chromium                | Not performed                           |
| Xbox / macOS        | USB data cable            | Conditional on OS and Chromium exposing a standard gamepad | Not performed                           |
| Xbox / macOS        | Supported Bluetooth model | Same standard path when exposed by Chromium                | Not performed                           |

[Sony documents USB and Bluetooth support on Windows and macOS](https://www.playstation.com/en-us/support/hardware/pair-dualsense-controller-bluetooth/).
[Apple lists supported Bluetooth Xbox models](https://support.apple.com/en-us/111101),
including model 1708, Series X/S, Elite Series 2 and Adaptive Controller. These
manufacturer statements establish platform support, not this client's end-to-end
validation. The app's own supported OS/runtime requirements still apply.

The Windows worker's read-only present-device inspection on 2026-10-13 exposed
only Microsoft Hyper-V Input, with no physical Xbox or Sony controller available.
Synthetic IDs labelled USB or Bluetooth are reproducible fixtures, not evidence
of a real connection or its transport. Gamepad IDs identify a browser/model label;
they are not guaranteed unique serials. Identical IDs share preference/profile
settings; the current slot remains selected while it exists. A slot is not a
persistent physical identity. One selected pad is sent as Xbox player zero;
multiple connected controllers do not establish cloud local multiplayer support.

## Controls and feedback boundaries

For a standard DualSense, Cross/Circle/Square/Triangle correspond to Xbox
A/B/X/Y, L1/R1 to LB/RB, L2/R2 to LT/RT, Create to View and Options to Menu.
The local UI follows the selected controller's labels; streamed Xbox games keep
their own prompts. Stick axes, analog triggers and D-pad use the standard layout.
DualSense labels require a recognized name or vendor/product ID; anonymized or
unknown identifiers retain Xbox labels without changing their standard mapping.
Per-profile deadzones, trigger range and face-button swaps affect gameplay.
Local confirmation/back retain their physical bottom/right positions.

Focus loss, overlays, profile/device changes and disconnects release Xbox input.
Held controls require release before they are forwarded again. Keyboard controls
remain optional and independent. A brief transport interruption can resume in
place. Lost transport retains the existing Xbox session and heartbeat; this
version cannot reattach video after that transport is gone. Only the warned
explicit restart ends it and requests a new session, risking unsaved progress.
Controller reconnection does not guarantee remote recovery.

Ordinary two-channel vibration is attempted only when the exposed actuator
supports `dual-rumble`. Capability presence is reported as unverified, with
unsupported/rejected effects handled gracefully and reset attempted on lifecycle
changes. Visibility and connection can prevent reset; physical stopping is not
guaranteed by a rejected browser call. See the
[Gamepad haptics API](https://www.w3.org/TR/gamepad/#gamepadhapticactuator-interface).
USB/Bluetooth, OS, driver and Chromium versions can expose different capabilities.
A report's delay plus duration is capped at five seconds. Preempted effects are
not queued or replayed.

This client does not implement adaptive triggers, gyro, touchpad input, speaker,
microphone, headset routing, advanced Sony haptics or Xbox trigger motors.
Sony's game-specific PC USB haptic support does not establish this application's
support, and Sony documents advanced haptic feedback as unavailable on Mac.
No native HID access, permission bypass, pairing or driver change is used.

## Bounded hands-on gate

On each owner-provided device/host/transport combination, use the built source
revision and an already-connected controller. First spend five minutes in
signed-out Settings: confirm the exposed mapping, press each control, inspect
four axes and analog triggers, move through UI controls, and check preferred
selection with a second controller. Record OS, architecture, Electron version,
connection type and observed capabilities without serials or credentials.

In an already-authorized live session, spend ten minutes checking controls,
overlay open/close, blur/refocus, hotplug, same-model replacement, held release,
preferred-device disconnect and ordinary rumble. Include both USB and Bluetooth
where the device supports them. Verify that unsupported rumble leaves controls
usable. Do not change pairing, drivers or security settings to complete a gate.
Fresh authentication requires the owner's handoff. Sustained performance and
signed-installation checks remain in [native qualification](NATIVE-QUALIFICATION.md).

Unit and Electron fixture tests qualify client logic only. Add physical evidence
with the exact revision after these gates actually pass; do not mark this matrix
as validated from synthetic tests.

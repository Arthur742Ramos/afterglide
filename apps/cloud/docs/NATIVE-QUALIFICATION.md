# Native and live-stream qualification

Source checks and simulated streams qualify client behavior. They do not qualify
Xbox capacity, actual decode performance, physical controllers or distributed
installation. Record the exact tested commit for every gate below; passing an
older build does not qualify subsequent authentication or transport changes.

## Evidence boundaries

| Platform      | Existing evidence                                                                                                                                           | Still required                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Windows x64   | Source/mock Electron checks and unpacked packaging in CI                                                                                                    | Sustained live streaming, physical input/rumble, signed clean installation                                                                             |
| Apple Silicon | Source/mock CI and unpacked arm64 packaging; PR #16 records native fullscreen and a short real Fortnite 1080p/60 session with user-confirmed audio/keyboard | Recheck the campaign commit with sustained live streaming and interruption recovery; packaged Keychain/physical input and ordinary signed installation |
| Intel Mac     | Architecture-specific package configuration                                                                                                                 | Actual x64 execution and the same live, input and install gates                                                                                        |

An arm64 run or cross-packaged x64 artifact is not Intel execution evidence.
Unpacked packaging with signing disabled is not signed-installation evidence.
The short PR #16 session is useful compatibility evidence, not a sustained
performance distribution or proof of hardware decoding.

## Decode and sustained-session comparison

Use the same game, save position, region, network, display, requested quality and
controller connection for each comparison. On a dedicated host, record repeated
source and packaged launches separately, then run at least a 30-minute session
per comparison. Export the bounded local performance report deliberately.

Record observed resolution/FPS, negotiated codec, reported decoder, interval
decode/jitter-buffer costs, RTT/loss, frame-cadence distributions, freezes, input
queue and Electron CPU. Include sample counts, unknown fields, recovery intervals
and changes in settings. Do not substitute requested resolution for observation,
Chromium's GPU feature status for actual decoder identity, or frame cadence/RTT
for button-to-photon latency. Establish physical latency with a separate external
measurement setup if that claim is needed.

Compare medians and tails under matching conditions. Repeat an anomalous session
and preserve its evidence. Codec or platform-flag experiments belong in reversible
branches after measurements identify a bottleneck; this campaign does not force
codecs or change security settings.

## Interaction and interruption gates

- USB and Bluetooth controllers: navigation, preferred-device selection, hotplug,
  same-index replacement, held-button release and supported rumble.
- Focus loss, captured controls and fullscreen: neutral input, release/repress
  behavior, readable controls and keyboard parity on actual Windows/Mac desktops.
- Interrupted/repeated flows: cancel and relaunch, sign-out and replacement login,
  network loss/restoration, sleep/resume, recovery cancellation and session exit.
  A replacement cloud session may not preserve game progress.
- Check the supported compact/desktop sizes and 200% zoom with actual errors,
  missing artwork, settings-save failure and Settings return focus.

## Installation gate

On owner-approved clean Windows and Mac machines, verify signed artifacts,
publisher identity, ordinary installation, launch, uninstall, shortcuts/Dock,
fullscreen restoration and credential-store behavior. Mac distribution also
requires the approved Developer ID, hardened-runtime entitlements, notarization
and stapling checks. Signing credentials and new login/permission prompts require
the owner's authorized handoff; keep security protections enabled.

This is a qualification protocol, not a completed qualification report. No release,
purchase, new account access or security-setting change is authorized by this
document. Link completed evidence from [validation](../VALIDATION.md) only after
the corresponding gate has actually passed.

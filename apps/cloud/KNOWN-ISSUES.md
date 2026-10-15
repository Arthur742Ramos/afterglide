# Known issues and boundaries

Cloud is an alpha preview. The owner reports successful everyday use, and live
Mac sessions have been recorded. This feedback does not qualify every machine,
game, controller or network. See [current release status](docs/RELEASE-STATUS.md).

| Area                  | Current boundary                                                                                                                                                       | What to do                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installation          | No public Cloud binary release. Candidate artifacts are unsigned and are not qualified for ordinary installation.                                                      | Use the documented source route or an owner-approved qualification machine. Keep OS protections enabled.                                                                                     |
| Mac compatibility     | Apple Silicon has source/native and some live-stream evidence. Intel execution and clean signed installation remain unverified.                                        | Check the exact build and architecture; do not treat an arm64 result as Intel evidence.                                                                                                      |
| Controllers           | Synthetic Gamepad tests cover routing, prompts and input lifecycle. Physical USB/Bluetooth and rumble combinations remain unqualified.                                 | Use standard mapping and record actual host/device/transport results. Advanced Sony haptics, adaptive triggers, gyro, touchpad, controller audio and microphone routing are not implemented. |
| Smooth playback       | Smooth is experimental. Receiver buffering can reduce some disruptions and can increase input delay. Packet loss can still freeze video.                               | Compare Automatic and Smooth; preserve a report from the same scene/network.                                                                                                                 |
| Decode/performance    | Browser decoder fields may be unavailable. A prior Mac smoke test reported software decode status. CI does not prove hardware decoding or universal performance gains. | Measure the packaged candidate on the actual device.                                                                                                                                         |
| Recovery              | Automatic attempts are bounded. Reconnect starts a new Xbox session; remote progress is not guaranteed.                                                                | Use the recovery controls, or return to Library and relaunch.                                                                                                                                |
| Updates               | Cloud has no approved release feed yet.                                                                                                                                | Follow release status; manual upgrades will be documented before distribution.                                                                                                               |
| Automated UI evidence | Recent CI passed after retries in Health/zoom and Settings-return journeys. Native Mac fullscreen is an opt-in test.                                                   | Triage flakes and run the actual native interaction checks before qualification; a green retry is not a direct pass.                                                                         |

Xbox determines game availability, account/region eligibility, queue capacity and
negotiated resolution/FPS/bitrate. HTTPS region probes are diagnostics, not a
measurement of the active media route. No globally optimal region or perfect
latency claim is made.

[Report a reproducible issue](SUPPORT.md) or inspect the
[release qualification checklist](docs/RELEASE-QUALIFICATION.md).

# AFTERGLIDE

**Your Xbox. Wherever you land.**

Afterglide is an open-source, controller-first Xbox remote-play client designed
for Steam Deck. The project is currently **pre-alpha**: the native app shell and
session state machine are underway, while authentication and video streaming are
not implemented yet.

> Afterglide is an independent project. It is not affiliated with or endorsed by
> Microsoft, Xbox, Valve, or Steam.

## Why Afterglide

- Launch-to-play flow designed for Steam Deck Gaming Mode
- Native Rust application with a GPU-rendered interface
- Explicit focus navigation, large targets, and readable connection states
- Media boundary designed for GStreamer and hardware video decoding
- Performance budgets measured on real LCD and OLED Steam Deck hardware
- Flatpak distribution planned for one-step installation and updates

## Current vertical slice

The first slice contains a functional controller-oriented home screen backed by
a tested session state machine. It uses a simulated console so product work can
continue while the streaming adapter is built.

```bash
cargo run -p afterglide-desktop
```

Use the arrow keys to move focus, Enter to activate an action, and Escape to quit.
These inputs mirror the navigation actions that Steam Input will provide on Deck.

## Architecture

```text
Slint UI  ── user actions / view state ──►  afterglide-core
                                                │
                              ┌─────────────────┴─────────────────┐
                              ▼                                   ▼
                    Xbox protocol adapter                 media adapter
                    auth · discovery · input          WebRTC · GStreamer · VA-API
```

The UI never owns protocol or transport state. The core emits explicit commands,
and platform adapters report events back into the state machine. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Roadmap

- [x] Product brief, design system, native shell, and session state machine
- [ ] Steam Deck input adapter and on-device navigation test
- [ ] Microsoft authentication and secure token storage
- [ ] Console discovery, wake, and session negotiation
- [ ] GStreamer WebRTC playback with verified hardware decoding
- [ ] Audio, rumble, adaptive quality, and interruption recovery
- [ ] Flatpak packaging, Add to Steam flow, and public beta
- [ ] Cloud gaming feasibility and implementation

## Performance gates

| Measure | Initial gate |
|---|---|
| Cold launch to interactive home | Under 2 seconds on Steam Deck |
| Interface rendering | Sustained 60 fps |
| Client frame loss | Under 0.5% in a controlled 30-minute session |
| Decode path | Hardware acceleration verified inside the shipped Flatpak |
| Recovery | Resume or explain the failure after sleep and network interruption |

These are engineering targets, not current claims. Benchmark fixtures and raw
results will be published as the media path lands.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a change. Early work is
tracked in GitHub issues and grouped by milestone.

## License

MIT. See [`LICENSE`](LICENSE).


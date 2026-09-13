# Contributing to Afterglide

Afterglide is early. Before implementing a large feature, open an issue describing
the user-visible outcome and how it will be tested on Steam Deck.

## Development checks

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
```

Changes to the streaming path should include measurements taken under a described
network, console, and device configuration. Changes to normal user flows must be
usable without a mouse and preserve accessible roles and focus indicators.

Do not commit Microsoft credentials, authentication tokens, console identifiers,
IP addresses, or unredacted diagnostic bundles.


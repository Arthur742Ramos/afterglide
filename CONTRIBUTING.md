# Contributing to Afterglide

Afterglide is early. Before implementing a large feature, open an issue describing
the user-visible outcome and how it will be tested on Steam Deck.

## Development checks

Use Node.js 24 or newer, then run:

```bash
npm ci
npm run verify
npm run test:e2e
npm audit --audit-level=high
```

The end-to-end suite launches the real Electron application with a deterministic
platform adapter. It never needs Microsoft credentials or a console. Changes to
the live streaming path must also record the network, Xbox model, device, decoder
status, and session length used for manual verification.

Normal user flows must work with a controller and preserve accessible names,
visible focus, reduced motion, and keyboard parity.

Do not commit Microsoft credentials, authentication tokens, console identifiers,
IP addresses, or unredacted diagnostic bundles.

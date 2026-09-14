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
platform adapter. By default, native windows stay hidden and cannot take focus;
fullscreen requests are suppressed, including saved launch-fullscreen settings.
Offscreen rendering keeps animation frames and screenshots working independently
of native-window visibility, including under Xvfb. This applies
to both `npm run test:e2e` and direct `npx playwright test` runs. Electron still
requires a display server on Linux; use `xvfb-run --auto-servernum npm run test:e2e`
on a headless host, as CI does.

Only when you want visible windows for debugging, run `npm run test:e2e:headed`
(or set `AFTERGLIDE_E2E_HEADED=1` for a direct Playwright run). Playwright's
`--headed` flag alone does not control Electron windows. The background policy
applies only to unpackaged E2E runs, not normal development or packaged apps.

The suite never needs Microsoft credentials or a console. Changes to the live
streaming path must also record the network, Xbox model, device, decoder status,
and session length used for manual verification.

Normal user flows must work with a controller and preserve accessible names,
visible focus, reduced motion, and keyboard parity.

Do not commit Microsoft credentials, authentication tokens, console identifiers,
IP addresses, or unredacted diagnostic bundles.

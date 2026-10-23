# First official Mac release preparation

The planned first distribution is **Afterglide Cloud 0.1.0-beta.1**, Apple Silicon
only, with tag **cloud-v0.1.0-beta.1**. It is a beta, not a stable release.
The version bump reserves its identity; it does not mean that a release exists.
The original root `v*` tags continue to belong to the Linux app.

The application baseline is reviewed main
`b0fa39eb4675c938d199a5aa673cec3f3e302504`, including recent library navigation,
input-stall handling and Xbox session preservation. A release must use the final
reviewed preparation commit, not the older baseline hash. Do not include dirty
worktrees or open, unreviewed changes. The runtime update feed remains disabled;
this first release uses a manual upgrade.

## Current blockers (2026-10-23)

- The owner's Mac has valid Apple Development and Apple Distribution identities,
  but no Developer ID Application signing identity. Apple Distribution is not the
  Developer ID identity required for this direct-download release.
- The repository has no Actions secrets or variables configured. Hosted signing
  and notarization cannot run. No credentials were created, exported or uploaded.
- No final signed artifact exists yet. Clean download/install, upgrade with
  settings and Keychain restoration, physical controller, and sustained live
  interruption-recovery qualification must be completed on those exact bytes.

The existing installed alpha and running install-test copy must remain intact
while preparation proceeds. Do not stop a game, sign out, replace an active app,
reset its profile or accept a new Keychain/permission/legal prompt automatically.

## Signing configuration

An owner must provision approved existing credentials through a secure path.
Creating/exporting certificates, generating an app-specific password or expanding
credential access requires separate explicit authorization. Never put values in
issues, PRs, workflow input fields, logs or committed files.

The workflow expects these GitHub Actions repository secrets:

| Secret                                  | Purpose                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `CLOUD_MAC_CSC_LINK`                    | Base64 PKCS#12 containing the approved Developer ID Application certificate/private key for team `72GY62F838` |
| `CLOUD_MAC_CSC_KEY_PASSWORD`            | Password protecting that PKCS#12                                                                              |
| `CLOUD_MAC_APPLE_ID`                    | Approved notarization account                                                                                 |
| `CLOUD_MAC_APPLE_APP_SPECIFIC_PASSWORD` | Approved existing app-specific notarization password                                                          |

The locked electron-builder 26.15.3 supports this credential route and creates a
temporary signing keychain on the disposable hosted runner. This setup is not
presently configured. No local keychain is changed by preparation. The pipeline
does not run on pull requests and accepts only an exact reviewed `main` SHA.
Missing credentials, a wrong publisher, an ad-hoc/development signature or a
failed notarization stops it; there is no unsigned fallback.

Apple documents [Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
and [notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

## Hosted validation and artifact path

1. Review and merge the preparation changes. Wait for root CI and Cloud desktop
   checks to pass on that exact merged commit. CI covers Windows and native
   Apple Silicon; it does not make Windows an advertised release target.
2. Dispatch **Cloud Mac release preparation** on `main`, with its complete
   40-character `expected_sha` and `cloud-v0.1.0-beta.1` as `release_tag`.
3. The native hosted Mac repeats format/type/unit checks, audit and simulated
   Electron journeys, then signs/notarizes the app and builds arm64 DMG/ZIP.
   The final DMG is separately notarized and stapled.
4. Native verification checks strict/deep signatures, the exact app identifier,
   package version, arm64 architecture, owner team, Developer ID Application,
   timestamp, hardened runtime, app/DMG staple validity and Gatekeeper assessment.
   Apps extracted from ZIP and read-only mounted DMG must match the built app's
   ASAR hash and code directory identity.
5. Packaged dependencies/notices are checked, and the signed packaged app opens
   and closes twice at the signed-out screen on the disposable hosted runner.
   This smoke script refuses to run on the owner's Mac or a self-hosted runner.
   It does not sign in, request permissions or start gameplay.
6. The workflow retains both installers, `SHA256SUMS`, `mac-release.json`,
   `mac-smoke.json` and DMG notarization evidence. A separate job creates only a
   **draft prerelease** from those exact assets. It refuses to overwrite an
   existing release or tag. A draft is not the official public release.

Do not reuse the unsigned candidate manifest/verifier to claim distribution
trust; that route deliberately requires ad-hoc signatures and remains separate.

## Final qualification matrix

Record the final commit, version, complete DMG/ZIP SHA-256, OS and actual results.
Mark retries, skips and unperformed checks explicitly.

| Check                                        | Host                           | Required evidence                                                                                         |
| -------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Unit/type/format/audit and simulated UI      | Hosted Windows + Apple Silicon | Successful exact-commit CI; retries/skips visible                                                         |
| Signed/notarized image integrity             | Hosted Apple Silicon           | Release manifest, native checks, accepted notary result                                                   |
| Packaged signed-out launch and relaunch      | Disposable hosted Mac          | Two successful packaged launches, no renderer errors                                                      |
| Ordinary downloaded DMG/ZIP opening          | Clean approved Mac             | Gatekeeper accepts without exception; no quarantine stripping                                             |
| New installation, quit/reopen and uninstall  | Clean approved Mac             | Signed app opens normally; data effects recorded                                                          |
| Upgrade from owner alpha                     | Owner Mac when safe            | Reversible app/data backup, same bundle ID, preferences preserved; Keychain prompts reviewed by owner     |
| Account restoration and sign-out/replacement | Approved owner test            | Existing login restores; account actions performed deliberately                                           |
| USB/Bluetooth controller and local controls  | Physical approved devices      | Actual input, rumble, F10/Controls, L3+R3 pass-through, fullscreen/blur/resume                            |
| Live streaming and interruption recovery     | Approved owner session         | At least 30 minutes, exact build, deliberate report export; same-session hold and warned restart verified |
| Accessibility and window interaction         | Native Mac                     | VoiceOver, keyboard, reduced motion and compact/200% display checks                                       |

Do not intentionally interrupt a user's existing game/network to fill this table.
Arrange a dedicated session and obtain approval before disrupting active use.
Developer builds and historical user feedback do not fill exact-artifact gates.
Intel Mac and Windows binaries remain outside this first release scope.

## Publish and install after qualification

Keep the draft unpublished until all required results above are recorded and any
failures resolved. Recheck its target tag SHA and every asset against the signed
manifest and GitHub download digests; do not rebuild or re-sign between final
qualification and publication. Replace the draft notes with concrete changes,
supported scope, limitations, checksums and the qualification evidence. Set the
manifest's public-release status to reflect publication in separate release
notes/evidence rather than changing already-qualified installers. Publish the
existing draft as a beta prerelease, without moving its tag or clobbering assets.

Download only from the resulting release under
`https://github.com/Arthur742Ramos/afterglide/releases`. Keep Gatekeeper and browser
protections enabled. Preserve settings and the previous app for rollback. Quit
and replace the owner's app only when its active session can safely end, with
explicit approval if interruption is necessary. Verify `/Applications/Afterglide
Cloud.app` version, bundle identity, signature and artifact identity, then launch
normally. Stop and report any warning or unexpected permission prompt.

Local Mac work should be limited to final signing if an approved local credential
route is chosen, and install/live qualification. Hosted builds avoid duplicating
toolchains and installers on the owner's nearly full disk. Do not remove unrelated
files, source checkouts, caches or running jobs to make space.

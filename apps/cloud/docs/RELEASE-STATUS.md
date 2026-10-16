# Cloud download and release status

Afterglide Cloud is a source alpha for Windows and macOS. There is no supported
public Cloud installer download yet. The repository's published Linux AppImage
belongs to the original Steam Deck/remote-play app and does not install Cloud.

| Platform            | Current route                                                                                          | Distribution qualification                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Windows x64         | [Build from source](../README.md#run); manual candidate workflow can build an unsigned NSIS installer  | Signing, clean install/upgrade/uninstall and sustained physical-device qualification pending         |
| macOS Apple Silicon | Source execution and local development DMG; manual candidate workflow can build unsigned arm64 DMG/ZIP | Developer ID, notarization/stapling, clean install and packaged device/account qualification pending |
| macOS Intel         | Architecture-specific packaging configuration                                                          | Actual Intel execution and the complete qualification checklist pending; no supported binary claim   |

Candidate artifacts are retained in GitHub Actions for 14 days and may require
GitHub access to retrieve. They are test inputs, not a public download channel.
They contain `candidate.json` with version, exact source commit, target and
unqualified distribution status, plus `SHA256SUMS`. A checksum detects a changed
file; it does not establish publisher trust, signing or a working installation.

The manual [Cloud unsigned candidate workflow](../../../.github/workflows/cloud-candidate.yml)
builds and retains test artifacts. It has read-only repository permissions, no
signing secrets and no release-publishing step. It never changes the original
Afterglide Linux release workflow. Maintainers should select an exact reviewed
commit/ref, record the Actions run and use the manifest's commit as the candidate
identity. See [release qualification](RELEASE-QUALIFICATION.md) before promoting
any candidate.

Both ordinary Cloud CI and the candidate workflow load required libraries from
the packaged archive and compare its license/notices with source. This catches
missing packaged dependencies even when the installer builder exits successfully.
It does not launch a UI, read credentials or contact Xbox, and does not qualify
installation or gameplay.

Mac test candidates use an explicit **ad-hoc signature**, with hardened runtime
retained and the locked builder's existing Electron entitlements. They use no
signing certificate and are **not Developer ID signed or notarized**. Ad-hoc
signing seals the completed app and nested code; it does not establish an Apple
publisher identity or guarantee Gatekeeper acceptance on another Mac.

Native macOS CI verifies the unpacked app with
`codesign --verify --deep --strict`. Native regression fixtures prove that missing
resource seals and changed resources fail verification. Before candidate upload,
the same check runs on the app extracted from ZIP and on a read-only mounted DMG,
and their `app.asar` hashes must match the built app. The candidate run retains
`mac-signatures.json` separately with source, host, artifact hashes and native
signature metadata. No validator launches the app or changes quarantine/trust.

Earlier candidates through the `aa67d3b` shortcut-fix build explicitly skipped
signing with `identity=null`. Packaging modified Electron's bundles without
creating valid resource seals. Their hashes can match while native `codesign`
rejects them with “code has no resources but signature indicates they must be
present.” Do not use those Mac images for installation; byte integrity and a
loadable executable did not qualify their bundle signatures. This packaging fix
does not change the F10/Controls replacement or the L3+R3 pass-through migration.

Cloud updates are disabled until a separate release source is approved. The first
distribution can use a documented manual upgrade path; automatic replacement
is not required for this alpha campaign. A future Cloud release needs its own
version/tag and download assets. Do not push a root `v*` tag to release Cloud:
those tags drive the original Linux release workflow.

[Install/source instructions](INSTALL.md) · [Known issues](../KNOWN-ISSUES.md) ·
[Support](../SUPPORT.md) · [Privacy](../PRIVACY.md)

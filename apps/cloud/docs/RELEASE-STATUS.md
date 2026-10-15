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

Cloud updates are disabled until a separate release source is approved. The first
distribution can use a documented manual upgrade path; automatic replacement
is not required for this alpha campaign. A future Cloud release needs its own
version/tag and download assets. Do not push a root `v*` tag to release Cloud:
those tags drive the original Linux release workflow.

[Install/source instructions](INSTALL.md) · [Known issues](../KNOWN-ISSUES.md) ·
[Support](../SUPPORT.md) · [Privacy](../PRIVACY.md)

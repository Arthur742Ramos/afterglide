#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "${test_root}"' EXIT
mkdir -p "${test_root}/bin" "${test_root}/home"

cat >"${test_root}/bin/uname" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -s) printf 'Linux\n' ;;
  -m) printf 'x86_64\n' ;;
  *) printf 'Linux\n' ;;
esac
EOF

cat >"${test_root}/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while (($#)); do
  case "$1" in
    --output)
      output="$2"
      shift 2
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
case "${url}" in
  *.AppImage)
    printf '%s\n' "${MOCK_APP_CONTENT:-mock-appimage-v1}" >"${output}"
    ;;
  */SHA256SUMS)
    directory="$(dirname "${output}")"
    asset="$(find "${directory}" -maxdepth 1 -name 'Afterglide-*.AppImage' -print -quit)"
    hash="$(shasum -a 256 "${asset}" | cut -d' ' -f1)"
    icon_hash="$(printf '<svg xmlns="http://www.w3.org/2000/svg"/>\n' | shasum -a 256 | cut -d' ' -f1)"
    {
      printf '%s  %s\n' "${hash}" "$(basename "${asset}")"
      printf '%s  %s\n' "${icon_hash}" "io.github.Arthur742Ramos.Afterglide.svg"
    } >"${output}"
    ;;
  *.svg)
    printf '<svg xmlns="http://www.w3.org/2000/svg"/>\n' >"${output}"
    ;;
  *)
    printf 'Unexpected mock URL: %s\n' "${url}" >&2
    exit 1
    ;;
esac
EOF

cat >"${test_root}/bin/sha256sum" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " != *" --check "* ]]; then
  printf 'The test shim only supports checksum verification.\n' >&2
  exit 2
fi
while read -r expected file; do
  actual="$(shasum -a 256 "${file}" | cut -d' ' -f1)"
  [[ "${actual}" == "${expected}" ]]
  printf '%s: OK\n' "${file}"
done
EOF

chmod 0755 "${test_root}/bin/uname" "${test_root}/bin/curl" \
  "${test_root}/bin/sha256sum"

test_path="${test_root}/bin:${PATH}"
HOME="${test_root}/home" PATH="${test_path}" \
  bash "${project_root}/packaging/install-steam-deck.sh" >/dev/null

test -x "${test_root}/home/.local/opt/afterglide/Afterglide.AppImage"
test -x "${test_root}/home/.local/bin/afterglide"
test -f "${test_root}/home/.local/share/applications/io.github.Arthur742Ramos.Afterglide.desktop"
test -f "${test_root}/home/.local/share/icons/hicolor/scalable/apps/io.github.Arthur742Ramos.Afterglide.svg"
grep -Fq '0.3.0-alpha.1' "${test_root}/home/.local/opt/afterglide/VERSION"
grep -Fq 'Name=Afterglide' \
  "${test_root}/home/.local/share/applications/io.github.Arthur742Ramos.Afterglide.desktop"

HOME="${test_root}/home" PATH="${test_path}" MOCK_APP_CONTENT="mock-appimage-v2" \
  bash "${project_root}/packaging/install-steam-deck.sh" >/dev/null
grep -Fq 'mock-appimage-v2' \
  "${test_root}/home/.local/opt/afterglide/Afterglide.AppImage"

HOME="${test_root}/home" PATH="${test_path}" \
  bash "${project_root}/packaging/install-steam-deck.sh" --uninstall >/dev/null
test ! -e "${test_root}/home/.local/opt/afterglide/Afterglide.AppImage"
test ! -e "${test_root}/home/.local/bin/afterglide"
test ! -e "${test_root}/home/.local/share/applications/io.github.Arthur742Ramos.Afterglide.desktop"

printf 'Steam Deck installer integration test passed.\n'

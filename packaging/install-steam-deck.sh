#!/usr/bin/env bash
set -euo pipefail

readonly VERSION="0.3.0-alpha.1"
readonly REPOSITORY="Arthur742Ramos/afterglide"
readonly APP_ID="io.github.Arthur742Ramos.Afterglide"
readonly ASSET="Afterglide-${VERSION}-x86_64.AppImage"
readonly RELEASE_URL="https://github.com/${REPOSITORY}/releases/download/v${VERSION}"
readonly INSTALL_DIR="${HOME}/.local/opt/afterglide"
readonly APP_PATH="${INSTALL_DIR}/Afterglide.AppImage"
readonly BIN_PATH="${HOME}/.local/bin/afterglide"
readonly ICON_PATH="${HOME}/.local/share/icons/hicolor/scalable/apps/${APP_ID}.svg"
readonly DESKTOP_PATH="${HOME}/.local/share/applications/${APP_ID}.desktop"

usage() {
  cat <<EOF
Install Afterglide ${VERSION} for the current Linux user.

Usage:
  install-steam-deck.sh
  install-steam-deck.sh --uninstall
  install-steam-deck.sh --help

No root access, Node.js, or npm is required.
EOF
}

refresh_desktop_database() {
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "${HOME}/.local/share/applications" >/dev/null 2>&1 || true
  fi
}

uninstall_afterglide() {
  rm -f "${APP_PATH}" "${INSTALL_DIR}/VERSION" "${BIN_PATH}" "${ICON_PATH}" "${DESKTOP_PATH}"
  rmdir "${INSTALL_DIR}" 2>/dev/null || true
  refresh_desktop_database
  printf 'Afterglide was removed from this user account.\n'
}

case "${1:-}" in
  --help|-h)
    usage
    exit 0
    ;;
  --uninstall)
    uninstall_afterglide
    exit 0
    ;;
  "") ;;
  *)
    printf 'Unknown option: %s\n\n' "$1" >&2
    usage >&2
    exit 2
    ;;
esac

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'Afterglide’s current package supports Linux only.\n' >&2
  exit 1
fi
if [[ "$(uname -m)" != "x86_64" ]]; then
  printf 'Afterglide’s current package supports x86_64 Linux only.\n' >&2
  exit 1
fi
for command_name in curl sha256sum install; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "${command_name}" >&2
    exit 1
  fi
done

temporary_directory="$(mktemp -d)"
trap 'rm -rf "${temporary_directory}"' EXIT

printf 'Downloading Afterglide %s…\n' "${VERSION}"
curl --fail --location --silent --show-error \
  --retry 2 --retry-all-errors --connect-timeout 10 --max-time 300 \
  --output "${temporary_directory}/${ASSET}" \
  "${RELEASE_URL}/${ASSET}"
curl --fail --location --silent --show-error \
  --retry 2 --retry-all-errors --connect-timeout 10 --max-time 60 \
  --output "${temporary_directory}/SHA256SUMS" \
  "${RELEASE_URL}/SHA256SUMS"
curl --fail --location --silent --show-error \
  --retry 2 --retry-all-errors --connect-timeout 10 --max-time 60 \
  --output "${temporary_directory}/${APP_ID}.svg" \
  "${RELEASE_URL}/${APP_ID}.svg"

app_checksum="$(
  awk -v file="${ASSET}" '$2 == file { print $1 "  " $2 }' \
    "${temporary_directory}/SHA256SUMS"
)"
icon_checksum="$(
  awk -v file="${APP_ID}.svg" '$2 == file { print $1 "  " $2 }' \
    "${temporary_directory}/SHA256SUMS"
)"
app_checksum_count="$(printf '%s\n' "${app_checksum}" | awk 'NF { count += 1 } END { print count + 0 }')"
icon_checksum_count="$(printf '%s\n' "${icon_checksum}" | awk 'NF { count += 1 } END { print count + 0 }')"
if [[ "${app_checksum_count}" != "1" || "${icon_checksum_count}" != "1" ]]; then
  printf 'The release checksum is incomplete. Nothing was installed.\n' >&2
  exit 1
fi
(
  cd "${temporary_directory}"
  printf '%s\n%s\n' "${app_checksum}" "${icon_checksum}" | \
    sha256sum --check --strict -
)

install -d "${INSTALL_DIR}" "$(dirname "${BIN_PATH}")" \
  "$(dirname "${ICON_PATH}")" "$(dirname "${DESKTOP_PATH}")"
install -m 0755 "${temporary_directory}/${ASSET}" "${APP_PATH}"
install -m 0644 "${temporary_directory}/${APP_ID}.svg" "${ICON_PATH}"
printf '%s\n' "${VERSION}" >"${INSTALL_DIR}/VERSION"

cat >"${BIN_PATH}" <<EOF
#!/bin/sh
exec "${APP_PATH}" "\$@"
EOF
chmod 0755 "${BIN_PATH}"

desktop_exec="${BIN_PATH//\\/\\\\}"
desktop_exec="${desktop_exec//\"/\\\"}"
cat >"${DESKTOP_PATH}" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Afterglide
Comment=Play your Xbox from Steam Deck
Exec="${desktop_exec}"
Icon=${APP_ID}
Terminal=false
Categories=Game;
StartupNotify=true
EOF
chmod 0644 "${DESKTOP_PATH}"
refresh_desktop_database

cat <<EOF

Afterglide ${VERSION} is installed.

Open it from the application launcher in Desktop Mode. To add it to Gaming Mode:
  1. In Steam, choose Games > Add a Non-Steam Game to My Library.
  2. Select Afterglide from the list. If it is absent, choose Browse, press Ctrl+H,
     and select ${BIN_PATH}.
  3. In Controller Settings, keep the Gamepad template.
  4. Optional: map L4 to F10 for Afterglide controls and R4 to F9 for stats.

Run this installer again to replace the installed build with ${VERSION}.
EOF

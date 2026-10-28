#!/usr/bin/env bash
# macOS & Linux Tek Adımlık Otomatik Native Messaging Host Kurulum Betiği
#
# Hem manifest.json içindeki sabit ortak anahtar ID'sini (haamijddaadhbhjfpblfloidmpglfmnk)
# hem de eklenti klasörünün tam dosya yolundan (path hash) üretilen unpacked Extension ID'sini
# otomatik hesaplayıp allowed_origins listesine ekler!
# Böylece eklenti daha önce yüklenmiş olsa bile hiçbir ID kopyalamaya gerek kalmadan anında çalışır.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
EXT_DIR="${PROJECT_ROOT}/extension"
HOST_DIR="${HOME}/mpv_host"
HOST_SCRIPT="${HOST_DIR}/mpv_host.py"
HOST_NAME="com.talha.mpv"

# 1. Sabit (manifest.json "key" alanından gelen) Extension ID
KEY_EXT_ID="haamijddaadhbhjfpblfloidmpglfmnk"

# 2. Klasör yolundan (unpacked path SHA256 -> a-p) üretilen Extension ID
PATH_EXT_ID=$(python3 -c '
import hashlib, sys
p = sys.argv[1]
h = hashlib.sha256(p.encode("utf-8")).hexdigest()[:32]
print("".join(chr(ord("a") + int(c, 16)) for c in h))
' "${EXT_DIR}")

# 3. İsteğe bağlı olarak komut satırından verilen ek Extension ID
CUSTOM_EXT_ID="${1:-}"

ORIGINS_JSON="    \"chrome-extension://${KEY_EXT_ID}/\",
    \"chrome-extension://${PATH_EXT_ID}/\""

if [[ -n "${CUSTOM_EXT_ID}" && "${CUSTOM_EXT_ID}" =~ ^[a-p]{32}$ && "${CUSTOM_EXT_ID}" != "${KEY_EXT_ID}" && "${CUSTOM_EXT_ID}" != "${PATH_EXT_ID}" ]]; then
  ORIGINS_JSON="${ORIGINS_JSON},
    \"chrome-extension://${CUSTOM_EXT_ID}/\""
fi

mkdir -p "${HOST_DIR}"

MANIFEST_CONTENT=$(cat <<EOF
{
  "name": "${HOST_NAME}",
  "description": "Native Messaging Host for Stream to mpv extension",
  "path": "${HOST_SCRIPT}",
  "type": "stdio",
  "allowed_origins": [
${ORIGINS_JSON}
  ]
}
EOF
)

FIREFOX_MANIFEST_CONTENT=$(cat <<EOF
{
  "name": "${HOST_NAME}",
  "description": "Native Messaging Host for Stream to mpv extension",
  "path": "${HOST_SCRIPT}",
  "type": "stdio",
  "allowed_extensions": [
    "stream-to-mpv@talha.dev"
  ]
}
EOF
)

OS_NAME="$(uname -s)"

# İşletim sistemine göre tarayıcıların NativeMessagingHosts dizinleri
if [[ "${OS_NAME}" == "Darwin" ]]; then
  APP_SUPPORT="${HOME}/Library/Application Support"
  CHROMIUM_NM_DIRS=(
    "${APP_SUPPORT}/Chromium/NativeMessagingHosts"
    "${APP_SUPPORT}/Google/Chrome/NativeMessagingHosts"
    "${APP_SUPPORT}/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    "${APP_SUPPORT}/Microsoft Edge/NativeMessagingHosts"
    "${APP_SUPPORT}/Vivaldi/NativeMessagingHosts"
    "${APP_SUPPORT}/Arc/User Data/NativeMessagingHosts"
    "${APP_SUPPORT}/com.operasoftware.Opera/NativeMessagingHosts"
    "${APP_SUPPORT}/Google/Chrome for Testing/NativeMessagingHosts"
  )
  FIREFOX_NM_DIRS=(
    "${APP_SUPPORT}/Mozilla/NativeMessagingHosts"
  )
elif [[ "${OS_NAME}" == "Linux" ]]; then
  CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
  CHROMIUM_NM_DIRS=(
    "${CONFIG_HOME}/chromium/NativeMessagingHosts"
    "${CONFIG_HOME}/google-chrome/NativeMessagingHosts"
    "${CONFIG_HOME}/google-chrome-beta/NativeMessagingHosts"
    "${CONFIG_HOME}/google-chrome-unstable/NativeMessagingHosts"
    "${CONFIG_HOME}/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    "${CONFIG_HOME}/microsoft-edge/NativeMessagingHosts"
    "${CONFIG_HOME}/vivaldi/NativeMessagingHosts"
    "${CONFIG_HOME}/thorium/NativeMessagingHosts"
  )
  FIREFOX_NM_DIRS=(
    "${HOME}/.mozilla/native-messaging-hosts"
    "${HOME}/.librewolf/native-messaging-hosts"
  )
else
  echo "ERROR: Unsupported operating system: ${OS_NAME} (macOS and Linux are supported)." >&2
  exit 1
fi

echo "[1/3] Installing native host script to ${HOST_SCRIPT}..."
cp "${SCRIPT_DIR}/mpv_host.py" "${HOST_SCRIPT}"
chmod 755 "${HOST_SCRIPT}"
echo "${MANIFEST_CONTENT}" > "${HOST_DIR}/${HOST_NAME}.json"

echo "[2/3] Configuring browser NativeMessagingHosts manifests..."
for TARGET_DIR in "${CHROMIUM_NM_DIRS[@]}"; do
  mkdir -p "${TARGET_DIR}"
  echo "${MANIFEST_CONTENT}" > "${TARGET_DIR}/${HOST_NAME}.json"
  echo "  -> Configured: ${TARGET_DIR}/${HOST_NAME}.json"
done

for TARGET_DIR in "${FIREFOX_NM_DIRS[@]}"; do
  mkdir -p "${TARGET_DIR}"
  echo "${FIREFOX_MANIFEST_CONTENT}" > "${TARGET_DIR}/${HOST_NAME}.json"
  echo "  -> Configured: ${TARGET_DIR}/${HOST_NAME}.json"
done

echo "[3/3] Verifying mpv & yt-dlp..."
MPV_FOUND=""
for CANDIDATE in "$(command -v mpv 2>/dev/null || true)" "/opt/homebrew/bin/mpv" "/usr/local/bin/mpv" "/Applications/mpv.app/Contents/MacOS/mpv" "/usr/bin/mpv"; do
  if [[ -n "${CANDIDATE}" && -x "${CANDIDATE}" ]]; then
    MPV_FOUND="${CANDIDATE}"
    break
  fi
done

if [[ -n "${MPV_FOUND}" ]]; then
  echo "  -> mpv found at: ${MPV_FOUND}"
elif [[ "${OS_NAME}" == "Darwin" ]]; then
  echo "  -> WARNING: mpv was not found. Run 'brew install mpv'"
else
  echo "  -> WARNING: mpv was not found. Install it with your package manager (e.g. 'sudo pacman -S mpv' or 'sudo apt install mpv')"
fi

echo ""
echo "✓ Setup complete!"
echo "  Allowed Extension IDs:"
echo "    - ${KEY_EXT_ID} (manifest key ID)"
echo "    - ${PATH_EXT_ID} (unpacked folder ID)"

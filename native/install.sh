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
HOST_NAME="com.talha.mpv"
OS_NAME="$(uname -s)"

# Host betiği ev klasörüne değil, işletim sisteminin uygulama verisi için ayırdığı konuma kurulur
if [[ "${OS_NAME}" == "Darwin" ]]; then
  HOST_DIR="${HOME}/Library/Application Support/StreamToMpv"
else
  HOST_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/stream-to-mpv"
fi
HOST_SCRIPT="${HOST_DIR}/mpv_host.py"
# 1.2.1 ve öncesinin kurduğu konum: kurulumda ve kaldırmada temizlenir
LEGACY_HOST_DIR="${HOME}/mpv_host"

# Kullanım: install.sh [EXTENSION_ID] | --uninstall | --print-host-path
MODE="install"
case "${1:-}" in
  --uninstall) MODE="uninstall"; shift ;;
  --print-host-path) echo "${HOST_SCRIPT}"; exit 0 ;;
esac

# 1. Sabit (manifest.json "key" alanından gelen) Extension ID
KEY_EXT_ID="haamijddaadhbhjfpblfloidmpglfmnk"

# 2. Klasör yolundan (unpacked path SHA256 -> a-p) üretilen Extension ID
PATH_EXT_ID=$(python3 -c '
import hashlib, sys
p = sys.argv[1]
h = hashlib.sha256(p.encode("utf-8")).hexdigest()[:32]
print("".join(chr(ord("a") + int(c, 16)) for c in h))
' "${EXT_DIR}")

# 3. Chrome Web Store'dan kurulan eklentinin ID'si (mağaza "key" alanını kabul etmediği için farklıdır).
#    Yayınlandıktan sonra Developer Dashboard'daki Item ID buraya yazılmalıdır.
CHROME_STORE_EXT_ID="cclgdinilniikloipfhflcchjohjcbpk"

# 4. İsteğe bağlı olarak komut satırından verilen ek Extension ID
CUSTOM_EXT_ID="${1:-}"

ORIGINS_JSON="    \"chrome-extension://${KEY_EXT_ID}/\",
    \"chrome-extension://${PATH_EXT_ID}/\""

if [[ "${CHROME_STORE_EXT_ID}" =~ ^[a-p]{32}$ ]]; then
  ORIGINS_JSON="${ORIGINS_JSON},
    \"chrome-extension://${CHROME_STORE_EXT_ID}/\""
fi

if [[ -n "${CUSTOM_EXT_ID}" && "${CUSTOM_EXT_ID}" =~ ^[a-p]{32}$ && "${CUSTOM_EXT_ID}" != "${KEY_EXT_ID}" && "${CUSTOM_EXT_ID}" != "${PATH_EXT_ID}" && "${CUSTOM_EXT_ID}" != "${CHROME_STORE_EXT_ID}" ]]; then
  ORIGINS_JSON="${ORIGINS_JSON},
    \"chrome-extension://${CUSTOM_EXT_ID}/\""
fi

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

# Eski ~/mpv_host kurulumunu siler: yalnızca bizim dosyalarımız, klasör ancak boş kalırsa
remove_legacy_host() {
  [[ -d "${LEGACY_HOST_DIR}" && "${LEGACY_HOST_DIR}" != "${HOST_DIR}" ]] || return 0
  rm -f "${LEGACY_HOST_DIR}/mpv_host.py" "${LEGACY_HOST_DIR}/${HOST_NAME}.json"
  if rmdir "${LEGACY_HOST_DIR}" 2>/dev/null; then
    echo "  -> Removed old install folder: ${LEGACY_HOST_DIR}"
  else
    echo "  -> Removed old host files; ${LEGACY_HOST_DIR} kept because it contains other files"
  fi
}

if [[ "${MODE}" == "uninstall" ]]; then
  echo "[1/2] Removing browser NativeMessagingHosts manifests..."
  for TARGET_DIR in "${CHROMIUM_NM_DIRS[@]}" "${FIREFOX_NM_DIRS[@]}"; do
    if [[ -f "${TARGET_DIR}/${HOST_NAME}.json" ]]; then
      rm -f "${TARGET_DIR}/${HOST_NAME}.json"
      echo "  -> Removed: ${TARGET_DIR}/${HOST_NAME}.json"
    fi
    # Kurulumun açtığı klasör başka kayıt içermiyorsa kaldırılır (rmdir yalnızca boş klasörü siler)
    rmdir "${TARGET_DIR}" 2>/dev/null || true
  done
  echo "[2/2] Removing native host script..."
  rm -f "${HOST_SCRIPT}"
  rmdir "${HOST_DIR}" 2>/dev/null && echo "  -> Removed: ${HOST_DIR}" || true
  remove_legacy_host
  echo ""
  echo "✓ Stream to mpv native host uninstalled. mpv, VLC and yt-dlp were left untouched."
  if [[ "${OS_NAME}" == "Darwin" && -d "/Library/Application Support/StreamToMpv" ]]; then
    echo "  The .pkg installer also left a system-wide copy in /Library/Application Support/StreamToMpv"
    echo "  (owned by root); delete that folder in Finder if you no longer need it."
  fi
  exit 0
fi

echo "[1/3] Installing native host script to ${HOST_SCRIPT}..."
mkdir -p "${HOST_DIR}"
cp "${SCRIPT_DIR}/mpv_host.py" "${HOST_SCRIPT}"
chmod 755 "${HOST_SCRIPT}"
remove_legacy_host

echo "[2/3] Configuring browser NativeMessagingHosts manifests..."
# Yalnızca kurulu (ayar klasörü olan) tarayıcılara kayıt yazılır; olmayan tarayıcılar için boş klasör açılmaz
CONFIGURED_COUNT=0
register_manifest() {
  local target_dir="$1" content="$2"
  [[ -d "$(dirname "${target_dir}")" ]] || return 0
  mkdir -p "${target_dir}"
  echo "${content}" > "${target_dir}/${HOST_NAME}.json"
  echo "  -> Configured: ${target_dir}/${HOST_NAME}.json"
  CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))
}

for TARGET_DIR in "${CHROMIUM_NM_DIRS[@]}"; do
  register_manifest "${TARGET_DIR}" "${MANIFEST_CONTENT}"
done

for TARGET_DIR in "${FIREFOX_NM_DIRS[@]}"; do
  register_manifest "${TARGET_DIR}" "${FIREFOX_MANIFEST_CONTENT}"
done

if [[ "${CONFIGURED_COUNT}" -eq 0 ]]; then
  echo "  -> WARNING: no supported browser profile found. Open your browser once, then run 'make' again."
else
  echo "  -> Installed a new browser later? Run 'make' again to register it."
fi

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
if [[ "${CHROME_STORE_EXT_ID}" =~ ^[a-p]{32}$ ]]; then
  echo "    - ${CHROME_STORE_EXT_ID} (Chrome Web Store ID)"
fi

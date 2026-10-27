#!/usr/bin/env bash
# macOS İmzalanabilir ve Dağıtılabilir Kurulum Paketi (.pkg) Üretici
# Çıktı: dist/StreamToMpv-Installer.pkg
# Bu paket çalıştırıldığında kullanıcının ev dizinine native host'u ve tarayıcı manifestlerini
# hiçbir terminal komutu veya Extension ID kopyalama işlemi gerektirmeden otomatik kurar.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_DIR="${PROJECT_ROOT}/dist/pkg_build"
PAYLOAD_DIR="${BUILD_DIR}/payload"
SCRIPTS_DIR="${BUILD_DIR}/scripts"
OUTPUT_PKG="${PROJECT_ROOT}/dist/StreamToMpv-Installer.pkg"

rm -rf "${BUILD_DIR}"
mkdir -p "${PAYLOAD_DIR}/Library/Application Support/StreamToMpv"
mkdir -p "${SCRIPTS_DIR}"

# 1. Host ve eklenti dosyalarını paket payload'una kopyala
cp "${PROJECT_ROOT}/native/mpv_host.py" "${PAYLOAD_DIR}/Library/Application Support/StreamToMpv/mpv_host.py"
chmod 755 "${PAYLOAD_DIR}/Library/Application Support/StreamToMpv/mpv_host.py"
cp -R "${PROJECT_ROOT}/extension" "${PAYLOAD_DIR}/Library/Application Support/StreamToMpv/extension"

# 2. Paket kurulumu tamamlandığında aktif kullanıcı için ~/mpv_host ve NativeMessagingHosts kayıtlarını yapan postinstall betiği
cat << 'EOF' > "${SCRIPTS_DIR}/postinstall"
#!/usr/bin/env bash
set -euo pipefail

TARGET_USER="${USER:-$(stat -f '%Su' /dev/console)}"
USER_HOME="$(dscl . -read "/Users/${TARGET_USER}" NFSHomeDirectory | awk '{print $2}')"

if [[ -z "${USER_HOME}" || ! -d "${USER_HOME}" ]]; then
  exit 0
fi

HOST_DIR="${USER_HOME}/mpv_host"
HOST_SCRIPT="${HOST_DIR}/mpv_host.py"
HOST_NAME="com.talha.mpv"
FIXED_EXT_ID="haamijddaadhbhjfpblfloidmpglfmnk"

mkdir -p "${HOST_DIR}"
cp "/Library/Application Support/StreamToMpv/mpv_host.py" "${HOST_SCRIPT}"
chmod 755 "${HOST_SCRIPT}"
chown -R "${TARGET_USER}:staff" "${HOST_DIR}"

MANIFEST_JSON=$(cat <<JSON
{
  "name": "${HOST_NAME}",
  "description": "Native Messaging Host for Stream to mpv extension",
  "path": "${HOST_SCRIPT}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${FIXED_EXT_ID}/"
  ]
}
JSON
)

echo "${MANIFEST_JSON}" > "${HOST_DIR}/${HOST_NAME}.json"
chown "${TARGET_USER}:staff" "${HOST_DIR}/${HOST_NAME}.json"

for NM_DIR in \
  "${USER_HOME}/Library/Application Support/Chromium/NativeMessagingHosts" \
  "${USER_HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "${USER_HOME}/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
  "${USER_HOME}/Library/Application Support/Microsoft Edge/NativeMessagingHosts"; do
  mkdir -p "${NM_DIR}"
  echo "${MANIFEST_JSON}" > "${NM_DIR}/${HOST_NAME}.json"
  chown -R "${TARGET_USER}:staff" "$(dirname "${NM_DIR}")"
done

exit 0
EOF

chmod 755 "${SCRIPTS_DIR}/postinstall"

# 3. pkgbuild ile standart macOS .pkg paketini oluştur
pkgbuild \
  --root "${PAYLOAD_DIR}" \
  --scripts "${SCRIPTS_DIR}" \
  --identifier "com.talha.streamtompv.pkg" \
  --version "1.1.0" \
  --install-location "/" \
  "${OUTPUT_PKG}"

rm -rf "${BUILD_DIR}"
echo "✓ Distributable macOS installer package built at: ${OUTPUT_PKG}"

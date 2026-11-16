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
PKG_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "${PROJECT_ROOT}/extension/manifest.json")"

rm -rf "${BUILD_DIR}"
mkdir -p "${PAYLOAD_DIR}/Library/Application Support/StreamToMpv"
mkdir -p "${SCRIPTS_DIR}"

# 1. Host ve eklenti dosyalarını paket payload'una kopyala
cp "${PROJECT_ROOT}/native/mpv_host.py" "${PAYLOAD_DIR}/Library/Application Support/StreamToMpv/mpv_host.py"
chmod 755 "${PAYLOAD_DIR}/Library/Application Support/StreamToMpv/mpv_host.py"
cp -R "${PROJECT_ROOT}/extension" "${PAYLOAD_DIR}/Library/Application Support/StreamToMpv/extension"

# 2. Paket kurulumu tamamlandığında aktif kullanıcı için ~/Library/Application Support/StreamToMpv ve
#    NativeMessagingHosts kayıtlarını yapan postinstall betiği (install.sh ile aynı konum)
cat << 'EOF' > "${SCRIPTS_DIR}/postinstall"
#!/usr/bin/env bash
set -euo pipefail

TARGET_USER="${USER:-$(stat -f '%Su' /dev/console)}"
USER_HOME="$(dscl . -read "/Users/${TARGET_USER}" NFSHomeDirectory | awk '{print $2}')"

if [[ -z "${USER_HOME}" || ! -d "${USER_HOME}" ]]; then
  exit 0
fi

HOST_DIR="${USER_HOME}/Library/Application Support/StreamToMpv"
HOST_SCRIPT="${HOST_DIR}/mpv_host.py"
LEGACY_HOST_DIR="${USER_HOME}/mpv_host"
HOST_NAME="com.talha.mpv"
FIXED_EXT_ID="haamijddaadhbhjfpblfloidmpglfmnk"
# Chrome Web Store'dan kurulan eklentinin kimliği (install.sh ile aynı tutulmalı)
CHROME_STORE_EXT_ID="cclgdinilniikloipfhflcchjohjcbpk"

mkdir -p "${HOST_DIR}"
cp "/Library/Application Support/StreamToMpv/mpv_host.py" "${HOST_SCRIPT}"
chmod 755 "${HOST_SCRIPT}"
chown -R "${TARGET_USER}:staff" "${HOST_DIR}"

# 1.2.1 ve öncesinin ev klasörüne kurduğu ~/mpv_host: yalnızca bizim dosyalarımız silinir, klasör boşsa kaldırılır
if [[ -d "${LEGACY_HOST_DIR}" ]]; then
  rm -f "${LEGACY_HOST_DIR}/mpv_host.py" "${LEGACY_HOST_DIR}/${HOST_NAME}.json"
  rmdir "${LEGACY_HOST_DIR}" 2>/dev/null || true
fi

MANIFEST_JSON=$(cat <<JSON
{
  "name": "${HOST_NAME}",
  "description": "Native Messaging Host for Stream to mpv extension",
  "path": "${HOST_SCRIPT}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${FIXED_EXT_ID}/",
    "chrome-extension://${CHROME_STORE_EXT_ID}/"
  ]
}
JSON
)

FIREFOX_MANIFEST_JSON=$(cat <<JSON
{
  "name": "${HOST_NAME}",
  "description": "Native Messaging Host for Stream to mpv extension",
  "path": "${HOST_SCRIPT}",
  "type": "stdio",
  "allowed_extensions": [
    "stream-to-mpv@talha.dev"
  ]
}
JSON
)


APP_SUPPORT="${USER_HOME}/Library/Application Support"
for NM_DIR in \
  "${APP_SUPPORT}/Chromium/NativeMessagingHosts" \
  "${APP_SUPPORT}/Google/Chrome/NativeMessagingHosts" \
  "${APP_SUPPORT}/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
  "${APP_SUPPORT}/Microsoft Edge/NativeMessagingHosts" \
  "${APP_SUPPORT}/Vivaldi/NativeMessagingHosts" \
  "${APP_SUPPORT}/Arc/User Data/NativeMessagingHosts" \
  "${APP_SUPPORT}/com.operasoftware.Opera/NativeMessagingHosts" \
  "${APP_SUPPORT}/Google/Chrome for Testing/NativeMessagingHosts"; do
  # postinstall root olarak çalışır: kurulu olmayan tarayıcılar için root sahipli profil klasörü oluşturma
  [[ -d "$(dirname "${NM_DIR}")" ]] || continue
  mkdir -p "${NM_DIR}"
  echo "${MANIFEST_JSON}" > "${NM_DIR}/${HOST_NAME}.json"
  chown "${TARGET_USER}:staff" "${NM_DIR}" "${NM_DIR}/${HOST_NAME}.json"
done

FF_NM_DIR="${APP_SUPPORT}/Mozilla/NativeMessagingHosts"
if [[ -d "${APP_SUPPORT}/Mozilla" ]]; then
  mkdir -p "${FF_NM_DIR}"
  echo "${FIREFOX_MANIFEST_JSON}" > "${FF_NM_DIR}/${HOST_NAME}.json"
  chown "${TARGET_USER}:staff" "${FF_NM_DIR}" "${FF_NM_DIR}/${HOST_NAME}.json"
fi

exit 0
EOF

chmod 755 "${SCRIPTS_DIR}/postinstall"

# 3. pkgbuild ile standart macOS .pkg paketini oluştur
pkgbuild \
  --root "${PAYLOAD_DIR}" \
  --scripts "${SCRIPTS_DIR}" \
  --identifier "com.talha.streamtompv.pkg" \
  --version "${PKG_VERSION}" \
  --install-location "/" \
  "${OUTPUT_PKG}"

rm -rf "${BUILD_DIR}"
echo "✓ Distributable macOS installer package built at: ${OUTPUT_PKG}"

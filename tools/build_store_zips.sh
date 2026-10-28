#!/usr/bin/env bash
# Chrome Web Store ve Firefox Add-ons (AMO) için yüklemeye hazır eklenti arşivlerini üretir.
#
# - chrome-web-store.zip: "key" alanı (Web Store kabul etmez), Firefox'a özel
#   "browser_specific_settings" ve "background.scripts" alanları çıkarılır.
# - firefox-amo.zip: "key" ve Firefox'un desteklemediği "background.service_worker" çıkarılır.
#
# Kaynak extension/manifest.json değiştirilmez; yerel geliştirmede sabit ID için "key" korunur.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${ROOT_DIR}/extension"
OUT_DIR="${ROOT_DIR}/dist/store"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "${BUILD_DIR}"' EXIT

mkdir -p "${OUT_DIR}"

build_variant() {
  local target="$1"
  local zip_name="$2"
  local stage="${BUILD_DIR}/${target}"

  mkdir -p "${stage}"
  cp -R "${EXT_DIR}/." "${stage}/"
  find "${stage}" -name ".DS_Store" -delete

  python3 - "${EXT_DIR}/manifest.json" "${stage}/manifest.json" "${target}" <<'PY'
import json, sys

src, dst, target = sys.argv[1:4]
with open(src, encoding="utf-8") as f:
    manifest = json.load(f)

manifest.pop("key", None)
background = manifest.get("background", {})
if target == "chrome":
    manifest.pop("browser_specific_settings", None)
    background.pop("scripts", None)
else:
    background.pop("service_worker", None)

with open(dst, "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY

  rm -f "${OUT_DIR}/${zip_name}"
  (cd "${stage}" && zip -rqX "${OUT_DIR}/${zip_name}" .)
  echo "  -> ${target}: dist/store/${zip_name}"
}

echo "==> Building store packages (version $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "${EXT_DIR}/manifest.json"))..."
build_variant chrome chrome-web-store.zip
build_variant firefox firefox-amo.zip

if command -v npx >/dev/null 2>&1; then
  echo "==> Linting Firefox package with web-ext..."
  npx -y web-ext@8 lint --source-dir "${BUILD_DIR}/firefox" --warnings-as-errors
else
  echo "==> npx not found; skipping web-ext lint (install Node.js to enable it)."
fi

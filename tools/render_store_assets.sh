#!/usr/bin/env bash
# store-assets/src/*.html tasarımlarını headless Chromium ile mağaza boyutlarında PNG'ye çevirir.
# Dosya adındaki boyut (ör. promo-small-440x280.html) yoksa 1280x800 kullanılır.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${ROOT_DIR}/store-assets/src"
OUT_DIR="${ROOT_DIR}/store-assets"

CHROME_BIN="${CHROME_BIN:-$(command -v chromium || command -v google-chrome-stable || command -v google-chrome || true)}"
if [[ -z "${CHROME_BIN}" ]]; then
  echo "ERROR: Chromium/Chrome not found. Set CHROME_BIN to the browser binary." >&2
  exit 1
fi

for html in "${SRC_DIR}"/*.html; do
  name="$(basename "${html}" .html)"
  size="1280x800"
  if [[ "${name}" =~ ([0-9]+x[0-9]+)$ ]]; then
    size="${BASH_REMATCH[1]}"
  fi
  "${CHROME_BIN}" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --allow-file-access-from-files --virtual-time-budget=4000 \
    --window-size="${size/x/,}" --screenshot="${OUT_DIR}/${name}.png" "file://${html}" >/dev/null 2>&1
  echo "  -> store-assets/${name}.png (${size})"
done

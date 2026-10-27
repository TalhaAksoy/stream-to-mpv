#!/usr/bin/env bash
# Finder üzerinden çift tıklamayla çalışan tek adımlık macOS Kurulum Aracı
# Kullanıcıdan Extension ID kopyalamasını veya JSON düzenlemesini istemez.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "===================================================="
echo "  Stream to mpv — One-Click macOS Setup"
echo "===================================================="
echo ""

bash "${ROOT_DIR}/native/install.sh"

# macOS yerel bildirim kutusu ile kurulumun tamamlandığını göster
if command -v osascript >/dev/null 2>&1; then
  osascript -e 'display notification "Native host configured automatically. Load the extension folder once and click Open in mpv on any video!" with title "Stream to mpv — Ready"' >/dev/null 2>&1 || true
fi

echo ""
read -r -p "Press Enter to close this window..." _ || true

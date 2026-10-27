# Stream to mpv — Tek Komutluk Kurulum (make)
# Kullanım:
#   make          -> Bağımlılıkları kontrol eder/kurar, Native Host'u ve tüm tarayıcı manifestlerini kurar, test eder.
#   make install  -> Sadece kurulum ve doğrulama yapar.
#   make zip      -> Android (Bare / Lemur / Mises) için dist/stream-to-mpv-extension.zip üretir.
#   make test     -> Tüm birim ve entegrasyon testlerini çalıştırır.
#   make pkg      -> Dağıtılabilir macOS .pkg kurulum paketini üretir.

SHELL := /bin/bash
.PHONY: all install deps host verify zip test pkg clean

all: install zip

install: deps host verify
	@echo ""
	@echo "========================================================"
	@echo "  ✓ KURULUM TAMAMLANDI VE DOĞRULANDI!"
	@echo "  Şimdi Chrome'da açık olan video sekmesini yenile (Cmd+R)"
	@echo "  ve videonun sağ üstündeki 'Open in mpv' butonuna bas."
	@echo "========================================================"

deps:
	@echo "==> [1/3] Checking mpv & yt-dlp dependencies..."
	@if ! command -v mpv >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/mpv ] && [ ! -x /usr/local/bin/mpv ] && [ ! -x /Applications/mpv.app/Contents/MacOS/mpv ]; then \
		echo "  -> Installing mpv via Homebrew..."; \
		brew install mpv; \
	else \
		echo "  -> mpv is installed."; \
	fi
	@if ! command -v yt-dlp >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/yt-dlp ] && [ ! -x /usr/local/bin/yt-dlp ]; then \
		echo "  -> Installing yt-dlp via Homebrew..."; \
		brew install yt-dlp; \
	else \
		echo "  -> yt-dlp is installed."; \
	fi

host:
	@echo "==> [2/3] Installing Native Messaging Host & Chrome Manifests..."
	@chmod +x ./native/install.sh ./native/mpv_host.py "./Install Stream to mpv.command"
	@./native/install.sh

verify:
	@echo "==> [3/3] Verifying Native Messaging Host handshake (under clean macOS GUI PATH)..."
	@env -i HOME="${HOME}" EXT_PATH="$(CURDIR)/extension" PATH="/usr/bin:/bin:/usr/sbin:/sbin" /usr/bin/python3 -c 'import hashlib, json, os, struct, subprocess; p = os.environ["EXT_PATH"]; path_id = "".join(chr(ord("a") + int(c, 16)) for c in hashlib.sha256(p.encode("utf-8")).hexdigest()[:32]); msg = json.dumps({"action": "ping"}).encode("utf-8"); payload = struct.pack("<I", len(msg)) + msg; r1 = subprocess.run([os.environ["HOME"] + "/mpv_host/mpv_host.py", "chrome-extension://haamijddaadhbhjfpblfloidmpglfmnk/"], input=payload, capture_output=True); r2 = subprocess.run([os.environ["HOME"] + "/mpv_host/mpv_host.py", f"chrome-extension://{path_id}/"], input=payload, capture_output=True); assert r1.returncode == 0, f"stderr: {r1.stderr.decode()}"; d1 = json.loads(r1.stdout[4:].decode("utf-8")); d2 = json.loads(r2.stdout[4:].decode("utf-8")); assert d1.get("ok") and d2.get("ok") and d1.get("mpv_available"); print("  -> Clean macOS GUI environment test OK & mpv ready!")'

test:
	@node ./tests/test_extension_logic.mjs
	@node ./tests/test_background_lifecycle.mjs
	@python3 ./tests/test_native_host.py
	@python3 ./tests/test_anime_embed_e2e.py
	@python3 ./tests/test_overlay_positioning.py

pkg:
	@chmod +x ./native/build_macos_pkg.sh
	@./native/build_macos_pkg.sh

zip:
	@mkdir -p dist
	@rm -f dist/stream-to-mpv-extension.zip
	@(cd extension && zip -rq ../dist/stream-to-mpv-extension.zip . -x "*.DS_Store")
	@echo "  -> Mobile extension archive ready: dist/stream-to-mpv-extension.zip"

clean:
	@rm -rf dist/pkg_build

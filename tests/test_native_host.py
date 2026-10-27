#!/usr/bin/env python3
"""
macOS Native Messaging Host (mpv_host.py) Uçtan Uca Test Paketi
Doğrulanan senaryolar:
- Standart 4-byte little-endian Native Messaging protokolü okuma/yazma
- Origin doğrulaması (Senaryo 13: geçersiz origin veya JSON içi sahte origin reddi)
- Sadece http:// ve https:// URL kabulü (file://, javascript: reddi)
- Referer ve User-Agent CRLF / kontrol karakteri (header injection) reddi
- mpv yüklü değilken (Senaryo 12) MPV_NOT_INSTALLED hatasının döndürülmesi
- Sahte (mock) veya gerçek mpv ile argüman listesinin (--referrer, --user-agent) doğrulanması
"""

import json
import os
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
HOST_SCRIPT = ROOT_DIR / "native" / "mpv_host.py"
VALID_EXT_ID = "abcdefghijklmnopabcdefghijklmnop"
VALID_ORIGIN = f"chrome-extension://{VALID_EXT_ID}/"


def call_native_host(payload: dict, argv_args: list[str], extra_env: dict | None = None) -> tuple[int, dict]:
    encoded = json.dumps(payload).encode("utf-8")
    stdin_bytes = struct.pack("<I", len(encoded)) + encoded

    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)

    proc = subprocess.run(
        [sys.executable, str(HOST_SCRIPT), *argv_args],
        input=stdin_bytes,
        capture_output=True,
        env=env,
        timeout=10,
    )

    stdout = proc.stdout
    assert len(stdout) >= 4, f"Expected 4-byte header from host, got {len(stdout)} bytes. stderr={proc.stderr.decode()}"
    msg_len = struct.unpack("<I", stdout[:4])[0]
    body = stdout[4 : 4 + msg_len].decode("utf-8")
    return proc.returncode, json.loads(body)


def run_tests() -> None:
    print("=== Running macOS Native Messaging Host Tests ===")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)
        manifest_file = tmp_path / "com.talha.mpv.json"
        manifest_file.write_text(
            json.dumps(
                {
                    "name": "com.talha.mpv",
                    "path": str(HOST_SCRIPT),
                    "type": "stdio",
                    "allowed_origins": [VALID_ORIGIN],
                }
            ),
            encoding="utf-8",
        )
        base_env = {"MPV_HOST_MANIFEST_PATH": str(manifest_file)}

        # 1. Senaryo 13a: Komut satırında geçersiz origin varsa reddetmeli (JSON içinde sahte origin olsa bile!)
        code, resp = call_native_host(
            {
                "action": "open",
                "url": "https://example.com/video.mp4",
                "origin": VALID_ORIGIN,  # Sahte JSON içi origin kanıt kabul edilmemeli!
            },
            ["chrome-extension://pppppppppppppppppppppppppppppppp/"],
            extra_env=base_env,
        )
        assert resp["ok"] is False
        assert resp["error_code"] == "FORBIDDEN_ORIGIN"
        print("  [PASS] Scenario 13a: Unauthorized caller origin rejected (JSON 'origin' field ignored)")

        # 2. Senaryo 13b: Hiç origin argümanı yoksa reddetmeli
        code, resp = call_native_host(
            {"action": "ping"},
            [],
            extra_env=base_env,
        )
        assert resp["ok"] is False
        assert resp["error_code"] == "FORBIDDEN_ORIGIN"
        print("  [PASS] Scenario 13b: Missing caller origin argument rejected")

        # 3. Güvenlik: file:// veya javascript: protokolü reddedilmeli
        code, resp = call_native_host(
            {"action": "open", "url": "file:///etc/passwd"},
            [VALID_ORIGIN],
            extra_env=base_env,
        )
        assert resp["ok"] is False
        assert resp["error_code"] == "INVALID_URL"
        print("  [PASS] Security: Non-HTTP URLs (file://) rejected")

        # 4. Güvenlik: Referer ve User-Agent içinde CRLF (Header Injection) reddedilmeli
        code, resp = call_native_host(
            {
                "action": "open",
                "url": "https://example.com/master.m3u8",
                "referer": "https://example.com\r\nX-Injected: pwned",
                "user_agent": "Mozilla/5.0",
            },
            [VALID_ORIGIN],
            extra_env=base_env,
        )
        assert resp["ok"] is False
        assert resp["error_code"] == "INVALID_HEADER"
        print("  [PASS] Security: HTTP header injection (CRLF in Referer/User-Agent) rejected")

        # 5. Senaryo 12: mpv yüklü değilken anlaşılır MPV_NOT_INSTALLED hatası dönmeli
        # mpv_host.py içinde shutil.which sabit yollara da baktığı için birim fonksiyon üzerinden test ediyoruz
        sys.path.insert(0, str(ROOT_DIR / "native"))
        import mpv_host  # type: ignore

        orig_find = mpv_host.find_binary
        try:
            mpv_host.find_binary = lambda name: None
            res_missing = mpv_host.handle_message(
                {
                    "action": "open",
                    "url": "https://example.com/video.mp4",
                    "referer": "https://example.com",
                    "user_agent": "Mozilla/5.0",
                }
            )
            assert res_missing["ok"] is False
            assert res_missing["error_code"] == "MPV_NOT_INSTALLED"
            print("  [PASS] Scenario 12: Missing mpv binary returns clear MPV_NOT_INSTALLED error")
        finally:
            mpv_host.find_binary = orig_find

        # 6. Senaryo 1, 2, 4, 5: Sahte (mock) mpv binary'si ile gerçek subprocess.Popen argümanlarının doğrulanması
        args_log_file = tmp_path / "mpv_args.json"
        mock_mpv_script = tmp_path / "mock_mpv"
        mock_mpv_script.write_text(
            f"""#!/usr/bin/env python3
import json, sys
with open({repr(str(args_log_file))}, "w") as f:
    json.dump(sys.argv[1:], f)
""",
            encoding="utf-8",
        )
        mock_mpv_script.chmod(0o755)

        try:
            mpv_host.find_binary = lambda name: str(mock_mpv_script) if name == "mpv" else None
            res_ok = mpv_host.handle_message(
                {
                    "action": "open",
                    "url": "https://cdn.example.com/hls/master.m3u8?token=abc123",
                    "referer": "https://site.example.com/watch/42",
                    "user_agent": "CustomAgent/2.0",
                    "tab_id": 5,
                }
            )
            assert res_ok["ok"] is True
            assert res_ok["status"] == "mpv_launch_requested"

            # Arka planda başlayan mock_mpv'nin argüman dosyasını yazmasını bekle
            import time
            for _ in range(20):
                if args_log_file.exists():
                    break
                time.sleep(0.05)

            recorded_args = json.loads(args_log_file.read_text(encoding="utf-8"))
            assert "--referrer=https://site.example.com/watch/42" in recorded_args
            assert "--user-agent=CustomAgent/2.0" in recorded_args
            assert "--http-header-fields=Origin: https://site.example.com" in recorded_args
            assert recorded_args[-1] == "https://cdn.example.com/hls/master.m3u8?token=abc123"
            print("  [PASS] Scenario 1, 2, 4, 5: mpv spawned with exact --referrer, --user-agent, and stream URL")
        finally:
            mpv_host.find_binary = orig_find

    print("All Native Messaging Host tests passed successfully!")


if __name__ == "__main__":
    run_tests()

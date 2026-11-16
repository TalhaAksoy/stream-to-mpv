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
import shutil
import os
import struct
import subprocess
import sys
import tempfile
import time
import types
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

        import time

        def make_mock_binary(name: str, log_file: Path, stdout_text: str = "") -> Path:
            script = tmp_path / name
            script.write_text(
                f"""#!/usr/bin/env python3
import json, sys
with open({repr(str(log_file))}, "w") as f:
    json.dump(sys.argv[1:], f)
sys.stdout.write({repr(stdout_text)})
""",
                encoding="utf-8",
            )
            script.chmod(0o755)
            return script

        def wait_for_args(log_file: Path) -> list:
            for _ in range(40):
                if log_file.exists() and log_file.read_text(encoding="utf-8").strip():
                    break
                time.sleep(0.05)
            return json.loads(log_file.read_text(encoding="utf-8"))

        # 7. Uzantısız yakalanmış HLS akışı (örn. /w/<token>) kind=stream ile gelince ytdl_hook'a düşmemeli;
        #    Referer / User-Agent başlıkları korunmalı (eski davranış başlıkları siliyordu).
        mpv_log = tmp_path / "mpv_args_stream.json"
        mock_mpv = make_mock_binary("mock_mpv_stream", mpv_log)
        mock_ytdlp_unused = make_mock_binary("mock_ytdlp_unused", tmp_path / "unused.json")
        try:
            mpv_host.find_binary = lambda name: (
                str(mock_mpv) if name == "mpv" else str(mock_ytdlp_unused) if name == "yt-dlp" else None
            )
            res = mpv_host.handle_message(
                {
                    "action": "open",
                    "kind": "stream",
                    "url": "https://www.example-anime.test/w/AbCdEf123",
                    "referer": "https://www.example-anime.test/ep-6",
                    "user_agent": "BrowserUA/1.0",
                    "use_ytdlp_fallback": True,
                    "stream_format": "hls",
                    "title": "Episode 6",
                }
            )
            assert res["ok"] is True and res["resolved_via"] == "direct", res
            args = wait_for_args(mpv_log)
            assert "--referrer=https://www.example-anime.test/ep-6" in args, args
            assert "--user-agent=BrowserUA/1.0" in args, args
            assert "--force-media-title=Episode 6" in args, args
            # FFmpeg 7.1+ uzantısız/octet-stream HLS'yi kendiliğinden algılamaz: demuxer zorlanmalı
            assert "--demuxer-lavf-format=hls" in args, args
            assert not any(a.startswith("--ytdl-format") for a in args), args
            assert args[-1] == "https://www.example-anime.test/w/AbCdEf123"
            print("  [PASS] Extensionless captured HLS (kind=stream) keeps Referer/User-Agent and forces the HLS demuxer")
        finally:
            mpv_host.find_binary = orig_find

        # 8. mpv + sayfa URL'si (kind=page) yt-dlp yoksa sessizce yanlış açmak yerine anlaşılır hata dönmeli
        try:
            mpv_host.find_binary = lambda name: str(mock_mpv) if name == "mpv" else None
            res = mpv_host.handle_message(
                {"action": "open", "kind": "page", "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}
            )
            assert res["ok"] is False and res["error_code"] == "YTDLP_NOT_INSTALLED", res
            print("  [PASS] Page URL without yt-dlp returns YTDLP_NOT_INSTALLED instead of a dead fallback")
        finally:
            mpv_host.find_binary = orig_find

        # 9. VLC: Referer --http-referrer ile, User-Agent ise giriş seçeneği (:http-user-agent) olarak aktarılmalı
        #    (VLC 3 genel --http-user-agent bayrağını yok sayıp "VLC/3.x" gönderir)
        vlc_log = tmp_path / "vlc_args.json"
        mock_vlc = make_mock_binary("mock_vlc", vlc_log)
        try:
            mpv_host.find_binary = lambda name: str(mock_vlc) if name == "vlc" else None
            res = mpv_host.handle_message(
                {
                    "action": "open",
                    "player": "vlc",
                    "kind": "stream",
                    "url": "https://cdn.example.com/hls/master.m3u8?token=xyz",
                    "referer": "https://site.example.com/watch/1",
                    "user_agent": "BrowserUA/2.0",
                    "preferred_resolution": "720",
                }
            )
            assert res["ok"] is True and res["player"] == "vlc", res
            args = wait_for_args(vlc_log)
            assert "--http-referrer=https://site.example.com/watch/1" in args, args
            assert "--no-qt-privacy-ask" in args, "first-run privacy dialog must not block the player window"
            assert not any(a.startswith("--http-user-agent") for a in args), args
            assert "--adaptive-maxheight=720" in args, args
            assert args[-2:] == ["https://cdn.example.com/hls/master.m3u8?token=xyz", ":http-user-agent=BrowserUA/2.0"], args
            print("  [PASS] VLC spawned with --http-referrer, resolution cap, stream URL and :http-user-agent input option")
        finally:
            mpv_host.find_binary = orig_find

        # 10. VLC + sayfa URL'si: yt-dlp --dump-json ile ayrık video+ses çözülüp --input-slave ile verilmeli
        vlc_log2 = tmp_path / "vlc_args_page.json"
        mock_vlc2 = make_mock_binary("mock_vlc2", vlc_log2)
        ytdlp_json = json.dumps(
            {
                "requested_formats": [
                    {
                        "url": "https://rr1.googlevideo.test/video.m3u8",
                        "vcodec": "avc1",
                        "http_headers": {"User-Agent": "YtUA/1"},
                        "available_at": int(time.time()) + 4,
                    },
                    {"url": "https://rr1.googlevideo.test/audio.m3u8", "vcodec": "none"},
                ]
            }
        )
        mock_ytdlp = make_mock_binary("mock_ytdlp", tmp_path / "ytdlp_args.json", ytdlp_json + "\n")
        sleeps: list[float] = []
        orig_time = mpv_host.time
        try:
            mpv_host.time = types.SimpleNamespace(time=time.time, sleep=lambda secs: sleeps.append(secs))
            mpv_host.find_binary = lambda name: (
                str(mock_vlc2) if name == "vlc" else str(mock_ytdlp) if name == "yt-dlp" else None
            )
            res = mpv_host.handle_message(
                {"action": "open", "player": "vlc", "kind": "page", "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}
            )
            assert res["ok"] is True and res["resolved_via"] == "yt-dlp", res
            args = wait_for_args(vlc_log2)
            assert "--input-slave=https://rr1.googlevideo.test/audio.m3u8" in args, args
            assert args[-2:] == ["https://rr1.googlevideo.test/video.m3u8", ":http-user-agent=YtUA/1"], args
            # YouTube adresi "available_at" anına kadar 403 döner: VLC o ana kadar beklenip öyle başlatılmalı
            assert sleeps and 3 <= sleeps[0] <= mpv_host.MAX_AVAILABILITY_WAIT_SECONDS, sleeps
            ytdlp_args = json.loads((tmp_path / "ytdlp_args.json").read_text(encoding="utf-8"))
            assert "--dump-json" in ytdlp_args and ytdlp_args[-1] == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
            # VLC 3 ayrı video+ses HLS listelerini birlikte oynatamaz (siyah ekran / ilk karede donma):
            # ayrık parçalar yalnızca https (DASH) dosyalarından seçilmeli, HLS ancak tek akış (ses+video) olabilir
            fmt = ytdlp_args[ytdlp_args.index("-f") + 1]
            for alt in fmt.split("/"):
                if "+" in alt:
                    assert "m3u8" not in alt and alt.count("[protocol=https]") == 2, fmt
            assert fmt.split("/")[0].startswith("bestvideo[protocol=https][vcodec^=avc1]"), fmt
            assert "[height<=2160]" in mpv_host.build_vlc_format_selector("2160").split("/")[0], "4K choice must not be capped to H.264"
            assert "m3u8" in mpv_host.build_ytdl_format_selector("best"), "mpv keeps its HLS-first selector"
            print("  [PASS] VLC page URL resolved via yt-dlp (https DASH video+audio, never split HLS) with audio as --input-slave")
        finally:
            mpv_host.time = orig_time
            mpv_host.find_binary = orig_find

        # 11. Harici altyazılar: mpv'ye uzak adresler --sub-file ile (ilki tercih edilen) verilmeli; geçersizler atılmalı.
        #     VLC'ye ise tercih edilen altyazı Referer ile indirilip uzantısı içerikten belirlenmiş yerel dosya olarak.
        import http.server
        import threading

        class SubHandler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                if self.headers.get("Referer") != "https://player.example.com/":
                    self.send_response(403)
                    self.end_headers()
                    return
                body = b"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n"
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        sub_srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), SubHandler)
        threading.Thread(target=sub_srv.serve_forever, daemon=True).start()
        sub_url = f"http://127.0.0.1:{sub_srv.server_address[1]}/anime/x/subtitles/track_0_en"
        subs_msg = [{"url": sub_url, "lang": "en"}, {"url": "https://subs.example.com/ara-9.vtt", "lang": "ar"}, {"url": "file:///etc/passwd"}]
        mpv_log_sub = tmp_path / "mpv_args_subs.json"
        mock_mpv_sub = make_mock_binary("mock_mpv_sub", mpv_log_sub)
        vlc_log_sub = tmp_path / "vlc_args_subs.json"
        mock_vlc_sub = make_mock_binary("mock_vlc_sub", vlc_log_sub)
        try:
            mpv_host.find_binary = lambda name: str(mock_mpv_sub) if name == "mpv" else None
            res = mpv_host.handle_message(
                {"action": "open", "player": "mpv", "kind": "stream", "url": "https://cdn.example.com/master.m3u8",
                 "referer": "https://player.example.com/", "subtitles": subs_msg}
            )
            assert res["ok"] is True, res
            args = wait_for_args(mpv_log_sub)
            sub_args = [a for a in args if a.startswith("--sub-file=")]
            assert sub_args == [f"--sub-file={sub_url}", "--sub-file=https://subs.example.com/ara-9.vtt"], args
            assert args.index(sub_args[0]) < args.index("--"), "subtitle options must come before the URL separator"

            mpv_host.find_binary = lambda name: str(mock_vlc_sub) if name == "vlc" else None
            res = mpv_host.handle_message(
                {"action": "open", "player": "vlc", "kind": "stream", "url": "https://cdn.example.com/master.m3u8",
                 "referer": "https://player.example.com/", "subtitles": subs_msg}
            )
            assert res["ok"] is True, res
            args = wait_for_args(vlc_log_sub)
            vlc_sub = [a for a in args if a.startswith("--sub-file=")]
            assert len(vlc_sub) == 1, args
            local = Path(vlc_sub[0].split("=", 1)[1])
            assert local.suffix == ".vtt" and local.read_bytes().startswith(b"WEBVTT"), local
            shutil.rmtree(local.parent, ignore_errors=True)
            print("  [PASS] Subtitles: mpv gets remote --sub-file URLs (preferred first); VLC gets the preferred one downloaded with Referer as a local .vtt")
        finally:
            mpv_host.find_binary = orig_find
            sub_srv.shutdown()

        # 12. İzin listesinde olmayan oynatıcı / yol reddedilmeli; ping oynatıcı durumlarını döndürmeli
        res = mpv_host.handle_message({"action": "open", "player": "/bin/sh", "url": "https://example.com/a.mp4"})
        assert res["ok"] is False and res["error_code"] == "INVALID_PLAYER", res
        pong = mpv_host.handle_message({"action": "ping"})
        assert pong["ok"] is True and set(pong["players"]) == {"mpv", "vlc"} and pong["host_version"], pong
        print("  [PASS] Non-allowlisted player rejected; ping reports host_version and per-player availability")

    print("All Native Messaging Host tests passed successfully!")


if __name__ == "__main__":
    run_tests()

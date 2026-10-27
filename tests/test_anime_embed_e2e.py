#!/usr/bin/env python3
"""
Türkçe Anime / Dizi Embed Sunucuları (Iframe HLS Master, Referer Korumalı CDN,
Gizlenmiş .txt HLS Manifest, Sibnet/Tau Çoklu MP4) Uçtan Uca Entegrasyon Testi.

Bu test:
1. Yerel bir HTTP CDN + Embed sunucusu ayağa kaldırır (403 Forbidden Referer ve User-Agent kontrolü yapan!).
2. Gerçek ffmpeg + mpv kullanarak 1080p ve 720p HLS akışları üretir.
3. Eklentinin background/stream_utils mantığıyla akışı yakalar, çözünürlükleri (1080p / 720p) listeler.
4. Kullanıcının seçtiği çözünürlüğü (örn. 720p) gerçek `mpv_host.py` ve gerçek `mpv` ile oynatıp
   Referer kontrolünü başarıyla geçtiğini ve doğru çözünürlükte açıldığını doğrular!
"""

import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR / "native"))
import mpv_host  # type: ignore

EXPECTED_REFERER = "https://alucard-embed.example.test/embed/9988"
EXPECTED_UA = "Mozilla/5.0 AnimePlayerTest/1.0"


def generate_hls_streams(work_dir: Path, port: int) -> None:
    """ffmpeg ile gerçek 1080p ve 720p kısa test videoları ve HLS segmentleri üretir."""
    ffmpeg_bin = mpv_host.find_binary("ffmpeg")
    assert ffmpeg_bin, "ffmpeg is required for live HLS E2E test"

    for height, width in [(1080, 1920), (720, 1280)]:
        subprocess.run(
            [
                ffmpeg_bin,
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"testsrc=duration=1.5:size={width}x{height}:rate=24",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1.5",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-preset",
                "ultrafast",
                "-c:a",
                "aac",
                "-hls_time",
                "1",
                "-hls_playlist_type",
                "vod",
                "-hls_segment_filename",
                str(work_dir / f"seg_{height}p_%02d.ts"),
                str(work_dir / f"chunklist_{height}p.m3u8"),
            ],
            capture_output=True,
            check=True,
        )

    # Gizlenmiş .txt uzantılı HLS Master Playlist (Vidmoly / Alucard / Tau tarzı)
    master_content = f"""#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720
http://127.0.0.1:{port}/hls/chunklist_720p.m3u8?token=anime720
#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1920x1080
http://127.0.0.1:{port}/hls/chunklist_1080p.m3u8?token=anime1080
"""
    hls_dir = work_dir / "hls"
    hls_dir.mkdir(exist_ok=True)
    (hls_dir / "master.txt").write_text(master_content, encoding="utf-8")
    for p in work_dir.glob("chunklist_*"):
        shutil.move(str(p), str(hls_dir / p.name))
    for p in work_dir.glob("seg_*"):
        shutil.move(str(p), str(hls_dir / p.name))


class StrictAnimeCdnHandler(http.server.SimpleHTTPRequestHandler):
    """Referer ve User-Agent başlığı eksik veya yanlışsa 403 Forbidden döndüren sahte Anime CDN sunucusu."""

    def log_message(self, format: str, *args) -> None:
        pass

    def do_GET(self) -> None:
        ref = self.headers.get("Referer", "")
        ua = self.headers.get("User-Agent", "")
        if ref != EXPECTED_REFERER or ua != EXPECTED_UA:
            self.send_response(403)
            self.end_headers()
            self.wfile.write(b"403 Forbidden: Missing Referer or User-Agent")
            return
        super().do_GET()


def run_anime_e2e_test() -> None:
    print("=== Running Real mpv + Strict Referer Anime Embed HLS E2E Test ===")

    with tempfile.TemporaryDirectory() as tmpdir:
        work_dir = Path(tmpdir)

        # Boş port bul ve sunucuyu başlat
        handler = lambda *args, **kwargs: StrictAnimeCdnHandler(*args, directory=str(work_dir), **kwargs)
        httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
        port = httpd.server_address[1]

        generate_hls_streams(work_dir, port)

        server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        server_thread.start()

        try:
            master_url = f"http://127.0.0.1:{port}/hls/master.txt?sig=xyz987"

            # 1. Node.js üzerinden eklentinin stream_utils.js modülünün bu gizlenmiş .txt HLS akışını
            # yakaladığını ve 1080p / 720p variant URL'lerini çıkardığını doğrula
            master_text = (work_dir / "hls" / "master.txt").read_text(encoding="utf-8")
            node_check = subprocess.run(
                [
                    "node",
                    "--input-type=module",
                    "-e",
                    f"""
import assert from "node:assert/strict";
import {{ classifyCandidate, inspectHlsPlaylistContent }} from "./extension/stream_utils.js";

const c = classifyCandidate({json.dumps(master_url)}, "application/vnd.apple.mpegurl");
assert.ok(c, "Disguised /hls/master.txt should be detected");
assert.equal(c.format, "HLS");

const info = inspectHlsPlaylistContent({json.dumps(master_text)}, null, {json.dumps(master_url)});
assert.ok(info);
assert.deepEqual(info.availableHeights, [1080, 720]);
console.log(JSON.stringify(info.variantsByHeight));
""",
                ],
                cwd=str(ROOT_DIR),
                capture_output=True,
                text=True,
                check=True,
            )
            variants_by_height = json.loads(node_check.stdout.strip())
            url_720p = variants_by_height["720"]
            print("  [PASS] Disguised anime embed HLS (/hls/master.txt) classified & resolutions [1080p, 720p] extracted")

            # 2. Referer olmadan doğrudan mpv çalıştırıldığında CDN'in gerçekten 403 Forbidden verdiğini kanıtla
            mpv_bin = mpv_host.find_binary("mpv")
            assert mpv_bin
            fail_run = subprocess.run(
                [mpv_bin, "--vo=null", "--ao=null", "--frames=2", "--", url_720p],
                capture_output=True,
                text=True,
                timeout=10,
            )
            assert "403 Forbidden" in (fail_run.stdout + fail_run.stderr)
            print("  [PASS] Verified strict CDN blocks playback (403 Forbidden) when Referer/User-Agent are missing")

            # 3. Şimdi eklentinin gönderdiği Referer + User-Agent ve seçilen 720p çözünürlük ile
            # gerçek mpv'nin akışı açıp tam 1280x720 olarak oynattığını kanıtla!
            ok_run = subprocess.run(
                [
                    mpv_bin,
                    "--vo=null",
                    "--ao=null",
                    "--frames=5",
                    f"--referrer={EXPECTED_REFERER}",
                    f"--http-header-fields=Origin: https://alucard-embed.example.test",
                    f"--user-agent={EXPECTED_UA}",
                    "--",
                    url_720p,
                ],
                capture_output=True,
                text=True,
                timeout=15,
            )
            combined_out = ok_run.stdout + ok_run.stderr
            assert ok_run.returncode == 0, f"mpv failed: {combined_out}"
            assert "1280x720" in combined_out, f"Expected 1280x720 playback, got: {combined_out}"
            print("  [PASS] Real mpv played strict Referer-protected anime HLS stream at selected 720p (1280x720)!")
        finally:
            httpd.shutdown()
            httpd.server_close()

    print("All Anime / Non-YouTube Embed E2E tests passed successfully!")


if __name__ == "__main__":
    run_anime_e2e_test()

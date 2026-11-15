#!/usr/bin/env python3
"""
Disguised-HLS anime site fixture (TR Anime İzle tarzı yeni tema simülasyonu).

Gerçek sitede gözlemlenen yapıyı yerel olarak üretir; böylece eklenti testleri siteye bağımlı olmaz:
  /episode           -> Ana sayfa, oynatıcı doğrudan sayfada (hls.js), blob: MSE
  /w/<token>         -> Uzantısız HLS master playlist, Content-Type: application/octet-stream
  /w/<token>/v<n>    -> Uzantısız variant playlist (segmentler .jpeg kılıklı MPEG-TS)
  /seg/<r>/fileNNN.jpeg -> image/jpeg MIME ile sunulan TS segmentleri
  /wrapper           -> Sarmalayıcı iframe: /embed/?id=https://ok.ru/videoembed/1 (JWPlayer benzeri API)
  /hls2/<id>?gt=...  -> Sarmalayıcının text/plain olarak sunduğu HLS master'ı

Token "R" ile başlıyorsa (örn. /w/Rabc) Referer başlığı zorunludur (sıkı CDN simülasyonu).

Kullanım: python3 disguised_hls_server.py <port> <work_dir> [hls.js-url]
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

RENDITIONS = {"v0": (1280, 720, "1500k"), "v1": (640, 360, "500k")}
DEFAULT_HLSJS = "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"


def generate_segments(work_dir: Path) -> None:
    for name, (w, h, br) in RENDITIONS.items():
        out = work_dir / name
        if (out / "index.m3u8").exists():
            continue
        out.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-f", "lavfi", "-i", f"testsrc=size={w}x{h}:rate=25",
                "-f", "lavfi", "-i", "sine=frequency=440",
                "-t", "20", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", br,
                "-c:a", "aac", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod",
                "-hls_segment_filename", str(out / "file%03d.ts"), str(out / "index.m3u8"),
            ],
            check=True,
        )


def make_handler(work_dir: Path, hlsjs_url: str):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # sessiz; STM_FIXTURE_LOG ayarlıysa istekleri dosyaya yaz
            log_path = os.environ.get("STM_FIXTURE_LOG")
            if log_path:
                try:
                    with open(log_path, "a", encoding="utf-8") as fh:
                        fh.write(f"{time.strftime('%H:%M:%S')} {self.command} {self.path} sfm={self.headers.get('Sec-Fetch-Mode', '')}\n")
                except OSError:
                    pass

        def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            path = urlparse(self.path).path
            host = self.headers.get("Host", "127.0.0.1")
            base = f"http://{host}"

            if path == "/episode":
                html = f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixture Anime 6. Bolum</title>
<script src="{hlsjs_url}"></script></head>
<body style="margin:0;background:#111"><div id="player" style="width:100%;max-width:960px;aspect-ratio:16/9">
<video id="v" controls muted playsinline style="width:100%;height:100%"></video></div>
<script>
  const token = new URLSearchParams(location.search).get('t') || 'AbC123tok';
  // Gerçek sitedeki gibi: önce /api/watch/<id> sadece göreli playlist yolunu döndürür
  fetch('/api/watch/ep6').then(r => r.text()).then(p => {{
    const src = p.trim().replace('TOKEN', token);
    const v = document.getElementById('v');
    if (window.Hls && Hls.isSupported()) {{ const h = new Hls(); h.loadSource(src); h.attachMedia(v); }}
    else {{ v.src = src; }}
    v.play().catch(() => {{}});
  }});
</script></body></html>"""
                return self._send(200, html.encode(), "text/html; charset=utf-8")

            if path == "/api/watch/ep6":
                return self._send(200, b"/w/TOKEN", "text/html; charset=utf-8")

            if path == "/wrapper":
                # ?eh=http://localhost:PORT -> sarmalayıcı iframe'i farklı bir origin'den yüklenir (cross-origin)
                qs = parse_qs(urlparse(self.path).query)
                embed_origin = (qs.get("eh") or [""])[0]
                if not embed_origin.startswith(("http://", "https://")):
                    embed_origin = ""
                html = f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixture Wrapper Episode</title></head>
<body style="margin:0;background:#111"><iframe src="{embed_origin}/embed/?id=https://ok.ru/videoembed/18588112521757"
 style="width:100%;max-width:960px;aspect-ratio:16/9;border:0" allow="autoplay; fullscreen"></iframe></body></html>"""
                return self._send(200, html.encode(), "text/html; charset=utf-8")

            if path == "/embed/":
                html = f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><script src="{hlsjs_url}"></script></head>
<body style="margin:0;background:#000"><div class="jwplayer" id="jw" style="width:100vw;height:100vh">
<video id="v" muted playsinline style="width:100%;height:100%"></video></div>
<script>
  // Şifreli yapılandırma çözülmüş gibi: kaynak yalnızca oynatıcı nesnesinde var (ağda .m3u8 yok)
  const file = '/hls2/RHVHcFVx?gt=cFhTYWQy';
  const item = {{ sources: [{{ file, type: 'hls', label: 'Original' }}], allSources: [{{ file, type: 'hls' }}] }};
  const api = {{ getPlaylistItem: () => item, getContainer: () => document.getElementById('jw') }};
  window.jwplayer = (i) => (i === undefined || i === 0 ? api : {{}});
  const v = document.getElementById('v');
  const h = new Hls(); h.loadSource(file); h.attachMedia(v); v.play().catch(() => {{}});
</script></body></html>"""
                return self._send(200, html.encode(), "text/html; charset=utf-8")

            parts = [p for p in path.split("/") if p]

            # /w/<token> ve /w/<token>/v<n>
            if len(parts) >= 2 and parts[0] in ("w", "hls2"):
                token = parts[1]
                if token.startswith("R"):
                    ref = self.headers.get("Referer", "")
                    if not ref.startswith(base):
                        return self._send(
                            403, b'{"error":true,"message":"Baglanti gecersiz veya suresi dolmus"}',
                            "application/json",
                        )
                ctype = "application/octet-stream" if parts[0] == "w" else "text/plain"
                prefix = f"/{parts[0]}/{token}"
                if len(parts) == 2:
                    body = (
                        "#EXTM3U\n#EXT-X-VERSION:6\n"
                        '#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2"\n'
                        f"{prefix}/v0\n\n"
                        '#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360,CODECS="avc1.64001f,mp4a.40.2"\n'
                        f"{prefix}/v1\n"
                    )
                    return self._send(200, body.encode(), ctype)
                rend = parts[2]
                src = work_dir / rend / "index.m3u8"
                if rend in RENDITIONS and src.exists():
                    lines = []
                    for line in src.read_text().splitlines():
                        if line.endswith(".ts") and not line.startswith("#"):
                            line = f"{base}/seg/{rend}/{line[:-3]}.jpeg"
                        lines.append(line)
                    return self._send(200, ("\n".join(lines) + "\n").encode(), ctype)
                return self._send(404, b"not found", "text/plain")

            if len(parts) == 3 and parts[0] == "seg" and parts[1] in RENDITIONS and parts[2].endswith(".jpeg"):
                seg = work_dir / parts[1] / (parts[2][:-5] + ".ts")
                if seg.exists():
                    return self._send(200, seg.read_bytes(), "image/jpeg")

            return self._send(404, b"not found", "text/plain")

    return Handler


def start_server(port: int, work_dir: Path, hlsjs_url: str = DEFAULT_HLSJS) -> ThreadingHTTPServer:
    work_dir.mkdir(parents=True, exist_ok=True)
    generate_segments(work_dir)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(work_dir, hlsjs_url))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    wd = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/tmp/disguised_hls_fixture")
    hls = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_HLSJS
    srv = start_server(port, wd, hls)
    print(f"Fixture ready on http://127.0.0.1:{port}/episode", flush=True)
    threading.Event().wait()

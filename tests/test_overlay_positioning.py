#!/usr/bin/env python3
"""
Gerçek Chromium (Headless Chrome) üzerinde mobil/dar ekran ve iframe taşma (clipping) E2E testi.

Doğrulanan senaryolar:
1. Buton sol kenardayken (örn. tranimeizle mobil görünümü, 350x420) menünün sol kenardan kesilmemesi.
2. JWPlayer / Plyr kontrol ikonları videodan SONRA (asenkron) ve CSS `order` ile eklendiğinde
   `▶ mpv` butonunun otomatik olarak sağdaki ayar/tam ekran ikonlarının yanına geçmesi.
3. Çok basık 16:9 mobil iframe (320x180) + `overflow: hidden` + `transform: translateY(0)` altında
   Top Layer (`popover="manual"`) sayesinde menünün hiçbir kenardan kesilmemesi ve tıklanabilir kalması.
4. Sayfanın en üstündeki mobil oynatıcıda (390x780, video yüksekliği 210px, `.html5-video-player { overflow: hidden }`)
   menünün aşağı doğru açılırken oynatıcının `overflow: hidden` sınırına takılmaması.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
CONTENT_JS_PATH = ROOT_DIR / "extension" / "content.js"


def find_chrome_binary() -> str | None:
    candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        shutil.which("google-chrome") or "",
        shutil.which("chromium") or "",
    ]
    for path in candidates:
        if path and os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def build_test_html(content_js_code: str) -> str:
    # Chrome uzantı API'sini Android mobil senaryosuyla taklit et (4 öğe + Share butonu üretir)
    mock_chrome = """
    window.chrome = {
      runtime: {
        onMessage: { addListener: () => {} },
        sendMessage: async (msg) => {
          if (msg && msg.type === "GET_VIDEO_RESOLUTIONS") {
            return {
              ok: true,
              mode: "hls_master",
              heights: [1080, 720, 480],
              isAndroid: true,
              androidIntents: {
                best: "intent://cdn.example.com/master.m3u8#Intent;scheme=https;package=is.xyz.mpv;type=video/*;end",
                "1080": "intent://cdn.example.com/1080.m3u8#Intent;scheme=https;package=is.xyz.mpv;type=video/*;end",
                "720": "intent://cdn.example.com/720.m3u8#Intent;scheme=https;package=is.xyz.mpv;type=video/*;end",
                "480": "intent://cdn.example.com/480.m3u8#Intent;scheme=https;package=is.xyz.mpv;type=video/*;end"
              },
              streamUrls: {
                best: "https://cdn.example.com/master.m3u8"
              }
            };
          }
          return { ok: true };
        }
      }
    };
    """

    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    html, body {{
      margin: 0;
      padding: 0;
      background: #111;
      color: #fff;
      font-family: sans-serif;
    }}
    .player-shell {{
      position: relative;
      width: 100%;
      height: var(--player-h, 100vh);
      overflow: hidden;
      background: #000;
    }}
    video {{
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
    }}
    .control-bar {{
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 40px;
      display: flex;
      align-items: center;
      padding: 0 6px;
      box-sizing: border-box;
      background: rgba(0, 0, 0, 0.7);
      overflow: hidden;
      transform: translateY(0);
      backdrop-filter: blur(4px);
    }}
    .spacer {{
      flex: 1 1 auto;
    }}
    .icon-btn {{
      width: 28px;
      height: 28px;
      flex-shrink: 0;
    }}
  </style>
</head>
<body>
  <div id="mount"></div>
  <script>{mock_chrome}</script>
  <script>{content_js_code}</script>
  <script>
    async function waitFrames(n = 3) {{
      for (let i = 0; i < n; i++) {{
        await new Promise((r) => requestAnimationFrame(r));
      }}
    }}

    window.runScenario = async function(kind) {{
      const mount = document.getElementById("mount");
      mount.innerHTML = "";
      document.documentElement.style.removeProperty("--player-h");

      if (kind === "left_edge_button") {{
        // Özel bir kontrol barında buton en solda (x ≈ 6px) olsa bile menü soldan kesilmemeli!
        mount.innerHTML = `
          <div class="player-shell jwplayer">
            <video src="https://cdn.example.com/v.mp4"></video>
            <div class="control-bar jw-button-container">
              <div class="spacer" style="order: 10"></div>
            </div>
          </div>
        `;
        await waitFrames(4);
        const host = document.querySelector("[data-mpv-control-host]");
        // Zorla en sola sabitle (kullanıcının ekran görüntüsündeki senaryoyu birebir simüle et)
        host.style.order = "-1";
        await waitFrames(2);
      }} else if (kind === "async_jwplayer_order") {{
        // Önce <video> ve boş .jw-button-container oluşur, 40ms sonra sağ/sol ikonlar CSS order ile eklenir
        mount.innerHTML = `
          <div class="player-shell jwplayer">
            <video src="https://cdn.example.com/v.mp4"></video>
            <div class="control-bar jw-button-container"></div>
          </div>
        `;
        await waitFrames(3);
        const bar = mount.querySelector(".jw-button-container");
        bar.insertAdjacentHTML("beforeend", `
          <div class="icon-btn jw-icon-volume" style="order: 3"></div>
          <div class="spacer jw-spacer" style="order: 6"></div>
          <div class="icon-btn jw-icon-settings" style="order: 9"></div>
          <div class="icon-btn jw-icon-pip" style="order: 10"></div>
          <div class="icon-btn jw-icon-fullscreen" style="order: 12"></div>
        `);
        await waitFrames(4);
      }} else if (kind === "cramped_16_9_iframe") {{
        mount.innerHTML = `
          <div class="player-shell video-js">
            <video src="https://cdn.example.com/v.mp4"></video>
            <div class="control-bar vjs-control-bar">
              <div class="spacer"></div>
              <div class="icon-btn vjs-fullscreen-control"></div>
            </div>
          </div>
        `;
        await waitFrames(4);
      }} else if (kind === "top_of_page_youtube") {{
        document.documentElement.style.setProperty("--player-h", "205px");
        mount.innerHTML = `
          <div class="player-shell html5-video-player">
            <video src="https://cdn.example.com/v.mp4"></video>
            <div class="control-bar ytp-right-controls" style="justify-content: flex-end;">
              <div class="icon-btn"></div>
            </div>
          </div>
          <div style="height: 600px; padding: 16px;">Page content below video</div>
        `;
        await waitFrames(4);
      }}

      const host = document.querySelector("[data-mpv-control-host]");
      const shadow = host.shadowRoot;
      const trigger = shadow.querySelector(".mpv-trigger");
      const menu = shadow.querySelector(".mpv-menu");

      trigger.click();
      await new Promise((r) => setTimeout(r, 60));
      await waitFrames(2);

      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const items = [...shadow.querySelectorAll(".mpv-item")];
      const firstItemRect = items[0].getBoundingClientRect();

      // Görsel kesilme (overflow: hidden clipping) testi:
      // Menü gerçekten Top Layer'daysa, menünün sol-orta ve sağ-orta noktalarında elementFromPoint host'u görür!
      const probeLeftX = Math.round(menuRect.left + 14);
      const probeRightX = Math.round(menuRect.right - 14);
      const probeY = Math.round(firstItemRect.top + firstItemRect.height / 2);

      const outerHitLeft = document.elementFromPoint(probeLeftX, probeY);
      const outerHitRight = document.elementFromPoint(probeRightX, probeY);
      const shadowHitLeft = shadow.elementFromPoint(probeLeftX, probeY);
      const shadowHitRight = shadow.elementFromPoint(probeRightX, probeY);

      return {{
        vw: window.innerWidth,
        vh: window.innerHeight,
        triggerLeft: triggerRect.left,
        triggerRight: triggerRect.right,
        menuLeft: menuRect.left,
        menuRight: menuRect.right,
        menuTop: menuRect.top,
        menuBottom: menuRect.bottom,
        menuWidth: menuRect.width,
        menuHeight: menuRect.height,
        outerHitLeftIsHost: outerHitLeft === host,
        outerHitRightIsHost: outerHitRight === host,
        shadowHitLeftInsideMenu: Boolean(shadowHitLeft && menu.contains(shadowHitLeft)),
        shadowHitRightInsideMenu: Boolean(shadowHitRight && menu.contains(shadowHitRight)),
      }};
    }};
  </script>
</body>
</html>
"""


class MiniCDP:
    """Basit WebSocket/CDP istemcisi (harici Python paketi gerektirmez)."""

    def __init__(self, ws_url: str):
        import base64
        import hashlib
        from urllib.parse import urlparse

        parsed = urlparse(ws_url)
        self.sock = socket.create_connection((parsed.hostname, parsed.port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        handshake = (
            f"GET {parsed.path} HTTP/1.1\r\n"
            f"Host: {parsed.hostname}:{parsed.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(handshake.encode("ascii"))
        resp = b""
        while b"\r\n\r\n" not in resp:
            resp += self.sock.recv(4096)
        expected = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
        ).decode()
        assert expected in resp.decode("latin1"), f"WebSocket handshake failed: {resp!r}"
        self.next_id = 1

    def _send_frame(self, payload: bytes) -> None:
        mask = os.urandom(4)
        header = bytearray([0x81])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(length.to_bytes(2, "big"))
        else:
            header.append(0x80 | 127)
            header.extend(length.to_bytes(8, "big"))
        header.extend(mask)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def _recv_exact(self, n: int) -> bytes:
        buf = bytearray()
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("WebSocket closed")
            buf.extend(chunk)
        return bytes(buf)

    def _recv_frame(self) -> str:
        while True:
            b1, b2 = self._recv_exact(2)
            opcode = b1 & 0x0F
            masked = bool(b2 & 0x80)
            length = b2 & 0x7F
            if length == 126:
                length = int.from_bytes(self._recv_exact(2), "big")
            elif length == 127:
                length = int.from_bytes(self._recv_exact(8), "big")
            mask = self._recv_exact(4) if masked else b""
            data = self._recv_exact(length)
            if masked:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if opcode == 0x8:
                raise ConnectionError("WebSocket closed by peer")
            if opcode == 0x9:
                # Ping -> Pong
                pong = bytearray([0x8A, 0x80]) + os.urandom(4)
                self.sock.sendall(bytes(pong))
                continue
            if opcode == 0x1:
                return data.decode("utf-8")

    def call(self, method: str, params: dict | None = None) -> dict:
        msg_id = self.next_id
        self.next_id += 1
        self._send_frame(json.dumps({"id": msg_id, "method": method, "params": params or {}}).encode("utf-8"))
        while True:
            msg = json.loads(self._recv_frame())
            if msg.get("id") == msg_id:
                if "error" in msg:
                    raise RuntimeError(f"CDP error on {method}: {msg['error']}")
                return msg.get("result", {})

    def close(self) -> None:
        try:
            self.sock.close()
        except Exception:
            pass


def assert_menu_fully_visible(label: str, r: dict) -> None:
    assert r["menuWidth"] >= 150, f"[{label}] Menu too narrow: {r}"
    assert r["menuHeight"] >= 80, f"[{label}] Menu too short: {r}"
    assert r["menuLeft"] >= 6, f"[{label}] Menu clipped on LEFT! {r}"
    assert r["menuRight"] <= r["vw"] - 6, f"[{label}] Menu clipped on RIGHT! {r}"
    assert r["menuTop"] >= 6, f"[{label}] Menu clipped on TOP! {r}"
    assert r["menuBottom"] <= r["vh"] - 6, f"[{label}] Menu clipped on BOTTOM! {r}"
    assert r["outerHitLeftIsHost"] and r["shadowHitLeftInsideMenu"], (
        f"[{label}] Left side of menu visually clipped by ancestor overflow! {r}"
    )
    assert r["outerHitRightIsHost"] and r["shadowHitRightInsideMenu"], (
        f"[{label}] Right side of menu visually clipped by ancestor overflow! {r}"
    )
    print(
        f"  [PASS] {label}: menu=[{r['menuLeft']:.0f}..{r['menuRight']:.0f} x "
        f"{r['menuTop']:.0f}..{r['menuBottom']:.0f}] inside {r['vw']}x{r['vh']} (unclipped in Top Layer)"
    )


def main() -> None:
    print("=== Running Mobile Viewport & Overflow Clipping UI Tests (Headless Chrome) ===")
    chrome_bin = find_chrome_binary()
    if not chrome_bin:
        print("  [SKIP] Google Chrome / Chromium not found; skipping headless UI geometry test.")
        return

    content_js = CONTENT_JS_PATH.read_text(encoding="utf-8")
    port = pick_free_port()

    with tempfile.TemporaryDirectory(prefix="mpv_ui_test_") as tmp_dir:
        html_file = Path(tmp_dir) / "test.html"
        html_file.write_text(build_test_html(content_js), encoding="utf-8")
        profile_dir = Path(tmp_dir) / "profile"

        proc = subprocess.Popen(
            [
                chrome_bin,
                "--headless=new",
                f"--remote-debugging-port={port}",
                f"--user-data-dir={profile_dir}",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-gpu",
                html_file.as_uri(),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        cdp: MiniCDP | None = None
        try:
            targets = None
            for _ in range(40):
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                        page_targets = [t for t in data if t.get("type") == "page"]
                        if page_targets:
                            targets = page_targets
                            break
                except Exception:
                    time.sleep(0.1)

            assert targets, "Failed to connect to Headless Chrome DevTools target"
            cdp = MiniCDP(targets[0]["webSocketDebuggerUrl"])
            cdp.call("Page.enable")
            cdp.call("Runtime.enable")

            # Sayfanın yüklenmesini bekle
            for _ in range(30):
                ready = cdp.call(
                    "Runtime.evaluate",
                    {"expression": "typeof window.runScenario === 'function'", "returnByValue": True},
                )
                if ready.get("result", {}).get("value") is True:
                    break
                time.sleep(0.1)

            def run_case(width: int, height: int, scenario: str) -> dict:
                cdp.call(
                    "Emulation.setDeviceMetricsOverride",
                    {"width": width, "height": height, "deviceScaleFactor": 2, "mobile": True},
                )
                res = cdp.call(
                    "Runtime.evaluate",
                    {
                        "expression": f"window.runScenario({json.dumps(scenario)})",
                        "awaitPromise": True,
                        "returnByValue": True,
                    },
                )
                return res["result"]["value"]

            # Test 1: Kullanıcının bildirdiği tranimeizle mobil sol kenar kesilme senaryosu (350x420)
            r1 = run_case(350, 420, "left_edge_button")
            assert_menu_fully_visible("Scenario 1 (Button forced to far-left on 350x420 mobile iframe)", r1)

            # Test 2: Asenkron JWPlayer kontrol barı + CSS flex `order` -> buton sağ tarafa yerleşmeli
            r2 = run_case(350, 420, "async_jwplayer_order")
            assert r2["triggerLeft"] > 175, f"Expected trigger to move to right half of JWPlayer bar, got: {r2}"
            assert_menu_fully_visible("Scenario 2 (Async JWPlayer flex order -> right-side button + menu)", r2)

            # Test 3: Çok basık 16:9 mobil iframe (320x180) + overflow: hidden + transform
            r3 = run_case(320, 180, "cramped_16_9_iframe")
            assert_menu_fully_visible("Scenario 3 (Cramped 320x180 16:9 mobile iframe with overflow:hidden)", r3)

            # Test 4: Sayfanın en üstündeki mobil video (390x780, player height 205px, aşağı açılma)
            r4 = run_case(390, 780, "top_of_page_youtube")
            assert r4["menuTop"] > 200, f"Expected menu to open downward below top-of-page player: {r4}"
            assert_menu_fully_visible("Scenario 4 (Top-of-page mobile video opening downward over overflow:hidden)", r4)

            print("All 4 mobile viewport & Top-Layer overflow scenarios passed!\n")
        finally:
            if cdp:
                cdp.close()
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    main()

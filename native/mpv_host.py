#!/usr/bin/env python3
"""
macOS & Linux Native Messaging Host (com.talha.mpv)
Chromium eklentisinden gelen doğrulanmış medya akışlarını harici mpv oynatıcısında başlatır.
macOS sistem Python 3.9 (/usr/bin/python3) ve üzeri tüm sürümlerle %100 uyumludur.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

# Maksimum kabul edilebilir mesaj boyutu (64 KB)
MAX_MESSAGE_BYTES = 65536

# Kontrol karakteri filtresi (HTTP header injection ve komut enjeksiyonuna karşı)
CONTROL_CHAR_REGEX = re.compile(r"[\x00-\x1f\x7f]")

# Chromium eklenti origin formatı: chrome-extension://<32-karakterli-id>/
CHROME_EXT_ORIGIN_REGEX = re.compile(r"^chrome-extension://[a-p]{32}/?$")
# Firefox (Gecko) eklenti kimliği
GECKO_EXT_ID = "stream-to-mpv@talha.dev"

# Host sürümü (eklenti eski bir ~/mpv_host kopyasını ping ile tespit edebilsin diye)
HOST_VERSION = "1.2.1"

# İzin verilen harici oynatıcılar (yol asla mesajdan alınmaz)
SUPPORTED_PLAYERS = ("mpv", "vlc")


def log_stderr(message: str) -> None:
    """
    Hata ayıklama mesajlarını yalnızca stderr'e yazar.
    Güvenlik gereği imzalı tam URL'ler veya hassas başlıklar loglanmaz.
    """
    try:
        sys.stderr.write(f"[com.talha.mpv] {message}\n")
        sys.stderr.flush()
    except Exception:
        pass


def send_response(payload: dict) -> None:
    """
    Standart Native Messaging protokolüne uygun olarak 4-byte little-endian uzunluk
    ve UTF-8 JSON mesajını stdout üzerinden gönderir.
    """
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def read_message() -> dict | None:
    """
    stdin üzerinden 4-byte little-endian uzunluk başlığını ve ardından UTF-8 JSON gövdesini okur.
    """
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    if len(raw_length) < 4:
        raise ValueError("Incomplete message length header.")

    msg_length = struct.unpack("<I", raw_length)[0]
    if msg_length <= 0 or msg_length > MAX_MESSAGE_BYTES:
        raise ValueError(f"Invalid message length: {msg_length}")

    raw_body = sys.stdin.buffer.read(msg_length)
    if len(raw_body) < msg_length:
        raise ValueError("Incomplete message body.")

    parsed = json.loads(raw_body.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError("Message root must be a JSON object.")
    return parsed


def load_allowed_origins() -> set[str]:
    """
    Ev dizinindeki veya çalışma ortamındaki Native Messaging manifest dosyalarından
    ya da aynı klasördeki allowed_origins.json yapılandırmasından izin verilen origin listesini yükler.
    """
    allowed = set()
    home = Path.home()

    manifest_candidates = [
        Path(__file__).resolve().parent / "com.talha.mpv.json",
        home / "Library/Application Support/Chromium/NativeMessagingHosts/com.talha.mpv.json",
        home / "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.talha.mpv.json",
        home / "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.talha.mpv.json",
        home / "Library/Application Support/Vivaldi/NativeMessagingHosts/com.talha.mpv.json",
        home / "Library/Application Support/Arc/User Data/NativeMessagingHosts/com.talha.mpv.json",
        home / "Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.talha.mpv.json",
        home / "Library/Application Support/com.operasoftware.Opera/NativeMessagingHosts/com.talha.mpv.json",
    ]

    # Linux: XDG yapılandırma dizinindeki Chromium tabanlı tarayıcı manifestleri
    config_home = Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config")
    for browser_dir in (
        "chromium",
        "google-chrome",
        "google-chrome-beta",
        "google-chrome-unstable",
        "BraveSoftware/Brave-Browser",
        "microsoft-edge",
        "vivaldi",
        "thorium",
    ):
        manifest_candidates.append(config_home / browser_dir / "NativeMessagingHosts/com.talha.mpv.json")

    env_manifest = os.environ.get("MPV_HOST_MANIFEST_PATH")
    if env_manifest:
        manifest_candidates.insert(0, Path(env_manifest))

    for path in manifest_candidates:
        try:
            if path.is_file():
                data = json.loads(path.read_text(encoding="utf-8"))
                origins = data.get("allowed_origins", [])
                if isinstance(origins, list):
                    for item in origins:
                        if isinstance(item, str) and item.strip():
                            allowed.add(item.strip().rstrip("/"))
        except Exception as exc:
            log_stderr(f"Failed to read manifest at {path.name}: {exc}")

    return allowed


def verify_caller_origin(argv: list[str]) -> tuple[bool, str]:
    """
    Tarayıcı (Chromium veya Firefox) tarafından native host'a komut satırı argümanı
    olarak aktarılan origin veya eklenti kimliğini doğrular.
    ÖNEMLİ: JSON mesajının içindeki herhangi bir 'origin' alanına ASLA güvenilmez;
    yalnızca tarayıcının argv üzerinden geçirdiği argüman kontrol edilir.
    """
    caller_origin = None
    is_gecko = False

    for arg in argv[1:]:
        cleaned = arg.strip().rstrip("/")
        if cleaned.startswith("chrome-extension://"):
            caller_origin = cleaned
            break
        if cleaned == GECKO_EXT_ID:
            caller_origin = cleaned
            is_gecko = True
            break

    if not caller_origin:
        return False, "Missing or invalid browser caller origin argument."

    if is_gecko:
        return True, caller_origin

    if not CHROME_EXT_ORIGIN_REGEX.match(caller_origin + "/"):
        return False, "Malformed chrome-extension caller origin."

    # Yerel manifest içindeki allowed_origins ile karşılaştır
    allowed_origins = load_allowed_origins()
    valid_configured = {
        o for o in allowed_origins if CHROME_EXT_ORIGIN_REGEX.match(o + "/")
    }

    if valid_configured and caller_origin not in valid_configured:
        return False, "Caller extension origin is not in allowed_origins."

    return True, caller_origin


def build_augmented_path() -> str:
    """
    macOS GUI uygulamalarının (Chromium/Chrome) kısıtlı PATH ortamına karşı
    Apple Silicon (/opt/homebrew/bin) ve Intel (/usr/local/bin) Homebrew dizinlerini,
    Linux'ta ise pip/pipx kurulumları için ~/.local/bin dizinini PATH'e ekler.
    """
    current_path = os.environ.get("PATH", "")
    path_parts = [p for p in current_path.split(os.pathsep) if p]
    extra_dirs = [
        str(Path.home() / ".local/bin"),
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/Applications/mpv.app/Contents/MacOS",
        "/usr/bin",
        "/bin",
    ]
    for d in extra_dirs:
        if d not in path_parts:
            path_parts.insert(0, d)
    return os.pathsep.join(path_parts)


def find_binary(name: str) -> str | None:
    """
    Binary yolunu kodda sabitlemeden (hardcode etmeden) genişletilmiş PATH üzerinde shutil.which ile bulur.
    """
    search_path = build_augmented_path()
    return shutil.which(name, path=search_path)


def validate_http_url(raw_url: str) -> tuple[bool, str]:
    """
    URL'nin yalnızca geçerli bir http:// veya https:// adresi olduğunu ve kontrol karakteri içermediğini doğrular.
    file://, javascript:, data: veya özel protokoller kesinlikle reddedilir.
    """
    if not raw_url or not isinstance(raw_url, str):
        return False, "URL is required and must be a string."

    raw_url = raw_url.strip()
    if len(raw_url) > 8192:
        return False, "URL exceeds maximum allowed length."

    if CONTROL_CHAR_REGEX.search(raw_url):
        return False, "URL contains forbidden control characters."

    try:
        parsed = urlparse(raw_url)
    except Exception:
        return False, "Malformed URL."

    if parsed.scheme not in ("http", "https"):
        return False, "Only http:// and https:// URLs are permitted."

    if not parsed.netloc:
        return False, "URL is missing host/domain."

    return True, raw_url


def validate_header_field(value: str, field_name: str) -> tuple[bool, str]:
    """
    Referer ve User-Agent değerlerinde HTTP header injection oluşturabilecek
    CR/LF (\r, \n) veya diğer kontrol karakterlerini reddeder.
    """
    if value is None:
        return True, ""
    if not isinstance(value, str):
        return False, f"{field_name} must be a string."

    if len(value) > 2048:
        return False, f"{field_name} exceeds maximum length."

    if CONTROL_CHAR_REGEX.search(value):
        return False, f"{field_name} contains forbidden control characters (possible header injection)."

    return True, value.strip()


def looks_like_direct_stream(url: str) -> bool:
    """
    URL'nin doğrudan HLS (.m3u8), MP4 veya WebM akışı olup olmadığını kontrol eder.
    """
    lower = url.lower()
    return (
        ".m3u8" in lower
        or ".mp4" in lower
        or ".webm" in lower
        or ".m4v" in lower
        or ".mov" in lower
    )


def find_player_binary(player: str) -> str | None:
    """
    İzin verilen oynatıcının (mpv / vlc) çalıştırılabilir dosyasını bulur.
    Yol asla mesajdan alınmaz; yalnızca sabit isimler ve bilinen uygulama paketleri denenir.
    """
    if player == "mpv":
        return find_binary("mpv")
    if player == "vlc":
        found = find_binary("vlc")
        if found:
            return found
        mac_vlc = Path("/Applications/VLC.app/Contents/MacOS/VLC")
        home_mac_vlc = Path.home() / "Applications/VLC.app/Contents/MacOS/VLC"
        for candidate in (mac_vlc, home_mac_vlc):
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
    return None


def build_ytdl_format_selector(preferred_resolution: str) -> str:
    """
    Kullanıcının seçtiği çözünürlüğe (örn: 'best', '2160', '1440', '1080', '720', '480', '360', 'audio')
    göre YouTube SABR 403 uyumlu (m3u8 öncelikli) güvenli ytdl-format dizgesini oluşturur.
    """
    pref = (preferred_resolution or "best").strip().lower()
    if pref == "audio":
        return "bestaudio[protocol*=m3u8]/bestaudio/best"

    if pref.isdigit():
        h = int(pref)
        if 144 <= h <= 4320:
            return (
                f"bestvideo[height<={h}][protocol*=m3u8]+bestaudio[protocol*=m3u8]"
                f"/best[height<={h}][protocol*=m3u8]"
                f"/bestvideo[height<={h}]+bestaudio"
                f"/best[height<={h}]/best"
            )

    return "bestvideo[protocol*=m3u8]+bestaudio[protocol*=m3u8]/best[protocol*=m3u8]/bestvideo+bestaudio/best"


def resolve_with_ytdlp(
    url: str, referer: str, user_agent: str, preferred_resolution: str = "best"
) -> tuple[bool, dict | str]:
    """
    yt-dlp --dump-json ile sayfa URL'sinden oynatılabilir medya URL'lerini (ve gerekli başlıkları) çözümler.
    Ayrık video+ses formatlarında ses izini ayrıca döndürür. Kesinlikle dosya indirme işlemi başlatmaz.
    Dönen sözlük: {"url", "audio_url", "user_agent", "referer"}
    """
    ytdlp_bin = find_binary("yt-dlp")
    if not ytdlp_bin:
        return False, "yt-dlp is not installed (required to resolve this page for the selected player)."

    cmd = [
        ytdlp_bin,
        "--no-playlist",
        "--no-warnings",
        "--dump-json",
        "-f",
        build_ytdl_format_selector(preferred_resolution),
    ]
    if referer:
        cmd.extend(["--referer", referer])
    if user_agent:
        cmd.extend(["--user-agent", user_agent])

    cmd.extend(["--", url])

    env = os.environ.copy()
    env["PATH"] = build_augmented_path()

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=25,
            shell=False,
            env=env,
        )
        if proc.returncode != 0 or not proc.stdout.strip():
            return False, "yt-dlp could not resolve a playable stream URL."

        info = json.loads(proc.stdout.strip().splitlines()[0])
        if not isinstance(info, dict):
            return False, "yt-dlp returned unexpected output."

        video_url = ""
        audio_url = ""
        headers = info.get("http_headers") if isinstance(info.get("http_headers"), dict) else {}

        requested = info.get("requested_formats")
        if isinstance(requested, list) and requested:
            for fmt in requested:
                if not isinstance(fmt, dict):
                    continue
                f_url = fmt.get("url") or ""
                has_video = fmt.get("vcodec") not in (None, "none")
                if has_video and not video_url:
                    video_url = f_url
                    if isinstance(fmt.get("http_headers"), dict):
                        headers = fmt["http_headers"]
                elif not has_video and not audio_url:
                    audio_url = f_url
            if not video_url and audio_url:
                video_url, audio_url = audio_url, ""
        else:
            video_url = info.get("url") or ""

        ok_url, validated = validate_http_url(video_url)
        if not ok_url:
            return False, "yt-dlp returned a non-HTTP URL."

        result = {"url": validated, "audio_url": "", "user_agent": "", "referer": ""}
        if audio_url:
            ok_audio, validated_audio = validate_http_url(audio_url)
            if ok_audio:
                result["audio_url"] = validated_audio

        ok_ua, ua_val = validate_header_field(str(headers.get("User-Agent", "") or ""), "User-Agent")
        if ok_ua:
            result["user_agent"] = ua_val
        ok_ref, ref_val = validate_header_field(str(headers.get("Referer", "") or ""), "Referer")
        if ok_ref:
            result["referer"] = ref_val
        return True, result
    except subprocess.TimeoutExpired:
        return False, "yt-dlp resolution timed out."
    except Exception as exc:
        log_stderr(f"yt-dlp error: {type(exc).__name__}")
        return False, "Failed to execute yt-dlp."


def spawn_detached(cmd: list[str], player: str) -> tuple[bool, dict]:
    """
    Oynatıcıyı ayrı oturumda (start_new_session=True) ve argüman listesiyle (shell=False) başlatır.
    """
    env = os.environ.copy()
    env["PATH"] = build_augmented_path()

    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            shell=False,
            env=env,
        )
        return True, {
            "ok": True,
            "status": f"{player}_launch_requested",
            "message": f"{player} launch requested",
            "player": player,
            "pid": proc.pid,
        }
    except Exception as exc:
        log_stderr(f"Failed to spawn {player}: {type(exc).__name__}")
        return False, {
            "ok": False,
            "error_code": "PLAYER_SPAWN_ERROR" if player != "mpv" else "MPV_SPAWN_ERROR",
            "error": f"Failed to start {player} process: {type(exc).__name__}",
        }


def origin_from_referer(referer: str) -> str:
    try:
        parsed_ref = urlparse(referer)
        if parsed_ref.scheme in ("http", "https") and parsed_ref.netloc:
            return f"{parsed_ref.scheme}://{parsed_ref.netloc}"
    except Exception:
        pass
    return ""


MAX_SUBTITLES = 8
MAX_SUBTITLE_BYTES = 4 * 1024 * 1024
SUBTITLE_TEMP_PREFIX = "stream-to-mpv-subs-"


def parse_subtitles(raw) -> list[str]:
    """Eklentiden gelen altyazı listesini (ilk eleman tercih edilen) doğrular; geçerli http(s) URL'leri döndürür."""
    urls: list[str] = []
    if not isinstance(raw, list):
        return urls
    for item in raw[:MAX_SUBTITLES]:
        url = item.get("url", "") if isinstance(item, dict) else ""
        ok, value = validate_http_url(url)
        if ok and value not in urls:
            urls.append(value)
    return urls


def cleanup_old_subtitle_dirs(max_age_seconds: int = 24 * 3600) -> None:
    base = Path(tempfile.gettempdir())
    now = time.time()
    try:
        for entry in base.glob(f"{SUBTITLE_TEMP_PREFIX}*"):
            try:
                if entry.is_dir() and now - entry.stat().st_mtime > max_age_seconds and entry.owner() == Path.home().owner():
                    shutil.rmtree(entry, ignore_errors=True)
            except OSError:
                continue
    except OSError:
        pass


def download_subtitle(url: str, referer: str, user_agent: str) -> str:
    """
    Altyazıyı (Referer / User-Agent ile) özel bir geçici klasöre indirir ve yerel yolunu döndürür.
    VLC uzak altyazıyı türünü dosya uzantısından anladığı için uzantısız adresleri (ör. .../track_0_en) açamaz;
    yerel dosyaya içeriğe göre doğru uzantı verilir. Başarısızsa "".
    """
    headers = {"User-Agent": user_agent or "Mozilla/5.0"}
    if referer:
        headers["Referer"] = referer
        origin_val = origin_from_referer(referer)
        if origin_val:
            headers["Origin"] = origin_val
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as res:
            data = res.read(MAX_SUBTITLE_BYTES + 1)
    except Exception as exc:
        log_stderr(f"Subtitle download failed: {type(exc).__name__}")
        return ""
    if not data or len(data) > MAX_SUBTITLE_BYTES:
        return ""
    head = data[:200].lstrip(b"\xef\xbb\xbf").lstrip()
    if head.startswith(b"WEBVTT"):
        ext = ".vtt"
    elif head.startswith(b"[Script Info]"):
        ext = ".ass"
    elif re.match(rb"\d+\s*\r?\n\d\d:\d\d", head):
        ext = ".srt"
    else:
        return ""
    cleanup_old_subtitle_dirs()
    folder = tempfile.mkdtemp(prefix=SUBTITLE_TEMP_PREFIX)
    path = Path(folder) / f"subtitle{ext}"
    path.write_bytes(data)
    return str(path)


def launch_mpv(
    url: str,
    referer: str,
    user_agent: str,
    via_ytdl_hook: bool = False,
    preferred_resolution: str = "best",
    title: str = "",
    force_hls: bool = False,
    subtitles: list[str] | None = None,
) -> tuple[bool, dict]:
    """
    mpv oynatıcısını subprocess.Popen ile ayrı oturumda (start_new_session=True) ve
    argüman listesi (shell=False) kullanarak güvenli biçimde başlatır.
    """
    mpv_bin = find_player_binary("mpv")
    if not mpv_bin:
        return False, {
            "ok": False,
            "error_code": "MPV_NOT_INSTALLED",
            "error": "mpv is not installed or could not be found in PATH (checked /opt/homebrew/bin and /usr/local/bin).",
        }

    cmd = [
        mpv_bin,
        "--force-window=immediate",
        "--no-terminal",
    ]

    # Eğer sistemde yt-dlp varsa mpv'nin yerleşik ytdl_hook betiğine tam yolunu bildir
    ytdlp_bin = find_binary("yt-dlp")
    if ytdlp_bin:
        cmd.append(f"--script-opts=ytdl_hook-ytdl_path={ytdlp_bin}")

    if preferred_resolution == "audio":
        cmd.append("--vid=no")

    if title:
        cmd.append(f"--force-media-title={title}")

    if force_hls and not via_ytdl_hook:
        # FFmpeg 7.1+ uzantısı .m3u8 olmayan ve MIME türü application/octet-stream olan playlist'leri HLS olarak
        # algılamayı reddeder ("Not detecting m3u8/hls with non standard extension..."). Eklenti playlist'i
        # sayfa içinde #EXTM3U ile doğruladıysa demuxer'ı zorla.
        cmd.append("--demuxer-lavf-format=hls")

    if via_ytdl_hook:
        # YouTube SABR 403 kısıtına karşı HLS (m3u8) akışlarına öncelik ver ve
        # kullanıcının seçtiği çözünürlük sınırını uygula.
        fmt = build_ytdl_format_selector(preferred_resolution)
        cmd.append(f"--ytdl-format={fmt}")
    else:
        if referer:
            cmd.append(f"--referrer={referer}")
            # Bazı CDN'ler Origin başlığını da bekleyebildiği için http-header-fields ile desteklenir
            origin_val = origin_from_referer(referer)
            if origin_val:
                cmd.append(f"--http-header-fields=Origin: {origin_val}")

        if user_agent:
            cmd.append(f"--user-agent={user_agent}")

        # Harici altyazılar: mpv uzak dosyayı aynı Referer/User-Agent ile kendisi çeker ve ilkini seçer
        for sub_url in subtitles or []:
            cmd.append(f"--sub-file={sub_url}")

    # URL'nin bayrak (flag) olarak yorumlanmasını önlemek için '--' ayırıcı kullan
    cmd.extend(["--", url])
    return spawn_detached(cmd, "mpv")


def launch_vlc(
    url: str,
    referer: str,
    user_agent: str,
    preferred_resolution: str = "best",
    audio_url: str = "",
    title: str = "",
    subtitles: list[str] | None = None,
) -> tuple[bool, dict]:
    """
    VLC oynatıcısını Referer / User-Agent başlıklarıyla güvenli biçimde başlatır.
    """
    vlc_bin = find_player_binary("vlc")
    if not vlc_bin:
        return False, {
            "ok": False,
            "error_code": "VLC_NOT_INSTALLED",
            "error": "VLC is not installed or could not be found (checked PATH and /Applications/VLC.app).",
        }

    # İlk çalıştırmadaki "Privacy and Network Access Policy" sorusu modal bir penceredir; video penceresinin
    # arkasında kalınca (KDE/Wayland'de gözlendi) VLC tıklamaya yanıt vermez. Soru sorulmadan açılır.
    cmd = [vlc_bin, "--no-qt-privacy-ask"]
    if referer:
        cmd.append(f"--http-referrer={referer}")
    if user_agent:
        cmd.append(f"--http-user-agent={user_agent}")
    if preferred_resolution == "audio":
        cmd.append("--no-video")
    elif preferred_resolution.isdigit() and 144 <= int(preferred_resolution) <= 4320:
        cmd.append(f"--adaptive-maxheight={int(preferred_resolution)}")
    if audio_url:
        cmd.append(f"--input-slave={audio_url}")
    if title:
        cmd.append(f"--meta-title={title}")
    if subtitles:
        # VLC tek --sub-file alır ve uzak altyazının türünü uzantıdan anlar: tercih edilen altyazı indirilip verilir
        local_sub = download_subtitle(subtitles[0], referer, user_agent)
        if local_sub:
            cmd.append(f"--sub-file={local_sub}")

    # URL yalnızca http(s) olarak doğrulandığı için bayrak olarak yorumlanamaz
    cmd.append(url)
    return spawn_detached(cmd, "vlc")


def handle_message(msg: dict) -> dict:
    """
    Gelen JSON mesajını doğrular ve ilgili eylemi çalıştırır.
    """
    action = msg.get("action")
    if action == "ping":
        return {
            "ok": True,
            "status": "pong",
            "host_version": HOST_VERSION,
            "mpv_available": bool(find_player_binary("mpv")),
            "players": {name: bool(find_player_binary(name)) for name in SUPPORTED_PLAYERS},
            "ytdlp_available": bool(find_binary("yt-dlp")),
        }

    if action != "open":
        return {
            "ok": False,
            "error_code": "INVALID_ACTION",
            "error": "Unsupported action. Expected 'open' or 'ping'.",
        }

    player = str(msg.get("player", "mpv") or "mpv").strip().lower()
    if player not in SUPPORTED_PLAYERS:
        return {
            "ok": False,
            "error_code": "INVALID_PLAYER",
            "error": f"Unsupported player. Expected one of: {', '.join(SUPPORTED_PLAYERS)}.",
        }

    raw_url = msg.get("url", "")
    ok_url, target_url = validate_http_url(raw_url)
    if not ok_url:
        return {
            "ok": False,
            "error_code": "INVALID_URL",
            "error": target_url,
        }

    ok_ref, referer = validate_header_field(msg.get("referer", ""), "Referer")
    if not ok_ref:
        return {
            "ok": False,
            "error_code": "INVALID_HEADER",
            "error": referer,
        }

    ok_ua, user_agent = validate_header_field(msg.get("user_agent", ""), "User-Agent")
    if not ok_ua:
        return {
            "ok": False,
            "error_code": "INVALID_HEADER",
            "error": user_agent,
        }

    ok_title, title = validate_header_field(msg.get("title", ""), "Title")
    if not ok_title:
        title = ""
    title = title[:200]

    preferred_res = str(msg.get("preferred_resolution", "best") or "best").strip().lower()
    if CONTROL_CHAR_REGEX.search(preferred_res) or len(preferred_res) > 16:
        preferred_res = "best"

    # kind: "stream" -> yakalanmış gerçek medya akışı (uzantısız /w/<token> gibi HLS'ler dahil), başlıklarla doğrudan aç.
    #       "page"   -> akış yakalanamadı; sayfa URL'si yt-dlp ile çözülmeli (YouTube, Twitch vb.).
    # Eski eklenti sürümleri "kind" göndermez: o durumda use_ytdlp_fallback + uzantı sezgisi kullanılır.
    kind = str(msg.get("kind", "") or "").strip().lower()
    use_ytdlp = bool(msg.get("use_ytdlp_fallback", False))
    stream_format = str(msg.get("stream_format", "") or "").strip().lower()
    path_lower = urlparse(target_url).path.lower()
    force_hls = stream_format == "hls" and not (path_lower.endswith(".m3u8") or path_lower.endswith(".m3u"))
    if kind not in ("stream", "page"):
        kind = "page" if (use_ytdlp and not looks_like_direct_stream(target_url)) else "stream"
    subtitles = parse_subtitles(msg.get("subtitles")) if kind == "stream" else []

    if player == "vlc":
        audio_url = ""
        resolved_via = "direct"
        if kind == "page":
            ok_yt, resolved = resolve_with_ytdlp(target_url, referer, user_agent, preferred_res)
            if not ok_yt:
                return {
                    "ok": False,
                    "error_code": "YTDLP_RESOLVE_FAILED",
                    "error": str(resolved),
                }
            target_url = resolved["url"]
            audio_url = resolved["audio_url"]
            referer = resolved["referer"] or referer
            user_agent = resolved["user_agent"] or user_agent
            resolved_via = "yt-dlp"
        ok_launch, result = launch_vlc(
            target_url,
            referer,
            user_agent,
            preferred_resolution=preferred_res,
            audio_url=audio_url,
            title=title,
            subtitles=subtitles,
        )
        if ok_launch:
            result["resolved_via"] = resolved_via
        return result

    # mpv: sayfa URL'lerinde mpv'nin yerleşik ytdl_hook'u (yt-dlp) ses+video birleştirmesini kendisi yapar.
    resolved_via = "direct"
    if kind == "page":
        if not find_binary("yt-dlp"):
            return {
                "ok": False,
                "error_code": "YTDLP_NOT_INSTALLED",
                "error": "No stream was captured and yt-dlp is not installed, so this page cannot be resolved. Install yt-dlp or play the video first.",
            }
        resolved_via = "mpv-ytdl"

    ok_launch, result = launch_mpv(
        target_url,
        referer,
        user_agent,
        via_ytdl_hook=(resolved_via == "mpv-ytdl"),
        preferred_resolution=preferred_res,
        title=title,
        force_hls=force_hls and kind == "stream",
        subtitles=subtitles,
    )
    if ok_launch:
        result["resolved_via"] = resolved_via
    return result


def main() -> int:
    # 1. Tarayıcı tarafından sağlanan komut satırı origin argümanını doğrula
    origin_ok, origin_info = verify_caller_origin(sys.argv)
    if not origin_ok:
        log_stderr(f"Rejected caller origin: {origin_info}")
        send_response(
            {
                "ok": False,
                "error_code": "FORBIDDEN_ORIGIN",
                "error": origin_info,
            }
        )
        return 1

    # 2. Mesajı oku ve işle
    try:
        message = read_message()
        if message is None:
            return 0
        response = handle_message(message)
        send_response(response)
        return 0 if response.get("ok") else 1
    except Exception as exc:
        log_stderr(f"Message handling error: {type(exc).__name__}: {exc}")
        send_response(
            {
                "ok": False,
                "error_code": "PROTOCOL_ERROR",
                "error": "Invalid native messaging payload.",
            }
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())

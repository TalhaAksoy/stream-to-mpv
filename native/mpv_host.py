#!/usr/bin/env python3
"""
macOS Native Messaging Host (com.talha.mpv)
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
    Apple Silicon (/opt/homebrew/bin) ve Intel (/usr/local/bin) Homebrew dizinlerini PATH'e ekler.
    """
    current_path = os.environ.get("PATH", "")
    path_parts = [p for p in current_path.split(os.pathsep) if p]
    extra_dirs = [
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


def resolve_with_ytdlp(url: str, referer: str, user_agent: str) -> tuple[bool, str]:
    """
    İsteğe bağlı fallback modunda yt-dlp --get-url kullanarak oynatılabilir medya URL'sini çözümler.
    Kesinlikle dosya indirme işlemi başlatmaz.
    """
    ytdlp_bin = find_binary("yt-dlp")
    if not ytdlp_bin:
        return False, "yt-dlp binary not found on system PATH."

    cmd = [
        ytdlp_bin,
        "--no-playlist",
        "--no-warnings",
        "--get-url",
        "-f",
        "best[protocol^=http]/best",
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
            timeout=12,
            shell=False,
            env=env,
        )
        if proc.returncode != 0:
            return False, "yt-dlp could not resolve a playable stream URL."

        lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
        if not lines:
            return False, "yt-dlp returned empty output."

        resolved_url = lines[0]
        ok_url, validated = validate_http_url(resolved_url)
        if not ok_url:
            return False, "yt-dlp returned a non-HTTP URL."

        return True, validated
    except subprocess.TimeoutExpired:
        return False, "yt-dlp resolution timed out."
    except Exception as exc:
        log_stderr(f"yt-dlp error: {type(exc).__name__}")
        return False, "Failed to execute yt-dlp fallback."


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


def launch_mpv(
    url: str,
    referer: str,
    user_agent: str,
    via_ytdl_hook: bool = False,
    preferred_resolution: str = "best",
) -> tuple[bool, dict]:
    """
    mpv oynatıcısını subprocess.Popen ile ayrı oturumda (start_new_session=True) ve
    argüman listesi (shell=False) kullanarak güvenli biçimde başlatır.
    """
    mpv_bin = find_binary("mpv")
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

    if via_ytdl_hook:
        # YouTube SABR 403 kısıtına karşı HLS (m3u8) akışlarına öncelik ver ve
        # kullanıcının seçtiği çözünürlük sınırını uygula.
        fmt = build_ytdl_format_selector(preferred_resolution)
        cmd.append(f"--ytdl-format={fmt}")
    else:
        if referer:
            cmd.append(f"--referrer={referer}")
            # Bazı CDN'ler Origin başlığını da bekleyebildiği için http-header-fields ile desteklenir
            try:
                parsed_ref = urlparse(referer)
                if parsed_ref.scheme in ("http", "https") and parsed_ref.netloc:
                    origin_val = f"{parsed_ref.scheme}://{parsed_ref.netloc}"
                    cmd.append(f"--http-header-fields=Origin: {origin_val}")
            except Exception:
                pass

        if user_agent:
            cmd.append(f"--user-agent={user_agent}")

    # URL'nin bayrak (flag) olarak yorumlanmasını önlemek için '--' ayırıcı kullan
    cmd.extend(["--", url])

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
            "status": "mpv_launch_requested",
            "message": "mpv launch requested",
            "pid": proc.pid,
        }
    except Exception as exc:
        log_stderr(f"Failed to spawn mpv: {type(exc).__name__}")
        return False, {
            "ok": False,
            "error_code": "MPV_SPAWN_ERROR",
            "error": f"Failed to start mpv process: {type(exc).__name__}",
        }


def handle_message(msg: dict) -> dict:
    """
    Gelen JSON mesajını doğrular ve ilgili eylemi çalıştırır.
    """
    action = msg.get("action")
    if action == "ping":
        mpv_bin = find_binary("mpv")
        return {
            "ok": True,
            "status": "pong",
            "mpv_available": bool(mpv_bin),
        }

    if action != "open":
        return {
            "ok": False,
            "error_code": "INVALID_ACTION",
            "error": "Unsupported action. Expected 'open' or 'ping'.",
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

    use_ytdlp = bool(msg.get("use_ytdlp_fallback", False))
    resolved_via = "direct"

    # Doğrudan HLS ve MP4 akışlarında her zaman doğrudan mpv tercih edilir.
    # Doğrudan akış olmayan sayfa URL'lerinde (örn. YouTube, Twitch, Vimeo):
    # - Eğer mpv zaten yt-dlp entegrasyonuyla (ytdl_hook) çalışabiliyorsa,
    #   onay gecikmesi yaşatmamak ve ses+video birleştirmesini mpv'nin yapması için doğrudan mpv'ye ilet.
    # - Aksi halde yt-dlp --get-url ile çözümle.
    if use_ytdlp and not looks_like_direct_stream(target_url):
        if find_binary("yt-dlp"):
            resolved_via = "mpv-ytdl"
        else:
            ok_yt, resolved_or_err = resolve_with_ytdlp(target_url, referer, user_agent)
            if ok_yt:
                target_url = resolved_or_err
                resolved_via = "yt-dlp"

    preferred_res = str(msg.get("preferred_resolution", "best") or "best").strip().lower()
    if CONTROL_CHAR_REGEX.search(preferred_res) or len(preferred_res) > 16:
        preferred_res = "best"

    ok_launch, result = launch_mpv(
        target_url,
        referer,
        user_agent,
        via_ytdl_hook=(resolved_via == "mpv-ytdl"),
        preferred_resolution=preferred_res,
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

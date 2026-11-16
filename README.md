> **🇬🇧 English** | **[🇹🇷 Türkçe okumak için tıklayın (README.tr.md)](./README.tr.md)**

# Stream to mpv

**Install once, click the `▶ mpv` button inside any web video player, pick your resolution, and watch directly in `mpv`.**

**Stream to mpv** is a lightweight, zero-dependency Manifest V3 browser extension and native bridge that automatically detects real media streams (**HLS `.m3u8` Master/Variant**, **`.mp4`**, **`.webm`**, disguised `.txt` HLS manifests, and `yt-dlp` / YouTube streams) and injects an inline **`▶ mpv`** button with a **resolution selector** directly into the video player's bottom-right control bar.

> **Note:** This project is **not** a video downloader. Detected stream URLs and required HTTP headers (`Referer`, `Origin`, `User-Agent`) are handed directly to your local `mpv` player for instant live **streaming**.

---

## Features

- **Inline Player Control Bar Button:** Integrates seamlessly next to the Settings / Subtitles / Fullscreen icons on YouTube, JWPlayer, Video.js, ArtPlayer, Plyr, and DPlayer. Falls back to a clean floating bottom-right control pill on custom players.
- **Resolution Selector Menu:** Choose **4K (2160p), 2K (1440p), 1080p, 720p, 480p, 360p, Auto (Best Quality)**, or **Audio Only** right before launching `mpv`.
- **Iframe & Anime/Movie Embed Support:** Captures disguised HLS playlists (e.g., `/hls/.../master.txt`), rotating signed `.m3u8` tokens, `302`-redirected CDN links, and multi-quality `.mp4` / HLS sources inside cross-origin `<iframe>` embeds (**OK.ru, VK, Mail.ru, Sibnet, Dailymotion**, Alucard, Tau Video, Vidmoly, etc.) across both macOS and Android.
- **YouTube SABR `403`-Safe Playback (macOS & Android):**
  - On **macOS**, prioritizes HLS (`m3u8`) formats via `mpv` + `yt-dlp` for smooth 1080p60/4K playback without closing.
  - On **Android**, extracts YouTube's direct HLS Master `.m3u8` stream in-browser so `mpv-android` plays video + audio directly without requiring `yt-dlp`.
- **Disguised & Extensionless HLS Detection:** Finds playlists that hide behind URLs without an extension and a generic MIME type (e.g. `/w/<token>` served as `application/octet-stream` with segments disguised as `.jpeg`) by verifying the `#EXTM3U` signature *inside the player's own frame* (same Referer/origin as the player). It also reads the real source directly from **JWPlayer** player objects (tested), with best-effort readers for Video.js, ArtPlayer, DPlayer, Clappr and Plyr, so encrypted-config wrapper embeds work too.
- **Choose Your Player:** Desktop: **mpv** or **VLC**. Android: **mpv**, **VLC**, **MX Player**, **Just Player**, or **"Ask every time"** (Android app chooser). The on-video menu always offers **Open in VLC** and **Open with…** as alternatives on Android.
- **Zero-Configuration Setup:** No manual Extension ID copying or JSON editing — running `make` installs and verifies everything automatically.

---

## Requirements

### 1. Desktop (macOS — Apple Silicon & Intel)

| Component | Status | Notes |
| :--- | :--- | :--- |
| **macOS** | Required | macOS 12+ (Apple Silicon M1/M2/M3/M4 or Intel) |
| **Browser** | Required | Google Chrome, Chromium, Brave, Microsoft Edge, Vivaldi, Arc, or Opera |
| **Python 3** | Required | Pre-installed on macOS (`/usr/bin/python3` 3.9+ fully supported) |
| **Homebrew** | Recommended | Used by `make` to auto-install `mpv` and `yt-dlp` (`https://brew.sh`) |
| **mpv** | Required | Auto-installed via `make` if missing (`brew install mpv`) |
| **yt-dlp** | Recommended | For YouTube/Twitch/MSE sites (`make` auto-installs `brew install yt-dlp`) |
| **VLC** *(Optional)* | Optional | Pick **VLC** instead of mpv in the extension popup (`brew install --cask vlc`) |
| **deno** *(Optional)* | Recommended | Speeds up `yt-dlp` YouTube JS challenge solving (`brew install deno`) |

### 2. Desktop (Linux)

| Component | Status | Notes |
| :--- | :--- | :--- |
| **Browser** | Required | Chromium, Google Chrome, Brave, Microsoft Edge, Vivaldi, Thorium, Firefox, or LibreWolf |
| **Python 3** | Required | `python3` from your distribution |
| **mpv** | Required | Install with your package manager (`sudo pacman -S mpv`, `sudo apt install mpv`, …) |
| **yt-dlp** | Recommended | For YouTube/Twitch/MSE sites (`sudo pacman -S yt-dlp` or `pipx install yt-dlp`). Also required when VLC opens YouTube-like page URLs |
| **VLC** *(Optional)* | Optional | Pick **VLC** instead of mpv in the extension popup (`sudo pacman -S vlc`, `sudo apt install vlc`) |

### 3. Android (Phone / Tablet — Android 8.0+)

| Component | Status | Notes |
| :--- | :--- | :--- |
| **mpv-android** and/or **VLC** | Required (one of them) | `is.xyz.mpv` or `org.videolan.vlc`. **VLC is recommended for sites that serve HLS without a `.m3u8` extension** (see Known Limitations) |
| **Extension-Capable Browser** | Required *(for on-video button)* | **Bare Browser**, **Lemur Browser**, **Mises Browser** (Chromium MV3), or **Firefox for Android** |

> **Important Note on Chrome for Android:** Standard Google **Chrome for Android** does not support desktop extensions (`content_scripts` / `webRequest`). Use an extension-capable browser listed above for the one-tap on-video **`▶ mpv`** button. *(An optional Kotlin Share-Intent companion app is also included under `android/` for sharing direct `.m3u8`/`.mp4` URLs from standard browsers).*

---

## Installation Guide

### A. macOS Setup (Ready in 2 Steps)

#### Step 1: Install the Native Bridge & Dependencies

Clone the repository and run **`make`**:

```bash
git clone https://github.com/TalhaAksoy/stream-to-mpv.git
cd stream-to-mpv
make
```

> **No-Terminal Alternative:** You can also double-click **`Install Stream to mpv.command`** or **`dist/StreamToMpv-Installer.pkg`** in Finder.

Running `make` automatically:
1. Installs `mpv` and `yt-dlp` via Homebrew if not already installed.
2. Installs the native host script to `~/mpv_host/mpv_host.py`.
3. Registers Native Messaging manifests across Chrome, Chromium, Brave, Edge, Vivaldi, Arc, Opera, and Firefox (without asking for an Extension ID) and verifies the handshake.

> **Updating:** Store updates only update the extension. Fixes in the native host (for example the VLC + YouTube fixes) arrive when you pull the latest code and run `make` again (`make host` reinstalls only the host).

#### Step 2: Load the Browser Extension

1. Open your browser (e.g., Google Chrome) and navigate to **`chrome://extensions`**.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked** in the top-left corner.
4. Select the **`extension`** folder inside this repository.

**Done!** Open any video page, click **`▶ mpv`** on the bottom-right player controls, and select your desired resolution.

---

### B. Linux Setup

1. Install `mpv` (and optionally `yt-dlp`) with your package manager — `make` does **not** run `sudo` for you; it only warns if they are missing.
2. Run `make` inside the cloned repository. It installs the host to `~/mpv_host/mpv_host.py` and registers Native Messaging manifests under `~/.config/<browser>/NativeMessagingHosts` (respecting `$XDG_CONFIG_HOME`), `~/.mozilla/native-messaging-hosts`, and `~/.librewolf/native-messaging-hosts`.
3. Load the **`extension`** folder via **Load unpacked** in `chrome://extensions` (same as Step 2 above).

> **Note:** Flatpak/Snap browsers are sandboxed and cannot launch host programs from your home directory; use a natively packaged browser.

---

### C. Android Setup (Bare Browser / Lemur / Mises)

1. Install **[mpv-android](https://play.google.com/store/apps/details?id=is.xyz.mpv)** (`is.xyz.mpv`) on your phone.
2. Install an extension-capable Android browser (Recommended: **Bare Browser**, **Lemur Browser**, or **Mises Browser**).
3. Send the pre-built **`dist/stream-to-mpv-extension.zip`** archive to your phone *(or rebuild it anytime with `make zip`)*.
4. Open **`chrome://extensions`** in your mobile browser, turn on **Developer mode**, and load `stream-to-mpv-extension.zip`. In **Bare Browser** use **More → Load unpacked** and pick the unzipped folder (Android does not allow picking the `Download` folder itself, so put it in its own folder). When updating, **Remove** the extension and load it again: Bare's reload button does not refresh the page scripts.
5. **Required Setting for Bare Browser:** Bare Browser blocks external app handoffs by default (`Open links in apps = Never`). Go to **Bare Browser → Settings → Privacy & security → Open links in apps** and select **`Always`** (or **`Ask every time`**) for one-tap launching into `mpv-android`. *(If you are in Incognito mode or prefer keeping that setting off, tap **`Share Stream to App…`** inside the `mpv` menu and pick **Open with mpv** from the Android share sheet).*
6. **Optional Tip for VK & OK.ru on Android:** **YouTube, Mail.ru, Sibnet, Dailymotion, and Tau** streams play out-of-the-box in `mpv-android`. For **VK** and **OK.ru** embeds (whose `vkuser.net` CDN verifies a Chrome `User-Agent` signature via `srcAg`), open **`mpv-android → Settings → Advanced → Edit mpv.conf`** once and add:
   ```ini
   user-agent="Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
   ```
7. **Optional: anime sites whose servers require a Referer (e.g. anikoto):** Android players cannot receive the `Referer` header from the browser, so these servers answer them with `403`. If the **▶ mpv** menu shows the Referer warning, add this rule once in **`mpv-android → Settings → Advanced → Edit mpv.conf`**. It adds the Referer only to streams whose address has the `/<32 hex>/<32 hex>/` layout that these servers use:
   ```ini
   [megaplay-referer]
   profile-cond=(path or ""):find("/"..("%x"):rep(32).."/"..("%x"):rep(32).."/")~=nil
   profile-restore=copy
   referrer=https://megaplay.buzz/
   ```
   **VLC alternative:** **VLC → Settings → Advanced → Custom libVLC options:** `--http-referrer=https://megaplay.buzz/`. VLC cannot limit this to one site, so every stream you open in VLC then carries that Referer. Subtitles of these sites cannot be passed to Android players: VLC treats a subtitle address given by the browser as a local file path, and mpv-android has no such option.

---

## Usage Tips

- **Selecting Resolution:** Click **`▶ mpv`** on the bottom-right control bar -> pick **`1080p`**, **`720p`**, **`Auto (Best Quality)`**, or **`Audio Only`**. The browser video pauses automatically while `mpv` opens.
- **Anime & Embed Sites:** Many embed players show a static poster/ad overlay before requesting the real `.m3u8` / `.mp4` manifest. Press Play once on the video so the stream loads, then click **`▶ mpv`**.
- **Choosing mpv or VLC:** Open the toolbar popup and pick **Player** (desktop) or **Android player**. On desktop Firefox, press **Allow desktop player** once to grant the native-messaging permission.
- **Toolbar Popup:** Click the extension icon in the browser toolbar to check connection status (`mpv Ready` / `Android Ready`) or toggle `Auto-open videos` (off by default). Under `Ignored stream domains` you can list hosts whose streams should never be captured (common ad servers are always ignored).

---

## Known Limitations & Security

1. **DRM-Protected Streams (Netflix, Disney+, Spotify, etc.):** Widevine / FairPlay encrypted streams cannot be played in external players; the extension detects them and displays an `Unsupported stream (DRM)` notice.
2. **Android Intent HTTP Header Limitation:** Official `mpv-android` (`is.xyz.mpv`) does not yet parse custom `Referer` or `User-Agent` headers from Android `ACTION_VIEW` Intents (`TODO` in upstream `MPVActivity.kt`). **YouTube, Mail.ru, Sibnet, Dailymotion, Tau, and Google Drive** play directly on Android out-of-the-box, and **VK / OK.ru** work once a browser `user-agent` is set in `mpv.conf` (see Step 6 above). Strict `Referer`-locked embed CDNs (e.g., Alucard / Vidmoly) may still return `403` on Android (all of them work seamlessly on macOS where full headers are passed).
3. **mpv-android and extensionless HLS:** FFmpeg 7.1+ (used by current mpv-android builds) refuses to detect HLS when the URL has no `.m3u8` extension *and* the server sends a generic MIME type (`Not detecting m3u8/hls with non standard extension and non standard mime type`). On desktop the native host fixes this with `--demuxer-lavf-format=hls`, but Android intents cannot pass mpv options — so for such streams the menu shows **Open in VLC (recommended)**; VLC detects HLS by content. **Just Player** (ExoPlayer) has the same limitation: the browser can only hand it `type=video/*`, so it treats the playlist as a plain file (`UnrecognizedInputFormatException`); the menu recommends VLC whenever the selected Android player is not VLC, and **Open with…** uses the HLS MIME type for such streams so Android only lists apps that can actually play them. **MX Player** (tested with 3.4.3) detects HLS by content and plays these streams, so no VLC hint is shown when MX is selected. On first launch MX asks for file access before it plays anything, network streams included.
4. **Google Drive embeds:** Drive's own `videoplayback` URLs are tied to a session cookie (`403` in an external player) and are split audio/video MSE tracks. For a public Drive file the extension opens the file's cookieless original instead (`drive.usercontent.google.com/download?id=…&confirm=t`, full original quality, seekable). Tested: desktop Firefox → native host → mpv from the button inside the Drive player; on Firefox Android the extension resolved the same URL (popup → Share → Just Player), and VLC, Just Player and mpv-android each played that URL. Private files, or files that hit Drive's download quota, return an HTML page at that URL instead of video.
5. **YouTube on Android:** YouTube's HLS stream lists 17 qualities plus separate audio and subtitle playlists. mpv-android (FFmpeg) downloads all of them before it starts, which can take 10–50 seconds; MX Player starts in a few seconds. The menu therefore also offers **360p · FAST**, a single MP4 file that starts at once in every player. VLC cannot open YouTube's HLS at all, so with VLC selected the MP4 is used. YouTube sometimes answers with a "confirm you're not a bot" check; then no external player can get the video.
6. **YouTube in VLC (desktop):** VLC 3 cannot play YouTube's separate HLS video and audio playlists together (black screen or a frozen first frame), so for VLC the native host asks yt-dlp for plain HTTPS (DASH) video and audio files instead, preferring H.264 up to 1080p; picking 1440p or 2160p allows VP9/AV1, which VLC may decode in software. YouTube makes some of these addresses usable only a few seconds after they are issued (earlier requests get `403`, shown by VLC as "unable to open the MRL"), so VLC can take 5–10 seconds to open. VLC 3 also ignores a global `--http-user-agent`; the host passes it as an input option. mpv is unaffected.
7. **Subtitles (desktop):** External subtitle files that the site's player loads (WebVTT, SRT, ASS) are passed to the player, preferring your browser language, then English (newest first within a language; a previous episode's subtitles are dropped when the episode changes). mpv loads them directly with the same Referer; for VLC the preferred one is downloaded first. Android players cannot receive them.
8. **Servers that hide video in images / require a Referer:** Some anime servers store video segments inside image files on image CDNs; external players cannot play these, and the menu says so (pick another server on the site). Servers that only answer requests carrying their own player's Referer work on desktop; on Android they need the one-time mpv.conf / VLC rule from Android setup step 7, and the menu shows a warning.
9. **Encrypted subtitles:** Some sites (e.g. openani.me) serve subtitles in an encrypted container behind a signed per-session token and decode them in the page. The extension does not break that protection, so the video opens in the player without those subtitles.
10. **Service-worker / encrypted MSE players** (e.g. Abyss) never expose a playable URL to the page and are not supported; pick another source on the site.
11. **Privacy & Hardened Execution:** Browser cookies and `Authorization` headers are never exfiltrated. `mpv_host.py` launches only allow-listed players (`mpv`, `vlc`), accepts only `http://` and `https://` URLs, spawns processes with `shell=False` and a `--` argument separator, rejects CRLF header injection, and validates caller `allowed_origins`.

---

## Developer Commands & Automated Tests

Built with pure vanilla JavaScript (Manifest V3) and Python 3 — zero npm frameworks or bundlers required:

```bash
# Install dependencies, native host, browser manifests, and mobile zip
make

# Run all unit, service-worker concurrency, security, and real mpv/ffmpeg E2E tests
make test

# Rebuild mobile extension zip (dist/stream-to-mpv-extension.zip)
make zip

# Rebuild macOS installer package (dist/StreamToMpv-Installer.pkg)
make pkg

# Build Chrome Web Store & Firefox AMO upload packages (dist/store/*.zip) and lint the Firefox one
make store
```

---

## Project Structure

```text
.
├── Makefile                        # One-command installer, verifier, test runner & packager
├── Install Stream to mpv.command   # Double-clickable macOS Finder installer
├── README.md                       # English documentation
├── README.tr.md                    # Turkish documentation (Türkçe rehber)
├── PRIVACY.md                      # Privacy policy (used for store listings)
├── LICENSE                         # MIT License
├── tools/build_store_zips.sh       # Chrome Web Store & Firefox AMO package builder
├── dist/
│   ├── StreamToMpv-Installer.pkg   # Distributable macOS installer package
│   └── stream-to-mpv-extension.zip # Ready-to-load mobile extension archive
├── extension/                      # Manifest V3 browser extension (vanilla JS)
│   ├── manifest.json               # Permissions & deterministic public key
│   ├── content.js                  # Inline control-bar button, resolution menu & Android YT HLS extractor
│   ├── background.js               # webRequest capture, frame matching & Native Messaging / Intent bridge
│   ├── stream_utils.js             # HLS Master (#EXT-X-STREAM-INF) parser & stream prioritization
│   ├── page_probe.js               # MAIN-world reader for JWPlayer / Video.js / ArtPlayer sources (on click only)
│   ├── popup.html                  # Compact status & settings popup
│   └── popup.js                    # Popup controller
├── native/                         # macOS & Linux Native Messaging Host
│   ├── mpv_host.py                 # Hardened Python 3 mpv / VLC & yt-dlp launcher (com.talha.mpv)
│   ├── install.sh                  # Zero-config multi-browser manifest installer
│   ├── build_macos_pkg.sh          # macOS .pkg builder
│   └── com.talha.mpv.json.example  # Example Native Messaging host manifest
├── android/                        # Optional Kotlin Share-Intent companion app for standard Android browsers
└── tests/                          # Unit, lifecycle, security & real mpv + strict-Referer HLS E2E tests
```

---

## License

[MIT](./LICENSE) · [Privacy Policy](./PRIVACY.md)

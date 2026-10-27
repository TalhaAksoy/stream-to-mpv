> **🇬🇧 English** | **[🇹🇷 Türkçe okumak için tıklayın (README.tr.md)](./README.tr.md)**

# Stream to mpv

**Install once, click the `▶ mpv` button inside any web video player, pick your resolution, and watch directly in `mpv`.**

**Stream to mpv** is a lightweight, zero-dependency Manifest V3 browser extension and native bridge that automatically detects real media streams (**HLS `.m3u8` Master/Variant**, **`.mp4`**, **`.webm`**, disguised `.txt` HLS manifests, and `yt-dlp` / YouTube streams) and injects an inline **`▶ mpv`** button with a **resolution selector** directly into the video player's bottom-right control bar.

> **Note:** This project is **not** a video downloader. Detected stream URLs and required HTTP headers (`Referer`, `Origin`, `User-Agent`) are handed directly to your local `mpv` player for instant live **streaming**.

---

## Features

- **Inline Player Control Bar Button:** Integrates seamlessly next to the Settings / Subtitles / Fullscreen icons on YouTube, JWPlayer, Video.js, ArtPlayer, Plyr, and DPlayer. Falls back to a clean floating bottom-right control pill on custom players.
- **Resolution Selector Menu:** Choose **4K (2160p), 2K (1440p), 1080p, 720p, 480p, 360p, Auto (Best Quality)**, or **Audio Only** right before launching `mpv`.
- **Iframe & Anime/Movie Embed Support:** Captures disguised HLS playlists (e.g., `/hls/.../master.txt`), rotating signed `.m3u8` tokens, and multi-quality `.mp4` sources inside cross-origin `<iframe>` embeds (Alucard, Tau Video, Vidmoly, Sibnet, etc.) and forwards `Referer` + `Origin` + `User-Agent` to `mpv` on macOS to prevent `403 Forbidden` errors.
- **YouTube SABR `403`-Safe Playback (macOS & Android):**
  - On **macOS**, prioritizes HLS (`m3u8`) formats via `mpv` + `yt-dlp` for smooth 1080p60/4K playback without closing.
  - On **Android**, extracts YouTube's direct HLS Master `.m3u8` stream in-browser so `mpv-android` plays video + audio directly without requiring `yt-dlp`.
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
| **deno** *(Optional)* | Recommended | Speeds up `yt-dlp` YouTube JS challenge solving (`brew install deno`) |

### 2. Android (Phone / Tablet — Android 8.0+)

| Component | Status | Notes |
| :--- | :--- | :--- |
| **mpv-android** | Required | Package ID: `is.xyz.mpv` (Install from Google Play Store, F-Droid, or GitHub Releases) |
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

#### Step 2: Load the Browser Extension

1. Open your browser (e.g., Google Chrome) and navigate to **`chrome://extensions`**.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked** in the top-left corner.
4. Select the **`extension`** folder inside this repository.

**Done!** Open any video page, click **`▶ mpv`** on the bottom-right player controls, and select your desired resolution.

---

### B. Android Setup (Bare Browser / Lemur / Mises)

1. Install **[mpv-android](https://play.google.com/store/apps/details?id=is.xyz.mpv)** (`is.xyz.mpv`) on your phone.
2. Install an extension-capable Android browser (Recommended: **Bare Browser**, **Lemur Browser**, or **Mises Browser**).
3. Send the pre-built **`dist/stream-to-mpv-extension.zip`** archive to your phone *(or rebuild it anytime with `make zip`)*.
4. Open **`chrome://extensions`** in your mobile browser, turn on **Developer mode**, and load `stream-to-mpv-extension.zip`.
5. **Required Setting for Bare Browser:** Bare Browser blocks external app handoffs by default (`Open links in apps = Never`). Go to **Bare Browser → Settings → Open links in apps** and select **`Always`** (or **`Ask`**) for one-tap launching into `mpv-android`. *(If you are in Incognito mode or prefer keeping that setting off, tap **`Share Stream to App…`** inside the `mpv` menu and pick **Open with mpv** from the Android share sheet).*

---

## Usage Tips

- **Selecting Resolution:** Click **`▶ mpv`** on the bottom-right control bar -> pick **`1080p`**, **`720p`**, **`Auto (Best Quality)`**, or **`Audio Only`**. The browser video pauses automatically while `mpv` opens.
- **Anime & Embed Sites:** Many embed players show a static poster/ad overlay before requesting the real `.m3u8` / `.mp4` manifest. Press Play once on the video so the stream loads, then click **`▶ mpv`**.
- **Toolbar Popup:** Click the extension icon in the browser toolbar to check connection status (`mpv Ready` / `Android Ready`) or toggle `Auto-open videos` (off by default).

---

## Known Limitations & Security

1. **DRM-Protected Streams (Netflix, Disney+, Spotify, etc.):** Widevine / FairPlay encrypted streams cannot be played in external players; the extension detects them and displays an `Unsupported stream (DRM)` notice.
2. **Android Intent HTTP Header Limitation:** Official `mpv-android` (`is.xyz.mpv`) does not yet parse custom `Referer` or `User-Agent` headers from Android `ACTION_VIEW` Intents (`TODO` in upstream `MPVActivity.kt`). YouTube and standard `.m3u8` / `.mp4` servers (e.g., Sibnet, Tau, OK.ru, GDrive) play directly on Android, whereas strict `Referer`-locked embed CDNs (e.g., Alucard / Vidmoly) may return `403` on Android (all of them work seamlessly on macOS where full headers are passed).
3. **Privacy & Hardened Execution:** Browser cookies and `Authorization` headers are never exfiltrated. `mpv_host.py` accepts only `http://` and `https://` URLs, spawns processes with `shell=False` and `--no-config` safety checks, rejects CRLF header injection, and validates caller `allowed_origins`.

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
```

---

## Project Structure

```text
.
├── Makefile                        # One-command installer, verifier, test runner & packager
├── Install Stream to mpv.command   # Double-clickable macOS Finder installer
├── README.md                       # English documentation
├── README.tr.md                    # Turkish documentation (Türkçe rehber)
├── dist/
│   ├── StreamToMpv-Installer.pkg   # Distributable macOS installer package
│   └── stream-to-mpv-extension.zip # Ready-to-load mobile extension archive
├── extension/                      # Manifest V3 browser extension (vanilla JS)
│   ├── manifest.json               # Permissions & deterministic public key
│   ├── content.js                  # Inline control-bar button, resolution menu & Android YT HLS extractor
│   ├── background.js               # webRequest capture, frame matching & Native Messaging / Intent bridge
│   ├── stream_utils.js             # HLS Master (#EXT-X-STREAM-INF) parser & stream prioritization
│   ├── popup.html                  # Compact status & settings popup
│   └── popup.js                    # Popup controller
├── native/                         # macOS Native Messaging Host
│   ├── mpv_host.py                 # Hardened Python 3 mpv & yt-dlp launcher (com.talha.mpv)
│   ├── install.sh                  # Zero-config multi-browser manifest installer
│   ├── build_macos_pkg.sh          # macOS .pkg builder
│   └── com.talha.mpv.json.example  # Example Native Messaging host manifest
├── android/                        # Optional Kotlin Share-Intent companion app for standard Android browsers
└── tests/                          # Unit, lifecycle, security & real mpv + strict-Referer HLS E2E tests
```

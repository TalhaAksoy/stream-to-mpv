# Privacy Policy — Stream to mpv

_Last updated: 2026-11-15_

**Stream to mpv does not collect, store remotely, sell, or share any personal data.** It has no analytics, no telemetry, no advertising, and no server of its own.

## What the extension processes, and where it stays

| Data | Why | Where it goes |
| :--- | :--- | :--- |
| URLs of media requests on the page you are viewing (e.g. `.m3u8`, `.mp4`) | To detect playable video streams | Kept in the browser's temporary session storage (`storage.session`) and cleared when the tab is closed or the browser exits |
| `Referer` and `User-Agent` headers of those requests | Some video servers refuse playback without them | Same as above; passed to mpv only when you click **▶ mpv** |
| URLs of small playlist-like responses with an unknown file type | To recognise playlists that hide their `.m3u8` extension, when you press **▶ mpv** | Same as above (session storage, cleared with the tab) |
| URLs of subtitle files the page's player loads (`.vtt`, `.srt`, `.ass`) | To show the same subtitles in the desktop player | Same as above (session storage, cleared with the tab); passed to the local player when you click **▶ mpv** |
| Your settings (auto-open, yt-dlp fallback, chosen player) | To remember your preferences | Browser local storage (`storage.local`) on your device |

When you click **▶ mpv**, the selected stream is handed **only to software on your own device**:

- **Desktop:** the stream URL, those two headers, the page title and any captured subtitle URLs go to the local native messaging host (`mpv_host.py`), which starts the player you chose (`mpv` or `VLC`) on your computer. For VLC, the host downloads the preferred subtitle file once into a private temporary folder on your computer (removed after a day).
- **Android:** the stream URL and the page title go to the player app you chose (mpv-android, VLC, MX Player, Just Player or the Android app chooser) through an Android intent.

Cookies and `Authorization` headers are never stored or forwarded.

## Network requests made by the extension

The extension only contacts the website you are already watching, to find the real video address:

- the video server, to check whether a playlist is a multi-quality HLS master playlist (first 4 KB only);
- when you press **▶ mpv** and no stream was recognised yet: the same playlist addresses the page's own player already loaded, re-requested from inside that page (playlist text only, never video data), and the player configuration already present in the page (read locally, nothing is sent anywhere);
- YouTube, Mail.ru and Sibnet player endpoints on those same sites, when you use the button there;
- when you press **▶ mpv**: the stream's playlist, requested once with and once without the `Referer` header, to warn you when a server hides video inside images or will refuse an Android player.

No data is sent to the developer or any third party.

## Permissions

- **`webRequest` + access to all sites:** to notice video stream requests on any site with a video player.
- **`tabs`:** to associate detected streams with the right tab and show the stream count badge.
- **`storage`:** to keep detected streams for the current session and your settings.
- **`nativeMessaging`:** to hand the stream to the local mpv player on desktop.

## Contact

Questions or concerns: open an issue at <https://github.com/TalhaAksoy/stream-to-mpv/issues>.

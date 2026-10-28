# Privacy Policy — Stream to mpv

_Last updated: 2026-10-28_

**Stream to mpv does not collect, store remotely, sell, or share any personal data.** It has no analytics, no telemetry, no advertising, and no server of its own.

## What the extension processes, and where it stays

| Data | Why | Where it goes |
| :--- | :--- | :--- |
| URLs of media requests on the page you are viewing (e.g. `.m3u8`, `.mp4`) | To detect playable video streams | Kept in the browser's temporary session storage (`storage.session`) and cleared when the tab is closed or the browser exits |
| `Referer` and `User-Agent` headers of those requests | Some video servers refuse playback without them | Same as above; passed to mpv only when you click **▶ mpv** |
| Your settings (auto-open, yt-dlp fallback) | To remember your preferences | Browser local storage (`storage.local`) on your device |

When you click **▶ mpv**, the selected stream is handed **only to software on your own device**:

- **Desktop:** the stream URL and those two headers go to the local native messaging host (`mpv_host.py`), which starts the `mpv` player on your computer.
- **Android:** the stream URL and the page title go to the `mpv-android` app through an Android intent.

Cookies and `Authorization` headers are never stored or forwarded.

## Network requests made by the extension

The extension only contacts the website you are already watching, to find the real video address:

- the video server, to check whether a playlist is a multi-quality HLS master playlist (first 4 KB only);
- YouTube, Mail.ru and Sibnet player endpoints on those same sites, when you use the button there.

No data is sent to the developer or any third party.

## Permissions

- **`webRequest` + access to all sites:** to notice video stream requests on any site with a video player.
- **`tabs`:** to associate detected streams with the right tab and show the stream count badge.
- **`storage`:** to keep detected streams for the current session and your settings.
- **`nativeMessaging`:** to hand the stream to the local mpv player on desktop.

## Contact

Questions or concerns: open an issue at <https://github.com/TalhaAksoy/stream-to-mpv/issues>.

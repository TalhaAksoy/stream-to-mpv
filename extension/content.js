/**
 * Content Script — Video Oynatıcı Kontrollerinin Yanında Çözünürlük Seçimli "mpv" Butonu
 *
 * Özellikler:
 * - YouTube (`.ytp-right-controls`) ve benzeri oynatıcılarda sağ üst köşe yerine doğrudan
 *   sağ alttaki oynatıcı kontrol butonlarının (Altyazı / Ayarlar / Tam ekran) yanına yerleşir.
 * - Özel kontrol çubuğu olmayan diğer sitelerde video oynatıcısının sağ alt kontrol hizasında
 *   kompakt bir kontrol butonu olarak konumlanır.
 * - Butona basıldığında mevcut çözünürlükleri (4K / 1440p / 1080p / 720p / 480p / 360p / Audio Only / Best)
 *   içeren şık bir menü açılır; seçilen çözünürlükle doğrudan mpv başlatılır.
 * - Sitenin CSS kurallarından etkilenmemek için Shadow DOM (shared CSSStyleSheet + template cloning) kullanır.
 */

(() => {
  if (globalThis.__streamToMpvContentLoaded) return;
  globalThis.__streamToMpvContentLoaded = true;

  const MIN_VIDEO_WIDTH = 180;
  const MIN_VIDEO_HEIGHT = 100;

  const AD_CONTAINER_SELECTOR = [
    ".ad-showing",
    ".ad-interrupting",
    "[id^='google_ads_']",
    ".ima-ad-container",
    ".video-ads",
    ".vjs-ad-playing",
    "[data-ad-element]"
  ].join(",");

  const videoRegistry = new WeakMap();
  const trackedVideos = new Set();

  // Modern Web Guidance (`shadow-dom`): paylaşılan tekil CSSStyleSheet
  const sharedSheet =
    typeof CSSStyleSheet !== "undefined" && "replaceSync" in CSSStyleSheet.prototype
      ? new CSSStyleSheet()
      : null;

  const WIDGET_CSS = `
    :host {
      all: initial;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      position: relative;
      height: 100%;
      flex-shrink: 0;
      vertical-align: top;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      z-index: 2147483646;
    }

    :host([data-mode="floating"]) {
      position: fixed;
      top: 0;
      left: 0;
      width: 0;
      height: 0;
      pointer-events: none;
    }

    .mpv-root {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 100%;
    }

    :host([data-mode="floating"]) .mpv-root {
      position: fixed;
      height: 36px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.18s ease;
    }

    :host([data-mode="floating"]) .mpv-root.visible {
      opacity: 0.85;
    }

    :host([data-mode="floating"]) .mpv-root.visible:hover,
    :host([data-mode="floating"]) .mpv-root.menu-open {
      opacity: 1;
    }

    /* YouTube ve modern oynatıcı kontrol butonlarıyla birebir uyumlu ikon+rozet buton */
    .mpv-trigger {
      pointer-events: auto;
      appearance: none;
      background: transparent;
      border: none;
      color: #ffffff;
      cursor: pointer;
      height: 100%;
      min-height: 36px;
      padding: 0 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      opacity: 0.9;
      transition: opacity 0.15s ease, transform 0.12s ease, background 0.15s ease;
      border-radius: 8px;
      user-select: none;
      -webkit-user-select: none;
    }

    :host([data-mode="floating"]) .mpv-trigger {
      background: rgba(15, 17, 23, 0.82);
      border: 1px solid rgba(255, 255, 255, 0.2);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-radius: 999px;
      padding: 0 12px;
      height: 34px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
    }

    .mpv-trigger:hover:not(:disabled) {
      opacity: 1;
      background: rgba(255, 255, 255, 0.12);
    }

    :host([data-mode="floating"]) .mpv-trigger:hover:not(:disabled) {
      background: rgba(142, 68, 173, 0.92);
      border-color: rgba(255, 255, 255, 0.45);
    }

    .mpv-trigger:active:not(:disabled) {
      transform: scale(0.95);
    }

    .mpv-trigger:disabled {
      opacity: 0.6;
      cursor: default;
    }

    .mpv-icon {
      width: 20px;
      height: 20px;
      fill: currentColor;
      flex-shrink: 0;
      filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.5));
    }

    .mpv-badge {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.2px;
      padding: 2px 5px;
      border-radius: 4px;
      background: rgba(155, 89, 182, 0.92);
      color: #ffffff;
      line-height: 1;
      text-shadow: none;
    }

    @media (max-width: 480px) {
      :host([data-mode="inline"]) .mpv-trigger {
        min-height: 28px;
        padding: 0 5px;
        gap: 3px;
      }

      :host([data-mode="inline"]) .mpv-icon {
        width: 17px;
        height: 17px;
      }

      :host([data-mode="inline"]) .mpv-badge {
        font-size: 9.5px;
        padding: 2px 4px;
      }
    }

    /* Çözünürlük Seçim Menüsü (Top Layer Popover + 2D ekran sınırı korumalı) */
    .mpv-menu {
      pointer-events: auto;
      visibility: visible;
      opacity: 1;
      box-sizing: border-box;
      position: fixed;
      inset: auto;
      margin: 0;
      top: 8px;
      left: 8px;
      width: fit-content;
      min-width: min(188px, calc(100vw - 16px));
      max-width: min(268px, calc(100vw - 16px));
      max-height: min(65vh, 300px);
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      background: rgba(20, 22, 29, 0.96);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 12px;
      padding: 6px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.6);
      color: #f0f3f8;
      display: none;
      flex-direction: column;
      gap: 2px;
      z-index: 2147483647;
    }

    .mpv-menu:where(:popover-open, .open) {
      display: flex;
    }

    .mpv-menu-header {
      font-size: 11px;
      font-weight: 700;
      color: #9ba3b5;
      padding: 5px 10px 4px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      margin-bottom: 2px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .mpv-menu-items {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .mpv-menu-note {
      padding: 6px 12px 2px;
      font-size: 11.5px;
      line-height: 1.35;
      color: #f5b041;
      white-space: normal;
    }

    .mpv-menu-divider {
      height: 1px;
      background: rgba(255, 255, 255, 0.08);
      margin: 3px 4px;
    }

    .mpv-item {
      appearance: none;
      box-sizing: border-box;
      border: none;
      background: transparent;
      color: #f0f3f8;
      font-family: inherit;
      font-size: 12.5px;
      font-weight: 500;
      text-decoration: none;
      padding: 8px 10px;
      border-radius: 7px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      text-align: left;
      width: 100%;
      min-width: 0;
      transition: background 0.12s ease;
    }

    .mpv-item:hover {
      background: rgba(155, 89, 182, 0.35);
    }

    .mpv-item-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .mpv-item-tag {
      font-size: 10px;
      font-weight: 700;
      color: #d7bde2;
      background: rgba(142, 68, 173, 0.35);
      padding: 1px 5px;
      border-radius: 4px;
      flex-shrink: 0;
    }

    .mpv-toast {
      pointer-events: none;
      visibility: visible;
      opacity: 1;
      box-sizing: border-box;
      position: fixed;
      inset: auto;
      margin: 0;
      top: 8px;
      left: 8px;
      width: fit-content;
      max-width: min(280px, calc(100vw - 16px));
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      padding: 6px 11px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      color: #ffffff;
      background: rgba(20, 24, 33, 0.95);
      border: 1px solid rgba(255, 255, 255, 0.18);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
      display: none;
      z-index: 2147483647;
    }

    .mpv-toast:where(:popover-open, .show) {
      display: block;
    }

    .mpv-toast.success {
      background: rgba(20, 68, 43, 0.95);
      border-color: rgba(46, 204, 113, 0.55);
      color: #abebc6;
    }

    .mpv-toast.error {
      background: rgba(78, 22, 22, 0.95);
      border-color: rgba(231, 76, 60, 0.6);
      color: #fadbd8;
    }
  `;

  if (sharedSheet) {
    sharedSheet.replaceSync(WIDGET_CSS);
  }

  // Modern Web Guidance (`shadow-dom` & `viewport-aware-dropdowns`): tek seferlik <template> + Top Layer popover
  const widgetTemplate = document.createElement("template");
  widgetTemplate.innerHTML = `
    <div class="mpv-root">
      <button type="button" class="mpv-trigger" aria-label="Open in mpv (Choose resolution)">
        <svg class="mpv-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/>
        </svg>
        <span class="mpv-badge">mpv</span>
      </button>
      <div class="mpv-menu" popover="manual" aria-label="Select mpv resolution">
        <div class="mpv-menu-header">
          <span>Open in mpv</span>
        </div>
        <div class="mpv-menu-items"></div>
      </div>
      <div class="mpv-toast" popover="manual" role="status" aria-live="polite"></div>
    </div>
  `;

  const RESOLUTION_LABELS = {
    2160: { label: "2160p", tag: "4K" },
    1440: { label: "1440p", tag: "2K" },
    1080: { label: "1080p", tag: "HD" },
    720: { label: "720p", tag: "HD" },
    480: { label: "480p", tag: "" },
    360: { label: "360p", tag: "" }
  };

  function isEligiblePlayerVideo(video, rect) {
    if (!video || !video.isConnected) return false;
    if (rect.width < MIN_VIDEO_WIDTH || rect.height < MIN_VIDEO_HEIGHT) return false;

    const style = window.getComputedStyle(video);
    if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) < 0.1) {
      return false;
    }

    try {
      if (video.closest(AD_CONTAINER_SELECTOR)) return false;
    } catch {
      // Yoksay
    }

    if (
      video.loop &&
      video.muted &&
      !video.controls &&
      Number.isFinite(video.duration) &&
      video.duration > 0 &&
      video.duration < 8
    ) {
      return false;
    }

    return true;
  }

  /**
   * Video oynatıcısına ait yerel kontrol çubuğunu (örn. YouTube `.ytp-right-controls`) bulur.
   * Bulunursa buton doğrudan o kontrol ikonlarının yanına yerleştirilir!
   */
  function findInlineControlBar(video) {
    // 1. YouTube masaüstü oynatıcısı (.html5-video-player -> .ytp-right-controls)
    const ytPlayer = video.closest(".html5-video-player");
    if (ytPlayer) {
      const rightControls =
        ytPlayer.querySelector(".ytp-right-controls-left") ||
        ytPlayer.querySelector(".ytp-right-controls");
      if (rightControls) {
        return { container: rightControls, insertFirst: true };
      }
    }

    // 2. Video.js (.vjs-control-bar): sağ taraftaki ayar/altyazı/PiP/tam ekran ikonlarının önüne yerleş
    const vjsBar = video.closest(".video-js")?.querySelector(".vjs-control-bar");
    if (vjsBar) {
      const vjsAnchor =
        vjsBar.querySelector(".vjs-subs-caps-button") ||
        vjsBar.querySelector(".vjs-descriptions-button") ||
        vjsBar.querySelector(".vjs-picture-in-picture-control") ||
        vjsBar.querySelector(".vjs-fullscreen-control");
      return { container: vjsBar, beforeNode: vjsAnchor || null };
    }

    // 3. JWPlayer / FirePlayer (.jw-button-container): spacer'dan sonraki sağ kontrol grubunun önüne yerleş
    const jwRight = video
      .closest(".jwplayer")
      ?.querySelector(".jw-button-container");
    if (jwRight) {
      const jwAnchor =
        jwRight.querySelector(".jw-icon-cc") ||
        jwRight.querySelector(".jw-settings-submenu-button") ||
        jwRight.querySelector(".jw-icon-settings") ||
        jwRight.querySelector(".jw-icon-pip") ||
        jwRight.querySelector(".jw-icon-fullscreen");
      return { container: jwRight, beforeNode: jwAnchor || null };
    }

    // 4. ArtPlayer (.art-controls-right)
    const artRight = video
      .closest(".art-video-player")
      ?.querySelector(".art-controls-right");
    if (artRight) {
      return { container: artRight, insertFirst: true };
    }

    // 5. DPlayer (.dplayer-icons-right)
    const dplayerRight = video
      .closest(".dplayer")
      ?.querySelector(".dplayer-icons-right");
    if (dplayerRight) {
      return { container: dplayerRight, insertFirst: true };
    }

    // 6. Plyr (.plyr__controls): sağdaki altyazı/ayar/PiP/tam ekran butonlarının önüne yerleş
    const plyrControls = video.closest(".plyr")?.querySelector(".plyr__controls");
    if (plyrControls) {
      const plyrAnchor =
        plyrControls.querySelector("[data-plyr='captions']") ||
        plyrControls.querySelector("[data-plyr='settings']") ||
        plyrControls.querySelector("[data-plyr='pip']") ||
        plyrControls.querySelector("[data-plyr='fullscreen']");
      return { container: plyrControls, beforeNode: plyrAnchor || null };
    }

    return null;
  }

  function getFloatingMountRoot(video) {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl && fsEl.tagName !== "VIDEO" && fsEl.contains(video)) {
      return fsEl;
    }
    return document.body || document.documentElement;
  }

  function countEligibleVideosInFrame() {
    let count = 0;
    for (const v of trackedVideos) {
      if (!v.isConnected) continue;
      if (isEligiblePlayerVideo(v, v.getBoundingClientRect())) count++;
    }
    return Math.max(1, count);
  }

  // Android YouTube için doğrudan HLS (.m3u8) çözümleme önbelleği (mpv-android yerel yt-dlp içermez)
  const ytAndroidHlsCache = new Map();
  const YT_CACHE_TTL_MS = 8 * 60 * 1000;

  function extractYouTubeVideoId(rawUrl) {
    try {
      const u = new URL(rawUrl);
      const host = u.hostname.toLowerCase();
      if (host === "youtu.be") {
        const id = u.pathname.split("/").filter(Boolean)[0] || "";
        return /^[\w-]{11}$/.test(id) ? id : null;
      }
      if (
        host === "youtube.com" ||
        host.endsWith(".youtube.com") ||
        host === "youtube-nocookie.com" ||
        host.endsWith(".youtube-nocookie.com")
      ) {
        const vParam = u.searchParams.get("v");
        if (vParam && /^[\w-]{11}$/.test(vParam)) return vParam;

        const parts = u.pathname.split("/").filter(Boolean);
        if (
          parts.length >= 2 &&
          (parts[0] === "shorts" || parts[0] === "live" || parts[0] === "embed" || parts[0] === "v") &&
          /^[\w-]{11}$/.test(parts[1])
        ) {
          return parts[1];
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Android üzerinde YouTube sayfasındayken (aynı origin: m.youtube.com / www.youtube.com)
   * Innertube VISIONOS istemcisiyle doğrudan HLS Master (.m3u8) adresini çıkarır.
   * Bu sayede yt-dlp barındırmayan mpv-android (is.xyz.mpv) videoyu ses+görüntü ile doğrudan oynatır.
   */
  async function extractYouTubeHlsOnAndroid(rawUrl) {
    const videoId = extractYouTubeVideoId(rawUrl);
    if (!videoId) return null;

    const cached = ytAndroidHlsCache.get(videoId);
    if (cached && Date.now() - cached.timestamp < YT_CACHE_TTL_MS) {
      return cached;
    }

    let visitorData = "";
    try {
      const swRes = await fetch("/sw.js_data", { credentials: "omit" });
      if (swRes.ok) {
        const swText = (await swRes.text()).replace(/^\)\]\}'\s*/, "");
        const swJson = JSON.parse(swText);
        visitorData = swJson?.[0]?.[2]?.[0]?.[0]?.[13] || "";
      }
    } catch {
      // Yoksay
    }

    const clientConfigs = [
      {
        headerId: "101",
        headerVer: "1.02",
        client: {
          clientName: "VISIONOS",
          clientVersion: "1.02",
          deviceMake: "Apple",
          deviceModel: "RealityDevice17,1",
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
          osName: "visionOS",
          osVersion: "26.5.23O471",
          hl: "en",
          ...(visitorData ? { visitorData } : {})
        }
      },
      {
        headerId: "5",
        headerVer: "21.26.4",
        client: {
          clientName: "IOS",
          clientVersion: "21.26.4",
          deviceMake: "Apple",
          deviceModel: "iPhone16,2",
          userAgent: "com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
          osName: "iPhone",
          osVersion: "18.3.2.22D82",
          hl: "en",
          ...(visitorData ? { visitorData } : {})
        }
      }
    ];

    for (const cfg of clientConfigs) {
      try {
        const res = await fetch("/youtubei/v1/player?prettyPrint=false", {
          method: "POST",
          credentials: "omit",
          headers: {
            "Content-Type": "application/json",
            "X-YouTube-Client-Name": cfg.headerId,
            "X-YouTube-Client-Version": cfg.headerVer,
            ...(visitorData ? { "X-Goog-Visitor-Id": visitorData } : {})
          },
          body: JSON.stringify({
            videoId,
            context: { client: cfg.client },
            contentCheckOk: true,
            racyCheckOk: true
          })
        });

        if (!res.ok) continue;
        const data = await res.json();
        const hlsUrl = data?.streamingData?.hlsManifestUrl;
        if (hlsUrl && typeof hlsUrl === "string" && hlsUrl.startsWith("https://")) {
          const entry = {
            videoId,
            streamUrl: hlsUrl,
            title: data?.videoDetails?.title || document.title || "",
            timestamp: Date.now()
          };
          ytAndroidHlsCache.set(videoId, entry);
          return entry;
        }
      } catch {
        // Sonraki istemci profilini dene
      }
    }

    return null;
  }

  function isValidStreamHttpUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return false;
    try {
      const u = new URL(rawUrl);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }

  /**
   * Popüler dizi/film/anime embed oynatıcılarını (OK.ru, Mail.ru, VK, Sibnet) alan adına göre tanır.
   */
  function detectEmbedProvider(rawUrl) {
    try {
      const u = new URL(rawUrl);
      const host = u.hostname.toLowerCase();
      const path = u.pathname.toLowerCase();

      if (
        host === "ok.ru" ||
        host.endsWith(".ok.ru") ||
        host === "odnoklassniki.ru" ||
        host.endsWith(".odnoklassniki.ru")
      ) {
        return "okru";
      }

      if (
        host === "my.mail.ru" ||
        host.endsWith(".my.mail.ru") ||
        ((host === "mail.ru" || host.endsWith(".mail.ru")) && path.includes("/video/"))
      ) {
        return "mailru";
      }

      if (
        host === "vk.com" ||
        host.endsWith(".vk.com") ||
        host === "vk.ru" ||
        host.endsWith(".vk.ru") ||
        host === "vkvideo.ru" ||
        host.endsWith(".vkvideo.ru")
      ) {
        return "vk";
      }

      if (host === "sibnet.ru" || host.endsWith(".sibnet.ru")) {
        return "sibnet";
      }

      if ((host === "drive.google.com" || host === "docs.google.com") && extractDriveFileId(rawUrl)) {
        return "gdrive";
      }

      return null;
    } catch {
      return null;
    }
  }

  /** drive.google.com/file/d/<id>/preview|view → dosya kimliği (yoksa ""). */
  function extractDriveFileId(rawUrl) {
    try {
      const m = new URL(rawUrl).pathname.match(/^\/(?:a\/[^/]+\/)?file\/d\/([A-Za-z0-9_-]{20,})(?:\/|$)/);
      return m ? m[1] : "";
    } catch {
      return "";
    }
  }

  /**
   * Google Drive önizleme oynatıcısının videoplayback adresleri DRIVE_STREAM çerezine bağlıdır (harici oynatıcıda
   * 403) ve MSE için ayrık ses/görüntü izleridir. Herkese açık dosyanın orijinal hali ise çerezsiz, Range destekli
   * drive.usercontent.google.com/download adresinden tek MP4 olarak akıtılabilir (mpv / VLC / mpv-android /
   * Just Player ile doğrulandı).
   */
  function extractGoogleDriveStream() {
    const id = extractDriveFileId(window.location.href);
    if (!id) return null;
    const direct = new URL("https://drive.usercontent.google.com/download");
    direct.searchParams.set("id", id);
    direct.searchParams.set("export", "download");
    direct.searchParams.set("confirm", "t");
    const resourceKey = new URL(window.location.href).searchParams.get("resourcekey");
    if (resourceKey) direct.searchParams.set("resourcekey", resourceKey);
    return {
      provider: "gdrive",
      streamUrl: direct.href,
      format: "MP4",
      variantsByHeight: {},
      title: (document.title || "").replace(/\s*-\s*Google Drive\s*$/i, "")
    };
  }

  function parseOkRuDom() {
    const qualityMap = {
      mobile: 144,
      lowest: 240,
      low: 360,
      sd: 480,
      hd: 720,
      full: 1080,
      quad: 1440,
      ultra: 2160
    };

    const nodes = document.querySelectorAll(
      '[data-module="OKVideo"][data-options], [data-options*="flashvars"], [data-options*="metadata"]'
    );
    for (const node of nodes) {
      try {
        const rawOpts = node.getAttribute("data-options");
        if (!rawOpts) continue;
        const opts = JSON.parse(rawOpts);
        const rawMeta = opts?.flashvars?.metadata;
        const meta = typeof rawMeta === "string" ? JSON.parse(rawMeta) : rawMeta;
        if (!meta || typeof meta !== "object") continue;

        const variantsByHeight = {};
        if (Array.isArray(meta.videos)) {
          for (const item of meta.videos) {
            if (!item || item.disallowed || !item.url) continue;
            const h = qualityMap[String(item.name || "").toLowerCase()];
            if (!h) continue;
            try {
              const resolved = new URL(item.url, window.location.href).href;
              if (isValidStreamHttpUrl(resolved)) {
                variantsByHeight[h] = resolved;
              }
            } catch {
              // Geçersiz URL'yi atla
            }
          }
        }

        const rawHls =
          meta.hlsManifestUrl || meta.ondemandHls || meta.hlsMasterPlaylistUrl || "";
        let hlsUrl = "";
        if (rawHls) {
          try {
            const resolvedHls = new URL(rawHls, window.location.href).href;
            if (isValidStreamHttpUrl(resolvedHls)) hlsUrl = resolvedHls;
          } catch {
            // Yoksay
          }
        }

        const sortedHeights = Object.keys(variantsByHeight)
          .map((k) => parseInt(k, 10))
          .sort((a, b) => b - a);
        const bestMp4 = sortedHeights.length > 0 ? variantsByHeight[sortedHeights[0]] : "";
        const streamUrl = hlsUrl || bestMp4;
        if (!streamUrl) continue;

        return {
          provider: "okru",
          streamUrl,
          format: hlsUrl ? "HLS" : "MP4",
          variantsByHeight,
          title: meta.movie?.title || document.title || ""
        };
      } catch {
        // Sonraki düğümü dene
      }
    }
    return null;
  }

  function unescapeInlineJsonUrl(rawStr) {
    if (!rawStr || typeof rawStr !== "string") return "";
    return rawStr
      .replace(/\\\//g, "/")
      .replace(/\\u0026/gi, "&")
      .replace(/&amp;/gi, "&")
      .trim();
  }

  function parseVkDom() {
    const variantsByHeight = {};
    let hlsUrl = "";

    for (const script of document.scripts) {
      const text = script.textContent || "";
      if (
        !text.includes("vkuser.net") &&
        !text.includes("okcdn.ru") &&
        !text.includes('"hls"') &&
        !text.includes('"mp4_')
      ) {
        continue;
      }

      const mp4Regex = /"(?:mp4_|url|cache)(144|240|360|480|720|1080|1440|2160)"\s*:\s*"(https?:[^"]+)"/g;
      for (const match of text.matchAll(mp4Regex)) {
        const h = parseInt(match[1], 10);
        const cleaned = unescapeInlineJsonUrl(match[2]);
        if (h > 0 && isValidStreamHttpUrl(cleaned) && !variantsByHeight[h]) {
          variantsByHeight[h] = cleaned;
        }
      }

      if (!hlsUrl) {
        const hlsMatch = text.match(/"(?:hls|hls_ondemand|hls_live)"\s*:\s*"(https?:[^"]+)"/);
        if (hlsMatch) {
          const cleanedHls = unescapeInlineJsonUrl(hlsMatch[1]);
          if (isValidStreamHttpUrl(cleanedHls)) {
            hlsUrl = cleanedHls;
          }
        }
      }
    }

    const sortedHeights = Object.keys(variantsByHeight)
      .map((k) => parseInt(k, 10))
      .sort((a, b) => b - a);
    const bestMp4 = sortedHeights.length > 0 ? variantsByHeight[sortedHeights[0]] : "";
    const streamUrl = hlsUrl || bestMp4;
    if (!streamUrl) return null;

    return {
      provider: "vk",
      streamUrl,
      format: hlsUrl ? "HLS" : "MP4",
      variantsByHeight,
      title: document.title || ""
    };
  }

  async function extractMailRuStream() {
    let metaUrl = "";
    const cfgEl = document.querySelector(".sp-video__page-config");
    if (cfgEl?.textContent) {
      try {
        const cfg = JSON.parse(cfgEl.textContent);
        if (cfg?.metaUrl && typeof cfg.metaUrl === "string") {
          metaUrl = cfg.metaUrl;
        }
      } catch {
        // Yoksay
      }
    }

    if (!metaUrl) {
      const embedMatch = window.location.pathname.match(/\/video\/embed\/(\d+)/i);
      if (embedMatch) {
        metaUrl = `/+/video/meta/${embedMatch[1]}`;
      }
    }

    if (!metaUrl) {
      const htmlText = document.documentElement?.innerHTML || "";
      const inlineMeta =
        htmlText.match(/["']((?:https?:\/\/[^"']+)?\/\+\/video\/meta\/[^"'\s<>]+)["']/i) ||
        htmlText.match(/(\/\+\/video\/meta\/\d+)/i);
      if (inlineMeta?.[1]) {
        metaUrl = unescapeInlineJsonUrl(inlineMeta[1]);
      }
    }

    if (!metaUrl) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const endpoint = new URL(metaUrl, window.location.href).href;
      const res = await fetch(endpoint, {
        credentials: "include",
        signal: controller.signal
      });
      if (!res.ok) return null;
      const data = await res.json();
      const variantsByHeight = {};
      if (Array.isArray(data?.videos)) {
        for (const item of data.videos) {
          if (!item?.url) continue;
          const h = parseInt(String(item.key || ""), 10);
          const resolved = new URL(item.url, window.location.href).href;
          if (!Number.isNaN(h) && h > 0 && isValidStreamHttpUrl(resolved)) {
            variantsByHeight[h] = resolved;
          }
        }
      }

      const sortedHeights = Object.keys(variantsByHeight)
        .map((k) => parseInt(k, 10))
        .sort((a, b) => b - a);
      if (sortedHeights.length === 0) return null;

      return {
        provider: "mailru",
        streamUrl: variantsByHeight[sortedHeights[0]],
        format: "MP4",
        variantsByHeight,
        title: data?.meta?.title || document.title || ""
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function extractSibnetStream() {
    let candidateSrc = "";

    for (const v of document.querySelectorAll("video")) {
      const srcs = [
        v.currentSrc || "",
        v.src || "",
        ...Array.from(v.querySelectorAll("source"), (s) => s.src || "")
      ];
      for (const s of srcs) {
        if (s && !s.startsWith("blob:") && !s.startsWith("data:") && isValidStreamHttpUrl(s)) {
          candidateSrc = s;
          if (/\/\/dv\d*\.sibnet\.ru\//i.test(s)) break;
        }
      }
      if (/\/\/dv\d*\.sibnet\.ru\//i.test(candidateSrc)) break;
    }

    if (!candidateSrc) {
      for (const script of document.scripts) {
        const text = script.textContent || "";
        const m =
          text.match(/src\s*:\s*["']((?:https?:\/\/[^"']+)?\/v\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
          text.match(/["']((?:https?:\/\/[^"']+)?\/v\/[a-zA-Z0-9/_.-]+\.(?:mp4|m3u8)[^"']*)["']/i);
        if (m?.[1]) {
          try {
            candidateSrc = new URL(m[1], window.location.href).href;
            break;
          } catch {
            // Yoksay
          }
        }
      }
    }

    if (!isValidStreamHttpUrl(candidateSrc)) return null;

    // Sibnet /v/...mp4 adresi Referer korumalı 302 yönlendirmesi yapar.
    // Aynı frame içinden hafif bir no-cors HEAD isteği tetikleyerek background.js onBeforeRedirect'in
    // doğrudan dv*.sibnet.ru CDN adresini yakalamasını sağlıyoruz.
    if (!/\/\/dv\d*\.sibnet\.ru\//i.test(candidateSrc)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        await fetch(candidateSrc, {
          method: "HEAD",
          mode: "no-cors",
          credentials: "include",
          redirect: "follow",
          signal: controller.signal
        });
      } catch {
        // Ağ hatası olursa mevcut aday URL ile devam et
      } finally {
        clearTimeout(timer);
      }
    }

    return {
      provider: "sibnet",
      streamUrl: candidateSrc,
      format: candidateSrc.toLowerCase().includes(".m3u8") ? "HLS" : "MP4",
      variantsByHeight: {},
      title: document.title || "",
      refreshFromSession: true
    };
  }

  // Sayfa ilk yüklendiğinde OK.ru / VK DOM yapılandırmasını hafifçe önbelleğe al
  // (oynatıcı başladıktan sonra data-options silinse bile çözünürlükler korunsun)
  let initialEmbedSnapshot = null;
  const currentEmbedProvider = detectEmbedProvider(window.location.href);
  if (currentEmbedProvider === "okru") {
    initialEmbedSnapshot = parseOkRuDom();
  } else if (currentEmbedProvider === "vk") {
    initialEmbedSnapshot = parseVkDom();
  } else if (currentEmbedProvider === "gdrive") {
    // Drive önizlemesinde video iç içe youtube.googleapis.com iframe'inde oynar ve o frame dosya kimliğini bilmez.
    // Doğrudan adres burada (ağ isteği yapmadan) kaydedilir; iç frame'deki buton, kendi frame'inde akış yoksa
    // sekmedeki bu kayda düşer. Video hiç oynatılmamış olsa bile çalışır.
    const driveStream = extractGoogleDriveStream();
    if (driveStream) {
      chrome.runtime
        .sendMessage({
          type: "REGISTER_EXTRACTED_STREAM",
          streamUrl: driveStream.streamUrl,
          format: driveStream.format,
          title: driveStream.title,
          pageUrl: window.location.href,
          userAgent: navigator.userAgent
        })
        .catch(() => {});
    }
  }

  async function extractEmbedStreamInPage(rawUrl, options = {}) {
    if (options.isAndroid) {
      const ytId = extractYouTubeVideoId(rawUrl);
      if (ytId) {
        const yt = await extractYouTubeHlsOnAndroid(rawUrl);
        if (yt?.streamUrl) {
          return {
            provider: "youtube",
            streamUrl: yt.streamUrl,
            format: "HLS",
            variantsByHeight: {},
            title: yt.title || document.title || ""
          };
        }
        return null;
      }
    }

    const provider = detectEmbedProvider(rawUrl);
    if (provider === "okru") {
      return parseOkRuDom() || initialEmbedSnapshot;
    }
    if (provider === "vk") {
      return parseVkDom() || initialEmbedSnapshot;
    }
    if (provider === "mailru") {
      return await extractMailRuStream();
    }
    if (provider === "sibnet") {
      return await extractSibnetStream();
    }
    if (provider === "gdrive") {
      return extractGoogleDriveStream();
    }
    return null;
  }

  // Toolbar popup üzerinden aktif sekme sorgulandığında Android için doğrudan HLS/MP4 çıkar
  // Chromium tabanlı Android tarayıcılar (Bare vb.) eklenti açılır penceresinden intent:// bağlantısını uygulamaya
  // iletmez (ERR_UNKNOWN_URL_SCHEME). Açılır pencere bunun yerine videonun üzerindeki menüyü açtırır; kullanıcı
  // menü öğesine sayfada dokunduğu için intent gerçek bir kullanıcı hareketiyle açılır.
  chrome.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "OPEN_PLAYER_MENU") return false;
    const hosts = [...document.querySelectorAll("[data-mpv-control-host]")];
    const visible = hosts.filter((h) => h.shadowRoot?.querySelector(".mpv-root.visible"));
    const target = (visible.length > 0 ? visible : hosts)[0];
    const trigger = target?.shadowRoot?.querySelector(".mpv-trigger");
    // Bu frame'de oynatıcı yoksa yanıt verme; başka bir frame (örn. gömülü oynatıcı iframe'i) yanıtlasın
    if (!trigger) return false;
    trigger.click();
    sendResponse({ ok: true });
    return false;
  });

  chrome.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "EXTRACT_YOUTUBE_HLS_ANDROID") return false;
    const vid = extractYouTubeVideoId(window.location.href);
    const provider = detectEmbedProvider(window.location.href);
    if (!vid && !provider) {
      // Cross-origin iframe yanıtını ezmemek için eşleşmeyen frame'lerde sendResponse çağırma
      return false;
    }

    (async () => {
      const extracted = await extractEmbedStreamInPage(window.location.href, { isAndroid: true });
      if (extracted?.streamUrl) {
        let finalStreamUrl = extracted.streamUrl;
        try {
          const regRes = await chrome.runtime.sendMessage({
            type: "REGISTER_EXTRACTED_STREAM",
            streamUrl: extracted.streamUrl,
            format: extracted.format,
            variantsByHeight: extracted.variantsByHeight,
            title: extracted.title,
            pageUrl: window.location.href,
            userAgent: navigator.userAgent
          });
          if (regRes?.streamUrl) finalStreamUrl = regRes.streamUrl;
        } catch {
          // Yoksay
        }
        sendResponse({ ok: true, streamUrl: finalStreamUrl, title: extracted.title });
      } else {
        sendResponse({ ok: false });
      }
    })();
    return true;
  });

  // ---------------------------------------------------------------------------
  // Oynatıcıdan bağımsız akış keşfi (uzantısız / MIME türü gizlenmiş HLS, blob: MSE oynatıcılar)
  // ---------------------------------------------------------------------------
  const PROBE_REQUEST_EVENT = "stream-to-mpv:probe-request";
  const PROBE_RESPONSE_EVENT = "stream-to-mpv:probe-response";
  const PLAYLIST_SNIFF_LIMIT = 256 * 1024;

  /**
   * MAIN world'deki page_probe.js'ten sayfadaki oynatıcı nesnelerinin (JWPlayer, Video.js, ArtPlayer…)
   * gerçek kaynak URL'lerini ister. Tıklanan video geçici bir nonce özniteliğiyle işaretlenir ki
   * birden fazla oynatıcı varsa doğru olanın kaynakları öne alınsın.
   */
  function requestPagePlayerSources(video, timeoutMs = 600) {
    return new Promise((resolve) => {
      const nonce = `stm${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      let done = false;
      const finish = (sources) => {
        if (done) return;
        done = true;
        document.removeEventListener(PROBE_RESPONSE_EVENT, onResponse);
        try {
          video?.removeAttribute("data-stream-to-mpv-probe");
        } catch {
          // Yoksay
        }
        resolve(Array.isArray(sources) ? sources : []);
      };
      const onResponse = (ev) => {
        let data = null;
        try {
          data = JSON.parse(typeof ev.detail === "string" ? ev.detail : "");
        } catch {
          return;
        }
        if (!data || data.nonce !== nonce) return;
        finish(data.sources);
      };
      document.addEventListener(PROBE_RESPONSE_EVENT, onResponse);
      try {
        video?.setAttribute("data-stream-to-mpv-probe", nonce);
      } catch {
        // Yoksay
      }
      try {
        document.dispatchEvent(new CustomEvent(PROBE_REQUEST_EVENT, { detail: nonce }));
      } catch {
        finish([]);
        return;
      }
      setTimeout(() => finish([]), timeoutMs);
    });
  }

  /**
   * URL'yi bu frame'in kendi bağlamından (aynı Referer / origin ile, oynatıcının yaptığı gibi) çeker ve
   * gövde #EXTM3U ile başlıyorsa playlist metnini döndürür. Video dosyalarını indirmez: ilk parça
   * playlist imzası taşımıyorsa veya MIME türü video/* ise hemen iptal edilir.
   */
  /**
   * Bir promise'i süre sınırıyla yarıştırır; süre dolarsa fallback döner. Buton "..." durumunda asla
   * sonsuza kadar takılı kalmasın diye tıklama akışındaki tüm beklemeler bununla sınırlandırılır.
   */
  function withDeadline(promise, ms, fallback) {
    let timer = null;
    return Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      })
    ]).finally(() => clearTimeout(timer));
  }

  function sendMessageWithDeadline(message, ms = 8000) {
    return withDeadline(chrome.runtime.sendMessage(message), ms, null);
  }

  function fetchPlaylistText(url, timeoutMs = 5000) {
    return withDeadline(fetchPlaylistTextInner(url, timeoutMs), timeoutMs + 500, null);
  }

  async function fetchPlaylistTextInner(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal
      });
      if (!res.ok) return null;
      const mime = (res.headers.get("content-type") || "").toLowerCase();
      if (/^(video|audio)\//.test(mime) && !/mpegurl/.test(mime)) {
        controller.abort();
        return null;
      }
      const reader = res.body?.getReader();
      if (!reader) return null;
      const decoder = new TextDecoder("utf-8");
      let text = "";
      let received = 0;
      while (received < PLAYLIST_SNIFF_LIMIT) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
        text += decoder.decode(value, { stream: true });
        if (text.length >= 16 && !/^\uFEFF?\s*#EXTM3U/.test(text)) {
          reader.cancel().catch(() => {});
          return null;
        }
      }
      reader.cancel().catch(() => {});
      text = text.replace(/^\uFEFF/, "").trimStart();
      if (!text.startsWith("#EXTM3U")) return null;
      return { url: res.url && isValidStreamHttpUrl(res.url) ? res.url : url, text };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const NON_PLAYLIST_EXT_RE =
    /\.(?:ts|m4s|m4f|mp4|m4v|webm|mkv|mov|aac|mp3|m4a|vtt|srt|key|jpe?g|png|gif|webp|avif|svg|ico|woff2?|ttf|otf|js|mjs|css|json|xml|html?|php|wasm|map|txt)$/i;

  function collectResourceTimingCandidates() {
    const out = [];
    try {
      const entries = performance.getEntriesByType("resource");
      for (let i = entries.length - 1; i >= 0 && out.length < 10; i--) {
        const e = entries[i];
        if (e.initiatorType !== "xmlhttprequest" && e.initiatorType !== "fetch") continue;
        let u;
        try {
          u = new URL(e.name);
        } catch {
          continue;
        }
        if (u.protocol !== "http:" && u.protocol !== "https:") continue;
        const lowerPath = u.pathname.toLowerCase();
        // .m3u8 uzantılılar zaten ağ yakalamasıyla bulunur; burada yalnızca gizlenmiş adresler aranır
        if (lowerPath.endsWith(".m3u8") || NON_PLAYLIST_EXT_RE.test(lowerPath)) continue;
        if (/\/(?:api|ajax|graphql|log|stats|ping|analytics|collect|track|auth)(?:\/|$)/i.test(lowerPath)) continue;
        if (!out.includes(e.name)) out.push(e.name);
      }
    } catch {
      // Yoksay
    }
    return out;
  }

  function classifyPlayerSourceKind(source) {
    const type = String(source?.type || "").toLowerCase();
    let path = "";
    try {
      path = new URL(source.url).pathname.toLowerCase();
    } catch {
      return "invalid";
    }
    if (/dash|mpd/.test(type) || path.endsWith(".mpd")) return "dash";
    if (/hls|m3u8|mpegurl/.test(type) || path.endsWith(".m3u8") || path.includes(".m3u8/")) return "hls";
    if (/mp4|webm|video\/|mov|mkv/.test(type) || /\.(mp4|m4v|webm|mkv|mov)$/.test(path)) return "file";
    return "unknown";
  }

  /**
   * Ağ yakalamasıyla eşleşen bir akış bulunamadığında (örn. /w/<token> gibi uzantısız, application/octet-stream
   * olarak sunulan HLS playlist'leri veya şifreli yapılandırmalı JWPlayer gömmeleri) bu frame içinde gerçek
   * akışı keşfeder:
   *   1) Sayfadaki oynatıcı nesnelerinin kaynakları (page_probe.js, MAIN world)
   *   2) Arka planın bu frame için tuttuğu MIME türü belirsiz XHR adayları; frame içinden yeniden çekilip
   *      #EXTM3U imzasıyla doğrulanır.
   */
  async function discoverStreamInFrame(video) {
    const tried = new Set();
    const sources = (await requestPagePlayerSources(video))
      .filter((s) => s && isValidStreamHttpUrl(s.url))
      .sort((a, b) => Number(Boolean(b.isTarget)) - Number(Boolean(a.isTarget)));

    for (const source of sources) {
      if (tried.has(source.url)) continue;
      tried.add(source.url);
      const kind = classifyPlayerSourceKind(source);
      if (kind === "dash" || kind === "invalid") continue;
      if (kind === "file") {
        return { provider: source.player, streamUrl: source.url, format: "MP4", variantsByHeight: {} };
      }
      const playlist = await fetchPlaylistText(source.url, 4000);
      if (playlist) {
        return {
          provider: source.player,
          streamUrl: playlist.url,
          format: "HLS",
          playlistText: playlist.text,
          variantsByHeight: {}
        };
      }
      if (kind === "hls") {
        // Oynatıcı türü HLS diyor ama doğrulama zaman aşımına uğradı (yavaş proxy / CORS): yine de kullan
        return { provider: source.player, streamUrl: source.url, format: "HLS", variantsByHeight: {} };
      }
    }

    let candidates = [];
    try {
      const res = await sendMessageWithDeadline({ type: "GET_PROBE_CANDIDATES" }, 4000);
      candidates = Array.isArray(res?.candidates) ? res.candidates.map((c) => c.url) : [];
    } catch {
      candidates = [];
    }
    // Bağımsız ikinci kaynak: bu frame'in Resource Timing kayıtları (XHR/fetch ile yüklenmiş, uzantısı
    // medya segmenti / görsel / betik olmayan adresler). Service worker zamanlamasından etkilenmez.
    for (const url of collectResourceTimingCandidates()) {
      if (!candidates.includes(url)) candidates.push(url);
    }
    const pending = candidates
      .filter((url) => isValidStreamHttpUrl(url) && !tried.has(url))
      .slice(0, 12)
      .map((url) => fetchPlaylistText(url, 3500));
    const results = await Promise.all(pending);
    // En yeni adaylar önde; master playlist'i (#EXT-X-STREAM-INF) variant'lara tercih et
    const verified = results.filter(Boolean);
    const best = verified.find((r) => r.text.includes("#EXT-X-STREAM-INF")) || verified[0];
    if (best) {
      return {
        provider: "network",
        streamUrl: best.url,
        format: "HLS",
        playlistText: best.text,
        variantsByHeight: {}
      };
    }
    return null;
  }

  /**
   * Bazı siteler gerçek gömme oynatıcıyı (ok.ru, mail.ru, hexload…) kendi sarmalayıcılarına
   * `?id=https://ok.ru/videoembed/...` gibi bir parametreyle verir. Masaüstünde yt-dlp sarmalayıcıyı değil
   * içteki gerçek gömme adresini çözebildiği için onu döndürür.
   */
  function findWrappedEmbedUrl(rawUrl) {
    try {
      const u = new URL(rawUrl);
      for (const [, val] of u.searchParams.entries()) {
        if (!/^https?:\/\//i.test(val)) continue;
        if (!isValidStreamHttpUrl(val)) continue;
        const inner = new URL(val);
        if (inner.hostname === u.hostname) continue;
        return inner.href;
      }
    } catch {
      // Yoksay
    }
    return "";
  }

  const PLAYER_LABELS = {
    mpv: "mpv",
    vlc: "VLC",
    mx: "MX Player",
    mxpro: "MX Player Pro",
    just: "Just Player",
    chooser: "player"
  };
  let currentPlayerLabel = "mpv";

  async function refreshPlayerLabel(isAndroid) {
    try {
      const data = await chrome.storage.local.get(["player", "androidPlayer"]);
      const key = isAndroid ? data.androidPlayer : data.player;
      currentPlayerLabel = PLAYER_LABELS[key] || "mpv";
    } catch {
      currentPlayerLabel = "mpv";
    }
  }

  function collectVideoContext(video, meta) {
    const sourceUrls = [];
    for (const node of video.querySelectorAll("source")) {
      if (node.src) sourceUrls.push(node.src);
    }

    return {
      currentSrc: video.currentSrc || "",
      src: video.src || "",
      sources: sourceUrls,
      videoCountInFrame: countEligibleVideosInFrame(),
      actionTimestamp: meta.lastActivityAt || Date.now(),
      pageUrl: window.location.href,
      fallbackPageUrl: findWrappedEmbedUrl(window.location.href) || window.location.href
    };
  }

  function attachWidgetToVideo(video) {
    if (videoRegistry.has(video)) return;

    const host = document.createElement("div");
    host.setAttribute("data-mpv-control-host", "true");

    const shadow = host.attachShadow({ mode: "open", delegatesFocus: true });
    if (sharedSheet) {
      shadow.adoptedStyleSheets = [sharedSheet];
    } else {
      const styleEl = document.createElement("style");
      styleEl.textContent = WIDGET_CSS;
      shadow.appendChild(styleEl);
    }

    shadow.appendChild(widgetTemplate.content.cloneNode(true));

    const rootEl = shadow.querySelector(".mpv-root");
    const triggerBtn = shadow.querySelector(".mpv-trigger");
    const badgeEl = shadow.querySelector(".mpv-badge");
    const menuEl = shadow.querySelector(".mpv-menu");
    const menuItemsEl = shadow.querySelector(".mpv-menu-items");
    const toastEl = shadow.querySelector(".mpv-toast");

    const supportsPopover =
      typeof HTMLElement !== "undefined" &&
      "popover" in HTMLElement.prototype &&
      typeof menuEl.showPopover === "function";

    function showPopoverSafe(el) {
      if (!supportsPopover || !el.isConnected) return;
      try {
        el.showPopover();
      } catch {
        // Zaten açıksa veya desteklenmiyorsa yoksay
      }
    }

    function hidePopoverSafe(el) {
      if (!supportsPopover) return;
      try {
        el.hidePopover();
      } catch {
        // Zaten kapalıysa yoksay
      }
    }

    function getViewportSize() {
      const docEl = document.documentElement;
      const vw =
        document.compatMode === "CSS1Compat" && docEl?.clientWidth
          ? Math.min(window.innerWidth || docEl.clientWidth, docEl.clientWidth)
          : window.innerWidth || docEl?.clientWidth || 360;
      const vh = window.innerHeight || docEl?.clientHeight || 240;
      return {
        vw: Math.max(120, vw),
        vh: Math.max(80, vh)
      };
    }

    /**
     * Menü veya bildirim kutusunu butonun konumuna göre hizalar;
     * sol, sağ, üst ve alt ekran/iframe sınırlarından taşmasını otomatik engeller.
     */
    function positionOverlayPanel(panelEl) {
      const EDGE_PAD = 8;
      const GAP = 8;
      const { vw, vh } = getViewportSize();
      const btnRect = triggerBtn.getBoundingClientRect();

      const hasValidBtnRect = btnRect.width > 0 && btnRect.height > 0;
      const videoRect = video.getBoundingClientRect();
      const anchorRect = hasValidBtnRect
        ? btnRect
        : {
            left: Math.max(EDGE_PAD, Math.min(vw - 72, videoRect.right - 80)),
            right: Math.max(80, Math.min(vw - EDGE_PAD, videoRect.right - 12)),
            top: Math.max(EDGE_PAD, Math.min(vh - 40, videoRect.bottom - 44)),
            bottom: Math.max(40, Math.min(vh - EDGE_PAD, videoRect.bottom - 10)),
            width: 68,
            height: 34
          };

      const maxW = Math.max(120, vw - EDGE_PAD * 2);
      panelEl.style.maxWidth = `${maxW}px`;

      const spaceAbove = anchorRect.top - GAP - EDGE_PAD;
      const spaceBelow = vh - anchorRect.bottom - GAP - EDGE_PAD;
      const openDown = spaceAbove < 180 && spaceBelow > spaceAbove;

      if (panelEl === menuEl) {
        const directionalSpace = openDown ? spaceBelow : spaceAbove;
        const allowedHeight =
          directionalSpace >= 108
            ? Math.min(300, Math.floor(directionalSpace))
            : Math.max(84, Math.min(300, vh - EDGE_PAD * 2));
        panelEl.style.maxHeight = `${allowedHeight}px`;
      }

      // Doğal genişlik ve yüksekliği ölçmek için geçici olarak başlangıç noktasına al
      panelEl.style.left = `${EDGE_PAD}px`;
      panelEl.style.top = `${EDGE_PAD}px`;

      const panelRect = panelEl.getBoundingClientRect();
      const panelW = panelRect.width || Math.min(200, maxW);
      const panelH = panelRect.height || 40;

      // Buton ekranın sol yarısındaysa sola, sağ yarısındaysa sağa hizala; ardından [8px, vw - 8px] aralığına sıkıştır
      const anchorCenterX = anchorRect.left + anchorRect.width / 2;
      const preferredLeft =
        anchorCenterX < vw / 2 ? anchorRect.left : anchorRect.right - panelW;
      const maxLeft = Math.max(EDGE_PAD, vw - panelW - EDGE_PAD);
      const finalLeft = Math.min(Math.max(preferredLeft, EDGE_PAD), maxLeft);

      // Yukarı veya aşağı aç; [8px, vh - 8px] aralığına sıkıştır
      const preferredTop = openDown
        ? anchorRect.bottom + GAP
        : anchorRect.top - GAP - panelH;
      const maxTop = Math.max(EDGE_PAD, vh - panelH - EDGE_PAD);
      const finalTop = Math.min(Math.max(preferredTop, EDGE_PAD), maxTop);

      panelEl.style.left = `${Math.round(finalLeft)}px`;
      panelEl.style.top = `${Math.round(finalTop)}px`;

      // Top Layer Popover desteklemeyen eski tarayıcılarda üst kapsayıcı transform sapmasını telafi et
      const verifyRect = panelEl.getBoundingClientRect();
      const dx = verifyRect.left - Math.round(finalLeft);
      const dy = verifyRect.top - Math.round(finalTop);
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        panelEl.style.left = `${Math.round(finalLeft - dx)}px`;
        panelEl.style.top = `${Math.round(finalTop - dy)}px`;
      }
    }

    function openMenu() {
      menuEl.classList.add("open");
      rootEl.classList.add("menu-open", "visible");
      showPopoverSafe(menuEl);
      positionOverlayPanel(menuEl);
    }

    function closeMenu() {
      menuEl.classList.remove("open");
      rootEl.classList.remove("menu-open");
      hidePopoverSafe(menuEl);
    }

    function hideToast() {
      toastEl.className = "mpv-toast";
      hidePopoverSafe(toastEl);
    }

    function repositionOpenPanels() {
      if (menuEl.classList.contains("open")) {
        showPopoverSafe(menuEl);
        positionOverlayPanel(menuEl);
      }
      if (toastEl.classList.contains("show")) {
        showPopoverSafe(toastEl);
        positionOverlayPanel(toastEl);
      }
    }

    const meta = {
      video,
      host,
      rootEl,
      triggerBtn,
      badgeEl,
      menuEl,
      menuItemsEl,
      toastEl,
      mode: "floating",
      lastActivityAt: Date.now(),
      toastTimer: null,
      closeMenu,
      repositionOpenPanels
    };

    function showToast(text, kind = "info", durationMs = 3000) {
      if (meta.toastTimer) clearTimeout(meta.toastTimer);
      closeMenu();
      toastEl.textContent = text;
      toastEl.className = `mpv-toast show ${kind}`;
      rootEl.classList.add("visible");
      showPopoverSafe(toastEl);
      positionOverlayPanel(toastEl);

      meta.toastTimer = setTimeout(() => {
        hideToast();
      }, durationMs);
    }

    async function shareOrCopyStreamUrl(streamUrl) {
      if (!streamUrl) {
        showToast("No playable stream URL detected yet.", "error", 3200);
        return;
      }

      if (typeof navigator.share === "function") {
        try {
          await navigator.share({ url: streamUrl });
          try {
            if (!video.paused) video.pause();
          } catch {
            // Yoksay
          }
          closeMenu();
          return;
        } catch (err) {
          // Kullanıcı iptali sessiz; "Share failed" (paylaşım desteklenmiyor) panoya kopyalamaya düşer
          if (err?.name === "AbortError" && !/fail/i.test(err?.message || "")) {
            closeMenu();
            return;
          }
          // Cross-origin iframe içindeyse navigator.share izin hatası verebilir; panoya kopyalamaya düş
        }
      }

      try {
        await navigator.clipboard.writeText(streamUrl);
        showToast("Stream URL copied! Open mpv-android -> Open URL", "success", 3800);
      } catch {
        showToast("Use the extension toolbar icon -> Share Stream", "info", 3800);
      }
    }

    async function launchWithResolution(preferredResolution, labelText) {
      closeMenu();
      triggerBtn.disabled = true;
      badgeEl.textContent = "...";

      try {
        const context = collectVideoContext(video, meta);
        // yt-dlp ile çözümleme (VLC + sayfa URL'si) 25 sn sürebildiği için süre sınırı daha uzun
        const response = await sendMessageWithDeadline({
          type: "OPEN_FROM_VIDEO_OVERLAY",
          preferredResolution,
          clientHandlesAndroidIntent: true,
          ...context
        }, 45000);

        if (!response) {
          showToast("The extension did not respond in time. Please try again.", "error", 4200);
          return;
        }

        if (response?.ok) {
          if (response.intentUri) {
            const tempLink = document.createElement("a");
            tempLink.href = response.intentUri;
            tempLink.target = "_blank";
            tempLink.rel = "noopener noreferrer";
            shadow.appendChild(tempLink);
            tempLink.click();
            tempLink.remove();
          }
          try {
            if (!video.paused) video.pause();
          } catch {
            // Yoksay
          }
          showToast(`Opening in ${currentPlayerLabel} (${labelText})`, "success", 2600);
        } else {
          showToast(response?.errorMessage || `Could not open in ${currentPlayerLabel}.`, "error", 4200);
        }
      } catch (err) {
        showToast(err?.message || "Extension error.", "error", 4000);
      } finally {
        triggerBtn.disabled = false;
        badgeEl.textContent = "mpv";
      }
    }

    function appendOptionLabels(containerEl, label, tag) {
      const nameSpan = document.createElement("span");
      nameSpan.className = "mpv-item-label";
      nameSpan.textContent = label;
      containerEl.appendChild(nameSpan);

      if (tag) {
        const tagSpan = document.createElement("span");
        tagSpan.className = "mpv-item-tag";
        tagSpan.textContent = tag;
        containerEl.appendChild(tagSpan);
      }
    }

    function appendAndroidIntentLink(label, tag, href) {
      const link = document.createElement("a");
      link.className = "mpv-item";
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      appendOptionLabels(link, label, tag);
      link.addEventListener("click", (ev) => {
        // ev.preventDefault() ÇAĞRILMAMALI: tarayıcının doğal intent:// navigasyonu kullanılır
        ev.stopPropagation();
        try {
          if (!video.paused) video.pause();
        } catch {
          // Yoksay
        }
        setTimeout(() => showToast(`Opening (${label})`, "success", 2600), 80);
      });
      menuItemsEl.appendChild(link);
    }

    function renderResolutionItems(heights, mode, isAndroid = false, androidIntents = {}, streamUrls = {}, extras = {}) {
      menuItemsEl.replaceChildren();

      // Uzantısız / octet-stream HLS (örn. /w/<token>): mpv-android'in FFmpeg'i bunu HLS olarak açmaz ve
      // intent ile seçenek iletilemez. VLC içerikten algıladığı için öne çıkar.
      const altIntents = extras?.altIntents || {};
      // mpv-android (FFmpeg uzantı kontrolü) ve Just Player (ExoPlayer, intent MIME'ı video/*) bu akışı açamaz;
      // VLC ve MX Player içerikten tanır (emülatörde doğrulandı). MX Pro doğrulanmadı.
      const recommendVlc =
        isAndroid && extras?.disguisedHls && !["vlc", "mx"].includes(extras?.androidPlayer) && altIntents.vlc;
      if (recommendVlc) {
        const note = document.createElement("div");
        note.className = "mpv-menu-note";
        const p = extras.androidPlayer;
        note.textContent =
          p === "mpv" || p === "just"
            ? `${p === "mpv" ? "mpv-android" : "Just Player"} can't open this stream type. Use VLC:`
            : p === "chooser"
              ? "Some apps can't open this stream type. VLC works:"
              : `${currentPlayerLabel} may not open this stream type. VLC works:`;
        menuItemsEl.appendChild(note);
        appendAndroidIntentLink("Open in VLC", "RECOMMENDED", altIntents.vlc);
        const div = document.createElement("div");
        div.className = "mpv-menu-divider";
        menuItemsEl.appendChild(div);
      }

      const options = [{ value: "best", label: isAndroid ? `Open in ${currentPlayerLabel}` : "Auto (Best Quality)", tag: "BEST" }];

      const list = Array.isArray(heights) && heights.length > 0 ? heights : [];
      for (const h of list) {
        const info = RESOLUTION_LABELS[h] || { label: `${h}p`, tag: h >= 1080 ? "HD" : "" };
        options.push({ value: String(h), label: info.label, tag: info.tag });
      }

      if (!isAndroid && mode === "ytdl") {
        options.push({ value: "audio", label: "Audio Only", tag: "MP3/AAC" });
      }

      for (const opt of options) {
        const directIntentUri = isAndroid ? (androidIntents?.[opt.value] || androidIntents?.best || "") : "";

        // Android üzerinde gerçek kullanıcı dokunuşuyla (user gesture) harici uygulamayı açmak için
        // doğrudan <a href="intent://..."> bağlantısı üret (Modern Web Guidance `html`: URL navigasyonu için <a>)
        if (isAndroid && directIntentUri) {
          const itemLink = document.createElement("a");
          itemLink.className = "mpv-item";
          itemLink.href = directIntentUri;
          itemLink.target = "_blank";
          itemLink.rel = "noopener noreferrer";
          appendOptionLabels(itemLink, opt.label, opt.tag);

          itemLink.addEventListener("click", (ev) => {
            // ÖNEMLİ: ev.preventDefault() ÇAĞRILMAMALIDIR; tarayıcının doğal intent:// navigasyonuna izin ver!
            ev.stopPropagation();
            try {
              if (!video.paused) video.pause();
            } catch {
              // Yoksay
            }
            // Bağlantı aktivasyonu tamamlandıktan hemen sonra menüyü kapat ve bilgi göster
            setTimeout(() => {
              showToast(`Opening in ${currentPlayerLabel} (${opt.label})`, "success", 2800);
            }, 80);
          });

          menuItemsEl.appendChild(itemLink);
          continue;
        }

        const itemBtn = document.createElement("button");
        itemBtn.type = "button";
        itemBtn.className = "mpv-item";
        appendOptionLabels(itemBtn, opt.label, opt.tag);

        itemBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          launchWithResolution(opt.value, opt.label);
        });

        menuItemsEl.appendChild(itemBtn);
      }

      // Android ek seçenek: Bare Browser'da "Open links in apps = Never" veya Gizli Sekme aktifse
      // bile çalışan yerel Android Paylaşım Menüsü ("Open with mpv") butonu
      if (isAndroid && streamUrls?.best) {
        const divider = document.createElement("div");
        divider.className = "mpv-menu-divider";
        menuItemsEl.appendChild(divider);

        if (altIntents.vlc && !recommendVlc) {
          appendAndroidIntentLink("Open in VLC", "VLC", altIntents.vlc);
        }
        if (altIntents.chooser) {
          appendAndroidIntentLink("Open with…", "APPS", altIntents.chooser);
        }

        const shareBtn = document.createElement("button");
        shareBtn.type = "button";
        shareBtn.className = "mpv-item";
        appendOptionLabels(shareBtn, "Share Stream to App…", "SHARE");
        shareBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          shareOrCopyStreamUrl(streamUrls.best);
        });
        menuItemsEl.appendChild(shareBtn);
      }
    }

    // Ana "mpv" butonuna basıldığında çözünürlük menüsünü aç/kapat
    triggerBtn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      if (menuEl.classList.contains("open")) {
        closeMenu();
        return;
      }

      hideToast();
      await withDeadline(refreshPlayerLabel(/Android/i.test(navigator.userAgent)), 1500, null);
      const menuHeaderLabel = shadow.querySelector(".mpv-menu-header span");
      if (menuHeaderLabel) menuHeaderLabel.textContent = `Open in ${currentPlayerLabel}`;

      // Arka plandan bu videonun mevcut çözünürlüklerini ve (Android ise) hazır intent:// linklerini sorgula
      let heights = [2160, 1440, 1080, 720, 480, 360];
      let mode = "ytdl";
      let isAndroid = /Android/i.test(navigator.userAgent);
      let androidIntents = {};
      let streamUrls = {};
      let menuExtras = { altIntents: {}, disguisedHls: false, androidPlayer: "mpv" };
      const takeExtras = (r) => {
        if (!r || typeof r !== "object") return;
        if (r.altIntents && typeof r.altIntents === "object") menuExtras.altIntents = r.altIntents;
        if (typeof r.disguisedHls === "boolean") menuExtras.disguisedHls = r.disguisedHls;
        if (typeof r.androidPlayer === "string") menuExtras.androidPlayer = r.androidPlayer;
      };
      try {
        const context = collectVideoContext(video, meta);
        const resInfo = await sendMessageWithDeadline({
          type: "GET_VIDEO_RESOLUTIONS",
          ...context
        });
        if (resInfo?.ok) {
          mode = resInfo.mode || "ytdl";
          heights = Array.isArray(resInfo.heights) ? resInfo.heights : [];
          isAndroid = Boolean(resInfo.isAndroid);
          androidIntents = resInfo.androidIntents || {};
          takeExtras(resInfo);
          streamUrls = resInfo.streamUrls || {};
        }
      } catch {
        // Varsayılan listeyi koru
      }

      const ytVideoId = isAndroid ? extractYouTubeVideoId(window.location.href) : null;
      const embedProvider = detectEmbedProvider(window.location.href);
      const needsAndroidExtract =
        isAndroid &&
        (Boolean(ytVideoId) ||
          (Boolean(embedProvider) &&
            (!androidIntents.best ||
              (heights.length === 0 && embedProvider !== "sibnet") ||
              (embedProvider === "sibnet" && /\/v\//i.test(streamUrls.best || "")))));
      const needsDesktopEmbedExtract =
        !isAndroid &&
        Boolean(embedProvider) &&
        (mode === "ytdl" || (heights.length === 0 && embedProvider !== "sibnet"));

      if (needsAndroidExtract || needsDesktopEmbedExtract) {
        badgeEl.textContent = "...";
        triggerBtn.disabled = true;
        try {
          const extracted = await withDeadline(
            extractEmbedStreamInPage(window.location.href, { isAndroid }),
            12000,
            null
          );
          if (extracted?.streamUrl) {
            const regRes = await sendMessageWithDeadline({
              type: "REGISTER_EXTRACTED_STREAM",
              streamUrl: extracted.streamUrl,
              format: extracted.format,
              variantsByHeight: extracted.variantsByHeight,
              title: extracted.title,
              pageUrl: window.location.href,
              userAgent: navigator.userAgent
            });

            if (extracted.refreshFromSession) {
              const refreshed = await sendMessageWithDeadline({
                type: "GET_VIDEO_RESOLUTIONS",
                ...collectVideoContext(video, meta)
              });
              if (refreshed?.ok && (refreshed.androidIntents?.best || !isAndroid)) {
                mode = refreshed.mode || mode;
                heights = Array.isArray(refreshed.heights) ? refreshed.heights : heights;
                androidIntents = refreshed.androidIntents || androidIntents;
                takeExtras(refreshed);
                streamUrls = refreshed.streamUrls || streamUrls;
              } else if (regRes?.ok) {
                heights = Array.isArray(regRes.heights) ? regRes.heights : [];
                androidIntents = regRes.androidIntents || {};
                takeExtras(regRes);
                streamUrls = regRes.streamUrls || { best: extracted.streamUrl };
                mode = heights.length > 0 ? "hls_master" : "direct";
              }
            } else if (regRes?.ok) {
              heights = Array.isArray(regRes.heights) ? regRes.heights : [];
              androidIntents = regRes.androidIntents || {};
              takeExtras(regRes);
              streamUrls = regRes.streamUrls || { best: extracted.streamUrl };
              mode =
                extracted.provider === "youtube"
                  ? "youtube_hls"
                  : heights.length > 0
                    ? "hls_master"
                    : "direct";
            }
          }
        } catch {
          // Hata olursa mevcut algılanan akış listesiyle devam et
        } finally {
          badgeEl.textContent = "mpv";
          triggerBtn.disabled = false;
        }
      }

      // Ağ yakalaması ve bilinen gömme çıkarıcıları sonuç vermediyse (örn. uzantısız /w/<token> HLS, şifreli
      // yapılandırmalı JWPlayer gömmeleri) bu frame içinde oynatıcıdan bağımsız keşif yap.
      const stillNoStream = isAndroid ? !androidIntents.best : mode === "ytdl";
      const skipDiscovery = !isAndroid && Boolean(extractYouTubeVideoId(window.location.href));
      if (stillNoStream && !skipDiscovery) {
        badgeEl.textContent = "...";
        triggerBtn.disabled = true;
        try {
          const discovered = await withDeadline(discoverStreamInFrame(video), 12000, null);
          if (discovered?.streamUrl) {
            const regRes = await sendMessageWithDeadline({
              type: "REGISTER_EXTRACTED_STREAM",
              streamUrl: discovered.streamUrl,
              format: discovered.format,
              playlistText: discovered.playlistText,
              variantsByHeight: discovered.variantsByHeight,
              title: document.title || "",
              pageUrl: window.location.href,
              userAgent: navigator.userAgent
            });
            if (regRes?.ok) {
              heights = Array.isArray(regRes.heights) ? regRes.heights : [];
              androidIntents = regRes.androidIntents || {};
              takeExtras(regRes);
              streamUrls = regRes.streamUrls || { best: regRes.streamUrl || discovered.streamUrl };
              mode = heights.length > 0 ? "hls_master" : "direct";
            } else if (regRes?.statusCode === "UNSUPPORTED_STREAM") {
              showToast(regRes.errorMessage || "Unsupported stream (DRM).", "error", 4200);
              return;
            }
          }
        } catch {
          // Keşif başarısızsa mevcut duruma göre devam et
        } finally {
          badgeEl.textContent = "mpv";
          triggerBtn.disabled = false;
        }
      }

      if (isAndroid && !androidIntents.best) {
        showToast(
          ytVideoId
            ? "Could not extract YouTube HLS stream for this video."
            : "No stream found for this player yet. Start playback for a few seconds, then tap again.",
          "error",
          4200
        );
        return;
      }

      renderResolutionItems(heights, mode, isAndroid, androidIntents, streamUrls, menuExtras);
      openMenu();
    });

    // Oynatıcının kendi tıklama/dokunma/kısayol olaylarının tetiklenmesini engelle
    for (const evtName of [
      "mousedown",
      "mouseup",
      "pointerdown",
      "pointerup",
      "touchstart",
      "touchend",
      "dblclick"
    ]) {
      host.addEventListener(evtName, (ev) => {
        ev.stopPropagation();
      });
    }

    // Dışarıya tıklandığında veya Escape tuşuna basıldığında menüyü kapat
    document.addEventListener(
      "click",
      (ev) => {
        if (!menuEl.classList.contains("open")) return;
        const path = ev.composedPath ? ev.composedPath() : [];
        if (!path.includes(host)) {
          closeMenu();
        }
      },
      { capture: true, passive: true }
    );

    document.addEventListener(
      "keydown",
      (ev) => {
        if (ev.key === "Escape" && menuEl.classList.contains("open")) {
          closeMenu();
        }
      },
      { passive: true }
    );

    const markActivity = () => {
      meta.lastActivityAt = Date.now();
      updateWidgetPlacement(meta);
    };

    video.addEventListener("play", markActivity, { passive: true });
    video.addEventListener("playing", markActivity, { passive: true });
    video.addEventListener("seeking", markActivity, { passive: true });
    video.addEventListener("loadeddata", markActivity, { passive: true });
    video.addEventListener("mousemove", () => updateWidgetPlacement(meta), { passive: true });
    video.addEventListener("touchstart", () => updateWidgetPlacement(meta), { passive: true });

    videoRegistry.set(video, meta);
    trackedVideos.add(video);
    updateWidgetPlacement(meta);
  }

  /**
   * Butonu varsa oynatıcının kontrol çubuğunun içine (inline),
   * yoksa videonun sağ alt kontrol hizasına (floating) yerleştirir.
   */
  function updateWidgetPlacement(meta) {
    const { video, host, rootEl, menuEl } = meta;

    if (!video.isConnected) {
      meta.closeMenu();
      host.remove();
      trackedVideos.delete(video);
      return;
    }

    const inlineBar = findInlineControlBar(video);
    if (inlineBar && inlineBar.container) {
      meta.mode = "inline";
      host.setAttribute("data-mode", "inline");
      rootEl.style.bottom = "";
      rootEl.style.right = "";
      rootEl.style.top = "";

      // Menü açıkken DOM ebeveynini taşıma (Top Layer popover'ın kapanmasını önler), sadece konumu güncelle
      if (menuEl.classList.contains("open") && host.parentNode === inlineBar.container) {
        meta.repositionOpenPanels();
        return;
      }

      const targetBefore =
        inlineBar.beforeNode && inlineBar.beforeNode.parentNode === inlineBar.container
          ? inlineBar.beforeNode
          : null;

      if (targetBefore) {
        const targetOrder = window.getComputedStyle(targetBefore).order;
        host.style.order = targetOrder && targetOrder !== "0" ? targetOrder : "";
        if (host.parentNode !== inlineBar.container || host.nextElementSibling !== targetBefore) {
          inlineBar.container.insertBefore(host, targetBefore);
        }
      } else if (inlineBar.insertFirst) {
        host.style.order = "";
        if (host.parentNode !== inlineBar.container || inlineBar.container.firstElementChild !== host) {
          inlineBar.container.insertBefore(host, inlineBar.container.firstChild);
        }
      } else {
        const lastEl = inlineBar.container.lastElementChild;
        if (lastEl && lastEl !== host) {
          const lastOrder = window.getComputedStyle(lastEl).order;
          host.style.order = lastOrder && lastOrder !== "0" ? lastOrder : "";
        }
        if (host.parentNode !== inlineBar.container || inlineBar.container.lastElementChild !== host) {
          inlineBar.container.appendChild(host);
        }
      }

      meta.repositionOpenPanels();
      return;
    }

    // Özel kontrol barı bulunamadıysa: sağ alt kontrol çubuğu hizasında (floating) göster
    meta.mode = "floating";
    host.setAttribute("data-mode", "floating");
    host.style.order = "";

    const desiredRoot = getFloatingMountRoot(video);
    if (desiredRoot && host.parentNode !== desiredRoot) {
      if (menuEl.classList.contains("open")) {
        meta.closeMenu();
      }
      desiredRoot.appendChild(host);
    }

    const rect = video.getBoundingClientRect();
    const eligible = isEligiblePlayerVideo(video, rect);
    const inViewport =
      rect.bottom > 50 &&
      rect.right > 70 &&
      rect.top < window.innerHeight - 40 &&
      rect.left < window.innerWidth - 60;

    if (!eligible || !inViewport) {
      rootEl.classList.remove("visible");
      if (menuEl.classList.contains("open")) {
        meta.closeMenu();
      }
      return;
    }

    // Sağ alt kontrol barının hemen üst/yan hizası
    const bottomOffset = Math.max(12, Math.round(window.innerHeight - rect.bottom + 46));
    const rightOffset = Math.max(12, Math.round(window.innerWidth - rect.right + 14));

    rootEl.style.bottom = `${bottomOffset}px`;
    rootEl.style.right = `${rightOffset}px`;
    rootEl.classList.add("visible");
    meta.repositionOpenPanels();
  }

  let rafScheduled = false;
  function scheduleLayoutUpdate() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      for (const video of trackedVideos) {
        const meta = videoRegistry.get(video);
        if (meta) updateWidgetPlacement(meta);
      }
    });
  }

  function handleFullscreenChange() {
    for (const video of trackedVideos) {
      const meta = videoRegistry.get(video);
      if (meta) meta.closeMenu();
    }
    scheduleLayoutUpdate();
  }

  function scanForVideos(root = document) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    for (const v of root.querySelectorAll("video")) {
      attachWidgetToVideo(v);
    }
  }

  scanForVideos(document);

  const observer = new MutationObserver((mutations) => {
    let needsRescan = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.tagName === "VIDEO") {
          attachWidgetToVideo(node);
        } else if (node.querySelectorAll) {
          needsRescan = true;
        }
      }
    }
    if (needsRescan) scanForVideos(document);
    scheduleLayoutUpdate();
  });

  observer.observe(document.documentElement || document, {
    childList: true,
    subtree: true
  });

  window.addEventListener("scroll", scheduleLayoutUpdate, { passive: true, capture: true });
  window.addEventListener("resize", scheduleLayoutUpdate, { passive: true });
  document.addEventListener("fullscreenchange", handleFullscreenChange, { passive: true });
  document.addEventListener("webkitfullscreenchange", handleFullscreenChange, { passive: true });

  setInterval(scheduleLayoutUpdate, 1200);
})();

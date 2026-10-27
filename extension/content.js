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

  // Toolbar popup üzerinden YouTube sekmesi sorgulandığında Android için doğrudan HLS çıkar
  chrome.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "EXTRACT_YOUTUBE_HLS_ANDROID") return false;
    const vid = extractYouTubeVideoId(window.location.href);
    if (!vid) {
      sendResponse({ ok: false });
      return false;
    }

    (async () => {
      const extracted = await extractYouTubeHlsOnAndroid(window.location.href);
      if (extracted?.streamUrl) {
        try {
          await chrome.runtime.sendMessage({
            type: "REGISTER_EXTRACTED_STREAM",
            streamUrl: extracted.streamUrl,
            title: extracted.title
          });
        } catch {
          // Yoksay
        }
        sendResponse({ ok: true, streamUrl: extracted.streamUrl, title: extracted.title });
      } else {
        sendResponse({ ok: false });
      }
    })();
    return true;
  });

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
      pageUrl: window.location.href
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
          if (err?.name === "AbortError") {
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
        const response = await chrome.runtime.sendMessage({
          type: "OPEN_FROM_VIDEO_OVERLAY",
          preferredResolution,
          clientHandlesAndroidIntent: true,
          ...context
        });

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
          showToast(`Opening in mpv (${labelText})`, "success", 2600);
        } else {
          showToast(response?.errorMessage || "Could not open in mpv.", "error", 4200);
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

    function renderResolutionItems(heights, mode, isAndroid = false, androidIntents = {}, streamUrls = {}) {
      menuItemsEl.replaceChildren();

      const options = [{ value: "best", label: isAndroid ? "Open in mpv-android" : "Auto (Best Quality)", tag: "BEST" }];

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
              showToast(`Opening in mpv (${opt.label})`, "success", 2800);
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

      // Arka plandan bu videonun mevcut çözünürlüklerini ve (Android ise) hazır intent:// linklerini sorgula
      let heights = [2160, 1440, 1080, 720, 480, 360];
      let mode = "ytdl";
      let isAndroid = /Android/i.test(navigator.userAgent);
      let androidIntents = {};
      let streamUrls = {};
      try {
        const context = collectVideoContext(video, meta);
        const resInfo = await chrome.runtime.sendMessage({
          type: "GET_VIDEO_RESOLUTIONS",
          ...context
        });
        if (resInfo?.ok) {
          mode = resInfo.mode || "ytdl";
          heights = Array.isArray(resInfo.heights) ? resInfo.heights : [];
          isAndroid = Boolean(resInfo.isAndroid);
          androidIntents = resInfo.androidIntents || {};
          streamUrls = resInfo.streamUrls || {};
        }
      } catch {
        // Varsayılan listeyi koru
      }

      if (isAndroid) {
        const ytVideoId = extractYouTubeVideoId(window.location.href);
        if (ytVideoId) {
          badgeEl.textContent = "...";
          triggerBtn.disabled = true;
          try {
            const extracted = await extractYouTubeHlsOnAndroid(window.location.href);
            if (extracted?.streamUrl) {
              const regRes = await chrome.runtime.sendMessage({
                type: "REGISTER_EXTRACTED_STREAM",
                streamUrl: extracted.streamUrl,
                title: extracted.title
              });
              if (regRes?.ok && regRes.intentUri) {
                androidIntents = { best: regRes.intentUri };
                streamUrls = { best: extracted.streamUrl };
                heights = [];
                mode = "youtube_hls";
              }
            }
          } catch {
            // Yoksay
          } finally {
            badgeEl.textContent = "mpv";
            triggerBtn.disabled = false;
          }
        }

        if (!androidIntents.best) {
          showToast(
            ytVideoId
              ? "Could not extract YouTube HLS stream for this video."
              : "Play the video first so its stream URL can be captured.",
            "error",
            3600
          );
          return;
        }
      }

      renderResolutionItems(heights, mode, isAndroid, androidIntents, streamUrls);
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

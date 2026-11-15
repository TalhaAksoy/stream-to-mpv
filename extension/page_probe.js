/**
 * Page Probe (MAIN world)
 *
 * Sayfanın kendi JavaScript dünyasında çalışır; yalnızca içerik betiği (content.js) bir istek
 * olayı gönderdiğinde, sayfadaki bilinen oynatıcı nesnelerinden (JWPlayer, Video.js, ArtPlayer,
 * DPlayer, Clappr, Plyr) gerçek kaynak URL'lerini okur.
 *
 * - Global XHR / fetch yamalaması YAPMAZ; sayfa davranışını değiştirmez.
 * - Yanıt yalnızca JSON dizgesi olarak döner (Firefox Xray sınırlarında güvenli).
 * - Sayfa bu yanıtı taklit edebilir; bu yüzden içerik betiği ve arka plan URL'leri yeniden doğrular.
 */
(() => {
  if (window.__streamToMpvPageProbe) return;
  Object.defineProperty(window, "__streamToMpvPageProbe", { value: true });

  const REQUEST_EVENT = "stream-to-mpv:probe-request";
  const RESPONSE_EVENT = "stream-to-mpv:probe-response";
  const MAX_SOURCES = 24;

  function toAbsoluteHttpUrl(raw) {
    if (typeof raw !== "string" || !raw.trim()) return "";
    try {
      const u = new URL(raw.trim(), document.baseURI);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
    } catch {
      return "";
    }
  }

  function containsTarget(containerEl, targetVideo) {
    try {
      return Boolean(containerEl && targetVideo && containerEl.contains(targetVideo));
    } catch {
      return false;
    }
  }

  function collectSources(nonce) {
    const out = [];
    const seen = new Set();
    const targetVideo = nonce
      ? document.querySelector(`video[data-stream-to-mpv-probe="${CSS.escape(nonce)}"]`)
      : null;

    const push = (rawUrl, type, player, isTarget, label) => {
      const url = toAbsoluteHttpUrl(rawUrl);
      if (!url || seen.has(url) || out.length >= MAX_SOURCES) return;
      seen.add(url);
      out.push({
        url,
        type: typeof type === "string" ? type.slice(0, 40) : "",
        player,
        isTarget: Boolean(isTarget),
        label: typeof label === "string" ? label.slice(0, 40) : ""
      });
    };

    // 1. JWPlayer (jwplayer(0..n)); allSources / sources / file
    try {
      if (typeof window.jwplayer === "function") {
        for (let i = 0; i < 8; i++) {
          let p = null;
          try {
            p = window.jwplayer(i);
          } catch {
            break;
          }
          if (!p || typeof p.getPlaylistItem !== "function") break;
          const container = typeof p.getContainer === "function" ? p.getContainer() : null;
          if (!container) break;
          const isTarget = containsTarget(container, targetVideo);
          const item = p.getPlaylistItem() || {};
          const sources = []
            .concat(Array.isArray(item.allSources) ? item.allSources : [])
            .concat(Array.isArray(item.sources) ? item.sources : []);
          if (item.file) sources.push({ file: item.file, type: item.type });
          for (const s of sources) {
            if (s && typeof s === "object") push(s.file, s.type, "jwplayer", isTarget, s.label);
          }
        }
      }
    } catch {
      // Yoksay
    }

    // 2. Video.js (videojs.getPlayers())
    try {
      const vjs = window.videojs;
      const players = vjs && typeof vjs.getPlayers === "function" ? vjs.getPlayers() : null;
      if (players) {
        for (const p of Object.values(players)) {
          if (!p || typeof p.currentSources !== "function") continue;
          const isTarget = containsTarget(typeof p.el === "function" ? p.el() : null, targetVideo);
          for (const s of p.currentSources() || []) {
            push(s?.src, s?.type, "videojs", isTarget, "");
          }
          if (typeof p.currentSrc === "function") push(p.currentSrc(), "", "videojs", isTarget, "");
        }
      }
    } catch {
      // Yoksay
    }

    // 3. ArtPlayer (Artplayer.instances)
    try {
      const instances = window.Artplayer?.instances;
      if (Array.isArray(instances)) {
        for (const art of instances) {
          const isTarget = containsTarget(art?.template?.$container || art?.template?.$player, targetVideo);
          push(art?.option?.url || art?.url, art?.option?.type, "artplayer", isTarget, "");
          for (const q of art?.option?.quality || []) push(q?.url, art?.option?.type, "artplayer", isTarget, q?.html);
        }
      }
    } catch {
      // Yoksay
    }

    // 4. DPlayer / Clappr / Plyr: sitelerin sık kullandığı global değişken adları
    try {
      for (const name of ["dp", "dplayer", "player", "clappr", "plyr", "art"]) {
        const obj = window[name];
        if (!obj || typeof obj !== "object") continue;
        const container = obj.container || obj.elements?.container || obj.core?.el || null;
        const isTarget = containsTarget(container, targetVideo);
        push(obj.options?.video?.url, obj.options?.video?.type, "dplayer", isTarget, "");
        for (const q of obj.options?.video?.quality || []) push(q?.url, q?.type, "dplayer", isTarget, q?.name);
        push(obj.options?.source, "", "clappr", isTarget, "");
        push(typeof obj.source === "string" ? obj.source : "", "", "plyr", isTarget, "");
      }
    } catch {
      // Yoksay
    }

    return out;
  }

  document.addEventListener(REQUEST_EVENT, (ev) => {
    const nonce = typeof ev.detail === "string" ? ev.detail.slice(0, 64) : "";
    let payload = "[]";
    try {
      payload = JSON.stringify(collectSources(nonce));
    } catch {
      payload = "[]";
    }
    document.dispatchEvent(
      new CustomEvent(RESPONSE_EVENT, { detail: JSON.stringify({ nonce, sources: JSON.parse(payload) }) })
    );
  });
})();

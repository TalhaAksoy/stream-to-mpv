/**
 * Background Service Worker (Manifest V3)
 * Ağ trafiğini (webRequest) izler, video akışlarını sınıflandırır,
 * geçici durumu chrome.storage.session üzerinde yarışsız (mutex ile) yönetir
 * ve macOS Native Messaging / Android Intent üzerinden mpv başlatır.
 */

import {
  DEFAULT_BLOCKED_DOMAINS,
  STREAM_PRIORITY,
  classifyCandidate,
  computeDedupeKey,
  inspectHlsPlaylistContent,
  isBlockedDomain,
  isValidHttpUrl,
  matchStreamForVideoContext,
  selectBestPlayableStream,
  sortStreams
} from "./stream_utils.js";

const NATIVE_HOST_NAME = "com.talha.mpv";
const MAX_STREAMS_PER_TAB = 25;
const MAX_PENDING_REQUESTS = 300;
const AUTO_OPEN_COLLECT_MS = 1400; // Master playlist yakalamak için kısa toplama aralığı

// Eşzamanlı storage.session yazmalarında veri yarışını (race condition) önleyen sıralı kilit
let storageQueue = Promise.resolve();
function withSessionLock(fn) {
  const next = storageQueue.then(fn, fn);
  storageQueue = next.catch(() => {});
  return next;
}

// Otomatik oynatma için sekme bazlı kısa toplama zamanlayıcıları
const autoOpenTimers = new Map();

/**
 * HTTP başlıklarında satır sonu / kontrol karakteri olup olmadığını denetler.
 */
function sanitizeHeaderValue(val) {
  if (!val || typeof val !== "string") return "";
  if (/[\r\n\0]/.test(val)) return "";
  return val.trim();
}

/**
 * Kalıcı kullanıcı ayarlarını chrome.storage.local'dan okur.
 */
async function getSettings() {
  const defaults = {
    autoOpen: false, // Varsayılan olarak kesinlikle kapalı
    ytdlpFallback: true, // YouTube/Twitch/Vimeo vb. sitelerde tek tıklamayla çalışması için varsayılan açık
    blockedDomains: DEFAULT_BLOCKED_DOMAINS
  };
  try {
    const data = await chrome.storage.local.get(["autoOpen", "ytdlpFallback", "blockedDomains"]);
    return {
      autoOpen: Boolean(data.autoOpen ?? defaults.autoOpen),
      ytdlpFallback: Boolean(data.ytdlpFallback ?? defaults.ytdlpFallback),
      blockedDomains: Array.isArray(data.blockedDomains) ? data.blockedDomains : defaults.blockedDomains
    };
  } catch {
    return defaults;
  }
}

/**
 * Yakalanan akışlar içerisinden aynı frame'deki alternatif çözünürlükleri (HLS Master veya
 * Sibnet/Tau/Alucard gibi çoklu MP4 kalite URL'leri) toplar.
 */
function buildResolutionMapForTab(streams, frameId, primaryStream) {
  const heightMap = {};

  if (primaryStream?.variantsByHeight) {
    Object.assign(heightMap, primaryStream.variantsByHeight);
  }

  const sameFrame = (streams || []).filter(
    (s) =>
      s.streamType !== "unsupported" &&
      (typeof s.frameId !== "number" || s.frameId === frameId)
  );

  for (const s of sameFrame) {
    if (s.quality) {
      const m = String(s.quality).match(/(\d{3,4})p/i);
      if (m) {
        const h = parseInt(m[1], 10);
        if (h > 0 && !heightMap[h]) {
          heightMap[h] = s.url;
        }
      }
    }
  }

  const heights = Object.keys(heightMap)
    .map((k) => parseInt(k, 10))
    .filter((h) => !Number.isNaN(h) && h > 0)
    .sort((a, b) => b - a);

  return { heights, heightMap };
}

/**
 * Sekme üzerindeki rozet (badge) sayısını günceller.
 */
async function updateTabBadge(tabId, streams) {
  if (typeof tabId !== "number" || tabId < 0) return;
  try {
    const playableCount = (streams || []).filter(
      (s) => s.streamType !== "unsupported" && s.priority !== STREAM_PRIORITY.UNSUPPORTED_DRM
    ).length;
    const text = playableCount > 0 ? String(playableCount) : "";
    await chrome.action.setBadgeText({ tabId, text });
    if (playableCount > 0) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#6c3483" });
    }
  } catch {
    // Sekme kapanmış olabilir, sessizce yoksay
  }
}

/**
 * HLS adayının gerçekten #EXT-X-STREAM-INF içerip içermediğini güvenli ve hafif bir istekle doğrular.
 * Büyük dosyaları veya video segmentlerini kesinlikle indirmez (Range: bytes=0-4095 ve AbortController kullanır).
 */
async function verifyHlsMasterIfNeeded(tabId, dedupeKey, streamUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3500);

  try {
    const response = await fetch(streamUrl, {
      method: "GET",
      headers: {
        Range: "bytes=0-4095"
      },
      credentials: "omit",
      signal: controller.signal
    });

    if (!response.ok && response.status !== 206) return;

    // Boyut çok büyükse (örn. yanlışlıkla doğrudan video dosyasıysa) hemen iptal et
    const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
    if (contentLength > 256 * 1024) {
      controller.abort();
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) return;

    const { value } = await reader.read();
    await reader.cancel();

    if (!value) return;
    const text = new TextDecoder("utf-8").decode(value.slice(0, 8192));
    const verifiedInfo = inspectHlsPlaylistContent(text, null, streamUrl);
    if (!verifiedInfo) return;

    await withSessionLock(async () => {
      const key = `tab_${tabId}`;
      const stored = await chrome.storage.session.get(key);
      const tabState = stored[key];
      if (!tabState || !Array.isArray(tabState.streams)) return;

      const idx = tabState.streams.findIndex((s) => s.dedupeKey === dedupeKey);
      if (idx === -1) return;

      const current = tabState.streams[idx];
      current.streamType = verifiedInfo.streamType;
      current.priority = verifiedInfo.priority;
      current.verified = true;
      if (verifiedInfo.quality) {
        current.quality = verifiedInfo.quality;
      }
      if (Array.isArray(verifiedInfo.availableHeights)) {
        current.availableHeights = verifiedInfo.availableHeights;
      }
      if (verifiedInfo.variantsByHeight) {
        current.variantsByHeight = verifiedInfo.variantsByHeight;
      }
      if (verifiedInfo.unsupportedReason) {
        current.unsupportedReason = verifiedInfo.unsupportedReason;
      }

      tabState.streams = sortStreams(tabState.streams);
      await chrome.storage.session.set({ [key]: tabState });
      await updateTabBadge(tabId, tabState.streams);
    });
  } catch {
    // CORS veya ağ hatası durumunda mevcut sınıflandırmayı koru
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Yakalanan bir akış adayını ilgili sekmenin oturum verisine ekler veya günceller.
 */
async function recordStreamCandidate(tabId, candidateData) {
  if (typeof tabId !== "number" || tabId < 0) return;

  let tabInfo = null;
  try {
    tabInfo = await chrome.tabs.get(tabId);
  } catch {
    return; // Sekme mevcut değil
  }

  const pageUrl = tabInfo?.url || "";
  const pageTitle = tabInfo?.title || "Unknown Tab";

  let shouldVerifyHls = false;
  let triggerAutoOpen = false;

  await withSessionLock(async () => {
    const key = `tab_${tabId}`;
    const stored = await chrome.storage.session.get(key);
    const tabState = stored[key] || {
      tabId,
      pageUrl,
      pageTitle,
      sessionId: `${tabId}_${Date.now()}`,
      autoOpenedSessionId: null,
      streams: []
    };

    // Eğer sayfa URL'si (ana sayfa/navigasyon) değişmişse ve onUpdated kaçırılmışsa, farklı videoları karıştırma
    if (pageUrl && tabState.pageUrl && getPageIdentity(pageUrl) !== getPageIdentity(tabState.pageUrl)) {
      tabState.pageUrl = pageUrl;
      tabState.pageTitle = pageTitle;
      tabState.sessionId = `${tabId}_${Date.now()}`;
      tabState.autoOpenedSessionId = null;
      tabState.streams = [];
    } else {
      if (pageUrl) tabState.pageUrl = pageUrl;
      if (pageTitle) tabState.pageTitle = pageTitle;
    }

    const dedupeKey = computeDedupeKey(candidateData.url);
    const now = Date.now();
    const existingIdx = tabState.streams.findIndex(
      (s) =>
        s.dedupeKey === dedupeKey ||
        (Array.isArray(s.aliasUrls) &&
          (s.aliasUrls.includes(candidateData.url) || s.aliasUrls.includes(dedupeKey)))
    );

    let domain = "";
    try {
      domain = new URL(candidateData.url).hostname;
    } catch {
      domain = "unknown";
    }

    if (existingIdx !== -1) {
      // Aynı akışın yeni imzalı/güncel URL'si geldi: eskiyi silmeden en güncel URL'yi koru.
      // Ancak 302 yönlendirme öncesi alias geldiyse çözümlenmiş son CDN URL'sini geri alma!
      const existing = tabState.streams[existingIdx];
      const matchedViaRedirectAlias = existing.dedupeKey !== dedupeKey;
      const urlChanged = !matchedViaRedirectAlias && existing.url !== candidateData.url;
      if (!matchedViaRedirectAlias) {
        existing.url = candidateData.url;
      }
      existing.updatedAt = now;
      existing.tabTitle = pageTitle;
      if (candidateData.referer) existing.referer = candidateData.referer;
      if (candidateData.userAgent) existing.userAgent = candidateData.userAgent;
      if (typeof candidateData.frameId === "number") existing.frameId = candidateData.frameId;
      if (candidateData.quality && !existing.quality) existing.quality = candidateData.quality;

      if (Array.isArray(candidateData.aliasUrls) && candidateData.aliasUrls.length > 0) {
        const mergedAliases = new Set([...(existing.aliasUrls || []), ...candidateData.aliasUrls]);
        existing.aliasUrls = Array.from(mergedAliases);
      }

      if (
        candidateData.variantsByHeight &&
        typeof candidateData.variantsByHeight === "object" &&
        Object.keys(candidateData.variantsByHeight).length > 0
      ) {
        existing.variantsByHeight = {
          ...(existing.variantsByHeight || {}),
          ...candidateData.variantsByHeight
        };
        existing.availableHeights = Object.keys(existing.variantsByHeight)
          .map((k) => parseInt(k, 10))
          .filter((h) => !Number.isNaN(h) && h > 0)
          .sort((a, b) => b - a);
      }

      if (candidateData.verified) {
        existing.verified = true;
        existing.priority = Math.min(existing.priority, candidateData.priority);
        existing.streamType = candidateData.streamType;
      } else if (!existing.verified && candidateData.priority < existing.priority) {
        // Eğer daha önce doğrulanmamışsa ve yeni bilgi daha yüksek öncelikliyse güncelle
        existing.priority = candidateData.priority;
        existing.streamType = candidateData.streamType;
      }

      // İmzalı HLS Master URL'si yenilendiyse alt variant token'larının bayat kalmaması için yeniden doğrula
      if (urlChanged && candidateData.needsVerification && !candidateData.variantsByHeight) {
        shouldVerifyHls = true;
      }
    } else {
      const newEntry = {
        id: `${tabId}_${now}_${Math.random().toString(36).slice(2, 7)}`,
        dedupeKey,
        tabId,
        frameId: typeof candidateData.frameId === "number" ? candidateData.frameId : 0,
        tabTitle: pageTitle,
        pageUrl,
        domain,
        url: candidateData.url,
        aliasUrls: Array.isArray(candidateData.aliasUrls) ? candidateData.aliasUrls : [],
        referer: candidateData.referer || pageUrl || "",
        userAgent: candidateData.userAgent || "",
        format: candidateData.format,
        streamType: candidateData.streamType,
        priority: candidateData.priority,
        quality: candidateData.quality || null,
        availableHeights: Array.isArray(candidateData.availableHeights)
          ? candidateData.availableHeights
          : undefined,
        variantsByHeight: candidateData.variantsByHeight || undefined,
        verified: Boolean(candidateData.verified),
        unsupportedReason: candidateData.unsupportedReason || null,
        capturedAt: now,
        updatedAt: now
      };

      tabState.streams.push(newEntry);
      shouldVerifyHls = Boolean(candidateData.needsVerification);
    }

    tabState.streams = sortStreams(tabState.streams).slice(0, MAX_STREAMS_PER_TAB);
    await chrome.storage.session.set({ [key]: tabState });
    await updateTabBadge(tabId, tabState.streams);

    // Otomatik açma kontrolü: yalnızca oynatılabilir akış varsa ve bu oturumda henüz açılmadıysa
    const playable = selectBestPlayableStream(tabState.streams);
    if (playable && tabState.autoOpenedSessionId !== tabState.sessionId) {
      triggerAutoOpen = true;
    }
  });

  if (shouldVerifyHls) {
    const dedupeKey = computeDedupeKey(candidateData.url);
    verifyHlsMasterIfNeeded(tabId, dedupeKey, candidateData.url);
  }

  if (triggerAutoOpen) {
    scheduleAutoOpenIfEnabled(tabId);
  }
}

/**
 * Aynı sekmede farklı bir videoya geçildiğini anlamak için sayfa kimliği çıkarır (hash hariç).
 */
function getPageIdentity(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return rawUrl || "";
  }
}

/**
 * Otomatik oynatma etkinse kısa bir toplama aralığı (collection window) bekler,
 * böylece ilk görülen chunklist yerine master playlist'in yakalanmasına fırsat tanır
 * ve aynı oturum için yalnızca bir kez mpv başlatır.
 */
async function scheduleAutoOpenIfEnabled(tabId) {
  const settings = await getSettings();
  if (!settings.autoOpen) return;

  if (autoOpenTimers.has(tabId)) return;

  const timerId = setTimeout(async () => {
    autoOpenTimers.delete(tabId);

    // Ayarın bu sırada kullanıcı tarafından kapatılmadığını tekrar doğrula
    const latestSettings = await getSettings();
    if (!latestSettings.autoOpen) return;

    let streamToOpen = null;
    await withSessionLock(async () => {
      const key = `tab_${tabId}`;
      const stored = await chrome.storage.session.get(key);
      const tabState = stored[key];
      if (!tabState || !Array.isArray(tabState.streams)) return;

      if (tabState.autoOpenedSessionId === tabState.sessionId) return;

      const best = selectBestPlayableStream(tabState.streams);
      if (!best) return;

      tabState.autoOpenedSessionId = tabState.sessionId;
      streamToOpen = best;
      await chrome.storage.session.set({ [key]: tabState });
    });

    if (streamToOpen) {
      const result = await openStreamInMpv(streamToOpen, { isAutoOpen: true });
      if (!result.ok) {
        // Otomatik açma başarısız olursa sekme durumuna hata bilgisini kaydet ve rozet ile uyar
        await withSessionLock(async () => {
          const key = `tab_${tabId}`;
          const stored = await chrome.storage.session.get(key);
          const tabState = stored[key];
          if (tabState) {
            tabState.lastAutoOpenError = result.errorMessage || "Auto-open failed";
            await chrome.storage.session.set({ [key]: tabState });
          }
        });
        try {
          await chrome.action.setBadgeText({ tabId, text: "ERR" });
          await chrome.action.setBadgeBackgroundColor({ tabId, color: "#c0392b" });
        } catch {
          // Sekme kapanmış olabilir
        }
      }
    }
  }, AUTO_OPEN_COLLECT_MS);

  autoOpenTimers.set(tabId, timerId);
}

/**
 * webRequest.onSendHeaders: İstek URL'sini, Referer ve User-Agent başlıklarını requestId ile yakalar.
 */
chrome.webRequest.onSendHeaders.addListener(
  async (details) => {
    if (details.tabId < 0) return;
    if (!isValidHttpUrl(details.url)) return;

    const settings = await getSettings();
    if (isBlockedDomain(details.url, settings.blockedDomains)) return;

    let referer = "";
    let userAgent = "";

    if (Array.isArray(details.requestHeaders)) {
      for (const h of details.requestHeaders) {
        const name = (h.name || "").toLowerCase();
        if (name === "referer") {
          referer = sanitizeHeaderValue(h.value);
        } else if (name === "user-agent") {
          userAgent = sanitizeHeaderValue(h.value);
        }
      }
    }

    if (!referer && details.initiator && isValidHttpUrl(details.initiator)) {
      referer = sanitizeHeaderValue(details.initiator);
    }

    // URL üzerinden doğrudan sınıflandırma yapılabiliyorsa kaydet, ayrıca onHeadersReceived için pending'de tut
    let existingAliases = [];
    await withSessionLock(async () => {
      const stored = await chrome.storage.session.get("pendingRequests");
      const pending = stored.pendingRequests || {};
      const prevMeta = pending[details.requestId];
      existingAliases = Array.isArray(prevMeta?.aliasUrls) ? prevMeta.aliasUrls : [];

      pending[details.requestId] = {
        url: details.url,
        tabId: details.tabId,
        frameId: typeof details.frameId === "number" ? details.frameId : (prevMeta?.frameId ?? 0),
        referer: referer || prevMeta?.referer || "",
        userAgent: userAgent || prevMeta?.userAgent || "",
        aliasUrls: existingAliases,
        timestamp: Date.now()
      };

      // Bellek sınırı: eski pending kayıtlarını temizle
      const keys = Object.keys(pending);
      if (keys.length > MAX_PENDING_REQUESTS) {
        keys
          .sort((a, b) => pending[a].timestamp - pending[b].timestamp)
          .slice(0, keys.length - MAX_PENDING_REQUESTS)
          .forEach((k) => delete pending[k]);
      }

      await chrome.storage.session.set({ pendingRequests: pending });
    });

    const urlClassified = classifyCandidate(details.url, "");
    if (urlClassified) {
      await recordStreamCandidate(details.tabId, {
        url: details.url,
        frameId: typeof details.frameId === "number" ? details.frameId : 0,
        referer,
        userAgent,
        aliasUrls: existingAliases,
        ...urlClassified
      });
    }
  },
  { urls: ["http://*/*", "https://*/*"] },
  ["requestHeaders", "extraHeaders"]
);

/**
 * webRequest.onBeforeRedirect: Sibnet (/v/...mp4 -> dv*.sibnet.ru/...mp4) gibi Referer korumalı
 * 302 yönlendirmelerini izleyerek son CDN adresini kaydeder; böylece hem DOM video.src eşleşmesi
 * korunur hem de Android mpv-android doğrudan son CDN adresini Referer engeline takılmadan açar.
 */
chrome.webRequest.onBeforeRedirect?.addListener(
  async (details) => {
    if (details.tabId < 0) return;
    if (!isValidHttpUrl(details.url) || !isValidHttpUrl(details.redirectUrl)) return;

    const settings = await getSettings();
    if (isBlockedDomain(details.redirectUrl, settings.blockedDomains)) return;

    const fromClassified = classifyCandidate(details.url, "");
    const toClassified = classifyCandidate(details.redirectUrl, "");
    if (!fromClassified && !toClassified) return;

    const fromDedupe = computeDedupeKey(details.url);
    const toDedupe = computeDedupeKey(details.redirectUrl);

    await withSessionLock(async () => {
      const tabKey = `tab_${details.tabId}`;
      const [storedPending, storedTab] = await Promise.all([
        chrome.storage.session.get("pendingRequests"),
        chrome.storage.session.get(tabKey)
      ]);
      const pending = storedPending.pendingRequests || {};
      const prevMeta = pending[details.requestId];
      const nextAliases = Array.from(
        new Set([...(prevMeta?.aliasUrls || []), details.url, fromDedupe])
      );

      pending[details.requestId] = {
        url: details.redirectUrl,
        tabId: details.tabId,
        frameId: typeof details.frameId === "number" ? details.frameId : (prevMeta?.frameId ?? 0),
        referer: prevMeta?.referer || sanitizeHeaderValue(details.initiator || ""),
        userAgent: prevMeta?.userAgent || "",
        aliasUrls: nextAliases,
        timestamp: Date.now()
      };

      const tabState = storedTab[tabKey];
      if (tabState && Array.isArray(tabState.streams)) {
        const fromIdx = tabState.streams.findIndex(
          (s) => s.url === details.url || s.dedupeKey === fromDedupe
        );
        if (fromIdx !== -1 && (!toClassified || toClassified.streamType !== "unsupported")) {
          const entry = tabState.streams[fromIdx];
          const mergedAliases = Array.from(
            new Set([...(entry.aliasUrls || []), ...nextAliases])
          );
          const dupTargetIdx = tabState.streams.findIndex(
            (s, idx) => idx !== fromIdx && s.dedupeKey === toDedupe
          );
          if (dupTargetIdx !== -1) {
            const targetEntry = tabState.streams[dupTargetIdx];
            targetEntry.url = details.redirectUrl;
            targetEntry.updatedAt = Date.now();
            targetEntry.aliasUrls = Array.from(
              new Set([...(targetEntry.aliasUrls || []), ...mergedAliases])
            );
            tabState.streams.splice(fromIdx, 1);
          } else {
            entry.url = details.redirectUrl;
            entry.dedupeKey = toDedupe;
            entry.aliasUrls = mergedAliases;
            entry.updatedAt = Date.now();
          }
          tabState.streams = sortStreams(tabState.streams);
          await chrome.storage.session.set({ pendingRequests: pending, [tabKey]: tabState });
          return;
        }
      }

      await chrome.storage.session.set({ pendingRequests: pending });
    });
  },
  { urls: ["http://*/*", "https://*/*"] }
);

/**
 * webRequest.onHeadersReceived: Response Content-Type ve Content-Length başlıklarını okur,
 * requestId üzerinden onSendHeaders ile ilişkilendirir.
 */
chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    if (details.tabId < 0) return;
    if (!isValidHttpUrl(details.url)) return;

    // 3xx yönlendirme yanıtlarında pending kaydını silme; onBeforeRedirect hedef CDN adresini devralacak
    if (typeof details.statusCode === "number" && details.statusCode >= 300 && details.statusCode < 400) {
      return;
    }

    let reqMeta = null;
    await withSessionLock(async () => {
      const stored = await chrome.storage.session.get("pendingRequests");
      const pending = stored.pendingRequests || {};
      reqMeta = pending[details.requestId] || null;
      if (reqMeta) {
        delete pending[details.requestId];
        await chrome.storage.session.set({ pendingRequests: pending });
      }
    });

    const settings = await getSettings();
    if (isBlockedDomain(details.url, settings.blockedDomains)) return;

    let contentType = "";
    let contentLength = null;

    if (Array.isArray(details.responseHeaders)) {
      for (const h of details.responseHeaders) {
        const name = (h.name || "").toLowerCase();
        if (name === "content-type") {
          contentType = h.value || "";
        } else if (name === "content-length") {
          const parsedLen = parseInt(h.value || "", 10);
          if (!Number.isNaN(parsedLen)) contentLength = parsedLen;
        }
      }
    }

    const classified = classifyCandidate(details.url, contentType, contentLength);
    if (!classified) {
      // onSendHeaders aşamasında URL uzantısından aday eklenmiş küçük init segmentlerini (<50 KB) temizle
      if (contentLength !== null && contentLength > 0 && contentLength < 50 * 1024) {
        const rejectedDedupe = computeDedupeKey(details.url);
        await withSessionLock(async () => {
          const tabKey = `tab_${details.tabId}`;
          const stored = await chrome.storage.session.get(tabKey);
          const tabState = stored[tabKey];
          if (!tabState || !Array.isArray(tabState.streams)) return;
          const beforeLen = tabState.streams.length;
          tabState.streams = tabState.streams.filter((s) => s.dedupeKey !== rejectedDedupe);
          if (tabState.streams.length !== beforeLen) {
            await chrome.storage.session.set({ [tabKey]: tabState });
            await updateTabBadge(details.tabId, tabState.streams);
          }
        });
      }
      return;
    }

    await recordStreamCandidate(details.tabId, {
      url: details.url,
      frameId:
        typeof details.frameId === "number"
          ? details.frameId
          : reqMeta?.frameId ?? 0,
      referer: reqMeta?.referer || sanitizeHeaderValue(details.initiator || ""),
      userAgent: reqMeta?.userAgent || "",
      aliasUrls: reqMeta?.aliasUrls || [],
      ...classified
    });
  },
  { urls: ["http://*/*", "https://*/*"] },
  ["responseHeaders", "extraHeaders"]
);

/**
 * İstek hata ile biterse pending tablosundan temizle.
 */
chrome.webRequest.onErrorOccurred.addListener(
  async (details) => {
    await withSessionLock(async () => {
      const stored = await chrome.storage.session.get("pendingRequests");
      const pending = stored.pendingRequests || {};
      if (pending[details.requestId]) {
        delete pending[details.requestId];
        await chrome.storage.session.set({ pendingRequests: pending });
      }
    });
  },
  { urls: ["http://*/*", "https://*/*"] }
);

/**
 * Sekme kapandığında ilgili sekmenin tüm akış verilerini temizle.
 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (autoOpenTimers.has(tabId)) {
    clearTimeout(autoOpenTimers.get(tabId));
    autoOpenTimers.delete(tabId);
  }
  await withSessionLock(async () => {
    const key = `tab_${tabId}`;
    await chrome.storage.session.remove(key);
  });
});

/**
 * Ana sayfa navigasyonunda (URL değiştiğinde veya sayfa yenilendiğinde)
 * önceki oynatma oturumunun verilerini temizle.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    if (autoOpenTimers.has(tabId)) {
      clearTimeout(autoOpenTimers.get(tabId));
      autoOpenTimers.delete(tabId);
    }
    await withSessionLock(async () => {
      const key = `tab_${tabId}`;
      const stored = await chrome.storage.session.get(key);
      const prev = stored[key];

      if (!prev || getPageIdentity(prev.pageUrl) !== getPageIdentity(changeInfo.url)) {
        await chrome.storage.session.set({
          [key]: {
            tabId,
            pageUrl: changeInfo.url,
            pageTitle: tab.title || "Loading...",
            sessionId: `${tabId}_${Date.now()}`,
            autoOpenedSessionId: null,
            streams: []
          }
        });
        await updateTabBadge(tabId, []);
      }
    });
  } else if (changeInfo.title) {
    await withSessionLock(async () => {
      const key = `tab_${tabId}`;
      const stored = await chrome.storage.session.get(key);
      const tabState = stored[key];
      if (tabState) {
        tabState.pageTitle = changeInfo.title;
        for (const s of tabState.streams) {
          s.tabTitle = changeInfo.title;
        }
        await chrome.storage.session.set({ [key]: tabState });
      }
    });
  }
});

/**
 * Çalışma ortamının Android olup olmadığını tespit eder.
 */
async function isAndroidPlatform() {
  try {
    const info = await chrome.runtime.getPlatformInfo();
    if (info?.os === "android") return true;
  } catch {
    // Yoksay
  }
  return /Android/i.test(navigator.userAgent);
}

/**
 * Android üzerinde mpv-android (is.xyz.mpv) için resmi Intent URI'sini oluşturur.
 * Notlar:
 * 1) mpv-android'in AndroidManifest.xml tanımında <data android:mimeType="video/*" /> yer alır
 *    ("video/any" değil, "video/*" kullanılmalıdır).
 * 2) Bare Browser (Patch 0110) "Open links in apps = Never" durumunda S.browser_fallback_url varsa
 *    sekmeyi zorla o adrese yönlendirdiği için S.browser_fallback_url eklenmez.
 */
function buildAndroidMpvIntentUri(streamUrl, title = "") {
  const parsed = new URL(streamUrl);
  const scheme = parsed.protocol.replace(":", "");
  const cleanHostAndPath = `${parsed.host}${parsed.pathname}${parsed.search}`;

  const parts = [
    `intent://${cleanHostAndPath}#Intent`,
    `scheme=${scheme}`,
    `package=is.xyz.mpv`,
    `action=android.intent.action.VIEW`,
    `type=video/*`
  ];

  const cleanTitle = sanitizeHeaderValue(title);
  if (cleanTitle) {
    parts.push(`S.title=${encodeURIComponent(cleanTitle.slice(0, 120))}`);
  }

  parts.push("end");
  return `${parts.join(";")};`;
}

/**
 * Seçilen akışı platforma göre (macOS Native Messaging veya Android Intent) mpv'de açmayı dener.
 */
async function openStreamInMpv(streamRecord, options = {}) {
  if (!streamRecord || !isValidHttpUrl(streamRecord.url)) {
    return {
      ok: false,
      statusCode: "INVALID_URL",
      errorMessage: "Invalid or unsupported stream URL."
    };
  }

  if (
    streamRecord.streamType === "unsupported" ||
    streamRecord.priority === STREAM_PRIORITY.UNSUPPORTED_DRM
  ) {
    return {
      ok: false,
      statusCode: "UNSUPPORTED_STREAM",
      errorMessage: streamRecord.unsupportedReason || "Unsupported stream (DRM / DASH)."
    };
  }

  // Sekmedeki en güncel URL'yi kullandığımızdan emin ol
  let latestRecord = streamRecord;
  if (typeof streamRecord.tabId === "number") {
    const stored = await chrome.storage.session.get(`tab_${streamRecord.tabId}`);
    const tabState = stored[`tab_${streamRecord.tabId}`];
    if (tabState && Array.isArray(tabState.streams)) {
      const found = tabState.streams.find((s) => s.dedupeKey === streamRecord.dedupeKey);
      if (found) latestRecord = found;
    }
  }

  // Eğer kullanıcı belirli bir çözünürlük seçtiyse (örn. maxHeight = 720 veya "audio")
  // ve HLS Master Playlist içinde ilgili variant URL mevcutsa doğrudan o variant URL'sini seç
  const requestedResolution = options.preferredResolution || "best";
  let targetUrl = latestRecord.url;

  if (
    requestedResolution !== "best" &&
    requestedResolution !== "audio" &&
    latestRecord.variantsByHeight &&
    typeof latestRecord.variantsByHeight === "object"
  ) {
    const maxH = parseInt(String(requestedResolution), 10);
    if (!Number.isNaN(maxH) && maxH > 0) {
      const heights = Object.keys(latestRecord.variantsByHeight)
        .map((k) => parseInt(k, 10))
        .filter((h) => !Number.isNaN(h) && h <= maxH)
        .sort((a, b) => b - a);
      if (heights.length > 0) {
        const pickedUrl = latestRecord.variantsByHeight[heights[0]];
        if (isValidHttpUrl(pickedUrl)) {
          targetUrl = pickedUrl;
        }
      }
    }
  }

  // Akış yaş kontrolü (örneğin 45 dakikadan eskiyse kullanıcıya bilgi notu ekle)
  const ageMs = Date.now() - (latestRecord.updatedAt || latestRecord.capturedAt || Date.now());
  const mightBeExpired = ageMs > 45 * 60 * 1000;

  const isAndroid = await isAndroidPlatform();
  if (isAndroid) {
    // Android üzerinde doğrudan sayfa içi kullanıcı tıklamasıyla (user gesture) açılabilmesi için
    // intentUri'yi yanıt içinde döndür; eğer popup'tan veya otomatik açmadan çağrıldıysa tabs.update/create dene.
    const intentUri = buildAndroidMpvIntentUri(targetUrl, latestRecord.tabTitle || "");
    if (!options.returnIntentOnly) {
      try {
        if (typeof latestRecord.tabId === "number" && latestRecord.tabId >= 0) {
          await chrome.tabs.update(latestRecord.tabId, { url: intentUri });
        } else {
          await chrome.tabs.create({ url: intentUri, active: true });
        }
      } catch (err) {
        return {
          ok: false,
          statusCode: "ANDROID_INTENT_FAILED",
          errorMessage: `Failed to launch Android Intent: ${err?.message || "Unknown error"}`
        };
      }
    }

    return {
      ok: true,
      statusCode: "ANDROID_INTENT_READY",
      intentUri,
      streamUrl: targetUrl,
      message: "Opening in mpv-android...",
      headerWarning: latestRecord.referer
        ? "Note: mpv-android does not natively support HTTP Referer/User-Agent via Android Intents."
        : null,
      mightBeExpired
    };
  }

  // Masaüstü (macOS): Native Messaging üzerinden com.talha.mpv ile iletişim kur
  const settings = await getSettings();
  const payload = {
    action: "open",
    url: targetUrl,
    referer: sanitizeHeaderValue(latestRecord.referer || ""),
    user_agent: sanitizeHeaderValue(latestRecord.userAgent || ""),
    tab_id: typeof latestRecord.tabId === "number" ? latestRecord.tabId : -1,
    use_ytdlp_fallback: Boolean(options.useYtdlpFallback ?? settings.ytdlpFallback),
    preferred_resolution: String(requestedResolution)
  };

  try {
    const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, payload);
    if (!response || !response.ok) {
      return {
        ok: false,
        statusCode: response?.error_code || "HOST_ERROR",
        errorMessage: response?.error || "mpv could not be started by native host.",
        mightBeExpired
      };
    }

    return {
      ok: true,
      statusCode: "MPV_LAUNCH_REQUESTED",
      message: response.message || "mpv launch requested",
      pid: response.pid || null,
      resolvedVia: response.resolved_via || "direct",
      mightBeExpired
    };
  } catch (err) {
    const rawMsg = err?.message || String(err);
    const isNotInstalled =
      rawMsg.includes("Specified native messaging host not found") ||
      rawMsg.includes("Native host has exited") ||
      rawMsg.includes("Access to the specified native messaging host is forbidden");

    return {
      ok: false,
      statusCode: isNotInstalled ? "NATIVE_HOST_NOT_INSTALLED" : "NATIVE_MESSAGING_ERROR",
      errorMessage: isNotInstalled
        ? `Native host not installed or origin not allowed (${rawMsg}). Run native/install.sh with your Extension ID.`
        : `Native host error: ${rawMsg}`,
      mightBeExpired
    };
  }
}

/**
 * Popup arayüzünden gelen mesajları dinler.
 * Güvenlik: Yalnızca kendi eklenti kimliğimizden (chrome.runtime.id) gelen mesajları kabul et;
 * rastgele web sitelerinden veya dış kaynaklardan gelen mesajları reddet.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, errorMessage: "Unauthorized sender." });
    return false;
  }

  (async () => {
    try {
      switch (message?.type) {
        case "GET_STATE": {
          const allSession = await chrome.storage.session.get(null);
          const settings = await getSettings();
          const tabsData = [];

          for (const [k, val] of Object.entries(allSession)) {
            if (k.startsWith("tab_") && val && Array.isArray(val.streams)) {
              tabsData.push(val);
            }
          }

          sendResponse({
            ok: true,
            settings,
            tabsData
          });
          break;
        }

        case "SET_SETTINGS": {
          const current = await getSettings();
          const next = {
            autoOpen:
              typeof message.autoOpen === "boolean" ? message.autoOpen : current.autoOpen,
            ytdlpFallback:
              typeof message.ytdlpFallback === "boolean"
                ? message.ytdlpFallback
                : current.ytdlpFallback,
            blockedDomains: Array.isArray(message.blockedDomains)
              ? message.blockedDomains
              : current.blockedDomains
          };
          await chrome.storage.local.set(next);
          sendResponse({ ok: true, settings: next });
          break;
        }

        case "OPEN_BEST_IN_TAB": {
          const tabId = message.tabId;
          const stored = await chrome.storage.session.get(`tab_${tabId}`);
          const tabState = stored[`tab_${tabId}`];
          const streams = tabState?.streams || [];
          const returnIntentOnly = Boolean(message.clientHandlesAndroidIntent);

          if (streams.length === 0) {
            // Eğer akış yakalanmadıysa ama kullanıcı yt-dlp fallback ile sayfa URL'sini denemek istiyorsa
            if (message.allowPageFallback && isValidHttpUrl(message.pageUrl)) {
              const res = await openStreamInMpv(
                {
                  url: message.pageUrl,
                  referer: message.pageUrl,
                  userAgent: "",
                  tabId,
                  tabTitle: message.tabTitle || "",
                  streamType: "page_fallback",
                  priority: STREAM_PRIORITY.OTHER_VIDEO
                },
                { useYtdlpFallback: true, returnIntentOnly }
              );
              sendResponse(res);
              return;
            }

            sendResponse({
              ok: false,
              statusCode: "NO_VIDEO_DETECTED",
              errorMessage: "No video detected in the current tab."
            });
            return;
          }

          const best = selectBestPlayableStream(streams);
          if (!best) {
            const firstUnsupported = streams.find((s) => s.streamType === "unsupported");
            sendResponse({
              ok: false,
              statusCode: "UNSUPPORTED_STREAM",
              errorMessage:
                firstUnsupported?.unsupportedReason || "Unsupported stream (DRM protected)."
            });
            return;
          }

          const res = await openStreamInMpv(best, { returnIntentOnly });
          sendResponse(res);
          break;
        }

        case "REGISTER_EXTRACTED_STREAM": {
          const tabId = sender.tab?.id ?? message.tabId;
          const frameId = typeof sender.frameId === "number" ? sender.frameId : 0;
          const streamUrl = message.streamUrl || "";
          const title = message.title || sender.tab?.title || "";
          const referer = sanitizeHeaderValue(
            message.pageUrl || sender.url || sender.tab?.url || ""
          );
          const userAgent = sanitizeHeaderValue(message.userAgent || "");

          if (!isValidHttpUrl(streamUrl)) {
            sendResponse({ ok: false, errorMessage: "Invalid extracted stream URL." });
            return;
          }

          const cleanVariants = {};
          if (message.variantsByHeight && typeof message.variantsByHeight === "object") {
            for (const [k, v] of Object.entries(message.variantsByHeight)) {
              const h = parseInt(String(k), 10);
              if (!Number.isNaN(h) && h >= 144 && h <= 4320 && isValidHttpUrl(v)) {
                cleanVariants[h] = v;
              }
            }
          }
          const heights = Object.keys(cleanVariants)
            .map((k) => parseInt(k, 10))
            .sort((a, b) => b - a);

          const isHls =
            message.format === "HLS" || /\.m3u8(?:$|[/?#])/i.test(streamUrl);
          const hasMultiHeights = heights.length > 0;

          let effectiveStreamUrl = streamUrl;
          if (typeof tabId === "number" && tabId >= 0) {
            await recordStreamCandidate(tabId, {
              url: streamUrl,
              frameId,
              referer,
              userAgent,
              format: isHls ? "HLS" : "MP4",
              streamType: isHls || hasMultiHeights ? "master" : "direct",
              priority:
                isHls || hasMultiHeights
                  ? STREAM_PRIORITY.VERIFIED_HLS_MASTER
                  : STREAM_PRIORITY.DIRECT_MP4,
              quality: hasMultiHeights ? `Up to ${heights[0]}p` : null,
              availableHeights: hasMultiHeights ? heights : undefined,
              variantsByHeight: hasMultiHeights ? cleanVariants : undefined,
              verified: hasMultiHeights,
              needsVerification: isHls && !hasMultiHeights
            });

            const storedTab = await chrome.storage.session.get(`tab_${tabId}`);
            const targetDedupe = computeDedupeKey(streamUrl);
            const matchedEntry = storedTab[`tab_${tabId}`]?.streams?.find(
              (s) =>
                s.dedupeKey === targetDedupe ||
                (Array.isArray(s.aliasUrls) &&
                  (s.aliasUrls.includes(streamUrl) || s.aliasUrls.includes(targetDedupe)))
            );
            if (matchedEntry && isValidHttpUrl(matchedEntry.url)) {
              effectiveStreamUrl = matchedEntry.url;
            }
          }

          const isAndroid = await isAndroidPlatform();
          const streamUrls = { best: effectiveStreamUrl };
          const androidIntents = {};
          if (isAndroid) {
            androidIntents.best = buildAndroidMpvIntentUri(effectiveStreamUrl, title);
            for (const h of heights) {
              const vUrl = cleanVariants[h];
              streamUrls[String(h)] = vUrl;
              androidIntents[String(h)] = buildAndroidMpvIntentUri(vUrl, title);
            }
          } else {
            for (const h of heights) {
              streamUrls[String(h)] = cleanVariants[h];
            }
          }

          sendResponse({
            ok: true,
            isAndroid,
            streamUrl: effectiveStreamUrl,
            heights,
            streamUrls,
            androidIntents,
            intentUri: isAndroid ? androidIntents.best : null
          });
          break;
        }

        case "GET_TAB_LAUNCH_TARGET": {
          const tabId = message.tabId;
          const stored = typeof tabId === "number" ? await chrome.storage.session.get(`tab_${tabId}`) : {};
          const streams = stored[`tab_${tabId}`]?.streams || [];
          const isAndroid = await isAndroidPlatform();
          const settings = await getSettings();
          const tabTitle = message.tabTitle || stored[`tab_${tabId}`]?.pageTitle || "";

          const best = selectBestPlayableStream(streams);
          if (best && isValidHttpUrl(best.url)) {
            sendResponse({
              ok: true,
              isAndroid,
              mode: "stream",
              streamUrl: best.url,
              intentUri: isAndroid ? buildAndroidMpvIntentUri(best.url, tabTitle) : null
            });
            return;
          }

          const pageUrl = message.pageUrl || stored[`tab_${tabId}`]?.pageUrl || "";

          // Android üzerinde mpv-android (is.xyz.mpv) yerel yt-dlp içermediği için ham HTML sayfa
          // adresi gönderilirse uygulama açılıp anında kapanır! YouTube ise content script üzerinden
          // doğrudan gerçek HLS (.m3u8) yayın adresini çıkar.
          if (isAndroid) {
            if (typeof tabId === "number" && tabId >= 0 && typeof chrome.tabs?.sendMessage === "function") {
              try {
                const ytExtracted = await chrome.tabs.sendMessage(tabId, {
                  type: "EXTRACT_YOUTUBE_HLS_ANDROID"
                });
                if (ytExtracted?.ok && isValidHttpUrl(ytExtracted.streamUrl)) {
                  const resolvedTitle = ytExtracted.title || tabTitle;
                  sendResponse({
                    ok: true,
                    isAndroid: true,
                    mode: "youtube_hls",
                    streamUrl: ytExtracted.streamUrl,
                    intentUri: buildAndroidMpvIntentUri(ytExtracted.streamUrl, resolvedTitle)
                  });
                  return;
                }
              } catch {
                // Content script henüz hazır değil veya YouTube sayfası değil
              }
            }

            sendResponse({
              ok: false,
              isAndroid: true,
              statusCode: "NO_STREAM_YET",
              errorMessage: "Play the video in the page first so its .m3u8 / .mp4 stream can be captured."
            });
            return;
          }

          if (settings.ytdlpFallback !== false && isValidHttpUrl(pageUrl)) {
            sendResponse({
              ok: true,
              isAndroid: false,
              mode: "page_fallback",
              streamUrl: pageUrl,
              intentUri: null
            });
            return;
          }

          sendResponse({
            ok: false,
            isAndroid,
            statusCode: "NO_VIDEO_DETECTED",
            errorMessage: "No playable stream detected in this tab yet."
          });
          break;
        }

        case "OPEN_SPECIFIC_STREAM": {
          const { tabId, dedupeKey } = message;
          const stored = await chrome.storage.session.get(`tab_${tabId}`);
          const tabState = stored[`tab_${tabId}`];
          const stream = tabState?.streams?.find((s) => s.dedupeKey === dedupeKey);

          if (!stream) {
            sendResponse({
              ok: false,
              statusCode: "STREAM_EXPIRED",
              errorMessage: "Stream may have expired or tab was refreshed."
            });
            return;
          }

          const res = await openStreamInMpv(stream);
          sendResponse(res);
          break;
        }

        case "OPEN_FROM_VIDEO_OVERLAY": {
          const tabId = sender.tab?.id ?? message.tabId;
          const frameId = typeof sender.frameId === "number" ? sender.frameId : (message.frameId ?? 0);

          if (typeof tabId !== "number" || tabId < 0) {
            sendResponse({
              ok: false,
              statusCode: "NO_ACTIVE_TAB",
              errorMessage: "Could not identify the current browser tab."
            });
            return;
          }

          const stored = await chrome.storage.session.get(`tab_${tabId}`);
          const tabState = stored[`tab_${tabId}`];
          const streams = tabState?.streams || [];
          const settings = await getSettings();

          const matched = matchStreamForVideoContext(streams, {
            frameId,
            currentSrc: message.currentSrc || "",
            src: message.src || "",
            sources: Array.isArray(message.sources) ? message.sources : [],
            videoCountInFrame: typeof message.videoCountInFrame === "number" ? message.videoCountInFrame : 1,
            actionTimestamp: message.actionTimestamp || Date.now(),
            pageUrl: message.pageUrl || sender.tab?.url || ""
          });

          const preferredResolution = message.preferredResolution || "best";
          const returnIntentOnly = Boolean(message.clientHandlesAndroidIntent);

          if (!matched.stream) {
            const isAndroid = await isAndroidPlatform();
            // Android üzerinde mpv-android yerel yt-dlp içermediğinden ham HTML sayfa URL'sini gönderme!
            if (isAndroid) {
              sendResponse({
                ok: false,
                statusCode: matched.reason || "NO_STREAM_YET",
                errorMessage:
                  "Play the video first so its .m3u8 / .mp4 stream URL can be captured."
              });
              return;
            }

            // Masaüstü: doğrudan HLS/MP4 akışı yakalanmadıysa (örneğin YouTube MSE videoplayback parçaları),
            // yt-dlp fallback ile sayfa URL'sini doğrudan mpv'ye gönder
            const candidatePageUrl = message.pageUrl || sender.tab?.url || "";
            if (
              matched.reason === "NO_VIDEO_DETECTED" &&
              settings.ytdlpFallback !== false &&
              isValidHttpUrl(candidatePageUrl)
            ) {
              const res = await openStreamInMpv(
                {
                  url: candidatePageUrl,
                  referer: candidatePageUrl,
                  userAgent: "",
                  tabId,
                  frameId,
                  tabTitle: sender.tab?.title || "",
                  streamType: "page_fallback",
                  priority: STREAM_PRIORITY.OTHER_VIDEO
                },
                { useYtdlpFallback: true, preferredResolution, returnIntentOnly }
              );
              sendResponse(res);
              return;
            }

            sendResponse({
              ok: false,
              statusCode: matched.reason || "NO_VIDEO_DETECTED",
              errorMessage: matched.errorMessage || "No playable stream found for this video."
            });
            return;
          }

          const { heightMap } = buildResolutionMapForTab(streams, frameId, matched.stream);
          const streamToOpen = {
            ...matched.stream,
            variantsByHeight: {
              ...(matched.stream.variantsByHeight || {}),
              ...heightMap
            },
            tabId,
            frameId,
            tabTitle: matched.stream.tabTitle || sender.tab?.title || "",
            referer: matched.stream.referer || message.pageUrl || sender.tab?.url || ""
          };

          const res = await openStreamInMpv(streamToOpen, { preferredResolution, returnIntentOnly });
          sendResponse(res);
          break;
        }

        case "GET_VIDEO_RESOLUTIONS": {
          const tabId = sender.tab?.id ?? message.tabId;
          const frameId = typeof sender.frameId === "number" ? sender.frameId : (message.frameId ?? 0);
          const stored = typeof tabId === "number" ? await chrome.storage.session.get(`tab_${tabId}`) : {};
          const streams = stored[`tab_${tabId}`]?.streams || [];
          const isAndroid = await isAndroidPlatform();
          const tabTitle = sender.tab?.title || "";

          const matched = matchStreamForVideoContext(streams, {
            frameId,
            currentSrc: message.currentSrc || "",
            src: message.src || "",
            sources: Array.isArray(message.sources) ? message.sources : [],
            videoCountInFrame: typeof message.videoCountInFrame === "number" ? message.videoCountInFrame : 1,
            actionTimestamp: message.actionTimestamp || Date.now(),
            pageUrl: message.pageUrl || sender.tab?.url || ""
          });

          if (matched.stream) {
            // En güncel URL'yi al
            const latest =
              streams.find((s) => s.dedupeKey === matched.stream.dedupeKey) || matched.stream;
            const { heights, heightMap } = buildResolutionMapForTab(streams, frameId, latest);

            const androidIntents = {};
            const streamUrls = {};
            if (isAndroid && isValidHttpUrl(latest.url)) {
              streamUrls.best = latest.url;
              androidIntents.best = buildAndroidMpvIntentUri(latest.url, tabTitle);
              for (const h of heights) {
                const vUrl = heightMap[h];
                if (isValidHttpUrl(vUrl)) {
                  streamUrls[String(h)] = vUrl;
                  androidIntents[String(h)] = buildAndroidMpvIntentUri(vUrl, tabTitle);
                }
              }
            }

            if (heights.length > 0) {
              sendResponse({
                ok: true,
                isAndroid,
                mode: "hls_master",
                heights,
                androidIntents,
                streamUrls
              });
              return;
            }
            sendResponse({
              ok: true,
              isAndroid,
              mode: "direct",
              heights: [],
              androidIntents,
              streamUrls
            });
            return;
          }

          // Doğrudan akış yoksa (örn. YouTube MSE veya henüz oynatılmamış video)
          if (isAndroid) {
            sendResponse({
              ok: true,
              isAndroid: true,
              mode: "android_no_stream",
              heights: [],
              androidIntents: {},
              streamUrls: {}
            });
            return;
          }

          sendResponse({
            ok: true,
            isAndroid: false,
            mode: "ytdl",
            heights: [2160, 1440, 1080, 720, 480, 360]
          });
          break;
        }

        case "CHECK_HOST_STATUS": {
          const isAndroid = await isAndroidPlatform();
          if (isAndroid) {
            sendResponse({
              ok: true,
              platform: "android",
              hostInstalled: true,
              mpvAvailable: true
            });
            return;
          }

          try {
            const resp = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: "ping" });
            sendResponse({
              ok: true,
              platform: "mac",
              hostInstalled: Boolean(resp?.ok),
              mpvAvailable: Boolean(resp?.mpv_available),
              extensionId: chrome.runtime.id
            });
          } catch (err) {
            sendResponse({
              ok: true,
              platform: "mac",
              hostInstalled: false,
              mpvAvailable: false,
              extensionId: chrome.runtime.id,
              errorMessage: err?.message || "Native host not connected"
            });
          }
          break;
        }

        case "CLEAR_STREAMS": {
          const targetTabId = message.tabId;
          await withSessionLock(async () => {
            if (typeof targetTabId === "number") {
              await chrome.storage.session.remove(`tab_${targetTabId}`);
              await updateTabBadge(targetTabId, []);
            } else {
              const all = await chrome.storage.session.get(null);
              const keysToRemove = Object.keys(all).filter((k) => k.startsWith("tab_"));
              if (keysToRemove.length > 0) {
                await chrome.storage.session.remove(keysToRemove);
              }
              const tabs = await chrome.tabs.query({});
              for (const t of tabs) {
                if (typeof t.id === "number") {
                  await updateTabBadge(t.id, []);
                }
              }
            }
          });
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, errorMessage: "Unknown message type." });
      }
    } catch (err) {
      sendResponse({
        ok: false,
        errorMessage: err?.message || "Unexpected background error."
      });
    }
  })();

  return true;
});

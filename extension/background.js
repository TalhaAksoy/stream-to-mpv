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
  isMediaSegment,
  googleDriveDirectUrl,
  classifySubtitleUrl,
  sortSubtitlesByPreference,
  isValidHttpUrl,
  matchStreamForVideoContext,
  selectBestPlayableStream,
  sortStreams
} from "./stream_utils.js";

const NATIVE_HOST_NAME = "com.talha.mpv";
const MAX_STREAMS_PER_TAB = 25;
const MAX_PENDING_REQUESTS = 300;

// onSendHeaders → onHeadersReceived arasında istek başlıklarını (Referer/UA, yönlendirme takma adları) taşıyan
// kısa ömürlü tablo. Her istekte storage.session'a yazmak tüm istekleri tek kilitte sıraya sokuyordu; bellekte
// tutulur. Service worker iki olay arasında kapanırsa kayıt kaybolur ve initiator yedeğine düşülür.
const pendingRequests = new Map();
// 1.2.1 öncesi sürümler bu tabloyu storage.session'da tutuyordu; kalıntıyı bir kez temizle
chrome.storage.session?.remove?.("pendingRequests")?.catch?.(() => {});

function rememberPendingRequest(requestId, meta) {
  pendingRequests.delete(requestId); // ekleme sırasını tazele
  pendingRequests.set(requestId, meta);
  while (pendingRequests.size > MAX_PENDING_REQUESTS) {
    pendingRequests.delete(pendingRequests.keys().next().value);
  }
}
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
 * webRequest dinleyicisini Chromium'da "extraHeaders" ile (Referer/Origin görünür olsun diye) kaydeder.
 * Firefox bu seçeneği tanımaz ve addListener hata fırlatır; bu durumda seçeneksiz kaydeder.
 */
function addWebRequestListener(event, listener, filter, extraInfoSpec) {
  try {
    event.addListener(listener, filter, [...extraInfoSpec, "extraHeaders"]);
  } catch {
    event.addListener(listener, filter, extraInfoSpec);
  }
}

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
// Masaüstü native host'un başlatabildiği oynatıcılar (host tarafında da izin listesiyle doğrulanır)
const DESKTOP_PLAYERS = ["mpv", "vlc"];

// Android'de intent ile açılabilecek oynatıcılar. "chooser": paket belirtilmez, Android uygulama seçiciyi gösterir.
const ANDROID_PLAYERS = {
  mpv: { pkg: "is.xyz.mpv", label: "mpv" },
  vlc: { pkg: "org.videolan.vlc", label: "VLC" },
  mx: { pkg: "com.mxtech.videoplayer.ad", label: "MX Player" },
  mxpro: { pkg: "com.mxtech.videoplayer.pro", label: "MX Player Pro" },
  just: { pkg: "com.brouken.player", label: "Just Player" },
  chooser: { pkg: "", label: "Choose app" }
};

const SETTINGS_KEYS = ["autoOpen", "ytdlpFallback", "blockedDomains", "extraBlockedDomains", "player", "androidPlayer"];
const MAX_EXTRA_BLOCKED_DOMAINS = 50;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/**
 * Kullanıcının eklediği "akış yakalanmayacak" alan adlarını temizler: küçük harf, şema/yol/port/"*." atılır,
 * geçersizler ve yinelenenler elenir. Varsayılan reklam listesi ayrı tutulur; kullanıcı onu silemez.
 */
function sanitizeBlockedDomains(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    let d = raw.trim().toLowerCase();
    d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "");
    d = d.replace(/^\*?\./, "").replace(/\.$/, "");
    if (!DOMAIN_RE.test(d) || out.includes(d)) continue;
    out.push(d);
    if (out.length >= MAX_EXTRA_BLOCKED_DOMAINS) break;
  }
  return out;
}
let settingsCache = null;

function normalizeSettings(data = {}) {
  return {
    autoOpen: Boolean(data.autoOpen ?? false), // Varsayılan olarak kesinlikle kapalı
    // YouTube/Twitch/Vimeo vb. sitelerde tek tıklamayla çalışması için varsayılan açık
    ytdlpFallback: Boolean(data.ytdlpFallback ?? true),
    extraBlockedDomains: sanitizeBlockedDomains(data.extraBlockedDomains),
    // Etkin liste = varsayılan reklam alanları + eski sürümlerin sakladığı liste + kullanıcının eklediği alanlar
    blockedDomains: Array.from(
      new Set([
        ...DEFAULT_BLOCKED_DOMAINS,
        ...sanitizeBlockedDomains(data.blockedDomains),
        ...sanitizeBlockedDomains(data.extraBlockedDomains)
      ])
    ),
    player: DESKTOP_PLAYERS.includes(data.player) ? data.player : "mpv",
    androidPlayer: Object.hasOwn(ANDROID_PLAYERS, data.androidPlayer || "") ? data.androidPlayer : "mpv"
  };
}

/**
 * Kalıcı kullanıcı ayarlarını chrome.storage.local'dan okur.
 * Her ağ isteğinde storage okumamak için bellekte önbelleklenir; storage.onChanged ile geçersiz kılınır.
 */
async function getSettings() {
  if (settingsCache) return settingsCache;
  try {
    const data = await chrome.storage.local.get(SETTINGS_KEYS);
    settingsCache = normalizeSettings(data);
    return settingsCache;
  } catch {
    return normalizeSettings();
  }
}

chrome.storage.onChanged?.addListener((_changes, areaName) => {
  if (areaName === "local") settingsCache = null;
});

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
        current.variantsArePlaylists = true;
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
    if (!resetTabStateIfPageChanged(tabState, pageUrl, pageTitle)) {
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

      if (typeof candidateData.variantsArePlaylists === "boolean") {
        existing.variantsArePlaylists = candidateData.variantsArePlaylists;
      }
      if (candidateData.verifiedInPage) existing.verifiedInPage = true;

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
        variantsArePlaylists: Boolean(candidateData.variantsArePlaylists),
        verifiedInPage: Boolean(candidateData.verifiedInPage),
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
/**
 * Sekmenin sayfası değiştiyse (SPA geçişi veya kaçırılmış onUpdated) önceki videoya ait her şeyi (akışlar,
 * altyazılar, doğrulama adayları) sıfırlar. Hangi kayıt önce gelirse (akış, altyazı, aday) sıfırlamayı o yapar;
 * böylece yeni bölümün erken gelen altyazısı sonradan gelen akış kaydıyla silinmez. Sıfırlandıysa true döner.
 */
function resetTabStateIfPageChanged(tabState, pageUrl, pageTitle) {
  if (!pageUrl || !tabState.pageUrl || getPageIdentity(pageUrl) === getPageIdentity(tabState.pageUrl)) {
    return false;
  }
  tabState.pageUrl = pageUrl;
  if (pageTitle) tabState.pageTitle = pageTitle;
  tabState.sessionId = `${tabState.tabId}_${Date.now()}`;
  tabState.autoOpenedSessionId = null;
  tabState.streams = [];
  tabState.subtitles = [];
  tabState.probeCandidates = [];
  return true;
}

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

// Akış taşıyamayacak istek türleri: bunlar için depolama yazımı / sınıflandırma yapılmaz (performans).
// Not: HLS playlist'leri XHR/fetch ile geldiği için "xmlhttprequest" bilerek listede DEĞİLDİR.
const IRRELEVANT_REQUEST_TYPES = new Set([
  "image",
  "imageset",
  "stylesheet",
  "font",
  "script",
  "ping",
  "beacon",
  "csp_report",
  "websocket",
  "web_manifest",
  "speculative",
  "xslt",
  "xml_dtd"
]);

/**
 * İsteğin akış adayı olabilecek (sekmeye ait, http(s), alakalı türde) bir istek olup olmadığını hızlıca kontrol eder.
 */
function isRelevantRequest(details) {
  if (typeof details.tabId !== "number" || details.tabId < 0) return false;
  if (details.type && IRRELEVANT_REQUEST_TYPES.has(details.type)) return false;
  return isValidHttpUrl(details.url);
}

// Uzantısı / MIME türü belirsiz XHR yanıtları (örn. application/octet-stream olarak sunulan /w/<token> HLS
// playlist'leri). Arka plan gövdeyi göremediği için bunlar yalnızca "aday" olarak tutulur; butona basıldığında
// içerik betiği aynı frame içinden yeniden çekip #EXTM3U imzasını doğrular.
const AMBIGUOUS_PLAYLIST_MIMES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
  "text/plain",
  "application/force-download",
  "application/unknown"
]);
const MAX_PROBE_CANDIDATES_PER_TAB = 20;
// Yeniden çekilmesi yan etki doğurabilecek API uçları (örn. /api/watch/<id> her çağrıda yeni token üretir)
const NON_PLAYLIST_PATH_RE = /\/(?:api|ajax|graphql|log|stats|ping|analytics|collect|track|auth)(?:\/|$)/i;

/**
 * Belirsiz bir XHR yanıtını, butona basıldığında doğrulanmak üzere sekmenin aday listesine ekler.
 */
async function recordProbeCandidate(tabId, candidate) {
  let tabInfo = null;
  try {
    tabInfo = await chrome.tabs.get(tabId);
  } catch {
    return; // Sekme mevcut değil
  }
  await withSessionLock(async () => {
    const key = `tab_${tabId}`;
    const stored = await chrome.storage.session.get(key);
    // Sekme durumu henüz oluşmadıysa (onUpdated'dan önce gelen XHR) burada oluştur; aday kaybolmasın
    const tabState = stored[key] || {
      tabId,
      pageUrl: tabInfo?.url || "",
      pageTitle: tabInfo?.title || "",
      sessionId: `${tabId}_${Date.now()}`,
      autoOpenedSessionId: null,
      streams: []
    };
    resetTabStateIfPageChanged(tabState, tabInfo?.url || "", tabInfo?.title || "");
    const list = Array.isArray(tabState.probeCandidates) ? tabState.probeCandidates : [];
    const filtered = list.filter((c) => c.url !== candidate.url);
    filtered.unshift(candidate);
    tabState.probeCandidates = filtered.slice(0, MAX_PROBE_CANDIDATES_PER_TAB);
    await chrome.storage.session.set({ [key]: tabState });
  });
}

const MAX_SUBTITLES_PER_TAB = 24;
const MAX_SUBTITLES_PER_OPEN = 8;

async function recordSubtitleCandidate(details, info) {
  let tabInfo = null;
  try {
    tabInfo = await chrome.tabs.get(details.tabId);
  } catch {
    return;
  }
  let referer = "";
  for (const h of details.requestHeaders || []) {
    if ((h.name || "").toLowerCase() === "referer") referer = sanitizeHeaderValue(h.value);
  }
  if (!referer && details.initiator && isValidHttpUrl(details.initiator)) {
    referer = sanitizeHeaderValue(`${details.initiator}/`);
  }
  await withSessionLock(async () => {
    const key = `tab_${details.tabId}`;
    const stored = await chrome.storage.session.get(key);
    const tabState = stored[key] || {
      tabId: details.tabId,
      pageUrl: tabInfo?.url || "",
      pageTitle: tabInfo?.title || "",
      sessionId: `${details.tabId}_${Date.now()}`,
      autoOpenedSessionId: null,
      streams: []
    };
    resetTabStateIfPageChanged(tabState, tabInfo?.url || "", tabInfo?.title || "");
    const list = Array.isArray(tabState.subtitles) ? tabState.subtitles : [];
    if (list.some((s) => s.url === details.url)) return;
    list.push({
      url: details.url,
      frameId: typeof details.frameId === "number" ? details.frameId : 0,
      lang: info.lang || "",
      referer,
      timestamp: Date.now()
    });
    tabState.subtitles = list.slice(-MAX_SUBTITLES_PER_TAB);
    await chrome.storage.session.set({ [key]: tabState });
  });
}

/** Bir iframe yeni belgeye geçerken o frame'e ait eski altyazıları siler (yalnızca gerçekten varsa yazar). */
async function dropFrameSubtitles(tabId, frameId) {
  await withSessionLock(async () => {
    const key = `tab_${tabId}`;
    const stored = await chrome.storage.session.get(key);
    const tabState = stored[key];
    const list = Array.isArray(tabState?.subtitles) ? tabState.subtitles : [];
    const kept = list.filter((s) => s.frameId !== frameId);
    if (kept.length === list.length) return;
    tabState.subtitles = kept;
    await chrome.storage.session.set({ [key]: tabState });
  });
}

/** Açılan akışın frame'inde yakalanan altyazılar, tercih sırasıyla (tarayıcı dili, İngilizce, diğerleri). */
function selectSubtitlesForStream(tabState, record) {
  const all = Array.isArray(tabState?.subtitles) ? tabState.subtitles : [];
  const frameId = typeof record?.frameId === "number" ? record.frameId : 0;
  const inFrame = all.filter((s) => s.frameId === frameId && isValidHttpUrl(s.url));
  let uiLanguage = "";
  try {
    uiLanguage = chrome.i18n?.getUILanguage?.() || "";
  } catch {
    uiLanguage = "";
  }
  return sortSubtitlesByPreference(inFrame, uiLanguage).slice(0, MAX_SUBTITLES_PER_OPEN);
}

// Drive videoplayback istekleri saniyede birkaç kez tekrarlanır; aynı frame/dosya için tek kayıt yeterli.
const recordedDriveStreams = new Set();

async function recordGoogleDriveStream(details, directUrl) {
  const frameId = typeof details.frameId === "number" ? details.frameId : 0;
  const key = `${details.tabId}:${frameId}:${directUrl}`;
  if (recordedDriveStreams.has(key)) return;
  recordedDriveStreams.add(key);
  if (recordedDriveStreams.size > 200) recordedDriveStreams.clear();
  await recordStreamCandidate(details.tabId, {
    url: directUrl,
    frameId,
    referer: "",
    userAgent: "",
    format: "MP4",
    streamType: "direct",
    priority: STREAM_PRIORITY.DIRECT_MP4,
    quality: "Original",
    verified: true,
    needsVerification: false
  });
}

/**
 * webRequest.onSendHeaders: İstek URL'sini, Referer ve User-Agent başlıklarını requestId ile yakalar.
 */
addWebRequestListener(
  chrome.webRequest.onSendHeaders,
  async (details) => {
    if (!isRelevantRequest(details)) return;
    // Google Drive önizlemesi: çereze bağlı MSE parçaları yerine dosyanın çerezsiz doğrudan adresi kaydedilir
    // (video iç içe youtube.googleapis.com iframe'inde oynar; kayıt o frame'e yapılır).
    const driveDirect = googleDriveDirectUrl(details.url);
    if (driveDirect) {
      await recordGoogleDriveStream(details, driveDirect);
      return;
    }
    // Oynatıcının çektiği harici altyazı dosyaları (.vtt/.srt/.ass). Segment filtresinden önce: .vtt/.srt orada
    // HLS altyazı parçası sayılıp atlanır.
    const subtitleInfo = classifySubtitleUrl(details.url);
    if (subtitleInfo) {
      await recordSubtitleCandidate(details, subtitleInfo);
      return;
    }
    // Video/ses segmentleri (.ts, .m4s, .jpeg kılıklı HLS parçaları vb.) her saniye onlarca istek üretir;
    // bunlar için depolama kilidine girmeden erken çık.
    if (isMediaSegment(details.url)) return;

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

    // onHeadersReceived için başlıkları sakla (await'ten önce, eşzamanlı: yanıt olayıyla yarışmasın)
    const prevMeta = pendingRequests.get(details.requestId);
    const existingAliases = Array.isArray(prevMeta?.aliasUrls) ? prevMeta.aliasUrls : [];
    rememberPendingRequest(details.requestId, {
      url: details.url,
      tabId: details.tabId,
      frameId: typeof details.frameId === "number" ? details.frameId : (prevMeta?.frameId ?? 0),
      referer: referer || prevMeta?.referer || "",
      userAgent: userAgent || prevMeta?.userAgent || "",
      aliasUrls: existingAliases
    });

    // Gömülü oynatıcı iframe'i yeni bir sayfaya geçiyor (bölüm/sunucu değişimi): üst sayfa adresi aynı kalsa da
    // o frame'de yakalanmış eski altyazılar artık başka bir videoya ait.
    if (details.type === "sub_frame" && typeof details.frameId === "number") {
      await dropFrameSubtitles(details.tabId, details.frameId);
    }

    const settings = await getSettings();
    if (isBlockedDomain(details.url, settings.blockedDomains)) {
      pendingRequests.delete(details.requestId);
      return;
    }

    // URL üzerinden doğrudan sınıflandırma yapılabiliyorsa kaydet
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
  ["requestHeaders"]
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

    const prevMeta = pendingRequests.get(details.requestId);
    const nextAliases = Array.from(new Set([...(prevMeta?.aliasUrls || []), details.url, fromDedupe]));
    rememberPendingRequest(details.requestId, {
      url: details.redirectUrl,
      tabId: details.tabId,
      frameId: typeof details.frameId === "number" ? details.frameId : (prevMeta?.frameId ?? 0),
      referer: prevMeta?.referer || sanitizeHeaderValue(details.initiator || ""),
      userAgent: prevMeta?.userAgent || "",
      aliasUrls: nextAliases
    });

    await withSessionLock(async () => {
      const tabKey = `tab_${details.tabId}`;
      const storedTab = await chrome.storage.session.get(tabKey);

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
          await chrome.storage.session.set({ [tabKey]: tabState });
        }
      }
    });
  },
  { urls: ["http://*/*", "https://*/*"] }
);

/**
 * webRequest.onHeadersReceived: Response Content-Type ve Content-Length başlıklarını okur,
 * requestId üzerinden onSendHeaders ile ilişkilendirir.
 */
addWebRequestListener(
  chrome.webRequest.onHeadersReceived,
  async (details) => {
    if (!isRelevantRequest(details)) return;
    if (isMediaSegment(details.url)) return;

    // 3xx yönlendirme yanıtlarında pending kaydını silme; onBeforeRedirect hedef CDN adresini devralacak
    if (typeof details.statusCode === "number" && details.statusCode >= 300 && details.statusCode < 400) {
      return;
    }

    const reqMeta = pendingRequests.get(details.requestId) || null;
    pendingRequests.delete(details.requestId);

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
          // Yalnızca URL uzantısından tahmin edilmiş, doğrulanmamış doğrudan dosya (MP4/WebM) kayıtlarını sil.
          // Sayfa içinde doğrulanmış / kaydedilmiş HLS playlist'leri (örn. 218 baytlık /w/<token> master)
          // küçük oldukları için silinmemeli.
          tabState.streams = tabState.streams.filter(
            (s) => !(s.dedupeKey === rejectedDedupe && !s.verified && s.format !== "HLS")
          );
          if (tabState.streams.length !== beforeLen) {
            await chrome.storage.session.set({ [tabKey]: tabState });
            await updateTabBadge(details.tabId, tabState.streams);
          }
        });
      }

      // Uzantısız ve MIME türü belirsiz XHR yanıtı: gizlenmiş bir HLS playlist'i olabilir (örn. /w/<token>,
      // application/octet-stream). Gövde burada görülemediği için yalnızca doğrulama adayı olarak sakla.
      const lowerMime = (contentType || "").toLowerCase().split(";")[0].trim();
      const statusOk = details.statusCode === 200 || details.statusCode === 206 || details.statusCode === undefined;
      if (
        details.type === "xmlhttprequest" &&
        statusOk &&
        !NON_PLAYLIST_PATH_RE.test(new URL(details.url).pathname) &&
        AMBIGUOUS_PLAYLIST_MIMES.has(lowerMime) &&
        (contentLength === null || contentLength <= 2 * 1024 * 1024)
      ) {
        await recordProbeCandidate(details.tabId, {
          url: details.url,
          frameId: typeof details.frameId === "number" ? details.frameId : reqMeta?.frameId ?? 0,
          referer: reqMeta?.referer || sanitizeHeaderValue(details.initiator || ""),
          userAgent: reqMeta?.userAgent || "",
          mime: lowerMime,
          at: Date.now()
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
  ["responseHeaders"]
);

/**
 * İstek hata ile biterse pending tablosundan temizle.
 */
chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    pendingRequests.delete(details.requestId);
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
function buildAndroidMpvIntentUri(
  streamUrl,
  title = "",
  playerKey = settingsCache?.androidPlayer || "mpv",
  mimeType = "video/*"
) {
  const parsed = new URL(streamUrl);
  const scheme = parsed.protocol.replace(":", "");
  const cleanHostAndPath = `${parsed.host}${parsed.pathname}${parsed.search}`;
  const pkg = (ANDROID_PLAYERS[playerKey] || ANDROID_PLAYERS.mpv).pkg;

  const parts = [`intent://${cleanHostAndPath}#Intent`, `scheme=${scheme}`];
  // "chooser" seçiliyse paket belirtilmez; Android video/* işleyebilen uygulamaları listeler.
  if (pkg) parts.push(`package=${pkg}`);
  parts.push(`action=android.intent.action.VIEW`, `type=${mimeType}`);

  const cleanTitle = sanitizeHeaderValue(title);
  if (cleanTitle) {
    parts.push(`S.title=${encodeURIComponent(cleanTitle.slice(0, 120))}`);
  }

  parts.push("end");
  return `${parts.join(";")};`;
}

/**
 * Uzantısı .m3u8 olmayan (örn. /w/<token>) HLS akışı mı? FFmpeg 7.1+ bunları uzantı/MIME kontrolü yüzünden
 * kendiliğinden HLS olarak açmaz; mpv-android'e intent ile demuxer seçeneği iletilemediği için VLC önerilir.
 */
function isDisguisedHls(record) {
  if (!record || record.format !== "HLS" || !record.verifiedInPage) return false;
  try {
    const p = new URL(record.url).pathname.toLowerCase();
    return !(p.endsWith(".m3u8") || p.endsWith(".m3u"));
  } catch {
    return false;
  }
}

/**
 * Açılacak URL'nin kendisi bir HLS playlist'i mi? Kaydın kendi URL'si (HLS formatındaysa) ya da doğrulanmış bir
 * master'dan çıkarılmış variant olmalı. OK.ru / VK'nın MP4 çözünürlük dosyalarında HLS demuxer'ı zorlanmamalı.
 */
function isOpeningPlaylist(record, targetUrl) {
  if (!record || record.format !== "HLS") return false;
  if (targetUrl === record.url) return true;
  return Boolean(
    record.variantsArePlaylists &&
      record.variantsByHeight &&
      Object.values(record.variantsByHeight).includes(targetUrl)
  );
}

/**
 * Android menüsünde seçili oynatıcıya ek olarak sunulan alternatif intent'ler (VLC ve uygulama seçici).
 */
function buildAndroidAltIntents(streamUrl, title, disguisedHls = false) {
  if (!isValidHttpUrl(streamUrl)) return {};
  // Uzantısız HLS'de seçici HLS MIME tipiyle açılır; intent filtresi eşleşmesi büyük/küçük harfe duyarlıdır.
  // Emülatörde: "application/x-mpegURL" yalnızca VLC'yi listeler (açabiliyor). "application/vnd.apple.mpegurl"
  // ise MX Player ve VLC'nin yanında bu akışı açamayan mpv-android ve Google Photos'u da listeler. Seçicinin amacı
  // yalnızca açabilen uygulamaları göstermek; MX kullanıcıları menüde "Open in MX Player"ı zaten görür.
  const chooserMime = disguisedHls ? "application/x-mpegURL" : "video/*";
  const alt = { chooser: buildAndroidMpvIntentUri(streamUrl, title, "chooser", chooserMime) };
  if ((settingsCache?.androidPlayer || "mpv") !== "vlc") {
    alt.vlc = buildAndroidMpvIntentUri(streamUrl, title, "vlc");
  }
  return alt;
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
  let subtitles = [];
  if (typeof streamRecord.tabId === "number") {
    const stored = await chrome.storage.session.get(`tab_${streamRecord.tabId}`);
    const tabState = stored[`tab_${streamRecord.tabId}`];
    if (tabState && Array.isArray(tabState.streams)) {
      const found = tabState.streams.find((s) => s.dedupeKey === streamRecord.dedupeKey);
      if (found) latestRecord = found;
    }
    subtitles = selectSubtitlesForStream(tabState, { frameId: streamRecord.frameId ?? latestRecord.frameId });
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

  const settings = await getSettings();
  const isAndroid = await isAndroidPlatform();
  if (isAndroid) {
    // Android üzerinde doğrudan sayfa içi kullanıcı tıklamasıyla (user gesture) açılabilmesi için
    // intentUri'yi yanıt içinde döndür; eğer popup'tan veya otomatik açmadan çağrıldıysa tabs.update/create dene.
    const intentUri = buildAndroidMpvIntentUri(targetUrl, latestRecord.tabTitle || "", settings.androidPlayer);
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
      message: `Opening in ${(ANDROID_PLAYERS[settings.androidPlayer] || ANDROID_PLAYERS.mpv).label}...`,
      headerWarning: latestRecord.referer
        ? "Note: Android players cannot receive HTTP Referer/User-Agent via Android Intents."
        : null,
      mightBeExpired
    };
  }

  // Masaüstü (macOS / Linux): Native Messaging üzerinden com.talha.mpv ile iletişim kur.
  // kind: yakalanmış gerçek akış ("stream") ile yt-dlp'nin çözmesi gereken sayfa URL'sini ("page") ayırır;
  // böylece uzantısız HLS akışları (örn. /w/<token>) Referer/User-Agent başlıklarını kaybetmez.
  const isPageFallback = latestRecord.streamType === "page_fallback";
  const player = DESKTOP_PLAYERS.includes(options.player) ? options.player : settings.player;
  const payload = {
    action: "open",
    kind: isPageFallback ? "page" : "stream",
    player,
    url: targetUrl,
    referer: sanitizeHeaderValue(latestRecord.referer || ""),
    user_agent: sanitizeHeaderValue(latestRecord.userAgent || ""),
    title: sanitizeHeaderValue(latestRecord.tabTitle || "").slice(0, 200),
    tab_id: typeof latestRecord.tabId === "number" ? latestRecord.tabId : -1,
    use_ytdlp_fallback: isPageFallback && Boolean(options.useYtdlpFallback ?? settings.ytdlpFallback),
    // Doğrulanmış HLS (uzantısız /w/<token> dahil) -> host mpv'de HLS demuxer'ını zorlayabilsin
    stream_format: !isPageFallback && isOpeningPlaylist(latestRecord, targetUrl) ? "hls" : "",
    preferred_resolution: String(requestedResolution),
    // Oynatıcının yüklediği harici altyazılar (ilk eleman tercih edilen dil); host mpv/VLC'ye ekler
    subtitles: isPageFallback ? [] : subtitles.map((s) => ({ url: s.url, lang: s.lang || "" }))
  };

  if (!(await hasNativeMessagingPermission())) {
    return { ...NATIVE_PERMISSION_ERROR, mightBeExpired };
  }

  try {
    // mpv dışındaki bir oynatıcı seçiliyse, eski bir ~/mpv_host kopyası "player" alanını yok sayıp sessizce
    // mpv açmasın diye host sürümünü önce doğrula.
    if (player !== "mpv") {
      const hostInfo = await getNativeHostInfo();
      if (hostInfo && !hostInfo.host_version) {
        return {
          ok: false,
          statusCode: "NATIVE_HOST_OUTDATED",
          errorMessage: `The installed native host is outdated and cannot launch ${player}. Run 'make' in the stream-to-mpv folder again.`,
          mightBeExpired
        };
      }
      if (hostInfo?.players && hostInfo.players[player] === false) {
        return {
          ok: false,
          statusCode: `${player.toUpperCase()}_NOT_INSTALLED`,
          errorMessage: `${player === "vlc" ? "VLC" : player} is not installed on this computer.`,
          mightBeExpired
        };
      }
    }

    const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, payload);
    if (!response || !response.ok) {
      return {
        ok: false,
        statusCode: response?.error_code || "HOST_ERROR",
        errorMessage: response?.error || `${player} could not be started by native host.`,
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
        ? `Native host not installed or origin not allowed (${rawMsg}). Run 'make' in the stream-to-mpv folder to install the native host.`
        : `Native host error: ${rawMsg}`,
      mightBeExpired
    };
  }
}

/**
 * Firefox paketinde "nativeMessaging" isteğe bağlı izindir (Firefox for Android bu izni ayrıcalıklı sayar ve
 * zorunlu olarak istenirse eklentiyi hiç yüklemez). Masaüstü Firefox'ta kullanıcı popup'tan bir kez izin verir.
 */
async function hasNativeMessagingPermission() {
  if (typeof chrome.runtime.sendNativeMessage === "function") {
    try {
      if (chrome.permissions?.contains) {
        return await chrome.permissions.contains({ permissions: ["nativeMessaging"] });
      }
    } catch {
      // Bazı tarayıcılar bu sorguyu desteklemeyebilir; API mevcutsa izin var kabul et
    }
    return true;
  }
  return false;
}

const NATIVE_PERMISSION_ERROR = {
  ok: false,
  statusCode: "NATIVE_PERMISSION_REQUIRED",
  errorMessage:
    "Desktop player access is not allowed yet. Click the Stream to mpv toolbar icon and press 'Allow desktop player'."
};

// Native host ping sonucunu kısa süre önbellekle (her açılışta ayrı python süreci başlatmamak için)
let nativeHostInfoCache = null;
async function getNativeHostInfo({ force = false } = {}) {
  if (!(await hasNativeMessagingPermission())) {
    throw new Error("NATIVE_PERMISSION_REQUIRED");
  }
  if (!force && nativeHostInfoCache && Date.now() - nativeHostInfoCache.at < 60 * 1000) {
    return nativeHostInfoCache.info;
  }
  try {
    const info = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: "ping" });
    nativeHostInfoCache = { at: Date.now(), info };
    return info;
  } catch (err) {
    nativeHostInfoCache = null;
    throw err;
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
      // Android intent üretimi oynatıcı seçimine bağlı olduğundan ayarların önbelleğe alındığından emin ol
      await getSettings();
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
            extraBlockedDomains: Array.isArray(message.extraBlockedDomains)
              ? sanitizeBlockedDomains(message.extraBlockedDomains)
              : current.extraBlockedDomains,
            player: DESKTOP_PLAYERS.includes(message.player) ? message.player : current.player,
            androidPlayer: Object.hasOwn(ANDROID_PLAYERS, message.androidPlayer || "")
              ? message.androidPlayer
              : current.androidPlayer
          };
          await chrome.storage.local.set(next);
          settingsCache = normalizeSettings(next);
          sendResponse({ ok: true, settings: settingsCache });
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

          // İçerik betiği gizlenmiş bir playlist'i (#EXTM3U) sayfa bağlamında doğruladıysa metnini gönderir;
          // master/variant/DRM ayrımı ve çözünürlük haritası burada stream_utils ile yeniden hesaplanır.
          let playlistInfo = null;
          if (typeof message.playlistText === "string" && message.playlistText.length <= 256 * 1024) {
            playlistInfo = inspectHlsPlaylistContent(message.playlistText, null, streamUrl);
            if (playlistInfo?.streamType === "unsupported") {
              sendResponse({
                ok: false,
                statusCode: "UNSUPPORTED_STREAM",
                errorMessage: playlistInfo.unsupportedReason || "Unsupported DRM stream."
              });
              return;
            }
          }

          const cleanVariants = {};
          const rawVariants =
            message.variantsByHeight && typeof message.variantsByHeight === "object" &&
            Object.keys(message.variantsByHeight).length > 0
              ? message.variantsByHeight
              : playlistInfo?.variantsByHeight || null;
          if (rawVariants) {
            for (const [k, v] of Object.entries(rawVariants)) {
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
            Boolean(playlistInfo) || message.format === "HLS" || /\.m3u8(?:$|[/?#])/i.test(streamUrl);
          const hasMultiHeights = heights.length > 0;
          const verifiedInPage = Boolean(playlistInfo);

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
              quality: hasMultiHeights ? `Up to ${heights[0]}p` : playlistInfo?.quality || null,
              availableHeights: hasMultiHeights ? heights : undefined,
              variantsByHeight: hasMultiHeights ? cleanVariants : undefined,
              // Variant'lar ancak sayfa içinde doğrulanmış bir master'dan çıkarıldıysa HLS playlist'tir;
              // OK.ru / VK gibi sağlayıcıların çözünürlük haritası doğrudan MP4 dosyalarıdır.
              variantsArePlaylists: hasMultiHeights && Boolean(playlistInfo?.variantsByHeight) && rawVariants === playlistInfo.variantsByHeight,
              verifiedInPage,
              verified: hasMultiHeights || verifiedInPage,
              // Sayfa içinde doğrulanan (token'lı) playlist'leri arka planda çerezsiz/Referer'sız yeniden çekme
              needsVerification: isHls && !hasMultiHeights && !verifiedInPage
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

          const registeredDisguised = isDisguisedHls({ url: effectiveStreamUrl, format: isHls ? "HLS" : "MP4", verifiedInPage });
          sendResponse({
            ok: true,
            isAndroid,
            streamUrl: effectiveStreamUrl,
            heights,
            streamUrls,
            androidIntents,
            altIntents: isAndroid ? buildAndroidAltIntents(effectiveStreamUrl, title, registeredDisguised) : {},
            disguisedHls: registeredDisguised,
            androidPlayer: settingsCache?.androidPlayer || "mpv",
            intentUri: isAndroid ? androidIntents.best : null
          });
          break;
        }

        case "GET_PROBE_CANDIDATES": {
          // Butona basılan frame'de yakalanmış, MIME türü belirsiz XHR yanıtları (gizlenmiş playlist adayları)
          const tabId = sender.tab?.id;
          const frameId = typeof sender.frameId === "number" ? sender.frameId : 0;
          if (typeof tabId !== "number" || tabId < 0) {
            sendResponse({ ok: true, candidates: [] });
            return;
          }
          const stored = await chrome.storage.session.get(`tab_${tabId}`);
          const list = stored[`tab_${tabId}`]?.probeCandidates || [];
          const candidates = list
            .filter((c) => c && isValidHttpUrl(c.url) && (typeof c.frameId !== "number" || c.frameId === frameId))
            .slice(0, 8)
            .map((c) => ({ url: c.url, mime: c.mime || "", at: c.at || 0 }));
          sendResponse({ ok: true, candidates });
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
            pageUrl: message.pageUrl || sender.tab?.url || "",
            frameUrl: sender.url || ""
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
            // Sarmalayıcı gömmelerde (örn. ?id=https://ok.ru/videoembed/...) yt-dlp'ye içteki gerçek adres verilir
            const candidatePageUrl = isValidHttpUrl(message.fallbackPageUrl)
              ? message.fallbackPageUrl
              : message.pageUrl || sender.tab?.url || "";
            if (
              matched.reason === "NO_VIDEO_DETECTED" &&
              settings.ytdlpFallback !== false &&
              isValidHttpUrl(candidatePageUrl)
            ) {
              const res = await openStreamInMpv(
                {
                  url: candidatePageUrl,
                  referer: message.pageUrl || candidatePageUrl,
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
            pageUrl: message.pageUrl || sender.tab?.url || "",
            frameUrl: sender.url || ""
          });

          if (matched.stream) {
            // En güncel URL'yi al
            const latest =
              streams.find((s) => s.dedupeKey === matched.stream.dedupeKey) || matched.stream;
            const { heights, heightMap } = buildResolutionMapForTab(streams, frameId, latest);

            const androidIntents = {};
            const streamUrls = {};
            // Masaüstünde de gönderilir: menü, segmentleri resim CDN'inde gizli akışları bununla tespit eder
            if (isValidHttpUrl(latest.url)) streamUrls.best = latest.url;
            if (isAndroid && isValidHttpUrl(latest.url)) {
              androidIntents.best = buildAndroidMpvIntentUri(latest.url, tabTitle);
              for (const h of heights) {
                const vUrl = heightMap[h];
                if (isValidHttpUrl(vUrl)) {
                  streamUrls[String(h)] = vUrl;
                  androidIntents[String(h)] = buildAndroidMpvIntentUri(vUrl, tabTitle);
                }
              }
            }

            const extra = {
              altIntents: isAndroid ? buildAndroidAltIntents(latest.url, tabTitle, isDisguisedHls(latest)) : {},
              disguisedHls: isDisguisedHls(latest),
              androidPlayer: settingsCache?.androidPlayer || "mpv"
            };
            if (heights.length > 0) {
              sendResponse({
                ok: true,
                isAndroid,
                mode: "hls_master",
                heights,
                androidIntents,
                streamUrls,
                ...extra
              });
              return;
            }
            sendResponse({
              ok: true,
              isAndroid,
              mode: "direct",
              heights: [],
              androidIntents,
              streamUrls,
              ...extra
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
              mpvAvailable: true,
              androidPlayers: Object.fromEntries(
                Object.entries(ANDROID_PLAYERS).map(([k, v]) => [k, v.label])
              )
            });
            return;
          }

          try {
            const resp = await getNativeHostInfo({ force: true });
            const selected = (await getSettings()).player;
            const players = resp?.players && typeof resp.players === "object"
              ? resp.players
              : { mpv: Boolean(resp?.mpv_available) };
            sendResponse({
              ok: true,
              platform: "desktop",
              hostInstalled: Boolean(resp?.ok),
              hostVersion: resp?.host_version || null,
              hostOutdated: Boolean(resp?.ok) && !resp?.host_version,
              mpvAvailable: Boolean(resp?.mpv_available),
              players,
              selectedPlayerAvailable: Boolean(players[selected]),
              ytdlpAvailable: resp?.ytdlp_available ?? null,
              extensionId: chrome.runtime.id
            });
          } catch (err) {
            sendResponse({
              ok: true,
              platform: "desktop",
              permissionRequired: err?.message === "NATIVE_PERMISSION_REQUIRED",
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

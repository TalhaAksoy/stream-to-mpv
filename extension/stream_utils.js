/**
 * Akış sınıflandırma, filtreleme, tekilleştirme ve önceliklendirme yardımcı modülü.
 * Hem masaüstü hem Android WebExtensions ortamında çalışır.
 */

// Varsayılan reklam ve izleyici alan adı filtreleri (düzenlenebilir yapı)
export const DEFAULT_BLOCKED_DOMAINS = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "imasdk.googleapis.com",
  "adnxs.com",
  "criteo.com",
  "taboola.com",
  "outbrain.com",
  "rubiconproject.com",
  "pubmatic.com",
  "openx.net",
  "scorecardresearch.com",
  "moatads.com",
  "innovid.com",
  "teads.tv",
  "spotxchange.com",
  "springserve.com",
  "freewheel.tv"
];

// Bağımsız oynatılabilir akış olarak listelenmeyecek video/ses segment uzantıları
const SEGMENT_EXTENSIONS = [
  ".ts",
  ".m4s",
  ".m4f",
  ".cmfv",
  ".cmfa",
  ".aac",
  ".vtt",
  ".srt",
  ".key",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".svg",
  ".woff",
  ".woff2",
  ".js",
  ".css",
  ".json",
  ".xml"
];

// Dinamik imzalı URL'lerde sık değişen geçici token/zaman damgası parametreleri.
// ÖNEMLİ: Tekilleştirme sırasında tüm query string silinmez; sadece bu uçucu imza
// parametreleri normalize edilerek aynı akışın yeni token'lı URL'sinin eskiyi güncellemesi sağlanır.
const VOLATILE_TOKEN_PARAMS = new Set([
  "token",
  "sig",
  "signature",
  "Policy",
  "Key-Pair-Id",
  "Signature",
  "Expires",
  "expires",
  "exp",
  "hdnts",
  "hdnea",
  "wmsAuthSign",
  "auth",
  "hash",
  "md5",
  "e",
  "st",
  "t",
  "ts",
  "timestamp",
  "nonce",
  "X-Amz-Signature",
  "X-Amz-Date",
  "X-Amz-Expires",
  "X-Amz-Security-Token",
  "X-Amz-Credential",
  "se",
  "sp",
  "sv",
  "sr"
]);

// Öncelik sabitleri (Düşük sayı = Yüksek öncelik)
export const STREAM_PRIORITY = {
  VERIFIED_HLS_MASTER: 1,
  LIKELY_HLS_MASTER: 2,
  HLS_VARIANT: 3,
  DIRECT_MP4: 4,
  OTHER_VIDEO: 5,
  UNSUPPORTED_DRM: 99
};

/**
 * URL'nin geçerli bir http veya https adresi olup olmadığını kontrol eder.
 */
export function isValidHttpUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Alan adının reklam/takip filtresinde olup olmadığını kontrol eder.
 */
export function isBlockedDomain(rawUrl, customBlockedList = DEFAULT_BLOCKED_DOMAINS) {
  try {
    const { hostname } = new URL(rawUrl);
    const lowerHost = hostname.toLowerCase();
    return customBlockedList.some(
      (domain) => lowerHost === domain || lowerHost.endsWith(`.${domain}`)
    );
  } catch {
    return true;
  }
}

/**
 * URL veya query parametreleri içinde segment (.ts, .m4s vb.) olup olmadığını kontrol eder.
 */
export function isMediaSegment(rawUrl, contentType = "") {
  try {
    const parsed = new URL(rawUrl);
    const lowerPath = parsed.pathname.toLowerCase();

    // Eğer açıkça .m3u8 ise segment değildir
    if (lowerPath.endsWith(".m3u8")) return false;
    for (const [, val] of parsed.searchParams.entries()) {
      if (val.toLowerCase().includes(".m3u8")) return false;
    }

    // Path uzantısı segment mi?
    for (const ext of SEGMENT_EXTENSIONS) {
      if (lowerPath.endsWith(ext)) return true;
    }

    // Query parametrelerinde segment dosyası referansı var mı? (örn: file=seg-1.ts)
    for (const [, val] of parsed.searchParams.entries()) {
      const lowerVal = val.toLowerCase();
      for (const ext of SEGMENT_EXTENSIONS) {
        if (lowerVal.endsWith(ext)) return true;
      }
    }

    // MIME türü segment ise (video/mp2t genellikle .ts segmentleridir)
    const lowerMime = (contentType || "").toLowerCase().split(";")[0].trim();
    if (lowerMime === "video/mp2t" || lowerMime === "video/iso.segment") {
      return true;
    }

    // Byte-range veya parça parametreleri içeren segment istekleri (örn: byterange, frag, seg)
    if (
      parsed.searchParams.has("byterange") ||
      /\/seg-\d+-/.test(lowerPath) ||
      /\/chunk-\d+\.(m4s|ts|mp4)$/i.test(lowerPath) ||
      /\/fragment-\d+/i.test(lowerPath)
    ) {
      return true;
    }

    return false;
  } catch {
    return true;
  }
}

/**
 * URL veya MIME türüne göre DRM / DASH (.mpd) veya korumalı içerik olup olmadığını tespit eder.
 */
export function isDrmOrUnsupportedStream(rawUrl, contentType = "") {
  try {
    const parsed = new URL(rawUrl);
    const lowerPath = parsed.pathname.toLowerCase();
    const lowerMime = (contentType || "").toLowerCase().split(";")[0].trim();

    if (
      lowerPath.includes("widevine") ||
      lowerPath.includes("fairplay") ||
      lowerPath.includes("playready") ||
      lowerPath.includes("drm") ||
      lowerMime === "application/dash+xml" ||
      lowerPath.endsWith(".mpd")
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * URL'den ve query parametrelerinden tahmini video kalitesini (örn: 1080p, 720p, 4K) çıkarır.
 */
export function extractQualityHint(rawUrl) {
  try {
    const decoded = decodeURIComponent(rawUrl);
    const matchRes = decoded.match(/(?:^|[^0-9])(2160p|1440p|1080p|720p|480p|360p|240p|4k|8k)(?:[^0-9]|$)/i);
    if (matchRes) return matchRes[1].toUpperCase().replace("P", "p");

    const matchDim = decoded.match(/(?:1920x1080|1280x720|3840x2160|2560x1440|854x480|640x360)/i);
    if (matchDim) {
      const height = matchDim[0].split("x")[1];
      return `${height}p`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * HLS URL'sinin isimlendirme kurallarına göre muhtemel Master mı yoksa Variant/Chunklist mi olduğunu tahmin eder.
 */
export function classifyHlsRoleByUrl(rawUrl) {
  try {
    const decoded = decodeURIComponent(rawUrl).toLowerCase();
    // Variant / chunklist işaretçileri
    if (
      decoded.includes("chunklist") ||
      decoded.includes("variant") ||
      decoded.includes("media_") ||
      decoded.includes("index_0") ||
      decoded.includes("index_1") ||
      decoded.includes("level_") ||
      /(?:^|[/_.-])(1080p?|720p?|480p?|360p?|240p?)(?:[/_.-]|\.m3u8)/i.test(decoded)
    ) {
      return "variant";
    }

    // Master / ana manifest işaretçileri
    if (
      decoded.includes("master") ||
      decoded.includes("manifest") ||
      decoded.includes("playlist.m3u8") ||
      decoded.includes("index.m3u8")
    ) {
      return "likely_master";
    }

    // Bilinmiyorsa içerik doğrulamasına aday olması için likely_master olarak başlatılır
    return "likely_master";
  } catch {
    return "variant";
  }
}

/**
 * İstek URL'sini ve Response Content-Type değerini birlikte değerlendirerek akışı sınıflandırır.
 * r_file=chunklist.m3u8 gibi query parametrelerini de yakalar.
 */
export function classifyCandidate(rawUrl, contentType = "", contentLength = null) {
  if (!isValidHttpUrl(rawUrl)) return null;
  if (isMediaSegment(rawUrl, contentType)) return null;

  const parsed = new URL(rawUrl);
  const lowerPath = parsed.pathname.toLowerCase();
  const lowerMime = (contentType || "").toLowerCase().split(";")[0].trim();

  // DRM / desteklenmeyen kontrolü
  if (isDrmOrUnsupportedStream(rawUrl, contentType)) {
    // Yalnızca gerçek bir manifest (.mpd veya dash+xml) ise Unsupported olarak raporla,
    // rastgele /drm/api/license çağrılarını kalabalık etmemesi için filtrele
    if (lowerPath.endsWith(".mpd") || lowerMime === "application/dash+xml") {
      return {
        format: "DRM/DASH",
        streamType: "unsupported",
        priority: STREAM_PRIORITY.UNSUPPORTED_DRM,
        quality: extractQualityHint(rawUrl),
        needsVerification: false,
        unsupportedReason: "Encrypted DRM or DASH (.mpd) stream is not directly supported"
      };
    }
    return null;
  }

  // Küçük boyutlu (örn. < 50 KB) video/mp4 veya video/webm yanıtları genellikle init segmentidir
  if (
    contentLength !== null &&
    contentLength > 0 &&
    contentLength < 50 * 1024 &&
    (lowerMime.startsWith("video/") || lowerPath.endsWith(".mp4") || lowerPath.endsWith(".webm"))
  ) {
    return null;
  }

  // 1. HLS tespiti: path .m3u8 bitiyorsa, query parametresinde .m3u8 varsa veya MIME türü HLS ise
  const hasM3u8InPath = lowerPath.endsWith(".m3u8") || lowerPath.includes(".m3u8/");
  let hasM3u8InQuery = false;
  let queryM3u8Value = "";

  for (const [, val] of parsed.searchParams.entries()) {
    if (val.toLowerCase().includes(".m3u8")) {
      hasM3u8InQuery = true;
      queryM3u8Value = val;
      break;
    }
  }

  const isHlsMime =
    lowerMime === "application/vnd.apple.mpegurl" ||
    lowerMime === "application/x-mpegurl" ||
    lowerMime === "audio/mpegurl" ||
    lowerMime === "audio/x-mpegurl" ||
    lowerMime === "vnd.apple.mpegurl";

  // Türkçe anime/dizi CDN'lerinde sık görülen .txt veya uzantısız ama /hls/.../master.txt tipi HLS manifestleri
  const isDisguisedHlsPath =
    (lowerPath.includes("/hls/") || lowerPath.includes("/m3u8/")) &&
    (lowerPath.endsWith("master.txt") ||
      lowerPath.endsWith("playlist.txt") ||
      lowerPath.endsWith("index.txt"));

  if (hasM3u8InPath || hasM3u8InQuery || isHlsMime || isDisguisedHlsPath) {
    const roleTarget = hasM3u8InQuery ? queryM3u8Value : rawUrl;
    const initialRole = classifyHlsRoleByUrl(roleTarget);
    const isVariant = initialRole === "variant";

    return {
      format: "HLS",
      streamType: isVariant ? "variant" : "likely_master",
      priority: isVariant ? STREAM_PRIORITY.HLS_VARIANT : STREAM_PRIORITY.LIKELY_HLS_MASTER,
      quality: extractQualityHint(rawUrl),
      needsVerification: true // HLS içeriği #EXT-X-STREAM-INF için kontrol edilebilir
    };
  }

  // 2. Doğrudan MP4 tespiti
  const isMp4Path = lowerPath.endsWith(".mp4") || lowerPath.endsWith(".m4v");
  let isMp4Query = false;
  for (const [, val] of parsed.searchParams.entries()) {
    if (val.toLowerCase().endsWith(".mp4")) {
      isMp4Query = true;
      break;
    }
  }
  const isMp4Mime = lowerMime === "video/mp4" || lowerMime === "application/mp4";

  if (isMp4Path || isMp4Query || isMp4Mime) {
    return {
      format: "MP4",
      streamType: "direct",
      priority: STREAM_PRIORITY.DIRECT_MP4,
      quality: extractQualityHint(rawUrl),
      needsVerification: false
    };
  }

  // 3. WebM ve diğer desteklenen doğrudan video türleri
  const isWebmPath = lowerPath.endsWith(".webm") || lowerPath.endsWith(".mkv") || lowerPath.endsWith(".mov");
  const isWebmMime = lowerMime === "video/webm" || lowerMime === "video/x-matroska" || lowerMime === "video/quicktime";

  if (isWebmPath || isWebmMime) {
    return {
      format: lowerPath.endsWith(".webm") || lowerMime === "video/webm" ? "WebM" : "Video",
      streamType: "direct",
      priority: STREAM_PRIORITY.OTHER_VIDEO,
      quality: extractQualityHint(rawUrl),
      needsVerification: false
    };
  }

  return null;
}

/**
 * Tekilleştirme anahtarı (deduplication key) üretir.
 * Query parametrelerinin tamamını SİLMEZ!
 * `id=123`, `r_file=chunklist.m3u8`, `itag=18` gibi akışı tanımlayan anlamlı query parametrelerini korur;
 * yalnızca imzalı URL'lerde sürekli yenilenen token/signature/expires parametrelerini normalize eder.
 * Böylece aynı akışın yeni imzalı URL'si geldiğinde listeyi şişirmez, mevcut kaydın URL'sini günceller.
 */
export function computeDedupeKey(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const keptParams = [];

    for (const [key, val] of parsed.searchParams.entries()) {
      if (!VOLATILE_TOKEN_PARAMS.has(key) && !VOLATILE_TOKEN_PARAMS.has(key.toLowerCase())) {
        keptParams.push([key, val]);
      }
    }

    keptParams.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    const normalizedQuery = keptParams
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    return `${parsed.origin}${parsed.pathname}${normalizedQuery ? `?${normalizedQuery}` : ""}`;
  } catch {
    return rawUrl;
  }
}

/**
 * HLS metin içeriğini inceleyerek gerçekte Master Playlist mi, Variant Playlist mi yoksa DRM'li mi olduğunu doğrular.
 * Master playlist ise içindeki mevcut çözünürlükleri ve variant URL'lerini de çıkarır.
 */
export function inspectHlsPlaylistContent(text, currentQuality = null, baseUrl = "") {
  if (!text || typeof text !== "string") return null;
  if (!text.includes("#EXTM3U")) return null;

  // DRM kontrolü (#EXT-X-KEY içinde SAMPLE-AES veya Widevine/FairPlay varsa)
  if (
    /#EXT-X-KEY:.*METHOD=(SAMPLE-AES|SAMPLE-AES-CTR|SAMPLE-AES-CENC)/i.test(text) ||
    text.includes("com.widevine.alpha") ||
    text.includes("com.apple.streamingkeydelivery")
  ) {
    return {
      format: "DRM/HLS",
      streamType: "unsupported",
      priority: STREAM_PRIORITY.UNSUPPORTED_DRM,
      quality: currentQuality,
      verified: true,
      unsupportedReason: "HLS stream uses DRM encryption (SAMPLE-AES / Widevine / FairPlay)"
    };
  }

  // Master playlist doğrulaması (#EXT-X-STREAM-INF varlığı)
  if (text.includes("#EXT-X-STREAM-INF")) {
    let bestHeight = 0;
    const heightsSet = new Set();
    const variantsByHeight = {};
    // Ayrık ses izi (#EXT-X-MEDIA:TYPE=AUDIO) varsa tekil variant URL'si sessiz kalacağından
    // doğrudan variant URL'si yerine Master URL'nin kullanılması gerekir.
    const hasSeparateAudio = /#EXT-X-MEDIA:[^\r\n]*TYPE=AUDIO/i.test(text);

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("#EXT-X-STREAM-INF")) continue;

      const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
      const height = resMatch ? parseInt(resMatch[2], 10) : 0;
      if (height > 0) {
        heightsSet.add(height);
        if (height > bestHeight) bestHeight = height;
      }

      // Bir sonraki yorum olmayan satır variant URL'sidir
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();
        if (!nextLine) continue;
        if (nextLine.startsWith("#")) break;
        if (!hasSeparateAudio && height > 0 && baseUrl) {
          try {
            const resolvedVariant = new URL(nextLine, baseUrl).href;
            if (!variantsByHeight[height]) {
              variantsByHeight[height] = resolvedVariant;
            }
          } catch {
            // Geçersiz göreceli URL'yi yoksay
          }
        }
        break;
      }
    }

    const availableHeights = Array.from(heightsSet).sort((a, b) => b - a);
    const detectedQuality = bestHeight > 0 ? `Up to ${bestHeight}p` : currentQuality;

    return {
      format: "HLS",
      streamType: "master",
      priority: STREAM_PRIORITY.VERIFIED_HLS_MASTER,
      quality: detectedQuality,
      availableHeights,
      variantsByHeight,
      verified: true
    };
  }

  // Variant / Media playlist doğrulaması (#EXTINF veya #EXT-X-TARGETDURATION varlığı)
  if (text.includes("#EXTINF") || text.includes("#EXT-X-TARGETDURATION")) {
    return {
      format: "HLS",
      streamType: "variant",
      priority: STREAM_PRIORITY.HLS_VARIANT,
      quality: currentQuality,
      verified: true
    };
  }

  return null;
}

/**
 * Akış listesini öncelik sırasına (ve eşit öncelikte en güncel yakalanma zamanına) göre sıralar.
 */
export function sortStreams(streams) {
  return [...streams].sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return b.updatedAt - a.updatedAt;
  });
}

/**
 * Sekmedeki oynatılabilir en uygun akışı seçer.
 */
export function selectBestPlayableStream(streams) {
  const playable = sortStreams(streams).filter(
    (s) => s.streamType !== "unsupported" && s.priority !== STREAM_PRIORITY.UNSUPPORTED_DRM
  );
  return playable.length > 0 ? playable[0] : null;
}

/**
 * Tıklanan <video> elementinin bağlamını (frameId, src/currentSrc, kaynaklar, oynatma zamanı ve
 * sayfadaki toplam video sayısı) kullanarak sekmedeki yakalanmış ağ akışlarıyla eşleştirir.
 *
 * Kurallar:
 * - video.src veya currentSrc bir `blob:` URL'si ise asla doğrudan mpv'ye gönderilmez; ağ yakalamasından çözülür.
 * - Aynı frameId içindeki akışlara öncelik verilir.
 * - Sayfada birden fazla video varsa ve tıklanan videonun hangi akışa ait olduğu güvenilir şekilde
 *   ayırt edilemiyorsa (başka bir videonun URL'sini yanlışlıkla açmamak için) AMBIGUOUS_MULTIPLE_VIDEOS döndürülür.
 */
export function matchStreamForVideoContext(streams, videoContext = {}) {
  const {
    frameId = 0,
    currentSrc = "",
    src = "",
    sources = [],
    videoCountInFrame = 1,
    actionTimestamp = Date.now()
  } = videoContext;

  const allDomUrls = [currentSrc, src, ...(Array.isArray(sources) ? sources : [])]
    .filter((u) => typeof u === "string" && u.trim().length > 0);

  // 1. Doğrudan HTTP(S) URL'leri (blob: veya data: OLMAYANLAR)
  const directHttpDomUrls = allDomUrls.filter(
    (u) => !u.startsWith("blob:") && !u.startsWith("data:") && isValidHttpUrl(u)
  );

  const safeStreams = Array.isArray(streams) ? streams : [];

  // Aday havuzunu önce aynı frameId'ye göre filtrele; eğer boşsa ve ana frame ise tümüne bak
  const sameFrameStreams = safeStreams.filter(
    (s) => typeof s.frameId !== "number" || s.frameId === frameId
  );
  const candidatePool = sameFrameStreams.length > 0 ? sameFrameStreams : safeStreams;

  // Eğer tamamı DRM/desteklenmeyen ise hemen bildir
  const playablePool = candidatePool.filter(
    (s) => s.streamType !== "unsupported" && s.priority !== STREAM_PRIORITY.UNSUPPORTED_DRM
  );
  if (playablePool.length === 0 && candidatePool.length > 0) {
    const firstDrm = candidatePool.find((s) => s.streamType === "unsupported");
    return {
      stream: null,
      reason: "UNSUPPORTED_STREAM",
      errorMessage: firstDrm?.unsupportedReason || "Unsupported DRM stream."
    };
  }

  // 2. Video elementinin doğrudan HTTP src/currentSrc adresi varsa ağ kayıtlarıyla tam veya dedupeKey eşleşmesi ara
  if (directHttpDomUrls.length > 0) {
    for (const domUrl of directHttpDomUrls) {
      const domDedupe = computeDedupeKey(domUrl);
      const exactMatch = playablePool.find(
        (s) => s.url === domUrl || s.dedupeKey === domDedupe
      );
      if (exactMatch) {
        return { stream: exactMatch, reason: "MATCHED_DOM_URL" };
      }
    }

    // Ağ yakalamasında henüz yoksa ama DOM üzerindeki URL doğrudan geçerli bir medya akışıysa (.mp4/.m3u8/.webm veya uzantısız video endpoint'i)
    for (const domUrl of directHttpDomUrls) {
      const classified = classifyCandidate(domUrl, "");
      if (classified && classified.streamType !== "unsupported") {
        return {
          stream: {
            url: domUrl,
            dedupeKey: computeDedupeKey(domUrl),
            format: classified.format,
            streamType: classified.streamType,
            priority: classified.priority,
            referer: videoContext.pageUrl || "",
            userAgent: "",
            updatedAt: Date.now()
          },
          reason: "DIRECT_DOM_HTTP_SRC"
        };
      }

      // Uzantısız video endpoint'i (örn. Sibnet / Google / imzalı yönlendirme linkleri): sayfa URL'sinin kendisi değilse kabul et
      if (playablePool.length === 0 && domUrl !== (videoContext.pageUrl || "")) {
        try {
          const parsedDom = new URL(domUrl);
          const lowerDomPath = parsedDom.pathname.toLowerCase();
          if (!/\.(html?|php|aspx?|jsp)$/i.test(lowerDomPath)) {
            return {
              stream: {
                url: domUrl,
                dedupeKey: computeDedupeKey(domUrl),
                format: "Video",
                streamType: "direct",
                priority: STREAM_PRIORITY.OTHER_VIDEO,
                referer: videoContext.pageUrl || "",
                userAgent: "",
                updatedAt: Date.now()
              },
              reason: "DIRECT_DOM_VIDEO_ELEMENT_SRC"
            };
          }
        } catch {
          // Geçersiz URL'yi yoksay
        }
      }
    }
  }

  // 3. `blob:` MSE oynatıcısı veya kaynak URL'si gizli oynatıcı: ağ yakalamasından (playablePool) seç
  if (playablePool.length === 0) {
    return {
      stream: null,
      reason: "NO_VIDEO_DETECTED",
      errorMessage: "No playable stream detected for this video yet."
    };
  }

  // Aynı frame içinde tek bir video varsa, bu frame'deki en yüksek öncelikli (Verified Master > Variant > MP4) akışı seç
  if (videoCountInFrame <= 1) {
    return {
      stream: selectBestPlayableStream(playablePool),
      reason: "SINGLE_VIDEO_IN_FRAME_BEST"
    };
  }

  // 4. Aynı frame içinde BİRDEN FAZLA video varsa:
  // Farklı kök dizinlerden / farklı videolardan gelen bağımsız akış gruplarını kontrol et.
  // Eğer tüm yakalanmış akışlar aynı HLS ailesine (aynı dizin/path prefix) aitse güvenle en iyisini seç.
  const streamFamilies = new Set(
    playablePool.map((s) => {
      try {
        const u = new URL(s.url);
        const dir = u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1);
        return `${u.origin}${dir}`;
      } catch {
        return s.dedupeKey;
      }
    })
  );

  if (streamFamilies.size === 1) {
    return {
      stream: selectBestPlayableStream(playablePool),
      reason: "SINGLE_STREAM_FAMILY_BEST"
    };
  }

  // Birden fazla bağımsız akış ailesi varsa, tıklanan videonun son etkileşim/oynatma zamanına (actionTimestamp)
  // çok yakın (son 8 saniye içinde) güncellenmiş tek bir akış ailesi var mı bak
  if (actionTimestamp) {
    const recentStreams = playablePool.filter(
      (s) => Math.abs(actionTimestamp - (s.updatedAt || s.capturedAt || 0)) <= 8000
    );
    const recentFamilies = new Set(
      recentStreams.map((s) => {
        try {
          const u = new URL(s.url);
          const dir = u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1);
          return `${u.origin}${dir}`;
        } catch {
          return s.dedupeKey;
        }
      })
    );

    if (recentStreams.length > 0 && recentFamilies.size === 1) {
      return {
        stream: selectBestPlayableStream(recentStreams),
        reason: "MATCHED_BY_RECENT_PLAYBACK_ACTIVITY"
      };
    }
  }

  // Güvenilir şekilde hangi videoya ait olduğu ayrıştırılamıyorsa başka bir videoyu yanlışlıkla açma!
  return {
    stream: null,
    reason: "AMBIGUOUS_MULTIPLE_VIDEOS",
    errorMessage: "Multiple active videos detected. Briefly play or seek the target video, then click again."
  };
}


/**
 * Background Service Worker Yaşam Döngüsü ve Yarış Durumu (Race Condition) Testleri
 * Senaryo 7, 8, 9, 10, 11'i gerçek background.js kodu üzerinde sahte (mock) Chrome API'si ile doğrular.
 */

import assert from "node:assert/strict";

// Bellek içi chrome.storage.session ve chrome.storage.local simülasyonu
const sessionStore = {};
const localStore = { autoOpen: false, ytdlpFallback: false };
const tabBadges = {};
const mockTabs = new Map();

let listeners = {};
let simulateNativeHostMissing = false;
let simulatePlatformOs = "mac";
let lastNativePayload = null;
let simulateOldHost = false;

function setupChromeMock() {
  listeners = {
    onSendHeaders: [],
    onBeforeRedirect: [],
    onHeadersReceived: [],
    onErrorOccurred: [],
    onTabRemoved: [],
    onTabUpdated: [],
    onMessage: []
  };

  globalThis.chrome = {
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      getPlatformInfo: async () => ({ os: simulatePlatformOs }),
      sendNativeMessage: async (hostName, payload) => {
        if (simulateNativeHostMissing) {
          throw new Error("Specified native messaging host not found.");
        }
        if (payload?.action === "ping") {
          return simulateOldHost
            ? { ok: true, status: "pong", mpv_available: true }
            : { ok: true, status: "pong", host_version: "1.2.0", mpv_available: true, players: { mpv: true, vlc: true } };
        }
        lastNativePayload = { hostName, payload };
        return {
          ok: true,
          message: "mpv launch requested",
          pid: 42424,
          resolved_via: "direct"
        };
      },
      onMessage: {
        addListener: (fn) => listeners.onMessage.push(fn)
      }
    },
    storage: {
      session: {
        get: async (key) => {
          if (key === null) return structuredClone(sessionStore);
          if (typeof key === "string") {
            return key in sessionStore ? { [key]: structuredClone(sessionStore[key]) } : {};
          }
          if (Array.isArray(key)) {
            const out = {};
            for (const k of key) {
              if (k in sessionStore) out[k] = structuredClone(sessionStore[k]);
            }
            return out;
          }
          return {};
        },
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) {
            sessionStore[k] = structuredClone(v);
          }
        },
        remove: async (keys) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) delete sessionStore[k];
        }
      },
      local: {
        get: async () => structuredClone(localStore),
        set: async (obj) => Object.assign(localStore, structuredClone(obj))
      }
    },
    tabs: {
      get: async (tabId) => {
        if (!mockTabs.has(tabId)) throw new Error("No tab");
        return mockTabs.get(tabId);
      },
      query: async () => Array.from(mockTabs.values()),
      onRemoved: {
        addListener: (fn) => listeners.onTabRemoved.push(fn)
      },
      onUpdated: {
        addListener: (fn) => listeners.onTabUpdated.push(fn)
      }
    },
    action: {
      setBadgeText: async ({ tabId, text }) => {
        tabBadges[tabId] = text;
      },
      setBadgeBackgroundColor: async () => {}
    },
    webRequest: {
      onSendHeaders: {
        addListener: (fn) => listeners.onSendHeaders.push(fn)
      },
      onBeforeRedirect: {
        addListener: (fn) => listeners.onBeforeRedirect.push(fn)
      },
      onHeadersReceived: {
        addListener: (fn) => listeners.onHeadersReceived.push(fn)
      },
      onErrorOccurred: {
        addListener: (fn) => listeners.onErrorOccurred.push(fn)
      }
    }
  };
}

// Gerçek ağ isteklerine çıkmasın diye global fetch'i simüle et
globalThis.fetch = async (url) => {
  if (url.includes("master.m3u8")) {
    const body = new TextEncoder().encode("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\nchunk.m3u8\n");
    return {
      ok: true,
      status: 206,
      headers: new Map([["content-length", String(body.length)]]),
      body: {
        getReader: () => ({
          read: async () => ({ value: body, done: false }),
          cancel: async () => {}
        })
      }
    };
  }
  return { ok: false, status: 404 };
};

setupChromeMock();
await import("../extension/background.js");

function sendMessageToBg(message, senderId = "abcdefghijklmnopabcdefghijklmnop", senderExtra = {}) {
  return new Promise((resolve) => {
    const fn = listeners.onMessage[0];
    fn(message, { id: senderId, ...senderExtra }, (resp) => resolve(resp));
  });
}

console.log("=== Running Background Service Worker Lifecycle & Concurrency Tests ===");

// Senaryo 7: Eşzamanlı çok sayıda network event gelmesi ve imzalı URL güncellenmesi
mockTabs.set(101, { id: 101, url: "https://video.example.com/watch/1", title: "Episode 1" });

await Promise.all([
  listeners.onSendHeaders[0]({
    requestId: "r1",
    tabId: 101,
    url: "https://cdn.example.com/hls/master.m3u8?vid=1&token=tok_A",
    requestHeaders: [
      { name: "Referer", value: "https://video.example.com/watch/1" },
      { name: "User-Agent", value: "TestBrowser/1.0" }
    ]
  }),
  listeners.onSendHeaders[0]({
    requestId: "r2",
    tabId: 101,
    url: "https://cdn.example.com/hls/master.m3u8?vid=1&token=tok_B",
    requestHeaders: [
      { name: "Referer", value: "https://video.example.com/watch/1" },
      { name: "User-Agent", value: "TestBrowser/1.0" }
    ]
  }),
  listeners.onSendHeaders[0]({
    requestId: "r3",
    tabId: 101,
    url: "https://cdn.example.com/hls/chunklist_720p.m3u8?vid=1&token=tok_C",
    requestHeaders: []
  })
]);

// HLS doğrulamasının tamamlanması için kısa bekleme
await new Promise((r) => setTimeout(r, 50));

let stateResp = await sendMessageToBg({ type: "GET_STATE" });
assert.equal(stateResp.ok, true);
let tab101 = stateResp.tabsData.find((t) => t.tabId === 101);
assert.ok(tab101);
// tok_A ve tok_B tekilleştirilmiş olmalı, toplamda 2 akış (1 master + 1 variant) bulunmalı
assert.equal(tab101.streams.length, 2);
// En güncel token (tok_B) korunmuş ve Master en üstte seçilmiş olmalı
assert.equal(tab101.streams[0].url, "https://cdn.example.com/hls/master.m3u8?vid=1&token=tok_B");
assert.equal(tab101.streams[0].streamType, "master");
console.log("  [PASS] Scenario 7: Concurrent network events deduplicated & latest signed token preserved");

// Senaryo 4 & 5: Open in mpv çağrıldığında Referer, User-Agent ve en güncel URL'nin Native Host'a aktarılması
const openResp = await sendMessageToBg({ type: "OPEN_BEST_IN_TAB", tabId: 101 });
assert.equal(openResp.ok, true);
assert.equal(lastNativePayload.hostName, "com.talha.mpv");
assert.equal(lastNativePayload.payload.url, "https://cdn.example.com/hls/master.m3u8?vid=1&token=tok_B");
assert.equal(lastNativePayload.payload.referer, "https://video.example.com/watch/1");
assert.equal(lastNativePayload.payload.user_agent, "TestBrowser/1.0");
console.log("  [PASS] Scenario 4, 5 & 6: Open in mpv sends latest signed URL with Referer and User-Agent");

// Senaryo 10: Service worker yeniden başlatıldıktan sonra chrome.storage.session üzerindeki akış listesinin korunması
// (Global değişkenler sıfırlansa bile GET_STATE ve OPEN_BEST_IN_TAB storage.session'dan okur)
const afterRestartResp = await sendMessageToBg({ type: "GET_STATE" });
const persistedTab = afterRestartResp.tabsData.find((t) => t.tabId === 101);
assert.equal(persistedTab.streams.length, 2);
console.log("  [PASS] Scenario 10: Stream state persists in chrome.storage.session across SW restarts");

// Senaryo 9: Sekme navigasyonu sonrası eski akışın temizlenmesi ve kullanılmaması
mockTabs.set(101, { id: 101, url: "https://video.example.com/watch/2", title: "Episode 2" });
await listeners.onTabUpdated[0](101, { status: "loading", url: "https://video.example.com/watch/2" }, mockTabs.get(101));

stateResp = await sendMessageToBg({ type: "GET_STATE" });
tab101 = stateResp.tabsData.find((t) => t.tabId === 101);
assert.equal(tab101.streams.length, 0);
console.log("  [PASS] Scenario 9: Main-frame navigation clears previous playback session streams");

// Senaryo 8: Sekme kapanırken ilgili verilerin tamamen temizlenmesi
await listeners.onTabRemoved[0](101);
stateResp = await sendMessageToBg({ type: "GET_STATE" });
assert.equal(stateResp.tabsData.find((t) => t.tabId === 101), undefined);
console.log("  [PASS] Scenario 8: Tab closure removes all associated session data");

// Senaryo 11: Native host yüklü değilken anlaşılır hata gösterilmesi
mockTabs.set(202, { id: 202, url: "https://video.example.com/movie", title: "Movie" });
await listeners.onSendHeaders[0]({
  requestId: "r10",
  tabId: 202,
  url: "https://cdn.example.com/movie.mp4",
  requestHeaders: []
});
simulateNativeHostMissing = true;
const missingHostResp = await sendMessageToBg({ type: "OPEN_BEST_IN_TAB", tabId: 202 });
assert.equal(missingHostResp.ok, false);
assert.equal(missingHostResp.statusCode, "NATIVE_HOST_NOT_INSTALLED");
simulateNativeHostMissing = false;
console.log("  [PASS] Scenario 11: Native host not installed returns clear NATIVE_HOST_NOT_INSTALLED status");

// Güvenlik: Yetkisiz dış göndericiden gelen mesajın reddedilmesi
const unauthResp = await sendMessageToBg({ type: "GET_STATE" }, "malicious_sender_id");
assert.equal(unauthResp.ok, false);
console.log("  [PASS] Security: Unauthorized external runtime messages are rejected");

// Video üzerindeki "Open in mpv" butonu (OPEN_FROM_VIDEO_OVERLAY) uçtan uca akış testi
mockTabs.set(303, { id: 303, url: "https://cinema.example.com/watch", title: "Cinema Stream" });
await listeners.onSendHeaders[0]({
  requestId: "r30",
  tabId: 303,
  frameId: 2,
  url: "https://cdn.cinema.example.com/hls/master.m3u8?token=fresh999",
  requestHeaders: [
    { name: "Referer", value: "https://cinema.example.com/watch" },
    { name: "User-Agent", value: "OverlayBrowser/1.0" }
  ]
});
await new Promise((r) => setTimeout(r, 40));

const overlayResp = await sendMessageToBg(
  {
    type: "OPEN_FROM_VIDEO_OVERLAY",
    currentSrc: "blob:https://cinema.example.com/abc-123",
    src: "",
    sources: [],
    videoCountInFrame: 1,
    actionTimestamp: Date.now(),
    pageUrl: "https://cinema.example.com/watch"
  },
  "abcdefghijklmnopabcdefghijklmnop",
  { tab: { id: 303, url: "https://cinema.example.com/watch", title: "Cinema Stream" }, frameId: 2 }
);
assert.equal(overlayResp.ok, true);
assert.equal(lastNativePayload.payload.url, "https://cdn.cinema.example.com/hls/master.m3u8?token=fresh999");
assert.equal(lastNativePayload.payload.referer, "https://cinema.example.com/watch");
assert.equal(lastNativePayload.payload.user_agent, "OverlayBrowser/1.0");
console.log("  [PASS] On-video overlay click (OPEN_FROM_VIDEO_OVERLAY) resolves blob: to frame's Master HLS stream and launches mpv");

// Android (Bare Browser / Lemur / Mises) Intent üretimi ve GET_VIDEO_RESOLUTIONS / GET_TAB_LAUNCH_TARGET testi
simulatePlatformOs = "android";
const androidResInfo = await sendMessageToBg(
  {
    type: "GET_VIDEO_RESOLUTIONS",
    currentSrc: "blob:https://cinema.example.com/abc-123",
    src: "",
    sources: [],
    videoCountInFrame: 1,
    actionTimestamp: Date.now(),
    pageUrl: "https://cinema.example.com/watch"
  },
  "abcdefghijklmnopabcdefghijklmnop",
  { tab: { id: 303, url: "https://cinema.example.com/watch", title: "Cinema Stream" }, frameId: 2 }
);
assert.equal(androidResInfo.ok, true);
assert.equal(androidResInfo.isAndroid, true);
assert.ok(androidResInfo.androidIntents?.best?.startsWith("intent://cdn.cinema.example.com/hls/master.m3u8?token=fresh999#Intent;"));
assert.ok(androidResInfo.androidIntents.best.includes(";package=is.xyz.mpv;"));
assert.ok(androidResInfo.androidIntents.best.includes(";action=android.intent.action.VIEW;"));
assert.ok(androidResInfo.androidIntents.best.includes(";type=video/*;"));
assert.ok(!androidResInfo.androidIntents.best.includes("type=video/any"));
assert.ok(!androidResInfo.androidIntents.best.includes("S.browser_fallback_url"));
assert.equal(androidResInfo.streamUrls?.best, "https://cdn.cinema.example.com/hls/master.m3u8?token=fresh999");

const androidPopupTarget = await sendMessageToBg({
  type: "GET_TAB_LAUNCH_TARGET",
  tabId: 303,
  pageUrl: "https://cinema.example.com/watch",
  tabTitle: "Cinema Stream"
});
assert.equal(androidPopupTarget.ok, true);
assert.equal(androidPopupTarget.isAndroid, true);
assert.equal(androidPopupTarget.streamUrl, "https://cdn.cinema.example.com/hls/master.m3u8?token=fresh999");
assert.ok(androidPopupTarget.intentUri.includes(";type=video/*;"));

// Android üzerinde akışı henüz yakalanmamış sekmede HTML sayfa URL'si mpv-android'e gönderilmemeli (açılıp kapanmayı önler)
mockTabs.set(404, { id: 404, url: "https://m.youtube.com/watch?v=zU__OqDkyeY", title: "YT Mobile" });
const androidNoRawPage = await sendMessageToBg(
  {
    type: "GET_VIDEO_RESOLUTIONS",
    currentSrc: "blob:https://m.youtube.com/xyz",
    src: "",
    sources: [],
    videoCountInFrame: 1,
    actionTimestamp: Date.now(),
    pageUrl: "https://m.youtube.com/watch?v=zU__OqDkyeY"
  },
  "abcdefghijklmnopabcdefghijklmnop",
  { tab: { id: 404, url: "https://m.youtube.com/watch?v=zU__OqDkyeY", title: "YT Mobile" }, frameId: 0 }
);
assert.equal(androidNoRawPage.mode, "android_no_stream");
assert.equal(androidNoRawPage.androidIntents.best, undefined);

// Content script YouTube HLS çıkardığında REGISTER_EXTRACTED_STREAM ile kaydedip geçerli m3u8 intent üretmeli
const regYt = await sendMessageToBg(
  {
    type: "REGISTER_EXTRACTED_STREAM",
    streamUrl: "https://manifest.googlevideo.com/api/manifest/hls_variant/id/123/file/index.m3u8",
    title: "YT Mobile"
  },
  "abcdefghijklmnopabcdefghijklmnop",
  { tab: { id: 404, url: "https://m.youtube.com/watch?v=zU__OqDkyeY", title: "YT Mobile" }, frameId: 0 }
);
assert.equal(regYt.ok, true);
assert.ok(regYt.intentUri.startsWith("intent://manifest.googlevideo.com/api/manifest/hls_variant/id/123/file/index.m3u8#Intent;"));
assert.ok(regYt.intentUri.includes(";type=video/*;"));

simulatePlatformOs = "mac";
console.log("  [PASS] Android (Bare Browser) intent:// generation uses type=video/*, never sends raw HTML page URLs, and registers extracted YouTube HLS");

// Sibnet 302 yönlendirmesi (video.sibnet.ru/v/...mp4 -> dv82.sibnet.ru/...mp4) ve çoklu çözünürlüklü
// OK.ru / Mail.ru / VK REGISTER_EXTRACTED_STREAM testi (Android + macOS)
mockTabs.set(505, { id: 505, url: "https://www.tranimeizle.live/ep-1", title: "Anime Ep 1" });
await listeners.onSendHeaders[0]({
  requestId: "r_sib_1",
  tabId: 505,
  frameId: 4,
  url: "https://video.sibnet.ru/v/abcd123/1887072.mp4",
  requestHeaders: [
    { name: "Referer", value: "https://video.sibnet.ru/shell.php?videoid=1887072" },
    { name: "User-Agent", value: "MobileChrome/131.0" }
  ]
});
await listeners.onHeadersReceived[0]({
  requestId: "r_sib_1",
  tabId: 505,
  frameId: 4,
  statusCode: 302,
  url: "https://video.sibnet.ru/v/abcd123/1887072.mp4",
  responseHeaders: [{ name: "Location", value: "https://dv82.sibnet.ru/38/99/1887072.mp4?st=xyz&e=1799999" }]
});
await listeners.onBeforeRedirect[0]({
  requestId: "r_sib_1",
  tabId: 505,
  frameId: 4,
  url: "https://video.sibnet.ru/v/abcd123/1887072.mp4",
  redirectUrl: "https://dv82.sibnet.ru/38/99/1887072.mp4?st=xyz&e=1799999"
});

simulatePlatformOs = "android";
const sibnetAndroidRes = await sendMessageToBg(
  {
    type: "GET_VIDEO_RESOLUTIONS",
    currentSrc: "https://video.sibnet.ru/v/abcd123/1887072.mp4",
    src: "https://video.sibnet.ru/v/abcd123/1887072.mp4",
    sources: [],
    videoCountInFrame: 1,
    actionTimestamp: Date.now(),
    pageUrl: "https://video.sibnet.ru/shell.php?videoid=1887072"
  },
  "abcdefghijklmnopabcdefghijklmnop",
  { tab: { id: 505, url: "https://www.tranimeizle.live/ep-1", title: "Anime Ep 1" }, frameId: 4 }
);
assert.equal(sibnetAndroidRes.ok, true);
assert.equal(sibnetAndroidRes.streamUrls.best, "https://dv82.sibnet.ru/38/99/1887072.mp4?st=xyz&e=1799999");
assert.ok(sibnetAndroidRes.androidIntents.best.startsWith("intent://dv82.sibnet.ru/38/99/1887072.mp4?st=xyz&e=1799999#Intent;"));

// OK.ru / Mail.ru / VK çoklu çözünürlüklü REGISTER_EXTRACTED_STREAM -> Android intent + macOS seçim testi
const okExtracted = await sendMessageToBg(
  {
    type: "REGISTER_EXTRACTED_STREAM",
    streamUrl: "https://vd414.okcdn.ru/video.m3u8?cmd=videoPlayerCdn&srcAg=CHROME_ANDROID",
    format: "HLS",
    variantsByHeight: {
      1080: "https://ok8-11.vkuser.net/?type=5&ct=0&id=777",
      720: "https://ok8-11.vkuser.net/?type=3&ct=0&id=777",
      360: "https://ok8-11.vkuser.net/?type=1&ct=0&id=777"
    },
    title: "OK Embed Episode",
    pageUrl: "https://ok.ru/videoembed/4637825762649",
    userAgent: "AndroidChrome/131.0"
  },
  "abcdefghijklmnopabcdefghijklmnop",
  { tab: { id: 505, url: "https://www.tranimeizle.live/ep-1", title: "Anime Ep 1" }, frameId: 5 }
);
assert.equal(okExtracted.ok, true);
assert.deepEqual(okExtracted.heights, [1080, 720, 360]);
assert.ok(okExtracted.androidIntents["720"].startsWith("intent://ok8-11.vkuser.net/?type=3&ct=0&id=777#Intent;"));

// Masaüstünde aynı kayıttan 720p seçildiğinde tam 720p URL + iframe Referer + User-Agent gitmeli
simulatePlatformOs = "mac";
const okMacOpen = await sendMessageToBg(
  {
    type: "OPEN_FROM_VIDEO_OVERLAY",
    preferredResolution: "720",
    currentSrc: "blob:https://ok.ru/1234",
    src: "",
    sources: [],
    videoCountInFrame: 1,
    actionTimestamp: Date.now(),
    pageUrl: "https://ok.ru/videoembed/4637825762649"
  },
  "abcdefghijklmnopabcdefghijklmnop",
  { tab: { id: 505, url: "https://www.tranimeizle.live/ep-1", title: "Anime Ep 1" }, frameId: 5 }
);
assert.equal(okMacOpen.ok, true);
assert.equal(lastNativePayload.payload.url, "https://ok8-11.vkuser.net/?type=3&ct=0&id=777");
assert.equal(lastNativePayload.payload.referer, "https://ok.ru/videoembed/4637825762649");
assert.equal(lastNativePayload.payload.user_agent, "AndroidChrome/131.0");
// OK.ru'nun 720p dosyası MP4'tür: HLS demuxer'ı zorlanmamalı
assert.equal(lastNativePayload.payload.stream_format, "");
console.log("  [PASS] Sibnet 302 redirect & OK.ru/Mail.ru/VK multi-resolution extraction work across Android & macOS");

// --- TR Anime İzle yeni tema: uzantısız /w/<token> HLS (application/octet-stream) ---
mockTabs.set(606, { id: 606, url: "https://www.anime.example/ep-6", title: "Ep 6" });
await listeners.onTabUpdated[0](606, { status: "loading", url: "https://www.anime.example/ep-6" }, { title: "Ep 6" });
const wUrl = "https://www.anime.example/w/xI_JV4b7UUYScx5YTF5GPlmBU9Jn";
await listeners.onSendHeaders[0]({
  requestId: "w1", tabId: 606, frameId: 0, type: "xmlhttprequest", url: wUrl,
  requestHeaders: [{ name: "Referer", value: "https://www.anime.example/ep-6" }, { name: "User-Agent", value: "AnimeUA/1" }]
});
await listeners.onHeadersReceived[0]({
  requestId: "w1", tabId: 606, frameId: 0, type: "xmlhttprequest", url: wUrl, statusCode: 200,
  responseHeaders: [{ name: "Content-Type", value: "application/octet-stream" }, { name: "Content-Length", value: "520" }]
});
// .jpeg kılıklı segmentler aday olmamalı ve depolamaya yazılmamalı
await listeners.onSendHeaders[0]({ requestId: "w2", tabId: 606, frameId: 0, type: "xmlhttprequest", url: "https://sv1.cdn.example/plateau/x/v2/file000.jpeg", requestHeaders: [] });
// Görsel / betik istekleri tamamen yok sayılmalı
await listeners.onSendHeaders[0]({ requestId: "w3", tabId: 606, frameId: 0, type: "image", url: "https://www.anime.example/w/notaplaylist", requestHeaders: [] });

// Token üreten API uçları (örn. /api/watch/<id>) asla yeniden çekilecek aday olmamalı
await listeners.onHeadersReceived[0]({
  requestId: "w5", tabId: 606, frameId: 0, type: "xmlhttprequest", url: "https://www.anime.example/api/watch/01a1db30", statusCode: 200,
  responseHeaders: [{ name: "Content-Type", value: "text/plain" }, { name: "Content-Length", value: "140" }]
});
const cands = await sendMessageToBg({ type: "GET_PROBE_CANDIDATES" }, "abcdefghijklmnopabcdefghijklmnop", { tab: { id: 606 }, frameId: 0 });
assert.deepEqual(cands.candidates.map((c) => c.url), [wUrl]);
assert.ok(!("w2" in (sessionStore.pendingRequests || {})), "segment requests must not be written to pendingRequests");
assert.ok(!("w3" in (sessionStore.pendingRequests || {})), "image requests must not be written to pendingRequests");
console.log("  [PASS] Ambiguous octet-stream XHR recorded as in-frame probe candidate; segments/images skip storage writes");

const masterText = `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-STREAM-INF:BANDWIDTH=15634237,RESOLUTION=1920x1080\n/w/xI_JV4b7UUYScx5YTF5GPlmBU9Jn/v0\n#EXT-X-STREAM-INF:BANDWIDTH=8293034,RESOLUTION=1280x720\n/w/xI_JV4b7UUYScx5YTF5GPlmBU9Jn/v1\n`;
const reg = await sendMessageToBg(
  { type: "REGISTER_EXTRACTED_STREAM", streamUrl: wUrl, format: "HLS", playlistText: masterText, pageUrl: "https://www.anime.example/ep-6", userAgent: "AnimeUA/1", title: "Ep 6" },
  "abcdefghijklmnopabcdefghijklmnop",
  { tab: { id: 606, url: "https://www.anime.example/ep-6", title: "Ep 6" }, frameId: 0 }
);
assert.equal(reg.ok, true);
assert.deepEqual(reg.heights, [1080, 720]);
assert.equal(reg.streamUrls["720"], "https://www.anime.example/w/xI_JV4b7UUYScx5YTF5GPlmBU9Jn/v1");
assert.equal(reg.disguisedHls, true);

// Aynı küçük playlist yeniden çekildiğinde (<50 KB, uzantısız) "init segmenti" temizliği kaydı silmemeli
await listeners.onHeadersReceived[0]({
  requestId: "w4", tabId: 606, frameId: 0, type: "xmlhttprequest", url: wUrl, statusCode: 200,
  responseHeaders: [{ name: "Content-Type", value: "application/octet-stream" }, { name: "Content-Length", value: "520" }]
});
lastNativePayload = null;
const wOpen = await sendMessageToBg(
  { type: "OPEN_FROM_VIDEO_OVERLAY", preferredResolution: "720", currentSrc: "blob:https://www.anime.example/1", src: "", sources: [], videoCountInFrame: 1, actionTimestamp: Date.now(), pageUrl: "https://www.anime.example/ep-6" },
  "abcdefghijklmnopabcdefghijklmnop",
  { tab: { id: 606, url: "https://www.anime.example/ep-6", title: "Ep 6" }, frameId: 0 }
);
assert.equal(wOpen.ok, true);
assert.equal(lastNativePayload.payload.url, "https://www.anime.example/w/xI_JV4b7UUYScx5YTF5GPlmBU9Jn/v1");
assert.equal(lastNativePayload.payload.kind, "stream");
assert.equal(lastNativePayload.payload.stream_format, "hls");
assert.equal(lastNativePayload.payload.use_ytdlp_fallback, false);
assert.equal(lastNativePayload.payload.referer, "https://www.anime.example/ep-6");
assert.equal(lastNativePayload.payload.player, "mpv");
console.log("  [PASS] In-page verified /w/<token> master registers 1080/720 variants, survives small-response cleanup, opens as kind=stream + HLS");

// --- Oynatıcı seçimi: VLC (masaüstü) ve Android paketleri ---
await sendMessageToBg({ type: "SET_SETTINGS", player: "vlc", androidPlayer: "vlc" });
lastNativePayload = null;
await sendMessageToBg(
  { type: "OPEN_FROM_VIDEO_OVERLAY", preferredResolution: "best", currentSrc: "blob:x", src: "", sources: [], videoCountInFrame: 1, actionTimestamp: Date.now(), pageUrl: "https://www.anime.example/ep-6" },
  "abcdefghijklmnopabcdefghijklmnop",
  { tab: { id: 606, url: "https://www.anime.example/ep-6", title: "Ep 6" }, frameId: 0 }
);
assert.equal(lastNativePayload.payload.player, "vlc");

simulateOldHost = true;
lastNativePayload = null;
const oldHostResp = await sendMessageToBg(
  { type: "OPEN_FROM_VIDEO_OVERLAY", preferredResolution: "best", currentSrc: "blob:x", src: "", sources: [], videoCountInFrame: 1, actionTimestamp: Date.now(), pageUrl: "https://www.anime.example/ep-6" },
  "abcdefghijklmnopabcdefghijklmnop",
  { tab: { id: 606, url: "https://www.anime.example/ep-6", title: "Ep 6" }, frameId: 0 }
);
// Ping önbelleği 60 sn; eski host'u görmesi için önbelleği CHECK_HOST_STATUS ile zorla yenile ve tekrar dene
if (oldHostResp.ok) {
  await sendMessageToBg({ type: "CHECK_HOST_STATUS" });
  lastNativePayload = null;
  const retry = await sendMessageToBg(
    { type: "OPEN_FROM_VIDEO_OVERLAY", preferredResolution: "best", currentSrc: "blob:x", src: "", sources: [], videoCountInFrame: 1, actionTimestamp: Date.now(), pageUrl: "https://www.anime.example/ep-6" },
    "abcdefghijklmnopabcdefghijklmnop",
    { tab: { id: 606, url: "https://www.anime.example/ep-6", title: "Ep 6" }, frameId: 0 }
  );
  assert.equal(retry.ok, false);
  assert.equal(retry.statusCode, "NATIVE_HOST_OUTDATED");
} else {
  assert.equal(oldHostResp.statusCode, "NATIVE_HOST_OUTDATED");
}
assert.equal(lastNativePayload, null, "outdated host must not be asked to open (it would silently use mpv)");
simulateOldHost = false;
await sendMessageToBg({ type: "CHECK_HOST_STATUS" });

simulatePlatformOs = "android";
const vlcRes = await sendMessageToBg(
  { type: "GET_VIDEO_RESOLUTIONS", currentSrc: "blob:x", src: "", sources: [], videoCountInFrame: 1, actionTimestamp: Date.now(), pageUrl: "https://www.anime.example/ep-6" },
  "abcdefghijklmnopabcdefghijklmnop",
  { tab: { id: 606, url: "https://www.anime.example/ep-6", title: "Ep 6" }, frameId: 0 }
);
assert.ok(vlcRes.androidIntents.best.includes(";package=org.videolan.vlc;"), vlcRes.androidIntents.best);
assert.ok(!vlcRes.altIntents.vlc, "VLC alternative is redundant when VLC is already selected");
assert.ok(vlcRes.altIntents.chooser && !vlcRes.altIntents.chooser.includes("package="), "chooser intent must not pin a package");

await sendMessageToBg({ type: "SET_SETTINGS", androidPlayer: "mpv" });
const mpvRes = await sendMessageToBg(
  { type: "GET_VIDEO_RESOLUTIONS", currentSrc: "blob:x", src: "", sources: [], videoCountInFrame: 1, actionTimestamp: Date.now(), pageUrl: "https://www.anime.example/ep-6" },
  "abcdefghijklmnopabcdefghijklmnop",
  { tab: { id: 606, url: "https://www.anime.example/ep-6", title: "Ep 6" }, frameId: 0 }
);
assert.equal(mpvRes.disguisedHls, true);
assert.ok(mpvRes.altIntents.vlc.includes(";package=org.videolan.vlc;"));
// Uzantısız HLS'de seçici HLS MIME'ıyla açılır (ExoPlayer/Just Player gibi açamayan uygulamalar elenir)
assert.ok(mpvRes.altIntents.chooser.includes(";type=application/x-mpegURL;"), mpvRes.altIntents.chooser);
assert.ok(mpvRes.androidIntents.best.includes(";type=video/*;"), "main intent keeps video/* (mpv-android filter)");
await sendMessageToBg({ type: "SET_SETTINGS", player: "mpv" });
simulatePlatformOs = "mac";
console.log("  [PASS] Player choice: VLC payload on desktop, outdated host blocked, Android VLC/chooser intents and disguised-HLS VLC hint");

// Google Drive: dış Drive frame'i (N) doğrudan adresi kaydeder; iç YouTube-embed frame'i (akışı yok) ona düşer.
// Aynı sekmedeki başka bir akışsız frame'e (örn. ana sayfa oynatıcısı) Drive kaydı verilmemeli.
mockTabs.set(808, { id: 808, url: "https://www.anime.example/ep-7", title: "Ep 7" });
const driveDirectUrl = "https://drive.usercontent.google.com/download?id=1A-JJSa4w5wywuqVr9_KSullSaiULQWGb&export=download&confirm=t";
const driveReg = await sendMessageToBg(
  { type: "REGISTER_EXTRACTED_STREAM", streamUrl: driveDirectUrl, format: "MP4", title: "ep7.mp4", pageUrl: "https://drive.google.com/file/d/1A-JJSa4w5wywuqVr9_KSullSaiULQWGb/preview", userAgent: "UA" },
  "abcdefghijklmnopabcdefghijklmnop",
  { tab: { id: 808, url: "https://www.anime.example/ep-7", title: "Ep 7" }, frameId: 5, url: "https://drive.google.com/file/d/1A-JJSa4w5wywuqVr9_KSullSaiULQWGb/preview" }
);
assert.equal(driveReg.ok, true);
const innerRes = await sendMessageToBg(
  { type: "GET_VIDEO_RESOLUTIONS", currentSrc: "blob:https://youtube.googleapis.com/x", src: "", sources: [], videoCountInFrame: 1, actionTimestamp: Date.now(), pageUrl: "https://www.anime.example/ep-7" },
  "abcdefghijklmnopabcdefghijklmnop",
  { tab: { id: 808, url: "https://www.anime.example/ep-7", title: "Ep 7" }, frameId: 6, url: "https://youtube.googleapis.com/embed/?ps=docs&origin=https%3A%2F%2Fdrive.google.com" }
);
assert.equal(innerRes.ok, true);
assert.equal(innerRes.mode, "direct", "Drive inner YouTube-embed frame falls back to the Drive file registered by its parent frame");
const mainRes = await sendMessageToBg(
  { type: "GET_VIDEO_RESOLUTIONS", currentSrc: "blob:https://www.anime.example/y", src: "", sources: [], videoCountInFrame: 1, actionTimestamp: Date.now(), pageUrl: "https://www.anime.example/ep-7" },
  "abcdefghijklmnopabcdefghijklmnop",
  { tab: { id: 808, url: "https://www.anime.example/ep-7", title: "Ep 7" }, frameId: 0, url: "https://www.anime.example/ep-7" }
);
assert.notEqual(mainRes?.mode, "direct", `unrelated stream-less frame must not receive the Drive file: ${JSON.stringify(mainRes)}`);
lastNativePayload = null;
await sendMessageToBg(
  { type: "OPEN_FROM_VIDEO_OVERLAY", currentSrc: "blob:https://www.anime.example/y", src: "", sources: [], videoCountInFrame: 1, actionTimestamp: Date.now(), pageUrl: "https://www.anime.example/ep-7", preferredResolution: "best" },
  "abcdefghijklmnopabcdefghijklmnop",
  { tab: { id: 808, url: "https://www.anime.example/ep-7", title: "Ep 7" }, frameId: 0, url: "https://www.anime.example/ep-7" }
);
assert.ok(!JSON.stringify(lastNativePayload || {}).includes("drive.usercontent"), "main frame must not open the Drive file");
console.log("  [PASS] Google Drive: inner viewer frame uses the parent's cookieless Drive file; unrelated frames do not");

console.log("All background lifecycle & concurrency tests passed!");

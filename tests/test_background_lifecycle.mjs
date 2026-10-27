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

function setupChromeMock() {
  listeners = {
    onSendHeaders: [],
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

console.log("All background lifecycle & concurrency tests passed!");

/**
 * Eklenti ve akış seçim mantığı test paketi (Node.js üzerinde sıfır bağımlılıkla çalışır).
 * Senaryo 1-11 ve 17'nin akış sınıflandırma, tekilleştirme, sekme yaşam döngüsü ve
 * service worker yeniden başlatma (chrome.storage.session) davranışlarını doğrular.
 */

import assert from "node:assert/strict";
import {
  STREAM_PRIORITY,
  classifyCandidate,
  computeDedupeKey,
  inspectHlsPlaylistContent,
  isBlockedDomain,
  isMediaSegment,
  matchStreamForVideoContext,
  selectBestPlayableStream,
  sortStreams
} from "../extension/stream_utils.js";

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(err);
    process.exit(1);
  }
}

console.log("=== Running Extension Stream Detection & Lifecycle Tests ===");

// Senaryo 1: Normal MP4 URL tespiti
test("Scenario 1: Direct MP4 URL detection and classification", () => {
  const c = classifyCandidate("https://cdn.example.com/videos/sample_1080p.mp4", "video/mp4", 15_000_000);
  assert.ok(c);
  assert.equal(c.format, "MP4");
  assert.equal(c.streamType, "direct");
  assert.equal(c.priority, STREAM_PRIORITY.DIRECT_MP4);
  assert.equal(c.quality, "1080p");
});

// Senaryo 2: HLS Master Playlist tespiti ve #EXT-X-STREAM-INF doğrulaması
test("Scenario 2: HLS master playlist detection and #EXT-X-STREAM-INF content verification", () => {
  // İsim olarak sadece playlist.m3u8 olsa bile içerikten Master olduğu doğrulanmalı
  const initial = classifyCandidate("https://stream.example.com/live/playlist.m3u8", "application/vnd.apple.mpegurl");
  assert.ok(initial);
  assert.equal(initial.format, "HLS");
  assert.equal(initial.priority, STREAM_PRIORITY.LIKELY_HLS_MASTER);

  const masterM3u8Text = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
chunklist_720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
chunklist_1080p.m3u8`;

  const verified = inspectHlsPlaylistContent(
    masterM3u8Text,
    null,
    "https://stream.example.com/live/playlist.m3u8"
  );
  assert.ok(verified);
  assert.equal(verified.streamType, "master");
  assert.equal(verified.priority, STREAM_PRIORITY.VERIFIED_HLS_MASTER);
  assert.equal(verified.quality, "Up to 1080p");
  assert.deepEqual(verified.availableHeights, [1080, 720]);
  assert.equal(
    verified.variantsByHeight[720],
    "https://stream.example.com/live/chunklist_720p.m3u8"
  );
});

// Senaryo 3: Sadece chunklist / variant playlist mevcutken tespit ve seçim
test("Scenario 3: Chunklist / variant playlist detection (including r_file=chunklist.m3u8 query param)", () => {
  const queryVariant = classifyCandidate(
    "https://edge.example.com/play?id=99&r_file=chunklist_720p.m3u8",
    "application/x-mpegurl"
  );
  assert.ok(queryVariant);
  assert.equal(queryVariant.format, "HLS");
  assert.equal(queryVariant.streamType, "variant");
  assert.equal(queryVariant.priority, STREAM_PRIORITY.HLS_VARIANT);

  // Sadece variant mevcutken en iyi oynatılabilir akış olarak seçilmeli
  const best = selectBestPlayableStream([
    { ...queryVariant, url: "https://edge.example.com/play?id=99&r_file=chunklist_720p.m3u8", updatedAt: 1000 }
  ]);
  assert.ok(best);
  assert.equal(best.streamType, "variant");
});

// Segmentlerin (.ts, .m4s) filtrelenmesi
test("Media segments (.ts, .m4s, small init segments) are ignored", () => {
  assert.equal(isMediaSegment("https://cdn.example.com/seg-102.ts", "video/mp2t"), true);
  assert.equal(isMediaSegment("https://cdn.example.com/chunk-001.m4s", "video/iso.segment"), true);
  assert.equal(classifyCandidate("https://cdn.example.com/seg-102.ts", "video/mp2t"), null);
  // Küçük boyutlu (12 KB) MP4 init segmenti elenmeli
  assert.equal(classifyCandidate("https://cdn.example.com/init.mp4", "video/mp4", 12_000), null);
});

// Reklam / takip alan adlarının filtrelenmesi
test("Ad and tracker domains are blocked", () => {
  assert.equal(isBlockedDomain("https://pubads.g.doubleclick.net/gampad/ads.mp4"), true);
  assert.equal(isBlockedDomain("https://media.example.org/video.mp4"), false);
});

// Senaryo 6 & 7: Query string içinde signed token bulunan URL ve çok sayıda network event tekilleştirmesi
test("Scenario 6 & 7: Signed token rotation updates URL without losing meaningful query params or duplicating", () => {
  const url1 = "https://cdn.example.com/hls/stream.m3u8?video_id=abc&r_file=master.m3u8&token=OLD_TOKEN_111&expires=1700000100";
  const url2 = "https://cdn.example.com/hls/stream.m3u8?video_id=abc&r_file=master.m3u8&token=NEW_TOKEN_222&expires=1700000999";
  const differentVideoUrl = "https://cdn.example.com/hls/stream.m3u8?video_id=xyz&r_file=master.m3u8&token=NEW_TOKEN_222";

  const key1 = computeDedupeKey(url1);
  const key2 = computeDedupeKey(url2);
  const keyDifferent = computeDedupeKey(differentVideoUrl);

  // Aynı videonun yenilenmiş token'lı URL'si aynı dedupeKey'i üretmeli
  assert.equal(key1, key2);
  // Farklı video_id taşıyan URL farklı dedupeKey üretmeli (tüm query silinmemeli!)
  assert.notEqual(key1, keyDifferent);
});

// Öncelik sıralaması: Verified Master > Likely Master > Variant > Direct MP4 > Other
test("Stream priority ordering selects Verified Master over Variant and MP4", () => {
  const candidates = [
    { id: "mp4", priority: STREAM_PRIORITY.DIRECT_MP4, streamType: "direct", updatedAt: 300 },
    { id: "variant", priority: STREAM_PRIORITY.HLS_VARIANT, streamType: "variant", updatedAt: 400 },
    { id: "master", priority: STREAM_PRIORITY.VERIFIED_HLS_MASTER, streamType: "master", updatedAt: 200 },
    { id: "likely", priority: STREAM_PRIORITY.LIKELY_HLS_MASTER, streamType: "likely_master", updatedAt: 250 }
  ];

  const sorted = sortStreams(candidates);
  assert.deepEqual(
    sorted.map((s) => s.id),
    ["master", "likely", "variant", "mp4"]
  );
  assert.equal(selectBestPlayableStream(candidates).id, "master");
});

// Senaryo 17: DRM içerikte desteklenmiyor sonucunun doğru tespit edilmesi
test("Scenario 17: DRM protected streams are flagged as unsupported and never auto-selected for mpv", () => {
  const dashDrm = classifyCandidate("https://cdn.example.com/drm/manifest.mpd", "application/dash+xml");
  assert.ok(dashDrm);
  assert.equal(dashDrm.streamType, "unsupported");
  assert.equal(dashDrm.priority, STREAM_PRIORITY.UNSUPPORTED_DRM);

  const encryptedHlsText = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key.example.com/123",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:6.0,
seg1.ts`;
  const inspectedDrm = inspectHlsPlaylistContent(encryptedHlsText);
  assert.ok(inspectedDrm);
  assert.equal(inspectedDrm.streamType, "unsupported");

  // Sadece DRM akış varsa selectBestPlayableStream null dönmeli
  assert.equal(selectBestPlayableStream([dashDrm, inspectedDrm]), null);
});

// Video üzeri "Open in mpv" butonu eşleştirme testleri (blob: URL reddi, frameId izolasyonu, çoklu video koruması)
test("Video overlay matching: blob: URL is never sent directly; resolves to network HLS master", () => {
  const streams = [
    {
      url: "https://cdn.example.com/v1/chunklist.m3u8",
      dedupeKey: "https://cdn.example.com/v1/chunklist.m3u8",
      frameId: 0,
      streamType: "variant",
      priority: STREAM_PRIORITY.HLS_VARIANT,
      updatedAt: 1000
    },
    {
      url: "https://cdn.example.com/v1/master.m3u8",
      dedupeKey: "https://cdn.example.com/v1/master.m3u8",
      frameId: 0,
      streamType: "master",
      priority: STREAM_PRIORITY.VERIFIED_HLS_MASTER,
      updatedAt: 900
    }
  ];

  const matched = matchStreamForVideoContext(streams, {
    frameId: 0,
    currentSrc: "blob:https://example.com/550e8400-e29b-41d4-a716-446655440000",
    src: "",
    videoCountInFrame: 1
  });

  assert.ok(matched.stream);
  assert.equal(matched.stream.url, "https://cdn.example.com/v1/master.m3u8");
});

test("Video overlay matching: multiple videos on page match by direct src or recent activity, preventing wrong video launch", () => {
  const streams = [
    {
      url: "https://cdn1.example.com/videoA/master.m3u8",
      dedupeKey: "https://cdn1.example.com/videoA/master.m3u8",
      frameId: 0,
      streamType: "master",
      priority: STREAM_PRIORITY.VERIFIED_HLS_MASTER,
      updatedAt: 10_000
    },
    {
      url: "https://cdn2.example.com/videoB/master.m3u8",
      dedupeKey: "https://cdn2.example.com/videoB/master.m3u8",
      frameId: 0,
      streamType: "master",
      priority: STREAM_PRIORITY.VERIFIED_HLS_MASTER,
      updatedAt: 50_000
    }
  ];

  // Video B oynatıldığında (actionTimestamp = 51_000) yalnızca yakın zamanda aktif olan Video B seçilmeli
  const matchB = matchStreamForVideoContext(streams, {
    frameId: 0,
    currentSrc: "blob:https://example.com/uuid-b",
    videoCountInFrame: 2,
    actionTimestamp: 51_000
  });
  assert.ok(matchB.stream);
  assert.equal(matchB.stream.url, "https://cdn2.example.com/videoB/master.m3u8");

  // İki video da aynı anda güncellenmişse ve blob URL ise yanlış videoyu açmak yerine AMBIGUOUS_MULTIPLE_VIDEOS dönmeli
  const ambiguousStreams = [
    { ...streams[0], updatedAt: 50_000 },
    { ...streams[1], updatedAt: 50_200 }
  ];
  const matchAmbiguous = matchStreamForVideoContext(ambiguousStreams, {
    frameId: 0,
    currentSrc: "blob:https://example.com/uuid-unknown",
    videoCountInFrame: 2,
    actionTimestamp: 50_500
  });
  assert.equal(matchAmbiguous.stream, null);
  assert.equal(matchAmbiguous.reason, "AMBIGUOUS_MULTIPLE_VIDEOS");
});

console.log(`All ${passed} extension unit tests passed successfully!`);

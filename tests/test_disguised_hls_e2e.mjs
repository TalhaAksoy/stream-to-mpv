/**
 * Uçtan uca (gerçek Chromium + gerçek eklenti + gerçek native host + gerçek mpv) test:
 * TR Anime İzle'nin yeni temasındaki yapı yerel fixture ile taklit edilir.
 *
 *  1) /episode : hls.js oynatıcı, uzantısız /w/<token> master playlist (application/octet-stream),
 *     .jpeg kılıklı TS segmentleri. Eski sürümde "Play the video first" hatası veriyordu.
 *  2) /wrapper : cross-origin sarmalayıcı iframe; kaynak yalnızca JWPlayer benzeri nesnede (page_probe.js).
 *  3) Sıkı Referer: /w/R... token'ı Referer olmadan 403 döner; mpv'ye doğru Referer aktarılmalı.
 *
 * Gereksinimler: chromium, mpv, ffmpeg, python3 ve internet (hls.js CDN). Eksikse test atlanır.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT_ID = "haamijddaadhbhjfpblfloidmpglfmnk"; // manifest.json "key" alanından türeyen sabit kimlik

function which(bin) {
  const r = spawnSync("bash", ["-lc", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

const chromiumBin = which("chromium") || which("chromium-browser") || which("google-chrome");
const mpvBin = which("mpv");
const cvlcBin = which("cvlc");
if (!chromiumBin || !mpvBin || !which("ffmpeg")) {
  console.log("=== Disguised HLS E2E: SKIPPED (chromium / mpv / ffmpeg not found) ===");
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stm-e2e-"));
const port = 18000 + Math.floor(Math.random() * 2000);
const cdpPort = 19500 + Math.floor(Math.random() * 400);

// 1. Fixture sunucusu
const fixture = spawn("python3", [path.join(ROOT, "tests/fixtures/disguised_hls_server.py"), String(port), path.join(tmp, "media")], {
  stdio: ["ignore", "pipe", "inherit"]
});
await new Promise((resolve, reject) => {
  fixture.stdout.on("data", (d) => String(d).includes("Fixture ready") && resolve());
  fixture.on("exit", (c) => reject(new Error(`fixture exited ${c}`)));
});

// 2. mpv sarmalayıcısı: argümanları kaydeder ve gerçek mpv'yi görüntüsüz (vo=null) birkaç kare oynatır
const wrapDir = path.join(tmp, "bin");
fs.mkdirSync(wrapDir);
const runLog = path.join(tmp, "runs");
fs.mkdirSync(runLog);
fs.writeFileSync(
  path.join(wrapDir, "mpv"),
  `#!/usr/bin/env bash
n=$(date +%s%N)
printf '%s\\n' "$@" > "${runLog}/$n.args"
args=()
for a in "$@"; do case "$a" in --no-terminal|--force-window*) ;; *) args+=("$a");; esac; done
"${mpvBin}" --no-config --vo=null --ao=null --frames=30 --msg-level=all=info "\${args[@]}" > "${runLog}/$n.out" 2>&1
echo $? > "${runLog}/$n.exit"
`,
  { mode: 0o755 }
);

// VLC sarmalayıcısı (VLC kuruluysa): argümanları kaydeder, gerçek VLC'yi pencere açmadan (cvlc, dummy çıkış) oynatır
if (cvlcBin) {
  fs.writeFileSync(
    path.join(wrapDir, "vlc"),
    `#!/usr/bin/env bash
n=vlc-$(date +%s%N)
printf '%s\\n' "$@" > "${runLog}/$n.args"
timeout 25 "${cvlcBin}" -I dummy --vout=dummy --aout=dummy --avcodec-hw=none --play-and-exit --run-time=5 -vv "$@" > "${runLog}/$n.out" 2>&1
echo $? > "${runLog}/$n.exit"
`,
    { mode: 0o755 }
  );
}

// 3. Geçici Chromium profiline native host manifesti (kullanıcının ~/.config dizinine dokunulmaz)
const udd = path.join(tmp, "profile");
const nmDir = path.join(udd, "NativeMessagingHosts");
fs.mkdirSync(nmDir, { recursive: true });
const hostManifest = path.join(nmDir, "com.talha.mpv.json");
fs.writeFileSync(
  hostManifest,
  JSON.stringify({
    name: "com.talha.mpv",
    description: "test",
    path: path.join(ROOT, "native/mpv_host.py"),
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXT_ID}/`]
  })
);

const home = os.homedir();
const envPath = [wrapDir, `${home}/.local/bin`, "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/Applications/mpv.app/Contents/MacOS", "/usr/bin", "/bin"].join(":");
const chrome = spawn(
  chromiumBin,
  [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${udd}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1280,900",
    `--disable-extensions-except=${path.join(ROOT, "extension")}`,
    `--load-extension=${path.join(ROOT, "extension")}`,
    "about:blank"
  ],
  { env: { ...process.env, PATH: envPath, MPV_HOST_MANIFEST_PATH: hostManifest }, stdio: "ignore" }
);

let ws;
let msgId = 0;
const pending = new Map();
const sessions = new Map(); // sessionId -> targetInfo
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function cleanup() {
  try { ws?.close(); } catch {}
  try { chrome.kill("SIGKILL"); } catch {}
  try { fixture.kill(); } catch {}
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

async function evalIn(sessionId, expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  return r.result?.value;
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`Timeout waiting for ${label}`);
}

function listRuns() {
  return fs.readdirSync(runLog).filter((f) => f.endsWith(".exit")).map((f) => f.replace(".exit", "")).sort();
}

async function clickMpvAndPick(sessionId, label) {
  await waitFor(
    () => evalIn(sessionId, `!!document.querySelector('[data-mpv-control-host]')?.shadowRoot?.querySelector('.mpv-trigger')`),
    15000,
    "mpv button"
  );
  await evalIn(sessionId, `document.querySelector('[data-mpv-control-host]').shadowRoot.querySelector('.mpv-trigger').click()`);
  const items = await waitFor(
    () => evalIn(sessionId, `(() => { const r = document.querySelector('[data-mpv-control-host]').shadowRoot; const m = r.querySelector('.mpv-menu.open'); return m ? [...m.querySelectorAll('.mpv-item')].map(e => e.textContent.trim()) : null; })()`),
    15000,
    "resolution menu"
  );
  const ok = await evalIn(
    sessionId,
    `(() => { const r = document.querySelector('[data-mpv-control-host]').shadowRoot; const it = [...r.querySelectorAll('.mpv-menu.open .mpv-item')].find(e => e.textContent.includes(${JSON.stringify(label)})); if (!it) return false; it.click(); return true; })()`
  );
  return { items, clicked: ok };
}

async function readNewRun(before, timeoutMs = 30000) {
  const id = await waitFor(() => Promise.resolve(listRuns().find((r) => !before.includes(r))), timeoutMs, "mpv run");
  const args = fs.readFileSync(path.join(runLog, `${id}.args`), "utf8").trim().split("\n");
  const exit = fs.readFileSync(path.join(runLog, `${id}.exit`), "utf8").trim();
  const out = fs.readFileSync(path.join(runLog, `${id}.out`), "utf8");
  return { args, exit, out };
}

try {
  console.log("=== Running Disguised HLS (/w/<token>, octet-stream, .jpeg segments) Real Chromium + mpv E2E Test ===");
  const version = await waitFor(async () => (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(), 15000, "chromium");
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    if (m.method === "Target.attachedToTarget") {
      sessions.set(m.params.sessionId, m.params.targetInfo);
      await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, m.params.sessionId).catch(() => {});
      await send("Runtime.runIfWaitingForDebugger", {}, m.params.sessionId).catch(() => {});
    }
    if (m.method === "Target.detachedFromTarget") sessions.delete(m.params.sessionId);
    if (m.method === "Runtime.consoleAPICalled" && process.env.STM_DEBUG) console.log("   console:", m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 900));
  };

  if (process.env.STM_DEBUG) {
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const { targetInfos } = await send("Target.getTargets");
    for (const t of targetInfos.filter((t) => t.type === "service_worker")) {
      const { sessionId: swSid } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      await send("Runtime.enable", {}, swSid);
    }
  }
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  if (process.env.STM_DEBUG) await send("Runtime.enable", {}, sessionId);
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);

  // --- Senaryo 1: uzantısız octet-stream HLS + 720p seçimi ---
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/episode?t=AbC123tok` }, sessionId);
  await waitFor(() => evalIn(sessionId, `(document.querySelector('video')?.currentTime || 0) > 0.3`), 25000, "hls.js playback");
  let before = listRuns();
  let res = await clickMpvAndPick(sessionId, "720p");
  assert.ok(res.clicked, `720p option missing; menu=${JSON.stringify(res.items)}`);
  assert.ok(res.items.some((t) => t.includes("360p")), `menu should list master variants: ${JSON.stringify(res.items)}`);
  let run = await readNewRun(before);
  assert.equal(run.args.at(-1), `http://127.0.0.1:${port}/w/AbC123tok/v0`, `mpv URL: ${run.args.at(-1)}`);
  assert.ok(run.args.includes(`--referrer=http://127.0.0.1:${port}/episode?t=AbC123tok`), `referrer: ${run.args.join(" ")}`);
  assert.ok(!run.args.some((a) => a.startsWith("--ytdl-format")), "stream must not go through ytdl_hook");
  assert.equal(run.exit, "0", `mpv failed:\n${run.out.slice(-1500)}`);
  assert.ok(run.args.includes("--demuxer-lavf-format=hls"), `HLS demuxer must be forced: ${run.args.join(" ")}`);
  assert.doesNotMatch(run.out, /Not detecting m3u8|Playing: .*\.jpeg/, `ffmpeg must play it as HLS, not as a segment playlist:\n${run.out.slice(-800)}`);
  assert.match(run.out, /--vid=1/, `mpv should open a video track:\n${run.out.slice(-800)}`);
  console.log("  [PASS] Extensionless octet-stream /w/<token> master discovered in-page; real mpv played 720p variant (.jpeg segments)");

  // --- Senaryo 2: Referer zorunlu token (R...) -> mpv'ye Referer aktarılmalı ve oynamalı ---
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/episode?t=RstrictTok` }, sessionId);
  await waitFor(() => evalIn(sessionId, `(document.querySelector('video')?.currentTime || 0) > 0.3`), 25000, "strict playback");
  before = listRuns();
  res = await clickMpvAndPick(sessionId, "Auto");
  assert.ok(res.clicked, `Auto option missing; menu=${JSON.stringify(res.items)}`);
  run = await readNewRun(before);
  assert.equal(run.args.at(-1), `http://127.0.0.1:${port}/w/RstrictTok`);
  assert.equal(run.exit, "0", `mpv failed on strict Referer stream:\n${run.out.slice(-1500)}`);
  console.log("  [PASS] Referer-locked token stream (403 without Referer) played in real mpv with captured Referer");

  // --- Senaryo 3: cross-origin sarmalayıcı iframe, kaynak yalnızca JWPlayer API'sinde ---
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/wrapper?eh=http://localhost:${port}` }, sessionId);
  const embedSession = await waitFor(
    async () => {
      for (const [sid, t] of sessions.entries()) {
        if (t.type !== "iframe") continue;
        const href = await evalIn(sid, "location.href").catch(() => "");
        if (String(href).includes("/embed/")) return sid;
      }
      return null;
    },
    20000,
    "cross-origin embed iframe target"
  ).catch((e) => {
    console.error("   attached targets:", JSON.stringify([...sessions.values()].map((t) => [t.type, t.url])));
    throw e;
  });
  await waitFor(() => evalIn(embedSession, `(document.querySelector('video')?.currentTime || 0) > 0.3`), 25000, "embed playback");
  // page_probe.js (MAIN world) JWPlayer kaynağını gerçekten raporluyor mu?
  const probeReply = await evalIn(
    embedSession,
    `new Promise((resolve) => { document.addEventListener("stream-to-mpv:probe-response", (e) => resolve(e.detail), { once: true }); document.dispatchEvent(new CustomEvent("stream-to-mpv:probe-request", { detail: "t1" })); setTimeout(() => resolve(null), 1000); })`
  );
  const probeData = JSON.parse(probeReply || "{}");
  assert.ok(
    probeData.sources?.some((x) => x.player === "jwplayer" && x.type === "hls" && x.url.endsWith("/hls2/RHVHcFVx?gt=cFhTYWQy")),
    `page_probe.js should report the JWPlayer source: ${probeReply}`
  );
  before = listRuns();
  res = await clickMpvAndPick(embedSession, "Auto");
  assert.ok(res.clicked, `Auto option missing in embed; menu=${JSON.stringify(res.items)}`);
  run = await readNewRun(before);
  assert.equal(run.args.at(-1), `http://localhost:${port}/hls2/RHVHcFVx?gt=cFhTYWQy`, `embed mpv URL: ${run.args.at(-1)}`);
  assert.equal(run.exit, "0", `mpv failed on wrapped embed:\n${run.out.slice(-1500)}`);
  console.log("  [PASS] Cross-origin wrapper iframe (JWPlayer config only) resolved via page_probe.js and played in real mpv");

  // --- Senaryo 4: Oynatıcı olarak VLC seçili -> native host gerçek VLC'yi Referer ile başlatmalı ---
  if (cvlcBin) {
    const { targetInfos } = await send("Target.getTargets");
    const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.includes(EXT_ID));
    assert.ok(sw, "extension service worker target not found");
    const { sessionId: swSession } = await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
    await evalIn(swSession, `chrome.storage.local.set({ player: "vlc" }).then(() => true)`);

    await send("Page.navigate", { url: `http://127.0.0.1:${port}/episode?t=RvlcStrict` }, sessionId);
    await waitFor(() => evalIn(sessionId, `(document.querySelector('video')?.currentTime || 0) > 0.3`), 25000, "vlc scenario playback");
    before = listRuns();
    res = await clickMpvAndPick(sessionId, "720p");
    assert.ok(res.clicked, `720p missing; menu=${JSON.stringify(res.items)}`);
    run = await readNewRun(before, 45000);
    assert.ok(run.args.includes(`--http-referrer=http://127.0.0.1:${port}/episode?t=RvlcStrict`), `vlc args: ${run.args.join(" ")}`);
    // VLC 3 ignores a global --http-user-agent; the host passes it as an input option right after the URL
    assert.ok(run.args.at(-1).startsWith(":http-user-agent="), run.args.join(" "));
    assert.equal(run.args.at(-2), `http://127.0.0.1:${port}/w/RvlcStrict/v0`);
    assert.doesNotMatch(run.out, /HTTP 403/, "VLC must not hit 403 (Referer must be passed)");
    assert.match(run.out, /Received first picture/, `real VLC should decode video:\n${run.out.slice(-1500)}`);
    await evalIn(swSession, `chrome.storage.local.set({ player: "mpv" }).then(() => true)`);
    console.log("  [PASS] Player=VLC: extension -> native host -> real VLC played Referer-locked /w/<token> 720p variant");
  } else {
    console.log("  [SKIP] VLC not installed; real VLC scenario skipped");
  }

  console.log("All disguised HLS E2E tests passed!");
  await cleanup();
  process.exit(0);
} catch (err) {
  console.error("  [FAIL]", err?.stack || err);
  for (const f of fs.existsSync(runLog) ? fs.readdirSync(runLog) : []) {
    if (f.endsWith(".args")) console.error("   run", f, fs.readFileSync(path.join(runLog, f), "utf8").replace(/\n/g, " "));
  }
  await cleanup();
  process.exit(1);
}

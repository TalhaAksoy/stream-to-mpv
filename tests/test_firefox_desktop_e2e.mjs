/**
 * Masaüstü Firefox (Linux / macOS) uçtan uca testi — WebDriver BiDi ile:
 *  - Eklenti geçici olarak yüklenir (webExtension.install), native host geçici HOME altındaki
 *    ~/.mozilla/native-messaging-hosts manifestiyle bulunur (kullanıcının ev dizinine dokunulmaz).
 *  - Uzantısız /w/<token> (application/octet-stream) HLS sayfa içinde keşfedilir, gerçek mpv ile oynatılır.
 *
 * Gereksinimler: firefox, mpv, ffmpeg, python3, internet (hls.js CDN). Eksikse atlanır.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const which = (bin) => {
  const r = spawnSync("bash", ["-lc", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
};
const firefoxBin = which("firefox");
const mpvBin = which("mpv");
if (!firefoxBin || !mpvBin || !which("ffmpeg")) {
  console.log("=== Firefox Desktop E2E: SKIPPED (firefox / mpv / ffmpeg not found) ===");
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stm-ff-"));
const port = 20500 + Math.floor(Math.random() * 1500);
const bidiPort = 22500 + Math.floor(Math.random() * 500);

const fixture = spawn("python3", [path.join(ROOT, "tests/fixtures/disguised_hls_server.py"), String(port), path.join(tmp, "media")], {
  stdio: ["ignore", "pipe", "inherit"]
});
await new Promise((resolve, reject) => {
  fixture.stdout.on("data", (d) => String(d).includes("Fixture ready") && resolve());
  fixture.on("exit", (c) => reject(new Error(`fixture exited ${c}`)));
});

// Sahte HOME: native host gerçek kurulum betiğiyle (native/install.sh) kurulur, böylece Firefox'un
// kurulan konumu bulup çalıştırdığı da test edilir. Veri klasöründe bilerek boşluk var (macOS'taki
// "Application Support" gibi); kullanıcının gerçek ayar klasörlerine yazılmaması için XDG_* sahte HOME'a sabitlenir.
const home = path.join(tmp, "home");
const nmDir = path.join(home, ".mozilla", "native-messaging-hosts");
const installEnv = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, "App Data")
};
fs.mkdirSync(path.join(home, ".mozilla"), { recursive: true });
fs.mkdirSync(path.join(home, "mpv_host"), { recursive: true });
fs.writeFileSync(path.join(home, "mpv_host", "mpv_host.py"), "# eski (1.2.1) kurulum\n");
fs.writeFileSync(path.join(home, "mpv_host", "com.talha.mpv.json"), "{}\n");
const install = spawnSync("bash", [path.join(ROOT, "native/install.sh")], { env: installEnv, encoding: "utf8" });
assert.equal(install.status, 0, install.stderr + install.stdout);
const installedHost = path.join(home, "App Data", "stream-to-mpv", "mpv_host.py");
const ffManifest = JSON.parse(fs.readFileSync(path.join(nmDir, "com.talha.mpv.json"), "utf8"));
assert.equal(ffManifest.path, installedHost, "Firefox manifest must point at the installed host");
assert.deepEqual(ffManifest.allowed_extensions, ["stream-to-mpv@talha.dev"]);
assert.equal(fs.readFileSync(installedHost, "utf8"), fs.readFileSync(path.join(ROOT, "native/mpv_host.py"), "utf8"));
assert.ok(!fs.existsSync(path.join(home, "mpv_host")), "legacy ~/mpv_host must be migrated away");
assert.ok(!fs.existsSync(path.join(home, ".config", "thorium")), "no folders for browsers that are not installed");
assert.ok(!fs.existsSync(path.join(home, ".librewolf")), "no folders for browsers that are not installed");
const binDir = path.join(tmp, "bin");
const runLog = path.join(tmp, "runs");
fs.mkdirSync(binDir);
fs.mkdirSync(runLog);
fs.writeFileSync(
  path.join(binDir, "mpv"),
  `#!/usr/bin/env bash
n=$(date +%s%N)
printf '%s\\n' "$@" > "${runLog}/$n.args"
args=()
for a in "$@"; do case "$a" in --no-terminal|--force-window*) ;; *) args+=("$a");; esac; done
"${mpvBin}" --no-config --vo=null --ao=null --frames=30 "\${args[@]}" > "${runLog}/$n.out" 2>&1
echo $? > "${runLog}/$n.exit"
`,
  { mode: 0o755 }
);

const profile = path.join(tmp, "profile");
fs.mkdirSync(profile);
fs.writeFileSync(
  path.join(profile, "user.js"),
  [
    'user_pref("media.autoplay.default", 0);',
    'user_pref("media.autoplay.blocking_policy", 0);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("extensions.autoDisableScopes", 0);'
  ].join("\n")
);

const envPath = [binDir, `${home}/.local/bin`, "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/Applications/mpv.app/Contents/MacOS", "/usr/bin", "/bin"].join(":");
const ff = spawn(firefoxBin, ["--headless", "--no-remote", "--profile", profile, `--remote-debugging-port=${bidiPort}`, "about:blank"], {
  env: { ...process.env, HOME: home, PATH: envPath, MOZ_HEADLESS: "1" },
  stdio: "ignore"
});

let ws;
let msgId = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

async function cleanup() {
  try { ws?.close(); } catch {}
  try { ff.kill("SIGKILL"); } catch {}
  try { fixture.kill(); } catch {}
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
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

let context;
async function evaluate(expression) {
  const r = await send("script.evaluate", { expression, target: { context }, awaitPromise: true, resultOwnership: "none" });
  if (r.type === "exception") throw new Error(r.exceptionDetails?.text || "eval exception");
  const v = r.result;
  return v?.type === "boolean" || v?.type === "number" || v?.type === "string" ? v.value : v?.type === "null" || v?.type === "undefined" ? null : v?.value;
}

const listRuns = () =>
  fs.readdirSync(runLog).filter((f) => f.endsWith(".exit")).map((f) => f.replace(".exit", "")).sort();

async function clickAndPick(label) {
  await waitFor(() => evaluate(`!!document.querySelector('[data-mpv-control-host]')?.shadowRoot?.querySelector('.mpv-trigger')`), 15000, "mpv button");
  await evaluate(`document.querySelector('[data-mpv-control-host]').shadowRoot.querySelector('.mpv-trigger').click()`);
  const items = await waitFor(
    () => evaluate(`(() => { const m = document.querySelector('[data-mpv-control-host]').shadowRoot.querySelector('.mpv-menu.open'); return m ? JSON.stringify([...m.querySelectorAll('.mpv-item')].map(e => e.textContent.trim())) : null; })()`),
    20000,
    "menu"
  );
  const clicked = await evaluate(
    `(() => { const it = [...document.querySelector('[data-mpv-control-host]').shadowRoot.querySelectorAll('.mpv-menu.open .mpv-item')].find(e => e.textContent.includes(${JSON.stringify(label)})); if (!it) return false; it.click(); return true; })()`
  );
  return { items: JSON.parse(items), clicked };
}

try {
  console.log("=== Running Desktop Firefox (WebDriver BiDi) Disguised HLS E2E Test ===");
  ws = await waitFor(async () => {
    const sock = new WebSocket(`ws://127.0.0.1:${bidiPort}/session`);
    await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
    return sock;
  }, 30000, "firefox bidi");
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.type === "error" ? p.reject(new Error(`${m.error}: ${m.message}`)) : p.resolve(m.result);
    }
  };
  await send("session.new", { capabilities: {} });
  await send("webExtension.install", { extensionData: { type: "path", path: path.join(ROOT, "extension") } });
  const tree = await send("browsingContext.getTree", {});
  context = tree.contexts[0].context;
  await send("browsingContext.setViewport", { context, viewport: { width: 1280, height: 860 } });

  // --- mpv ---
  await send("browsingContext.navigate", { context, url: `http://127.0.0.1:${port}/episode?t=FfTok42`, wait: "complete" });
  await waitFor(() => evaluate(`(document.querySelector('video')?.currentTime || 0) > 0.3`), 30000, "playback");
  let before = listRuns();
  let res = await clickAndPick("720p");
  assert.ok(res.clicked, `720p missing: ${JSON.stringify(res.items)}`);
  const runId = await waitFor(() => Promise.resolve(listRuns().find((r) => !before.includes(r))), 30000, "mpv run");
  const args = fs.readFileSync(path.join(runLog, `${runId}.args`), "utf8").trim().split("\n");
  const out = fs.readFileSync(path.join(runLog, `${runId}.out`), "utf8");
  assert.equal(args.at(-1), `http://127.0.0.1:${port}/w/FfTok42/v0`);
  assert.ok(args.includes("--demuxer-lavf-format=hls"), args.join(" "));
  assert.ok(args.some((a) => a.startsWith("--referrer=http://127.0.0.1:")), args.join(" "));
  assert.equal(fs.readFileSync(path.join(runLog, `${runId}.exit`), "utf8").trim(), "0", out.slice(-1200));
  assert.match(out, /--vid=1/);
  console.log("  [PASS] Firefox: extensionless /w/<token> HLS discovered in-page and played in real mpv (720p, forced HLS demuxer)");

  // --- Cross-origin sarmalayıcı iframe (kaynak yalnızca JWPlayer API'sinde) ---
  await send("browsingContext.navigate", { context, url: `http://127.0.0.1:${port}/wrapper?eh=http://localhost:${port}`, wait: "complete" });
  const topContext = context;
  context = await waitFor(async () => {
    const t = await send("browsingContext.getTree", { root: topContext });
    const child = (t.contexts[0].children || []).find((c) => String(c.url).includes("/embed/"));
    return child?.context || null;
  }, 20000, "embed iframe context");
  await waitFor(() => evaluate(`(document.querySelector('video')?.currentTime || 0) > 0.3`), 30000, "embed playback");
  before = listRuns();
  res = await clickAndPick("Auto");
  assert.ok(res.clicked, `Auto missing in embed: ${JSON.stringify(res.items)}`);
  const embedRun = await waitFor(() => Promise.resolve(listRuns().find((r) => !before.includes(r))), 30000, "embed mpv run");
  const embedArgs = fs.readFileSync(path.join(runLog, `${embedRun}.args`), "utf8").trim().split("\n");
  assert.equal(embedArgs.at(-1), `http://localhost:${port}/hls2/RHVHcFVx?gt=cFhTYWQy`);
  assert.equal(fs.readFileSync(path.join(runLog, `${embedRun}.exit`), "utf8").trim(), "0", fs.readFileSync(path.join(runLog, `${embedRun}.out`), "utf8").slice(-1200));
  console.log("  [PASS] Firefox: cross-origin wrapper iframe (JWPlayer config only) resolved and played in real mpv");
  context = topContext;

  console.log("  [PASS] Firefox found and ran the host installed by native/install.sh (data path with a space; legacy ~/mpv_host migrated)");

  // --- make uninstall: host ve kayıt kaldırılır, aynı klasördeki başka dosyalara dokunulmaz ---
  fs.writeFileSync(path.join(nmDir, "other.host.json"), "{}\n");
  const uninstall = spawnSync("bash", [path.join(ROOT, "native/install.sh"), "--uninstall"], { env: installEnv, encoding: "utf8" });
  assert.equal(uninstall.status, 0, uninstall.stderr + uninstall.stdout);
  assert.ok(!fs.existsSync(path.join(nmDir, "com.talha.mpv.json")), "uninstall must remove the Firefox registration");
  assert.ok(fs.existsSync(path.join(nmDir, "other.host.json")), "uninstall must keep other native hosts");
  assert.ok(!fs.existsSync(path.join(home, "App Data", "stream-to-mpv")), "uninstall must remove the host folder");
  console.log("  [PASS] install.sh --uninstall removed the host and its Firefox registration, kept other hosts");

  console.log("All desktop Firefox E2E tests passed!");
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

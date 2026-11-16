/**
 * Sadeleştirilmiş Popup Arayüz Mantığı
 * Birincil kullanım video üzerindeki "Open in mpv" butonudur.
 * Bu küçük popup yalnızca kurulum/bağlantı durumunu ve basit tercihleri gösterir.
 */

const hostBadge = document.getElementById("hostBadge");
const primaryHint = document.getElementById("primaryHint");
const openCurrentBtn = document.getElementById("openCurrentBtn");
const androidDirectLink = document.getElementById("androidDirectLink");
const androidShareBtn = document.getElementById("androidShareBtn");
const androidMenuBtn = document.getElementById("androidMenuBtn");
const statusBanner = document.getElementById("statusBanner");
const autoOpenToggle = document.getElementById("autoOpenToggle");
const ytdlpToggle = document.getElementById("ytdlpToggle");
const allowNativeBtn = document.getElementById("allowNativeBtn");
const playerSelect = document.getElementById("playerSelect");
const androidPlayerSelect = document.getElementById("androidPlayerSelect");
const desktopPlayerRow = document.getElementById("desktopPlayerRow");
const androidPlayerRow = document.getElementById("androidPlayerRow");
const blocklistInput = document.getElementById("blocklistInput");
const blocklistSaveBtn = document.getElementById("blocklistSaveBtn");

const PLAYER_LABELS = {
  mpv: "mpv",
  vlc: "VLC",
  mx: "MX Player",
  mxpro: "MX Player Pro",
  just: "Just Player",
  chooser: "player"
};

let activeTab = null;
let androidStreamUrl = "";
let currentPlatform = "desktop";

function setPlayerNameLabels(playerKey) {
  for (const el of document.querySelectorAll(".player-name")) {
    el.textContent = PLAYER_LABELS[playerKey] || playerKey || "mpv";
  }
}

async function refreshAndroidLaunchTarget() {
  if (activeTab?.id === undefined) return;
  const targetRes = await chrome.runtime.sendMessage({
    type: "GET_TAB_LAUNCH_TARGET",
    tabId: activeTab.id,
    pageUrl: activeTab.url || "",
    tabTitle: activeTab.title || ""
  });

  openCurrentBtn.hidden = true;
  if (targetRes?.ok && targetRes.intentUri) {
    androidStreamUrl = targetRes.streamUrl || "";
    androidDirectLink.href = targetRes.intentUri;
    androidDirectLink.hidden = false;
    androidShareBtn.hidden = false;
    primaryHint.textContent = IS_FIREFOX
      ? "Firefox asks 'Open in app?' on the page after you tap the button."
      : "Opens the player menu on the video. Bare Browser: set 'Settings → Privacy & security → Open links in apps' to 'Ask every time' or 'Always'.";
  } else {
    androidDirectLink.hidden = true;
    // Gizlenmiş HLS gibi akışlar ancak videodaki menü açılınca sayfa içinde bulunur; buradan başlatılabilir.
    androidMenuBtn.hidden = false;
    showStatus(
      targetRes?.errorMessage || "Play the video in the page first so its stream URL can be captured.",
      "info"
    );
  }
}

function showStatus(text, level = "info") {
  statusBanner.textContent = text;
  statusBanner.className = `status-banner visible status-${level}`;
}

async function initPopup() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0] || null;

    const [stateRes, hostRes] = await Promise.all([
      chrome.runtime.sendMessage({ type: "GET_STATE" }),
      chrome.runtime.sendMessage({ type: "CHECK_HOST_STATUS" })
    ]);

    if (stateRes?.ok) {
      autoOpenToggle.checked = Boolean(stateRes.settings?.autoOpen);
      ytdlpToggle.checked = Boolean(stateRes.settings?.ytdlpFallback);
      playerSelect.value = stateRes.settings?.player || "mpv";
      androidPlayerSelect.value = stateRes.settings?.androidPlayer || "mpv";
      blocklistInput.value = (stateRes.settings?.extraBlockedDomains || []).join("\n");
      setPlayerNameLabels(playerSelect.value);

      const currentTabData = (stateRes.tabsData || []).find((t) => t.tabId === activeTab?.id);
      const count = currentTabData?.streams?.length || 0;
      if (count > 0) {
        primaryHint.textContent = `${count} stream(s) ready in this tab. Click the mpv button on the player or below.`;
      }
    }

    if (hostRes?.ok) {
      if (hostRes.platform === "android") {
        currentPlatform = "android";
        hostBadge.textContent = "Android Ready";
        hostBadge.className = "status-pill ready";
        desktopPlayerRow.hidden = true;
        androidPlayerRow.hidden = false;
        setPlayerNameLabels(androidPlayerSelect.value);
        await refreshAndroidLaunchTarget();
      } else if (hostRes.hostInstalled && hostRes.hostOutdated && playerSelect.value !== "mpv") {
        hostBadge.textContent = "Update Needed";
        hostBadge.className = "status-pill missing";
        showStatus("The native host is outdated and cannot launch VLC. Run 'make' in the project folder again.", "error");
      } else if (hostRes.hostInstalled && (hostRes.selectedPlayerAvailable ?? hostRes.mpvAvailable)) {
        hostBadge.textContent = `${PLAYER_LABELS[playerSelect.value] || "mpv"} Ready`;
        hostBadge.className = "status-pill ready";
      } else if (hostRes.hostInstalled) {
        const name = PLAYER_LABELS[playerSelect.value] || "mpv";
        hostBadge.textContent = `${name} Not Found`;
        hostBadge.className = "status-pill missing";
        showStatus(`${name} was not found on this computer. Install it (e.g. brew / your package manager) or pick another player.`, "error");
      } else if (hostRes.permissionRequired) {
        hostBadge.textContent = "Permission Needed";
        hostBadge.className = "status-pill missing";
        allowNativeBtn.hidden = false;
        showStatus("Allow this extension to start mpv / VLC on this computer (one-time permission).", "info");
      } else {
        hostBadge.textContent = "Setup Required";
        hostBadge.className = "status-pill missing";
        showStatus("Run 'make' in project folder once to enable one-click launch.", "error");
      }
    }
  } catch (err) {
    showStatus(err?.message || "Failed to load status.", "error");
  }
}

// Firefox Android, eklenti açılır penceresinden (moz-extension sayfası) intent:// bağlantısını izlemez; hiçbir uygulama
// açılmaz. Intent sekmenin kendisinde açılınca Firefox "Open in app?" sorusunu gösterir ve sayfa olduğu gibi kalır.
// Tam ekran açılır pencere bu soruyu örttüğü için ardından kapatılır. Chromium tabanlı tarayıcılarda (Bare vb.)
// bağlantının varsayılan davranışı korunur.
const IS_FIREFOX = /\bFirefox\//.test(navigator.userAgent);
androidDirectLink?.addEventListener("click", async (ev) => {
  if (activeTab?.id === undefined) return;
  const intentUri = androidDirectLink.getAttribute("href") || "";
  if (!intentUri.startsWith("intent://")) return;
  ev.preventDefault();
  if (IS_FIREFOX) {
    try {
      await chrome.tabs.update(activeTab.id, { url: intentUri });
      window.close();
    } catch (err) {
      showStatus(err?.message || "Could not open the player. Use Share below.", "error");
    }
    return;
  }
  // Chromium (Bare vb.): eklenti sayfasından intent açılamaz; videonun üzerindeki menüyü aç.
  if (!(await openPlayerMenuOnPage())) {
    showStatus("Tap the ▶ mpv button on the video, or use Share below to copy the stream URL.", "info");
  }
});

/** Sekmedeki videonun ▶ mpv menüsünü açar (gerekirse sayfa içi akış keşfini de başlatır). */
async function openPlayerMenuOnPage() {
  if (activeTab?.id === undefined) return false;
  try {
    const res = await chrome.tabs.sendMessage(activeTab.id, { type: "OPEN_PLAYER_MENU" });
    if (res?.ok) {
      window.close();
      return true;
    }
  } catch {
    // Sayfada oynatıcı yok veya içerik betiği yüklenmemiş
  }
  return false;
}

androidMenuBtn?.addEventListener("click", async () => {
  if (!(await openPlayerMenuOnPage())) {
    showStatus("No video player found on this page. Start the video, then try again.", "info");
  }
});

androidShareBtn?.addEventListener("click", async () => {
  if (!androidStreamUrl) {
    showStatus("No video stream detected in this tab yet.", "error");
    return;
  }

  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ url: androidStreamUrl });
      showStatus("Select 'Open with mpv' in the Android share menu.", "success");
      return;
    } catch (err) {
      // Kullanıcı paylaşım menüsünü kapattıysa sessiz kal. Chromium tabanlı tarayıcılar (Bare vb.) eklenti
      // açılır penceresinden paylaşımı "AbortError: Share failed" ile reddeder; o durumda panoya kopyala.
      if (err?.name === "AbortError" && !/fail/i.test(err?.message || "")) return;
    }
  }

  try {
    await navigator.clipboard.writeText(androidStreamUrl);
    showStatus("Stream URL copied! Open mpv-android -> 'Open URL' and paste.", "success");
  } catch {
    showStatus(androidStreamUrl, "info");
  }
});

openCurrentBtn.addEventListener("click", async () => {
  if (!activeTab) return;
  openCurrentBtn.disabled = true;
  showStatus("Opening in mpv...", "info");

  try {
    const res = await chrome.runtime.sendMessage({
      type: "OPEN_BEST_IN_TAB",
      tabId: activeTab.id,
      allowPageFallback: Boolean(ytdlpToggle.checked),
      pageUrl: activeTab.url || "",
      tabTitle: activeTab.title || ""
    });

    if (res?.ok) {
      showStatus(`Opening in ${PLAYER_LABELS[playerSelect.value] || "mpv"}`, "success");
    } else {
      showStatus(res?.errorMessage || "No video detected in this tab.", "error");
    }
  } catch (err) {
    showStatus(err?.message || "Failed to contact extension.", "error");
  } finally {
    openCurrentBtn.disabled = false;
  }
});

autoOpenToggle.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({
    type: "SET_SETTINGS",
    autoOpen: autoOpenToggle.checked
  });
});

allowNativeBtn?.addEventListener("click", async () => {
  try {
    // permissions.request yalnızca kullanıcı etkileşimi içinde çağrılabilir (popup tıklaması)
    const granted = await chrome.permissions.request({ permissions: ["nativeMessaging"] });
    if (granted) {
      allowNativeBtn.hidden = true;
      statusBanner.className = "status-banner";
      await initPopup();
    } else {
      showStatus("Permission was not granted.", "error");
    }
  } catch (err) {
    showStatus(err?.message || "Could not request permission.", "error");
  }
});

playerSelect.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({ type: "SET_SETTINGS", player: playerSelect.value });
  setPlayerNameLabels(playerSelect.value);
  statusBanner.className = "status-banner";
  const hostRes = await chrome.runtime.sendMessage({ type: "CHECK_HOST_STATUS" });
  const name = PLAYER_LABELS[playerSelect.value] || playerSelect.value;
  if (hostRes?.hostOutdated && playerSelect.value !== "mpv") {
    hostBadge.textContent = "Update Needed";
    hostBadge.className = "status-pill missing";
    showStatus("The native host is outdated and cannot launch VLC. Run 'make' in the project folder again.", "error");
  } else if (hostRes?.hostInstalled && hostRes.selectedPlayerAvailable) {
    hostBadge.textContent = `${name} Ready`;
    hostBadge.className = "status-pill ready";
  } else if (hostRes?.hostInstalled) {
    hostBadge.textContent = `${name} Not Found`;
    hostBadge.className = "status-pill missing";
    showStatus(`${name} was not found on this computer.`, "error");
  }
});

androidPlayerSelect.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({ type: "SET_SETTINGS", androidPlayer: androidPlayerSelect.value });
  setPlayerNameLabels(androidPlayerSelect.value);
  if (currentPlatform === "android") await refreshAndroidLaunchTarget();
});

blocklistSaveBtn?.addEventListener("click", async () => {
  const entries = blocklistInput.value.split(/[\s,]+/).filter(Boolean);
  try {
    const res = await chrome.runtime.sendMessage({ type: "SET_SETTINGS", extraBlockedDomains: entries });
    const saved = res?.settings?.extraBlockedDomains || [];
    blocklistInput.value = saved.join("\n");
    const dropped = entries.length - saved.length;
    showStatus(
      dropped > 0
        ? `Saved ${saved.length} domain(s); ${dropped} invalid or duplicate entr${dropped === 1 ? "y was" : "ies were"} skipped.`
        : `Saved ${saved.length} domain(s).`,
      dropped > 0 ? "info" : "success"
    );
  } catch (err) {
    showStatus(err?.message || "Could not save the list.", "error");
  }
});

ytdlpToggle.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({
    type: "SET_SETTINGS",
    ytdlpFallback: ytdlpToggle.checked
  });
});

initPopup();

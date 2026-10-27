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
const statusBanner = document.getElementById("statusBanner");
const autoOpenToggle = document.getElementById("autoOpenToggle");
const ytdlpToggle = document.getElementById("ytdlpToggle");

let activeTab = null;
let androidStreamUrl = "";

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

      const currentTabData = (stateRes.tabsData || []).find((t) => t.tabId === activeTab?.id);
      const count = currentTabData?.streams?.length || 0;
      if (count > 0) {
        primaryHint.textContent = `${count} stream(s) ready in this tab. Click the mpv button on the player or below.`;
      }
    }

    if (hostRes?.ok) {
      if (hostRes.platform === "android") {
        hostBadge.textContent = "Android Ready";
        hostBadge.className = "status-pill ready";

        if (activeTab?.id !== undefined) {
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
            primaryHint.textContent =
              "Bare Browser: enable 'Settings → Open links in apps → Always' for 1-tap launch, or tap Share below.";
          } else {
            showStatus(
              targetRes?.errorMessage || "Play the video in the page first so its stream URL can be captured.",
              "info"
            );
          }
        }
      } else if (hostRes.hostInstalled && hostRes.mpvAvailable) {
        hostBadge.textContent = "mpv Ready";
        hostBadge.className = "status-pill ready";
      } else if (hostRes.hostInstalled && !hostRes.mpvAvailable) {
        hostBadge.textContent = "mpv Not Found";
        hostBadge.className = "status-pill missing";
        showStatus("mpv binary not found. Install mpv via Homebrew.", "error");
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
      if (err?.name === "AbortError") return;
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
      showStatus("Opening in mpv", "success");
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

ytdlpToggle.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({
    type: "SET_SETTINGS",
    ytdlpFallback: ytdlpToggle.checked
  });
});

initPopup();

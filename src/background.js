let notificationUrls = {};

const FRESH_MINUTES = 15;
const SCAN_INTERVAL = 3;

// --- Startup -----------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  console.log("Upwork Radar installed.");
  scheduleNextScan(SCAN_INTERVAL);
});

chrome.storage.local.get(["nextScanTimestamp"], (data) => {
  if (!data.nextScanTimestamp) scheduleNextScan(SCAN_INTERVAL);
});

// --- Alarm -------------------------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "upworkCheck") {
    await startJobScan();
    scheduleNextScan(SCAN_INTERVAL);
  }
});

// --- Message listener --------------------------------------------------------

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "SCAN_NOW") {
    startJobScan().then(() => sendResponse({ done: true }));
    return true;
  }
  if (request.type === "CHECK_LOGIN") {
    verifyLogin().then(loggedIn => sendResponse({ loggedIn }));
    return true;
  }

  if (request.type === "CLOUDFLARE_DETECTED") {
    handleCloudflare();
    return false;
  }
});

// --- Cloudflare handler ------------------------------------------------------

let cloudflareHandled = false;

// --- Cloudflare handler ------------------------------------------------------
// When a challenge is detected:
// 1. Navigate the existing Upwork tab to the search page so the user sees it
// 2. Poll until the challenge is solved
// 3. Auto-retry the scan

async function handleCloudflare() {
  if (cloudflareHandled) return;
  cloudflareHandled = true;

  chrome.storage.local.set({ cloudflareBlocked: true });
  console.log("[UpworkRadar] Cloudflare detected — navigating tab to solve.");

  // Find existing Upwork tab or create one
  const tabs = await chrome.tabs.query({ url: "https://www.upwork.com/*" });
  let tabId;

  if (tabs.length > 0) {
    tabId = tabs[0].id;
    // Navigate to search page — Cloudflare challenge will appear there
    await chrome.tabs.update(tabId, {
      url: "https://www.upwork.com/nx/search/jobs/?sort=recency",
      active: true  // bring to front so user sees the challenge
    });
  } else {
    const tab = await chrome.tabs.create({
      url: "https://www.upwork.com/nx/search/jobs/?sort=recency",
      active: true
    });
    tabId = tab.id;
  }

  await waitForTabLoad(tabId);

  // Poll every 2 seconds to check if challenge is solved
  let attempts = 0;
  const maxAttempts = 60; // give up after 2 minutes

  const checkInterval = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(checkInterval);
      cloudflareHandled = false;
      chrome.storage.local.set({ cloudflareBlocked: false });
      console.log("[UpworkRadar] Cloudflare timeout — giving up.");
      return;
    }

    try {
      const result = await new Promise(resolve => {
        chrome.tabs.sendMessage(tabId, { type: "CHECK_CLOUDFLARE_PASSED" }, res => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res);
        });
      });

      if (result && result.passed) {
        clearInterval(checkInterval);
        cloudflareHandled = false;
        chrome.storage.local.set({ cloudflareBlocked: false });
        console.log("[UpworkRadar] Cloudflare solved — retrying scan.");
        await sleep(1500);
        startJobScan();
      }
    } catch(e) {
      // Tab may still be loading — keep polling
    }
  }, 2000);
}

// --- Main scan ---------------------------------------------------------------

async function startJobScan() {
  console.log("Scan started:", new Date().toLocaleTimeString());
  notifiedThisScan.clear(); // reset per-scan dedup set

  const { keywords = [] } = await chrome.storage.local.get({ keywords: [] });
  if (keywords.length === 0) {
    console.log("No keywords, skipping.");
    return;
  }

  // Find any open Upwork tab to use as our fetch proxy
  const tabs = await chrome.tabs.query({ url: "https://www.upwork.com/*" });
  if (tabs.length === 0) {
    console.log("No Upwork tab open — scan skipped. Please keep an Upwork tab open.");
    // Save a flag so popup can show a warning
    chrome.storage.local.set({ noTabWarning: true });
    return;
  }

  chrome.storage.local.set({ noTabWarning: false });
  const tab = tabs[0];

  // Programmatically inject content script in case it wasn't loaded
  // (e.g. tab was open before extension was installed/updated)
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    await sleep(500); // let script initialize
  } catch (e) {
    // Already injected — ignore "Cannot access" or duplicate injection errors
  }

  for (const keyword of keywords) {
    await sleep(800); // small delay between keywords to avoid hammering
    try {
      // Content script fetches search page in background using fetch()
      // No tab navigation — the Upwork tab stays on whatever page it's on
      const freshJobs = await fetchJobsViaContentScript(tab.id, keyword);
      if (freshJobs.length === 0) {
        console.log("No fresh jobs for: " + keyword);
        continue;
      }
      console.log(freshJobs.length + " fresh job(s) for: " + keyword);
      for (const job of freshJobs.reverse()) {
        await processJobResult(keyword, job.id, job.title);
      }
    } catch (err) {
      console.error("Error scanning " + keyword + ": " + err.message);
    }
  }
}

// --- Wait for tab to finish loading --------------------------------------

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.status === "complete") {
        setTimeout(resolve, 1200); // extra wait for JS to render
        return;
      }
      const listener = (id, info) => {
        if (id === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(resolve, 1200);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

// --- Delegate fetch to content script ----------------------------------------
// Content script runs inside a real Upwork tab, so it has full browser
// context, real cookies, and correct headers — Cloudflare can't block it.

async function fetchJobsViaContentScript(tabId, keyword) {
  // Retry up to 3 times — content script may not be ready if tab just loaded
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await tryMessageContentScript(tabId, keyword);
    if (result !== null) return result; // null = content script not ready
    if (attempt < 3) {
      console.log("Content script not ready, retrying in 2s... (attempt " + attempt + ")");
      await sleep(2000);
    }
  }
  console.warn("Content script unreachable after 3 attempts for: " + keyword);
  return [];
}

function tryMessageContentScript(tabId, keyword) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.warn("Content script timed out for: " + keyword);
      resolve([]); // timed out but was reachable — return empty
    }, 13000); // slightly longer than content script's 12s safety timer

    chrome.tabs.sendMessage(
      tabId,
      { type: "FETCH_JOBS", keyword, freshMinutes: FRESH_MINUTES },
      (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || "";
          if (msg.includes("Receiving end does not exist") || msg.includes("Could not establish connection")) {
            resolve(null); // content script not ready — signal to retry
            return;
          }
          console.warn("Message error:", msg);
          resolve([]);
          return;
        }
        resolve(response || []);
      }
    );
  });
}

// --- Process & deduplicate ---------------------------------------------------

// In-memory set to prevent duplicate notifications within a single scan
const notifiedThisScan = new Set();

async function processJobResult(keyword, jobId, jobTitle) {
  const formattedId = jobId.startsWith("~") ? jobId : "~" + jobId;
  const jobUrl = "https://www.upwork.com/jobs/" + formattedId;

  // Fast in-memory check — prevents same job notified twice in one scan
  if (notifiedThisScan.has(jobUrl)) {
    console.log("[UpworkRadar] Already notified this scan:", jobTitle);
    return;
  }

  // Storage check — prevents notifying about jobs already in latest matches
  const data = await chrome.storage.local.get("recentJobs");
  const recent = data.recentJobs || [];

  if (recent.some(j => j.url === jobUrl)) {
    console.log("[UpworkRadar] Already in latest matches, skipping:", jobTitle);
    return;
  }

  // Mark as notified immediately to block any parallel keyword from firing again
  notifiedThisScan.add(jobUrl);

  const newEntry = {
    title: jobTitle,
    keyword,
    url: jobUrl,
    id: formattedId,
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  };

  const updated = [newEntry, ...recent].slice(0, 10);

  await chrome.storage.local.set({ recentJobs: updated });
  console.log("[UpworkRadar] New job saved:", jobTitle);

  // Fire notification — awaited so service worker stays alive until it's done
  await notifyUser(jobTitle, jobUrl, keyword);
}

// --- Notification ------------------------------------------------------------

function notifyUser(jobTitle, jobUrl, keyword) {
  return new Promise((resolve) => {
    const notificationId = "upwork_" + Date.now();

    // Save URL first, then create notification — ensures URL is always persisted
    chrome.storage.local.get("notificationUrls", (data) => {
      const urls = data.notificationUrls || {};
      urls[notificationId] = jobUrl;

      chrome.storage.local.set({ notificationUrls: urls }, () => {
        chrome.notifications.create(notificationId, {
          type: "basic",
          iconUrl: "icons/upwork48.png",
          title: jobTitle,
          message: "Match for: " + keyword + " — click to open",
          contextMessage: "Support this project? Buy me a coffee! ☕",
          priority: 2
        }, (createdId) => {
          if (chrome.runtime.lastError) {
            console.error("[UpworkRadar] Notification error:", chrome.runtime.lastError.message);
          } else {
            console.log("[UpworkRadar] Notification fired:", createdId, "|", jobTitle);
          }
          resolve();
        });
      });
    });
  });
}

chrome.notifications.onClicked.addListener((notificationId) => {
  // Read URL from storage (survives service worker sleep)
  chrome.storage.local.get("notificationUrls", (data) => {
    const urls = data.notificationUrls || {};
    const url = urls[notificationId];
    if (url) {
      chrome.tabs.create({ url });
      delete urls[notificationId];
      chrome.storage.local.set({ notificationUrls: urls });
      chrome.notifications.clear(notificationId);
    }
  });
});

// --- Login check -------------------------------------------------------------

async function verifyLogin() {
  try {
    const response = await fetch("https://www.upwork.com/home", {
      credentials: "include",
      redirect: "follow"
    });
    const isLoginPage = response.url.includes("login") || response.url.includes("account-security");
    return response.ok && !isLoginPage;
  } catch {
    return false;
  }
}

// --- Scheduler ---------------------------------------------------------------

function scheduleNextScan(minutes) {
  const nextScanTime = Date.now() + minutes * 60 * 1000;
  chrome.storage.local.set({ nextScanTimestamp: nextScanTime });
  chrome.alarms.create("upworkCheck", { delayInMinutes: minutes });
}

// --- Helpers -----------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
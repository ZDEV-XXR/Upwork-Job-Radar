let notificationUrls = {};

const FRESH_MINUTES = 15;
const SCAN_INTERVAL = 2;

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
});

// --- Main scan ---------------------------------------------------------------

async function startJobScan() {
  console.log("Scan started:", new Date().toLocaleTimeString());

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

  for (const keyword of keywords) {
    await sleep(800);
    try {
      const freshJobs = await fetchJobsViaContentScript(tab.id, keyword);
      if (freshJobs.length === 0) {
        console.log("No fresh jobs for: " + keyword);
        continue;
      }
      console.log(freshJobs.length + " fresh job(s) for: " + keyword);
      for (const job of freshJobs.reverse()) {
        processJobResult(keyword, job.id, job.title);
      }
    } catch (err) {
      console.error("Error scanning " + keyword + ": " + err.message);
    }
  }
}

// --- Delegate fetch to content script ----------------------------------------
// Content script runs inside a real Upwork tab, so it has full browser
// context, real cookies, and correct headers — Cloudflare can't block it.

function fetchJobsViaContentScript(tabId, keyword) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.warn("Content script timed out for: " + keyword);
      resolve([]);
    }, 15000);

    chrome.tabs.sendMessage(
      tabId,
      { type: "FETCH_JOBS", keyword, freshMinutes: FRESH_MINUTES },
      (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          console.warn("Message error:", chrome.runtime.lastError.message);
          resolve([]);
        } else {
          resolve(response || []);
        }
      }
    );
  });
}

// --- Process & deduplicate ---------------------------------------------------

function processJobResult(keyword, jobId, jobTitle) {
  const key = "last_id_" + keyword;

  chrome.storage.local.get([key, "recentJobs"], (result) => {
    if (result[key] === jobId) return;

    const formattedId = jobId.startsWith("~") ? jobId : "~" + jobId;
    const jobUrl = "https://www.upwork.com/jobs/" + formattedId;

    const newEntry = {
      title: jobTitle,
      keyword,
      url: jobUrl,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    };

    let recent = result.recentJobs || [];
    if (!recent.some(j => j.url === jobUrl)) {
      recent = [newEntry, ...recent].slice(0, 5);
      chrome.storage.local.set({ [key]: jobId, recentJobs: recent }, () => {
        notifyUser(jobTitle, jobUrl, keyword);
      });
    }
  });
}

// --- Notification ------------------------------------------------------------

function notifyUser(jobTitle, jobUrl, keyword) {
  const notificationId = "upwork_" + Date.now();
  chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: "icons/upwork48.png",
    title: jobTitle,
    message: "Match for: " + keyword + " — click to open",
    priority: 2
  });
  notificationUrls[notificationId] = jobUrl;
}

chrome.notifications.onClicked.addListener((notificationId) => {
  const url = notificationUrls[notificationId];
  if (url) {
    chrome.tabs.create({ url });
    delete notificationUrls[notificationId];
    chrome.notifications.clear(notificationId);
  }
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
let notificationUrls = {};

// Initialize the alarm when installed
chrome.runtime.onInstalled.addListener(() => {
  console.log("Upwork Radar Installed");
  // Check every 5 minutes
  chrome.alarms.create("upworkCheck", { periodInMinutes: 5 });
});

chrome.notifications.onClicked.addListener(() => {
    // This opens your Upwork search when you click the notification
    chrome.tabs.create({ url: "https://www.upwork.com/nx/search/jobs/?sort=recency" });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "upworkCheck") {
    startJobScan();
    scheduleNextScan(1);
  }
});

async function startJobScan() {
  console.log("1. Scan initiated...");
  const data = await chrome.storage.local.get({ keywords: [] });

  const keywords = data.keywords;
  console.log("2. Keywords found:", keywords);

  if (keywords.length === 0) return;

  // FIXED URL PATTERN BELOW
  const tabs = await chrome.tabs.query({ url: "https://www.upwork.com/*" });
  console.log("3. Upwork tabs found:", tabs.length);
  
  if (tabs.length === 0) return;

  for (const keyword of keywords) {
    // Add a 200ms delay between each keyword check to avoid port errors
    await new Promise(resolve => setTimeout(resolve, 200));
    
    chrome.tabs.sendMessage(tabs[0].id, { type: "FETCH_LATEST_JOB", keyword: keyword }, (response) => {
  if (chrome.runtime.lastError) return;
  
  // FIX: Make sure you use response.jobId and response.jobTitle
  if (response && response.jobId && response.jobTitle) {
    processJobResult(keyword, response.jobId, response.jobTitle);
  } else {
    console.log(`No match for keyword: ${keyword}`);
  }
});
}
}  

function processJobResult(keyword, jobId, jobTitle) {
  const key = `last_id_${keyword}`;
  chrome.storage.local.get([key, "recentJobs"], (result) => {
    // Only proceed if it's a NEW job
    if (result[key] !== jobId) {
      const formattedId = jobId.startsWith('~') ? jobId : `~${jobId}`;
      const jobUrl = `https://www.upwork.com/jobs/${formattedId}`;
      
      let recent = result.recentJobs || [];
      const newEntry = {
        title: jobTitle, // Use the real job title here
        keyword: keyword,
        url: jobUrl, 
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
      };

      // Check if this job is already in the list to avoid duplicates
      const exists = recent.some(job => job.url === jobUrl);
      if (!exists) {
        recent = [newEntry, ...recent].slice(0, 5); 
        chrome.storage.local.set({ [key]: jobId, "recentJobs": recent }, () => {
          notifyUser(jobTitle, jobUrl, keyword);
        });
      }
    }
  });
}

function notifyUser(keyword, jobUrl, jobTitle) {
  const notificationId = "upwork_" + Date.now();
  
  chrome.notifications.create(notificationId, {
    type: "basic",
    // Make sure this path exactly matches your folder structure
    iconUrl: "icons/upwork48.png", 
    title: jobTitle,
    message: `Direct hit for: ${keyword}. Click to view the post.`,
    priority: 2
  });

  notificationUrls[notificationId] = jobUrl;
}

// THE CLICK LISTENER
chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationUrls[notificationId]) {
    chrome.tabs.create({ url: notificationUrls[notificationId] });
    
    // Clean up the memory
    delete notificationUrls[notificationId];
    chrome.notifications.clear(notificationId);
  }
});

function checkIfNew(jobId, keyword) {
  const storageKey = `last_id_${keyword}`;
  
  chrome.storage.local.get([storageKey], (res) => {
    if (res[storageKey] !== jobId) {
      // It's a brand new job!
      sendNotification(keyword);
      // Save it so we don't notify again
      chrome.storage.local.set({ [storageKey]: jobId });
    }
  });
}

function sendNotification(keyword) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/upwork48.png",
    title: "New Upwork Match!",
    message: `A new job for "${keyword}" was just posted.`,
    priority: 2
  });
}

async function verifyLogin() {
  try {
    const response = await fetch("https://www.upwork.com/home", {
      method: 'GET',
      redirect: 'follow',
      credentials: 'include'
    });

    // If it's the login page, the URL will change to include "login"
    const isLoginPage = response.url.includes("login");
    return response.ok && !isLoginPage;
  } catch (error) {
    return false;
  }
}

// Function to schedule and save the time
function scheduleNextScan(minutes = 1) {
  const nextScanTime = Date.now() + (minutes * 60 * 1000);
  chrome.storage.local.set({ nextScanTimestamp: nextScanTime });
  
  chrome.alarms.create("upworkCheck", { delayInMinutes: minutes });
}

// Kickstart the very first scan/timer on install or refresh
chrome.runtime.onInstalled.addListener(() => {
  scheduleNextScan(1); 
  console.log("Extension installed: First scan scheduled.");
});

// Also kickstart if the service worker wakes up and nothing is scheduled
chrome.storage.local.get(["nextScanTimestamp"], (data) => {
  if (!data.nextScanTimestamp) {
    scheduleNextScan(1);
  }
});
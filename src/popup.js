async function checkLogin() {
  const statusDiv = document.getElementById('auth-status');
  const loginBtn = document.getElementById('login-btn');
  const addBtn = document.getElementById('add-btn');
  const keywordInput = document.getElementById('keyword-input');

  // Find an open Upwork tab
  const [tab] = await chrome.tabs.query({ url: "https://www.upwork.com/*" });

  if (!tab) {
    statusDiv.textContent = "Upwork tab not found";
    statusDiv.className = "status logged-out";
    showLoginUI(true);
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "CHECK_LOGIN_STATUS" });
    if (response && response.loggedIn) {
      statusDiv.textContent = "Connected to Upwork";
      statusDiv.className = "status logged-in";
      showLoginUI(false);
    } else {
      statusDiv.textContent = "Please Log in on the page";
      statusDiv.className = "status logged-out";
      showLoginUI(true);
    }
  } catch (e) {
    statusDiv.textContent = "Please refresh your Upwork tab";
    showLoginUI(true);
  }
}

// Helper to toggle UI
function showLoginUI(isLoggedOut) {
  const loginBtn = document.getElementById('login-btn');
  const addBtn = document.getElementById('add-btn');
  const keywordInput = document.getElementById('keyword-input');

  if (isLoggedOut) {
    loginBtn.style.display = "block";
    addBtn.style.display = "none";
    keywordInput.style.display = "none";
  } else {
    loginBtn.style.display = "none";
    addBtn.style.display = "block";
    keywordInput.style.display = "block";
  }
}

// Initial Load
checkLogin();
chrome.storage.local.get({ keywords: [] }, (result) => {
  displayKeywords(result.keywords);
});

// Event listener for the new button
document.getElementById('login-btn').addEventListener('click', () => {
  // Using /home is the safest way to trigger the redirect to login or dashboard
  chrome.tabs.create({ url: 'https://www.upwork.com/home' });
});
// 2. Save Keyword to Storage
document.getElementById('add-btn').addEventListener('click', () => {
  const input = document.getElementById('keyword-input');
  const keyword = input.value.trim();

  if (keyword) {
    chrome.storage.local.get({ keywords: [] }, (result) => {
      const updatedKeywords = [...result.keywords, keyword];
      chrome.storage.local.set({ keywords: updatedKeywords }, () => {
        input.value = ''; // Clear input
        displayKeywords(updatedKeywords);
      });
    });
  }
});

function displayKeywords(keywords) {
  const list = document.getElementById('keywordList');
  list.innerHTML = '';

  keywords.forEach((word, index) => {
    const item = document.createElement('div');
    item.className = 'keyword-item';
    
    item.innerHTML = `
      <span class="keyword-text">${word}</span>
      <button class="delete-btn" data-index="${index}" title="Remove">X</button>
    `;

    list.appendChild(item);
  });

  // Add event listeners to all delete buttons
  document.querySelectorAll('.delete-btn').forEach(button => {
    button.addEventListener('click', function() {
      const index = this.getAttribute('data-index');
      deleteKeyword(index);
    });
  });
}

function deleteKeyword(index) {
  chrome.storage.local.get({ keywords: [] }, (data) => {
    let keywords = data.keywords;
    
    // Remove the specific keyword by its index
    keywords.splice(index, 1);
    
    // Save the updated list back to storage
    chrome.storage.local.set({ keywords: keywords }, () => {
      console.log("Keyword deleted.");
      displayKeywords(keywords); // Refresh the UI
    });
  });
}

chrome.storage.local.get("recentJobs", (data) => {
  if (data.recentJobs) {
    displayRecentJobs(data.recentJobs);
  }
});

function displayRecentJobs(jobs) {
  const container = document.getElementById('recentJobsList');
  container.innerHTML = '';

  jobs.forEach((job, index) => {
    const div = document.createElement('div');
    div.className = 'recent-item';
    
    div.innerHTML = `
      <button class="clear-job-btn" data-index="${index}" title="Clear match">X</button>
      <div class="job-clickable-area">
        <strong>${job.title}</strong>
        <span class="job-time">Found at ${job.time}</span>
      </div>
    `;
    
    // Clicking the text opens the URL
    div.addEventListener('click', () => {
      chrome.tabs.create({ url: job.url });
    });

    // ACTION 2: Click the X to delete the job
    const deleteBtn = div.querySelector('.clear-job-btn');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // CRITICAL: This stops the browser from opening the link!
      removeNotification(index);
    });

    container.appendChild(div);
  });
}

function removeNotification(index) {
  chrome.storage.local.get("recentJobs", (data) => {
    let recent = data.recentJobs || [];
    recent.splice(index, 1); // Remove the selected job
    
    chrome.storage.local.set({ "recentJobs": recent }, () => {
      displayRecentJobs(recent); // Refresh the UI
    });
  });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.recentJobs) {
    displayRecentJobs(changes.recentJobs.newValue);
  }
});

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get("recentJobs", (data) => {
    if (data.recentJobs) {
      displayRecentJobs(data.recentJobs);
    }
  });
});

function updateTimer() {
  const timerElement = document.getElementById("countdown");

  chrome.storage.local.get(["nextScanTimestamp"], (data) => {
    if (!data.nextScanTimestamp) {
      timerElement.innerText = "Pending...";
      return;
    }

    // Run immediately once, then start interval
    const runCountdown = () => {
      const now = Date.now();
      const distance = data.nextScanTimestamp - now;

      if (distance <= 0) {
        timerElement.innerText = "00:00";
        return;
      }

      const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((distance % (1000 * 60)) / 1000);

      // Pad with zeros (e.g., 0:05 instead of 0:5)
      timerElement.innerText = `${minutes}:${seconds < 10 ? '0' + seconds : seconds}`;
    };

    runCountdown();
    setInterval(runCountdown, 1000);
  });
}

document.addEventListener("DOMContentLoaded", updateTimer);
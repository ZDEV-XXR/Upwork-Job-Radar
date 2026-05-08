// ─── Login check (delegated to background.js which has cookie access) ────────

async function checkLogin() {
  const statusDiv = document.getElementById('auth-status');
  const loginBtn  = document.getElementById('login-btn');
  const addBtn    = document.getElementById('add-btn');
  const input     = document.getElementById('keyword-input');

  try {
    const response = await chrome.runtime.sendMessage({ type: 'CHECK_LOGIN' });

    if (response && response.loggedIn) {
      statusDiv.textContent  = "✓ Logged in to Upwork";
      statusDiv.className    = "logged-in";
      loginBtn.style.display = "none";
      addBtn.style.display   = "block";
      input.style.display    = "block";
    } else {
      throw new Error("not logged in");
    }
  } catch {
    statusDiv.textContent  = "✗ Not logged in — scans will be skipped";
    statusDiv.className    = "logged-out";
    loginBtn.style.display = "block";
    addBtn.style.display   = "none";
    input.style.display    = "none";
  }
}

// ─── Timer ───────────────────────────────────────────────────────────────────

function startTimer() {
  const el = document.getElementById('countdown');

  function tick() {
    chrome.storage.local.get(['nextScanTimestamp'], (data) => {
      if (!data.nextScanTimestamp) {
        el.textContent = 'Pending…';
        return;
      }
      const dist = data.nextScanTimestamp - Date.now();
      if (dist <= 0) {
        el.textContent = 'Scanning…';
        return;
      }
      const m = Math.floor(dist / 60000);
      const s = Math.floor((dist % 60000) / 1000);
      el.textContent = `${m}:${s < 10 ? '0' + s : s}`;
    });
  }

  tick();
  setInterval(tick, 1000);
}

// ─── Scan now button ─────────────────────────────────────────────────────────
// Sends a message to the background service worker to run a scan immediately.

document.getElementById('scan-now-btn').addEventListener('click', () => {
  const btn = document.getElementById('scan-now-btn');
  btn.textContent = 'Scanning…';
  btn.disabled = true;

  chrome.runtime.sendMessage({ type: 'SCAN_NOW' }, () => {
    setTimeout(() => {
      btn.textContent = 'Scan now';
      btn.disabled = false;
    }, 3000);
  });
});

// ─── Login button ─────────────────────────────────────────────────────────────

document.getElementById('login-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.upwork.com/home' });
});

// ─── Add keyword ─────────────────────────────────────────────────────────────

document.getElementById('add-btn').addEventListener('click', addKeyword);

document.getElementById('keyword-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addKeyword();
});

function addKeyword() {
  const input   = document.getElementById('keyword-input');
  const keyword = input.value.trim();
  if (!keyword) return;

  chrome.storage.local.get({ keywords: [] }, (result) => {
    // Prevent duplicates
    if (result.keywords.includes(keyword)) {
      input.value = '';
      return;
    }
    const updated = [...result.keywords, keyword];
    chrome.storage.local.set({ keywords: updated }, () => {
      input.value = '';
      displayKeywords(updated);
    });
  });
}

// ─── Keyword list ─────────────────────────────────────────────────────────────

function displayKeywords(keywords) {
  const list = document.getElementById('keywordList');
  list.innerHTML = '';

  keywords.forEach((word, index) => {
    const item = document.createElement('div');
    item.className = 'keyword-item';
    item.innerHTML = `
      <span class="keyword-text">${word}</span>
      <button class="delete-btn" data-index="${index}" title="Remove">✕</button>
    `;
    list.appendChild(item);
  });

  list.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteKeyword(Number(btn.dataset.index)));
  });
}

function deleteKeyword(index) {
  chrome.storage.local.get({ keywords: [] }, (data) => {
    data.keywords.splice(index, 1);
    chrome.storage.local.set({ keywords: data.keywords }, () => {
      displayKeywords(data.keywords);
    });
  });
}

// ─── Recent jobs ──────────────────────────────────────────────────────────────

function displayRecentJobs(jobs) {
  const container = document.getElementById('recentJobsList');
  container.innerHTML = '';

  if (!jobs || jobs.length === 0) {
    container.innerHTML = '<div class="no-jobs">No matches yet</div>';
    return;
  }

  jobs.forEach((job, index) => {
    const div = document.createElement('div');
    div.className = 'recent-item';
    div.innerHTML = `
      <button class="clear-job-btn" title="Dismiss">✕</button>
      <div class="job-title">${job.title}</div>
      <div class="job-meta">
        <span class="job-keyword">${job.keyword}</span>
        ${job.time}
      </div>
    `;

    div.addEventListener('click', () => chrome.tabs.create({ url: job.url }));

    div.querySelector('.clear-job-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      removeJob(index);
    });

    container.appendChild(div);
  });
}

function removeJob(index) {
  chrome.storage.local.get('recentJobs', (data) => {
    const recent = data.recentJobs || [];
    recent.splice(index, 1);
    chrome.storage.local.set({ recentJobs: recent }, () => displayRecentJobs(recent));
  });
}

// Live-update when background.js saves a new job
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.recentJobs) {
    displayRecentJobs(changes.recentJobs.newValue);
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  checkLogin();
  startTimer();
  checkNoTabWarning();

  chrome.storage.local.get({ keywords: [], recentJobs: [] }, (data) => {
    displayKeywords(data.keywords);
    displayRecentJobs(data.recentJobs);
  });
});

function checkNoTabWarning() {
  chrome.storage.local.get(["noTabWarning"], (data) => {
    const statusDiv = document.getElementById("auth-status");
    if (data.noTabWarning) {
      statusDiv.textContent = "⚠ Keep an Upwork tab open for scanning";
      statusDiv.className = "logged-out";
    }
  });
}
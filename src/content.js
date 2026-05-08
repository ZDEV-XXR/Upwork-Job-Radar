// Upwork Radar — content script

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  if (request.type === "CHECK_LOGIN_STATUS") {
    const isLoggedIn =
      document.querySelector('[data-qa="user-menu"]') !== null ||
      document.querySelector('.nav-item') !== null;
    sendResponse({ loggedIn: isLoggedIn });
    return false;
  }

  if (request.type === "FETCH_JOBS") {
    fetchJobs(request.keyword, request.freshMinutes || 15)
      .then(jobs => sendResponse(jobs))
      .catch(err => {
        console.error("[UpworkRadar] fetch error:", err.message);
        sendResponse([]);
      });
    return true;
  }

  if (request.type === "DEBUG_DUMP") {
    sendResponse(debugDump());
    return false;
  }
});

// ─── Main fetch — 4 layers ───────────────────────────────────────────────────

async function fetchJobs(keyword, freshMinutes) {
  const cutoff = Date.now() - freshMinutes * 60 * 1000;

  // ── Layer 1: Internal REST API ──────────────────────────────────────────────
  const apiUrl =
    "https://www.upwork.com/api/profiles/v2/search/jobs/url" +
    "?q=" + encodeURIComponent(keyword) + "&sort=recency&paging=0;10";
  try {
    const res = await fetch(apiUrl, {
      credentials: "include",
      headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest", "Referer": location.href }
    });
    if (res.ok) {
      const data = await res.json();
      const jobs = data?.searchResults?.jobs || data?.results || [];
      console.log("[UpworkRadar] Layer 1 API:", jobs.length, "jobs for:", keyword);
      if (jobs.length > 0) return strictFilter(jobs, cutoff);
    } else {
      console.warn("[UpworkRadar] Layer 1 status:", res.status);
    }
  } catch (e) { console.warn("[UpworkRadar] Layer 1 error:", e.message); }

  // ── Layer 2: Fetch search page HTML, parse __NEXT_DATA__ ───────────────────
  const pageUrl = "https://www.upwork.com/nx/search/jobs/?q=" + encodeURIComponent(keyword) + "&sort=recency";
  console.log("[UpworkRadar] Layer 2: fetching search page for:", keyword);
  try {
    const res = await fetch(pageUrl, {
      credentials: "include",
      headers: { "Accept": "text/html", "Referer": location.href }
    });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (m) {
        const d = JSON.parse(m[1]);
        const results =
          d?.props?.pageProps?.searchResults?.jobs?.results ||
          d?.props?.pageProps?.initialData?.jobs?.results ||
          d?.props?.pageProps?.results || [];
        console.log("[UpworkRadar] Layer 2:", results.length, "results. pageProps keys:", Object.keys(d?.props?.pageProps || {}));
        if (results.length > 0) return strictFilter(results, cutoff);
      }
    } else { console.warn("[UpworkRadar] Layer 2 page status:", res.status); }
  } catch (e) { console.warn("[UpworkRadar] Layer 2 error:", e.message); }

  // ── Layer 3: Read __NEXT_DATA__ from current page DOM ──────────────────────
  console.log("[UpworkRadar] Layer 3: current page __NEXT_DATA__");
  const nextEl = document.getElementById("__NEXT_DATA__");
  if (nextEl) {
    try {
      const d = JSON.parse(nextEl.textContent);
      const results =
        d?.props?.pageProps?.searchResults?.jobs?.results ||
        d?.props?.pageProps?.initialData?.jobs?.results ||
        d?.props?.pageProps?.results || [];
      const matched = results.filter(j =>
        (j.title + " " + (j.description || "")).toLowerCase().includes(keyword.toLowerCase())
      );
      console.log("[UpworkRadar] Layer 3: matched", matched.length, "of", results.length);
      if (matched.length > 0) return strictFilter(matched, cutoff);
    } catch (e) { console.warn("[UpworkRadar] Layer 3 error:", e.message); }
  }

  // ── Layer 4: DOM scrape visible job cards ──────────────────────────────────
  console.log("[UpworkRadar] Layer 4: DOM scrape for:", keyword);
  return domScrape(keyword, cutoff);
}

// ─── Strict freshness filter ─────────────────────────────────────────────────
// NEVER accepts a job without a verifiable date — no date = skip.

function strictFilter(jobs, cutoff) {
  const results = [];

  for (const job of jobs) {
    // Check all known date field names Upwork uses
    const raw =
      job.publishedOn ||
      job.createdOn   ||
      job.pubDate     ||
      job.publishTime ||
      job.postedOn    ||
      job.createdDateTime || null;

    if (!raw) {
      // Log the full key list so we can find the right date field
      console.warn("[UpworkRadar] Job has NO date field — skipped. Keys:", Object.keys(job), "Title:", job.title);
      continue;
    }

    const posted = new Date(raw).getTime();
    if (isNaN(posted)) {
      console.warn("[UpworkRadar] Unparseable date:", raw, "for:", job.title);
      continue;
    }

    const ageMinutes = Math.round((Date.now() - posted) / 60000);
    if (posted < cutoff) {
      console.log("[UpworkRadar] Too old (" + ageMinutes + " min):", job.title);
      continue;
    }

    console.log("[UpworkRadar] FRESH (" + ageMinutes + " min):", job.title);
    results.push({
      id:    job.ciphertext || job.id || job.jobUid,
      title: job.title
    });
  }

  return results.filter(j => j.id && j.title);
}

// ─── DOM scrape ──────────────────────────────────────────────────────────────
// For DOM scraping we parse the posted-time text strictly.
// "X minutes ago", "X seconds ago", "X hours ago" → check against cutoff.
// Anything else (days, weeks, months) → skip.

function domScrape(keyword, cutoff) {
  const jobs = [];

  const cardSelectors = [
    'article[data-test="job-tile"]',
    'article.job-tile',
    '[data-test="job-tile"]',
    'section.air3-card-section',
    '.job-tile'
  ];

  let cards = [];
  for (const sel of cardSelectors) {
    cards = Array.from(document.querySelectorAll(sel));
    if (cards.length > 0) {
      console.log("[UpworkRadar] DOM: found", cards.length, "cards with:", sel);
      break;
    }
  }

  if (cards.length === 0) {
    console.warn("[UpworkRadar] DOM: no job cards found on:", location.href);
    return [];
  }

  for (const card of cards) {
    if (!card.innerText.toLowerCase().includes(keyword.toLowerCase())) continue;

    // Find the posted time text
    const timeSelectors = [
      '[data-test="job-published-date"]',
      '[data-test="posted-on"]',
      'small[data-test]', 'time', '.job-tile-header small'
    ];
    let timeText = "";
    for (const sel of timeSelectors) {
      const el = card.querySelector(sel);
      if (el) { timeText = el.innerText.trim(); break; }
    }

    if (!timeText) {
      console.warn("[UpworkRadar] DOM: no time element found — skipping card");
      continue;
    }

    // Parse "X minutes ago", "X seconds ago", "X hours ago" into ms
    const ageMs = parseTimeAgo(timeText);
    if (ageMs === null) {
      console.log("[UpworkRadar] DOM: unparseable time '" + timeText + "' — skipping");
      continue;
    }

    const posted = Date.now() - ageMs;
    const ageMin = Math.round(ageMs / 60000);
    if (posted < cutoff) {
      console.log("[UpworkRadar] DOM: too old (" + ageMin + " min): '" + timeText + "'");
      continue;
    }

    const linkEl = card.querySelector("h3 a, h2 a, a[href*='/jobs/']");
    if (!linkEl) continue;

    const title = linkEl.innerText.trim();
    const href  = linkEl.getAttribute("href") || "";
    const match = href.match(/~[a-zA-Z0-9]+/);
    if (match && title) {
      console.log("[UpworkRadar] DOM: FRESH (" + ageMin + " min):", title);
      jobs.push({ id: match[0], title });
    }
  }

  console.log("[UpworkRadar] DOM: found", jobs.length, "fresh job(s) for:", keyword);
  return jobs;
}

// Parses "X seconds ago", "X minutes ago", "X hours ago" → milliseconds
// Returns null for anything that can't be resolved to a number.
function parseTimeAgo(text) {
  const t = text.toLowerCase();
  const num = parseInt(t);
  if (isNaN(num)) return null;

  if (t.includes("second")) return num * 1000;
  if (t.includes("minute")) return num * 60 * 1000;
  if (t.includes("hour"))   return num * 60 * 60 * 1000;

  // "1 day" = 1440 min — outside 15-min window so it will be filtered out,
  // but we return the value instead of null so it gets properly logged.
  if (t.includes("day"))    return num * 24 * 60 * 60 * 1000;
  if (t.includes("week"))   return num * 7 * 24 * 60 * 60 * 1000;

  return null;
}

// ─── Debug dump ──────────────────────────────────────────────────────────────

function debugDump() {
  const out = {
    url: location.href,
    cardCounts: {},
    nextDataKeys: null,
    resultsCount: 0,
    firstJobKeys: null,
    firstJobDateFields: null,
    timeElSamples: []
  };

  const sels = ['article[data-test="job-tile"]','article.job-tile','[data-test="job-tile"]','section.air3-card-section','.job-tile'];
  sels.forEach(s => out.cardCounts[s] = document.querySelectorAll(s).length);

  const el = document.getElementById("__NEXT_DATA__");
  if (el) {
    try {
      const d = JSON.parse(el.textContent);
      out.nextDataKeys = Object.keys(d?.props?.pageProps || {});
      const arr =
        d?.props?.pageProps?.searchResults?.jobs?.results ||
        d?.props?.pageProps?.initialData?.jobs?.results ||
        d?.props?.pageProps?.results || [];
      out.resultsCount = arr.length;
      if (arr[0]) {
        out.firstJobKeys = Object.keys(arr[0]);
        // Show all fields that look like dates
        out.firstJobDateFields = Object.entries(arr[0])
          .filter(([k, v]) => typeof v === "string" && (k.toLowerCase().includes("date") || k.toLowerCase().includes("time") || k.toLowerCase().includes("on") || k.toLowerCase().includes("pub")))
          .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});
      }
    } catch (e) { out.nextDataError = e.message; }
  }

  Array.from(document.querySelectorAll('article[data-test="job-tile"],[data-test="job-tile"]'))
    .slice(0, 3)
    .forEach(c => {
      const t = c.querySelector('[data-test="job-published-date"],[data-test="posted-on"],time,small');
      out.timeElSamples.push(t ? t.outerHTML : "none");
    });

  console.log("[UpworkRadar DEBUG]", JSON.stringify(out, null, 2));
  return out;
}
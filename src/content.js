// Upwork Radar — content script
// NO async fetch calls — only reads what's already on the page.
// This prevents timeout issues entirely.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  if (request.type === "CHECK_LOGIN_STATUS") {
    const isLoggedIn =
      document.querySelector('[data-qa="user-menu"]') !== null ||
      document.querySelector('.nav-item') !== null;
    sendResponse({ loggedIn: isLoggedIn });
    return false;
  }

  if (request.type === "FETCH_JOBS") {
    scrapeCurrentPage(request.keyword, request.freshMinutes || 15)
      .then(jobs => sendResponse(jobs))
      .catch(() => sendResponse([]));
    return true; // keep channel open for async
  }

  if (request.type === "DEBUG_DUMP") {
    sendResponse(debugDump());
    return false;
  }
});

// ─── Fetch search page via XHR (synchronous, same-origin, no navigation) ─────
// XHR with async=false runs in the tab's context so Cloudflare can't block it.
// No navigation needed — we fetch the HTML directly and parse it.

async function scrapeCurrentPage(keyword, freshMinutes) {
  const cutoff = Date.now() - freshMinutes * 60 * 1000;

  const searchUrl = "https://www.upwork.com/nx/search/jobs/?q=" +
    encodeURIComponent(keyword) + "&sort=recency";

  try {
    // Async XHR wrapped in a Promise — synchronous XHR is blocked in content scripts
    const html = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", searchUrl, true); // async
      xhr.withCredentials = true;
      xhr.setRequestHeader("Accept", "text/html");
      xhr.timeout = 10000;
      xhr.onload = () => xhr.status === 200 ? resolve(xhr.responseText) : reject(new Error("status " + xhr.status));
      xhr.onerror = () => reject(new Error("network error"));
      xhr.ontimeout = () => reject(new Error("timeout"));
      xhr.send();
    });

    // Parse the returned HTML as a document
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    // Try __NEXT_DATA__ in the fetched page
    const nextEl = doc.getElementById("__NEXT_DATA__");
    if (nextEl) {
      try {
        const pageData = JSON.parse(nextEl.textContent);
        const pp = pageData?.props?.pageProps;
        const results =
          pp?.searchResults?.jobs?.results ||
          pp?.initialData?.jobs?.results ||
          pp?.results || [];

        console.log("[UpworkRadar] XHR __NEXT_DATA__ results:", results.length, "for:", keyword);

        if (results.length > 0) {
          const fresh = strictFilter(results, cutoff);
          if (fresh.length > 0) return fresh;
          console.log("[UpworkRadar] All results filtered out by freshness for:", keyword);
          // Log date fields of first job so we can debug
          if (results[0]) {
            const dateFields = Object.fromEntries(
              Object.entries(results[0]).filter(([k]) => /date|time|on$|pub|posted|open|creat/i.test(k))
            );
            console.log("[UpworkRadar] First job date fields:", JSON.stringify(dateFields));
          }
          return [];
        }
        console.log("[UpworkRadar] XHR __NEXT_DATA__ empty. Keys:", Object.keys(pp || {}));
      } catch(e) {
        console.warn("[UpworkRadar] XHR __NEXT_DATA__ parse error:", e.message);
      }
    }

    // Fallback: parse job tiles from the fetched HTML
    return scrapeDocForKeyword(doc, keyword, cutoff);

  } catch(e) {
    console.warn("[UpworkRadar] XHR error:", e.message, "— falling back to current DOM");
    return scrapeDomForKeyword(keyword, cutoff);
  }
}

// ─── Layer 1: __NEXT_DATA__ JSON ─────────────────────────────────────────────

function scrapeNextData(keyword, cutoff) {
  const el = document.getElementById("__NEXT_DATA__");
  if (!el) {
    console.log("[UpworkRadar] No __NEXT_DATA__ on this page");
    return [];
  }

  let pageData;
  try {
    pageData = JSON.parse(el.textContent);
  } catch (e) {
    console.warn("[UpworkRadar] __NEXT_DATA__ parse error:", e.message);
    return [];
  }

  const pp = pageData?.props?.pageProps;
  const results =
    pp?.searchResults?.jobs?.results ||
    pp?.initialData?.jobs?.results ||
    pp?.results ||
    [];

  if (results.length === 0) {
    console.log("[UpworkRadar] __NEXT_DATA__ has no results. pageProps keys:", Object.keys(pp || {}));
    return [];
  }

  console.log("[UpworkRadar] __NEXT_DATA__ found", results.length, "total jobs");

  const fresh = [];
  for (const job of results) {
    const kw = keyword.toLowerCase();
    const text = ((job.title || "") + " " + (job.description || "")).toLowerCase();
    if (!text.includes(kw)) continue;

    // Find any date field — log all candidates so we can fix path if needed
    const dateValue =
      job.publishedOn       ||
      job.createdOn         ||
      job.pubDate           ||
      job.publishTime       ||
      job.postedOn          ||
      job.createdDateTime   ||
      job.openingDate       ||
      null;

    if (!dateValue) {
      // Log the job's keys so we know which field to use
      console.warn("[UpworkRadar] No date field found. Job keys:", Object.keys(job).join(", "), "| Title:", job.title);
      continue; // skip — can't verify freshness
    }

    const posted = new Date(dateValue).getTime();
    if (isNaN(posted)) {
      console.warn("[UpworkRadar] Unparseable date:", dateValue);
      continue;
    }

    const ageMin = Math.round((Date.now() - posted) / 60000);
    if (posted < cutoff) {
      console.log("[UpworkRadar] Too old (" + ageMin + "min):", job.title);
      continue;
    }

    const id = job.ciphertext || job.id || job.jobUid || null;
    if (!id || !job.title) continue;

    console.log("[UpworkRadar] FRESH (" + ageMin + "min):", job.title);
    fresh.push({ id, title: job.title });
  }

  console.log("[UpworkRadar] __NEXT_DATA__ returned", fresh.length, "fresh job(s) for:", keyword);
  return fresh;
}

// ─── Layer 2a: Scrape a parsed document (from XHR response) ─────────────────

function scrapeDocForKeyword(doc, keyword, cutoff) {
  const cards = Array.from(doc.querySelectorAll(
    'article.job-tile, article[data-test="job-tile"], [data-test="job-tile"]'
  ));
  console.log("[UpworkRadar] scrapeDoc found", cards.length, "cards");
  return extractJobsFromCards(cards, keyword, cutoff);
}

// ─── Layer 2b: Scrape current live DOM ────────────────────────────────────────

function scrapeDomForKeyword(keyword, cutoff) {
  return scrapeDom(keyword, cutoff);
}

// ─── Layer 2: DOM scrape ─────────────────────────────────────────────────────

function scrapeDom(keyword, cutoff) {
  const jobs = [];

  const cardSelectors = [
    'article.job-tile',
    'article[data-test="job-tile"]',
    '[data-test="job-tile"]',
    'section.air3-card-section',
    '.job-tile'
  ];

  let cards = [];
  for (const sel of cardSelectors) {
    cards = Array.from(document.querySelectorAll(sel));
    if (cards.length > 0) {
      console.log("[UpworkRadar] DOM found", cards.length, "cards with selector:", sel);
      break;
    }
  }

  if (cards.length === 0) {
    console.warn("[UpworkRadar] DOM: no job cards found on:", location.href);
    return [];
  }
  return extractJobsFromCards(cards, keyword, cutoff);
}

function extractJobsFromCards(cards, keyword, cutoff) {
  const jobs = [];
  for (const card of cards) {
    const cardText = (card.innerText || card.textContent || "").toLowerCase();
    if (!cardText.includes(keyword.toLowerCase())) continue;

    // Find time text — try selectors first, then regex on full card text
    // Correct selector confirmed: small.text-light.mb-1 contains "Posted X minutes ago"
    // Fallback: regex scan full card text
    let timeText = "";
    const timeEl = card.querySelector('small.text-light');
    if (timeEl) {
      timeText = (timeEl.innerText || timeEl.textContent || "").trim();
    }
    if (!timeText) {
      // Regex fallback on full card text — catches any format
      const m = cardText.match(/posted\s+(\d+\s+(?:second|minute|hour|day|week)s?\s+ago)/i);
      if (m) timeText = m[1];
    }
    console.log("[UpworkRadar] timeText:", JSON.stringify(timeText), "| keyword:", keyword);

    if (!timeText) { console.warn("[UpworkRadar] no time found — skipping"); continue; }

    const ageMs = parseTimeAgo(timeText);
    if (ageMs === null) { console.log("[UpworkRadar] unparseable time:", timeText); continue; }

    const posted = Date.now() - ageMs;
    const ageMin = Math.round(ageMs / 60000);
    if (posted < cutoff) { console.log("[UpworkRadar] too old (" + ageMin + "min):", timeText); continue; }

    const linkEl = card.querySelector("h3 a, h2 a, a[href*='/jobs/']");
    if (!linkEl) continue;

    const title = (linkEl.innerText || linkEl.textContent || "").trim();
    const href  = linkEl.getAttribute("href") || "";
    // Match ~digits in the URL (e.g. ~022052850103764816526)
    const match = href.match(/~\d+/);
    if (!match || !title) continue;

    console.log("[UpworkRadar] FRESH DOM (" + ageMin + "min):", title);
    jobs.push({ id: match[0], title });
  }
  console.log("[UpworkRadar] extractJobsFromCards:", jobs.length, "fresh jobs for:", keyword);
  return jobs;
}

// ─── Parse "X minutes ago" → milliseconds ────────────────────────────────────

function parseTimeAgo(text) {
  const t = text.toLowerCase();
  const num = parseInt(t);
  if (isNaN(num)) return null;
  if (t.includes("second")) return num * 1000;
  if (t.includes("minute")) return num * 60 * 1000;
  if (t.includes("hour"))   return num * 3600 * 1000;
  if (t.includes("day"))    return num * 86400 * 1000;
  if (t.includes("week"))   return num * 604800 * 1000;
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

  const sels = [
    'article[data-test="job-tile"]', 'article.job-tile',
    '[data-test="job-tile"]', 'section.air3-card-section', '.job-tile'
  ];
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
        // Show all fields that look date-related
        out.firstJobDateFields = Object.fromEntries(
          Object.entries(arr[0]).filter(([k]) =>
            /date|time|on$|pub|posted|open|creat/i.test(k)
          )
        );
      }
    } catch (e) { out.nextDataError = e.message; }
  }

  Array.from(document.querySelectorAll(
    'article.job-tile, article[data-test="job-tile"], [data-test="job-tile"]'
  )).slice(0, 3).forEach(c => {
    // Grab ALL small/time elements inside the card to find the right one
    const els = Array.from(c.querySelectorAll('small, time, [class*="posted"], [class*="date"], [class*="time"]'));
    out.timeElSamples.push(els.map(e => e.outerHTML).join(" | ") || "none");
  });

  console.log("[UpworkRadar DEBUG]", JSON.stringify(out, null, 2));
  return out;
}
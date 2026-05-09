// Upwork Radar — content script
// Fetches search pages in the background using fetch() from within the Upwork
// tab context — full cookies, no navigation, no page refresh.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  if (request.type === "FETCH_JOBS") {
    console.log("[UpworkRadar] FETCH_JOBS for:", request.keyword);
    const respond = sendResponse;
    let responded = false;

    const safetyTimer = setTimeout(() => {
      if (!responded) { responded = true; respond([]); }
    }, 12000);

    fetchJobsForKeyword(request.keyword, request.freshMinutes || 15)
      .then(jobs => {
        clearTimeout(safetyTimer);
        if (!responded) { responded = true; respond(jobs); }
      })
      .catch(err => {
        clearTimeout(safetyTimer);
        console.error("[UpworkRadar] Error:", err.message);
        if (!responded) { responded = true; respond([]); }
      });

    return true; // async
  }

  if (request.type === "CHECK_CLOUDFLARE_PASSED") {
    const blocked = document.title.includes("Just a moment") ||
                    !!document.querySelector("#challenge-form");
    sendResponse({ passed: !blocked });
    return false;
  }

  if (request.type === "CHECK_LOGIN_STATUS") {
    sendResponse({
      loggedIn: !!document.querySelector('[data-qa="user-menu"]') ||
                !!document.querySelector('.nav-item')
    });
    return false;
  }

  if (request.type === "DEBUG_DUMP") {
    sendResponse(debugDump());
    return false;
  }
});

// ─── Proactive Cloudflare detection ──────────────────────────────────────────
// Runs once when the content script loads on any Upwork page.
// If this page IS a Cloudflare challenge, immediately tell background.js.

(function checkOnLoad() {
  const isChallenge =
    document.title.includes("Just a moment") ||
    !!document.querySelector("#challenge-form") ||
    !!document.querySelector(".cf-browser-verification") ||
    document.body?.innerText?.includes("Enable JavaScript and cookies");

  if (isChallenge) {
    console.warn("[UpworkRadar] Page is a Cloudflare challenge — notifying background.");
    chrome.runtime.sendMessage({ type: "CLOUDFLARE_DETECTED" });
  }
})();

// ─── Fetch & parse search results ─────────────────────────────────────────────

async function fetchJobsForKeyword(keyword, freshMinutes) {
  const cutoff = Date.now() - freshMinutes * 60 * 1000;
  const url = "https://www.upwork.com/nx/search/jobs/?q=" +
    encodeURIComponent(keyword) + "&sort=recency";

  console.log("[UpworkRadar] Fetching:", url);

  const res = await fetch(url, {
    credentials: "include",
    headers: { "Accept": "text/html", "Upgrade-Insecure-Requests": "1" }
  });

  if (!res.ok) throw new Error("HTTP " + res.status);

  const html = await res.text();

  // Cloudflare check
  if (html.includes("Just a moment") || html.includes("challenge-form") || html.includes("cf_chl_")) {
    console.warn("[UpworkRadar] Cloudflare challenge detected");
    chrome.runtime.sendMessage({ type: "CLOUDFLARE_DETECTED" });
    return [];
  }

  console.log("[UpworkRadar] Got HTML, length:", html.length);

  // Parse into a document — use textContent (not innerText) on parsed docs
  const doc = new DOMParser().parseFromString(html, "text/html");
  const cards = Array.from(doc.querySelectorAll("article.job-tile"));
  console.log("[UpworkRadar] Cards found:", cards.length, "for:", keyword);

  if (cards.length === 0) {
    console.warn("[UpworkRadar] No cards — snippet:", html.slice(0, 300));
    return [];
  }

  return extractJobs(cards, keyword, cutoff, false);
}

// ─── Extract jobs from cards ──────────────────────────────────────────────────
// isLive=true  → use innerText  (live DOM, rendered)
// isLive=false → use textContent (DOMParser doc, not rendered)

function extractJobs(cards, keyword, cutoff, isLive) {
  const jobs = [];
  const kw = keyword.toLowerCase();
  const getText = el => el ? (isLive ? el.innerText : el.textContent) || "" : "";

  for (const card of cards) {
    const cardText = getText(card).toLowerCase();
    if (!cardText.includes(kw)) continue;

    // Time element — confirmed class: small.text-light ("Posted X minutes ago")
    const timeEl = card.querySelector("small.text-light");
    let timeText = getText(timeEl).trim();

    // Regex fallback
    if (!timeText) {
      const m = cardText.match(/posted\s+\d+\s+(?:second|minute|hour|day|week)s?\s+ago/i);
      if (m) timeText = m[0];
    }

    if (!timeText) {
      console.warn("[UpworkRadar] No time in card — smalls:",
        Array.from(card.querySelectorAll("small")).map(s => s.className + ":" + getText(s).trim()));
      continue;
    }

    const ageMs = parseTimeAgo(timeText);
    if (ageMs === null) { console.log("[UpworkRadar] Unparseable time:", timeText); continue; }

    const ageMin = Math.round(ageMs / 60000);
    if (Date.now() - ageMs < cutoff) { console.log("[UpworkRadar] Too old (" + ageMin + "min)"); continue; }

    // Link & ID
    const linkEl = card.querySelector("h3 a, h2 a, a[href*='/jobs/']");
    if (!linkEl) continue;

    const title = getText(linkEl).trim();
    const href = linkEl.getAttribute("href") || "";
    const idMatch = href.match(/~\d+/);
    if (!idMatch || !title) continue;

    console.log("[UpworkRadar] FRESH (" + ageMin + "min):", title);
    jobs.push({ id: idMatch[0], title });
  }

  console.log("[UpworkRadar] Extracted", jobs.length, "job(s) for:", keyword);
  return jobs;
}

// ─── Parse "Posted X minutes ago" → ms ───────────────────────────────────────

function parseTimeAgo(text) {
  const t = text.toLowerCase();
  const numMatch = t.match(/\d+/);
  if (!numMatch) return null;
  const num = parseInt(numMatch[0]);
  if (t.includes("second")) return num * 1000;
  if (t.includes("minute")) return num * 60 * 1000;
  if (t.includes("hour"))   return num * 3600 * 1000;
  if (t.includes("day"))    return num * 86400 * 1000;
  if (t.includes("week"))   return num * 604800 * 1000;
  return null;
}

// ─── Debug dump ───────────────────────────────────────────────────────────────

function debugDump() {
  const cards = Array.from(document.querySelectorAll("article.job-tile"));
  return {
    url: location.href,
    title: document.title,
    totalCards: cards.length,
    samples: cards.slice(0, 3).map(c => ({
      time: c.querySelector("small.text-light")?.innerText?.trim() || "NOT FOUND",
      allSmalls: Array.from(c.querySelectorAll("small")).map(s => s.className + ": " + s.innerText.trim()),
      href: c.querySelector("h3 a, h2 a")?.getAttribute("href") || "NOT FOUND",
      title: c.querySelector("h3 a, h2 a")?.innerText?.trim() || "NOT FOUND"
    }))
  };
}
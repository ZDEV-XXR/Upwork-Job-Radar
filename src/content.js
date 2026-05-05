function isFresh(timeText) {
  const text = timeText.toLowerCase();
  
  // If it says "seconds ago", it's definitely fresh
  if (text.includes("seconds")) return true;
  
  // If it says "minutes ago", extract the number
  if (text.includes("minutes")) {
    const minutes = parseInt(text.match(/\d+/));
    return minutes < 10;
  }
  
  // If it's hours, days, or anything else, it's too old
  return false;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log("Content Script received message:", request.type);

    if (request.type === "CHECK_LOGIN_STATUS") {
        const isLoggedIn = document.querySelector('[data-qa="user-menu"]') !== null || 
                       document.querySelector('.nav-item') !== null;
        sendResponse({ loggedIn: isLoggedIn });
    }

    if (request.type === "FETCH_LATEST_JOB") {
    // Look for job cards on the current page
    const keyword = request.keyword.toLowerCase(); // The keyword being checked
    const jobCards = document.querySelectorAll('[data-test="job-tile-list"] section');  

    let foundId = null;

    for (let card of jobCards) {
      const cardText = card.innerText.toLowerCase();

      const timeElement = card.querySelector('[data-test="job-pubilshed-date"]');
      const timeText = timeElement ? timeElement.innerText : "";
      
      // Only proceed if the card actually contains the keyword
      if (cardText.includes(keyword) && isFresh(timeText)) {
        const linkElement = card.querySelector('h3 a');
        if (linkElement) {
          const jobTitle = linkElement.innerText.trim();
          const href = linkElement.getAttribute('href');
          const match = href.match(/~[a-zA-Z0-9]+/);
          if (match) {
            result = { 
              jobId: match[0], 
              jobTitle: jobTitle // Send the title back
            };
            break; 
          }
        }
      }
    }
    sendResponse(result);
    
    if (jobCards) {
    const linkElement = jobCards.querySelector('h3 a');
    const href = linkElement.getAttribute('href'); // e.g., "/jobs/~01abc..."
    // This regex grabs everything after the ~
    const match = href.match(/~([a-zA-Z0-9]+)/);
    const jobId = match ? match[0] : null; // returns "~01abc..."

    sendResponse({ jobId: jobId });
    return;
    
    console.log("[Radar] No jobs found on the current page.");
    sendResponse({ jobId: null });
  }

  return true;
}
});

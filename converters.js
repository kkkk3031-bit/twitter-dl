// Browser bridge to public online converters.
//
// Some sites yt-dlp cannot touch from a datacenter IP (Reddit wants a login,
// Vimeo's OAuth handshake fails, a dozen small sites are simply not covered).
// A human would paste the link into an online converter, press Convert and take
// the download link — so that is exactly what this does, with a headless
// Chromium driving the page. Nothing is scraped except the link the site itself
// hands to the user who pasted it.
//
// Ordering matters everywhere it is used: yt-dlp first (fast, no third party),
// this second (slow, flaky, but covers what yt-dlp cannot).
const puppeteer = require("puppeteer");

const NAV_TIMEOUT = 60000;
const SETTLE_MS = 12000; // the converter needs time to resolve the link itself
const IDLE_CLOSE_MS = 120000; // a parked browser costs ~150MB — let it go
const CACHE_MS = 8 * 60 * 1000; // their links expire; do not hand out stale ones

let browser = null;
let idleTimer = null;
let busy = false;
const cache = new Map(); // url → { link, via, ts }

async function getBrowser() {
  if (browser && browser.connected) return browser;
  browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage", // small /dev/shm on this VPS crashes tabs otherwise
      "--disable-gpu",
      "--mute-audio",
      "--no-first-run",
    ],
  });
  return browser;
}

function touchIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (busy) return touchIdle();
    try {
      if (browser) await browser.close();
    } catch {}
    browser = null;
  }, IDLE_CLOSE_MS);
}

// A converter's own proxy link (9xbud, a workers.dev relay) is meant to be
// fetched by whoever pasted the URL, so it works from a phone. A raw CDN link
// is often bound to the IP that extracted it — the converter's server, not the
// user's — so it is kept only as a last resort.
function rankLinks(links) {
  const score = (h) => {
    if (/9xbud|workers\.dev|\/down\//i.test(h)) return 0;
    if (/googlevideo|fbcdn|cdninstagram|tiktokcdn/i.test(h)) return 2;
    return 1;
  };
  return links.sort((a, b) => score(a) - score(b));
}

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function via9xbuddy(page, target) {
  await page.goto("https://9xbuddy.com/process?url=" + encodeURIComponent(target), {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT,
  });
  // The page resolves the media in the background and then reveals the
  // "Download Now" anchors — wait for one instead of a fixed sleep.
  try {
    await page.waitForFunction(
      () => [...document.querySelectorAll("a")].some((a) => /download now/i.test(a.textContent || "")),
      { timeout: SETTLE_MS }
    );
  } catch {}
  const links = await page.evaluate(() =>
    [...document.querySelectorAll("a")]
      .filter((a) => /download now/i.test(a.textContent || ""))
      .map((a) => a.href)
      .filter((h) => /^https?:/.test(h))
  );
  return rankLinks(links)[0] || null;
}

const ADAPTERS = [{ name: "9xbuddy", run: via9xbuddy }];

// Returns { url, via } or null. Never throws — the caller always has a fallback.
async function convertViaWeb(target) {
  const hit = cache.get(target);
  if (hit && Date.now() - hit.ts < CACHE_MS)
    return { url: hit.link, via: hit.via, headers: hit.headers, cached: true };
  if (busy) return null; // one tab at a time on a 2-core box
  busy = true;
  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    );
    // Images and fonts are pure cost here — the link is in the DOM.
    await page.setRequestInterception(true);
    page.on("request", (r) =>
      /image|font|media/.test(r.resourceType()) ? r.abort() : r.continue()
    );
    for (const a of ADAPTERS) {
      let link = null;
      try {
        link = await a.run(page, target);
      } catch {}
      if (!link) continue;
      // The link alone is not enough: the converter's proxy answers 403 to a
      // bare request and 200 to one carrying the session that produced it
      // (verified both ways). So the session travels with the link — the phone
      // sets these on its download and still pulls the bytes itself, which is
      // the whole point of handing out a link instead of streaming.
      let headers = { "User-Agent": UA, Referer: "https://9xbuddy.com/" };
      try {
        const ck = (await page.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
        if (ck) headers.Cookie = ck;
      } catch {}
      cache.set(target, { link, via: a.name, headers, ts: Date.now() });
      return { url: link, via: a.name, headers };
    }
    return null;
  } catch {
    return null;
  } finally {
    busy = false;
    try {
      if (page) await page.close();
    } catch {}
    touchIdle();
  }
}

module.exports = { convertViaWeb };

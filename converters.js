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

// y2mate.gs — the site the KDL app's whole YouTube path mirrors (etacloud over
// a worker relay). Its own page JS does auth → init → convert → progress and
// only builds the real download link when the file is ready, so the page is
// driven exactly like a human would: paste the link, press the MP4 button
// (its default is MP3!), submit. The site's own `download()` is wrapped to
// capture the `<downloadURL>&v=..&f=mp4&r=y2mate.gs` link it produces — no
// click, no navigation, no file eating in the browser. The r=y2mate.gs suffix
// is what makes the link serve to any IP, not just this box's.
const Y2MATE = "https://y2mate.gs/";

async function viaY2mate(page, target) {
  await page.goto(Y2MATE, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
  // The site's own `download(downloadURL, vid, fmt, title)` is what builds the
  // real link when the file is ready (`e + "&v=" + t + "&f=" + o + "&r=" +
  // hostname` — the r=y2mate.gs suffix is what makes it serve to any IP, not
  // just this box's). Wrapping it captures that URL before the abandoned
  // Download-button click navigates the browser into downloading the file
  // itself. The site also injects an ad script and opens a popup on click —
  // both are pure noise here, so the click is skipped entirely.
  await page.evaluate(() => {
    window.open = () => null;
    if (window.__kdlWrapped) return;
    window.__kdlWrapped = true;
    window.__kdl = null;
    window.__kdlTitle = "";
    const orig = window.download;
    window.download = function (e, t, o, r) {
      window.__kdl = e + "&v=" + t + "&f=" + o + "&r=" + window.location.hostname;
      if (r) window.__kdlTitle = r; // the site reveals the title in this arg
      return orig.apply(this, arguments);
    };
  });
  try {
    await page.type("#video", target, { delay: 20 });
    // MP3 rides as the page default; the app wants video, so press MP4.
    await page.$$eval(".form__formats button", (btns) => {
      const mp4 = btns.find((b) => (b.textContent || "").trim().toLowerCase() === "mp4");
      if (mp4) mp4.click();
    });
    await page.click(`.form__actions button[type="submit"]`);
    // Fresh MP4 conversions can take a while; the wrap only fires once the
    // site decides the file is ready.
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline && !(await page.evaluate(() => window.__kdl || null))) {
      await new Promise((r2) => setTimeout(r2, 2000));
    }
    const direct = await page.evaluate(() => window.__kdl || null);
    if (!direct || !/^https?:\/\//.test(direct)) return null;
    // The site's progress path calls `download(..., !1)` — no title in the
    // args — but it always renders the title into the form's title line.
    const title = await page.evaluate(
      () => window.__kdlTitle || (document.querySelector(".form__title") && document.querySelector(".form__title").textContent) || ""
    );
    // One more risk: a direct link the site hands out can be useless (an
    // etacloud node that answers error:2 instead of video bytes, or a page
    // that needs session headers). Probe with a 1KB Range GET — a real video
    // answers 206/binary, a dead link answers JSON or 4xx.
    try {
      const probe = await fetch(direct, {
        headers: {
          "User-Agent": UA,
          Referer: Y2MATE,
          Origin: "https://y2mate.gs",
          Range: "bytes=0-1024",
        },
        signal: AbortSignal.timeout(20000),
        redirect: "follow",
      });
      if (!probe.ok) return null;
      const ct = probe.headers.get("content-type") || "";
      if (/json|text\//i.test(ct)) return null;
      if (probe.status === 206 || /video|octet-stream|mp4/i.test(ct)) return { url: direct, title };
      return null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

const ADAPTERS = [
  { name: "y2mate", referer: "https://y2mate.gs/", origin: "https://y2mate.gs", run: viaY2mate },
  { name: "9xbuddy", referer: "https://9xbuddy.com/", run: via9xbuddy },
];

// Returns { url, via } or null. Never throws — the caller always has a fallback.
async function convertViaWeb(target) {
  const hit = cache.get(target);
  if (hit && Date.now() - hit.ts < CACHE_MS)
    return { url: hit.link, via: hit.via, headers: hit.headers, title: hit.title || "", cached: true };
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
    page.on("request", (r) => {
      if (r.isInterceptResolutionHandled()) return;
      /image|font|media/.test(r.resourceType()) ? r.abort() : r.continue();
    });
    for (const a of ADAPTERS) {
      let link = null;
      try {
        link = await a.run(page, target);
      } catch {}
      if (!link) continue;
      const url = typeof link === "string" ? link : link.url;
      const title = typeof link === "string" ? "" : link.title || "";
      if (!url) continue;
      // The link alone is not enough: the converter's proxy answers 403 to a
      // bare request and 200 to one carrying the session that produced it
      // (verified both ways). So the session travels with the link — the phone
      // sets these on its download and still pulls the bytes itself, which is
      // the whole point of handing out a link instead of streaming.
      let headers = { "User-Agent": UA, Referer: a.referer || "https://9xbuddy.com/" };
      if (a.origin) headers.Origin = a.origin;
      try {
        const ck = (await page.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
        if (ck) headers.Cookie = ck;
      } catch {}
      cache.set(target, { link: url, via: a.name, headers, title, ts: Date.now() });
      return { url, via: a.name, headers, title };
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

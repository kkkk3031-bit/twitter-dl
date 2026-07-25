// Replies WITHOUT an X login.
//
// X's own endpoints are a dead end logged-out: the syndication endpoint carries
// no reply field at all, fxtwitter returns only a count, and guest-token
// TweetDetail answers 404 for guests. Every public Nitter mirror, however, still
// renders the full conversation server-side — the catch is that the surviving
// mirrors sit behind a JS proof-of-work wall (Anubis) or Cloudflare, so plain
// fetch gets a challenge page. A real browser solves that wall by simply being a
// browser, which is what the headless Chromium already vendored here does.
//
// Cost control: the wall issues a cookie once solved, so the jar is persisted
// and reused; the browser stays parked for a couple of minutes and is then let
// go, same as converters.js.
const puppeteer = require("puppeteer");
const fs = require("fs");
const os = require("os");
const path = require("path");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";
const NAV_TIMEOUT = 45000;
const CONTENT_TIMEOUT = 40000; // the proof-of-work wall can chew ~30s cold
const WARM_TIMEOUT = 15000; // with the wall's cookie in hand it is ~1.5s
const PAGE_NAV_TIMEOUT = 20000; // a deep "Load more" cursor makes the mirror re-fetch from X
const BUDGET_MS = 45000; // total wall-clock for one conversation walk
const IDLE_CLOSE_MS = 120000;
const CACHE_MS = 5 * 60 * 1000;
const MAX_PAGES = 5; // "Load more" hops; 20-ish replies a page

// Verified 2026-07-25: tiekoetter served a full 35-reply thread in 1.4s while
// xcancel/lightbrd/nitter.space were failing their own bot checks. Order is a
// starting hint only — a mirror that answers gets promoted on disk.
const MIRRORS = [
  "nitter.tiekoetter.com",
  "xcancel.com",
  "nitter.poast.org",
  "nitter.privacyredirect.com",
  "lightbrd.com",
  "nitter.space",
  "nitter.net",
];

const STATE_DIR = path.join(os.homedir(), ".cache", "twdl");
const STATE_FILE = path.join(STATE_DIR, "mirrors.json");

let browser = null;
let idleTimer = null;
let busy = false;
const cache = new Map(); // id → { data, ts }

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { hosts: {} };
  }
}

function saveState(s) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch {}
}

// Best mirror first: whichever answered last, then the rest in listed order.
function rankedMirrors() {
  const { hosts } = loadState();
  return [...MIRRORS].sort((a, b) => {
    const sa = hosts[a] || {};
    const sb = hosts[b] || {};
    return (sb.lastOk || 0) - (sa.lastOk || 0);
  });
}

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
  idleTimer.unref?.(); // a parked browser must not keep a short-lived process alive
}

async function shutdown() {
  clearTimeout(idleTimer);
  try {
    if (browser) await browser.close();
  } catch {}
  browser = null;
}

// Runs inside the page: Nitter renders the whole conversation as plain markup,
// so the DOM is the parser and there is no HTML-regex to rot.
function extractInPage() {
  const text = (el, sel) => el.querySelector(sel)?.textContent?.trim() || "";
  const num = (el, icon) => {
    const n = el.querySelector(`.tweet-stat .icon-${icon}`);
    if (!n) return null;
    const v = (n.parentElement?.textContent || "").replace(/[^\d]/g, "");
    return v ? Number(v) : 0;
  };
  const one = (el) => ({
    handle: text(el, ".username").replace(/^@/, ""),
    name: text(el, ".fullname"),
    date: el.querySelector(".tweet-date a")?.getAttribute("title") || "",
    text: text(el, ".tweet-content"),
    replying_to: [...el.querySelectorAll(".replying-to a")].map((a) => a.textContent.trim()),
    likes: num(el, "heart"),
    retweets: num(el, "retweet"),
    replies: num(el, "comment"),
    images: [...el.querySelectorAll(".attachment img")].map((i) => i.src),
    has_video: !!el.querySelector(".attachment.video-container, .attachment .video"),
  });

  const mainEl = document.querySelector(".main-tweet .timeline-item");
  const items = [...document.querySelectorAll(".reply .timeline-item")].filter(
    (el) => !el.classList.contains("unavailable") && el.querySelector(".username"),
  );
  const more = document.querySelector(".show-more:not(.timeline-item) a, .show-more a");
  return {
    main: mainEl ? one(mainEl) : null,
    replies: items.map(one),
    // Nitter's "Load more" carries the cursor for the next page of replies.
    nextHref: more && /cursor=/.test(more.getAttribute("href") || "") ? more.getAttribute("href") : null,
    blocked: !mainEl && !items.length,
    bodyStart: document.body.innerText.slice(0, 100).replace(/\s+/g, " "),
  };
}

async function scrapeMirror(host, id, handle, maxPages, opts = {}) {
  const b = await getBrowser();
  const page = await b.newPage();
  await page.setUserAgent(UA);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  // Images/fonts are dead weight — the reply text is all that is wanted.
  await page.setRequestInterception(true);
  page.on("request", (r) =>
    ["image", "font", "media"].includes(r.resourceType()) ? r.abort() : r.continue(),
  );

  try {
    const state = loadState();
    const known = state.hosts[host] || {};
    if (known.cookies?.length) {
      try {
        await page.setCookie(...known.cookies);
      } catch {}
    }

    const replies = [];
    let mainTweet = null;
    let url = `https://${host}/${handle || "i"}/status/${id}`;
    let solved = !!known.cookies?.length;
    let partial = false;
    // A mirror that has to re-fetch a deep cursor from X can sit there for
    // minutes; the first page is what matters, so the whole walk gets a budget
    // and hands back whatever it collected when the budget runs out.
    const deadline = Date.now() + (opts.budgetMs || BUDGET_MS);
    const seenCursors = new Set();

    for (let p = 0; p < maxPages; p++) {
      const left = deadline - Date.now();
      if (p > 0 && left < 4000) {
        partial = true;
        break;
      }
      try {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: p === 0 ? NAV_TIMEOUT : Math.max(5000, Math.min(PAGE_NAV_TIMEOUT, left)),
        });
      } catch (e) {
        if (p === 0) throw e;
        partial = true; // page 1 already in hand — a stalled cursor is not a failure
        break;
      }
      try {
        await page.waitForSelector(".main-tweet, .timeline-item", {
          timeout: solved ? WARM_TIMEOUT : CONTENT_TIMEOUT,
        });
      } catch {}
      const got = await page.evaluate(extractInPage);
      if (got.blocked) {
        if (p > 0) {
          partial = true;
          break;
        }
        return { ok: false, host, reason: `blocked by ${host} (${got.bodyStart.slice(0, 60)})` };
      }
      solved = true;
      if (!mainTweet) mainTweet = got.main;
      replies.push(...got.replies);
      // Nitter can hand back the cursor it was just given — that would loop.
      if (!got.nextHref || seenCursors.has(got.nextHref)) break;
      seenCursors.add(got.nextHref);
      url = new URL(got.nextHref, `https://${host}/`).href;
      if (p === maxPages - 1) partial = true;
    }

    // Persist the wall's cookie so the next call skips the proof-of-work.
    const cookies = await page.cookies();
    state.hosts[host] = { lastOk: Date.now(), cookies };
    saveState(state);

    // Nitter repeats the focal tweet inside thread groups — drop those.
    const seen = new Set();
    const clean = replies.filter((r) => {
      const k = `${r.handle}|${r.date}|${r.text}`;
      if (seen.has(k) || (mainTweet && k === `${mainTweet.handle}|${mainTweet.date}|${mainTweet.text}`))
        return false;
      seen.add(k);
      return true;
    });
    return { ok: true, host, main: mainTweet, replies: clean, partial };
  } catch (e) {
    return { ok: false, host, reason: `${host}: ${String(e.message).split("\n")[0]}` };
  } finally {
    try {
      await page.close();
    } catch {}
  }
}

// fetchCommentsNoLogin(id, handle) → { ok, replies:[...], via } | { ok:false, reason }
async function fetchCommentsNoLogin(id, handle, opts = {}) {
  const maxPages = opts.maxPages || MAX_PAGES;
  const hit = cache.get(`${id}|${maxPages}`);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.data;

  busy = true;
  const tried = [];
  try {
    for (const host of rankedMirrors()) {
      const r = await scrapeMirror(host, id, handle, maxPages, opts);
      if (r.ok) {
        const data = { ok: true, via: host, main: r.main, replies: r.replies, partial: !!r.partial };
        cache.set(`${id}|${maxPages}`, { data, ts: Date.now() });
        return data;
      }
      tried.push(r.reason);
    }
    return {
      ok: false,
      reason: `no mirror answered — ${tried.join(" | ")}`,
    };
  } finally {
    busy = false;
    touchIdle();
  }
}

module.exports = { fetchCommentsNoLogin, shutdown, MIRRORS };

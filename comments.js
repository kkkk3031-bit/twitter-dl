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
const BUDGET_MS = 60000; // total wall-clock for one conversation walk
const IDLE_CLOSE_MS = 120000;
const CACHE_MS = 5 * 60 * 1000;
const MAX_LOADS = 80; // thread pages opened per conversation, worst case
const TABS = 2; // parallel tabs — more makes these small instances 503

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
    // The permalink carries the reply's own status id — the dedupe key, and the
    // address of its sub-thread.
    id: (el.querySelector(".tweet-link")?.getAttribute("href") || "").match(/status\/(\d+)/)?.[1] || "",
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
  return {
    main: mainEl ? one(mainEl) : null,
    replies: items.map(one),
    blocked: !mainEl && !items.length,
    bodyStart: document.body.innerText.slice(0, 100).replace(/\s+/g, " "),
  };
}

// Nitter prints "Jul 25, 2026 · 2:36 AM UTC"; V8 parses it once the dot is out.
function toISO(d) {
  if (!d) return null;
  const t = Date.parse(String(d).replace(" · ", " "));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// Every reply gets its real address on X, so the list is clickable and each
// comment can be opened where it lives.
function decorate(r) {
  return {
    ...r,
    ts: toISO(r.date),
    url: r.id && r.handle ? `https://x.com/${r.handle}/status/${r.id}` : null,
  };
}

async function openTab(b, host, cookies) {
  const page = await b.newPage();
  await page.setUserAgent(UA);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  // Images/fonts are dead weight — the reply text is all that is wanted.
  await page.setRequestInterception(true);
  page.on("request", (r) =>
    ["image", "font", "media"].includes(r.resourceType()) ? r.abort() : r.continue(),
  );
  if (cookies?.length) {
    try {
      await page.setCookie(...cookies);
    } catch {}
  }
  return page;
}

// One thread page → its visible replies. Nitter renders a reply's own sub-thread
// only on that reply's page, which is what makes the walk below necessary.
async function loadThread(page, host, handle, id, waitMs) {
  await page.goto(`https://${host}/${handle || "i"}/status/${id}`, {
    waitUntil: "domcontentloaded",
  });
  try {
    await page.waitForSelector(".main-tweet, .timeline-item", { timeout: waitMs });
  } catch {}
  return page.evaluate(extractInPage);
}

// The whole conversation, not just the first page.
//
// Nitter's own "Load more" cursor is dead on every surviving mirror (it answers
// 200 with an empty page — the instances have no auth tokens, which is also why
// `conversation_id:` search 429s there), so paging is not the way in. The tree
// is: the root page lists the replies, each reply that has replies of its own
// links to a page listing those, and so on until the branches run out. Walking
// it with a couple of tabs pulled 44 replies where page 1 showed 32.
async function scrapeMirror(host, id, handle, opts = {}) {
  const b = await getBrowser();
  const state = loadState();
  const known = state.hosts[host] || {};
  const deep = opts.deep !== false;
  const maxLoads = opts.maxLoads || MAX_LOADS;
  const deadline = Date.now() + (opts.budgetMs || BUDGET_MS);
  const firstWait = known.cookies?.length ? WARM_TIMEOUT : CONTENT_TIMEOUT;

  const page = await openTab(b, host, known.cookies);
  let root;
  try {
    root = await loadThread(page, host, handle, id, firstWait);
  } catch (e) {
    await page.close().catch(() => {});
    return { ok: false, host, reason: `${host}: ${String(e.message).split("\n")[0]}` };
  }
  if (root.blocked) {
    await page.close().catch(() => {});
    return { ok: false, host, reason: `blocked by ${host} (${root.bodyStart.slice(0, 60)})` };
  }

  // The wall is solved for this host now — bank the cookie for next time.
  try {
    state.hosts[host] = { lastOk: Date.now(), cookies: await page.cookies() };
    saveState(state);
  } catch {}

  const found = new Map(); // reply id → reply, in discovery order
  const queue = []; // branches still to open
  const expanded = new Set([id]);
  let loads = 1;

  const take = (items) => {
    for (const r of items) {
      if (!r.id || found.has(r.id) || r.id === id) continue;
      found.set(r.id, r);
      if (r.replies > 0 && !expanded.has(r.id)) queue.push(r);
    }
  };
  take(root.replies);

  if (deep && queue.length) {
    // Two tabs: enough to hide the round-trip, gentle enough that the mirror
    // does not start 503-ing (they are small boxes and rate-limit hard).
    const tabs = [page];
    for (let i = 1; i < Math.min(TABS, queue.length); i++) {
      tabs.push(await openTab(b, host, known.cookies));
    }
    const worker = async (tab) => {
      while (queue.length && Date.now() < deadline && loads < maxLoads) {
        const node = queue.shift();
        if (!node || expanded.has(node.id)) continue;
        expanded.add(node.id);
        loads++;
        try {
          const got = await loadThread(tab, host, node.handle, node.id, WARM_TIMEOUT);
          if (!got.blocked) take(got.replies);
        } catch {
          // A single dead branch is not worth failing the whole conversation.
        }
      }
    };
    await Promise.all(tabs.map(worker));
    for (const t of tabs.slice(1)) await t.close().catch(() => {});
  }
  await page.close().catch(() => {});

  // Read it the way it happened: the tweet first, then every reply in the order
  // it was posted, regardless of which branch the walk found it on.
  const replies = [...found.values()]
    .map(decorate)
    .sort((a, b2) => (a.ts && b2.ts ? Date.parse(a.ts) - Date.parse(b2.ts) : 0));

  return {
    ok: true,
    host,
    main: root.main ? decorate({ ...root.main, id: root.main.id || id, handle: root.main.handle || handle }) : null,
    replies,
    loads,
    // Only genuinely incomplete if branches were left unopened.
    partial: queue.length > 0,
  };
}

// fetchCommentsNoLogin(id, handle) → { ok, replies:[...], via } | { ok:false, reason }
async function fetchCommentsNoLogin(id, handle, opts = {}) {
  const deep = opts.deep !== false;
  const hit = cache.get(`${id}|${deep ? "deep" : "fast"}`);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.data;
  // `busy` was tracked but never actually gated a second caller — unlike
  // converters.js's identical flag, this let concurrent /api/comments calls
  // stack multiple Puppeteer scrapes (2 tabs each, up to 60s) on the same
  // 2-core box at once. One conversation walk at a time, same as converters.js.
  if (busy) return { ok: false, reason: "busy — try again shortly" };

  busy = true;
  const tried = [];
  try {
    for (const host of rankedMirrors()) {
      const r = await scrapeMirror(host, id, handle, opts);
      if (r.ok) {
        const data = {
          ok: true,
          via: host,
          main: r.main,
          replies: r.replies,
          partial: !!r.partial,
          pages_read: r.loads,
        };
        cache.set(`${id}|${deep ? "deep" : "fast"}`, { data, ts: Date.now() });
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

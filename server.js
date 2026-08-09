// Twitter/X tweet extractor — paste a tweet link, download its full text,
// images, video, and all metadata. Uses X's public syndication endpoint (no
// login) for text/images/info and yt-dlp for video. Replies/comments are not
// available without an authenticated account — surfaced honestly in the UI.
const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const { execFile } = require("child_process");
const { convertViaWeb } = require("./converters");
const { fetchCommentsNoLogin } = require("./comments");

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

// The port is reachable from the internet — keep strangers from turning this
// into a free download farm. Cheap fixed-window limiter, no deps.
// Bucketed per IP AND per route: one shared per-IP counter meant every
// endpoint's requests were charged to the same tally and then compared against
// that endpoint's own max, so TikTok downloads ate Instagram's budget and the
// strictest route (/api/mp3, 5) throttled everything after 5 calls of any kind.
const hits = new Map(); // "ip|route" → { n, windowStart }
function rateLimit(max) {
  return (req, res, next) => {
    // The emulator, cron probes, logwatch and every other local process hit
    // this server through the loopback — one shared bucket made the app's
    // own downloads throttle against my own tests. The emulator also reaches
    // the box through its own public IP (apps hardcode it), which only this
    // machine can present as a source address. Loopback and self are the
    // operator; rate limits exist for strangers, judged by their real socket
    // IP (x-forwarded-for is ignored for them the moment it can be spoofed).
    const remote = req.ip;
    if (remote === "127.0.0.1" || remote === "::1" || remote === "72.60.89.132" || remote === "::ffff:72.60.89.132") return next();
    const ip = (req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || remote).replace("::ffff:", "");
    const key = ip + "|" + req.path;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.windowStart > 60_000) {
      hits.set(key, { n: 1, windowStart: now });
      return next();
    }
    if (++h.n > max) return res.status(429).json({ error: "Slow down — try again in a minute." });
    next();
  };
}
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [key, h] of hits) if (h.windowStart < cutoff) hits.delete(key);
}, 300_000).unref();

const DL = path.join(__dirname, "downloads");
fs.mkdirSync(DL, { recursive: true });
const YTDLP = path.join(os.homedir(), "bin", "yt-dlp");
const COOKIES = path.join(os.homedir(), ".config", "twdl", "cookies.txt");
// Separate jar: the X cookies above are no use to YouTube. Optional — the
// yt-dlp fallback runs without it, just with worse odds against the bot wall.
const YT_COOKIES = path.join(os.homedir(), ".config", "twdl", "youtube-cookies.txt");
// eta.etacloud.org is the y2mate.gs engine, reached directly. See /api/mp3.
const ETA_BASE = "https://eta.etacloud.org/api/v1";
const ETA_REF = "https://y2mate.gs/";
const ETA_ORI = "https://y2mate.gs";
const ETA_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function tweetId(input) {
  const s = String(input || "").trim();
  if (/^\d{5,25}$/.test(s)) return s;
  const m = s.match(/(?:twitter|x)\.com\/[^/]+\/status(?:es)?\/(\d+)/i);
  return m ? m[1] : null;
}

// X's embed widget derives this token from the id; a stable derivation works.
function synToken(id) {
  return ((Number(id) / 1e15) * Math.PI)
    .toString(6 ** 2)
    .replace(/(0+|\.)/g, "");
}

async function fetchTweet(id) {
  const url =
    `https://cdn.syndication.twimg.com/tweet-result?id=${id}` +
    `&token=${synToken(id)}&lang=en`;
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`syndication HTTP ${r.status}`);
  return r.json();
}

// Sensitive-flagged tweets come back as an empty TweetTombstone from the
// syndication endpoint; the fxtwitter API still serves them, including direct
// video.twimg.com mp4 URLs.
async function fetchFx(id) {
  const r = await fetch(`https://api.fxtwitter.com/status/${id}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`fxtwitter HTTP ${r.status}`);
  const j = await r.json();
  if (!j.tweet) throw new Error("tweet unavailable");
  return j.tweet;
}

function normalizeFx(t) {
  const media = t.media?.all || [];
  return {
    id: t.id,
    text: t.text || "",
    author: t.author
      ? { name: t.author.name, handle: t.author.screen_name, avatar: t.author.avatar_url }
      : null,
    created_at: t.created_at || null,
    stats: { likes: t.likes ?? null, retweets: t.retweets ?? null, replies: t.replies ?? null },
    images: media.filter((m) => m.type === "photo").map((m) => m.url),
    has_video: media.some((m) => m.type === "video" || m.type === "gif"),
    quoted: t.quote ? { text: t.quote.text, handle: t.quote.author?.screen_name } : null,
    comments_available: true,
    raw: t,
  };
}

// Highest-bitrate direct mp4 for a tweet, or null if it has no video.
async function fxVideoUrl(id) {
  const t = await fetchFx(id);
  const vids = (t.media?.all || []).filter((m) => m.type === "video" || m.type === "gif");
  if (!vids.length) return null;
  const formats = (vids[0].formats || []).filter((f) => f.container === "mp4");
  if (formats.length) return formats.reduce((a, b) => ((b.bitrate || 0) > (a.bitrate || 0) ? b : a)).url;
  return vids[0].url || null;
}

function normalize(t) {
  const photos = [];
  const push = (arr) =>
    (arr || []).forEach((m) => {
      if (m?.type === "photo" && m.url) photos.push(m.url);
    });
  push(t.mediaDetails);
  push(t.photos);
  (t.photos || []).forEach((p) => p?.url && photos.push(p.url));
  // t.photos sometimes carries the tweet's t.co permalink — keep real images only.
  const uniqPhotos = [...new Set(photos)].filter((u) =>
    /^https:\/\/pbs\.twimg\.com\//.test(u));
  const hasVideo =
    (t.mediaDetails || []).some((m) => m.type === "video" || m.type === "animated_gif") ||
    !!t.video;
  return {
    id: t.id_str || t.id,
    text: t.text || t.full_text || "",
    author: t.user
      ? { name: t.user.name, handle: t.user.screen_name, avatar: t.user.profile_image_url_https }
      : null,
    created_at: t.created_at || null,
    stats: {
      likes: t.favorite_count ?? null,
      retweets: t.conversation_count ?? t.retweet_count ?? null,
      replies: t.reply_count ?? null,
    },
    images: uniqPhotos,
    has_video: hasVideo,
    quoted: t.quoted_tweet
      ? { text: t.quoted_tweet.text, handle: t.quoted_tweet.user?.screen_name }
      : null,
    // X's own endpoints never carry the reply thread logged-out, but a public
    // Nitter mirror does — /api/comments walks one with a headless browser.
    comments_available: true,
    raw: t,
  };
}

app.post("/api/fetch", rateLimit(20), async (req, res) => {
  const id = tweetId(req.body?.url);
  if (!id) return res.status(400).json({ error: "Not a valid tweet link or ID" });
  try {
    const t = await fetchTweet(id);
    if (t?.__typename === "TweetTombstone") throw new Error("tombstone");
    res.json({ ok: true, ...normalize(t) });
  } catch (err) {
    try {
      res.json({ ok: true, ...normalizeFx(await fetchFx(id)) });
    } catch {
      res.status(502).json({ error: `Couldn't read that tweet (${err.message}). It may be private or deleted.` });
    }
  }
});

// Replies, with no X account anywhere in the loop. X serves none of these
// logged-out (syndication has no reply field, fxtwitter only a count, guest
// TweetDetail 404s), so this walks a public Nitter mirror in a headless browser
// — the same trick /api/convert already uses for converter sites. Cold call
// pays the mirror's proof-of-work wall (~15s); after that its cookie is cached.
app.get("/api/comments", rateLimit(10), async (req, res) => {
  const id = tweetId(req.query.url);
  if (!id) return res.status(400).json({ error: "Not a valid tweet link or ID" });
  let handle = String(req.query.handle || "").replace(/[^A-Za-z0-9_]/g, "");
  try {
    if (!handle) {
      // Nitter needs the author in the path; the public endpoint hands it over.
      const t = await fetchTweet(id).catch(() => null);
      handle = t?.user?.screen_name || (await fetchFx(id).catch(() => null))?.author?.screen_name || "";
    }
    // deep=0 → just the first thread page (fast); default walks the whole tree.
    const r = await fetchCommentsNoLogin(id, handle, {
      deep: req.query.deep !== "0",
      budgetMs: Math.min(120000, Math.max(10000, Number(req.query.budget) * 1000 || 60000)),
    });
    if (!r.ok) return res.status(502).json({ error: r.reason });
    res.json({
      ok: true,
      id,
      via: r.via,
      login_required: false,
      partial: !!r.partial,
      pages_read: r.pages_read,
      count: r.replies.length,
      // The tweet itself, so a client can render the conversation from the
      // person who started it down to the last reply on one page.
      main: r.main,
      url: `https://x.com/${handle || "i"}/status/${id}`,
      replies: r.replies,
    });
  } catch (e) {
    res.status(502).json({ error: `comments failed: ${e.message}` });
  }
});

// Proxy an image so the browser can force-download it (avoids CORS).
app.get("/api/image", rateLimit(60), async (req, res) => {
  const u = String(req.query.u || "");
  if (!/^https:\/\/pbs\.twimg\.com\//.test(u))
    return res.status(400).send("bad image url");
  try {
    const r = await fetch(u.includes("?") ? u : u + "?name=orig", {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return res.status(502).send("fetch failed");
    const name = ((u.split("/").pop() || "image").split("?")[0]).replace(/[^\w.-]/g, "_");
    res.setHeader("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.jpg"`);
    const buf = Buffer.from(await r.arrayBuffer());
    res.end(buf);
  } catch {
    res.status(502).send("image error");
  }
});

// Download the video: fast path streams the direct video.twimg.com mp4 that
// fxtwitter resolves (no re-download through yt-dlp); yt-dlp is the fallback.
let videoJobs = 0;
// 15/min: the app's paste-retry + stall-watchdog re-enqueues can burn
// several hits per download; 5 was 429-ing real phones mid-flow.
app.get("/api/video", rateLimit(15), async (req, res) => {
  const id = tweetId(req.query.url);
  if (!id) return res.status(400).json({ error: "bad url" });
  try {
    const direct = await fxVideoUrl(id);
    // fx loaded the tweet and found no video at all — yt-dlp can't do better
    // (no login cookies), so answer honestly instead of "needs login".
    if (direct === null)
      return res.status(404).json({ error: "This tweet has no video — it's text or photos only." });
    if (direct && /^https:\/\/video\.twimg\.com\//.test(direct)) {
      // Timeout covers connecting to the CDN only — never the body stream,
      // or slow phone downloads get cut mid-file and look like a freeze.
      const ac = new AbortController();
      const connTimer = setTimeout(() => ac.abort(), 30_000);
      const r = await fetch(direct, {
        headers: { "User-Agent": UA },
        signal: ac.signal,
      });
      clearTimeout(connTimer);
      if (r.ok && r.body) {
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Disposition", `attachment; filename="tweet-${id}.mp4"`);
        const len = r.headers.get("content-length");
        if (len) res.setHeader("Content-Length", len);
        const { Readable } = require("stream");
        const body = Readable.fromWeb(r.body);
        body.on("error", () => res.destroy());
        res.on("close", () => body.destroy()); // phone gave up → stop pulling from CDN
        return body.pipe(res);
      }
    }
  } catch {} // fall through to yt-dlp
  if (videoJobs >= 2)
    return res.status(429).json({ error: "Busy with other downloads — try again shortly." });
  videoJobs++;
  const out = path.join(DL, `${id}.%(ext)s`);
  const args = [
    `https://x.com/i/status/${id}`,
    "-o", out,
    "-f", "mp4/best",
    "--no-playlist",
    "--force-overwrites",
    "--ffmpeg-location", path.join(os.homedir(), "bin"),
  ];
  if (fs.existsSync(COOKIES)) args.push("--cookies", COOKIES);
  execFile(YTDLP, args, { timeout: 120000 }, async (err) => {
    videoJobs--;
    if (err) {
      return res.status(502).json({
        error:
          "Video download failed. X often needs login for video — add a cookies file at ~/.config/twdl/cookies.txt.",
      });
    }
    try {
      const files = (await fsp.readdir(DL)).filter((f) => f.startsWith(id + "."));
      if (!files.length) return res.status(404).json({ error: "no file produced" });
      const file = path.join(DL, files[0]);
      res.download(file, `tweet-${id}.mp4`, () => fs.unlink(file, () => {}));
    } catch {
      res.status(500).json({ error: "read failed" });
    }
  });
});

// TikTok and Instagram → MP4 via yt-dlp. Unlike X, both serve the media URL on
// the public page, so neither needs cookies and one handler covers both.
// Accepts the host and its subdomains only, so a lookalike like
// eviltiktok.com is rejected; TikTok's vm./vt. share shorteners are
// subdomains, and yt-dlp follows their redirect itself.
function siteUrl(input, hostRe) {
  const s = String(input || "").trim();
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (!hostRe.test(u.hostname)) return null;
  return u.toString();
}

// A URL is safe for this box to fetch — or to hand to the app — only when it is
// plain http(s) and every address it resolves to is public. The literal text
// check alone is not enough: a perfectly public-looking hostname can resolve to
// a private address, and that is exactly how an SSRF gets past a regex.
const PRIVATE_IP =
  /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80:)/i;

async function publicUrl(input) {
  let u;
  try {
    u = new URL(String(input || ""));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || PRIVATE_IP.test(host)) return null;
  try {
    const addrs = await require("dns").promises.lookup(host, { all: true });
    if (addrs.some((a) => PRIVATE_IP.test(a.address))) return null;
  } catch {
    return null;
  }
  return u.toString();
}

// fetch() follows redirects by itself, which would walk straight past the check
// above — a public link that answers 302 with an internal address still ends up
// fetched. So the hops are walked by hand and every one of them is re-checked.
async function fetchPublic(input, headers, hops = 5) {
  let target = input;
  for (let i = 0; i < hops; i++) {
    const safe = await publicUrl(target);
    if (!safe) throw new Error("blocked");
    const r = await fetch(safe, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(180000),
    });
    const loc = r.status >= 300 && r.status < 400 && r.headers.get("location");
    if (!loc) return r;
    target = new URL(loc, safe).toString();
  }
  throw new Error("too many redirects");
}

// Maps a yt-dlp failure to an honest HTTP answer. A photo-only post is a
// correct answer, not a failure — say so plainly instead of blaming the
// network (same honesty as /api/video for text-only tweets).
function ytdlpError(res, stderr, site) {
  const msg = String(stderr || "");
  if (/no video in this post|there is no video/i.test(msg))
    return res.status(404).json({ error: `This ${site} post has no video — it's a photo.` });
  if (/login required|requested content is not available|rate.?limit/i.test(msg))
    return res.status(502).json({
      error: `${site} is asking for a login for this one — it may be private or age-restricted.`,
    });
  return res.status(502).json({
    error: `${site} download failed — the video may be private, removed, or region-locked.`,
  });
}

// Hand back the signed CDN URL instead of the bytes, so the phone downloads
// straight from the source in one hop — no VPS bandwidth, no waiting for us to
// pull the file first. Only offered for Instagram: its signed links serve from
// any IP with no headers, while TikTok's CDN 403s anything but the session that
// extracted them (verified both ways), which is why /api/tiktok streams instead.
// onFail (unlike onNoVideo, which is only "this post has no video") runs on ANY
// yt-dlp failure, so a caller can hand the link to the converter bridge instead
// of turning an extractor gap into a dead end for the user.
function ytdlpDirectUrl(res, url, site, onNoVideo, onFail) {
  if (videoJobs >= 2)
    return res.status(429).json({ error: "Busy with other downloads — try again shortly." });
  videoJobs++;
  const args = [url, "-g", "-f", "mp4/best", "--no-playlist", "--no-warnings"];
  execFile(YTDLP, args, { timeout: 60000 }, (err, stdout, stderr) => {
    videoJobs--;
    if (err && onNoVideo && /no video in this post|there is no video/i.test(String(stderr)))
      return onNoVideo();
    if (err) return onFail ? onFail() : ytdlpError(res, stderr, site);
    const direct = String(stdout || "").trim().split("\n")[0];
    if (!/^https:\/\//.test(direct))
      return onFail ? onFail() : res.status(502).json({ error: `${site}: no direct link found` });
    res.json({ ok: true, url: direct });
  });
}

function ytdlpToClient(res, url, site, onNoVideo, onFail) {
  if (videoJobs >= 2)
    return res.status(429).json({ error: "Busy with other downloads — try again shortly." });
  videoJobs++;
  // Per-job dir: the filename comes from yt-dlp metadata, so there is no
  // predictable name to collide on or to clean up by prefix.
  const job = path.join(DL, `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(job, { recursive: true });
  const cleanup = () => fs.rm(job, { recursive: true, force: true }, () => {});
  const args = [
    url,
    "-o", path.join(job, "%(uploader)s-%(id)s.%(ext)s"),
    "-f", "mp4/best",
    "--no-playlist",
    // ASCII-only names — handles on both sites carry emoji and RTL text, which
    // would otherwise land raw in the Content-Disposition header.
    "--restrict-filenames",
    "--force-overwrites",
    "--ffmpeg-location", path.join(os.homedir(), "bin"),
  ];
  execFile(YTDLP, args, { timeout: 180000 }, async (err, stdout, stderr) => {
    videoJobs--;
    if (err) {
      cleanup();
      if (onNoVideo && /no video in this post|there is no video/i.test(String(stderr)))
        return onNoVideo();
      return onFail ? onFail() : ytdlpError(res, stderr, site);
    }
    try {
      const files = (await fsp.readdir(job)).filter((f) => !f.endsWith(".part"));
      if (!files.length) {
        cleanup();
        return res.status(404).json({ error: "no file produced" });
      }
      res.download(path.join(job, files[0]), files[0], cleanup);
    } catch {
      cleanup();
      res.status(500).json({ error: "read failed" });
    }
  });
}

// Tiers 2 and 3 of the converter, reusable: drive a headless browser through an
// online converter for what yt-dlp cannot extract, and carry the bytes ourselves
// only if that fails too. Every endpoint that can hit an extractor gap routes
// here instead of answering "not supported".
async function convertBridge(res, url, site, wantJson) {
  const r = await convertViaWeb(url);
  // The converter hands back a second link that this box is about to fetch —
  // or that the app will — so it earns the same address check the pasted link
  // got. A converter can be pointed back at our own network just as easily.
  if (r && r.url && !(await publicUrl(r.url))) r.url = null;
  if (r && r.url) {
    // The app gets the link plus the headers that make it work, and pulls the
    // bytes itself. A browser cannot attach someone else's cookies to a plain
    // download, so for the web UI this box streams it through instead.
    if (wantJson)
      return res.json({ ok: true, url: r.url, via: r.via, site, headers: r.headers || {} });
    try {
      const up = await fetchPublic(r.url, r.headers || {});
      if (!up.ok) throw new Error(String(up.status));
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `attachment; filename="${site.toLowerCase()}-video.mp4"`);
      const len = up.headers.get("content-length");
      if (len) res.setHeader("Content-Length", len);
      const { Readable } = require("stream");
      return Readable.fromWeb(up.body).pipe(res);
    } catch {
      return ytdlpToClient(res, url, site);
    }
  }
  // Tier 3: nothing direct worked — carry the bytes ourselves.
  if (wantJson)
    return res.status(502).json({ error: `${site}: no direct link found — try the in-app download.` });
  return ytdlpToClient(res, url, site);
}

// ── multi-site converter ───────────────────────────────────────────────────
// Everything yt-dlp can pull that is not one of the four first-class sites.
// The host list is an allowlist on purpose: this endpoint hands a user-supplied
// URL to a subprocess, so "any URL" would be an SSRF hole aimed at the VPS's own
// network. Adding a site is one entry here — nothing else changes.
const MEDIA_HOSTS =
  /^(?:.*\.)?(facebook\.com|fb\.watch|fb\.com|reddit\.com|redd\.it|pinterest\.[a-z.]{2,6}|pin\.it|snapchat\.com|twitch\.tv|vimeo\.com|dailymotion\.com|dai\.ly|kick\.com|tumblr\.com|threads\.net|threads\.com|streamable\.com|imgur\.com|rumble\.com|odysee\.com|bilibili\.com|ok\.ru|vk\.com|soundcloud\.com|9gag\.com|likee\.video|linkedin\.com|bsky\.app|twitch\.com|douyin\.com|iesdouyin\.com|weibo\.com|weibo\.cn|xiaohongshu\.com|xhslink\.com|kuaishou\.com|t\.me|telegram\.me|rutube\.ru|trovo\.live|medal\.tv|mixcloud\.com|bandcamp\.com|loom\.com|coub\.com|nicovideo\.jp|bigo\.tv|sendvid\.com|streamff\.com|ted\.com)$/i;

const SITE_LIST = [
  "Facebook", "Reddit", "Pinterest", "Snapchat", "Twitch", "Vimeo", "Dailymotion",
  "Kick", "Tumblr", "Threads", "Streamable", "Imgur", "Rumble", "Odysee",
  "Bilibili", "OK.ru", "VK", "SoundCloud", "9GAG", "Likee", "LinkedIn", "Bluesky",
  "Douyin", "Weibo", "Xiaohongshu (RedNote)", "Kuaishou", "Telegram", "Rutube",
  "Trovo", "Medal.tv", "Mixcloud", "Bandcamp", "Loom", "Coub", "Niconico",
  "Bigo Live", "Sendvid", "Streamff", "TED",
];

function siteLabel(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, "").split(".")[0];
    return h.charAt(0).toUpperCase() + h.slice(1);
  } catch {
    return "Media";
  }
}

// Same trick the app already uses for YouTube and Instagram: ask for the signed
// direct link first (~1s, the phone then pulls the bytes straight from the
// source CDN and this box carries none of it), and only stream through the VPS
// when a site's CDN refuses outsiders — TikTok-style. One endpoint, both paths.
app.get("/api/media", rateLimit(15), (req, res) => {
  const url = siteUrl(req.query.url, MEDIA_HOSTS);
  if (!url)
    return res.status(400).json({
      error: "That site isn't supported yet.",
      supported: SITE_LIST,
    });
  const site = siteLabel(url);
  const wantJson = req.query.direct === "1";
  // An extractor gap on an allowlisted site is not the end of the road: hand the
  // link to the same headless-browser converter bridge /api/convert uses. Sites
  // yt-dlp has no extractor for (or lost one to a site redesign) still download.
  const bridge = () => convertBridge(res, url, site, wantJson).catch(() =>
    res.status(502).json({ error: `${site}: conversion failed` }));
  if (wantJson) return ytdlpDirectUrl(res, url, site, null, bridge);
  ytdlpToClient(res, url, site, null, bridge);
});

// So the app and the web UI can show the real list instead of hard-coding it.
app.get("/api/sites", rateLimit(60), (_req, res) =>
  res.json({ ok: true, first_class: ["X / Twitter", "YouTube", "TikTok", "Instagram"], more: SITE_LIST })
);

// The catch-all: any link from anywhere. Three tiers, cheapest first —
//   1. yt-dlp direct link  (~1s, phone pulls from the source CDN, no VPS bytes)
//   2. online converter driven by a headless browser (covers what yt-dlp can't:
//      Reddit's login wall, Vimeo's OAuth, small sites with no extractor)
//   3. yt-dlp streaming through this box (last resort, costs bandwidth)
// direct=1 answers with JSON for the app; a plain call redirects to the link so
// a browser just downloads it.
app.get("/api/convert", rateLimit(10), async (req, res) => {
  const url = siteUrl(req.query.url, /.*/);
  if (!url) return res.status(400).json({ error: "Not a valid link" });
  // Never let a pasted link point this server at its own network.
  if (!(await publicUrl(url)))
    return res.status(400).json({ error: "Not a valid link" });

  const site = siteLabel(url);
  const wantJson = req.query.direct === "1";

  const tryBrowser = () => convertBridge(res, url, site, wantJson);

  // Tier 1: yt-dlp's own signed link. It resolves the host itself, so what it
  // returns is checked before it is passed on rather than trusted outright.
  const args = [url, "-g", "-f", "mp4/best", "--no-playlist", "--no-warnings"];
  execFile(YTDLP, args, { timeout: 45000 }, async (err, stdout) => {
    const direct = String(stdout || "").trim().split("\n")[0];
    if (!err && /^https:\/\//.test(direct) && (await publicUrl(direct))) {
      if (wantJson) return res.json({ ok: true, url: direct, via: "yt-dlp", site });
      return res.redirect(302, direct);
    }
    tryBrowser().catch(() =>
      res.status(502).json({ error: `${site}: conversion failed` })
    );
  });
});

// YouTube MP4 the way the KDL app's own flow was born: drive y2mate.gs in a
// headless browser, press the MP4 format button (its default is MP3), press
// Download, and hand the phone the direct link the site produces — the phone
// pulls the bytes itself, nothing streams through this box. That is the
// "trick" the site does with a human, done with a browser.
// direct=1 → { ok, url, via, headers }; otherwise the file is streamed through
// the VPS so the web UI can download it without session headers.
app.get("/api/ytmp4", rateLimit(4), async (req, res) => {
  const u = String(req.query.url || "");
  const m = u.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  if (!m) return res.status(400).json({ error: "Not a valid YouTube link" });
  const id = m[1];
  const target = `https://www.youtube.com/watch?v=${id}`;
  const wantJson = req.query.direct === "1";
  // One tab at a time on a 2-core box; a busy converter is a temporary
  // condition, so wait for it instead of failing on the first collision.
  let r = null;
  for (let i = 0; i < 5 && !r; i++) {
    r = await convertViaWeb(target);
    if (!r && i < 4) await new Promise((s) => setTimeout(s, 5000));
  }
  if (!r) {
    return res.status(502).json({ error: "y2mate conversion failed — try again in a minute." });
  }
  const name = `youtube-${id}.mp4`;
  if (wantJson) return res.json({ ok: true, url: r.url, via: r.via, headers: r.headers, title: r.title || "" });
  try {
    const dl = await fetch(r.url, {
      headers: { ...r.headers, Range: req.headers.range || "bytes=0-" },
      signal: AbortSignal.timeout(180000),
    });
    if (!dl.ok && dl.status !== 206)
      return res.status(502).json({ error: `y2mate link failed (HTTP ${dl.status})` });
    const ct = dl.headers.get("content-type") || "video/mp4";
    res.status(dl.status);
    res.setHeader("Content-Type", ct);
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    for (const k of ["content-length", "content-range", "accept-ranges"])
      if (dl.headers.get(k)) res.setHeader(k, dl.headers.get(k));
    return dl.body.pipe(res);
  } catch (e) {
    return res.status(502).json({ error: `y2mate stream failed: ${e.message}` });
  }
});

app.get("/api/tiktok", rateLimit(15), (req, res) => {
  const url = siteUrl(req.query.url, /(^|\.)tiktok\.com$/i);
  if (!url) return res.status(400).json({ error: "Not a valid TikTok link" });
  ytdlpToClient(res, url, "TikTok");
});

app.get("/api/instagram", rateLimit(15), (req, res) => {
  const url = siteUrl(req.query.url, /(^|\.)instagram\.com$/i);
  if (!url) return res.status(400).json({ error: "Not a valid Instagram link" });
  // A photo post has no video by definition, so yt-dlp saying "there is no
  // video" is the correct answer, not a failure — fall through to the image
  // path instead of reporting an error the way it used to.
  const photos = () => igPhotos(req, res, url);
  // direct=1 → JSON {url} with the CDN link (the app's fast path, ~1s);
  // without it, stream the bytes as a normal download for the web UI and as
  // the app's fallback when a direct link won't play.
  if (req.query.direct === "1") return ytdlpDirectUrl(res, url, "Instagram", photos);
  ytdlpToClient(res, url, "Instagram", photos);
});

// Instagram photos. The public embed page carries the full-size image and needs
// no login, which is the only reason photo posts can work at all here — the
// regular endpoints are login-walled. Same shape as the video path: direct=1
// hands back the CDN links, otherwise the image is streamed as a download.
const IG_CODE = /\/(?:reels?|p|tv)\/([\w-]+)/;

async function igImageUrls(url) {
  const m = IG_CODE.exec(new URL(url).pathname);
  if (!m) return [];
  // The bare UA matters: a full Chrome UA gets the 600KB JS app shell with no
  // image in it, while a minimal one gets the ~100KB server-rendered embed that
  // still carries the picture. Verified both ways — do not "modernise" this.
  const r = await fetch(`https://www.instagram.com/p/${m[1]}/embed/captioned/`, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) return [];
  const html = await r.text();
  const out = [];
  // Whatever comes out of a scraped page is somebody else's string, and this
  // box turns it into a request — so only Instagram's own CDN gets through.
  const igCdn = (u) => {
    try {
      const h = new URL(u);
      return (
        h.protocol === "https:" &&
        /(^|\.)(cdninstagram\.com|fbcdn\.net|instagram\.com)$/i.test(h.hostname)
      );
    } catch {
      return false;
    }
  };
  for (const mm of html.matchAll(/"display_url":"([^"]+)"/g)) {
    try {
      const u = JSON.parse(`"${mm[1]}"`);
      if (igCdn(u)) out.push(u);
    } catch {}
  }
  if (!out.length) {
    // The server-rendered embed inlines the <img> instead of a JSON blob.
    // t51.2885-19 and the s100x100/s150x150 crops are the poster's avatar, not
    // the post itself — dropping them is what separates photo from profile pic.
    for (const mm of html.matchAll(/src="(https:\/\/[^"]*scontent[^"]*t51[^"]*)"/g)) {
      const u = mm[1].replace(/&amp;/g, "&");
      if (!/t51\.2885-19|s150x150|s100x100|profile_pic/.test(u) && igCdn(u)) out.push(u);
    }
  }
  return [...new Set(out)];
}

async function igPhotos(req, res, url) {
  let imgs = [];
  try {
    imgs = await igImageUrls(url);
  } catch {}
  if (!imgs.length)
    return res.status(404).json({
      error: "This Instagram post has no video, and its photo could not be read — it may be private.",
    });
  const code = (IG_CODE.exec(new URL(url).pathname) || [])[1] || Date.now();
  if (req.query.direct === "1")
    return res.json({ ok: true, kind: "image", url: imgs[0], images: imgs, count: imgs.length });
  try {
    const r = await fetchPublic(imgs[0], {});
    if (!r.ok) throw new Error(String(r.status));
    res.setHeader("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.setHeader("Content-Disposition", `attachment; filename="instagram-${code}.jpg"`);
    const { Readable } = require("stream");
    Readable.fromWeb(r.body).pipe(res);
  } catch {
    res.status(502).json({ error: "Instagram photo fetch failed" });
  }
}

// The app calls this on every start with the versionCode it is actually running.
// The server does the comparison and logs the check-in, so "is that phone on the
// latest build?" is answerable here instead of guessed. Falls back gracefully:
// an app that only knows kdl-version.json still works, that file stays as is.
app.get("/api/kdl-check", rateLimit(60), (req, res) => {
  let latest = {};
  try {
    latest = JSON.parse(fs.readFileSync(path.join(__dirname, "public", "kdl-version.json"), "utf8"));
  } catch (e) {
    return res.status(500).json({ error: "no version file" });
  }
  const vc = parseInt(req.query.vc, 10) || 0;
  const upToDate = vc >= (latest.versionCode || 0);
  try {
    fs.appendFileSync(path.join(process.env.HOME, ".cache", "kdl-checkins.log"),
      `${new Date().toISOString()} vc=${vc} vn=${req.query.vn || "?"} latest=${latest.versionCode} ` +
      `${upToDate ? "uptodate" : "OUTDATED"} ip=${req.ip}\n`);
  } catch (e) { /* logging must never break the check */ }
  res.json({
    ok: true,
    versionCode: latest.versionCode,
    versionName: latest.versionName,
    url: latest.url,
    date: latest.date,
    yours: vc,
    upToDate,
  });
});

// YouTube → MP3 via the etacloud converter (primary), local yt-dlp (fallback).
//
// This used to lead with a Railway service, but that trial lapsed and every
// /start now answers 404, so the primary was a guaranteed three-second detour.
// etacloud (the engine behind y2mate.gs) converts on its own machines, which is
// what makes it the right primary here: YouTube bot-walls this VPS's datacenter
// IP — a local yt-dlp run gets LOGIN_REQUIRED on most videos regardless of
// player client, POT provider, or JS runtime. Local extraction stays as the
// fallback because it does still win on the occasional video etacloud misses.
app.get("/api/mp3", rateLimit(5), async (req, res) => {
  const u = String(req.query.url || "");
  const m = u.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})/);
  if (!m) return res.status(400).json({ error: "Not a valid YouTube link" });
  const id = m[1];
  try {
    // Every etacloud call has to carry UA + Referer + Origin: y2mate.gs —
    // omitting Origin gets empty 200s back from /init rather than an error.
    const etaGet = async (url, key, timeout = 25000) => {
      const headers = {
        "User-Agent": ETA_UA,
        "Accept": "application/json,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": ETA_REF,
        "Origin": ETA_ORI,
      };
      if (key) headers.Authorization = `Bearer ${key}`;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
      const t = await r.text();
      try { return JSON.parse(t); }
      catch { throw new Error(`etacloud ${r.status}: ${t.slice(0, 60)}`); }
    };

    const ts = Date.now();
    const { key } = await etaGet(`${ETA_BASE}/auth?_=${ts}`);
    if (!key) throw new Error("etacloud auth: no key");

    const init = await etaGet(`${ETA_BASE}/init?_=${ts}`, key);
    const convertUrl = String(init.convertURL || "").split("&v=")[0];
    if (!convertUrl) throw new Error("etacloud init: no convertURL");

    let conv = await etaGet(`${convertUrl}&v=${id}&f=mp3&_=${ts}`, null, 45000);
    // A busy node hands the job to a sibling: redirectURL, no downloadURL yet.
    for (let i = 0; i < 2; i++) {
      const redir = String(conv.redirectURL || "").split("&v=")[0];
      if (conv.downloadURL || !redir) break;
      conv = await etaGet(`${redir}&v=${id}&f=mp3&_=${Date.now()}`, null, 60000);
    }
    if (!conv.downloadURL) throw new Error(`etacloud convert: ${JSON.stringify(conv).slice(0, 80)}`);

    // progress >= 3 means the file is ready. Cached videos pass instantly;
    // a fresh one converts on etacloud's side and can take ~2 minutes.
    let title = conv.title || "";
    if (conv.progressURL) {
      let ready = false;
      for (let i = 0; i < 40 && !ready; i++) {
        const pr = await etaGet(`${conv.progressURL}&_=${Date.now()}`, null, 15000);
        if (pr.title) title = pr.title;
        if (pr.error) throw new Error(`etacloud progress error=${pr.error}`);
        ready = Number(pr.progress || 0) >= 3;
        if (!ready) await new Promise(r2 => setTimeout(r2, 3000));
      }
      if (!ready) throw new Error("etacloud timeout (progress never reached 3)");
    }

    const dl = await fetch(`${conv.downloadURL}&v=${id}&f=mp3&r=y2mate.gs`, {
      headers: { "User-Agent": ETA_UA, "Referer": ETA_REF, "Origin": ETA_ORI },
      signal: AbortSignal.timeout(180000),
    });
    if (!dl.ok) throw new Error(`etacloud download HTTP ${dl.status}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    // An HTML error page would sail through as a 200 and land in the user's
    // Music folder named .mp3, so the bytes get checked before they are sent.
    if (buf.length < 40000) throw new Error(`etacloud download too small (${buf.length}B)`);

    // The name comes back from the converter service, and it is about to be
    // a response header — a quote or a newline in it would break the header
    // apart, so it gets the same scrub /api/image gives its filenames.
    const fname = (String(title || `youtube-${id}`)
      .replace(/[^\w.\- ]/g, "_")
      .slice(0, 120) || `youtube-${id}`) + ".mp3";
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    return res.end(buf);
  } catch (e) {
    // etacloud failed — try local yt-dlp as fallback
    if (videoJobs >= 2)
      return res.status(429).json({ error: "Busy — try again shortly." });
    videoJobs++;
    const out = path.join(DL, `yt-${id}.%(ext)s`);
    const args = [
      `https://www.youtube.com/watch?v=${id}`,
      "-o", out, "-x", "--audio-format", "mp3", "--audio-quality", "0",
      "--no-playlist", "--force-overwrites",
      "--ffmpeg-location", path.join(os.homedir(), "bin"),
    ];
    // COOKIES is the X/Twitter jar — it holds nothing YouTube will accept, and
    // handing yt-dlp an unrelated cookie file is not what unblocks a bot wall.
    if (fs.existsSync(YT_COOKIES)) args.push("--cookies", YT_COOKIES);
    execFile(YTDLP, args, { timeout: 300000 }, (err, _stdout, stderr) => {
      videoJobs--;
      // Report the error that actually stopped the download. Reporting `e` here
      // — the primary's failure — is what made this look like a converter
      // outage in the logs while the real message sat in yt-dlp's stderr.
      if (err) {
        const why = String(stderr || "").split("\n").filter(l => l.startsWith("ERROR:")).pop()
          || err.message;
        return res.status(502).json({ error: `MP3 download failed: ${why.slice(0, 200)} (primary: ${e.message})` });
      }
      const file = path.join(DL, `yt-${id}.mp3`);
      if (!fs.existsSync(file)) return res.status(404).json({ error: "no file produced" });
      res.download(file, `youtube-${id}.mp3`, () => fs.unlink(file, () => {}));
    });
  }
});

const PORT = parseInt(process.env.PORT || "4310", 10);
// Only bind a port when this file is the program. Required as a module it just
// hands over the pieces worth testing on their own — the address guard above is
// the kind of thing that has to be provable, not eyeballed.
if (require.main === module) {
  const server = app.listen(PORT, () =>
    console.log(`twitter-dl on http://localhost:${PORT}`));
  // Losing a start race with another copy of ourselves is not a crash worth a
  // stack trace — the copy that won is already serving. Say so in one line.
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`port ${PORT} already served by another twitter-dl — exiting`);
      process.exit(0);
    }
    throw err;
  });
}

module.exports = { app, publicUrl, fetchPublic };

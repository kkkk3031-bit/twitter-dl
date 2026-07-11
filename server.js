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

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

// The port is reachable from the internet — keep strangers from turning this
// into a free download farm. Cheap fixed-window per-IP limiter, no deps.
const hits = new Map(); // ip → { n, windowStart }
function rateLimit(max) {
  return (req, res, next) => {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.windowStart > 60_000) {
      hits.set(ip, { n: 1, windowStart: now });
      return next();
    }
    if (++h.n > max) return res.status(429).json({ error: "Slow down — try again in a minute." });
    next();
  };
}
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [ip, h] of hits) if (h.windowStart < cutoff) hits.delete(ip);
}, 300_000).unref();

const DL = path.join(__dirname, "downloads");
fs.mkdirSync(DL, { recursive: true });
const YTDLP = path.join(os.homedir(), "bin", "yt-dlp");
const COOKIES = path.join(os.homedir(), ".config", "twdl", "cookies.txt");
const YT_RAILWAY = "https://youtube-mp3-downloader-production-c1e2.up.railway.app";
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
    // The public endpoint returns at most a couple of parent tweets, never the
    // full reply thread — comments require a logged-in account.
    comments_available: false,
    raw: t,
  };
}

app.post("/api/fetch", rateLimit(20), async (req, res) => {
  const id = tweetId(req.body?.url);
  if (!id) return res.status(400).json({ error: "Not a valid tweet link or ID" });
  try {
    const data = normalize(await fetchTweet(id));
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(502).json({ error: `Couldn't read that tweet (${err.message}). It may be private or deleted.` });
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

// Download the video via yt-dlp and stream the file back.
let videoJobs = 0;
app.get("/api/video", rateLimit(5), async (req, res) => {
  const id = tweetId(req.query.url);
  if (!id) return res.status(400).json({ error: "bad url" });
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

// YouTube → MP3 via yt-dlp (Railway API primary, local fallback).
app.get("/api/mp3", rateLimit(5), async (req, res) => {
  const u = String(req.query.url || "");
  const m = u.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})/);
  if (!m) return res.status(400).json({ error: "Not a valid YouTube link" });
  const id = m[1];
  // Railway job flow (fast, has cookies)
  try {
    const r = await fetch(YT_RAILWAY + "/start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: u }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    const jobId = j.job_id;
    if (!jobId) throw new Error("no job_id");
    for (let i = 0; i < 150; i++) {
      await new Promise(r2 => setTimeout(r2, 2000));
      const s = await fetch(YT_RAILWAY + "/status/" + jobId, { signal: AbortSignal.timeout(10000) });
      const st = await s.json();
      if (st.status === "done") {
        const dl = await fetch(YT_RAILWAY + "/download/" + jobId, { signal: AbortSignal.timeout(120000) });
        if (!dl.ok) throw new Error("download failed");
        const buf = Buffer.from(await dl.arrayBuffer());
        const fname = st.filename || `youtube-${id}.mp3`;
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
        return res.end(buf);
      }
      if (st.status === "error") throw new Error(st.error || "convert failed");
    }
    throw new Error("timeout");
  } catch (e) {
    // Railway failed — try local yt-dlp as fallback
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
    if (fs.existsSync(COOKIES)) args.push("--cookies", COOKIES);
    execFile(YTDLP, args, { timeout: 300000 }, (err) => {
      videoJobs--;
      if (err) return res.status(502).json({ error: "MP3 download failed: " + e.message });
      const file = path.join(DL, `yt-${id}.mp3`);
      if (!fs.existsSync(file)) return res.status(404).json({ error: "no file produced" });
      res.download(file, `youtube-${id}.mp3`, () => fs.unlink(file, () => {}));
    });
  }
});

const PORT = parseInt(process.env.PORT || "4310", 10);
app.listen(PORT, () => console.log(`twitter-dl on http://localhost:${PORT}`));

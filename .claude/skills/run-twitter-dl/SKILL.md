---
name: run-twitter-dl
description: Run, launch, build, test, or screenshot the twitter-dl tweet-downloader web app. Use when asked to start twitter-dl, drive its UI, verify a change to the paste-link → fetch flow, or capture a screenshot of the downloader page.
---

# Run twitter-dl

A single-file Express web app (`server.js`, port 4310) that takes an X/Twitter
link and returns the tweet's full text, images, video, and metadata via X's
public syndication endpoint + yt-dlp. Paths below are relative to the app root
(`~/twitter-dl`).

It's driven headless by **`.claude/skills/run-twitter-dl/driver.mjs`**, which
boots the server, opens the page in bundled Chromium (Puppeteer — no system
browser, no sudo), runs the real paste-link → fetch flow against a live tweet,
and writes screenshots. That driver is the primary agent path.

## Prerequisites

No apt packages and no sudo needed. Just Node deps (Express for the app,
Puppeteer for the driver — Puppeteer downloads its own Chromium on install):

```bash
cd ~/twitter-dl && npm install
```

## Run (agent path) — driver

```bash
cd ~/twitter-dl
fuser -k 4310/tcp 2>/dev/null   # free the port if a stray server is on it
node .claude/skills/run-twitter-dl/driver.mjs
```

Exit 0 means the homepage rendered AND a real tweet's text was fetched into the
DOM. It prints the fetched text + the download buttons and writes two
screenshots:

- `downloads/shot-home.png` — the empty homepage
- `downloads/shot-result.png` — a fetched tweet card (verify this isn't blank)

Options: `node .claude/skills/run-twitter-dl/driver.mjs <tweetUrlOrId>` to test a
specific tweet; `HEADFUL=1` to watch; `KEEP=1` to leave the server running.

## Run (human path)

```bash
cd ~/twitter-dl && node server.js      # → twitter-dl on http://localhost:4310
```

Open `http://localhost:4310`, paste a tweet link, click **Get**. Useless purely
headless (no browser to view it) — that's what the driver is for.

## Test the CLI (no browser)

The same extraction is also a CLI (`~/bin/twdl`), handy as a fast smoke check:

```bash
~/bin/twdl https://x.com/i/status/2073791465713480109        # markdown
~/bin/twdl https://x.com/i/status/2073791465713480109 --html # writes downloads/tweet-*.html
```

## Gotchas

- **No `chromium-cli` / no system Chromium / no sudo on this box.** The driver
  uses Puppeteer's bundled Chromium (`~/.cache/puppeteer/chrome/...`), launched
  with `--no-sandbox --disable-gpu --disable-dev-shm-usage` (required in this
  container or Chromium won't start).
- **Port 4310 collision.** If a server is already listening, the driver's own
  `node server.js` prints `EADDRINUSE` but the run still "passes" against the
  stale server — misleading. Always `fuser -k 4310/tcp` first for a clean run.
- **Comments/replies are never fetched without login.** X gates replies behind
  an account; the app/driver only get text+images+video+info. A cookie file at
  `~/.config/twdl/cookies.txt` (Netscape format) is required for replies/video-
  behind-login. Expected and surfaced in the UI — not a bug.
- **Needs outbound internet** to `cdn.syndication.twimg.com` (tweet data) and
  `pbs.twimg.com` (images). Available in this container.

## Troubleshooting

- `server never came up at http://localhost:4310` → `npm install` wasn't run, or
  the port is held by a dead process: `fuser -k 4310/tcp` and retry.
- Driver fails at `waitForSelector("#card")` with empty text → the tweet is
  private/deleted or X changed the syndication shape; try another tweet id.
- `Could not find Chromium` → the Puppeteer install step was skipped; run
  `npm install` (its postinstall fetches Chromium).

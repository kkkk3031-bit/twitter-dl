#!/usr/bin/env node
// Driver for the twitter-dl web app. Boots the server, drives the real UI with
// Puppeteer (bundled Chromium — no system browser / no sudo needed), exercises
// the paste-link → fetch → result flow against a live tweet, and screenshots.
//
// Usage:
//   node .claude/skills/run-twitter-dl/driver.mjs [tweetUrlOrId]
// Env:
//   PORT (default 4310), HEADFUL=1 to watch, KEEP=1 to leave server running.
//
// Exit 0 = homepage rendered AND a real tweet's text was fetched into the DOM.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const APP_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../..");
const PORT = process.env.PORT || "4310";
const BASE = `http://localhost:${PORT}`;
const TWEET = process.argv[2] || "https://x.com/i/status/2073791465713480109";
const SHOTS = path.join(APP_DIR, "downloads");

function log(...a) { console.log("[driver]", ...a); }

async function waitFor(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return true; } catch {}
    await sleep(400);
  }
  throw new Error(`server never came up at ${url}`);
}

const server = spawn("node", ["server.js"], {
  cwd: APP_DIR,
  env: { ...process.env, PORT },
  stdio: ["ignore", "inherit", "inherit"],
});
let browser;
const stop = () => { try { browser?.close(); } catch {} if (!process.env.KEEP) server.kill("SIGTERM"); };
process.on("exit", stop);

try {
  await waitFor(`${BASE}/`);
  log("server up on", BASE);
  browser = await puppeteer.launch({
    headless: !process.env.HEADFUL,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 480, height: 900 });

  await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
  await page.screenshot({ path: path.join(SHOTS, "shot-home.png") });
  log("homepage screenshot → downloads/shot-home.png");

  // Drive the real flow: type a tweet link, click Get, wait for the card.
  await page.type("#url", TWEET);
  await page.click("#go");
  await page.waitForSelector("#card", { visible: true, timeout: 25000 });
  await page.waitForFunction(
    () => document.querySelector("#text")?.textContent?.trim().length > 0,
    { timeout: 25000 },
  );
  const text = await page.$eval("#text", (el) => el.textContent.trim());
  const btns = await page.$$eval("#btns a, #btns button", (els) => els.map((e) => e.textContent));
  await page.screenshot({ path: path.join(SHOTS, "shot-result.png") });
  log("result screenshot → downloads/shot-result.png");
  log("fetched tweet text:", JSON.stringify(text.slice(0, 80)));
  log("download buttons:", btns.join(" | "));

  if (!text) throw new Error("no tweet text rendered — fetch failed");
  log("PASS ✓ homepage + live fetch both work");
  process.exit(0);
} catch (err) {
  console.error("[driver] FAIL:", err.message);
  process.exit(1);
}

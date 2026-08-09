const puppeteer = require("puppeteer");
(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--mute-audio", "--no-first-run"],
  });
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
  await page.setRequestInterception(true);
  let direct = null;
  page.on("request", (r) => {
    const u = r.url();
    if (/download\?sig|m=d|api\/v1\/download/.test(u)) {
      direct = u;
      console.log("CAPTURED:", u.slice(0, 160));
      try { r.abort(); } catch { r.continue(); }
      return;
    }
    if (r.isInterceptResolutionHandled()) return;
    /image|font|media/.test(r.resourceType()) ? r.abort() : r.continue();
  });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 200)));
  await page.goto("https://y2mate.gs/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.evaluate(() => { window.open = () => null; });
  await page.type("#video", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", { delay: 15 });
  await page.$$eval(".form__formats button", (btns) => {
    const mp4 = btns.find((b) => (b.textContent || "").trim().toLowerCase() === "mp4");
    if (mp4) mp4.click();
  });
  await page.click('.form__actions button[type="submit"]');
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline && !direct) {
    const armed = await page.evaluate(() => {
      const btn = document.querySelector(".form__actions--download button.download");
      return !!btn && !btn.disabled;
    }).catch(() => false);
    if (armed && !direct) {
      console.log("ARMED — clicking Download");
      try { await page.click(".form__actions--download button.download"); } catch (e) { console.log("click err", e.message.slice(0, 80)); }
      await new Promise(r => setTimeout(r, 2500));
    } else if (!armed) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  if (!direct) { console.log("NO DIRECT CAPTURED"); await browser.close(); process.exit(0); }
  const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
  const probe = await fetch(direct, {
    headers: { "User-Agent": UA, Referer: "https://y2mate.gs/", Origin: "https://y2mate.gs", Range: "bytes=0-1024" },
    signal: AbortSignal.timeout(20000), redirect: "follow",
  });
  console.log("probe status:", probe.status, "ct:", probe.headers.get("content-type"));
  const body = await probe.arrayBuffer();
  console.log("probe bytes:", body.byteLength, "head:", Buffer.from(body.slice(0, 60)).toString("latin1").replace(/\s+/g, " "));
  await browser.close();
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
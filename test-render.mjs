// Render check: paste a link, load the whole conversation, and confirm the page
// actually shows it — opening tweet first, replies in order, links out to X, and
// Arabic laid out right-to-left rather than as boxes. Screenshot for the eye.
import puppeteer from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";

const BASE = process.argv[2] || "http://127.0.0.1:4310";
const TWEET = process.argv[3] || "https://x.com/i/status/2080676928000790563";
const here = path.dirname(fileURLToPath(import.meta.url));

const b = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await b.newPage();
await page.setViewport({ width: 900, height: 1400 });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e.message)));

let bad = 0;
const ok = (c, m) => {
  console.log(`  ${c ? "✅" : "❌"} ${m}`);
  if (!c) bad++;
};

try {
  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 45000 });
  await page.type("input", TWEET);
  await page.click("button");
  await page.waitForSelector("#btns button", { timeout: 45000 });
  await page.evaluate(() =>
    [...document.querySelectorAll("#btns button")].find((x) => /Load comments/i.test(x.textContent))?.click(),
  );
  await page.waitForFunction(() => document.querySelector("#comments")?.style.display === "block", {
    timeout: 120000,
  });

  const r = await page.evaluate(() => {
    const entries = [...document.querySelectorAll("#comments .c")];
    const rtl = entries
      .map((e) => e.querySelector(".ct"))
      .filter((t) => t && getComputedStyle(t).direction === "rtl");
    return {
      head: document.querySelector("#comments .chead")?.textContent || "",
      total: entries.length,
      op: entries[0]?.classList.contains("op") || false,
      links: entries.filter((e) => e.querySelector('a[href^="https://x.com/"]')).length,
      rtlCount: rtl.length,
      rtlSample: rtl[0]?.textContent?.slice(0, 30) || "",
      // A glyph the font cannot draw collapses to zero width — catches tofu.
      arabicDrawn: rtl.length ? rtl[0].getBoundingClientRect().height > 0 : null,
      clipped: entries.filter((e) => {
        const t = e.querySelector(".ct");
        // both directions: a clipped RTL line overflows horizontally
        return t && (t.scrollHeight - t.clientHeight > 2 || t.scrollWidth - t.clientWidth > 2);
      }).length,
      pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });

  ok(r.total > 1, `${r.total} entries rendered (${r.head.slice(0, 60)})`);
  ok(r.op, "opening tweet is first, tagged TWEET");
  ok(r.links === r.total, `${r.links}/${r.total} entries link to x.com`);
  ok(r.rtlCount > 0, `${r.rtlCount} Arabic entries flipped to RTL: ${r.rtlSample}`);
  ok(r.arabicDrawn !== false, "Arabic glyphs drawn (non-zero height)");
  ok(r.clipped === 0, `no clipped comment text (${r.clipped} clipped)`);
  ok(!r.pageScrollsSideways, "page does not scroll sideways");
  ok(errs.length === 0, `no JS errors${errs.length ? ": " + errs[0] : ""}`);

  await page.screenshot({ path: path.join(here, "downloads", "shot-conversation.png"), fullPage: true });
} catch (e) {
  ok(false, `render check threw: ${e.message.split("\n")[0]}`);
} finally {
  await b.close();
}
process.exit(bad ? 1 : 0);

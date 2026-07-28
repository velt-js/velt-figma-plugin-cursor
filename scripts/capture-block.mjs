#!/usr/bin/env node
// capture-block.mjs — REFERENCE capture adapter: a device-resolution PNG element screenshot of one
// block's live state, for visual-diff. This is the capture path the redesign requires — the Chrome
// MCP `computer` screenshot returns a ~1x lossy JPEG (too noisy for pixel work); a DPR-2 element
// screenshot aligns 1:1 with the @2x Figma frame (frame-width × 2). See BLOCK-BY-BLOCK-REDESIGN-PLAN.md §0b.
//
// Capture is the one step that can't be pure-node (it drives a browser). This adapter uses
// playwright-core via DYNAMIC import so the repo's scripts stay dependency-free at the validate gate;
// the Judge can equally feed visual-diff a PNG from any device-res source (CDP, etc.).
//
// Usage:
//   node scripts/capture-block.mjs <url> <liveSelector> <outPng> [--scale 2] [--select-user user1]
//        [--assert <selector>] [--eval '<page JS to reach the block state>'] [--timeout 30000]
//        [--toggle <selector>]   # optional: element to click after user-select to open the surface
//        [--connect <wsEndpoint>]# reuse an existing Chromium (browser reuse across a block's iterations)
//
// The EXPENSIVE step (browser + DPR-2 screenshot) — call it only at iteration 1 + PASS-candidate, not
// every iteration; the cheap per-iteration checks (delta-compare + probes) run in the Judge's own live
// session. --connect reuses one browser across a block's captures instead of relaunching each time.
//
// playwright-core resolution: $PLAYWRIGHT_CORE, else a normal import, else a clear install hint.

import path from "node:path";
import { pathToFileURL } from "node:url";

async function loadChromium() {
  const candidates = [process.env.PLAYWRIGHT_CORE, "playwright-core",
    path.join(process.env.HOME || "", ".claude/skills/gstack/node_modules/playwright-core/index.js")].filter(Boolean);
  for (const c of candidates) {
    try { const m = await import(c); return (m.default || m).chromium; } catch { /* try next */ }
  }
  throw new Error("playwright-core not found — `npm i -D playwright-core` (or set $PLAYWRIGHT_CORE), or feed visual-diff a device-res PNG from your own capture (CDP element screenshot at DPR 2).");
}

// Acquire a browser: launch a fresh headless one, or REUSE an existing browser via --connect. A real
// Chrome (what the Judge drives) exposes a CDP endpoint (http://host:port or ws …/devtools/browser/…);
// a Playwright `launchServer` exposes a plain ws endpoint. Try the likely form first, then the other.
async function acquireBrowser(chromium, connectWs, { requireConnect = false } = {}) {
  if (!connectWs) {
    // Fail loud, never a silent blank headless capture (it can't open the Velt sidebar → captures an
    // empty surface → false-pass). Bare headless is for golden/offline calibration only.
    if (requireConnect) {
      console.error("✗ --require-connect set but no --connect <ws> given — refusing to capture in a blank headless browser.\n  Resolve a real browser via scripts/browser-endpoint.mjs, then pass --connect <ws>.");
      process.exit(3);
    }
    return chromium.launch({ headless: true });
  }
  const looksCdp = /^https?:|\/devtools\//.test(connectWs);
  const cdp = () => chromium.connectOverCDP(connectWs);
  const pw = () => chromium.connect({ wsEndpoint: connectWs });
  try { return await (looksCdp ? cdp() : pw()); }
  catch (e1) {
    try { return await (looksCdp ? pw() : cdp()); }
    catch (e2) { throw new Error(`--connect: could not attach to '${connectWs}' as CDP or a Playwright server endpoint (${e1.message})`); }
  }
}

async function main() {
  const [url, liveSelector, outPng, ...rest] = process.argv.slice(2);
  if (!url || !liveSelector || !outPng) { console.error("usage: capture-block.mjs <url> <liveSelector> <outPng> [--scale 2] [--select-user user1] [--assert sel] [--eval 'js'] [--toggle sel] [--connect ws] [--timeout 30000]"); process.exit(1); }
  const argv = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  const scale = +argv("--scale", "2"), timeout = +argv("--timeout", "30000");
  const selectUser = argv("--select-user", null), assertSel = argv("--assert", null), driveJs = argv("--eval", null);
  const toggleSel = argv("--toggle", null), connectWs = argv("--connect", null);
  const requireConnect = rest.includes("--require-connect");

  const chromium = await loadChromium();
  const browser = await acquireBrowser(chromium, connectWs, { requireConnect });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1512, height: 900 }, deviceScaleFactor: scale });
    const page = await ctx.newPage();
    // domcontentloaded (not networkidle): a realtime Velt app holds long-poll/SSE connections that may
    // never go idle; the explicit waitForSelector(liveSelector) below is the real readiness gate.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });

    // optional: pick a user in a test harness (a <select> of users — NOT a credential login).
    // HYDRATION-SAFE (BUG-2): wait for the select to be hydrated (present, enabled, app alive),
    // set + dispatch, VERIFY the value stuck, retry up to 3x — the old fire-right-after-DCL version
    // raced hydration and the selection sometimes silently didn't stick.
    if (selectUser) {
      await page.waitForFunction(() => {
        const sel = document.querySelector("select");
        const alive = !!window.Velt || [...document.querySelectorAll("*")].some((el) => el.tagName.toLowerCase().startsWith("velt-"));
        return !!sel && !sel.disabled && alive;
      }, { timeout });
      let stuck = false;
      for (let attempt = 1; attempt <= 3 && !stuck; attempt++) {
        await page.evaluate((u) => {
          const sel = document.querySelector("select");
          Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(sel, u);
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }, selectUser);
        stuck = await page.waitForFunction((u) => document.querySelector("select")?.value === u, selectUser, { timeout: 5000 }).then(() => true, () => false);
        if (!stuck) await page.waitForTimeout(500 * attempt);
      }
      if (!stuck) throw new Error(`selectUser '${selectUser}' did not stick after 3 attempts (hydration race) — treat as BLOCKED (env)`);
      await page.waitForTimeout(600);
      if (toggleSel) { await page.evaluate(async (t) => { document.querySelector(t)?.click(); await new Promise((r) => setTimeout(r, 1200)); }, toggleSel); }
    }

    // wait for the block's surface
    await page.waitForSelector(liveSelector, { timeout });

    // RESET state before driving this block — so a prior block's open menu / typed composer / hover
    // doesn't leak into this capture (§0d fix #b). Surface-agnostic: Escape closes menus; clear ANY
    // focused/visible contenteditable (not a design-specific selector); blur; dismiss overlays.
    await page.keyboard.press("Escape").catch(() => {});
    await page.evaluate(() => {
      for (const ed of document.querySelectorAll("[contenteditable]:not([contenteditable='false'])")) {
        if ((ed.textContent ?? "").length) { ed.focus(); document.execCommand("selectAll", false); document.execCommand("delete", false); }
      }
      document.activeElement?.blur?.();
      document.body?.click?.();   // dismiss any open overlay/menu
    }).catch(() => {});
    await page.waitForTimeout(400);

    // run the per-block drive (hover/click/type/seed), then assert
    if (driveJs) await page.evaluate(`(async()=>{ ${driveJs} })()`);
    if (assertSel) await page.waitForSelector(assertSel, { timeout: 8000 }).catch(() => { throw new Error(`state assert failed: ${assertSel} never appeared — the drive did not reach the block's state`); });
    await page.waitForTimeout(500);

    const el = page.locator(liveSelector).first();
    const box = await el.boundingBox();
    await el.screenshot({ path: outPng });
    console.log(JSON.stringify({ ok: true, outPng, deviceScaleFactor: scale, cssBox: box, note: "device-res element PNG ready for visual-diff" }));
  } finally {
    if (connectWs) await browser.close().catch(() => {});   // closes the connection, not the shared browser
    else await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

#!/usr/bin/env node
// verify-app.mjs — APP-IDENTITY check (B3). Both runs measured the WRONG app: preflight verified
// that *something* answered on :3000, not that it was THIS project's app — harvey judged the
// privado project for ~35 min before the Judge caught it. This script verifies, mechanically:
//   1. the URL answers (HTTP-level);
//   2. the page is a VELT app (a `velt-*` element or window.Velt appears within the timeout);
//   3. (optional) the page matches THIS repo — --expect <substring> against title+body, and/or
//      --marker <selector> that must exist.
// Run it at preflight when pinning `appUrl`, and again before every judge/measure session — a URL
// that stops matching mid-run is BLOCKED (env), never a FAIL against the build.
//
// Usage:
//   node scripts/verify-app.mjs <url> [--expect "<substring>"] [--marker "<selector>"]
//        [--timeout 20000] [--connect <wsEndpoint>] [--quiet]
// Exit codes: 0 = verified · 2 = reachable but NOT this app / Velt absent · 3 = unreachable · 1 = usage.
// Prints a JSON identity line either way (title, url, veltPresent, matched) for the journal.

import path from "node:path";
import { pathToFileURL } from "node:url";

async function loadChromium() {
  const candidates = [process.env.PLAYWRIGHT_CORE, "playwright-core",
    path.join(process.env.HOME || "", ".claude/skills/gstack/node_modules/playwright-core/index.js")].filter(Boolean);
  for (const c of candidates) {
    try { const m = await import(c); return (m.default || m).chromium; } catch { /* try next */ }
  }
  throw new Error("playwright-core not found — `npm i -D playwright-core` or set $PLAYWRIGHT_CORE");
}
async function acquireBrowser(chromium, connectWs) {
  if (!connectWs) return chromium.launch({ headless: true });
  const looksCdp = /^https?:|\/devtools\//.test(connectWs);
  try { return await (looksCdp ? chromium.connectOverCDP(connectWs) : chromium.connect({ wsEndpoint: connectWs })); }
  catch { return await (looksCdp ? chromium.connect({ wsEndpoint: connectWs }) : chromium.connectOverCDP(connectWs)); }
}

async function main() {
  const [url, ...rest] = process.argv.slice(2);
  if (!url) { console.error('usage: verify-app.mjs <url> [--expect "<substring>"] [--marker "<selector>"] [--timeout 20000] [--connect ws] [--quiet]'); process.exit(1); }
  const argv = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  const expect = argv("--expect", null), marker = argv("--marker", null);
  const timeout = +argv("--timeout", "20000"), connectWs = argv("--connect", null), quiet = rest.includes("--quiet");

  // HTTP-level reachability first (fast, no browser) — a connection refusal is exit 3, clearly env.
  try { await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(Math.min(timeout, 8000)) }); }
  catch (e) {
    console.log(JSON.stringify({ ok: false, url, reachable: false, why: `unreachable: ${e.cause?.code || e.message}` }));
    process.exit(3);
  }

  const chromium = await loadChromium();
  const browser = await acquireBrowser(chromium, connectWs);
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    // Velt presence: any custom element whose tag starts with velt-, or the client global.
    const veltPresent = await page.waitForFunction(
      () => !!document.querySelector("*") && ([...document.querySelectorAll("*")].some((el) => el.tagName.toLowerCase().startsWith("velt-")) || !!window.Velt),
      { timeout }
    ).then(() => true, () => false);
    const title = await page.title();
    const bodyText = (await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || "")).toLowerCase();
    const expectOk = !expect || title.toLowerCase().includes(expect.toLowerCase()) || bodyText.includes(expect.toLowerCase());
    const markerOk = !marker || !!(await page.$(marker));
    const ok = veltPresent && expectOk && markerOk;
    const why = ok ? null
      : !veltPresent ? "no velt-* element / window.Velt appeared — Velt is not rendering here"
      : !expectOk ? `--expect '${expect}' not found in title/body — a DIFFERENT app is answering on this URL (port squatter?)`
      : `--marker '${marker}' not found in the DOM`;
    console.log(JSON.stringify({ ok, url, reachable: true, title, veltPresent, expectOk, markerOk, why }));
    if (!ok && !quiet) console.error(`✗ ${why}\n  Fix: confirm the dev server for THIS repo (read its startup output for the real port — ports auto-bump), re-pin appUrl, re-run.`);
    process.exit(ok ? 0 : 2);
  } finally {
    if (connectWs) await browser.close().catch(() => {});
    else await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

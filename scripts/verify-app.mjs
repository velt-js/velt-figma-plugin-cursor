#!/usr/bin/env node
// verify-app.mjs — APP-IDENTITY check (B3). Both runs measured the WRONG app: preflight verified
// that *something* answered on :3000, not that it was THIS project's app — harvey judged the
// privado project for ~35 min before the Judge caught it. This script verifies, mechanically:
//   1. the URL answers (HTTP-level);
//   2. Velt actually BOOTED — window.Velt or a velt-* custom element DEFINED in the registry
//      (a velt-* tag merely present in the DOM is NOT boot evidence: React renders the JSX tags
//      even when the SDK script never loads — a cloud run's preflight false-positived on this);
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
    // Velt BOOT evidence, not mere presence. A cloud run's preflight passed on `veltPresent:true`
    // while Velt had never booted: React renders <velt-*> JSX tags into the DOM even when the SDK
    // script never loads (backend down / CDN TLS blocked in the BROWSER), so "a velt-* tag exists"
    // is a false positive. Booted means the custom elements are DEFINED (the SDK's JS actually ran)
    // or window.Velt exists — waited for, then broken down for the diagnosis.
    await page.waitForFunction(
      () => !!window.Velt || [...document.querySelectorAll("*")].some((el) => { const t = el.tagName.toLowerCase(); return t.startsWith("velt-") && !!customElements.get(t); }),
      { timeout }
    ).catch(() => {});
    const velt = await page.evaluate(() => {
      const tags = [...new Set([...document.querySelectorAll("*")].map((el) => el.tagName.toLowerCase()).filter((t) => t.startsWith("velt-")))];
      const defined = tags.filter((t) => !!customElements.get(t));
      const rendered = defined.filter((t) => [...document.querySelectorAll(t)].some((el) => (el.shadowRoot && el.shadowRoot.childElementCount) || el.childElementCount));
      return { tags, defined, rendered, global: !!window.Velt };
    });
    const veltPresent = velt.tags.length > 0 || velt.global;
    const veltBooted = velt.global || velt.defined.length > 0;
    const title = await page.title();
    const bodyText = (await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || "")).toLowerCase();
    const expectOk = !expect || title.toLowerCase().includes(expect.toLowerCase()) || bodyText.includes(expect.toLowerCase());
    const markerOk = !marker || !!(await page.$(marker));
    const ok = veltBooted && expectOk && markerOk;
    const why = ok ? null
      : !veltPresent ? "no velt-* element / window.Velt appeared — Velt is not rendering here"
      : !veltBooted ? `velt-* tags exist (${velt.tags.slice(0, 3).join(", ")}) but the SDK never DEFINED them — PRESENT BUT NOT BOOTED: Velt's script never loaded/initialized. Check the Velt backend is running and that the BROWSER can reach cdn.velt.dev (an egress proxy can break Chromium's TLS while curl succeeds — see guide/debugging.md)`
      : !expectOk ? `--expect '${expect}' not found in title/body — a DIFFERENT app is answering on this URL (port squatter?)`
      : `--marker '${marker}' not found in the DOM`;
    console.log(JSON.stringify({ ok, url, reachable: true, title, veltPresent, veltBooted, veltTags: velt.tags.length, veltDefined: velt.defined.length, veltRendered: velt.rendered.length, expectOk, markerOk, why }));
    if (!ok && !quiet) console.error(`✗ ${why}\n  Fix: confirm the dev server for THIS repo (read its startup output for the real port — ports auto-bump), re-pin appUrl, re-run.`);
    process.exit(ok ? 0 : 2);
  } finally {
    if (connectWs) await browser.close().catch(() => {});
    else await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

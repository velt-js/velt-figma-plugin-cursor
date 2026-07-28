#!/usr/bin/env node
// run-tab.mjs — lifecycle of the ONE measurement tab per run. Pipeline scripts (measure-block,
// dom-snapshot, smoke) find-or-create a single named tab (window.name, survives navigation) in the
// connected real browser and REUSE it across invocations — instead of spawning a tab + full page
// load per call (resource-heavy, and fresh navigations were the dev-server wedge trigger).
//
//   node scripts/run-tab.mjs open   --connect <ws> --url <appUrl>   # pre-warm the tab (preflight)
//   node scripts/run-tab.mjs status --connect <ws>                  # is the run tab open? where?
//   node scripts/run-tab.mjs close  --connect <ws>                  # close it (run wrap-up)
//
// VELT_SINGLE_TAB=0 disables the reuse behavior in the pipeline scripts entirely.

import { pathToFileURL } from "node:url";
import { loadChromium, acquireBrowser, openPage, findRunTab, RUN_TAB_NAME } from "./measure-block.mjs";

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  const connect = flag("--connect", null);
  if (!cmd || !connect) { console.error("usage: run-tab.mjs open|status|close --connect <ws> [--url <appUrl>]"); process.exit(1); }
  const chromium = await loadChromium();
  const browser = await acquireBrowser(chromium, connect, { requireConnect: true });
  try {
    const ctx = browser.contexts()[0];
    if (!ctx) { console.error("✗ no browser context — is the real browser running?"); process.exit(2); }
    const tab = await findRunTab(ctx, { originHint: flag("--url", null) });
    if (cmd === "status") {
      console.log(tab ? `✓ run tab open (${RUN_TAB_NAME}) at ${tab.url()}` : "· no run tab (the first pipeline call creates it)");
    } else if (cmd === "close") {
      if (tab) { await tab.close(); console.log("✓ run tab closed"); }
      else console.log("· no run tab to close");
    } else if (cmd === "open") {
      const url = flag("--url", null);
      if (!url) { console.error("✗ open requires --url <appUrl>"); process.exit(1); }
      if (tab) { console.log(`✓ run tab already open at ${tab.url()} — reusing`); }
      else {
        await openPage(browser, url, { reuseContext: true });   // creates + names the tab, leaves it open
        console.log(`✓ run tab opened at ${url} — every pipeline call now reuses it (one tab for the whole run)`);
      }
    } else { console.error(`✗ unknown command '${cmd}'`); process.exit(1); }
  } finally { await browser.close().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

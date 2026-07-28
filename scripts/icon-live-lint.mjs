#!/usr/bin/env node
// icon-live-lint.mjs — Live DOM icon identity pass (complements static icon-lint.mjs).
//
// Compares mounted SVG path `d` attributes inside the surface against exported assets.
// Catches: wrong glyph in slot, CSS masking a path into a filled circle, missing mount.
//
// Usage: node scripts/icon-live-lint.mjs <phaseDir> --url <url> --connect <ws> --surface <sel> --assets <dir>
// Exit 0 = ok / no icons; 2 = path mismatch or zero mounted paths when assets exist

import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

function normPath(d) {
  return String(d || "").replace(/\s+/g, " ").trim().toLowerCase();
}

async function collectAssetPaths(assetsDir) {
  const out = new Set();
  const files = await fs.readdir(assetsDir).catch(() => []);
  for (const f of files) {
    if (!f.endsWith(".svg")) continue;
    const text = await fs.readFile(path.join(assetsDir, f), "utf8");
    for (const m of text.matchAll(/\bd="([^"]+)"/g)) out.add(normPath(m[1]));
  }
  return out;
}

const LIVE_PROBE = `(function(sel){
  var root=document.querySelector(sel)||document.body;
  var paths=[];
  var svgs=root.querySelectorAll('svg');
  for(var i=0;i<svgs.length;i++){
    var r=svgs[i].getBoundingClientRect();
    if(r.width<2||r.height<2)continue;
    var ps=svgs[i].querySelectorAll('path[d]');
    for(var j=0;j<ps.length;j++)paths.push({d:ps[j].getAttribute('d')||'',w:Math.round(r.width),h:Math.round(r.height)});
  }
  return {mounted:paths.length, paths:paths};
})`;

async function main() {
  const args = process.argv.slice(2);
  const phaseDir = args[0];
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const url = flag("--url"), ws = flag("--connect"), surface = flag("--surface") || "body";
  const assets = flag("--assets") || (phaseDir ? path.join(phaseDir, "assets") : null);
  if (!phaseDir || !url || !ws || !assets) {
    console.error("usage: icon-live-lint.mjs <phaseDir> --url <url> --connect <ws> [--surface sel] [--assets dir]");
    process.exit(1);
  }
  const designPaths = await collectAssetPaths(assets);
  let chromium;
  try { chromium = require("playwright-core").chromium; }
  catch { console.error("✗ playwright-core required"); process.exit(1); }
  const browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();
  if (!String(page.url()).includes(new URL(url).hostname)) await page.goto(url, { waitUntil: "domcontentloaded" });
  const live = await page.evaluate(new Function("sel", `return (${LIVE_PROBE})(sel);`), surface);
  const problems = [];
  if (designPaths.size && live.mounted === 0) {
    problems.push({ kind: "no-mounted-icons", note: "assets exist but no visible SVG paths in surface" });
  }
  let matched = 0, unknown = 0;
  for (const p of live.paths || []) {
    const n = normPath(p.d);
    if (!n) continue;
    if (designPaths.has(n)) matched++;
    else { unknown++; problems.push({ kind: "unknown-live-path", d: n.slice(0, 80), box: `${p.w}x${p.h}` }); }
  }
  const report = { matched, unknown, mounted: live.mounted, assetPaths: designPaths.size, problems: problems.slice(0, 20), at: new Date().toISOString() };
  await fs.writeFile(path.join(phaseDir, "icon-live-lint.json"), JSON.stringify(report, null, 2) + "\n");
  // Unknown paths are warnings unless NONE matched when assets+mounts exist
  const fail = (designPaths.size && live.mounted && matched === 0) || problems.some((p) => p.kind === "no-mounted-icons");
  console.log(fail ? `✗ icon-live-lint: matched=${matched} unknown=${unknown} mounted=${live.mounted}` : `✓ icon-live-lint: matched=${matched} unknown=${unknown} mounted=${live.mounted}`);
  process.exit(fail ? 2 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });

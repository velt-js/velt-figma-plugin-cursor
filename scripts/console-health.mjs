#!/usr/bin/env node
// console-health.mjs — the POST-STRUCTURE console-storm gate (runs right after build-structure,
// alongside skeleton-check). The Harvey wireframe run (2026-07-28, cursor cloud): a Composer.ActionButton
// missing its required `type` prop threw Angular NG0950 on EVERY render tick — ~260 errors/sec for
// ~2 hours, a 1.2 GB dev log, disrupted cold renders and noisy measurements — and nothing looked at
// the console until the whole-design Judge (hour 3). This gate closes that window: a ~5-second
// sampled console read on the pinned appUrl, seconds after the skeleton first renders.
//
// A STORM (any repeating error signature, or a large error total, within the sample) exits 2 and
// names the signatures — the orchestrator dispatches the Builder (fix, structure scope) on exactly
// those before the style planner runs. One-off noise does not trip it: repetition is the signal.
//
// Usage:
//   node scripts/console-health.mjs <phaseDir> --url <appUrl> --connect <browserWs>
//        [--sample-ms 5000] [--per-sig 10] [--total 50] [--allow <substring-or-regex>]...
//
// exit 0 = healthy · 2 = storm (console-health.json names each signature) · 3 = usage/env error.
// --allow is for ORIGIN-ATTRIBUTABLE infra noise only (e.g. a Firestore 400 already allow-listed
// in the smoke config) — never for a velt/SDK error.

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadChromium, acquireBrowser, openPage } from "./measure-block.mjs";
import { obsEvent } from "./obs.mjs";   // session-replay record (fail-safe, VELT_OBS=0 disables)

// Collapse a raw console line to a stable signature: volatile numbers/hashes/urls out, shape kept —
// so "NG0950 ... at tick 41821" and "... at tick 41822" count as ONE repeating signature.
export function signatureOf(text) {
  return text
    .replace(/\[[^\]]*https?:[^\]]*\]$/, "")   // the [source-url] suffix openPage appends
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b\d+\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function assess(errors, { perSig = 10, total = 50, allow = [] } = {}) {
  const allowed = (t) => allow.some((p) => { try { return new RegExp(p).test(t); } catch { return t.includes(p); } });
  const counts = new Map();
  let kept = 0;
  for (const e of errors) {
    if (allowed(e)) continue;
    kept++;
    const sig = signatureOf(e);
    const cur = counts.get(sig) || { sig, count: 0, sample: e.slice(0, 300) };
    cur.count++;
    counts.set(sig, cur);
  }
  const signatures = [...counts.values()].sort((a, b) => b.count - a.count);
  const storms = signatures.filter((s) => s.count >= perSig);
  const storm = storms.length > 0 || kept >= total;
  return { storm, totalErrors: kept, storms, signatures: signatures.slice(0, 20) };
}

async function main() {
  const a = process.argv.slice(2);
  const phaseDir = a[0] && !a[0].startsWith("--") ? path.resolve(a[0]) : null;
  const flag = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const allow = a.flatMap((x, i) => (x === "--allow" && a[i + 1] ? [a[i + 1]] : []));
  const url = flag("--url");
  const connect = flag("--connect");
  const sampleMs = +flag("--sample-ms", "5000");
  const perSig = +flag("--per-sig", "10");
  const total = +flag("--total", "50");
  if (!phaseDir || !url) { console.error("usage: console-health.mjs <phaseDir> --url <appUrl> --connect <browserWs> [--sample-ms 5000] [--per-sig 10] [--total 50] [--allow <pat>]..."); process.exit(3); }

  const chromium = await loadChromium();
  // Same fail-loud contract as every live measurement: a real, authed browser or nothing.
  const browser = await acquireBrowser(chromium, connect, { requireConnect: true });
  let result;
  let page = null, persistentTab = false;
  try {
    ({ page, persistentTab } = await openPage(browser, url, { reuseContext: true }));
    // openPage's console listener has been collecting since navigation — cold-render errors count.
    const collected = [];
    page.on("console", (m) => { if (m.type() === "error") collected.push(m.text().slice(0, 300)); });
    page.on("pageerror", (e) => collected.push(String(e).slice(0, 300)));
    const before = collected.length;
    await page.waitForTimeout(sampleMs);
    // Storm math uses the steady-state sample window; the cold-render batch feeds `total`.
    result = assess(collected, { perSig, total, allow });
    result.sampleWindow = { ms: sampleMs, errorsInWindow: collected.length - before, errorsSinceLoad: collected.length };
  } finally {
    if (page && !persistentTab) await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const outP = path.join(phaseDir, "console-health.json");
  await fs.writeFile(outP, JSON.stringify({ url, sampledAt: new Date().toISOString(), ...result }, null, 2));
  obsEvent(phaseDir, {
    type: "console-health", src: "console-health", stage: "build-structure", ok: !result.storm,
    summary: result.storm
      ? `console STORM: ${result.storms.map((s) => `${s.count}× ${s.sig.slice(0, 60)}`).join(" · ") || `${result.totalErrors} errors total`}`
      : `console healthy (${result.totalErrors} error(s) in ${sampleMs}ms sample)`,
    artifacts: { report: "console-health.json" },
  });

  if (result.storm) {
    console.error(`✗ console-health STORM on ${url} (${result.totalErrors} error(s); thresholds per-sig≥${perSig} total≥${total}):`);
    for (const s of result.storms.length ? result.storms : result.signatures.slice(0, 5)) {
      console.error(`  ${String(s.count).padStart(5)}×  ${s.sig}`);
      console.error(`         e.g. ${s.sample.slice(0, 200)}`);
    }
    console.error(`  → a repeating SDK error this early is a structure defect (a missing required prop/slot),`);
    console.error(`    not judge material: dispatch the Builder (fix, structure scope) on the named signature(s),`);
    console.error(`    then re-run this gate. Full report: ${path.relative(process.cwd(), outP)}`);
    process.exit(2);
  }
  console.log(`✓ console healthy on ${url} — ${result.totalErrors} error(s) in the ${sampleMs}ms sample (report: ${path.relative(process.cwd(), outP)})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(3); });

#!/usr/bin/env node
// score-gold-issues.mjs — Score a run against learnings/gold-issues-*.json
//
// Classification helpers for canary scoring (detection lift + outcome).
// Usage:
//   node scripts/score-gold-issues.mjs <phaseDir> [--gold learnings/gold-issues-fresh-1.json]
// Prints how many gold issues have mechanical evidence in judge-defects / results.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DETECT_HINTS = {
  "sidebar-shape": [/border-radius/i, /panel/i, /sidebar/i],
  "header-typography": [/sidebar-title/i, /font-size/i, /comments/i],
  "header-filter-icon": [/filter/i, /icon/i, /width|height/i],
  "composer-height": [/composer/i, /content-height/i, /min-height|height/i],
  "composer-wrapper": [/composer/i, /double-composer|border/i],
  "composer-border-state": [/composer/i, /border/i],
  "composer-placeholder": [/placeholder/i, /text/i, /comment or tag/i],
  "composer-controls": [/send|avatar|iconbutton/i],
  "section-spacing": [/content-height/i, /gap/i],
  "card-border": [/card/i, /border|box-shadow/i],
  "thread-grouping": [/reply-outside|contract|containment|ThreadCard/i],
  "reply-alignment": [/vc-reply|reply/i],
  "reply-chevron": [/chevrongrabber|more-reply|MoreReply|hidden-count/i],
  "connector-line": [/connector/i],
  "content-alignment": [/margin-left|padding-left|28/i, /gap/i],
  "card-typography": [/font-size|font-family/i],
  "overflow-clip": [/clip|overflow|scroll/i],
  "hover-actions": [/hover|vc-actions|vc-resolve|options/i],
  "comment-gap": [/gap/i, /comment/i],
};

async function loadJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

function blobFromRun(judge, resultsSummary) {
  return JSON.stringify({ judge, resultsSummary }).toLowerCase();
}

async function main() {
  const [phaseDir, ...rest] = process.argv.slice(2);
  if (!phaseDir) { console.error("usage: score-gold-issues.mjs <phaseDir> [--gold path]"); process.exit(1); }
  const gi = rest.indexOf("--gold");
  const goldPath = gi >= 0 ? rest[gi + 1] : path.join(ROOT, "learnings/gold-issues-fresh-1.json");
  const gold = await loadJson(goldPath);
  const judge = await loadJson(path.join(phaseDir, "judge-defects.json"));
  const resultsDir = path.join(phaseDir, "results");
  const deltas = {};
  for (const b of Object.keys(judge?.blocks || {})) {
    deltas[b] = await loadJson(path.join(resultsDir, b, "delta.json"));
  }
  const blob = blobFromRun(judge, deltas);
  const rows = [];
  for (const issue of gold.issues || []) {
    const hints = DETECT_HINTS[issue.id] || [new RegExp(issue.id, "i")];
    const detected = hints.some((re) => re.test(blob));
    rows.push({
      id: issue.id,
      title: issue.title,
      baselineClass: issue.detectionClass,
      detectedInRun: detected,
      category: issue.category,
    });
  }
  const detectedN = rows.filter((r) => r.detectedInRun).length;
  const out = {
    phaseDir,
    gold: path.relative(ROOT, goldPath),
    detected: detectedN,
    total: rows.length,
    pct: Math.round(100 * detectedN / Math.max(1, rows.length)),
    rows,
  };
  await fs.writeFile(path.join(phaseDir, "gold-scorecard.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`Gold detection: ${detectedN}/${rows.length} (${out.pct}%)`);
  for (const r of rows) console.log(`  ${r.detectedInRun ? "✓" : "·"} ${r.id} [${r.baselineClass}]`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });

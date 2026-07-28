#!/usr/bin/env node
// mutation-drill.mjs — Phase 6: mutation drills as detector CI (RC6/RC2 anti-Goodhart).
//
// Injects KNOWN defects (mutations/manifest.json: css overrides after styles.css, or
// reversible DOM operations) into the live demo, runs the detector stack (compiled
// assertions + structural contract), and scores RECALL and PRECISION per category:
//   detected   = a NEW fail (absent in the control run) matching the mutation's expectDetect
//   false alarm = a NEW fail matching nothing expected
// The control run (no mutation) must add zero fails vs itself — flaky detectors block.
//
// The drill set is never published into the Judge's context; --random N extends it with
// non-memorizable perturbations drawn from the compiled suite itself.
//
// Run this on every judge-script change and before every full pipeline run. A category
// below its target (manifest.targets) exits 2.
//
// Usage:
//   node scripts/mutation-drill.mjs <phaseDir> [--connect <ws>] [--url <url>]
//        [--only <id>] [--random N] [--seed <n>] [--write]

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { evaluateStructuralContract, OBSERVE } from "./structural-contract-validate.mjs";
import { EXEC } from "./run-compiled-assertions.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadJson(p) { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; } }

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    "playwright-core",
    path.join(process.env.HOME || "", ".claude/skills/gstack/node_modules/playwright-core/index.js"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const mod = c.startsWith("/") || c.startsWith(".") ? require(c) : await import(c);
      const pw = mod.default || mod;
      if (pw.chromium) return pw.chromium;
    } catch { /* next */ }
  }
  throw new Error("playwright-core not found");
}

/** Deterministic PRNG (seeded) — drills must be reproducible per seed yet non-memorizable across seeds. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw N random mutations from the compiled suite's own decls (anti-memorization). */
export function randomMutations(suite, n, seed = 1) {
  const rnd = mulberry32(seed);
  const candidates = (suite?.assertions || []).filter((a) =>
    a.state === "default" && a.selector && (a.kind === "paint" || a.kind === "typography" || a.kind === "rect-gap" || a.kind === "rect-size"));
  const out = [];
  const used = new Set();
  let guard = 0;
  while (out.length < n && guard++ < n * 20 && candidates.length) {
    const a = candidates[Math.floor(rnd() * candidates.length)];
    if (used.has(a.id)) continue;
    used.add(a.id);
    let css = null, category = null;
    if (a.kind === "paint" && /background|color|border|box-shadow/.test(a.property)) {
      const c = `#${Math.floor(rnd() * 0xffffff).toString(16).padStart(6, "0")}`;
      const prop = a.property === "border" ? "border-color" : a.property === "box-shadow" ? "box-shadow" : a.property;
      css = `${a.selector}{${prop}:${a.property === "box-shadow" ? `0 0 0 2px ${c}` : c} !important}`;
      category = "style";
    } else if (a.kind === "typography") {
      css = a.property === "font-weight"
        ? `${a.selector}{font-weight:${+a.expected >= 500 ? 300 : 700} !important}`
        : a.property === "font-size"
          ? `${a.selector}{font-size:${(parseFloat(a.expected) || 12) + 4}px !important}`
          : null;
      category = "typography";
    } else if (a.kind === "rect-gap") {
      css = `${a.selector}{gap:${(a.expected || 8) + Math.max(6, a.tolerance * 3)}px !important}`;
      category = "layout";
    } else if (a.kind === "rect-size" && a.property !== "icon-size") {
      css = `${a.selector}{${a.dim === "w" ? "width" : "height"}:${(a.expected || 20) + 12}px !important}`;
      category = "layout";
    }
    if (!css) continue;
    out.push({ id: `R-${a.id}`, category, description: `random perturbation of ${a.id}`, apply: { css }, expectDetect: [a.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")] });
  }
  return out;
}

/** Pure scoring (golden entry point). runs = [{mutation, newFails:[ids], detected}] */
export function scoreDrill(runs, targets) {
  const byCat = {};
  for (const r of runs) {
    const cat = r.mutation.category;
    byCat[cat] = byCat[cat] || { total: 0, detected: 0, expectedHits: 0, falseAlarms: 0 };
    byCat[cat].total++;
    if (r.detected) byCat[cat].detected++;
    byCat[cat].expectedHits += r.expectedHits ?? (r.detected ? 1 : 0);
    byCat[cat].falseAlarms += r.falseAlarms ?? 0;
  }
  const scores = {};
  const regressions = [];
  for (const [cat, s] of Object.entries(byCat)) {
    const recall = s.total ? s.detected / s.total : 1;
    const newFails = s.expectedHits + s.falseAlarms;
    const precision = newFails ? s.expectedHits / newFails : 1;
    scores[cat] = { ...s, recall: +recall.toFixed(3), precision: +precision.toFixed(3) };
    const t = targets?.[cat];
    if (t) {
      if (recall < t.recall) regressions.push(`${cat} recall ${(recall * 100).toFixed(0)}% < target ${(t.recall * 100)}%`);
      if (precision < t.precision) regressions.push(`${cat} precision ${(precision * 100).toFixed(0)}% < target ${(t.precision * 100)}%`);
    }
  }
  return { scores, regressions };
}

// -------- live drill --------
async function runDetectors(page, suite, contractDoc) {
  const failIds = new Set();
  // compiled assertions (default state only — mutations are visible at rest; hover states
  // are exercised by the state-capture channel, not re-driven per mutation). The drill runs
  // the SAME exported detectors the pipeline runs — never a copy that could drift.
  const defaults = (suite.assertions || []).filter((a) => a.state === "default");
  const results = await page.evaluate(`(${EXEC})(${JSON.stringify({ assertions: defaults, stateConfirmed: true })})`);
  for (const r of results) if (r.status === "fail") failIds.add(r.id);
  if (contractDoc) {
    const observed = await page.evaluate(`(${OBSERVE})(${JSON.stringify(contractDoc)})`);
    for (const r of evaluateStructuralContract(contractDoc, observed)) if (r.status === "fail") failIds.add(r.id);
  }
  return failIds;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const phaseDir = args.find((a, i) => !a.startsWith("--") && (i === 0 || !["--connect", "--url", "--only", "--random", "--seed"].includes(args[i - 1])));
  if (!phaseDir) { console.error("usage: mutation-drill.mjs <phaseDir> [--connect <ws>] [--only <id>] [--random N] [--seed n] [--write]"); process.exit(1); }
  const manifest = await loadJson(path.join(ROOT, "mutations", "manifest.json"));
  const suite = await loadJson(path.join(phaseDir, "compiled-assertions.json"));
  const contractDoc = await loadJson(path.join(phaseDir, "structural-contract.json"));
  if (!manifest || !suite) { console.error("✗ mutations/manifest.json + compiled-assertions.json required"); process.exit(1); }
  let mutations = manifest.mutations;
  const only = flag("--only");
  if (only) mutations = mutations.filter((m) => m.id === only);
  const randomN = +(flag("--random") || 0);
  if (randomN) mutations = [...mutations, ...randomMutations(suite, randomN, +(flag("--seed") || Date.now() % 100000))];

  const ws = flag("--connect") || "http://localhost:9222";
  const chromium = await loadPlaywright();
  const browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => /localhost|127\.0\.0\.1/.test(p.url())) || context.pages()[0];
  if (!page) { console.error("✗ no page"); process.exit(1); }
  const url = flag("--url") || page.url();

  const reload = async () => { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }); await page.waitForTimeout(900); await page.evaluate(async () => { const rail = document.querySelector(".hw-rail"); if (rail && rail.getBoundingClientRect().width < 50) { const t = document.querySelector(".hw-sidebar-toggle"); if (t) { t.click(); await new Promise((r) => setTimeout(r, 500)); } } }); };

  // CONTROL: baseline fails (twice — flaky detectors are a drill failure themselves)
  await reload();
  const control1 = await runDetectors(page, suite, contractDoc);
  const control2 = await runDetectors(page, suite, contractDoc);
  const flaky = [...control2].filter((id) => !control1.has(id)).concat([...control1].filter((id) => !control2.has(id)));
  if (flaky.length) {
    console.error(`✗ control run instability — detectors flaked on: ${flaky.join(", ")}`);
    process.exit(2);
  }
  console.log(`control: ${control1.size} pre-existing fail(s) (baseline)`);

  const runs = [];
  for (const m of mutations) {
    await reload();
    if (m.apply.css) await page.addStyleTag({ content: m.apply.css });
    if (m.apply.dom) await page.evaluate(m.apply.dom);
    await page.waitForTimeout(400);
    const fails = await runDetectors(page, suite, contractDoc);
    const newFails = [...fails].filter((id) => !control1.has(id));
    const expected = m.expectDetect.map((p) => new RegExp(p, "i"));
    const expectedHits = newFails.filter((id) => expected.some((re) => re.test(id))).length;
    const falseAlarms = newFails.length - expectedHits;
    const detected = expectedHits > 0;
    runs.push({ mutation: m, newFails, detected, expectedHits, falseAlarms });
    console.log(`${detected ? "✓" : "✗"} ${m.id} [${m.category}] ${m.description} — ${expectedHits} expected hit(s), ${falseAlarms} false alarm(s)${detected ? "" : ` (MISSED — new fails: ${newFails.join(", ") || "none"})`}`);
  }
  await reload(); // restore

  const { scores, regressions } = scoreDrill(runs, manifest.targets);
  const doc = { at: new Date().toISOString(), url, control: control1.size, scores, regressions, runs: runs.map((r) => ({ id: r.mutation.id, category: r.mutation.category, detected: r.detected, newFails: r.newFails })) };
  await fs.writeFile(path.join(phaseDir, "mutation-drill-results.json"), JSON.stringify(doc, null, 2) + "\n");
  console.log("scores: " + JSON.stringify(scores));
  if (regressions.length) {
    console.error("✗ mutation drill BELOW TARGET:\n  " + regressions.join("\n  "));
    process.exit(2);
  }
  console.log("✓ mutation drill meets all category targets");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

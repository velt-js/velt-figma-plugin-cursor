#!/usr/bin/env node
// regression-guard.mjs — the build-over-build APPEARANCE regression gate.
//
// WHY THIS EXISTS (the v4 regression the pipeline shipped blind): the Judge measures ABSOLUTE
// deltas against the Figma frame. Nothing compared a NEW build to the LAST accepted one, so a
// change that made things WORSE — the comment card losing its border/background, the filter icon
// turning into a black square, the avatar collapsing to 0×0 — passed silently as long as the
// absolute-delta math didn't happen to trip. "Instead of improving we were breaking it" had no
// gate. This is that gate: it diffs the CURRENT per-block measurements against a saved BASELINE and
// FAILS on regressions — an element that was painted and is now transparent, or had a real box and
// now collapsed — which are almost always a structural/plan change breaking a working binding.
//
// It is INTENTIONALLY asymmetric: it does NOT punish IMPROVEMENTS (fewer diffs, newly-painted
// elements). It only flags things that got WORSE relative to the last-good build. A build with a
// clean baseline that only improves passes; a build that resurrects a fixed defect or kills a
// working paint fails.
//
// Signals compared, per (block, element):
//   * paintPresent  — did a visible paint (background/border/box-shadow/fill/color) exist, and is it
//                     now gone (→ transparent/none)?  [the "lost the card border" class]
//   * boxAlive      — did the element have a real box (w>1 && h>1) and is it now collapsed (0)?
//                     [the ".vc-card on a 0-height wrapper" class]
//   * diffCount     — did this block's measured diffCount INCREASE vs baseline? (advisory unless
//                     --strict-count) — a big jump is the "net worse" smell.
//
// Usage:
//   node scripts/regression-guard.mjs baseline <phaseDir>          # snapshot current results/ as the baseline
//   node scripts/regression-guard.mjs check <phaseDir> [--strict-count]
//        # exit 0 = no regressions · 2 = regressions found (printed + written to regression-report.json)
//        # exit 3 = no baseline yet (first build — record one, don't gate)
//
// The baseline lives at <phaseDir>/regression-baseline.json. Snapshot it right after a build the
// human accepts as "at least as good as before"; check it after every subsequent build.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// keys the BROWSER_PROBE persists into delta.elements[].rendered (see delta-compare paintSnap)
const PAINT_KEYS = ["background-color", "border-top-width", "box-shadow", "fill", "color", "outline-style"];
const isTransparent = (v) => v == null || v === "" || /^(none|transparent|normal|rgba\(0,\s*0,\s*0,\s*0\)|0px)$/.test(String(v).trim());

// Reduce one block's delta.json into a per-element fingerprint: does each measured element have a
// live paint, and a live box. We read the RENDERED side (what the live DOM actually shows), not the
// spec — this is about "what the build produces", tracked over time.
export function fingerprintBlock(delta) {
  const els = {};
  // delta.diffs carries {element, property, rendered}; but we want the full rendered snapshot.
  // measure-block persists the probe's element table under delta.elements when present; fall back
  // to reconstructing paint/box hints from the diff rows.
  const list = delta.elements || delta.els || null;
  if (Array.isArray(list)) {
    for (const e of list) {
      if (!e || e.name == null) continue;
      const rd = e.rendered || {};
      const paint = PAINT_KEYS.some((k) => rd[k] != null && !isTransparent(rd[k]));
      const box = e.box && e.box.w > 1 && e.box.h > 1;
      els[e.name] = { paint, box, present: e.present !== false };
    }
    return { els, diffCount: (delta.diffs || []).length };
  }
  // fallback: infer from diff rows (coarse — presence of a "background … got transparent" row means
  // paint is currently absent for that element).
  for (const d of delta.diffs || []) {
    const name = d.element; if (name == null || name === "(gross)") continue;
    const e = els[name] || (els[name] = { paint: true, box: true, present: true });
    if (PAINT_KEYS.includes(String(d.property)) && isTransparent(d.rendered)) e.paint = false;
    if (String(d.property).startsWith("box.") && (d.rendered === 0 || d.rendered === "(none)")) e.box = false;
    if (d.property === "(present)" && /MISSING/.test(String(d.rendered))) e.present = false;
  }
  return { els, diffCount: (delta.diffs || []).length };
}

async function readResults(phaseDir) {
  const base = path.join(phaseDir, "results");
  const out = {};
  let dirs = [];
  try { dirs = await fs.readdir(base); } catch { return out; }
  for (const d of dirs) {
    const dp = path.join(base, d, "delta.json");
    try { out[d] = fingerprintBlock(JSON.parse(await fs.readFile(dp, "utf8"))); } catch { /* no delta for this block */ }
  }
  return out;
}

// Compare current fingerprints against the baseline. Returns the regression rows (things that got
// WORSE) — never improvements.
export function findRegressions(baseline, current, { strictCount = false } = {}) {
  const regressions = [];
  for (const [block, base] of Object.entries(baseline)) {
    const cur = current[block];
    if (!cur) { regressions.push({ block, kind: "block-vanished", note: "block measured in baseline but has no current delta.json" }); continue; }
    for (const [name, b] of Object.entries(base.els || {})) {
      const c = (cur.els || {})[name];
      if (!c) continue; // element not measured now — not necessarily a regression
      if (b.paint && !c.paint) regressions.push({ block, element: name, kind: "paint-lost", was: "painted", now: "transparent/none", note: "element painted in the last build now has no visible paint — a working binding likely broke" });
      if (b.box && !c.box) regressions.push({ block, element: name, kind: "box-collapsed", was: "sized", now: "0", note: "element had a real box in the last build and now collapsed — chrome likely moved onto a 0-size wrapper" });
      if (b.present && !c.present) regressions.push({ block, element: name, kind: "element-vanished", was: "present", now: "MISSING" });
    }
    if (base.diffCount != null && cur.diffCount != null && cur.diffCount > base.diffCount) {
      const row = { block, kind: "diffcount-increased", was: base.diffCount, now: cur.diffCount, note: `this block got ${cur.diffCount - base.diffCount} diff(s) worse than the baseline` };
      if (strictCount) regressions.push(row); else row.advisory = true, regressions.push(row);
    }
  }
  return regressions;
}

async function main() {
  const [cmd, phaseDir, ...rest] = process.argv.slice(2);
  if (!cmd || !phaseDir) { console.error("usage: regression-guard.mjs <baseline|check> <phaseDir> [--strict-count]"); process.exit(1); }
  const baselinePath = path.join(phaseDir, "regression-baseline.json");
  const strictCount = rest.includes("--strict-count");

  if (cmd === "baseline") {
    const cur = await readResults(phaseDir);
    await fs.writeFile(baselinePath, JSON.stringify({ savedAt: new Date().toISOString(), blocks: cur }, null, 2));
    console.log(`✓ regression baseline saved: ${Object.keys(cur).length} block(s) → ${path.relative(process.cwd(), baselinePath)}`);
    process.exit(0);
  }

  if (cmd === "check") {
    let baseline;
    try { baseline = JSON.parse(await fs.readFile(baselinePath, "utf8")).blocks; }
    catch { console.log("⚠ no regression baseline yet — record one with `regression-guard.mjs baseline <phaseDir>` after an accepted build. Not gating this build."); process.exit(3); }
    const current = await readResults(phaseDir);
    const regressions = findRegressions(baseline, current, { strictCount });
    const hard = regressions.filter((r) => !r.advisory);
    await fs.writeFile(path.join(phaseDir, "regression-report.json"), JSON.stringify({ checkedAt: new Date().toISOString(), regressions }, null, 2));
    if (!regressions.length) { console.log("✓ no regressions vs baseline — this build is not worse than the last accepted one"); process.exit(0); }
    for (const r of regressions) console.log(`${r.advisory ? "⚠" : "✗"} [${r.kind}] ${r.block}${r.element ? " · " + r.element : ""}: ${r.note}`);
    console.log(`\n${hard.length} regression(s), ${regressions.length - hard.length} advisory — see regression-report.json`);
    process.exit(hard.length ? 2 : 0);
  }

  console.error(`unknown command '${cmd}'`); process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

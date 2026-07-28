#!/usr/bin/env node
// plan-drift.mjs — Phase 5: plan regeneration drift guard.
//
// Run-0's plan carried hover-bg #f7f6f4; a later regeneration LOST it silently and no gate
// noticed. This guard snapshots plan-style.json per run and diffs regenerations against the
// last snapshot: every REMOVED decl (selector+state+property present before, absent now)
// must carry a reason row in the new plan's `removals[]` (or plan-removals.json) — else
// exit 2 and the compile step refuses the drifted plan.
//
// Usage:
//   node scripts/plan-drift.mjs <phaseDir> check      — diff vs last snapshot; exit 2 on silent drops
//   node scripts/plan-drift.mjs <phaseDir> snapshot   — record current plan as the new baseline

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function loadJson(p) { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; } }

export function declSet(planStyle) {
  const set = new Map();
  for (const r of planStyle?.rules || []) {
    for (const [prop, value] of Object.entries(r.decls || {})) {
      set.set(`${r.selector}|${r.state || "default"}|${prop}`, { selector: r.selector, state: r.state || "default", property: prop, value });
    }
  }
  return set;
}

/** Pure drift evaluation: removed/changed decls vs the prior plan, minus documented removals. */
export function planDrift(prevPlan, nextPlan, removalsDoc) {
  const prev = declSet(prevPlan);
  const next = declSet(nextPlan);
  const documented = new Set([
    ...(nextPlan?.removals || []).map((r) => `${r.selector}|${r.state || "default"}|${r.property}`),
    ...((removalsDoc?.removals || []).map((r) => `${r.selector}|${r.state || "default"}|${r.property}`)),
  ]);
  const removed = [];
  const changed = [];
  for (const [key, d] of prev) {
    if (!next.has(key)) {
      if (!documented.has(key)) removed.push(d);
    } else if (String(next.get(key).value) !== String(d.value)) {
      changed.push({ ...d, newValue: next.get(key).value });
    }
  }
  const added = [...next.keys()].filter((k) => !prev.has(k)).length;
  return { removed, changed, added, documentedRemovals: documented.size };
}

async function main() {
  const [phaseDir, mode] = process.argv.slice(2);
  if (!phaseDir || !["check", "snapshot"].includes(mode || "")) {
    console.error("usage: plan-drift.mjs <phaseDir> check|snapshot");
    process.exit(1);
  }
  const planPath = path.join(phaseDir, "plan-style.json");
  const plan = await loadJson(planPath);
  if (!plan) { console.error("✗ no plan-style.json"); process.exit(1); }
  const histDir = path.join(phaseDir, "plan-style.history");
  await fs.mkdir(histDir, { recursive: true });
  const snaps = (await fs.readdir(histDir)).filter((f) => f.endsWith(".json")).sort();
  const latest = snaps.length ? await loadJson(path.join(histDir, snaps[snaps.length - 1])) : null;

  if (mode === "snapshot") {
    const sha = createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 12);
    if (latest && createHash("sha256").update(JSON.stringify(latest)).digest("hex").slice(0, 12) === sha) {
      console.log("· plan unchanged since last snapshot");
      return;
    }
    const out = path.join(histDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${sha}.json`);
    await fs.writeFile(out, JSON.stringify(plan, null, 2) + "\n");
    console.log(`✓ snapshot ${path.basename(out)}`);
    return;
  }

  if (!latest) {
    console.log("· no prior snapshot — baseline run (snapshot now with `plan-drift.mjs <phaseDir> snapshot`)");
    return;
  }
  const removalsDoc = await loadJson(path.join(phaseDir, "plan-removals.json"));
  const drift = planDrift(latest, plan, removalsDoc);
  if (drift.changed.length) {
    console.log(`· ${drift.changed.length} decl value(s) changed (allowed — values are the planner's to revise):`);
    for (const c of drift.changed.slice(0, 8)) console.log(`  ~ ${c.selector}[${c.state}].${c.property}: ${c.value} → ${c.newValue}`);
  }
  if (drift.added) console.log(`· ${drift.added} decl(s) added`);
  if (drift.removed.length) {
    console.error(`✗ plan drift: ${drift.removed.length} decl(s) REMOVED with no reason row (removals[] in plan-style.json or plan-removals.json):`);
    for (const r of drift.removed) console.error(`  - ${r.selector}[${r.state}].${r.property} (was ${JSON.stringify(r.value)})`);
    console.error("  A regeneration that silently drops decls is how hover-bg #f7f6f4 was lost. Document each removal or restore the decl.");
    process.exit(2);
  }
  console.log("✓ plan drift clean (no undocumented removals)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

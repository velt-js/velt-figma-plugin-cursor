#!/usr/bin/env node
// apply-plan-fills.mjs — persists the Planner's returned fills. The Planner is dispatched
// READ-ONLY (it cannot write files, not even via shell heredoc), so it returns ONE fills JSON
// in its final message and the ORCHESTRATOR persists it here. A prior run wedged 30+ min in
// the plan stage because the planner was told to write briefs via Bash — writes a read-only
// subagent can never make; this script is the durable half of the return-in-message contract.
//
// Usage:
//   node scripts/apply-plan-fills.mjs <phaseDir> <fills.json> [--assume-remaining]
//
// Applies: plan.json, connect-map.json, blocks.json annotations, briefs/*.probes.json fills,
// briefs/*.smoke.json fills. Deletes every satisfied `_todo_*` key and prints the leftover count.
//
// --assume-remaining  DEAD-PLANNER FALLBACK: after applying whatever fills exist (pass an empty
//   `{}` file if the planner returned nothing usable), clear every remaining `_todo` with the
//   scaffold's conservative default and tag the brief `"assumedFills": [paths]` so the Judge sees
//   exactly what was never decided. This lets `brief-scaffold.mjs --lint` pass and the build loop
//   start — the loop's gates catch what the assumed fills got wrong (the alternative, waiting on
//   a wedged planner, catches nothing).
//
// Fills JSON shape (all keys optional):
//   {
//     "planJson": {...}, "connectMapJson": {...},
//     "blocksPatch":  { "<blockId>": { "drive", "liveSelector", "fixture", "frameRegion" } },
//     "probesPatch":  { "<blockId>": { "drive": {"steps","assert"}, "liveSelector",
//                                      "elements": {"<name>": "<selector>"},
//                                      "relations": [], "gaps": [], "layer": [] } },
//     "smokePatch":   { "<familyId>": { "steps": [{"name","actions","assert"}], "resizeAssert" } }
//   }

import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const readJson = async (p) => JSON.parse(await fs.readFile(p, "utf8"));
// atomic: a crash mid-write must never leave a truncated brief for the build loop to trip on
async function writeJson(p, o) {
  const tmp = `${p}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(o, null, 2) + "\n");
  await fs.rename(tmp, p);
}

function stripTodos(obj) {
  if (Array.isArray(obj)) { obj.forEach(stripTodos); return; }
  if (obj && typeof obj === "object") {
    for (const k of Object.keys(obj)) {
      if (k.startsWith("_todo")) delete obj[k];
      else stripTodos(obj[k]);
    }
  }
}
function findTodos(obj, trail = "", out = []) {
  if (Array.isArray(obj)) obj.forEach((v, i) => findTodos(v, `${trail}[${i}]`, out));
  else if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("_todo")) out.push(trail ? `${trail}.${k}` : k);
    else findTodos(v, trail ? `${trail}.${k}` : k, out);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const assumeRemaining = args.includes("--assume-remaining");
  const [phaseDir, fillsPath] = args.filter((a) => !a.startsWith("--"));
  if (!phaseDir || !fillsPath) {
    console.error("usage: apply-plan-fills.mjs <phaseDir> <fills.json> [--assume-remaining]");
    process.exit(1);
  }

  const fills = await readJson(fillsPath);
  const briefsDir = path.join(phaseDir, "briefs");
  const out = { wrote: [], warnings: [], assumed: [] };

  // 1. plan.json + connect-map.json
  if (fills.planJson) { await writeJson(path.join(phaseDir, "plan.json"), fills.planJson); out.wrote.push("plan.json"); }
  else out.warnings.push("no planJson in fills");
  if (fills.connectMapJson) { await writeJson(path.join(phaseDir, "connect-map.json"), fills.connectMapJson); out.wrote.push("connect-map.json"); }
  else out.warnings.push("no connectMapJson in fills");

  // 2. blocks.json annotations
  const blocksPath = path.join(phaseDir, "blocks.json");
  const blocks = await readJson(blocksPath);
  for (const [id, patch] of Object.entries(fills.blocksPatch || {})) {
    const b = (blocks.blocks || []).find((x) => x.id === id);
    if (!b) { out.warnings.push(`blocksPatch: unknown block '${id}'`); continue; }
    if (patch.drive) b.drive = patch.drive;
    if (patch.liveSelector != null) b.liveSelector = patch.liveSelector;
    if (patch.fixture) b.fixture = patch.fixture;
    if ("frameRegion" in patch) b.frameRegion = patch.frameRegion;
  }
  await writeJson(blocksPath, blocks);
  out.wrote.push("blocks.json (annotated)");

  // 3. probes fills
  for (const [id, patch] of Object.entries(fills.probesPatch || {})) {
    const p = path.join(briefsDir, `${id}.probes.json`);
    let probe;
    try { probe = await readJson(p); } catch { out.warnings.push(`probesPatch: no skeleton for '${id}'`); continue; }
    if (patch.drive) {
      probe.drive.steps = patch.drive.steps || [];
      probe.drive.assert = patch.drive.assert ?? probe.drive.assert;
    }
    if (patch.liveSelector) {
      probe.liveSelector = patch.liveSelector;
      if (probe.browser) probe.browser.surfaceSelector = probe.browser.surfaceSelector ?? patch.liveSelector;
    }
    const selByName = patch.elements || {};
    for (const el of probe.browser?.elements || []) {
      if (selByName[el.name] != null) el.selector = selByName[el.name];
      else if (el.selector == null) out.warnings.push(`${id}: element '${el.name}' has no selector fill`);
    }
    if (patch.relations) probe.browser.relations = patch.relations;
    if (patch.gaps) probe.browser.gaps = patch.gaps;
    probe.layer = patch.layer ?? probe.layer ?? [];
    if (probe.layer === null) probe.layer = [];
    stripTodos(probe);
    await writeJson(p, probe);
  }
  out.wrote.push(`probes x${Object.keys(fills.probesPatch || {}).length}`);

  // 4. smoke fills
  for (const [famId, patch] of Object.entries(fills.smokePatch || {})) {
    const p = path.join(briefsDir, `${famId}.smoke.json`);
    let smoke;
    try { smoke = await readJson(p); } catch { out.warnings.push(`smokePatch: no skeleton for '${famId}'`); continue; }
    const byName = new Map((patch.steps || []).map((s) => [s.name, s]));
    for (const step of smoke.steps || []) {
      const f = byName.get(step.name);
      if (f) { step.actions = f.actions || []; step.assert = f.assert ?? step.assert; }
      else out.warnings.push(`${famId}: smoke step '${step.name}' has no fill`);
    }
    const resizeAssert = patch.resizeAssert ?? patch.resize?.assert;
    if (smoke.resize) smoke.resize.assert = resizeAssert ?? smoke.resize.assert ?? smoke.steps?.[0]?.assert ?? null;
    stripTodos(smoke);
    await writeJson(p, smoke);
  }
  out.wrote.push(`smoke x${Object.keys(fills.smokePatch || {}).length}`);

  // 5. leftover _todo scan — with the dead-planner fallback when authorized
  let leftovers = 0;
  for (const f of await fs.readdir(briefsDir).catch(() => [])) {
    if (!f.endsWith(".json") || f.endsWith(".spec.json")) continue;
    const p = path.join(briefsDir, f);
    const brief = await readJson(p);
    const todos = findTodos(brief);
    if (!todos.length) continue;
    if (assumeRemaining) {
      // conservative defaults: empty steps stay empty, null asserts/selectors stay null —
      // the loop's gates (lint passes, measure fails loudly) surface each one by name.
      stripTodos(brief);
      brief.assumedFills = todos;
      await writeJson(p, brief);
      out.assumed.push(`${f}: ${todos.length} field(s) assumed (${todos.slice(0, 3).join(", ")}${todos.length > 3 ? ", …" : ""})`);
    } else {
      leftovers += todos.length;
    }
  }

  console.log(JSON.stringify({ ...out, leftoverTodos: leftovers }, null, 2));
  const missingSkeleton = out.warnings.some((w) => w.includes("no skeleton for"));
  process.exit(missingSkeleton ? 2 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

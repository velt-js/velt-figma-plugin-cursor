#!/usr/bin/env node
// mechanism-checklist.mjs — GOLDEN-PATH appearance terminator.
// Refuses "done / handoff" when the demo-polish checklist is missing or failing,
// even if deltaCompare diffCount has plateaued.
//
// Usage:
//   node scripts/mechanism-checklist.mjs check <phaseDir> [--family <id>]
//   node scripts/mechanism-checklist.mjs init <phaseDir> <blockId> --results '<json>'
//
// Artifact: <phaseDir>/mechanism-checklist.json
// {
//   at, ok, items: [{ id, surface, status: "pass"|"fail"|"na", evidence }],
//   blocks: { <blockId>: { items: [...] } }
// }
//
// Exit 0 = every applicable item is pass or na (with reason)
// Exit 2 = missing artifact, or any applicable fail, or zero items recorded

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

export function applicableChecklist(playbook, blocks) {
  const items = playbook?.checklist || [];
  const blob = JSON.stringify(blocks || []).toLowerCase();
  return items.filter((it) => {
    const s = String(it.surface || "").toLowerCase();
    if (/sidebar/.test(s)) return /sidebar|flow|panel/.test(blob);
    if (/dialog|thread|card/.test(s)) return /dialog|thread|comment|card|selected|reply/.test(blob);
    if (/composer|page-mode/.test(s)) return /composer|page|flow|sidebar|reply/.test(blob);
    return true;
  });
}

export function evaluateChecklistDoc(doc, applicable) {
  const byId = new Map((doc?.items || []).map((i) => [i.id, i]));
  const fails = [];
  const missing = [];
  for (const a of applicable) {
    const row = byId.get(a.id);
    if (!row) { missing.push(a.id); continue; }
    if (row.status === "fail") fails.push(a.id);
    if (!["pass", "fail", "na"].includes(row.status)) missing.push(a.id);
    if (row.status === "na" && !row.evidence) missing.push(`${a.id}(na-without-evidence)`);
  }
  return { ok: !fails.length && !missing.length && applicable.length > 0 && (doc?.items || []).length > 0, fails, missing };
}

async function check(phaseDir, familyId) {
  const playbook = await loadJson(path.join(PLUGIN_ROOT, "knowledge", "mechanism-polish.json"));
  const blocksDoc = await loadJson(path.join(phaseDir, "blocks.json"));
  const blocks = (blocksDoc?.blocks || []).filter((b) => !familyId || b.familyId === familyId);
  const applicable = applicableChecklist(playbook, blocks);
  const doc = await loadJson(path.join(phaseDir, "mechanism-checklist.json"));
  if (!doc) {
    console.error("✗ mechanism-checklist.json missing — Builder must run DEMO-POLISH and record checklist results before handoff");
    process.exit(2);
  }
  const { ok, fails, missing } = evaluateChecklistDoc(doc, applicable);
  if (!ok) {
    if (missing.length) console.error(`✗ mechanism-checklist incomplete: ${missing.join(", ")}`);
    if (fails.length) console.error(`✗ mechanism-checklist FAIL: ${fails.join(", ")}`);
    if (!applicable.length) console.error("✗ mechanism-checklist: no applicable items (blocks.json empty?)");
    process.exit(2);
  }
  console.log(`✓ mechanism-checklist: ${applicable.length} applicable item(s) pass/na`);
  process.exit(0);
}

async function init(phaseDir, blockId, resultsJson) {
  const results = JSON.parse(resultsJson || "[]");
  const prev = (await loadJson(path.join(phaseDir, "mechanism-checklist.json"))) || { items: [], blocks: {} };
  prev.blocks = prev.blocks || {};
  prev.blocks[blockId] = { items: results, at: new Date().toISOString() };
  // Merge: latest non-na wins; fail beats pass
  const map = new Map((prev.items || []).map((i) => [i.id, i]));
  for (const r of results) {
    const cur = map.get(r.id);
    if (!cur || r.status === "fail" || (r.status === "pass" && cur.status === "na")) map.set(r.id, r);
    else if (!cur) map.set(r.id, r);
  }
  prev.items = [...map.values()];
  prev.at = new Date().toISOString();
  const playbook = await loadJson(path.join(PLUGIN_ROOT, "knowledge", "mechanism-polish.json"));
  const blocksDoc = await loadJson(path.join(phaseDir, "blocks.json"));
  const ev = evaluateChecklistDoc(prev, applicableChecklist(playbook, blocksDoc?.blocks || []));
  prev.ok = ev.ok;
  await fs.writeFile(path.join(phaseDir, "mechanism-checklist.json"), JSON.stringify(prev, null, 2) + "\n");
  console.log(`✓ mechanism-checklist updated (${blockId}) ok=${prev.ok}`);
}

async function main() {
  const [cmd, phaseDir, blockId, ...rest] = process.argv.slice(2);
  const flag = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
  if (cmd === "check") return check(phaseDir, flag("--family"));
  if (cmd === "init") return init(phaseDir, blockId, flag("--results"));
  console.error("usage: mechanism-checklist.mjs check <phaseDir> [--family id] | init <phaseDir> <blockId> --results '<json>'");
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

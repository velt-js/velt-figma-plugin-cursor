#!/usr/bin/env node
// golden-path-check.mjs — consolidates the three gates that separate a "gate STOPPED"
// run from a golden-demo-quality run. Used by write-handoff + orchestrator honesty.
//
// Usage: node scripts/golden-path-check.mjs <phaseDir>
// Exit 0 = all golden-path gates ok (or N/A because plan artifacts absent)
// Exit 2 = one or more golden-path gates failing
//
// Checks:
//   1) host-wiring.json ok (or verify-host-wiring can pass)
//   2) plan-style authorship not thin/deterministic
//   3) mechanism-checklist.json records applicable items as pass/na

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stylePlanAuthorshipProblems } from "./brief-scaffold.mjs";
import { applicableChecklist, evaluateChecklistDoc } from "./mechanism-checklist.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

export async function goldenPathProblems(phaseDir) {
  const problems = [];
  const host = await loadJson(path.join(phaseDir, "host-wiring.json"));
  if (!host) problems.push({ gate: "host-wiring", note: "host-wiring.json missing — run verify-host-wiring.mjs --apply" });
  else if (host.ok === false) problems.push({ gate: "host-wiring", note: `host-wiring not ok (${(host.missing || []).length} missing)` });

  const planStyle = await loadJson(path.join(phaseDir, "plan-style.json"));
  const blocks = await loadJson(path.join(phaseDir, "blocks.json"));
  if (planStyle) {
    for (const p of stylePlanAuthorshipProblems(planStyle, blocks)) {
      problems.push({ gate: "style-plan", note: p.note, kind: p.kind });
    }
  }

  const playbook = await loadJson(path.join(PLUGIN_ROOT, "knowledge", "mechanism-polish.json"));
  const checklist = await loadJson(path.join(phaseDir, "mechanism-checklist.json"));
  if (blocks?.blocks?.length) {
    const appl = applicableChecklist(playbook, blocks.blocks);
    if (appl.length) {
      if (!checklist) problems.push({ gate: "mechanism-checklist", note: "mechanism-checklist.json missing — DEMO-POLISH not recorded" });
      else {
        const ev = evaluateChecklistDoc(checklist, appl);
        if (!ev.ok) {
          problems.push({
            gate: "mechanism-checklist",
            note: `checklist incomplete/fail (missing=${ev.missing.join(",") || "—"} fails=${ev.fails.join(",") || "—"})`,
          });
        }
      }
    }
  }

  return problems;
}

async function main() {
  const phaseDir = process.argv[2];
  if (!phaseDir) {
    console.error("usage: golden-path-check.mjs <phaseDir>");
    process.exit(1);
  }
  const problems = await goldenPathProblems(phaseDir);
  const out = { at: new Date().toISOString(), ok: problems.length === 0, problems };
  await fs.writeFile(path.join(phaseDir, "golden-path.json"), JSON.stringify(out, null, 2) + "\n");
  if (problems.length) {
    console.error(`✗ golden-path: ${problems.length} gate(s) failing`);
    for (const p of problems) console.error(`  - [${p.gate}] ${p.note}`);
    process.exit(2);
  }
  console.log("✓ golden-path: host-wiring + style authorship + mechanism-checklist ok");
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

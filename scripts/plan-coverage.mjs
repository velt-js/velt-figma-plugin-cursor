#!/usr/bin/env node
// plan-coverage.mjs — Phase 5: the planner's completeness contract.
//
// Every Figma property on the family's design nodes must be accounted for as one of:
//   decl        — a plan-style rule covers it
//   relation    — encoded as sibling geometry in plan-fills boxes
//   state-row   — covered by a state-scoped rule
//   contract    — covered by a structural-contract row
//   unencodable — EXPLICITLY declared in plan-style.json `unencodable[]` with a reason
//   hole        — none of the above (the planner's open work-list)
//
// The report is stamped with the plan-style sha; compile-assertions --require-coverage
// refuses to compile against a plan whose coverage report is missing or stale.
//
// Usage: node scripts/plan-coverage.mjs <phaseDir> [--family <regex>] [--write]
// Exit 0 = report generated (holes allowed — they are the planner's queue);
// exit 2 = inputs missing/invalid.

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { familyNodes, extractSlots, coverageDiff } from "./compile-assertions.mjs";

async function loadJson(p) { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; } }
async function fileSha(p) { try { return createHash("sha256").update(await fs.readFile(p)).digest("hex"); } catch { return null; } }

export function buildCoverageReport({ designSpec, planStyle, planFills, contractDoc, familyRegex }) {
  const slots = extractSlots(planFills || {});
  const { frames, members } = familyNodes(designSpec, familyRegex);
  const holes = coverageDiff(designSpec, planStyle, members, slots);
  const unencodable = planStyle?.unencodable || [];
  const unencodableKey = new Set(unencodable.map((u) => `${u.specNodeId}|${u.property || "*"}`));
  const contractSpecIds = new Set();
  for (const c of contractDoc?.contracts || []) for (const m of String(c.note || "").matchAll(/\d+:\d+/g)) contractSpecIds.add(m[0]);

  const rows = [];
  for (const h of holes) {
    const props = h.kind === "unmapped-node" ? (h.properties || []) : [h.property];
    for (const prop of props) {
      let status = "hole";
      if (unencodableKey.has(`${h.specNodeId}|${prop}`) || unencodableKey.has(`${h.specNodeId}|*`)) status = "unencodable";
      else if (contractSpecIds.has(h.specNodeId)) status = "contract";
      rows.push({ specNodeId: h.specNodeId, nodeName: h.nodeName, state: h.state, property: prop, designValue: h.designValue ?? null, status, designPath: h.designPath });
    }
  }
  const accountedDecls = [];
  for (const [i, r] of (planStyle?.rules || []).entries()) {
    for (const prop of Object.keys(r.decls || {})) {
      accountedDecls.push({ selector: r.selector, state: r.state || "default", property: prop, specNodeId: r.specNodeId, ruleIndex: i });
    }
  }
  return {
    familyFrames: frames.map((f) => `${f.id}:${f.name}`),
    familyNodes: members.length,
    decls: accountedDecls.length,
    relations: slots.filter((s) => s.slot && s.box).length,
    rows,
    stats: rows.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {}),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const phaseDir = args.find((a, i) => !a.startsWith("--") && (i === 0 || !["--family"].includes(args[i - 1])));
  if (!phaseDir) { console.error("usage: plan-coverage.mjs <phaseDir> [--family <regex>] [--write]"); process.exit(1); }
  const designSpec = await loadJson(path.join(phaseDir, "designSpec.json"));
  const planStyle = await loadJson(path.join(phaseDir, "plan-style.json"));
  const planFills = await loadJson(path.join(phaseDir, "plan-fills.json"));
  const contractDoc = await loadJson(path.join(phaseDir, "structural-contract.json"));
  if (!designSpec || !planStyle) { console.error("✗ designSpec.json + plan-style.json required"); process.exit(2); }
  const familyRegex = new RegExp(flag("--family") || "single comment dialog|selected state", "i");
  const report = buildCoverageReport({ designSpec, planStyle, planFills, contractDoc, familyRegex });
  const doc = {
    generatedAt: new Date().toISOString(),
    planStyleSha: await fileSha(path.join(phaseDir, "plan-style.json")),
    designSpecSha: await fileSha(path.join(phaseDir, "designSpec.json")),
    ...report,
  };
  console.log(JSON.stringify({ stats: doc.stats, decls: doc.decls, relations: doc.relations, holes: doc.rows.filter((r) => r.status === "hole").slice(0, 10) }, null, 2));
  if (args.includes("--write")) {
    await fs.writeFile(path.join(phaseDir, "plan-coverage.json"), JSON.stringify(doc, null, 2) + "\n");
    console.log(`✓ wrote plan-coverage.json (${doc.stats.hole || 0} open hole(s), ${doc.stats.unencodable || 0} declared unencodable)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

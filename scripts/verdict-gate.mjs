#!/usr/bin/env node
// verdict-gate.mjs — the MECHANICAL terminator. Given the generated checklist + the Judge's report,
// it decides PASS / FAIL / INCOMPLETE. The whole point: a report that SAMPLES (measures fewer
// checklist entries than were generated, or skips a state, or omits the visual side-by-side) is
// **INCOMPLETE** — which is NOT pass, so /goal cannot terminate on it. This makes the M5 sampling
// failure (5 of 8 measured, all 5 pass → "done") structurally unreachable: coverage is checked, not
// trusted. The Judge can no longer hand-pick a narrow spec and self-terminate.
//
// judge-report.json shape (the Judge MUST produce this each loop):
// { states: { "<state>": {
//     dispositions: { "<checklist element id>": { status: "pass"|"fail"|"waived", note? } },
//     mustSupply:   { "<supply id>": "pass"|"fail" },
//     reconciliation: { ok: bool, conflicts?: [] },
//     contract:       { ok: bool, violations?: [] },
//     visualSideBySide: { figmaRef, liveShot, namedDifferences: [ ... ] }   // the required artifact
// } } }
//
// Usage: node scripts/verdict-gate.mjs --checklist <checklist.json> --report <judge-report.json>

import { promises as fs } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

// PASS only if coverage is complete AND every covered thing is clean. Missing coverage ⇒ INCOMPLETE.
export function verdictGate(checklist, report) {
  const missing = [];   // coverage / artifact gaps  ⇒ INCOMPLETE
  const failures = [];  // measured-but-wrong         ⇒ FAIL
  const states = report.states || {};
  const elementIds = (checklist.elements || []).map((e) => e.id);
  const supplyIds = (checklist.mustSupply || []).map((m) => m.id);

  // (a) every required state must be present
  for (const st of checklist.states || ["default"]) if (!states[st]) missing.push(`state '${st}' not driven`);

  // (b) the default (or the only) state must cover EVERY generated checklist element + every mustSupply
  const base = states.default || states[Object.keys(states)[0]] || {};
  const disp = base.dispositions || {};
  for (const id of elementIds) {
    if (!(id in disp)) missing.push(`element '${id}' has no Judge disposition (sampled out)`);
    else if (disp[id].status === "fail") failures.push(`element '${id}' FAIL: ${disp[id].note || ""}`);
  }
  const sup = base.mustSupply || {};
  for (const id of supplyIds) {
    if (!(id in sup)) missing.push(`mustSupply '${id}' not verified`);
    else if (sup[id] === "fail") failures.push(`mustSupply '${id}' not supplied`);
  }

  // (c) every present state must carry the required artifacts (visual side-by-side, reconciliation, contract)
  for (const [st, s] of Object.entries(states)) {
    const v = s.visualSideBySide;
    if (!v || !("namedDifferences" in v) || !v.figmaRef || !v.liveShot) missing.push(`state '${st}': visual side-by-side artifact missing (figmaRef + liveShot + namedDifferences required)`);
    else if (Array.isArray(v.namedDifferences) && v.namedDifferences.length) for (const d of v.namedDifferences) failures.push(`state '${st}' visual diff: ${typeof d === "string" ? d : JSON.stringify(d)}`);
    if (!s.reconciliation || typeof s.reconciliation.ok !== "boolean") missing.push(`state '${st}': reconciliation result missing`);
    else if (!s.reconciliation.ok) failures.push(`state '${st}': layer-reconciliation FAIL`);
    if (!s.contract || typeof s.contract.ok !== "boolean") missing.push(`state '${st}': mount-map contract result missing`);
    else if (!s.contract.ok) failures.push(`state '${st}': mount-map contract violation`);
  }

  const coverage = elementIds.length ? Math.round(100 * (elementIds.length - missing.filter((m) => m.startsWith("element ")).length) / elementIds.length) : 100;
  if (missing.length) return { verdict: "INCOMPLETE", coverage, missing, failures, note: "coverage/artifacts incomplete — CANNOT terminate (a sample is not a pass)" };
  if (failures.length) return { verdict: "FAIL", coverage: 100, missing: [], failures };
  return { verdict: "PASS", coverage: 100, missing: [], failures: [] };
}

async function main() {
  const cl = argv("--checklist"), rp = argv("--report");
  if (!cl || !rp) { console.error("usage: verdict-gate.mjs --checklist <checklist.json> --report <judge-report.json>"); process.exit(1); }
  const checklist = JSON.parse(await fs.readFile(cl, "utf8"));
  const report = JSON.parse(await fs.readFile(rp, "utf8"));
  const r = verdictGate(checklist, report);
  console.log(`VERDICT: ${r.verdict}  (element coverage ${r.coverage}%)`);
  if (r.missing.length) { console.log("  INCOMPLETE — not measured / artifacts missing:"); for (const m of r.missing.slice(0, 20)) console.log("    · " + m); }
  if (r.failures.length) { console.log("  FAIL — measured but wrong:"); for (const f of r.failures.slice(0, 20)) console.log("    · " + f); }
  if (r.verdict !== "PASS") process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

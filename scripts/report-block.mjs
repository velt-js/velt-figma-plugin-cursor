#!/usr/bin/env node
// report-block.mjs — the SCRIPT-WRITTEN block-report assembler. Previously the Judge agent
// transcribed probe outputs into block-report.json by hand — a hallucinated/typo'd/optimistic
// transcription could PASS a phase. Now: every measurement script persists its own JSON artifact,
// and THIS script assembles the block-report entry FROM THOSE FILES. The Judge never writes
// report JSON; it only produces the artifacts (and decides the few things scripts can't).
//
// Usage:
//   report-block.mjs measure <phaseDir> <blockId>
//       --capture <shot.png> --frame <frame.png>
//       --visual <visual.json>            # visual-diff.mjs --json-out
//       --delta <delta.json>              # BROWSER_PROBE result, saved verbatim
//       --stability <stability.json>      # STABILITY_PROBE result, saved verbatim
//       [--reconciliation <rec.json>]     # LAYER_PROBE result
//       [--contract <contract.json>]      # CONTRACT_PROBE result
//       [--driven]                        # pass ONLY if block.drive.assert matched in the live DOM
//   report-block.mjs account <phaseDir> <blockId> --disposition BLOCKED|GAP --note "<why>" --evidence <file>
//
// `measure` validates every artifact exists + has the required shape, copies each JSON into
// <phaseDir>/results/<blockId>/ (the canonical location the verdict gate audits against), and
// writes the entry. `account` records a terminal disposition — the note AND an existing evidence
// file are both REQUIRED (a GAP needs the F3-exhaustion record; a BLOCKED needs the triage
// capture) so "declare a gap to escape the loop" is structurally unreachable.

import { promises as fs } from "node:fs";
import path from "node:path";

async function loadJson(p) { return JSON.parse(await fs.readFile(p, "utf8")); }
async function mustExist(p, what) {
  const ok = await fs.access(p).then(() => true, () => false);
  if (!ok) { console.error(`✗ ${what} not found on disk: ${p}`); process.exit(1); }
}

async function measure(phaseDir, blockId, f) {
  for (const k of ["capture", "frame", "visual", "delta", "stability"]) if (!f[k]) { console.error(`✗ --${k} is required`); process.exit(1); }
  await mustExist(f.capture, "capture PNG"); await mustExist(f.frame, "frame PNG");

  // parse + shape-check each artifact (a malformed artifact must fail HERE, loudly, not at the gate)
  const visual = await loadJson(f.visual);
  if (typeof visual.diffPct !== "number" || !Array.isArray(visual.regions)) { console.error(`✗ ${f.visual} is not a visual-diff.mjs result (needs numeric diffPct + regions[])`); process.exit(1); }
  const delta = await loadJson(f.delta);
  const deltaOk = typeof delta.ok === "boolean" ? delta.ok : delta.verdict === "PASS";
  const deltaDiffs = Array.isArray(delta.diffs) ? delta.diffs : [];
  if (typeof delta.ok !== "boolean" && typeof delta.verdict !== "string") { console.error(`✗ ${f.delta} is not a delta-compare result (needs ok:boolean or verdict)`); process.exit(1); }
  const stability = await loadJson(f.stability);
  if (typeof stability.ok !== "boolean" || !Array.isArray(stability.targets)) { console.error(`✗ ${f.stability} is not a STABILITY_PROBE result (needs ok:boolean + targets[])`); process.exit(1); }
  const reconciliation = f.reconciliation ? await loadJson(f.reconciliation) : null;
  const contract = f.contract ? await loadJson(f.contract) : null;

  // canonicalize: copy every artifact JSON into results/<blockId>/ — the gate audits THESE
  const resDir = path.join(phaseDir, "results", blockId);
  await fs.mkdir(resDir, { recursive: true });
  const put = async (name, obj) => { const p = path.join(resDir, name); await fs.writeFile(p, JSON.stringify(obj, null, 2)); return path.relative(phaseDir, p); };
  const artifacts = {
    visual: await put("visual.json", visual),
    delta: await put("delta.json", delta),
    stability: await put("stability.json", stability),
    ...(reconciliation ? { reconciliation: await put("reconciliation.json", reconciliation) } : {}),
    ...(contract ? { contract: await put("contract.json", contract) } : {}),
  };

  const rp = path.join(phaseDir, "block-report.json");
  const report = JSON.parse(await fs.readFile(rp, "utf8").catch(() => '{"blocks":{}}'));
  report.blocks = report.blocks || {};
  report.blocks[blockId] = {
    built: true,
    driven: !!f.driven,
    capturePng: f.capture, framePng: f.frame,
    visualDiff: { diffPct: visual.diffPct, regions: visual.regions },
    deltaCompare: { ok: deltaOk, diffs: deltaDiffs },
    ...(reconciliation ? { reconciliation } : {}),
    ...(contract ? { contract } : {}),
    stability: { ok: stability.ok, targets: stability.targets },
    artifacts, assembledAt: new Date().toISOString(),
  };
  await fs.writeFile(rp, JSON.stringify(report, null, 2));
  const sig = visual.regions.filter((r) => (r.fill ?? 1) >= 0.05).length;
  console.log(`✓ ${blockId}: assembled from ${Object.keys(artifacts).length} artifacts — driven=${!!f.driven}, ${sig} significant visual region(s), delta ${deltaOk ? "clean" : deltaDiffs.length + " diffs"}, stability ${stability.ok ? "ok" : "FAIL"}`);
}

async function account(phaseDir, blockId, disposition, note, evidence) {
  const d = (disposition || "").toUpperCase();
  if (!["BLOCKED", "GAP"].includes(d)) { console.error("✗ --disposition BLOCKED|GAP (STUCK is written by block-iter.mjs, never by hand)"); process.exit(1); }
  if (!note || !note.trim()) { console.error("✗ --note is required (the specific why)"); process.exit(1); }
  if (!evidence) { console.error(`✗ --evidence <file> is required — a ${d} without evidence is an escape hatch, not a verdict (GAP: the F3-exhaustion record; BLOCKED: the env-triage capture)`); process.exit(1); }
  await mustExist(evidence, `${d} evidence file`);
  const rp = path.join(phaseDir, "block-report.json");
  const report = JSON.parse(await fs.readFile(rp, "utf8").catch(() => '{"blocks":{}}'));
  report.blocks = report.blocks || {};
  report.blocks[blockId] = { ...(report.blocks[blockId] || {}), disposition: d, note, evidence: path.relative(phaseDir, path.resolve(evidence)) };
  await fs.writeFile(rp, JSON.stringify(report, null, 2));
  console.log(`✓ ${blockId}: ${d} recorded with evidence ${evidence}`);
}

async function main() {
  const [cmd, phaseDir, blockId, ...rest] = process.argv.slice(2);
  const flag = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  if (!cmd || !phaseDir || !blockId) { console.error("usage: report-block.mjs measure|account <phaseDir> <blockId> [flags]"); process.exit(1); }
  if (cmd === "measure") await measure(phaseDir, blockId, {
    capture: flag("--capture"), frame: flag("--frame"), visual: flag("--visual"), delta: flag("--delta"),
    stability: flag("--stability"), reconciliation: flag("--reconciliation"), contract: flag("--contract"),
    driven: rest.includes("--driven"),
  });
  else if (cmd === "account") await account(phaseDir, blockId, flag("--disposition"), flag("--note"), flag("--evidence"));
  else { console.error(`✗ unknown command '${cmd}'`); process.exit(1); }
}

main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

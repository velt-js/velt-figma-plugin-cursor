#!/usr/bin/env node
// judge-verify-report.mjs — compute strict Judge verification verdict for a phase.
//
// Plain PASS banned when any failCriteria is true → PASS-DEGRADED or FAIL.
// Does NOT touch emit forwarding / dedupe / provenance / capability routing.
//
// Usage:
//   node scripts/judge-verify-report.mjs <phaseDir> [--write]

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { judgeVerifyVerdict } from "./judge-verify-verdict.mjs";

async function loadJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

export async function buildFailCriteria(phaseDir) {
  const defects = await loadJson(path.join(phaseDir, "judge-defects.json")) || {};
  const evidenceMeta = defects.evidenceMeta || {};
  const ledger = defects.deliveryLedger || [];
  const p0 = defects.workOrderP0 || [];
  const appearanceDir = path.join(phaseDir, "appearance");
  let orphanedVision = false;
  let selectorHintMissing = false;
  let blankCrops = false;
  let genericP0Ids = false;
  let nullRequiredSelectors = false;

  // Orphans: glance ids not in workOrder (post-emit check is authoritative when present)
  const orphanGate = await loadJson(path.join(phaseDir, "composed-vision-orphan-gate.json"));
  if (orphanGate?.orphans?.length) orphanedVision = true;

  for (const row of p0) {
    const id = String(row.issueKey || "").split(".").pop();
    if (/^visual-(chrome|region)-/i.test(id)) genericP0Ids = true;
    const hint = row.evidence?.selectorHint ?? row.builderPacket?.selectorHint;
    if (hint === "" || hint === null) selectorHintMissing = true;
    if (!row.evidence?.liveCrop || !row.evidence?.figmaCrop) blankCrops = true;
  }

  const hoverBlocked = evidenceMeta.hoverBlocked || [];
  const evidenceSource = evidenceMeta.evidenceSource || null;
  const connected = evidenceMeta.connected === true;

  // Phase 3: a structural contract that exists but was never validated on the LIVE DOM —
  // or that has violations — is a HARD fail (wireframe-source green is not sufficient).
  const contractDoc = await loadJson(path.join(phaseDir, "structural-contract.json"));
  const contractResults = await loadJson(path.join(phaseDir, "structural-contract-results.json"));
  const structuralContractViolations = !!(contractResults?.summary?.fail > 0);
  const structuralContractUnvalidated = !!(contractDoc && !contractResults);

  // Phase 2: emit recorded state-coverage problems (bound state frames without confirmed captures).
  const stateCoverageIncomplete = !!(defects.totals?.stateCoverageProblems?.length);

  // Phase 4: contradiction ladder must be drained — unresolved regions or invalid residuals
  // (missing crops/expiry) ban a plain PASS.
  const contradictionLedger = await loadJson(path.join(phaseDir, "contradiction-ledger.json"));
  const unresolvedContradictions = !!(contradictionLedger && (
    (contradictionLedger.unresolved || []).length
    || (contradictionLedger.entries || []).some((e) => e.status === "accepted-residual" && (!e.crops?.live || !e.crops?.figma || !e.expiry?.pixelHash))
  ));

  return {
    structuralContractViolations,
    structuralContractUnvalidated,
    stateCoverageIncomplete,
    unresolvedContradictions,
    orphanedVision,
    duplicateIssueKeys: false,
    duplicateIdentities: false,
    genericP0Ids,
    blankCrops,
    missingRouting: p0.some((r) => !r.route?.mode && !r.route),
    perBlockIdentityNotPreserved: false,
    runFailed: false,
    selectorLiveUnresolved: p0.some((r) => r.evidence?.selectorValidated === false && r.evidence?.selectorHint),
    selectorHintMissing,
    evidenceWithoutConnect: evidenceSource === "degraded-source" || (!connected && p0.length > 0),
    hoverCaptureUnavailable: hoverBlocked.length > 0,
    cdpUnavailable: evidenceMeta.connected === false && p0.length > 0,
    degradedSource: evidenceSource === "degraded-source",
    nullRequiredSelectors,
    _meta: { evidenceSource, connected, hoverBlocked, ledgerCount: ledger.length, p0Count: p0.length },
  };
}

export async function writeJudgeVerifyReport(phaseDir, { write = false } = {}) {
  const fc = await buildFailCriteria(phaseDir);
  const meta = fc._meta;
  delete fc._meta;
  const verdict = judgeVerifyVerdict({ failCriteria: fc });
  const report = {
    at: new Date().toISOString(),
    phaseDir,
    verdict: verdict.verdict,
    reasons: verdict.reasons,
    hard: verdict.hard,
    degraded: verdict.degraded,
    failCriteria: fc,
    meta,
  };
  if (write) {
    await fs.writeFile(path.join(phaseDir, "JUDGE-VERIFY-REPORT.json"), JSON.stringify(report, null, 2) + "\n");
    const md = [
      `# Judge verify — ${verdict.verdict}`,
      "",
      `Reasons: ${verdict.reasons.length ? verdict.reasons.join(", ") : "(none)"}`,
      "",
      "Any true failCriteria bans plain PASS. Soft degradations → PASS-DEGRADED; integrity failures → FAIL.",
      "",
      "```json",
      JSON.stringify({ failCriteria: fc, meta }, null, 2),
      "```",
      "",
    ].join("\n");
    await fs.writeFile(path.join(phaseDir, "JUDGE-VERIFY-REPORT.md"), md);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const phaseDir = args.find((a) => !a.startsWith("--"));
  const write = args.includes("--write");
  if (!phaseDir) {
    console.error("usage: judge-verify-report.mjs <phaseDir> [--write]");
    process.exit(1);
  }
  writeJudgeVerifyReport(phaseDir, { write }).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.verdict === "FAIL" ? 2 : 0);
  }).catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

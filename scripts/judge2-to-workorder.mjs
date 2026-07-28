#!/usr/bin/env node
// judge2-to-workorder.mjs — bridge Judge-2 named findings → Builder workOrderP0.
//
// The loop's Builder + strict-fix path historically read judge-defects.json workOrderP0.
// Judge-2 writes judge2/findings.named.json (and chrome-probe findings already named).
// This script is the mechanical handoff so 5d / velt-builder consume Judge-2 as authority.
//
// Usage:
//   node scripts/judge2-to-workorder.mjs <phaseDir> [--write]
// Exit 0 always (writes summary). Exit 2 when --write and demoBreaking P0 count > 0
// (so orchestrator can treat "Judge-2 found breakage" like a FAIL gate signal).

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function loadJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

function toWorkOrderRow(f, tier = "P0") {
  const mode = inferMode(f);
  return {
    issueKey: f.id || f.issueKey || "unnamed-chrome",
    issue: f.issue || f.id,
    blockId: f.blockId || "flow",
    state: f.state || "resting",
    tier,
    category: f.kind === "chrome" || f.detector === "judge2-chrome-probe" ? "chrome" : (f.category || "visual"),
    requiredMode: mode,
    detector: f.detector || "judge2",
    confidence: f.confidence || "high",
    attribution: f.attribution || "builder-error",
    named: f.named !== false,
    demoBreaking: !!f.demoBreaking || f.detector === "judge2-chrome-probe",
    evidence: f.evidence || {},
    source: "velt-judge-2",
  };
}

function inferMode(f) {
  const id = String(f.id || "");
  if (/host-wiring|page-mode|unregistered/i.test(id)) return "host-wiring";
  if (/structure|slot|wireframe|mount/i.test(id)) return "structure";
  if (/behavior|hover|focus|selected|drive/i.test(id) && /missing|not-driven|blocked-state/i.test(id)) return "behavior";
  return "style";
}

export async function judge2ToWorkOrder(phaseDir, { write = false } = {}) {
  const j2 = path.join(phaseDir, "judge2");
  const namedDoc = await loadJson(path.join(j2, "findings.named.json"));
  const report = await loadJson(path.join(j2, "report.json"));
  const probes = await loadJson(path.join(j2, "chrome-probes.json"));

  let findings = [];
  if (namedDoc?.findings?.length) findings = namedDoc.findings;
  else if (report?.namedFindings?.length) findings = report.namedFindings;
  else if (report?.findings?.length) {
    // Prefer already-named / chrome-probe rows if agent hasn't recorded yet
    findings = report.findings.filter((f) => f.named || f.demoBreaking || f.detector === "judge2-chrome-probe");
  }
  // Always union chrome-probe findings (already named) even if agent discarded elsewhere
  for (const f of probes?.findings || []) {
    if (!findings.some((x) => x.id === f.id && JSON.stringify(x.evidence || {}) === JSON.stringify(f.evidence || {}))) {
      findings.push(f);
    }
  }

  // Dedupe by issueKey+blockId
  const seen = new Set();
  const unique = [];
  for (const f of findings) {
    if (f.discard) continue;
    const key = `${f.id || f.issueKey}::${f.blockId || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
  }

  const workOrderP0 = unique
    .filter((f) => f.demoBreaking || f.detector === "judge2-chrome-probe" || f.confidence === "high" || f.named)
    .map((f) => toWorkOrderRow(f, "P0"));
  // Remaining named (non-demoBreaking medium) as P1
  const p0Keys = new Set(workOrderP0.map((r) => r.issueKey + "::" + r.blockId));
  const workOrderP1 = unique
    .filter((f) => !p0Keys.has(`${f.id || f.issueKey}::${f.blockId || ""}`))
    .map((f) => toWorkOrderRow(f, "P1"));

  const workOrder = [...workOrderP0, ...workOrderP1];
  const blocksDoc = await loadJson(path.join(phaseDir, "blocks.json")) || { blocks: [] };
  const blockIds = (blocksDoc.blocks || []).map((b) => b.id);
  const failingBlocks = new Set(workOrderP0.map((r) => r.blockId).filter(Boolean));

  const doc = {
    kind: "judge-defects",
    source: "velt-judge-2",
    emitter: "judge2-to-workorder.mjs",
    at: new Date().toISOString(),
    totals: {
      p0: workOrderP0.length,
      p1: workOrderP1.length,
      demoBreaking: workOrderP0.filter((r) => r.demoBreaking).length,
      plan: 0,
      builder: workOrderP0.length,
    },
    workOrderP0,
    workOrder,
    builderPackets: workOrderP0.slice(0, 12).map((r) => ({
      issueKey: r.issueKey,
      blockId: r.blockId,
      issue: r.issue,
      requiredMode: r.requiredMode,
      evidence: r.evidence,
    })),
    note: "Authority = velt-judge-2 (chromatic + chrome probes). Old composed-audit/emit path is not the loop judge.",
  };

  // Lightweight block-report patch so verdict-gate has something honest from Judge-2:
  // blocks that appear in P0 → FAIL disposition hint; others left as-is if report exists.
  const existingReport = await loadJson(path.join(phaseDir, "block-report.json")) || { blocks: {} };
  if (!existingReport.blocks) existingReport.blocks = {};
  for (const id of blockIds) {
    const prev = existingReport.blocks[id] || {};
    if (failingBlocks.has(id) || (failingBlocks.has("flow") && id === "flow")) {
      existingReport.blocks[id] = {
        ...prev,
        id,
        disposition: "FAIL",
        judge2: true,
        p0Count: workOrderP0.filter((r) => r.blockId === id || r.blockId === "flow").length,
      };
    } else if (!prev.disposition || prev.judge2) {
      // Only auto-PASS when Judge-2 found zero P0 globally (chrome clean + no named demoBreaking)
      if (workOrderP0.length === 0) {
        existingReport.blocks[id] = { ...prev, id, disposition: prev.disposition === "BLOCKED" || prev.disposition === "GAP" ? prev.disposition : "PASS", judge2: true };
      }
    }
  }
  existingReport.judge2 = {
    at: doc.at,
    p0: workOrderP0.length,
    demoBreaking: doc.totals.demoBreaking,
  };

  if (write) {
    await fs.writeFile(path.join(phaseDir, "judge-defects.json"), JSON.stringify(doc, null, 2) + "\n");
    await fs.writeFile(path.join(phaseDir, "block-report.json"), JSON.stringify(existingReport, null, 2) + "\n");
    const prompt = [
      `# Builder fix prompt (from velt-judge-2)`,
      ``,
      `P0 / demo-breaking: **${workOrderP0.length}**`,
      ``,
      ...workOrderP0.slice(0, 15).map((r, i) =>
        `${i + 1}. **${r.issueKey}** [\`${r.blockId}\`] mode=\`${r.requiredMode}\`\n` +
        `   ${r.issue}\n` +
        (r.evidence?.liveCrop ? `   live: \`${r.evidence.liveCrop}\`\n` : "")),
      ``,
      `Source: judge2/findings.named.json + chrome-probes.json via judge2-to-workorder.mjs`,
      ``,
    ].join("\n");
    await fs.writeFile(path.join(phaseDir, "builder-fix-prompt.md"), prompt);
  }

  return doc;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const phaseDir = args.find((a) => !a.startsWith("--"));
  const write = args.includes("--write");
  if (!phaseDir) {
    console.error("usage: judge2-to-workorder.mjs <phaseDir> [--write]");
    process.exit(1);
  }
  judge2ToWorkOrder(phaseDir, { write }).then((doc) => {
    console.log(JSON.stringify({
      p0: doc.totals.p0,
      demoBreaking: doc.totals.demoBreaking,
      wrote: write,
      out: write ? path.join(phaseDir, "judge-defects.json") : null,
    }, null, 2));
    process.exit(doc.totals.demoBreaking > 0 || doc.totals.p0 > 0 ? 2 : 0);
  }).catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

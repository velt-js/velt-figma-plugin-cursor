#!/usr/bin/env node
// judge2-record-findings.mjs — persist agent-named findings for judge-2.
//
// Usage:
//   node scripts/judge2-record-findings.mjs <phaseDir> --findings '<json-array>'
//   node scripts/judge2-record-findings.mjs <phaseDir> --file findings.json

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function loadJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const phaseDir = args.find((a, i) => !a.startsWith("--") && (i === 0 || !["--findings", "--file"].includes(args[i - 1])));
  if (!phaseDir) {
    console.error("usage: judge2-record-findings.mjs <phaseDir> --findings '<json>' | --file <path>");
    process.exit(1);
  }
  let findings = [];
  if (flag("--file")) findings = JSON.parse(await fs.readFile(flag("--file"), "utf8"));
  else if (flag("--findings")) findings = JSON.parse(flag("--findings"));
  else { console.error("need --findings or --file"); process.exit(1); }
  if (!Array.isArray(findings)) { console.error("findings must be an array"); process.exit(1); }

  const outDir = path.join(phaseDir, "judge2");
  await fs.mkdir(outDir, { recursive: true });
  const named = findings.filter((f) => !f.discard);
  const discarded = findings.filter((f) => f.discard);
  const doc = {
    at: new Date().toISOString(),
    namedCount: named.length,
    discardedCount: discarded.length,
    findings: named,
    discarded,
  };
  await fs.writeFile(path.join(outDir, "findings.named.json"), JSON.stringify(doc, null, 2) + "\n");

  // Patch report.json if present
  const report = await loadJson(path.join(outDir, "report.json"));
  if (report) {
    report.namedFindings = named;
    report.discardedFindings = discarded;
    report.namedAt = doc.at;
    await fs.writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  }

  const md = [
    `# Judge-2 named findings`,
    ``,
    `Named: **${named.length}** · Discarded: **${discarded.length}**`,
    ``,
    ...named.map((f, i) =>
      `${i + 1}. **${f.id}** — ${f.issue}\n` +
      `   - block: \`${f.blockId}\` · confidence: ${f.confidence || "?"}\n` +
      (f.evidence?.liveCrop ? `   - live: \`${f.evidence.liveCrop}\`\n` : "") +
      (f.evidence?.figmaCrop ? `   - figma: \`${f.evidence.figmaCrop}\`` : "")),
    ``,
  ].join("\n");
  await fs.writeFile(path.join(outDir, "FINDINGS.md"), md);

  // Bridge → Builder workOrderP0 (judge-defects.json + builder-fix-prompt.md)
  const { judge2ToWorkOrder } = await import("./judge2-to-workorder.mjs");
  const work = await judge2ToWorkOrder(phaseDir, { write: true });

  console.log(JSON.stringify({
    namedCount: named.length,
    discardedCount: discarded.length,
    p0: work.totals.p0,
    demoBreaking: work.totals.demoBreaking,
    out: path.join(outDir, "findings.named.json"),
    workOrder: path.join(phaseDir, "judge-defects.json"),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

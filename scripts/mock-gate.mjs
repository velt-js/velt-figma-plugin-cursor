#!/usr/bin/env node
// mock-gate.mjs — Live mock-vs-Figma/spec gate before plan-style (Phase 5).
//
// Scores each mocks/<blockId>.html against frames/<blockId>.png (and optional ref-spec/)
// via trials.mjs score-mock. Thresholds match trials.mjs:
//   - with ref-spec/<blockId>.png → gate on Δspec at MOCK_GATE_PCT (2%)
//   - frames only → gate on Δfigma at 15% (cross-rasterizer floor; see trials.mjs)
// Fail-closed above the applicable threshold.
//
// Usage: node scripts/mock-gate.mjs <phaseDir> [--pct <n>] [--scale 2]
//   --pct overrides the active threshold (spec or figma) for this run.
// Exit 0 = all mocks under gate; 2 = one or more failed / missing

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MOCK_GATE_PCT } from "./trials.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const FIGMA_ONLY_GATE_PCT = 15; // trials.mjs score-mock fallback when no ref-spec

async function exists(p) { return fs.access(p).then(() => true, () => false); }

async function main() {
  const [phaseDir, ...rest] = process.argv.slice(2);
  if (!phaseDir) { console.error("usage: mock-gate.mjs <phaseDir> [--pct <n>] [--scale 2]"); process.exit(1); }
  const flag = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? Number(rest[i + 1]) : d; };
  const pctOverride = flag("--pct", NaN);
  const scale = flag("--scale", 2);
  const mocksDir = path.join(phaseDir, "mocks");
  const framesDir = path.join(phaseDir, "frames");
  const refSpecDir = path.join(phaseDir, "ref-spec");
  if (!(await exists(mocksDir))) { console.error("✗ no mocks/ — structure builder must free-draw mocks first"); process.exit(2); }

  const mocks = (await fs.readdir(mocksDir)).filter((f) => f.endsWith(".html"));
  if (!mocks.length) { console.error("✗ mocks/ is empty"); process.exit(2); }

  // Prefer trials.mjs score-mock for each pair when frames exist
  const { spawnSync } = await import("node:child_process");
  const tmp = path.join(phaseDir, "mock-gate-scratch");
  await fs.mkdir(tmp, { recursive: true });
  let failed = 0, checked = 0;
  const report = { blocks: {}, at: new Date().toISOString() };

  for (const m of mocks.sort()) {
    const bid = m.replace(/\.html$/, "");
    const mock = path.join(mocksDir, m);
    const frame = path.join(framesDir, `${bid}.png`);
    const refSpec = path.join(refSpecDir, `${bid}.png`);
    if (!(await exists(frame))) {
      console.log(`⚠ ${bid}: no frames/${bid}.png — skip (cannot gate)`);
      report.blocks[bid] = { skipped: true, reason: "missing frame png" };
      continue;
    }
    const hasSpec = await exists(refSpec);
    const gatePct = Number.isFinite(pctOverride) ? pctOverride : (hasSpec ? MOCK_GATE_PCT : FIGMA_ONLY_GATE_PCT);
    const gateKind = hasSpec ? "spec" : "figma";
    checked++;
    const args = [
      path.join(SCRIPTS, "trials.mjs"), "score-mock", tmp,
      "--mock", mock, "--ref", frame, "--label", bid, "--group", "live-gate",
      "--selector", "#mock", "--scale", String(scale),
    ];
    if (hasSpec) args.push("--ref-spec", refSpec);
    const r = spawnSync("node", args, { encoding: "utf8" });
    const out = `${r.stdout || ""}\n${r.stderr || ""}`;
    // Prefer Δspec when present (the tight gate); else Δfigma
    const mSpec = /Δspec\s+([\d.]+)%/.exec(out);
    const mFigma = /Δfigma\s+([\d.]+)%/.exec(out);
    const specDiffPct = mSpec ? Number(mSpec[1]) : null;
    const figmaDiffPct = mFigma ? Number(mFigma[1]) : null;
    const diffPct = hasSpec ? (specDiffPct ?? figmaDiffPct) : figmaDiffPct;
    const pass = diffPct != null ? diffPct < gatePct : false;
    report.blocks[bid] = { pass, diffPct, specDiffPct, figmaDiffPct, gatePct, gateKind, exit: r.status };
    console.log(`${pass ? "✓" : "✗"} mock-gate ${bid}: Δ${gateKind} ${diffPct ?? "?"}% (gate <${gatePct}%)`);
    if (!pass) {
      if (r.status !== 0 && diffPct == null) console.log(`  ↳ score-mock failed:\n${out.trim().split("\n").slice(-8).join("\n")}`);
      failed++;
    }
  }

  report.gateNote = "Δspec uses MOCK_GATE_PCT (2%) when ref-spec/ exists; else Δfigma uses 15% (trials.mjs)";
  await fs.writeFile(path.join(phaseDir, "mock-gate.json"), JSON.stringify(report, null, 2) + "\n");
  if (!checked) { console.error("✗ mock-gate: no block had both mock+frame"); process.exit(2); }
  console.log(failed ? `✗ mock-gate FAILED: ${failed}/${checked}` : `✓ mock-gate: ${checked} mock(s) under their gate`);
  process.exit(failed ? 2 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });

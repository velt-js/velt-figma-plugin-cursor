#!/usr/bin/env node
// block-iter.mjs — the HARNESS-OWNED loop controller. The ≤N-iterations / ≤M-minutes / plateau /
// phase-soft-cap bounds used to live only in agent prompts — an LLM can't keep wall-clock, so a
// phase could run for hours. This script owns the loop state on disk: it counts iterations,
// stamps timestamps, detects plateau/oscillation from diff-counts + normalized-diff hashes, and
// WRITES the STUCK disposition / phase.remaining into block-report.json ITSELF when bounds hit.
// The orchestrator's only job is to call it every iteration and obey the exit code.
//
// Usage:
//   block-iter.mjs start <phaseDir> <blockId> [--budget strict|balanced|thorough]
//   block-iter.mjs record <phaseDir> <blockId> --diff-count N [--hash <normalizedDiffHash>]
//   block-iter.mjs check-phase <phaseDir> [--remaining id1,id2,...]
//   block-iter.mjs status <phaseDir> [blockId]
//
// Exit codes:
//   0 = CONTINUE (budget remains) / phase within soft-cap
//   4 = STOP — bounds hit: STUCK written for the block (record), or soft-cap reached (check-phase)
//   5 = ESCALATE — plateau detected, layer escalation budget available (once per block);
//       the next plateau or any hard bound → 4
//   1 = usage / error
//
// State: <phaseDir>/loop-state.json (append-per-attempt; survives interruption/resume).
// A retry is accepted only if the failing-diff count STRICTLY drops (forced improvement);
// a non-dropping attempt is "no-progress". Two consecutive no-progress (or a repeated /
// oscillating hash) = plateau. All caps come from --budget (default: balanced).

import { promises as fs } from "node:fs";
import path from "node:path";

const BUDGETS = {
  strict:   { maxBlockIters: 6,  maxBlockMinutes: 6,  maxPhaseMinutes: 60, graceMinutes: 15 },
  balanced: { maxBlockIters: 8,  maxBlockMinutes: 8,  maxPhaseMinutes: 75, graceMinutes: 15 },
  thorough: { maxBlockIters: 12, maxBlockMinutes: 10, maxPhaseMinutes: 90, graceMinutes: 20 },
};

const statePath = (dir) => path.join(dir, "loop-state.json");
const reportPath = (dir) => path.join(dir, "block-report.json");

async function loadJson(p, fallback) { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; } }
async function saveJson(p, obj) { await fs.writeFile(p, JSON.stringify(obj, null, 2)); }

async function loadState(dir) {
  const s = await loadJson(statePath(dir), null);
  return s || { budget: "balanced", caps: BUDGETS.balanced, phaseStartedAt: null, blocks: {} };
}

// merge a terminal disposition into block-report.json WITHOUT clobbering measured fields.
async function writeDisposition(dir, blockId, disposition, note) {
  const rp = reportPath(dir);
  const report = await loadJson(rp, { blocks: {} });
  report.blocks = report.blocks || {};
  report.blocks[blockId] = { ...(report.blocks[blockId] || {}), disposition, note, evidence: "loop-state.json" };
  await saveJson(rp, report);
}

function minutesSince(iso) { return (Date.now() - new Date(iso).getTime()) / 60000; }

async function cmdStart(dir, blockId, budget) {
  const state = await loadState(dir);
  if (budget) {
    if (!BUDGETS[budget]) { console.error(`✗ unknown --budget '${budget}' (strict|balanced|thorough)`); process.exit(1); }
    state.budget = budget; state.caps = BUDGETS[budget];
  }
  if (!state.phaseStartedAt) state.phaseStartedAt = new Date().toISOString();
  if (!state.blocks[blockId]) state.blocks[blockId] = { startedAt: new Date().toISOString(), attempts: [], escalated: false, stuck: false };
  await saveJson(statePath(dir), state);
  const b = state.blocks[blockId];
  console.log(`▶ block '${blockId}' — iteration ${b.attempts.length}/${state.caps.maxBlockIters}, budget=${state.budget} (≤${state.caps.maxBlockMinutes} min/block, phase soft-cap ${state.caps.maxPhaseMinutes} min)`);
}

async function cmdRecord(dir, blockId, diffCount, hash) {
  if (!Number.isFinite(diffCount) || diffCount < 0) { console.error("✗ --diff-count <N≥0> is required (the failing-diff / significant-region count of THIS attempt)"); process.exit(1); }
  const state = await loadState(dir);
  if (!state.blocks[blockId]) { console.error(`⚠ block '${blockId}' was never started — auto-starting now (call 'start' first next time)`); state.phaseStartedAt = state.phaseStartedAt || new Date().toISOString(); state.blocks[blockId] = { startedAt: new Date().toISOString(), attempts: [], escalated: false, stuck: false }; }
  const b = state.blocks[blockId];
  const prev = b.attempts[b.attempts.length - 1];
  const iter = b.attempts.length + 1;
  const attempt = { iter, t: new Date().toISOString(), diffCount, hash: hash || null };

  // ---- signals (computed BEFORE pushing, against history) ----
  const noProgress = prev ? diffCount >= prev.diffCount : false;   // strictly-drops rule
  const repeatHash = !!hash && b.attempts.some((a) => a.hash && a.hash === hash);
  const osc = !!hash && b.attempts.length >= 2 && b.attempts[b.attempts.length - 2].hash === hash; // A→B→A
  attempt.signals = { noProgress, repeatHash, oscillation: osc };
  b.attempts.push(attempt);

  const prevNoProgress = prev && prev.signals ? prev.signals.noProgress || prev.signals.repeatHash : false;
  const plateau = osc || repeatHash || (noProgress && prevNoProgress); // oscillation/repeat is immediate; else 2 consecutive no-progress
  const elapsedMin = minutesSince(b.startedAt);
  const boundsHit = iter >= state.caps.maxBlockIters || elapsedMin >= state.caps.maxBlockMinutes;
  const best = Math.min(...b.attempts.map((a) => a.diffCount));

  let verdict = "CONTINUE", exit = 0;
  if (boundsHit) {
    b.stuck = true; verdict = "STUCK"; exit = 4;
    await writeDisposition(dir, blockId, "STUCK", `harness bounds: ${iter} iterations / ${elapsedMin.toFixed(1)} min (caps ${state.caps.maxBlockIters}/${state.caps.maxBlockMinutes}); best residual diffCount=${best}; signals=${JSON.stringify(attempt.signals)}`);
  } else if (plateau) {
    const sig = osc ? "oscillation (A→B→A hash)" : repeatHash ? "repeated normalized-diff hash" : "2 consecutive no-progress attempts";
    if (!b.escalated) { b.escalated = true; verdict = "ESCALATE"; exit = 5; }
    else {
      b.stuck = true; verdict = "STUCK"; exit = 4;
      await writeDisposition(dir, blockId, "STUCK", `plateau after layer escalation: ${sig} at iteration ${iter}; best residual diffCount=${best}`);
    }
  }
  await saveJson(statePath(dir), state);

  const left = `${state.caps.maxBlockIters - iter} iters / ${(state.caps.maxBlockMinutes - elapsedMin).toFixed(1)} min left`;
  if (verdict === "CONTINUE") console.log(`● ${blockId} iter ${iter}: diffCount=${diffCount}${noProgress ? " (NO-PROGRESS — must strictly drop)" : ""} — CONTINUE (${left})`);
  else if (verdict === "ESCALATE") console.log(`▲ ${blockId} iter ${iter}: PLATEAU — escalate the layer ONCE per guide/02-decision-tree.md, then keep iterating (retry budget continues; next plateau = STUCK)`);
  else console.log(`■ ${blockId} iter ${iter}: STUCK written to block-report.json — advance to the next block (do NOT keep iterating this one)`);
  process.exit(exit);
}

async function cmdCheckPhase(dir, remaining) {
  const state = await loadState(dir);
  if (!state.phaseStartedAt) { console.log("phase not started"); process.exit(0); }
  const elapsed = minutesSince(state.phaseStartedAt);
  if (elapsed < state.caps.maxPhaseMinutes) {
    console.log(`phase ${elapsed.toFixed(0)}/${state.caps.maxPhaseMinutes} min — CONTINUE starting new blocks`);
    process.exit(0);
  }
  if (remaining && remaining.length) {
    const rp = reportPath(dir);
    const report = await loadJson(rp, { blocks: {} });
    report.phase = { softCapReached: true, remaining };
    await saveJson(rp, report);
    console.log(`■ phase soft-cap (${elapsed.toFixed(0)} ≥ ${state.caps.maxPhaseMinutes} min): ${remaining.length} un-started block(s) written to report.phase.remaining`);
  } else {
    console.log(`■ phase soft-cap reached (${elapsed.toFixed(0)} ≥ ${state.caps.maxPhaseMinutes} min): finish the IN-FLIGHT block within the ~${state.caps.graceMinutes} min grace, do NOT start new blocks; re-run with --remaining <ids> to record un-started blocks`);
  }
  process.exit(4);
}

async function cmdStatus(dir, blockId) {
  const state = await loadState(dir);
  if (blockId) { console.log(JSON.stringify(state.blocks[blockId] || null, null, 2)); return; }
  const rows = Object.entries(state.blocks).map(([id, b]) => `  ${id}: ${b.attempts.length} attempts, best=${b.attempts.length ? Math.min(...b.attempts.map((a) => a.diffCount)) : "-"}, escalated=${b.escalated}, stuck=${b.stuck}`);
  console.log(`budget=${state.budget} phaseStarted=${state.phaseStartedAt} (${state.phaseStartedAt ? minutesSince(state.phaseStartedAt).toFixed(0) : "-"} min)\n${rows.join("\n") || "  (no blocks)"}`);
}

async function main() {
  const [cmd, dir, ...rest] = process.argv.slice(2);
  const flag = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  if (!cmd || !dir) { console.error("usage: block-iter.mjs start|record|check-phase|status <phaseDir> [blockId] [flags]"); process.exit(1); }
  await fs.mkdir(dir, { recursive: true });
  if (cmd === "start") await cmdStart(dir, rest[0], flag("--budget"));
  else if (cmd === "record") await cmdRecord(dir, rest[0], +flag("--diff-count", "NaN"), flag("--hash"));
  else if (cmd === "check-phase") await cmdCheckPhase(dir, (flag("--remaining", "") || "").split(",").map((s) => s.trim()).filter(Boolean));
  else if (cmd === "status") await cmdStatus(dir, rest[0]);
  else { console.error(`✗ unknown command '${cmd}'`); process.exit(1); }
}

main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

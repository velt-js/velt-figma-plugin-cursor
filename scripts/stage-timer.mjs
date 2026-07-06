#!/usr/bin/env node
// stage-timer.mjs — the MECHANICAL clock for NON-BUILD stages (plan / brief-authoring / report).
// The first --auto cloud run proved the lesson at full strength: every stage bounded only by prose
// sprawls without limit — the planner ran ~80 min against a "~10-15 min" prompt box, then the
// orchestrator's own brief-finishing ran 50+ min more, and the run died having built NOTHING.
// block-iter.mjs already mechanized the build loop's bounds; this is the same discipline for the
// stages upstream of it. A stopped stage is not a failure — it means "emit what you have NOW, tag
// the rest `assumed`, and move on"; the loop's own gates catch anything the partial plan got wrong.
//
// Usage:
//   stage-timer.mjs start  <phaseDir> <stage> [--cap-min N] [--first-phase]
//   stage-timer.mjs check  <phaseDir> <stage>     # exit 0 = CONTINUE (prints remaining) · 4 = STOP
//   stage-timer.mjs end    <phaseDir> <stage>     # records the duration, prints it
//   stage-timer.mjs status <phaseDir>
//
// Default caps (active minutes; env stalls from loop-state.json are EXCLUDED, same as block-iter):
//   plan 20 · briefs 15 · report 10 · anything else 15.
// --first-phase applies a documented 1.5x multiplier (a no-memory first run legitimately reads more).
// Exit-code contract mirrors block-iter: the orchestrator calls `check` between its own steps and
// polls it while a stage subagent runs; on 4 it terminates/wraps the stage and PROCEEDS — it never
// waits out a sprawl. Callers never keep time themselves. All timestamps UTC.

import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_CAPS = { plan: 20, briefs: 15, report: 10 };
const FALLBACK_CAP = 15;
const FIRST_PHASE_MULTIPLIER = 1.5;

const statePath = (dir) => path.join(dir, "stage-state.json");
const nowIso = () => new Date().toISOString();

async function loadJson(p, fallback) { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; } }
async function save(dir, s) { await fs.writeFile(statePath(dir), JSON.stringify(s, null, 2)); }

// active minutes since startIso, excluding env-stall windows recorded by block-iter (loop-state.json)
async function activeMinutesSince(dir, startIso) {
  const start = new Date(startIso).getTime(), now = Date.now();
  const loop = await loadJson(path.join(dir, "loop-state.json"), null);
  let stalled = 0;
  for (const s of (loop && loop.stalls) || []) {
    const from = new Date(s.from).getTime();
    const to = s.to ? new Date(s.to).getTime() : now;
    stalled += Math.max(0, Math.min(now, to) - Math.max(start, from));
  }
  return Math.max(0, now - start - stalled) / 60000;
}

async function main() {
  const [cmd, dir, stage, ...rest] = process.argv.slice(2);
  const flag = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  if (!cmd || !dir || (cmd !== "status" && !stage)) {
    console.error("usage: stage-timer.mjs start|check|end <phaseDir> <stage> [--cap-min N] [--first-phase] | status <phaseDir>");
    process.exit(1);
  }
  await fs.mkdir(dir, { recursive: true });
  const state = await loadJson(statePath(dir), { stages: {} });
  state.stages = state.stages || {};

  if (cmd === "start") {
    let cap = +flag("--cap-min", "0") || DEFAULT_CAPS[stage] || FALLBACK_CAP;
    if (rest.includes("--first-phase")) cap = Math.round(cap * FIRST_PHASE_MULTIPLIER);
    // idempotent re-start of an OPEN stage keeps its clock (a re-invoked orchestrator must not reset it)
    const existing = state.stages[stage];
    if (existing && !existing.endedAt) {
      console.log(`▶ stage '${stage}' already running since ${existing.startedAt} (cap ${existing.capMin} active min) — clock NOT reset`);
      process.exit(0);
    }
    // WRITE-ONCE (resume clobber guard): a COMPLETED stage is finalized state — a resumed run once
    // reset the plan clock and re-dispatched a planner whose work was already done. Redoing a
    // finished stage is only ever intentional: pass --force.
    if (existing && existing.endedAt && !rest.includes("--force")) {
      console.error(`✗ stage '${stage}' already COMPLETED (${existing.durationMin} min, ended ${existing.endedAt}) — a resumed run must not redo it.`);
      console.error("  Run `node scripts/resume-check.mjs check <phaseDir>` and obey its verdict, or pass --force to intentionally re-run this stage.");
      process.exit(5);
    }
    if (existing && existing.endedAt) console.error(`⚠ --force: re-running completed stage '${stage}' (prior duration ${existing.durationMin} min is overwritten)`);
    state.stages[stage] = { startedAt: nowIso(), capMin: cap, endedAt: null, stoppedByTimer: false };
    await save(dir, state);
    console.log(`▶ stage '${stage}' started — cap ${cap} active min (env stalls excluded). Poll: stage-timer.mjs check ${dir} ${stage}`);
    process.exit(0);
  }

  const s = state.stages[stage];
  if (cmd === "check") {
    if (!s) { console.error(`✗ stage '${stage}' was never started`); process.exit(1); }
    if (s.endedAt) { console.log(`stage '${stage}' already ended (${s.durationMin} min)`); process.exit(0); }
    const elapsed = await activeMinutesSince(dir, s.startedAt);
    if (elapsed < s.capMin) {
      console.log(`stage '${stage}': ${elapsed.toFixed(1)}/${s.capMin} active min — CONTINUE`);
      process.exit(0);
    }
    s.stoppedByTimer = true;
    await save(dir, state);
    console.log(`■ stage '${stage}' HIT ITS CAP (${elapsed.toFixed(1)} ≥ ${s.capMin} active min) — STOP NOW: emit the stage's output with what exists, tag unverified items 'assumed', and hand back. Do NOT keep refining; the loop's gates catch what the partial output got wrong.`);
    process.exit(4);
  }

  if (cmd === "end") {
    if (!s) { console.error(`✗ stage '${stage}' was never started`); process.exit(1); }
    if (!s.endedAt) {
      s.endedAt = nowIso();
      s.durationMin = +(await activeMinutesSince(dir, s.startedAt)).toFixed(1);
      await save(dir, state);
    }
    console.log(`✓ stage '${stage}' ended — ${s.durationMin} active min (cap ${s.capMin}${s.stoppedByTimer ? ", STOPPED BY TIMER" : ""})`);
    process.exit(0);
  }

  if (cmd === "status") {
    for (const [name, st] of Object.entries(state.stages)) {
      const dur = st.endedAt ? `${st.durationMin} min` : `${(await activeMinutesSince(dir, st.startedAt)).toFixed(1)} min RUNNING`;
      console.log(`  ${name}: ${dur} / cap ${st.capMin}${st.stoppedByTimer ? "  ■ timer-stopped" : ""}`);
    }
    if (!Object.keys(state.stages).length) console.log("  (no stages)");
    process.exit(0);
  }

  console.error(`✗ unknown command '${cmd}'`);
  process.exit(1);
}

main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

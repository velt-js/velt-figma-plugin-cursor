#!/usr/bin/env node
// resume-check.mjs — the MECHANICAL RESUME GATE + RUN LOCK. Two failures from the first
// claude-cloud run, both in the "prose resume" class:
//   * A resumed orchestrator ignored a complete journal, re-ran preflight, RE-ENUMERATED blocks
//     (clobbering the finalized blocks.json + fixture URLs), reset the stage timer, and
//     re-dispatched the planner — ~40 min of redundant work + a manual git-restore, on a phase
//     that was one judge audit away from done. The SAME journal had resumed cleanly one
//     interruption earlier: resume correctness was prompt/timing luck, not a function of state.
//   * Two consecutive resumed processes STOOD DOWN after seeing their own `/velt-customize` string
//     in `ps` output and inferring a rival orchestrator. Even an explicit prose warning ("that
//     process is you") did not prevent it. Process identity cannot be an LLM inference.
//
// This script makes both decisions mechanical. It is the FIRST action of every run/resume,
// immediately after phase-init.mjs prints the phaseDir:
//
//   node scripts/resume-check.mjs check <phaseDir> [--claim] [--pid <ownerPid>]
//        (--pid $PPID from the invoking shell records the long-lived agent process as the lock
//         owner — without it the lock holds the transient shell's pid and goes stale fast)
//        exit 0 = FRESH   — no meaningful prior state; run full setup (preflight → enumerate → plan)
//        exit 2 = RESUME  — prior state exists; stdout JSON names the stage to re-enter and what
//                           MUST NOT be redone. Obey it verbatim (like a block-iter exit code).
//        exit 3 = CONFLICT— a LIVE rival orchestrator holds the run lock; HALT and surface its PID.
//   node scripts/resume-check.mjs release <phaseDir>
//        release the run lock at phase stop (wrap-up step, after reports are written).
//
// --claim writes <phaseDir>/.run.lock {pid, ppid, host, startedAt}. Liveness is checked with
// kill(pid, 0) on the SAME host — a lock whose process is dead (or from another host, i.e. a
// previous container) is STALE and silently reclaimed. `ps`-string matching is NEVER evidence:
// if this script exits 0/2 you proceed unconditionally, whatever `ps` appears to show.
//
// The verdict is derived from the phase artifacts alone (no journal parsing, no trust in prose):
//   no blocks.json                                → FRESH
//   blocks.json, no connect-map/plan              → RESUME plan   (re-dispatch planner for FILLS
//                                                    only — never re-enumerate, never re-preflight
//                                                    beyond env-services restore)
//   plan exists, briefs have _todo leftovers      → RESUME briefs (one bounded completion pass)
//   briefs clean, blocks unaccounted in report    → RESUME build  (remaining block ids listed)
//   every block accounted (built or dispositioned)→ RESUME audit  (final judge audit → gate →
//                                                    reports/handoff; NOTHING is rebuilt)

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const loadJson = async (p, fallback) => { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; } };
const exists = (p) => fs.access(p).then(() => true, () => false);

function findTodos(obj, out = []) {
  if (Array.isArray(obj)) obj.forEach((v) => findTodos(v, out));
  else if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("_todo")) out.push(k);
    else findTodos(v, out);
  }
  return out;
}

// EPERM = the process EXISTS but belongs to another user — that is "alive" (kill(1,0) as an
// unprivileged user throws EPERM for launchd; only ESRCH means dead).
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

async function lockCheck(dir, claim, claimPid) {
  const lockPath = path.join(dir, ".run.lock");
  const lock = await loadJson(lockPath, null);
  if (lock && lock.pid) {
    const sameHost = lock.host === os.hostname();
    const mine = lock.pid === process.pid || lock.pid === process.ppid || lock.ppid === process.ppid
      || (claimPid && lock.pid === claimPid);
    if (sameHost && !mine && pidAlive(lock.pid)) {
      console.error(`✗ CONFLICT: a LIVE orchestrator holds this phase (pid ${lock.pid} on ${lock.host}, since ${lock.startedAt}).`);
      console.error(`  HALT and surface this. If that process is genuinely dead-but-listed, remove ${lockPath} manually.`);
      return { conflict: true };
    }
    if (!sameHost) console.error(`⚠ stale run lock from another host ('${lock.host}' — a previous container); reclaiming`);
    else if (!mine) console.error(`⚠ stale run lock (pid ${lock.pid} is dead); reclaiming`);
  }
  if (claim) {
    const pid = claimPid || process.ppid || process.pid;
    await fs.writeFile(lockPath, JSON.stringify({ pid, ppid: process.ppid, host: os.hostname(), startedAt: new Date().toISOString() }, null, 2));
    console.error(`✓ run lock claimed (pid ${pid} @ ${os.hostname()})${claimPid ? "" : " — pass --pid $PPID for a longer-lived owner pid"}`);
  }
  return { conflict: false };
}

async function verdict(dir) {
  const blocksJ = await loadJson(path.join(dir, "blocks.json"), null);
  const blocks = (blocksJ && blocksJ.blocks) || [];
  if (!blocks.length) return { verdict: "FRESH", why: "no blocks.json — this phase has no prior state" };

  const doNotRedo = [
    "re-run enumerate-blocks (blocks.json is FINALIZED — re-enumeration clobbers annotations + fixture URLs; it now refuses without --force)",
    "re-run figma-extract if designSpec.json exists",
    "reset stage-timer stages that already ended",
  ];
  const briefsDir = path.join(dir, "briefs");
  // TWO-PHASE PLANNING ladder (plan-structure → build-structure → dom-snapshot → plan-style →
  // build-style → audit). Detected by plan-structure.json — a run that died after the snapshot
  // must NOT re-plan structure; each artifact marks its stage DONE.
  const twoPhase = await exists(path.join(dir, "plan-structure.json"));
  if (twoPhase) {
    const snapDir = path.join(dir, "dom-snapshot");
    const snapExists = (await fs.readdir(snapDir).catch(() => [])).some((f) => f.endsWith(".json"));
    const stylePlanExists = await exists(path.join(dir, "plan-style.json"));
    if (!snapExists) {
      return { verdict: "RESUME", stage: "build-structure", blocks: blocks.length,
        instruction: "plan-structure.json is DONE — restore env services, re-enter the STRUCTURE build (builder mode=structure) for any family whose skeleton isn't rendering, then run dom-snapshot.mjs (5a2). NEVER re-plan structure.",
        doNotRedo: [...doNotRedo, "re-dispatch the structure planner (plan-structure.json exists)"] };
    }
    if (!stylePlanExists) {
      return { verdict: "RESUME", stage: "plan-style", blocks: blocks.length,
        instruction: "structure build + dom-snapshot are DONE — restore env services, run brief-scaffold --style --from-snapshot if briefs aren't style-enriched, then dispatch the STYLE planner to fill the style briefs + emit plan-style.json. NEVER re-plan structure or re-snapshot.",
        doNotRedo: [...doNotRedo, "re-dispatch the structure planner", "re-run the structure build or dom-snapshot (snapshots exist)"] };
    }
    // plan-style exists → fall through to the build/audit accounting below (build = build-style + fixes)
  }
  const planExists = twoPhase || (await exists(path.join(dir, "connect-map.json"))) || (await exists(path.join(dir, "plan.json")));
  if (!planExists) {
    return { verdict: "RESUME", stage: "plan", blocks: blocks.length,
      instruction: "restore env services (dev server / backend / browser / proxy per the journal), then re-dispatch the planner to FILL the scaffolded briefs only",
      doNotRedo };
  }
  // briefs state: any probes.json missing or carrying _todo leftovers?
  let unfilled = 0;
  for (const b of blocks) {
    const brief = await loadJson(path.join(briefsDir, `${b.id}.probes.json`), null);
    if (!brief || findTodos(brief).length) unfilled++;
  }
  if (unfilled) {
    return { verdict: "RESUME", stage: "briefs", unfilledBriefs: unfilled,
      instruction: "ONE bounded completion pass filling the remaining _todo fields (stage-timer 'briefs'); the plan/connect-map are DONE",
      doNotRedo: [...doNotRedo, "re-dispatch a full planning pass (connect-map.json exists)"] };
  }
  const report = await loadJson(path.join(dir, "block-report.json"), { blocks: {} });
  const accounted = (id) => { const e = (report.blocks || {})[id]; return !!(e && (e.built || e.disposition)); };
  const remaining = blocks.map((b) => b.id).filter((id) => !accounted(id));
  // IN-FLIGHT ORPHAN detection (#5b): a block `start`ed in loop-state.json but never accounted in
  // block-report AND not marked stuck = its builder/judge died mid-flight (process killed on a
  // usage-limit, or a prior orchestrator ended its turn mid-dispatch). These must be RE-DISPATCHED
  // fresh, not merely "re-entered" — a prior run left a builder orphaned 75 min because resume
  // restored state but never relaunched the worker.
  const loopState = await loadJson(path.join(dir, "loop-state.json"), { blocks: {} });
  const inflightOrphans = Object.keys(loopState.blocks || {}).filter(
    (id) => !accounted(id) && !(loopState.blocks[id] && loopState.blocks[id].stuck));
  if (remaining.length) {
    return { verdict: "RESUME", stage: "build", remainingBlocks: remaining, inflightOrphans,
      instruction: `restore env services, then re-enter the build loop at the ${remaining.length} unaccounted block(s) — everything already built/measured/dispositioned in block-report.json is FINAL (write-once).${inflightOrphans.length ? ` RE-DISPATCH the ${inflightOrphans.length} IN-FLIGHT ORPHAN(s) [${inflightOrphans.join(", ")}] FRESH from the journal (their worker died mid-flight) — do NOT just wait.` : ""}`,
      doNotRedo: [...doNotRedo, "re-plan or refill briefs (lint is clean)", "rebuild/re-measure blocks already accounted in block-report.json"] };
  }
  return { verdict: "RESUME", stage: "audit", blocks: blocks.length,
    instruction: "restore env services, then go STRAIGHT to the final judge audit → verdict-gate-blocks → reports/handoff. Nothing is rebuilt.",
    doNotRedo: [...doNotRedo, "re-plan, refill briefs, or rebuild any block (all accounted)"] };
}

async function main() {
  const [cmd, dirArg, ...rest] = process.argv.slice(2);
  if (!cmd || !dirArg) { console.error("usage: resume-check.mjs check <phaseDir> [--claim] | release <phaseDir>"); process.exit(1); }
  const dir = path.resolve(dirArg);
  if (cmd === "release") {
    await fs.rm(path.join(dir, ".run.lock"), { force: true });
    console.log("✓ run lock released");
    return;
  }
  if (cmd !== "check") { console.error(`✗ unknown command '${cmd}'`); process.exit(1); }
  await fs.mkdir(dir, { recursive: true });
  const pidIdx = rest.indexOf("--pid");
  const claimPid = pidIdx >= 0 ? +rest[pidIdx + 1] || null : null;
  const { conflict } = await lockCheck(dir, rest.includes("--claim"), claimPid);
  if (conflict) process.exit(3);
  const v = await verdict(dir);
  console.log(JSON.stringify(v, null, 2));
  if (v.verdict === "FRESH") { console.error("→ FRESH: run full setup (preflight → enumerate → plan)"); process.exit(0); }
  console.error(`→ RESUME at stage '${v.stage}' — obey the instruction verbatim; the doNotRedo list is not advisory`);
  process.exit(2);
}

main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

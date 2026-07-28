#!/usr/bin/env node
// block-iter.mjs — the HARNESS-OWNED loop controller. The ≤N-iterations / ≤M-minutes / plateau /
// phase-soft-cap bounds used to live only in agent prompts — an LLM can't keep wall-clock, so a
// phase could run for hours. This script owns the loop state on disk: it counts iterations,
// stamps timestamps, detects plateau/oscillation from diff-counts + normalized-diff hashes, and
// WRITES the STUCK disposition / phase.remaining into block-report.json ITSELF when bounds hit.
// The orchestrator's only job is to call it every iteration and obey the exit code.
//
// v2 hardening (from the privado/harvey run autopsies):
//  * The normalized diff hash is COMPUTED HERE from `git diff` of the customization dir — agents
//    used to pass synthetic strings as --hash, which silently disabled repeat/oscillation detection
//    (privado's attach-glyph A→B→A was never caught). --hash is now only a fallback when git is
//    unavailable, and a warning says so.
//  * ENV STALLS are excluded from every elapsed-minutes calculation. `pause`/`resume` bracket an
//    environment outage (dev-server death, dead agent, session-limit pause); both runs charged
//    ~1.5h of env dead-time against the build budget, tripping soft-caps on non-build time.
//  * WINDOW RESET (B4): `start` on a block whose last activity is >20 min old opens a new work
//    window — the minute budget restarts, attempt history survives. Harvey's block objects were
//    never reset across passes, so STUCK notes reported garbage ("4 iterations / 370.7 min").
//  * Minute caps rescaled so ITERATIONS are the primary bound: the old 8-min block cap was
//    shorter than one builder round-trip (~13 min), stamping false-STUCK around clean work.
//  * All timestamps are UTC ISO (B1). Agents never do time math — this script prints elapsed.
//
// Usage:
//   block-iter.mjs start <phaseDir> <blockId> [--budget strict|balanced|thorough]
//   block-iter.mjs record <phaseDir> <blockId> --diff-count N [--hash <fallbackHash>] [--src <dir>]
//   block-iter.mjs pause <phaseDir> [--reason "<cause>"]   # env outage OR script/pipeline repair —
//        BOTH freeze every budget. Bracket measure-script fixes with pause/resume too: unbracketed
//        repair time false-STUCKed healthy blocks in two runs.
//   block-iter.mjs resume <phaseDir>
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
// oscillating hash) = plateau. All caps come from --budget (DEFAULT: thorough — grind each block
// until it measures CLEAN or genuinely plateaus, the STRICT polish behavior the user wants; pass
// --budget strict|balanced for a faster/rougher pass that STUCKs early).

import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { obsEvent } from "./obs.mjs";

const BUDGETS = {
  // maxBlockMinutes counts ACTIVE minutes (stalls excluded) and must exceed one full
  // builder round-trip — iterations are the primary bound, minutes the backstop.
  strict:   { maxBlockIters: 6,  maxBlockMinutes: 15, maxPhaseMinutes: 60,  graceMinutes: 15 },
  balanced: { maxBlockIters: 8,  maxBlockMinutes: 20, maxPhaseMinutes: 90,  graceMinutes: 15 },
  thorough: { maxBlockIters: 12, maxBlockMinutes: 30, maxPhaseMinutes: 120, graceMinutes: 20 },
};
const WINDOW_GAP_MINUTES = 20;   // start() on a block idle longer than this opens a fresh work window

const statePath = (dir) => path.join(dir, "loop-state.json");
const reportPath = (dir) => path.join(dir, "block-report.json");

async function loadJson(p, fallback) { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; } }
// atomic write (tmp + rename) so a concurrent reader never sees a torn file
async function saveJson(p, obj) {
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, p);
}

async function loadState(dir) {
  const s = await loadJson(statePath(dir), null);
  const state = s || { budget: "thorough", caps: BUDGETS.thorough, phaseStartedAt: null, blocks: {}, stalls: [] };
  state.stalls = state.stalls || [];
  return state;
}

// merge a terminal disposition into block-report.json WITHOUT clobbering measured fields.
// block-report.json is also written by report-block.mjs — serialize the read-modify-write with
// the same mkdir lock (atomic on every platform) so the two writers never clobber each other.
async function writeDisposition(dir, blockId, disposition, note) {
  const lock = path.join(dir, ".block-report.lock");
  const deadline = Date.now() + 15000;
  for (;;) {
    try { await fs.mkdir(lock); break; }
    catch { if (Date.now() > deadline) throw new Error("timed out waiting for block-report.json lock"); await new Promise((r) => setTimeout(r, 120)); }
  }
  try {
    const rp = reportPath(dir);
    const report = await loadJson(rp, { blocks: {} });
    report.blocks = report.blocks || {};
    // WRITE-ONCE: an existing DIFFERENT terminal disposition (BLOCKED/GAP, recorded with evidence)
    // is finalized state — never silently replace it with STUCK (a resume once clobbered finalized
    // entries this way). Refreshing the note of the SAME disposition is fine.
    const existing = report.blocks[blockId];
    const d = existing && typeof existing.disposition === "string" ? existing.disposition.toUpperCase() : null;
    if (d && d !== disposition.toUpperCase()) {
      console.error(`⚠ block '${blockId}' already finalized as ${d} — NOT overwriting with ${disposition} (loop bookkeeping still recorded in loop-state.json)`);
      return;
    }
    report.blocks[blockId] = { ...(existing || {}), disposition, note, evidence: "loop-state.json" };
    await saveJson(rp, report);
  } finally { await fs.rmdir(lock).catch(() => {}); }
}

// ---- time (UTC everywhere; env stalls excluded) ----
const nowIso = () => new Date().toISOString();
function overlapMs(aFrom, aTo, bFrom, bTo) {
  const from = Math.max(aFrom, bFrom), to = Math.min(aTo, bTo);
  return Math.max(0, to - from);
}
// active minutes between startIso and now, minus every stall window's overlap.
function activeMinutesSince(startIso, stalls) {
  const start = new Date(startIso).getTime(), now = Date.now();
  let stalled = 0;
  for (const s of stalls || []) {
    const from = new Date(s.from).getTime();
    const to = s.to ? new Date(s.to).getTime() : now;   // open stall counts up to now
    stalled += overlapMs(start, now, from, to);
  }
  return Math.max(0, (now - start - stalled)) / 60000;
}
const openStall = (state) => (state.stalls || []).find((s) => !s.to) || null;

// ---- normalized diff hash, computed from the working tree (never trusted from an agent) ----
// Take the changed hunk lines of the customization dir, strip whitespace/blank/comment-only noise,
// sort (order-independent), sha256. Cosmetic churn hashes equal; a genuinely different patch differs.
function computeNormalizedDiffHash(srcDir) {
  const target = srcDir || "components/velt/ui-customization";
  let out;
  try {
    out = execFileSync("git", ["diff", "HEAD", "--", target], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }).toString();
    // include untracked files (a fresh *Wf.tsx is invisible to `git diff HEAD` alone)
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", target], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    for (const f of untracked.split("\n").filter(Boolean)) {
      try { out += "\nNEWFILE:" + f + "\n" + execFileSync("cat", [f], { cwd: process.cwd() }).toString(); } catch { /* skip unreadable */ }
    }
  } catch { return null; }   // not a git repo / git missing → caller may fall back to --hash
  const lines = out.split("\n")
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l) || l.startsWith("NEWFILE:"))
    .map((l) => l.replace(/\s+/g, ""))
    .filter((l) => l.length > 1 && !/^[+-]\/\//.test(l) && !/^[+-]\/?\*/.test(l))
    .sort();
  if (!lines.length) return "empty-diff";
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

async function cmdStart(dir, blockId, budget) {
  const state = await loadState(dir);
  if (budget) {
    if (!BUDGETS[budget]) { console.error(`✗ unknown --budget '${budget}' (strict|balanced|thorough)`); process.exit(1); }
    state.budget = budget; state.caps = BUDGETS[budget];
  }
  if (!state.phaseStartedAt) state.phaseStartedAt = nowIso();
  if (!state.blocks[blockId]) {
    state.blocks[blockId] = { startedAt: nowIso(), windowStartedAt: nowIso(), windows: 1, attempts: [], escalated: false, stuck: false };
  } else {
    // WINDOW RESET (B4): re-entering a block after a long gap (new pass / after an outage) restarts
    // the minute budget; attempts + escalation history survive. Cumulative wall across passes is
    // exactly the corruption harvey's report showed ("4 iterations / 370.7 min").
    const b = state.blocks[blockId];
    const last = b.attempts.length ? b.attempts[b.attempts.length - 1].t : (b.windowStartedAt || b.startedAt);
    if (activeMinutesSince(last, state.stalls) > WINDOW_GAP_MINUTES && !b.stuck) {
      b.windowStartedAt = nowIso();
      b.windows = (b.windows || 1) + 1;
      console.log(`↻ block '${blockId}': idle > ${WINDOW_GAP_MINUTES} min — new work window (#${b.windows}); minute budget restarted, ${b.attempts.length} prior attempt(s) kept`);
    }
  }
  await saveJson(statePath(dir), state);
  const b = state.blocks[blockId];
  obsEvent(dir, { type: "block.start", src: "block-iter", stage: "fix", blockId, summary: `block '${blockId}' entered — ${b.attempts.length} prior attempt(s), window #${b.windows || 1}, budget=${state.budget}`, data: { priorAttempts: b.attempts.length, window: b.windows || 1, budget: state.budget } });
  console.log(`▶ block '${blockId}' — iteration ${b.attempts.length}/${state.caps.maxBlockIters}, budget=${state.budget} (≤${state.caps.maxBlockMinutes} active min/block window, phase soft-cap ${state.caps.maxPhaseMinutes} active min)`);
}

async function cmdRecord(dir, blockId, diffCount, fallbackHash, srcDir, maxAttemptsRaw) {
  if (!Number.isFinite(diffCount) || diffCount < 0) { console.error("✗ --diff-count <N≥0> is required (the failing-diff / significant-region count of THIS attempt)"); process.exit(1); }
  // --max-attempts N: the BOUNDED-FIX cap (new one-shot→judge→fix flow). When set and hit, the block
  // is BLOCKER-listed (disposition BLOCKED) rather than STUCK, and NO layer-escalation happens — 2 tries, then blocker.
  const maxAttempts = maxAttemptsRaw != null && Number.isFinite(+maxAttemptsRaw) && +maxAttemptsRaw > 0 ? +maxAttemptsRaw : null;
  const state = await loadState(dir);
  if (openStall(state)) console.error(`⚠ an env stall is OPEN (${openStall(state).reason || "no reason"}) — run 'block-iter.mjs resume ${dir}' once the environment is healthy; recording anyway`);
  if (!state.blocks[blockId]) { console.error(`⚠ block '${blockId}' was never started — auto-starting now (call 'start' first next time)`); state.phaseStartedAt = state.phaseStartedAt || nowIso(); state.blocks[blockId] = { startedAt: nowIso(), windowStartedAt: nowIso(), windows: 1, attempts: [], escalated: false, stuck: false }; }
  const b = state.blocks[blockId];
  const prev = b.attempts[b.attempts.length - 1];
  const iter = b.attempts.length + 1;

  // hash is computed from the working tree; an agent-passed --hash is only a fallback.
  let hash = computeNormalizedDiffHash(srcDir);
  if (!hash && fallbackHash) { hash = fallbackHash; console.error("⚠ git diff unavailable — using the agent-supplied --hash fallback (repeat/oscillation detection is weaker)"); }
  const attempt = { iter, t: nowIso(), diffCount, hash: hash || null };

  // ---- signals (computed BEFORE pushing, against history) ----
  const noProgress = prev ? diffCount >= prev.diffCount : false;   // strictly-drops rule
  const repeatHash = !!hash && hash !== "empty-diff" && b.attempts.some((a) => a.hash && a.hash === hash);
  const osc = !!hash && hash !== "empty-diff" && b.attempts.length >= 2 && b.attempts[b.attempts.length - 2].hash === hash; // A→B→A
  attempt.signals = { noProgress, repeatHash, oscillation: osc };
  b.attempts.push(attempt);

  const prevNoProgress = prev && prev.signals ? prev.signals.noProgress || prev.signals.repeatHash : false;
  const plateau = osc || repeatHash || (noProgress && prevNoProgress); // oscillation/repeat is immediate; else 2 consecutive no-progress
  const elapsedMin = activeMinutesSince(b.windowStartedAt || b.startedAt, state.stalls);
  const effectiveMaxIters = maxAttempts != null ? Math.min(state.caps.maxBlockIters, maxAttempts) : state.caps.maxBlockIters;
  const itersExhausted = iter >= effectiveMaxIters;
  const fixCapHit = maxAttempts != null && iter >= maxAttempts;   // bounded-fix cap → BLOCKED, not STUCK
  const minutesExhausted = elapsedMin >= state.caps.maxBlockMinutes;
  const best = Math.min(...b.attempts.map((a) => a.diffCount));

  // STUCK means BUILD CHURN hit its bounds — it requires genuine attempts, never wall-clock alone.
  // Two runs false-STUCKed healthy blocks whose window was eaten by script/env repair that nobody
  // bracketed with pause/resume (run 2 family 1; the claude-cloud 28-min idle gap). Minutes
  // exhausted with <2 attempts = the time went elsewhere: restart the window ONCE automatically
  // (logged), and remind the caller that repair time belongs inside `pause --reason "script-repair:…"`.
  let boundsHit = itersExhausted || minutesExhausted;
  if (minutesExhausted && !itersExhausted && iter < 2 && !(b.windowAutoRestarts >= 1)) {
    b.windowAutoRestarts = (b.windowAutoRestarts || 0) + 1;
    b.windowStartedAt = nowIso();
    b.windows = (b.windows || 1) + 1;
    boundsHit = false;
    console.error(`⚠ minute budget exhausted with only ${iter} attempt(s) — the window was eaten by non-build time, NOT churn. Window auto-restarted ONCE (#${b.windows}). Bracket env/script repair with 'block-iter.mjs pause ${dir} --reason "script-repair: <what>"' so it never burns block budget.`);
  }

  let verdict = "CONTINUE", exit = 0;
  if (boundsHit && fixCapHit) {
    // BOUNDED-FIX cap reached → blocker-list this block (BLOCKED), never STUCK, and never escalate.
    b.stuck = true; verdict = "BLOCKED"; exit = 4;
    await writeDisposition(dir, blockId, "BLOCKED", `bounded-fix cap reached: ${iter} attempt(s) (max ${maxAttempts}), best residual diffCount=${best}; signals=${JSON.stringify(attempt.signals)} — blocker-listed, no further fix attempts (evidence: loop-state.json)`);
  } else if (boundsHit) {
    const bound = itersExhausted ? `${iter} iterations (cap ${effectiveMaxIters})` : `${elapsedMin.toFixed(1)} active min this window (cap ${state.caps.maxBlockMinutes})`;
    b.stuck = true; verdict = "STUCK"; exit = 4;
    await writeDisposition(dir, blockId, "STUCK", `harness bound hit: ${bound}; ${iter} attempt(s), best residual diffCount=${best}; signals=${JSON.stringify(attempt.signals)}${!itersExhausted && iter < 2 ? "; NOTE: <2 attempts — window likely consumed by unbracketed env/script repair, triage before treating as a build failure" : ""}`);
  } else if (plateau) {
    const sig = osc ? "oscillation (A→B→A hash)" : repeatHash ? "repeated normalized-diff hash" : "2 consecutive no-progress attempts";
    if (!b.escalated) { b.escalated = true; verdict = "ESCALATE"; exit = 5; }
    else {
      b.stuck = true; verdict = "STUCK"; exit = 4;
      await writeDisposition(dir, blockId, "STUCK", `plateau after layer escalation: ${sig} at iteration ${iter}; best residual diffCount=${best}`);
    }
  }
  await saveJson(statePath(dir), state);
  obsEvent(dir, {
    type: "iter.record", src: "block-iter", stage: "fix", blockId, iter,
    ok: verdict === "CONTINUE" ? (diffCount === 0 ? true : null) : false,
    summary: `'${blockId}' iter ${iter}: diffCount=${diffCount} → ${verdict}${noProgress ? " (no-progress)" : ""}${plateau ? " (plateau)" : ""}`,
    data: { iter, diffCount, hash: hash || null, signals: attempt.signals, verdict, elapsedMin: +elapsedMin.toFixed(1), best },
  });

  const left = `${state.caps.maxBlockIters - iter} iters / ${(state.caps.maxBlockMinutes - elapsedMin).toFixed(1)} active min left`;
  if (verdict === "CONTINUE") console.log(`● ${blockId} iter ${iter}: diffCount=${diffCount}${noProgress ? " (NO-PROGRESS — must strictly drop)" : ""} hash=${hash || "n/a"} — CONTINUE (${left})`);
  else if (verdict === "ESCALATE") console.log(`▲ ${blockId} iter ${iter}: PLATEAU — escalate the layer ONCE per guide/02-decision-tree.md, then keep iterating (retry budget continues; next plateau = STUCK)`);
  else if (verdict === "BLOCKED") console.log(`■ ${blockId} iter ${iter}: bounded-fix cap (max ${maxAttempts}) reached — BLOCKED written to block-report.json; orchestrator blocker-lists it, advance (do NOT keep fixing)`);
  else console.log(`■ ${blockId} iter ${iter}: STUCK written to block-report.json — advance to the next block (do NOT keep iterating this one)`);
  process.exit(exit);
}

// ---- env stalls: pause/resume bracket an environment outage so it never burns build budget ----
async function cmdPause(dir, reason) {
  const state = await loadState(dir);
  const open = openStall(state);
  if (open) { console.log(`⏸ already paused since ${open.from} (${open.reason || "no reason"}) — nothing to do`); process.exit(0); }
  state.stalls.push({ from: nowIso(), to: null, reason: reason || null });
  await saveJson(statePath(dir), state);
  obsEvent(dir, { type: "pause", src: "block-iter", summary: `env stall OPEN: ${reason || "no reason given"}`, data: { reason: reason || null } });
  console.log(`⏸ env stall OPEN (${reason || "no reason given"}) — elapsed-time budgets are frozen; run 'resume' when the environment is healthy`);
}
async function cmdResume(dir) {
  const state = await loadState(dir);
  const open = openStall(state);
  if (!open) { console.log("▶ no open stall — nothing to resume"); process.exit(0); }
  open.to = nowIso();
  const min = ((new Date(open.to) - new Date(open.from)) / 60000).toFixed(1);
  await saveJson(statePath(dir), state);
  obsEvent(dir, { type: "resume", src: "block-iter", summary: `env stall CLOSED after ${min} min (${open.reason || "no reason"})`, data: { minutes: +min, reason: open.reason || null } });
  console.log(`▶ env stall CLOSED after ${min} min (${open.reason || "no reason"}) — excluded from all block/phase budgets`);
}

async function cmdCheckPhase(dir, remaining) {
  const state = await loadState(dir);
  if (!state.phaseStartedAt) { console.log("phase not started"); process.exit(0); }
  const elapsed = activeMinutesSince(state.phaseStartedAt, state.stalls);
  if (elapsed < state.caps.maxPhaseMinutes) {
    console.log(`phase ${elapsed.toFixed(0)}/${state.caps.maxPhaseMinutes} active min — CONTINUE starting new blocks`);
    process.exit(0);
  }
  if (remaining && remaining.length) {
    const rp = reportPath(dir);
    const report = await loadJson(rp, { blocks: {} });
    report.phase = { softCapReached: true, remaining };
    await saveJson(rp, report);
    obsEvent(dir, { type: "phase.softcap", src: "block-iter", ok: false, summary: `phase soft-cap reached (${elapsed.toFixed(0)} ≥ ${state.caps.maxPhaseMinutes} active min) — ${remaining.length} block(s) remaining`, data: { elapsedMin: +elapsed.toFixed(1), remaining } });
    console.log(`■ phase soft-cap (${elapsed.toFixed(0)} ≥ ${state.caps.maxPhaseMinutes} active min): ${remaining.length} un-started block(s) written to report.phase.remaining`);
  } else {
    obsEvent(dir, { type: "phase.softcap", src: "block-iter", ok: false, summary: `phase soft-cap reached (${elapsed.toFixed(0)} ≥ ${state.caps.maxPhaseMinutes} active min) — grace window open`, data: { elapsedMin: +elapsed.toFixed(1) } });
    console.log(`■ phase soft-cap reached (${elapsed.toFixed(0)} ≥ ${state.caps.maxPhaseMinutes} active min): finish the IN-FLIGHT block within the ~${state.caps.graceMinutes} min grace, do NOT start new blocks; re-run with --remaining <ids> to record un-started blocks`);
  }
  process.exit(4);
}

async function cmdStatus(dir, blockId) {
  const state = await loadState(dir);
  if (blockId) { console.log(JSON.stringify(state.blocks[blockId] || null, null, 2)); return; }
  const stall = openStall(state);
  const rows = Object.entries(state.blocks).map(([id, b]) => `  ${id}: ${b.attempts.length} attempts over ${b.windows || 1} window(s), best=${b.attempts.length ? Math.min(...b.attempts.map((a) => a.diffCount)) : "-"}, escalated=${b.escalated}, stuck=${b.stuck}`);
  const stalledTotal = (state.stalls || []).reduce((s, x) => s + ((x.to ? new Date(x.to) : new Date()) - new Date(x.from)), 0) / 60000;
  console.log(`budget=${state.budget} phaseStarted=${state.phaseStartedAt} (${state.phaseStartedAt ? activeMinutesSince(state.phaseStartedAt, state.stalls).toFixed(0) : "-"} active min; ${stalledTotal.toFixed(0)} min stalled across ${(state.stalls || []).length} stall(s)${stall ? "; ⏸ STALL OPEN: " + (stall.reason || "?") : ""})\n${rows.join("\n") || "  (no blocks)"}`);
}

async function main() {
  const [cmd, dir, ...rest] = process.argv.slice(2);
  const flag = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  if (!cmd || !dir) { console.error("usage: block-iter.mjs start|record|pause|resume|check-phase|status <phaseDir> [blockId] [flags]"); process.exit(1); }
  await fs.mkdir(dir, { recursive: true });
  if (cmd === "start") await cmdStart(dir, rest[0], flag("--budget"));
  else if (cmd === "record") await cmdRecord(dir, rest[0], +flag("--diff-count", "NaN"), flag("--hash"), flag("--src"), flag("--max-attempts"));
  else if (cmd === "pause") await cmdPause(dir, flag("--reason"));
  else if (cmd === "resume") await cmdResume(dir);
  else if (cmd === "check-phase") await cmdCheckPhase(dir, (flag("--remaining", "") || "").split(",").map((s) => s.trim()).filter(Boolean));
  else if (cmd === "status") await cmdStatus(dir, rest[0]);
  else { console.error(`✗ unknown command '${cmd}'`); process.exit(1); }
}

main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

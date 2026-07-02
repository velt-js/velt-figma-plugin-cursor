#!/usr/bin/env node
// verdict-gate-blocks.mjs — the MECHANICAL terminator for the block-by-block loop. Given blocks.json
// (the Figma-derived completeness oracle) and block-report.json (the Judge's per-block dispositions),
// decides PASS / FAIL / INCOMPLETE by EXIT CODE — no agent say-so, no /goal opinion.
//
// The whole point (BLOCK-BY-BLOCK-REDESIGN-PLAN.md §1, §9): a run that builds 5 of 16 blocks, or skips
// a block's state, or has no visual-diff artifact for a block, is INCOMPLETE → CANNOT terminate. So
// "stopped at the happy path" is structurally unreachable: every Figma frame is an accounted block.
//
// block-report.json shape (the Judge writes one entry per built block):
//   { blocks: { "<blockId>": {
//       built: true,
//       driven: true,                              // drive.assert matched in the live DOM
//       capturePng: "...", framePng: "...",        // evidence on disk
//       visualDiff: { diffPct, regions: [ {cssBox, changed, fill}, ... ] },  // from visual-diff.mjs
//       deltaCompare: { ok: true, diffs: [] },     // from delta-compare.mjs (exact style/box/colour)
//       stability: { ok: true, targets: [ {name, shift:{dx,dy}, ok}, ... ] }  // STABILITY_PROBE (R27)
//   } } }
//
// stability (R27) — the interaction-transition gate, GENERAL (not comments/composer-specific). A target
// that SHIFTS during a click — because a visibility/layout rule is keyed on a TRANSIENT state (:focus/
// :hover/:active and their Velt twins) that drops on pointer-down — false-passes every static capture.
// So EVERY block must carry a stability result (the Judge runs STABILITY_PROBE over the surface's
// interactive affordances; a block with none records `{ok:true, targets:[]}`): a block with no stability
// field is INCOMPLETE (the check was skipped, not trusted), and ANY block recording `ok===false` is a
// FAIL. "The button moved under the cursor" is structurally unreachable as a pass.
//
// Terminal-for-phase dispositions the ORCHESTRATOR may set on a block report entry (with evidence):
//   disposition: "BLOCKED" — the env can't seed/reach this state (needs data it can't produce). Requires `note`.
//   disposition: "GAP"     — a VERIFIED SDK gap: no layer can express it (F3 exhaustion). Requires `note`.
//   disposition: "STUCK"   — hit the per-block bounds (≤12 iters / ≤8 min / plateau) without passing. Requires `note`.
// And a phase-level stop when the 60-min soft-cap + grace is reached:
//   report.phase = { softCapReached: true, remaining: ["<blockId>", ...] }  // blocks never started (REMAINING)
//
// BLOCKED/GAP are verified-ACCEPTABLE (a complete phase may still PASS with them). STUCK/REMAINING are
// legitimate human-checkpoint stops → verdict STOPPED (hand off, don't loop). CRUCIALLY, a block that is
// NEITHER measured NOR explicitly accounted (STUCK/BLOCKED/GAP/REMAINING) still forces INCOMPLETE — so a
// silent early-stop (the M5 failure: build 5 of 16 and quit) remains structurally unreachable.
//
// Usage: node scripts/verdict-gate-blocks.mjs --blocks blocks.json --report block-report.json
//        [--max-region-fill 0.05]   # regions at/above this fill are "real" structural diffs ⇒ FAIL
//
// Exit codes: 0 = PASS, 2 = FAIL, 3 = INCOMPLETE, 4 = STOPPED (bounds/human-checkpoint), 1 = usage/error.

import { promises as fs } from "node:fs";

const STATUS_EXIT = { PASS: 0, FAIL: 2, INCOMPLETE: 3, STOPPED: 4 };
const TERMINAL = new Set(["BLOCKED", "GAP", "STUCK"]);

export function verdictGateBlocks(blocks, report, { maxRegionFill = 0.05 } = {}) {
  const missing = [];   // coverage / artifact gaps ⇒ INCOMPLETE (cannot terminate)
  const failures = [];  // built + measured but wrong ⇒ FAIL
  const accounted = { blocked: [], gap: [], stuck: [], remaining: [] };  // explicitly-stopped, with evidence
  const reps = (report && report.blocks) || {};
  const list = (blocks && blocks.blocks) || [];
  const remainingSet = new Set((report && report.phase && report.phase.remaining) || []);
  // an empty oracle is never a pass — zero blocks means enumeration failed / the wrong node was passed.
  if (!list.length) return { verdict: "INCOMPLETE", coverage: 0, missing: ["blocks.json has zero blocks — the completeness oracle is empty (extraction failed or the node isn't a Loop?)"], failures: [], accounted: { blocked: [], gap: [], stuck: [], remaining: [] } };

  for (const b of list) {
    const r = reps[b.id];

    // explicit terminal disposition (evidence required so it can't be used to silently escape the loop)
    const disp = r && typeof r.disposition === "string" ? r.disposition.toUpperCase() : null;
    if (disp && TERMINAL.has(disp)) {
      if (typeof r.note !== "string" || !r.note.trim()) { missing.push(`block '${b.id}' marked ${disp} without a written evidence note (a non-empty string is required)`); continue; }
      accounted[disp.toLowerCase()].push(`block '${b.id}' (${b.state}): ${disp} — ${r.note}`);
      continue;
    }
    // never started, but the phase soft-capped and explicitly listed it as remaining → accounted (STOPPED)
    if (!r && remainingSet.has(b.id)) { accounted.remaining.push(`block '${b.id}' (${b.state}): not started (phase soft-cap reached)`); continue; }

    if (!r) { missing.push(`block '${b.id}' (${b.state}) has no report entry — not built`); continue; }
    if (!r.built) { missing.push(`block '${b.id}' not built`); continue; }
    if (!r.driven) { missing.push(`block '${b.id}' state '${b.state}' not driven (drive.assert never matched)`); continue; }
    if (!r.visualDiff || typeof r.visualDiff.diffPct !== "number") { missing.push(`block '${b.id}' has no visual-diff artifact`); continue; }
    if (!r.deltaCompare || typeof r.deltaCompare.ok !== "boolean") { missing.push(`block '${b.id}' has no delta-compare result`); continue; }
    // interaction-stability (R27) — required on EVERY block (a block with no interactive affordance
    // records {ok:true, targets:[]}); a missing result means the check was skipped, not that it passed.
    if (!r.stability || typeof r.stability.ok !== "boolean") { missing.push(`block '${b.id}' has no interaction-stability result (R27)`); continue; }

    // measured-but-wrong → FAIL. Visual: any SIGNIFICANT region (fill >= threshold = a real structural
    // diff, not 1px drift). Delta: the exact style/box/colour gate must be ok. Stability: no target moved.
    const sig = (r.visualDiff.regions || []).filter((reg) => (reg.fill ?? 1) >= maxRegionFill);
    for (const reg of sig) failures.push(`block '${b.id}': visual diff at ${reg.cssBox || JSON.stringify(reg)} (fill ${reg.fill})`);
    // deltaCompare.ok === false ALWAYS FAILs, even if diffs[] is empty (a summary-only failure must not slip through).
    if (!r.deltaCompare.ok) {
      const ds = (r.deltaCompare.diffs && r.deltaCompare.diffs.length) ? r.deltaCompare.diffs.slice(0, 6) : [{ note: "delta-compare FAIL (no diff detail provided)" }];
      for (const d of ds) failures.push(`block '${b.id}': ${d.element || ""} ${d.property || ""} ${d.note || ""}`.trim());
    }
    // stability.ok === false ALWAYS FAILs, even if no target was flagged (R27 — "any block recording ok===false is a FAIL").
    if (!r.stability.ok) {
      const ts = (r.stability.targets || []).filter((t) => t && t.ok === false);
      if (ts.length) for (const t of ts.slice(0, 6)) failures.push(`block '${b.id}': target '${t.name}' shifts ${t.shift ? `(${t.shift.dx},${t.shift.dy})px` : ""} mid-interaction — visibility/layout keyed on a transient state (R27)`);
      else failures.push(`block '${b.id}': interaction-stability FAIL (stability.ok=false with no target detail) — a target moves mid-interaction (R27)`);
    }
  }

  const covered = list.length - missing.filter((m) => m.startsWith("block ") && /not built|no report/.test(m)).length;
  const coverage = list.length ? Math.round(100 * covered / list.length) : 100;
  const stoppedCount = accounted.stuck.length + accounted.remaining.length;

  // M5 guard first: any block neither measured nor explicitly accounted ⇒ INCOMPLETE, keep looping.
  if (missing.length) return { verdict: "INCOMPLETE", coverage, missing, failures, accounted, note: "coverage/artifacts incomplete — a partial build is NOT a pass" };
  if (failures.length) return { verdict: "FAIL", coverage: 100, missing: [], failures, accounted };
  // all blocks accounted, none failing:
  if (stoppedCount) return { verdict: "STOPPED", coverage: 100, missing: [], failures: [], accounted, note: "hit the bounds / soft-cap — hand off to the human with the remaining/stuck list, do NOT keep looping" };
  return { verdict: "PASS", coverage: 100, missing: [], failures: [], accounted };
}

async function main() {
  const a = process.argv.slice(2);
  const argv = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const bp = argv("--blocks"), rp = argv("--report"), fill = +argv("--max-region-fill", "0.05");
  if (!bp || !rp) { console.error("usage: verdict-gate-blocks.mjs --blocks <blocks.json> --report <block-report.json> [--max-region-fill 0.05]"); process.exit(1); }
  // a NaN/out-of-range threshold would silently disable the visual gate (every region ignored) — reject it.
  if (!Number.isFinite(fill) || fill < 0 || fill > 1) { console.error("✗ --max-region-fill must be a number in [0,1]"); process.exit(1); }
  const blocks = JSON.parse(await fs.readFile(bp, "utf8"));
  const report = JSON.parse(await fs.readFile(rp, "utf8"));
  const r = verdictGateBlocks(blocks, report, { maxRegionFill: fill });
  console.log(`VERDICT: ${r.verdict}  (block coverage ${r.coverage}% of ${(blocks.blocks || []).length})`);
  if (r.missing.length) { console.log("  INCOMPLETE — not built / not driven / artifacts missing:"); for (const m of r.missing.slice(0, 24)) console.log("    · " + m); }
  if (r.failures.length) { console.log("  FAIL — built but does not match:"); for (const f of r.failures.slice(0, 24)) console.log("    · " + f); }
  const acc = r.accounted || {};
  for (const [k, label] of [["stuck", "STUCK (hit bounds — hand to human)"], ["remaining", "REMAINING (soft-cap reached — not started)"], ["blocked", "BLOCKED (env can't reach)"], ["gap", "GAP (verified SDK gap)"]])
    if (acc[k] && acc[k].length) { console.log(`  ${label}:`); for (const m of acc[k].slice(0, 24)) console.log("    · " + m); }
  process.exit(STATUS_EXIT[r.verdict]);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

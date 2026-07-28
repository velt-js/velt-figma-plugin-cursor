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
import { pathToFileURL } from "node:url";
import path from "node:path";
import { obsEvent } from "./obs.mjs";

const STATUS_EXIT = { PASS: 0, FAIL: 2, INCOMPLETE: 3, STOPPED: 4 };
const TERMINAL = new Set(["BLOCKED", "GAP", "STUCK"]);

// ---- artifact audit (fs layer — kept OUT of the pure verdict function so golden calibration
// can keep calling verdictGateBlocks with plain objects). The gate previously trusted every
// value in block-report.json as the Judge transcribed it; this audit makes a PASS require
// on-disk, script-written evidence:
//   * capturePng/framePng must EXIST (a report naming a file that isn't there is INCOMPLETE);
//   * when the entry was assembled by report-block.mjs (entry.artifacts), the report's numbers
//     must MATCH the persisted artifact JSONs (a hand-edited report is INCOMPLETE);
//   * when loop-state.json stamps the block's startedAt, the capture's mtime must be ≥ it
//     (a stale screenshot from a prior attempt can't back this block);
//   * a terminal GAP/BLOCKED/STUCK must carry an `evidence` path that EXISTS (a one-word note
//     alone no longer accounts a block — "declare a gap to escape" is structurally closed).
export async function auditReportArtifacts(blocks, report, phaseDir) {
  const problems = [];
  const reps = (report && report.blocks) || {};
  const ids = new Set(((blocks && blocks.blocks) || []).map((b) => b.id));
  const resolve = (p) => (path.isAbsolute(p) ? p : path.join(phaseDir, p));
  const stat = (p) => fs.stat(resolve(p)).catch(() => null);
  const loopState = JSON.parse(await fs.readFile(path.join(phaseDir, "loop-state.json"), "utf8").catch(() => "null"));

  for (const [id, r] of Object.entries(reps)) {
    if (!ids.has(id)) continue; // extra entries are the pure gate's concern, not the audit's
    const disp = typeof r.disposition === "string" ? r.disposition.toUpperCase() : null;
    if (disp && TERMINAL.has(disp)) {
      if (!r.evidence || typeof r.evidence !== "string") { problems.push(`block '${id}' ${disp}: no \`evidence\` file recorded — a note alone cannot account a block (use report-block.mjs account / block-iter.mjs)`); continue; }
      if (!(await stat(r.evidence))) problems.push(`block '${id}' ${disp}: evidence file missing on disk: ${r.evidence}`);
      continue;
    }
    if (!r.built) continue; // unbuilt → the pure gate already yields INCOMPLETE
    for (const [k, what] of [["capturePng", "capture PNG"], ["framePng", "frame PNG"]]) {
      if (typeof r[k] !== "string") continue; // shape errors are the pure gate's job
      const st = await stat(r[k]);
      if (!st) { problems.push(`block '${id}': ${what} missing on disk: ${r[k]}`); continue; }
      const startedAt = loopState?.blocks?.[id]?.startedAt;
      if (k === "capturePng" && startedAt && st.mtimeMs < new Date(startedAt).getTime()) problems.push(`block '${id}': capture PNG is STALE (mtime predates the block's startedAt ${startedAt}) — re-capture this block`);
    }
    if (r.artifacts) {
      const vis = r.artifacts.visual && JSON.parse(await fs.readFile(resolve(r.artifacts.visual), "utf8").catch(() => "null"));
      if (!vis) problems.push(`block '${id}': visual artifact missing/unreadable: ${r.artifacts.visual}`);
      else if (vis.diffPct !== r.visualDiff?.diffPct || (vis.regions || []).length !== (r.visualDiff?.regions || []).length)
        problems.push(`block '${id}': report visualDiff does not match the persisted artifact ${r.artifacts.visual} — the report was edited by hand`);
      const del = r.artifacts.delta && JSON.parse(await fs.readFile(resolve(r.artifacts.delta), "utf8").catch(() => "null"));
      if (del) { const ok = typeof del.ok === "boolean" ? del.ok : del.verdict === "PASS"; if (ok !== r.deltaCompare?.ok) problems.push(`block '${id}': report deltaCompare.ok does not match artifact ${r.artifacts.delta}`); }
      const sta = r.artifacts.stability && JSON.parse(await fs.readFile(resolve(r.artifacts.stability), "utf8").catch(() => "null"));
      if (sta && sta.ok !== r.stability?.ok) problems.push(`block '${id}': report stability.ok does not match artifact ${r.artifacts.stability}`);
    } else {
      problems.push(`block '${id}': entry was not assembled by report-block.mjs (no \`artifacts\`) — hand-written report entries are not accepted as evidence`);
    }
  }
  return problems;
}

// ---- family smoke check (R30 — fs layer, like the artifact audit). A family with at least one
// MEASURED block must carry results/smoke/<familyId>.json with ok:true: the harvey run went fully
// green on seeded fixtures while real interaction paths were broken (7 user defects, ~80 min of
// post-loop fix passes). Missing smoke = INCOMPLETE (check skipped); ok:false = FAIL (real path broken).
// Only applies when blocks.json carries `families` (older phases without them gate as before).
export async function checkFamilySmoke(blocks, report, phaseDir) {
  const missing = [], failures = [];
  const families = (blocks && blocks.families) || [];
  if (!families.length) return { missing, failures };
  const reps = (report && report.blocks) || {};
  for (const fam of families) {
    const measured = (fam.blockIds || []).some((id) => {
      const r = reps[id];
      return r && r.built && !(typeof r.disposition === "string" && TERMINAL.has(r.disposition.toUpperCase()));
    });
    if (!measured) continue;   // fully terminal/unstarted family — smoke can't run against it
    const p = path.join(phaseDir, "results", "smoke", `${fam.id}.json`);
    const smoke = JSON.parse(await fs.readFile(p, "utf8").catch(() => "null"));
    if (!smoke) { missing.push(`family '${fam.id}': real-path smoke suite not run (R30) — 'measure-block.mjs smoke ${path.basename(phaseDir)} ${fam.id} …' must produce results/smoke/${fam.id}.json`); continue; }
    if (!smoke.ok) for (const s of (smoke.steps || []).filter((x) => !x.ok).slice(0, 6)) failures.push(`family '${fam.id}' smoke '${s.name}': ${s.error || (s.consoleErrors || []).join(" | ") || "failed"} (R30 — a fixture-green surface with a broken real path is NOT done)`);
    if (!smoke.ok && !(smoke.steps || []).some((x) => !x.ok)) failures.push(`family '${fam.id}' smoke: console errors during real-path drive (R30)`);
  }
  return { missing, failures };
}

export function verdictGateBlocks(blocks, report, { maxRegionFill = 0.05 } = {}) {
  const missing = [];   // coverage / artifact gaps ⇒ INCOMPLETE (cannot terminate)
  const failures = [];  // built + measured but wrong ⇒ FAIL
  const advisories = []; // pixel-diff regions vs the dummy-data design — reported, NOT gated (data≠design)
  const accounted = { blocked: [], gap: [], stuck: [], remaining: [] };  // explicitly-stopped, with evidence
  const reps = (report && report.blocks) || {};
  const list = (blocks && blocks.blocks) || [];
  const remainingSet = new Set((report && report.phase && report.phase.remaining) || []);
  // an empty oracle is never a pass — zero blocks means enumeration failed / the wrong node was passed.
  if (!list.length) return { verdict: "INCOMPLETE", coverage: 0, missing: ["blocks.json has zero blocks — the completeness oracle is empty (extraction failed or the node isn't a Loop?)"], failures: [], advisories: [], accounted: { blocked: [], gap: [], stuck: [], remaining: [] } };

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

    // COVERAGE FLOOR — deltaCompare is the AUTHORITY (content-independent style/box/gap), so a thin spec
    // must not certify a surface by checking nothing. This is the RUN-3 hole: delta reported 'clean' while
    // the inter-card gap and the reaction icons were never in the spec, and whole-surface pixel-diff (the
    // only thing that would have caught them) drowned in real-vs-dummy DATA noise and got waved off.
    // Raised floor: when the brief/report carries coverage.minAssert (from paint+text slot census),
    // require that many checked elements — not the historic ≥2 which let a 17-slot surface certify on crumbs.
    const checkedN = Array.isArray(r.deltaCompare.checked) ? r.deltaCompare.checked.length : 0;
    const gapsN = Array.isArray(r.deltaCompare.gaps) ? r.deltaCompare.gaps.length : 0;
    const minAssert = Math.max(2, Number(r.deltaCompare?.coverage?.minAssert ?? r.coverage?.minAssert ?? 2) || 2);
    if (checkedN < minAssert) { missing.push(`block '${b.id}' delta-compare spec too thin (asserted ${checkedN} element(s), need ≥${minAssert}) — enumerate every visible paint/text slot's style + box; a surface cannot be certified by checking nothing`); continue; }
    const isRepeating = /flow/i.test(b.role || "") || /comment|thread|list|feed/i.test(String(b.familyId || "") + String(b.component || ""));
    if (isRepeating && gapsN < 1) { missing.push(`block '${b.id}' is a repeating/list surface but delta-compare asserted no inter-card gap — add a compareGap between consecutive cards (the '2 vs 11' blind spot: the count varies, the gap does not)`); continue; }

    // measured-but-wrong → FAIL. deltaCompare (exact style/box/gap) is the authority; stability: no target
    // moved. visualDiff is ADVISORY — pixel-diff vs the DUMMY-data design frame lights up on real-vs-dummy
    // DATA (2 vs 11 cards, different text/names/times) that is NOT a defect, so it does not FAIL on its own;
    // a genuine styling issue a region hints at must be confirmed as a delta-compare assertion (which DOES
    // FAIL). Exception: a capture taken against MATCHED fixture data (dataMatched) is a valid pixel compare.
    const sig = (r.visualDiff.regions || []).filter((reg) => (reg.fill ?? 1) >= maxRegionFill);
    if (b.dataMatched) for (const reg of sig) failures.push(`block '${b.id}': visual diff at ${reg.cssBox || JSON.stringify(reg)} (fill ${reg.fill}) [dataMatched]`);
    else for (const reg of sig) advisories.push(`block '${b.id}': pixel region at ${reg.cssBox || JSON.stringify(reg)} (fill ${reg.fill}) — advisory only (live data ≠ design mock); confirm via delta-compare to gate it`);
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
  if (missing.length) return { verdict: "INCOMPLETE", coverage, missing, failures, advisories, accounted, note: "coverage/artifacts incomplete — a partial build is NOT a pass" };
  if (failures.length) return { verdict: "FAIL", coverage: 100, missing: [], failures, advisories, accounted };
  // all blocks accounted, none failing:
  if (stoppedCount) return { verdict: "STOPPED", coverage: 100, missing: [], failures: [], advisories, accounted, note: "hit the bounds / soft-cap — hand off to the human with the remaining/stuck list, do NOT keep looping" };
  return { verdict: "PASS", coverage: 100, missing: [], failures: [], advisories, accounted };
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
  // artifact audit: a verdict is only as good as its on-disk evidence. Audit failures force
  // INCOMPLETE (evidence problem = not measured), except a FAIL stays FAIL (already failing).
  const audit = a.includes("--no-artifact-audit") ? [] : await auditReportArtifacts(blocks, report, path.dirname(path.resolve(rp)));
  if (audit.length && r.verdict !== "FAIL") { r.missing.push(...audit); r.verdict = "INCOMPLETE"; r.note = "artifact audit failed — evidence on disk doesn't back the report"; }
  else if (audit.length) r.missing.push(...audit);
  // R30 — real-path smoke per family (skipped with --no-artifact-audit for offline/golden use).
  // Escalates PASS only: a STOPPED phase is already handing off to the human — the smoke findings
  // are appended to its lists for the handoff, but the stop stands (bounds beat re-looping).
  const smoke = a.includes("--no-artifact-audit") ? { missing: [], failures: [] } : await checkFamilySmoke(blocks, report, path.dirname(path.resolve(rp)));
  if (smoke.failures.length) { r.failures.push(...smoke.failures); if (r.verdict === "PASS") r.verdict = "FAIL"; }
  if (smoke.missing.length) { r.missing.push(...smoke.missing); if (r.verdict === "PASS") { r.verdict = "INCOMPLETE"; r.note = "family real-path smoke missing (R30)"; } }
  console.log(`VERDICT: ${r.verdict}  (block coverage ${r.coverage}% of ${(blocks.blocks || []).length})`);
  if (r.missing.length) { console.log("  INCOMPLETE — not built / not driven / artifacts missing:"); for (const m of r.missing.slice(0, 24)) console.log("    · " + m); }
  if (r.failures.length) { console.log("  FAIL — built but does not match:"); for (const f of r.failures.slice(0, 24)) console.log("    · " + f); }
  if (r.advisories && r.advisories.length) { console.log("  advisory (pixel regions vs dummy-data design — NOT gated; investigate + confirm via delta-compare):"); for (const m of r.advisories.slice(0, 12)) console.log("    · " + m); }
  const acc = r.accounted || {};
  for (const [k, label] of [["stuck", "STUCK (hit bounds — hand to human)"], ["remaining", "REMAINING (soft-cap reached — not started)"], ["blocked", "BLOCKED (env can't reach)"], ["gap", "GAP (verified SDK gap)"]])
    if (acc[k] && acc[k].length) { console.log(`  ${label}:`); for (const m of acc[k].slice(0, 24)) console.log("    · " + m); }
  obsEvent(path.dirname(path.resolve(rp)), {
    type: "verdict", src: "verdict-gate", ok: r.verdict === "PASS",
    summary: `gate: ${r.verdict} — coverage ${r.coverage}%, ${r.missing.length} missing, ${r.failures.length} failing`,
    data: { verdict: r.verdict, coverage: r.coverage, missing: r.missing.slice(0, 24), failures: r.failures.slice(0, 24) },
  });
  // VERDICT ARTIFACT — the only acceptable proof of "done". A run/stage may be journaled complete
  // ONLY if this file exists and carries the gate's own exit code; agent prose (orchestrator OR
  // human-in-the-loop) concludes nothing. Loop2 shipped a broken build precisely because the gate
  // was never run and spot-checks were narrated as completion.
  await fs.writeFile(path.join(path.dirname(path.resolve(rp)), "verdict.json"), JSON.stringify({
    verdict: r.verdict, exitCode: STATUS_EXIT[r.verdict], coverage: r.coverage, t: new Date().toISOString(),
    missing: r.missing.length, failures: r.failures.length,
  }, null, 2) + "\n");
  process.exit(STATUS_EXIT[r.verdict]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

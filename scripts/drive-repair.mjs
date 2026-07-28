#!/usr/bin/env node
// drive-repair.mjs — MECHANICAL VERIFY-AND-REPAIR for the briefs' drive steps, run right after the
// structure build's dom-snapshot (5a2). The build-structure trial measured the problem: 5 of 8
// planner-authored drives were dead against the REAL rendered DOM — not because the classes were
// wrong, but because the NESTING was ('.vc-card .vc-reply' when Reply is Body-level; sibling
// containers that render wrapper-nested) — and every fix was derivable from the snapshot. Like
// style selectors, drive selectors are only reliably plannable POST-build; this script closes the
// gap sub-second instead of at judge time.
//
//   node scripts/drive-repair.mjs <phaseDir> [--apply] [--snapshots <dir>]
//
// Checks every brief's drive.steps selectors + drive.assert against the dom-snapshot TREES
// (descendant-chain matching, not just token existence). With --apply it performs the two SAFE
// repairs and tags the brief `driveRepaired`:
//   * a failing DESCENDANT selector whose deepest suffix DOES match → replaced by that suffix
//     (each alternative in a comma list handled independently; dead alternatives dropped);
//   * a comment-only `eval` stub (js that is only /*…*/ — the planner's "seed data here" note)
//     → removed (seeding is a real-path smoke concern, never a state drive).
// Everything else is REPORTED (exit 2) for the orchestrator/planner — never guessed.
// Blocks whose snapshot is stateUnreachable are skipped (nothing to verify against).

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { obsEvent } from "./obs.mjs";

// ---- simple-selector matching against a snapshot tree ----
// Supports: tag, .class (multiple), descendant combinator (whitespace), comma alternatives.
// Pseudo-classes/elements and attribute selectors are STRIPPED (state pseudos can't be verified
// statically); child combinator `>` is treated as descendant (conservative-pass).
function parseSimple(sel) {
  const cleaned = sel.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, "").replace(/\[[^\]]*\]/g, "").trim();
  if (!cleaned) return null;
  const tag = (cleaned.match(/^[a-zA-Z][\w-]*/) || [null])[0];
  const classes = [...cleaned.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  if (!tag && !classes.length) return null;   // a bare combinator ('~', '+') — never match-all
  return { tag: tag ? tag.toLowerCase() : null, classes };
}
function nodeMatches(node, simple) {
  if (!simple) return false;
  if (simple.tag && node.tag !== simple.tag) return false;
  return simple.classes.every((c) => (node.classes || []).includes(c));
}
function chainMatches(node, chain, i = 0) {
  if (i >= chain.length) return true;
  const hit = nodeMatches(node, chain[i]);
  if (hit && i === chain.length - 1) return true;
  for (const c of node.children || []) {
    if (hit && chainMatches(c, chain, i + 1)) return true;   // descend to next part
    if (chainMatches(c, chain, i)) return true;              // keep searching for part i
  }
  return false;
}
export function selectorMatchesSnapshots(selector, snapshots) {
  for (const alt of String(selector).split(",")) {
    const chain = alt.trim().replace(/\s*>\s*/g, " ").split(/\s+/).map(parseSimple).filter(Boolean);
    if (!chain.length) continue;
    for (const s of snapshots) if (s.tree && chainMatches(s.tree, chain)) return true;
  }
  return false;
}
// the deepest suffix of a failing descendant chain that DOES match (the trial's repair class:
// '.vc-card .vc-reply' → '.vc-reply' when Reply is Body-level, not card-nested)
export function repairSelector(selector, snapshots) {
  const goodAlts = [];
  for (const alt of String(selector).split(",")) {
    const trimmed = alt.trim();
    if (!trimmed) continue;
    if (selectorMatchesSnapshots(trimmed, snapshots)) { goodAlts.push(trimmed); continue; }
    // suffix candidates over REAL parts only (bare combinators like '~'/'+' dropped — a suffix
    // must be a valid standalone selector, never '~ .foo')
    const parts = trimmed.replace(/\s*>\s*/g, " ").split(/\s+/).filter((p) => parseSimple(p));
    for (let i = 1; i < parts.length; i++) {
      const suffix = parts.slice(i).join(" ");
      if (selectorMatchesSnapshots(suffix, snapshots)) { goodAlts.push(suffix); break; }
    }
  }
  return goodAlts.length ? [...new Set(goodAlts)].join(", ") : null;
}
const isStubEval = (s) => s.action === "eval" && /^\s*\/\*[\s\S]*\*\/\s*$/.test(String(s.js || ""));
// Snapshots are rooted at the SURFACE — host-app chrome (the open-path toggle, the sign-in select)
// lives OUTSIDE them and can never match. Only selectors carrying our own (.vc-*) or the SDK's
// (velt-*/.velt-*/.s-*) vocabulary are required to exist in a snapshot; anything else is
// unverifiable host chrome → warn, never fail/repair.
export const isSurfaceScoped = (sel) => /(^|[\s,>.])(vc-|velt-|s-)/.test(String(sel));

export function repairDrive(brief, snapshots) {
  const report = { checked: 0, ok: 0, repaired: [], removedStubs: [], unrepairable: [] };
  const drive = brief.drive || {};
  const steps = drive.steps || [];
  report.hostChrome = [];
  const fix = (holder, key, label) => {
    const sel = holder[key];
    if (!sel) return;
    if (!isSurfaceScoped(sel)) { report.hostChrome.push({ where: label, selector: sel }); return; }   // outside the snapshotted surface — unverifiable
    report.checked++;
    if (selectorMatchesSnapshots(sel, snapshots)) { report.ok++; return; }
    const rep = repairSelector(sel, snapshots);
    if (rep) { report.repaired.push({ where: label, from: sel, to: rep }); holder[key] = rep; }
    else report.unrepairable.push({ where: label, selector: sel });
  };
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (isStubEval(s)) { report.removedStubs.push(String(s.js).slice(0, 60)); steps.splice(i, 1); continue; }
    if (["click", "dblclick", "hover", "waitFor"].includes(s.action)) fix(s, "selector", `steps[${i}].${s.action}`);
  }
  fix(drive, "assert", "assert");
  return report;
}

async function main() {
  const [phaseDirArg, ...rest] = process.argv.slice(2);
  if (!phaseDirArg) { console.error("usage: drive-repair.mjs <phaseDir> [--apply] [--snapshots <dir>]"); process.exit(1); }
  const phaseDir = path.resolve(phaseDirArg);
  const apply = rest.includes("--apply");
  const flag = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  const snapDir = path.resolve(flag("--snapshots", path.join(phaseDir, "dom-snapshot")));

  const blocks = JSON.parse(await fs.readFile(path.join(phaseDir, "blocks.json"), "utf8")).blocks || [];
  let totalRepaired = 0, totalDead = 0, totalStubs = 0, skipped = 0;
  for (const b of blocks) {
    const snapP = path.join(snapDir, `${b.id}.json`);
    const briefP = path.join(phaseDir, "briefs", `${b.id}.probes.json`);
    const snap = await fs.readFile(snapP, "utf8").then(JSON.parse, () => null);
    const brief = await fs.readFile(briefP, "utf8").then(JSON.parse, () => null);
    if (!brief) continue;
    if (!snap || snap.stateUnreachable || !snap.tree) { skipped++; console.log(`· ${b.id}: no usable snapshot — drive left as-is (state unreachable)`); continue; }
    // verify against THIS block's snapshot plus the flow's (drives traverse shared chrome first)
    const corpus = [snap];
    const flowSnap = await fs.readFile(path.join(snapDir, "flow.json"), "utf8").then(JSON.parse, () => null);
    if (flowSnap?.tree && flowSnap !== snap) corpus.push(flowSnap);
    const work = apply ? brief : JSON.parse(JSON.stringify(brief));
    const rep = repairDrive(work, corpus);
    totalRepaired += rep.repaired.length; totalDead += rep.unrepairable.length; totalStubs += rep.removedStubs.length;
    for (const r of rep.repaired) console.log(`${apply ? "✓ repaired" : "would repair"} ${b.id} ${r.where}: '${r.from}' → '${r.to}'`);
    for (const s of rep.removedStubs) console.log(`${apply ? "✓ removed" : "would remove"} ${b.id} stub eval: ${s}`);
    for (const u of rep.unrepairable) console.log(`✗ ${b.id} ${u.where}: '${u.selector}' matches NOTHING in the snapshot — needs the planner/orchestrator`);
    for (const h of rep.hostChrome) console.log(`· ${b.id} ${h.where}: '${h.selector}' is host-app chrome (outside the snapshot) — unverifiable here`);
    if (apply && (rep.repaired.length || rep.removedStubs.length)) {
      work.driveRepaired = { at: new Date().toISOString(), repaired: rep.repaired, removedStubs: rep.removedStubs.length };
      await fs.writeFile(briefP, JSON.stringify(work, null, 2));
    }
  }
  obsEvent(phaseDir, { type: "lint", src: "drive-repair", stage: "dom-snapshot", ok: totalDead === 0,
    summary: `drive-repair: ${totalRepaired} selector(s) repaired from the snapshot, ${totalStubs} stub eval(s) removed, ${totalDead} unrepairable${skipped ? `, ${skipped} block(s) skipped (unreachable)` : ""}` });
  console.log(`\n${totalDead ? "✗" : "✓"} drive-repair: ${totalRepaired} repaired · ${totalStubs} stubs removed · ${totalDead} unrepairable${apply ? " (applied)" : " (dry run — pass --apply)"}`);
  process.exit(totalDead ? 2 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

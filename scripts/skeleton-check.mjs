#!/usr/bin/env node
// skeleton-check.mjs — the MECHANICAL structure-fidelity gate. Loop2 evidence: the structure
// build's defects (header stacked instead of a row; a planned connector never in the markup; a
// template mounted at the wrong level so its class bound only to a 0-size twin) sailed into the
// style stage and poisoned it — the style planner had to plan against a WRONG DOM, and nothing
// mechanical compared the built skeleton to the plan/design. This closes that gap: every check
// here is a box/class fact a script can read from artifacts that already exist.
//
//   node scripts/skeleton-check.mjs <phaseDir> [--presence-only] [--snapshots <dir>]
//
// Checks, per the structure plan (plan-structure.json):
//   A. PRESENCE — every planned vcClass must appear on ≥1 element with a REAL box somewhere in the
//      dom-snapshot corpus. "In the markup but 0-size everywhere" is reported too (the mis-mounted
//      template class: it exists, but only on the hidden registry twin).
//   B. ARRANGEMENT — for each planned slot with a specNodeId whose spec node is a flex container:
//      the design's flex-direction (row/column) vs the RENDERED children arrangement (from child
//      boxes; wrapper chains descended). Catches "header stacked instead of a row" from geometry
//      alone. Skipped with --presence-only: pre-CSS, an unstyled skeleton's arrangement is
//      meaningless — run presence-only at 5a2, the full check after the style build.
//
// Exit 0 = clean · 2 = defects (named; the Builder fixes the SKELETON before plan-style/judge).

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { obsEvent } from "./obs.mjs";

// all vc- classes the plan commits to: slot rows + the top-level vcClasses contract (own markup)
export function plannedClasses(plan) {
  const out = new Map();   // class -> {slot?, specNodeId?, role?}
  for (const comp of plan.components || []) {
    for (const s of comp.slots || []) {
      if (s.vcClass) out.set(String(s.vcClass).replace(/^\./, ""), { slot: s.slot, specNodeId: s.specNodeId || null, role: s.role || null });
    }
  }
  const walkContract = (o) => {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (/^vc-[\w-]+$/.test(k) && !out.has(k)) out.set(k, { slot: null, specNodeId: null, role: "own-markup" });
      if (v && typeof v === "object") walkContract(v);
    }
  };
  walkContract(plan.vcClasses);
  return out;
}

// class -> best rendered element across the corpus: { visible: bool, box }. "Real box" accepts
// THIN elements (a 1px connector rail is legitimate) but rejects the 0-size registry twin.
const hasRealBox = (n) => !!(n.box && n.box.w > 0 && n.box.h > 0 && (n.box.w > 4 || n.box.h > 4));
export function classPresence(snapshots, classes) {
  const seen = new Map();   // class -> {inDom, visible}
  const visit = (n) => {
    const vis = hasRealBox(n);
    for (const c of n.classes || []) {
      if (!classes.has(c)) continue;
      const cur = seen.get(c) || { inDom: false, visible: false };
      cur.inDom = true;
      if (vis) cur.visible = true;
      seen.set(c, cur);
    }
    for (const ch of n.children || []) visit(ch);
  };
  for (const s of snapshots) if (s.tree) visit(s.tree);
  return seen;
}

// rendered arrangement of an element's children: descend single-child wrapper chains first, then
// classify by the spread of the children's box centers. "ambiguous" (≤1 child / no dominant axis)
// is never a defect — only a confident row-vs-column contradiction is.
export function renderedOrientation(node) {
  let el = node;
  let kids = (el.children || []).filter((c) => c.box && c.box.w > 4 && c.box.h > 2);
  for (let hop = 0; kids.length === 1 && hop < 4; hop++) { el = kids[0]; kids = (el.children || []).filter((c) => c.box && c.box.w > 4 && c.box.h > 2); }
  if (kids.length < 2) return "ambiguous";
  const cx = kids.map((k) => k.box.x + k.box.w / 2), cy = kids.map((k) => k.box.y + k.box.h / 2);
  const avgW = kids.reduce((a, k) => a + k.box.w, 0) / kids.length, avgH = kids.reduce((a, k) => a + k.box.h, 0) / kids.length;
  const spreadX = (Math.max(...cx) - Math.min(...cx)) / Math.max(avgW, 1);
  const spreadY = (Math.max(...cy) - Math.min(...cy)) / Math.max(avgH, 1);
  if (spreadX > spreadY * 1.5) return "row";
  if (spreadY > spreadX * 1.5) return "column";
  return "ambiguous";
}

export function skeletonProblems(plan, snapshots, specNodesById, { presenceOnly = false } = {}) {
  const problems = [];
  const classes = plannedClasses(plan);
  const presence = classPresence(snapshots, classes);
  // A. presence
  for (const [cls, meta] of classes) {
    const p = presence.get(cls);
    if (!p) problems.push({ kind: "missing-class", class: cls, slot: meta.slot, msg: `planned class '.${cls}'${meta.slot ? ` (slot ${meta.slot})` : " (own markup)"} exists NOWHERE in the rendered DOM — never built` });
    else if (!p.visible) problems.push({ kind: "zero-size-class", class: cls, slot: meta.slot, msg: `planned class '.${cls}'${meta.slot ? ` (slot ${meta.slot})` : ""} renders ZERO-SIZE everywhere (bound only to a hidden twin / wrong mount level?)` });
  }
  // A2. HOLLOW COMPOSITES (v4 empty-composer class): a planned CONTAINER slot whose live element
  //     has a real box but contains NO visible content (no text, no visible children anywhere in
  //     its subtree) renders as an empty shell — present, sized, and useless. Presence alone
  //     false-passed it; this names it.
  const hasVisibleContent = (n) => {
    if (n.text) return true;
    for (const c of n.children || []) {
      const vis = c.box && c.box.w > 0 && c.box.h > 0 && (c.box.w > 4 || c.box.h > 4);
      if (vis && (c.text || (c.paints && Object.keys(c.paints).length) || c.tag === "svg" || c.tag === "img")) return true;
      if (hasVisibleContent(c)) return true;
    }
    return false;
  };
  const findAllByClass = (cls) => {
    const hits = [];
    const visit = (n) => {
      if ((n.classes || []).includes(cls) && hasRealBox(n)) hits.push(n);
      for (const ch of n.children || []) visit(ch);
    };
    for (const s of snapshots) if (s.tree) visit(s.tree);
    return hits;
  };
  for (const [cls, meta] of classes) {
    if (meta.role !== "container") continue;
    const els = findAllByClass(cls);
    if (els.length && els.every((el) => !hasVisibleContent(el))) {
      problems.push({ kind: "hollow-container", class: cls, slot: meta.slot, msg: `planned container '.${cls}'${meta.slot ? ` (slot ${meta.slot})` : ""} renders with a REAL box but NO visible content anywhere inside (empty shell — internals never mounted?)` });
    }
  }
  if (presenceOnly) return problems;
  // B. arrangement (design flex-direction vs rendered child-box arrangement)
  const findByClass = (cls) => {
    const hits = [];
    const visit = (n) => {
      if ((n.classes || []).includes(cls) && hasRealBox(n)) hits.push(n);
      for (const ch of n.children || []) visit(ch);
    };
    for (const s of snapshots) if (s.tree) visit(s.tree);
    return hits;
  };
  for (const [cls, meta] of classes) {
    if (!meta.specNodeId) continue;
    const spec = specNodesById.get(meta.specNodeId);
    const decls = spec && spec.cssDecls;
    if (!decls || decls.display !== "flex") continue;
    const want = decls["flex-direction"] === "column" ? "column" : "row";   // CSS default: row
    const rendered = findByClass(cls).map(renderedOrientation).filter((o) => o !== "ambiguous");
    if (!rendered.length) continue;   // nothing confident to compare
    if (rendered.every((o) => o !== want)) {
      problems.push({ kind: "arrangement", class: cls, slot: meta.slot, want, got: rendered[0], msg: `'.${cls}'${meta.slot ? ` (slot ${meta.slot})` : ""}: design (spec ${meta.specNodeId}) lays children out as a ${want.toUpperCase()}, but every rendered instance is a ${rendered[0].toUpperCase()} — markup grouping is wrong` });
    }
  }
  return problems;
}

async function main() {
  const [phaseDirArg, ...rest] = process.argv.slice(2);
  if (!phaseDirArg) { console.error("usage: skeleton-check.mjs <phaseDir> [--presence-only] [--snapshots <dir>]"); process.exit(1); }
  const phaseDir = path.resolve(phaseDirArg);
  const presenceOnly = rest.includes("--presence-only");
  const flag = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  const snapDir = path.resolve(flag("--snapshots", path.join(phaseDir, "dom-snapshot")));

  const plan = await fs.readFile(path.join(phaseDir, "plan-structure.json"), "utf8").then(JSON.parse);
  const snapshots = [];
  for (const f of await fs.readdir(snapDir).catch(() => [])) {
    if (f.endsWith(".json")) { const s = await fs.readFile(path.join(snapDir, f), "utf8").then(JSON.parse, () => null); if (s && s.tree) snapshots.push(s); }
  }
  if (!snapshots.length) { console.error("✗ no usable dom-snapshots — run dom-snapshot.mjs first"); process.exit(1); }
  const specNodesById = new Map();
  const briefsDir = path.join(phaseDir, "briefs");
  for (const f of await fs.readdir(briefsDir).catch(() => [])) {
    if (!f.endsWith(".spec.json")) continue;
    const d = await fs.readFile(path.join(briefsDir, f), "utf8").then(JSON.parse, () => null);
    for (const n of d?.nodes || []) if (!specNodesById.has(n.id)) specNodesById.set(n.id, n);
  }

  const problems = skeletonProblems(plan, snapshots, specNodesById, { presenceOnly });
  for (const p of problems) console.log(`✗ [${p.kind}] ${p.msg}`);
  const summary = problems.length
    ? `skeleton-check${presenceOnly ? " (presence-only)" : ""}: ${problems.length} structure defect(s) — ${[...new Set(problems.map((p) => p.kind))].join(", ")}`
    : `skeleton-check${presenceOnly ? " (presence-only)" : ""}: skeleton matches the structure plan${presenceOnly ? "" : " + design arrangement"}`;
  obsEvent(phaseDir, { type: "lint", src: "skeleton-check", stage: presenceOnly ? "build-structure" : "build-style", ok: !problems.length, summary });
  console.log(`${problems.length ? "✗" : "✓"} ${summary}`);
  process.exit(problems.length ? 2 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

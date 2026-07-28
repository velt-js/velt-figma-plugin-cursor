#!/usr/bin/env node
// run-golden.mjs — the golden regression guard.
//
// OFFLINE (runs here, no browser): for each expected fixture, assert the design's
// surface + every identifier the golden build relies on STILL EXISTS in the guide.
// This catches the failure mode where the guide evolves and silently breaks the golden
// expectations (R10 / drift guard) — without needing a live app.
//
// E2E (manual / CI, needs the live env): the checklist printed at the end — run the
// playground, run /velt-customize against a Figma frame replicating each design, and
// assert the Judge reaches the expected verdict with a clean rules scan.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareDecls, compareProp, compareText, verdictOf, BROWSER_PROBE, LAYER_PROBE, reconcilePlan, mountMapDiff, CONTRACT_PROBE, STABILITY_PROBE } from "../scripts/delta-compare.mjs";
import { verdictGateBlocks } from "../scripts/verdict-gate-blocks.mjs";
import { assignIcons, normalizeBoxes } from "../scripts/figma-extract.mjs";
import { verdictGate } from "../scripts/verdict-gate.mjs";
import { buildChecklist } from "../scripts/build-checklist.mjs";
import { selectorTokensExist, snapshotCorpus, planSpecValueConflicts, planStructureProblems, structureFingerprint, styleCoverageGaps, nodeKindOf, textContentOf, isStaticChromeText, scaffoldProbes, probeBindingProblems, deriveThreadStructureContracts, stylePlanAuthorshipProblems } from "../scripts/brief-scaffold.mjs";
import { evaluateInvariantResult } from "../scripts/structural-invariants.mjs";
import { classifyDiff, issueKey, workOrderPriority, isTemplatedMiss, boxIoU } from "../scripts/emit-judge-defects.mjs";
import { collectRequiredWiring, evaluateHostSource, checkPropInSource } from "../scripts/verify-host-wiring.mjs";
import { applicableChecklist, evaluateChecklistDoc } from "../scripts/mechanism-checklist.mjs";
import { goldenPathProblems } from "../scripts/golden-path-check.mjs";
import { findRegressions, fingerprintBlock } from "../scripts/regression-guard.mjs";
import { selectorMatchesSnapshots, repairSelector, repairDrive } from "../scripts/drive-repair.mjs";
import { skeletonProblems } from "../scripts/skeleton-check.mjs";
import { SNAPSHOT_FN } from "../scripts/dom-snapshot.mjs";
import { calibrateJudgeValidation } from "./judge-validation.mjs";
import { calibrateDefectContract } from "./defect-contract.mjs";
import { calibrateCompiledOracle } from "./compiled-oracle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


const CALIB_DIR = path.join(ROOT, "golden", "calibration");
const CALIB_LAYOUT_DIR = path.join(ROOT, "golden", "calibration-layout");

// Calibrate the measurement Judge engine: a known-GOOD render (vs the velt-harvey-demo spec)
// must PASS, a known-BAD render must FAIL with named diffs. Proves the delta engine is strict.
async function calibrateJudge() {
  const spec = JSON.parse(await fs.readFile(path.join(CALIB_DIR, "spec.json"), "utf8"));
  const run = async (file) => {
    const rendered = JSON.parse(await fs.readFile(path.join(CALIB_DIR, file), "utf8"));
    const els = spec.map((s, i) => ({
      name: s.name,
      present: rendered[i]?.present !== false,
      table: rendered[i]?.present === false ? [] : compareDecls(s.expected, rendered[i].rendered || {}),
    }));
    return verdictOf(els);
  };
  const good = await run("rendered-good.json");
  const bad = await run("rendered-bad.json");
  const problems = [];
  if (good.verdict !== "PASS") problems.push(`known-GOOD render should PASS but got ${good.verdict}: ${JSON.stringify(good.diffs)}`);
  if (bad.verdict !== "FAIL") problems.push(`known-BAD render should FAIL but got ${bad.verdict}`);
  if (bad.diffs.length < 3) problems.push(`known-BAD render should surface multiple named diffs, got ${bad.diffs.length}`);
  if (problems.length) { for (const p of problems) console.error("  ✗ judge-calibration: " + p); return false; }
  console.log(`✓ Judge engine calibrated — GOOD render PASSes; BAD render FAILs with ${bad.diffs.length} named diffs (${bad.diffs.map((d) => d.element + "/" + d.property).slice(0, 4).join(", ")}…)`);
  return true;
}

// Calibrate the WHOLE-SURFACE layout engine: a render with CORRECT per-element styles but
// WRONG geometry (blown card gap, over-indented message, time before name, hover actions
// missing) must FAIL. This is the exact M5 blind spot — styles pass, surface is broken.
async function calibrateLayout() {
  const spec = JSON.parse(await fs.readFile(path.join(CALIB_LAYOUT_DIR, "spec.json"), "utf8"));
  const opts = { relations: spec.relations, gaps: spec.gaps, tol: spec.tol };
  const run = async (file) => {
    const rendered = JSON.parse(await fs.readFile(path.join(CALIB_LAYOUT_DIR, file), "utf8"));
    const els = spec.elements.map((s, i) => ({
      name: s.name,
      present: rendered[i]?.present !== false,
      table: rendered[i]?.present === false ? [] : compareDecls(s.expected || {}, rendered[i].rendered || {}),
      box: rendered[i]?.box,
      expectedBox: s.box,
    }));
    return verdictOf(els, opts);
  };
  const good = await run("rendered-good.json");
  const bad = await run("rendered-bad.json");
  const problems = [];
  if (good.verdict !== "PASS") problems.push(`good-geometry render should PASS but got ${good.verdict}: ${JSON.stringify(good.diffs)}`);
  if (bad.verdict !== "FAIL") problems.push(`bad-geometry render (correct styles!) should FAIL but got ${bad.verdict}`);
  // must catch a gap diff, a position diff, a broken relation, AND a missing element — the four M-findings
  const kinds = new Set(bad.diffs.map((d) => (d.property || "").split(".")[0]));
  for (const need of ["gap", "box", "relation", "(present)"]) {
    if (![...kinds].some((k) => k === need || k.startsWith(need))) problems.push(`bad-geometry render should surface a '${need}' diff; got kinds [${[...kinds].join(", ")}]`);
  }
  if (problems.length) { for (const p of problems) console.error("  ✗ layout-calibration: " + p); return false; }
  console.log(`✓ Layout engine calibrated — good geometry PASSes; correct-styles+broken-geometry FAILs with ${bad.diffs.length} diffs across gap/box/relation/missing (${[...kinds].join(", ")})`);
  return true;
}

// Calibrate the LAYERED icon resolver (S3): a named filter/kebab icon COMPONENT with NO adjacent
// label (exactly the M2a miss) must now assign via the name/component-signal layer; a labelled
// icon assigns via nearText; a truly anonymous icon must fall to UNASSIGNED with a render-and-
// recognize candidate shortlist (never silently guessed).
async function calibrateIconResolver() {
  const icons = [
    { id: "f1", name: "filterIcon", type: "INSTANCE", isComponent: true, label: null, ancestry: ["Header"], box: { w: 24, h: 24 } },
    { id: "k1", name: "more", type: "INSTANCE", isComponent: true, label: null, ancestry: ["CommentCard"], box: { w: 24, h: 24 } },
    { id: "r1", name: "vector", type: "VECTOR", isComponent: false, label: "Reply", ancestry: ["Card"], box: { w: 16, h: 16 } },
    { id: "e1", name: "vector", type: "VECTOR", isComponent: false, label: "Edit", ancestry: ["Menu"], box: { w: 16, h: 16 } },
    { id: "x1", name: "vector", type: "VECTOR", isComponent: false, label: null, ancestry: ["Mystery"], box: { w: 16, h: 16 } },
  ];
  const assets = icons.map((i) => ({ nodeId: i.id, file: `assets/${i.id}.svg` }));
  const { assignments, unassigned } = await assignIcons(icons, assets);
  const problems = [];
  const filter = assignments["VeltCommentsSidebarWireframe.MinimalFilterDropdown.Trigger"];
  const kebab = assignments["VeltCommentDialogWireframe.ThreadCard.Options.Trigger"];
  if (!filter || !/nameSignal/.test(filter.by)) problems.push(`M2a filter icon must assign via name/component-signal; got ${JSON.stringify(filter)}`);
  if (!kebab || !/nameSignal/.test(kebab.by)) problems.push(`M2a kebab icon must assign via name/component-signal; got ${JSON.stringify(kebab)}`);
  const reply = assignments["VeltCommentDialogWireframe.ThreadCard.Reply"];
  if (!reply || !/nearText/.test(reply.by)) problems.push(`labelled reply icon must assign via nearText; got ${JSON.stringify(reply)}`);
  const rr = unassigned.filter((u) => u.renderRecognize && Array.isArray(u.candidates) && u.candidates.length);
  if (!rr.length) problems.push(`a truly anonymous icon slot should be UNASSIGNED with a render-recognize candidate shortlist; got ${JSON.stringify(unassigned)}`);
  if (problems.length) { for (const p of problems) console.error("  ✗ icon-resolver-calibration: " + p); return false; }
  console.log(`✓ Icon resolver calibrated — filter+kebab assign by name-signal (M2a fix), reply by nearText, anonymous → render-recognize shortlist (${rr.length} slot(s))`);
  return true;
}

// Calibrate the ACTUAL injected probe STRING (not the imported helpers). The Judge ships
// `BROWSER_PROBE` into the page via the Cursor browser tool; if any module-scope identifier the
// toString-assembled functions close over (e.g. `nums`) isn't inlined, the probe throws at
// runtime and the importing tests never notice. So execute the real string against a tiny
// fake DOM (no deps) and assert it runs end-to-end on style (length!) + layout.
// Lock the cssClasses gap fix: the leaf slots the Judge actually measures must carry a stable
// manifest selector (a real Velt class), not rely entirely on the Builder's build-time .hw-*.
async function calibrateManifestSelectors() {
  const m = JSON.parse(await fs.readFile(path.join(ROOT, "manifest", "velt-codeconnect.json"), "utf8"));
  const want = {
    "VeltCommentDialogWireframe.ThreadCard.Name": "velt-thread-card--name",
    "VeltCommentDialogWireframe.ThreadCard.Time": "velt-thread-card--time",
    "VeltCommentDialogWireframe.ThreadCard.Message": "velt-thread-card--message",
    "VeltCommentDialogWireframe.ThreadCard.Avatar": "s-user-avatar-container",
  };
  const byPath = {};
  for (const c of Object.values(m.components)) for (const s of c.slots || []) byPath[s.reactPath] = s;
  const problems = [];
  for (const [rp, cls] of Object.entries(want)) {
    const s = byPath[rp];
    if (!s) { problems.push(`measured slot ${rp} missing from manifest`); continue; }
    if (!s.cssClasses || !s.cssClasses.includes(cls)) problems.push(`measured slot ${rp} must carry cssClass '${cls}'; got ${JSON.stringify(s.cssClasses)}`);
  }
  if (problems.length) { for (const p of problems) console.error("  ✗ manifest-selector-calibration: " + p); return false; }
  console.log(`✓ Manifest selectors calibrated — the measured leaf slots (name/time/message/avatar…) carry stable Velt classes, not just builder .hw-* fallbacks`);
  return true;
}

// Calibrate box normalization (Fix 2): designSpec boxes must come out surface-relative so they're
// comparable to the probe's getBoundingClientRect-minus-surface-root measurement. Root -> (0,0),
// children relative; boxless / x-less (icon) nodes untouched.
function calibrateBoxNormalization() {
  const nodes = [
    { name: "root", box: { x: 500, y: 300, w: 354, h: 800 } },
    { name: "card", box: { x: 516, y: 312, w: 322, h: 64 } },
    { name: "icon", box: { w: 24, h: 24 } },
    { name: "noBox", box: null },
  ];
  normalizeBoxes(nodes);
  const problems = [];
  const card = nodes[1].box;
  if (nodes[0].box.x !== 0 || nodes[0].box.y !== 0) problems.push(`root box should become (0,0); got ${JSON.stringify(nodes[0].box)}`);
  if (card.x !== 16 || card.y !== 12) problems.push(`card box should become surface-relative (16,12); got ${JSON.stringify(card)}`);
  if (nodes[2].box.w !== 24 || "x" in nodes[2].box) problems.push(`boxless/x-less icon node must be untouched; got ${JSON.stringify(nodes[2].box)}`);
  if (problems.length) { for (const p of problems) console.error("  ✗ box-normalization-calibration: " + p); return false; }
  console.log(`✓ Box normalization calibrated — designSpec boxes emitted surface-relative (root→0,0; child→16,12; icons untouched)`);
  return true;
}

// Calibrate layer reconciliation (the Figma-node=1-rect vs DOM=N-layers problem). Pure logic:
// a co-box wrapper that paints padding+bg must land in `neutralize`; a wrong-box owner trips
// `ownerMismatch`; functional-only CSS is NOT flagged. Then EXECUTE LAYER_PROBE on a fake DOM with
// a real parent chain (owner inside a co-box wrapper that has padding+bg) and assert it detects it.
// Calibrate the mount-map contract oracle (the functional veto). Pure: a missing required part,
// a part outside its required ancestor, a duplicated singleton, and a phantom interactive each
// produce a violation; a well-formed map is ok. Then EXECUTE CONTRACT_PROBE on a fake DOM with a
// real ancestry + a bare non-velt button and assert it reads the map + flags the phantom.
function calibrateContractOracle() {
  const problems = [];
  const expected = [
    { part: "ThreadCard", selector: ".tc", requiredAncestor: ".threads", singleton: false },
    { part: "Composer", selector: ".composer", requiredAncestor: null, singleton: true },
    { part: "Reply", selector: ".reply", requiredAncestor: ".tc", singleton: false },
  ];
  // pure: all good
  const good = mountMapDiff(expected, { parts: { ThreadCard: { present: true, count: 3, ancestorOk: true }, Composer: { present: true, count: 1, ancestorOk: true }, Reply: { present: true, count: 3, ancestorOk: true } }, phantoms: [] });
  if (!good.ok) problems.push(`well-formed mount map should be ok; got ${JSON.stringify(good.violations)}`);
  // pure: each failure kind
  const bad = mountMapDiff(expected, {
    parts: { ThreadCard: { present: false, count: 0, ancestorOk: true }, Composer: { present: true, count: 2, ancestorOk: true }, Reply: { present: true, count: 1, ancestorOk: false } },
    phantoms: [{ what: "button", where: "hw-fake-resolve" }],
  });
  const kinds = new Set(bad.violations.map((v) => v.kind));
  for (const need of ["MISSING", "CARDINALITY", "CONTAINMENT", "PHANTOM_INTERACTIVE"]) if (!kinds.has(need)) problems.push(`mount-map diff should surface ${need}; got [${[...kinds].join(", ")}]`);
  if (bad.ok) problems.push(`a broken mount map must NOT be ok`);

  // execute the real CONTRACT_PROBE: a phantom <button> (no velt ancestor) inside the surface
  const mkEl = (tag, className, r, parent) => ({ tagName: tag, className, _r: r, parentElement: parent || null, children: [], getBoundingClientRect() { return this._r; }, closest(sel) { let n = this; const want = sel.replace(/^\./, ""); while (n) { if ((n.className || "").split(/\s+/).includes(want) || (n.tagName || "").toLowerCase() === sel.toLowerCase()) return n; n = n.parentElement; } return null; } });
  const rect = (w, h) => ({ left: 0, top: 0, width: w, height: h });
  const surf = mkEl("div", "hw-rail-inner", rect(300, 400), null);
  const veltCard = mkEl("velt-comment-dialog-thread-card-wireframe", "velt-thread-card", rect(300, 64), surf);
  const phantomBtn = mkEl("button", "hw-fake-resolve", rect(24, 24), surf); // bare, no velt ancestor
  const all = { ".hw-rail-inner": [surf], ".tc": [veltCard], "button,[role=\"button\"],[role=\"menuitem\"],[role=\"checkbox\"],[tabindex]": [phantomBtn] };
  const doc = {
    querySelector: (sel) => (all[sel] || [])[0] || null,
    querySelectorAll: (sel) => all[sel] || [],
  };
  // surf.querySelectorAll must return the phantom button for the scan
  surf.querySelectorAll = (sel) => all['button,[role="button"],[role="menuitem"],[role="checkbox"],[tabindex]'] || [];
  let cplan;
  try {
    const run = new Function("document", "SPEC", "return (" + CONTRACT_PROBE + ")(SPEC);");
    cplan = run(doc, { surfaceSelector: ".hw-rail-inner", entries: [{ part: "ThreadCard", selector: ".tc", requiredAncestor: null, singleton: false }] });
  } catch (e) { problems.push("CONTRACT_PROBE threw at runtime: " + e.message); }
  if (cplan && (cplan.ok !== false || !cplan.violations.some((v) => v.kind === "PHANTOM_INTERACTIVE"))) problems.push(`CONTRACT_PROBE should flag the bare non-velt <button> as PHANTOM_INTERACTIVE; got ${JSON.stringify(cplan)}`);

  if (problems.length) { for (const p of problems) console.error("  ✗ contract-oracle-calibration: " + p); return false; }
  console.log(`✓ Contract oracle calibrated — mount-map diff surfaces MISSING/CONTAINMENT/CARDINALITY/PHANTOM; CONTRACT_PROBE reads the live map and flags a non-velt phantom button (boolean veto, no score)`);
  return true;
}

function calibrateLayerReconciliation() {
  const problems = [];
  const nzProps = (plan, cls) => { const e = (plan.neutralize || []).find((n) => (n.classes || "").indexOf(cls) >= 0); return e ? e.props : []; };
  const applyTo = (plan, prop) => { const a = (plan.apply || []).find((x) => x.prop === prop); return a ? a.target : null; };

  // PER-PROPERTY: a wrapper that compounds padding (owner ALSO has padding) gets padding zeroed, but
  // its SOLE background (design wants it, owner doesn't paint it) is KEPT — same wrapper, two verdicts.
  const p1 = reconcilePlan({
    owner: { box: { w: 300, h: 64 }, styles: { padding: "10px 10px 10px 10px" } },
    expectedBox: { w: 300, h: 64 }, tol: { size: 2 }, designPaint: { padding: "10px", background: "#fff" },
    layers: [{ classes: "velt-sidebar-container", clip: false, styles: { padding: "16px 16px 16px 16px", background: "rgb(255, 255, 255)" } }],
  });
  if (!nzProps(p1, "velt-sidebar-container").includes("padding")) problems.push(`compounding padding on the wrapper should be neutralized; got ${JSON.stringify(p1.neutralize)}`);
  if (nzProps(p1, "velt-sidebar-container").includes("background")) problems.push(`the wrapper's SOLE background (design wants it) must NOT be neutralized; got ${JSON.stringify(p1.neutralize)}`);
  if (applyTo(p1, "padding") !== "owner") problems.push(`padding apply-target should be owner; got ${applyTo(p1, "padding")}`);
  if (applyTo(p1, "background") !== "velt-sidebar-container") problems.push(`background should be applied to the cooperating wrapper; got ${applyTo(p1, "background")}`);

  // COOPERATING / CLIP-COUPLING: outer clip layer (radius+overflow) + inner bg owner; design wants both
  // → NOTHING neutralized; radius applied to the clipper, bg to the owner (the user's exact case).
  const p2 = reconcilePlan({
    owner: { box: { w: 300, h: 64 }, styles: { background: "rgb(255, 255, 255)" } },
    expectedBox: { w: 300, h: 64 }, tol: { size: 2 }, designPaint: { background: "#fff", "border-radius": "8px" },
    layers: [{ classes: "velt-clip", clip: true, styles: { "border-radius": "8px" } }],
  });
  if (!p2.ok || p2.neutralize.length) problems.push(`cooperating clip+bg layers must NOT be neutralized (ok=true); got ${JSON.stringify(p2)}`);
  if (applyTo(p2, "border-radius") !== "velt-clip" || applyTo(p2, "background") !== "owner") problems.push(`radius→clip layer, bg→owner; got radius=${applyTo(p2, "border-radius")} bg=${applyTo(p2, "background")}`);

  // wrong layer styled (R23) — owner box != design node box
  const p3 = reconcilePlan({ owner: { box: { w: 210, h: 210 } }, expectedBox: { w: 24, h: 24 }, tol: { size: 2 }, layers: [] });
  if (!p3.ownerMismatch) problems.push(`owner box (210x210) != design node (24x24) should set ownerMismatch; got ${JSON.stringify(p3)}`);

  // execute the REAL LAYER_PROBE string on a fake DOM with a parent chain — both compounding + cooperating
  const paintS = (over) => Object.assign({ paddingTop: "0px", paddingRight: "0px", paddingBottom: "0px", paddingLeft: "0px", marginTop: "0px", marginRight: "0px", marginBottom: "0px", marginLeft: "0px", backgroundColor: "rgba(0, 0, 0, 0)", borderTopWidth: "0px", borderTopStyle: "none", borderTopColor: "rgb(0, 0, 0)", borderTopLeftRadius: "0px", overflow: "visible" }, over || {});
  const mkEl = (className, r, s, parent) => ({ className, _r: r, _s: s, parentElement: parent || null, getBoundingClientRect() { return this._r; } });
  const rect = (x, y, w, h) => ({ left: x, top: y, width: w, height: h });
  const gcs = (n) => Object.assign({ getPropertyValue: (p) => n._s[p] || "" }, n._s);
  const run = new Function("document", "getComputedStyle", "SPEC", "return (" + LAYER_PROBE + ")(SPEC);");

  // cooperating in the DOM: .velt-clip (radius+overflow:hidden) wraps .hw-card (bg). design wants both.
  let dplan;
  try {
    const surf = mkEl("surf", rect(0, 0, 300, 200), paintS(), null);
    const clip = mkEl("velt-clip", rect(0, 0, 300, 64), paintS({ borderTopLeftRadius: "8px", overflow: "hidden" }), surf);
    const card = mkEl("hw-card", rect(0, 0, 300, 64), paintS({ backgroundColor: "rgb(255, 255, 255)" }), clip);
    const doc = { querySelectorAll: (sel) => ({ ".surf": [surf], ".hw-card": [card] }[sel] || []) };
    dplan = run(doc, gcs, { surfaceSelector: ".surf", ownerSelector: ".hw-card", expectedBox: { x: 0, y: 0, w: 300, h: 64 }, designPaint: { background: "#fff", "border-radius": "8px" }, tol: { size: 2 } });
  } catch (e) { problems.push("LAYER_PROBE string threw at runtime (closure missing): " + e.message); }
  if (dplan && (!dplan.found || dplan.layerCount !== 1 || !dplan.ok || dplan.neutralize.length)) problems.push(`LAYER_PROBE on cooperating clip+bg DOM should be ok (no neutralize); got ${JSON.stringify(dplan)}`);
  if (dplan && applyTo(dplan, "border-radius") !== "velt-clip") problems.push(`LAYER_PROBE should apply radius to the clip layer; got ${JSON.stringify(dplan && dplan.apply)}`);

  if (problems.length) { for (const p of problems) console.error("  ✗ layer-reconciliation-calibration: " + p); return false; }
  console.log(`✓ Layer reconciliation calibrated — per-property: compounding padding neutralized while the same wrapper's sole bg is KEPT; clip+bg cooperating layers preserved (radius→clipper, bg→owner); ownerMismatch on wrong layer; LAYER_PROBE runs the cooperating case end-to-end`);
  return true;
}

function calibrateProbeRuntime() {
  const el = (className, rect, styles) => ({ className, _rect: rect, _styles: styles || {}, getBoundingClientRect() { return this._rect; } });
  const rect = (x, y, w, h) => ({ left: x, top: y, width: w, height: h });
  const mkDoc = (map) => ({ querySelectorAll: (sel) => map[sel] || [] });
  const mkGCS = () => (node) => Object.assign({ getPropertyValue: (p) => (node._styles[p] || "") }, node._styles);
  // assemble the real injected probe exactly as the Judge would: pass document + getComputedStyle as args
  const runProbe = new Function("document", "getComputedStyle", "SPEC", "return (" + BROWSER_PROBE + ")(SPEC);");

  const surf = el("surf", rect(0, 0, 300, 200), {});
  const spec = {
    surfaceSelector: ".surf",
    tol: { px: 1, dE: 2, pos: 3, size: 2, gap: 3 },
    elements: [
      // padding + border-radius are LEN_PROPS → they go through nums(); background through ciede2000
      { name: "card", selector: ".card", expected: { background: "#ffffff", padding: "8px", "border-radius": "8px" }, box: { x: 0, y: 0, w: 300, h: 64 } },
    ],
  };
  const goodStyles = { backgroundColor: "rgb(255, 255, 255)", padding: "8px", borderRadius: "8px" };
  const badStyles = { backgroundColor: "rgb(99, 102, 241)", padding: "16px", borderRadius: "0px" };

  const problems = [];
  let good, bad;
  try {
    good = runProbe(mkDoc({ ".surf": [surf], ".card": [el("card", rect(0, 0, 300, 64), goodStyles)] }), mkGCS(), spec);
    bad = runProbe(mkDoc({ ".surf": [surf], ".card": [el("card", rect(20, 0, 250, 64), badStyles)] }), mkGCS(), spec);
  } catch (e) {
    console.error("  ✗ probe-runtime-calibration: the INJECTED probe string threw at runtime — a closure var is missing (this is the nums-style bug): " + e.message);
    return false;
  }
  // gross-mismatch: a 2-element spec where one element is missing must trip the gross element-count check
  let gross;
  try {
    const grossSpec = { surfaceSelector: ".surf", elements: [
      { name: "a", selector: ".a", expected: {}, box: { x: 0, y: 0, w: 300, h: 64 } },
      { name: "b", selector: ".b", expected: {}, box: { x: 0, y: 72, w: 300, h: 64 } },
    ] };
    gross = runProbe(mkDoc({ ".surf": [surf], ".a": [el("a", rect(0, 0, 300, 64), {})] /* .b absent */ }), mkGCS(), grossSpec);
  } catch (e) { problems.push("gross-check run threw: " + e.message); }

  if (good.verdict !== "PASS") problems.push(`good render should PASS through the injected probe but got ${good.verdict}: ${JSON.stringify(good.diffs)}`);
  if (!good.gross || good.gross.ok !== true) problems.push(`good render should report gross.ok=true; got ${JSON.stringify(good.gross)}`);
  if (bad.verdict !== "FAIL") problems.push(`bad render (wrong padding/radius/colour + wrong box) should FAIL through the injected probe but got ${bad.verdict}`);
  if (gross && (gross.gross?.ok !== false || !(gross.diffs || []).some((d) => d.element === "(gross)" && d.property === "element-count"))) problems.push(`missing-element surface should trip the gross element-count check; got ${JSON.stringify(gross.gross)} / ${JSON.stringify(gross.diffs)}`);
  // must surface a length diff (the nums() path) AND a box diff — proves the runtime path covers both
  const props = new Set((bad.diffs || []).map((d) => d.property));
  if (![...props].some((p) => p === "padding" || p === "border-radius")) problems.push(`injected probe should surface a length diff (nums path); got ${[...props].join(", ")}`);
  if (![...props].some((p) => String(p).startsWith("box."))) problems.push(`injected probe should surface a box diff; got ${[...props].join(", ")}`);
  if (problems.length) { for (const p of problems) console.error("  ✗ probe-runtime-calibration: " + p); return false; }
  console.log(`✓ Injected probe calibrated — the REAL BROWSER_PROBE string runs end-to-end on a fake DOM: good→PASS, bad→FAIL with length(nums) + box diffs (${[...props].join(", ")})`);
  return true;
}

// Calibrate the interaction-transition gate (R27): the REAL STABILITY_PROBE string must catch a click
// target that SHIFTS when the transient (focus) state drops — the Send/Cancel-moves-mid-click bug — and
// verdict-gate-blocks must require the artifact on interactive blocks and FAIL on a moved target.
function calibrateStabilityGate() {
  const problems = [];
  // --- (A) the injected STABILITY_PROBE string runs end-to-end on a fake DOM ---
  // The blur the probe performs flips `dropped`, which moves the BAD target down 18px (the focus-keyed
  // "Reply" link reappearing). The GOOD target ignores it. boxOf reads x/y; vis() reads width.
  const mkProbe = () => new Function("document", "FocusEvent", "SPEC", "return (" + STABILITY_PROBE + ")(SPEC);");
  const FocusEventShim = function () {};
  function fakeDom(targetRectFn) {
    const dropped = { v: false };
    const input = { tagName: "DIV", getBoundingClientRect: () => ({ x: 0, y: 0, width: 200, height: 20 }),
      dispatchEvent() {}, blur() { dropped.v = true; } };
    const send = { tagName: "BUTTON", getBoundingClientRect: () => targetRectFn(dropped.v) };
    const surf = { contains: () => true, querySelectorAll: () => [input] };
    const bySel = { ".send": [send], ".surf": [surf], "[contenteditable],input,textarea": [input] };
    const document = {
      activeElement: input, body: { offsetHeight: 0 },
      querySelector: (s) => (bySel[s] ? bySel[s][0] : null),
      querySelectorAll: (s) => bySel[s] || [],
    };
    return document;
  }
  const spec = { surfaceSelector: ".surf", targets: [{ name: "Send", selector: ".send" }], tol: 1 };
  let stable, moves;
  try {
    stable = mkProbe()(fakeDom(() => ({ x: 100, y: 100, width: 60, height: 28 })), FocusEventShim, spec);
    moves = mkProbe()(fakeDom((d) => ({ x: 100, y: d ? 118 : 100, width: 60, height: 28 })), FocusEventShim, spec);
  } catch (e) {
    console.error("  ✗ stability-calibration: the INJECTED STABILITY_PROBE string threw at runtime — a free var is missing: " + e.message);
    return false;
  }
  if (!stable.ok) problems.push(`a target that holds still must be ok=true; got ${JSON.stringify(stable.targets)}`);
  if (moves.ok) problems.push(`a target that shifts on focus-drop must be ok=false; got ok=true`);
  if (moves.ok === false && !(moves.targets[0] && moves.targets[0].shift && moves.targets[0].shift.dy === 18))
    problems.push(`the moved target must report its 18px dy; got ${JSON.stringify(moves.targets[0])}`);

  // --- (B) verdict-gate-blocks: EVERY block needs a stability result; a moved target FAILs (general) ---
  const base = (extra) => ({ built: true, driven: true, visualDiff: { diffPct: 0, regions: [] }, deltaCompare: { ok: true, diffs: [], checked: ["name", "message"], gaps: [] }, ...extra });
  const okStab = { stability: { ok: true, targets: [] } };                                  // surface with no affordance
  const movedStab = { stability: { ok: false, targets: [{ name: "Send", shift: { dx: 0, dy: 18 }, ok: false }] } };
  const blocks = { blocks: [{ id: "a", state: "default" }, { id: "b", state: "hover" }] };
  // a missing stability result anywhere ⇒ INCOMPLETE (the check was skipped, not passed)
  const missingStab = verdictGateBlocks(blocks, { blocks: { a: base(okStab), b: base() } });
  if (missingStab.verdict !== "INCOMPLETE" || !missingStab.missing.some((m) => /stability/.test(m)))
    problems.push(`a block with no stability result must be INCOMPLETE (named); got ${missingStab.verdict}`);
  // a moved target ⇒ FAIL (named)
  const moved = verdictGateBlocks(blocks, { blocks: { a: base(okStab), b: base(movedStab) } });
  if (moved.verdict !== "FAIL" || !moved.failures.some((f) => /shifts/.test(f))) problems.push(`a moved target must FAIL (named); got ${moved.verdict}`);
  // every block records stability + all stable ⇒ PASS, including the no-affordance {ok:true,targets:[]} case
  const clean = verdictGateBlocks(blocks, { blocks: { a: base(okStab), b: base({ stability: { ok: true, targets: [{ name: "Send", shift: { dx: 0, dy: 0 }, ok: true }] } }) } });
  if (clean.verdict !== "PASS") problems.push(`all blocks stable (incl. an empty-targets one) must PASS; got ${clean.verdict}`);

  if (problems.length) { for (const p of problems) console.error("  ✗ stability-calibration: " + p); return false; }
  console.log(`✓ Stability gate calibrated — the REAL STABILITY_PROBE catches an 18px focus-drop shift (still→ok, moves→FAIL); verdict-gate-blocks requires a stability result on EVERY block (missing→INCOMPLETE) and FAILs a moved target (R27)`);
  return true;
}

// Calibrate the MECHANICAL terminator (#2): a Judge report that SAMPLES — covers fewer checklist
// elements than were generated, even if every sampled element passes — must be INCOMPLETE, never
// PASS. This is the structural fix for the M5 failure: "5 of 8 measured, all 5 pass → done" is now
// unreachable because coverage is checked, not trusted. Also: a missing visual artifact ⇒ INCOMPLETE.
function calibrateVerdictGate() {
  const checklist = {
    elements: [{ id: "style-1" }, { id: "style-2" }, { id: "style-3" }, { id: "mention" }],
    mustSupply: [{ id: "supply:Reply" }],
    states: ["default", "hover"],
    requiredArtifacts: ["visualSideBySide"],
  };
  const cleanState = (diffs = []) => ({
    dispositions: { "style-1": { status: "pass" }, "style-2": { status: "pass" }, "style-3": { status: "pass" }, mention: { status: "pass" } },
    mustSupply: { "supply:Reply": "pass" },
    reconciliation: { ok: true }, contract: { ok: true },
    visualSideBySide: { figmaRef: "design.png", liveShot: "live.png", namedDifferences: diffs },
  });
  const problems = [];

  // (0) GENERATOR: distinct styled appearances (incl. a teal mention) are derived from the designSpec —
  // the design's full style set, not a hand-picked subset (the anti-sampling source).
  const gen = buildChecklist(
    { nodes: [
      { type: "TEXT", name: "name", cssDecls: { color: "#1a1917", "font-size": "14px", "font-weight": "500" }, text: "Wilson" },
      { type: "TEXT", name: "mention", cssDecls: { color: "#227277", "font-size": "14px" }, text: "@aaliyah" },
      { type: "TEXT", name: "name2", cssDecls: { color: "#1a1917", "font-size": "14px", "font-weight": "500" }, text: "Wilson" },
      { type: "FRAME", name: "layoutOnly", cssDecls: { display: "flex", gap: "8px" } },
    ] },
    { components: {} }
  );
  if (gen.elements.length !== 2) problems.push(`generator should dedup to 2 distinct styled appearances (name + mention), got ${gen.elements.length}`);
  if (!gen.elements.some((e) => JSON.stringify(e.expected).includes("227277"))) problems.push(`generator must include the teal mention style (the one a sampling Judge omits)`);
  if (gen.elements.some((e) => JSON.stringify(e.expected).includes("flex"))) problems.push(`generator should skip layout-only (non-painting) nodes`);

  // (1) SAMPLING: covers style-1/2/3 + mention BUT actually omit `mention` (the M5 case) → INCOMPLETE
  const sampled = JSON.parse(JSON.stringify({ states: { default: cleanState(), hover: cleanState() } }));
  delete sampled.states.default.dispositions.mention; // the sampled-out style
  const rSample = verdictGate(checklist, sampled);
  if (rSample.verdict !== "INCOMPLETE") problems.push(`a report that samples out an element (all measured ones pass) must be INCOMPLETE, got ${rSample.verdict}`);
  if (!rSample.missing.some((m) => m.includes("mention"))) problems.push(`INCOMPLETE must name the sampled-out element; got ${JSON.stringify(rSample.missing)}`);

  // (2) MISSING VISUAL ARTIFACT → INCOMPLETE even with full element coverage
  const noVisual = { states: { default: { ...cleanState(), visualSideBySide: undefined }, hover: cleanState() } };
  if (verdictGate(checklist, noVisual).verdict !== "INCOMPLETE") problems.push(`a missing visual side-by-side must be INCOMPLETE`);

  // (3) MISSING STATE → INCOMPLETE
  if (verdictGate(checklist, { states: { default: cleanState() } }).verdict !== "INCOMPLETE") problems.push(`a skipped required state must be INCOMPLETE`);

  // (4) FULL + CLEAN → PASS
  const full = { states: { default: cleanState(), hover: cleanState() } };
  if (verdictGate(checklist, full).verdict !== "PASS") problems.push(`full coverage + clean must PASS; got ${verdictGate(checklist, full).verdict}`);

  // (5) FULL but a named visual difference → FAIL (not INCOMPLETE)
  const withDiff = { states: { default: cleanState(["mention chip still purple, design is teal"]), hover: cleanState() } };
  if (verdictGate(checklist, withDiff).verdict !== "FAIL") problems.push(`full coverage with a named visual diff must FAIL`);

  if (problems.length) { for (const p of problems) console.error("  ✗ verdict-gate-calibration: " + p); return false; }
  console.log(`✓ Verdict gate calibrated — sampling → INCOMPLETE (named), missing artifact/state → INCOMPLETE, full+clean → PASS, full+diff → FAIL: "passed on a sample" is structurally unreachable`);
  return true;
}

// Content-independent verification (the design is DUMMY data, the app is REAL data — 2 vs 11 cards,
// different text/names/times): verdictGateBlocks must (a) NOT fail on whole-surface pixel regions (they
// reflect data, not defects) while deltaCompare stays the AUTHORITY; (b) reject a delta spec that covered
// too little (checked<2, or no inter-card gap on a list surface) as INCOMPLETE — "certify by checking
// nothing" is structurally unreachable; (c) still honour a dataMatched capture as a valid pixel compare.
function calibrateContentIndependentGate() {
  const problems = [];
  const listBlocks = { blocks: [{ id: "b1", state: "default", role: "flow", familyId: "flows", component: "Sidebar" }] };
  const mk = (over = {}) => ({ built: true, driven: true, capturePng: "c.png", framePng: "f.png",
    visualDiff: { diffPct: 2.0, regions: [{ cssBox: "x", fill: 0.6 }] },  // big pixel region = live data ≠ design mock
    deltaCompare: { ok: true, diffs: [], checked: ["name", "time", "msg"], gaps: [{ a: "c1", b: "c2", axis: "y", expected: 12 }] },
    stability: { ok: true, targets: [] }, artifacts: {}, ...over });

  // (1) big pixel region but delta covered + gap ⇒ PASS (pixel-diff is advisory vs dummy data) — the RUN-3 false-fail
  const advisory = verdictGateBlocks(listBlocks, { blocks: { b1: mk() } });
  if (advisory.verdict !== "PASS") problems.push(`a big pixel region with delta covered+gap must PASS (pixel advisory); got ${advisory.verdict}`);
  if (!(advisory.advisories || []).length) problems.push(`the pixel region must be surfaced as an advisory`);

  // (2) thin delta spec (checked<2) ⇒ INCOMPLETE (a surface can't certify by checking nothing)
  const thin = verdictGateBlocks(listBlocks, { blocks: { b1: mk({ deltaCompare: { ok: true, diffs: [], checked: ["name"], gaps: [] } }) } });
  if (thin.verdict !== "INCOMPLETE" || !thin.missing.some((m) => /too thin/.test(m))) problems.push(`a thin delta spec (checked<2) must be INCOMPLETE (named); got ${thin.verdict}`);

  // (3) list surface with covered elements but NO inter-card gap ⇒ INCOMPLETE (the 2-vs-11 blind spot)
  const noGap = verdictGateBlocks(listBlocks, { blocks: { b1: mk({ deltaCompare: { ok: true, diffs: [], checked: ["name", "time", "msg"], gaps: [] } }) } });
  if (noGap.verdict !== "INCOMPLETE" || !noGap.missing.some((m) => /gap/.test(m))) problems.push(`a list surface with no inter-card gap must be INCOMPLETE (named); got ${noGap.verdict}`);

  // (4) a real style defect (delta FAIL) still FAILs — the content-independent authority bites
  const deltaFail = verdictGateBlocks(listBlocks, { blocks: { b1: mk({ deltaCompare: { ok: false, diffs: [{ element: "reactions", property: "icon", note: "thumbsup missing" }], checked: ["name", "time", "msg", "reactions"], gaps: [{ a: "c1", b: "c2", axis: "y", expected: 12 }] } }) } });
  if (deltaFail.verdict !== "FAIL") problems.push(`a delta-compare failure must FAIL (authority); got ${deltaFail.verdict}`);

  // (5) a dataMatched capture re-enables pixel gating (valid comparison against matched fixture data)
  const dmBlocks = { blocks: [{ id: "b1", state: "default", role: "state", familyId: "fam", component: "Card", dataMatched: true }] };
  const dm = verdictGateBlocks(dmBlocks, { blocks: { b1: mk({ deltaCompare: { ok: true, diffs: [], checked: ["a", "b"], gaps: [] } }) } });
  if (dm.verdict !== "FAIL") problems.push(`a dataMatched capture with a pixel region must FAIL (valid pixel compare); got ${dm.verdict}`);

  if (problems.length) { for (const p of problems) console.error("  ✗ content-independent-gate: " + p); return false; }
  console.log(`✓ Content-independent gate calibrated — pixel-diff advisory (data≠design), deltaCompare authority, thin spec / missing inter-card gap ⇒ INCOMPLETE, dataMatched re-enables pixel gating`);
  return true;
}

// Calibrate the TWO-PHASE planning gates (loop1 fix set):
// (a) a style-plan selector whose tokens exist in NO dom-snapshot must be caught by the style lint
//     (a guessed selector binds to nothing and fails silently — half of a verified run's defects);
// (b) the snapshot's overlap scan (executed as the REAL injected string on a fake DOM) must catch a
//     planted extra glyph — the source the suppression rows are built from;
// (c) a plan-style value that CONFLICTS with its cited spec node must emit a plan-error(style)
//     conflict (the '#f1efec paraphrase' failure class — decls are verbatim, never paraphrased).
function calibrateTwoPhase() {
  const problems = [];

  // (a) selector-reality lint
  const snapshots = [{
    tree: {
      tag: "velt-comments-sidebar-wireframe", classes: ["velt-sidebar"], box: { x: 0, y: 0, w: 354, h: 800 }, visible: true, paints: {},
      children: [
        { tag: "div", classes: ["vc-card", "velt-thread-card"], box: { x: 0, y: 0, w: 322, h: 64 }, visible: true, paints: {}, children: [] },
      ],
    },
  }];
  const corpus = snapshotCorpus(snapshots);
  if (selectorTokensExist(".vc-card:hover", corpus).length) problems.push("a REAL snapshot selector (.vc-card:hover) must pass the token check");
  if (selectorTokensExist("velt-comments-sidebar-wireframe .velt-thread-card", corpus).length) problems.push("a real tag+class combo must pass the token check");
  const missing = selectorTokensExist(".velt-guessed-internal > .vc-card", corpus);
  if (!missing.includes(".velt-guessed-internal")) problems.push(`a GUESSED selector must be caught with the missing token named; got ${JSON.stringify(missing)}`);

  // (b) the REAL snapshot string catches a planted extra glyph (overlap) + zero-size content
  const cs = (over) => Object.assign({ display: "block", visibility: "visible", opacity: "1", backgroundColor: "rgba(0, 0, 0, 0)", borderTopWidth: "0px", borderTopStyle: "none", borderTopColor: "rgb(0,0,0)", boxShadow: "none", outlineWidth: "0px", outlineStyle: "none", outlineColor: "rgb(0,0,0)", borderTopLeftRadius: "0px" }, over || {});
  const mkEl = (tag, classes, r, styles) => {
    const el = { tagName: tag.toUpperCase(), nodeType: 1, classList: classes, id: "", _r: r, _s: cs(styles), children: [], childNodes: [],
      getBoundingClientRect() { return this._r; }, querySelectorAll: () => [] };
    return el;
  };
  const rect = (x, y, w, h) => ({ left: x, top: y, width: w, height: h });
  const surf = mkEl("div", ["vc-slot"], rect(0, 0, 100, 40));
  const designGlyph = mkEl("svg", ["vc-send-icon"], rect(10, 10, 16, 16));
  const defaultGlyph = mkEl("svg", ["s-send-default"], rect(12, 10, 16, 16));   // planted extra — overlaps
  // planted DEFAULT-SPACING internal (the loop2 compounded-indent class): an SDK element with
  // non-zero computed padding must land in the defaultSpacing hint for a mandatory disposition.
  const spacedInternal = mkEl("div", ["velt-thread-card--message"], rect(0, 30, 100, 10), { paddingLeft: "48px", paddingTop: "0px", paddingRight: "0px", paddingBottom: "0px", marginTop: "12.8px" });
  surf.children = [designGlyph, defaultGlyph, spacedInternal];
  const doc = { querySelectorAll: (sel) => (sel === ".vc-slot" ? [surf] : []), querySelector: (sel) => (sel === ".vc-slot" ? surf : null) };
  const gcs = (n) => n._s;
  let snap;
  try {
    const run = new Function("document", "getComputedStyle", "sel", "depth", "return (" + SNAPSHOT_FN + ")(sel, depth);");
    snap = run(doc, gcs, ".vc-slot", 10);
  } catch (e) { problems.push("SNAPSHOT_FN string threw at runtime (free var missing): " + e.message); }
  if (snap && !(snap.hints && snap.hints.overlaps.length === 1)) problems.push(`the overlap scan must catch the planted extra glyph (1 overlap); got ${JSON.stringify(snap && snap.hints && snap.hints.overlaps)}`);
  const ds = snap && snap.hints && snap.hints.defaultSpacing;
  if (!(ds && ds.length === 1 && /velt-thread-card--message/.test(ds[0].selector) && /48px/.test(ds[0].spacing.padding || "")))
    problems.push(`the default-spacing scan must catch the planted SDK padding (velt-thread-card--message 48px, the loop2 compounded-indent class); got ${JSON.stringify(ds)}`);

  // (c) plan-vs-spec value conflict ⇒ plan-error(style) (the '#f1efec paraphrase' case)
  const specNode = { id: "369:29469", cssDecls: { background: "#ffffff", border: "1px solid #f1efec" } };
  const badRule = { selector: ".vc-composer", specNodeId: "369:29469", purpose: "style", decls: { background: "#f1efec" } };
  const conflicts = planSpecValueConflicts(badRule, specNode);
  if (conflicts.length !== 1 || conflicts[0].attribution !== "plan-error(style)" || conflicts[0].prop !== "background")
    problems.push(`the paraphrased bg must emit ONE plan-error(style) conflict on 'background'; got ${JSON.stringify(conflicts)}`);
  const goodRule = { selector: ".vc-composer", specNodeId: "369:29469", purpose: "style", decls: { background: "#FFFFFF", padding: "12px" } };
  if (planSpecValueConflicts(goodRule, specNode).length) problems.push("verbatim values (case-insensitive) + composed extra props must NOT conflict");
  const neutralizeRule = { selector: ".velt-wrapper", specNodeId: "369:29469", purpose: "neutralize-wrapper", decls: { background: "transparent" } };
  if (planSpecValueConflicts(neutralizeRule, specNode).length) problems.push("neutralize-wrapper rules are exempt from the verbatim check (their decls are the zeroing set)");

  // (d) structure-plan completeness: a leaf planned WITHOUT its container chain (the graded-trial
  //     gap class: List/Threads/ThreadCard missing while their leaves were planned) must be caught
  //     by name; the complete plan passes; own-markup pseudo-slots are flagged as hygiene.
  const miniManifest = { components: { VeltCommentDialogWireframe: {
    rootWireframe: "velt-comment-dialog-wireframe",
    slots: [
      { reactPath: "VeltCommentDialogWireframe.Threads", role: "container", tag: "velt-comment-dialog-threads-wireframe" },
      { reactPath: "VeltCommentDialogWireframe.ThreadCard", role: "container", tag: "velt-comment-dialog-thread-card-wireframe" },
      { reactPath: "VeltCommentDialogWireframe.ThreadCard.Name", role: "item", tag: "velt-comment-dialog-thread-card-name-wireframe" },
    ],
    contract: { parts: [{ part: "ThreadCard", selector: ".tc", requiredAncestorHint: "velt-comment-dialog-threads-wireframe" }] },
  } } };
  const gappyPlan = { components: [{ id: "dialog", veltComponents: { wireframe: "VeltCommentDialogWireframe" }, slots: [
    { slot: "VeltCommentDialogWireframe.ThreadCard.Name", fillWith: "name" },
    { slot: "VeltCommentDialogWireframe.header-title (own markup)", fillWith: "Comments" },
  ] }] };
  const gaps = planStructureProblems(gappyPlan, miniManifest);
  if (!gaps.some((p) => p.kind === "missing-container" && p.missing === "VeltCommentDialogWireframe.ThreadCard"))
    problems.push(`a leaf without its container chain must flag the missing container by name; got ${JSON.stringify(gaps)}`);
  if (!gaps.some((p) => p.kind === "not-a-slot")) problems.push("an own-markup pseudo-slot row must be flagged as not-a-slot hygiene");
  const fullPlan = { components: [{ id: "dialog", veltComponents: { wireframe: "VeltCommentDialogWireframe" }, slots: [
    { slot: "VeltCommentDialogWireframe.Threads" },
    { slot: "VeltCommentDialogWireframe.ThreadCard" },
    { slot: "VeltCommentDialogWireframe.ThreadCard.Name", fillWith: "name" },
  ] }] };
  if (planStructureProblems(fullPlan, miniManifest).length) problems.push(`a complete container chain must pass; got ${JSON.stringify(planStructureProblems(fullPlan, miniManifest))}`);

  // (e) drive verify-and-repair (the build-structure trial class: 5/8 planner drives dead against
  //     the REAL DOM, every fix derivable from the snapshot) — a nesting-wrong descendant selector
  //     must repair to its matching suffix; a comment-only eval stub must be removed; a truly-dead
  //     .vc- selector must be unrepairable; host-app chrome must be exempt (outside the snapshot).
  const driveSnap = [{ tree: {
    tag: "div", classes: ["vc-list"], children: [
      { tag: "div", classes: ["vc-card"], children: [] },
      { tag: "div", classes: ["vc-reply"], children: [] },   // Body-level sibling, NOT card-nested
    ],
  } }];
  if (!selectorMatchesSnapshots(".vc-list .vc-reply", driveSnap)) problems.push("a real descendant chain must match the snapshot tree");
  if (selectorMatchesSnapshots(".vc-card .vc-reply", driveSnap)) problems.push("a nesting-WRONG chain (.vc-card .vc-reply when Reply is a sibling) must NOT match");
  const driveBrief = { drive: { steps: [
    { action: "click", selector: ".hw-sidebar-toggle" },
    { action: "eval", js: "/* assumed→verify-live: seed 1 reply */" },
    { action: "waitFor", selector: ".vc-list .vc-card ~ .vc-reply" },
  ], assert: ".vc-card .vc-reply" } };
  const driveRep = repairDrive(driveBrief, driveSnap);
  if (driveBrief.drive.assert !== ".vc-reply") problems.push(`the nesting-wrong assert must repair to its matching suffix '.vc-reply'; got '${driveBrief.drive.assert}'`);
  if (driveBrief.drive.steps.some((s) => s.action === "eval")) problems.push("a comment-only eval stub must be removed from the drive");
  if (driveRep.hostChrome.length !== 1) problems.push(`host-app chrome (.hw-sidebar-toggle) must be exempt, not failed; got ${JSON.stringify(driveRep.hostChrome)}`);
  if (repairSelector(".vc-card .velt-nonexistent", driveSnap)) problems.push("a truly-dead selector must stay unrepairable (never guessed)");

  // (f) skeleton-check (the loop2 build-structure classes): a planned class absent from the DOM
  //     must be caught; a class bound only to a 0-size twin must be caught; a design ROW rendered
  //     as a COLUMN (the stacked-header) must be caught; the correct skeleton passes.
  const skelPlan = { components: [{ slots: [
    { slot: "W.Header", vcClass: "vc-card__header", specNodeId: "1:1", role: "container" },
    { slot: "W.MoreReply", vcClass: "vc-morereply", specNodeId: null, role: "container" },
  ] }], vcClasses: { card: { "vc-thread-connector": "1px rail" } } };
  const skelSpec = new Map([["1:1", { id: "1:1", cssDecls: { display: "flex", "flex-direction": "row", "align-items": "center" } }]]);
  const stackedSnap = [{ blockId: "b1", tree: { tag: "div", classes: ["vc-panel"], box: { x: 0, y: 0, w: 320, h: 600 }, children: [
    { tag: "div", classes: ["vc-card__header"], box: { x: 0, y: 0, w: 300, h: 90 }, children: [
      { tag: "div", classes: ["vc-avatar"], box: { x: 0, y: 0, w: 300, h: 32 }, children: [] },
      { tag: "span", classes: ["vc-name"], box: { x: 0, y: 36, w: 300, h: 20 }, children: [] },
      { tag: "span", classes: ["vc-time"], box: { x: 0, y: 60, w: 300, h: 16 }, children: [] },
    ] },
    { tag: "velt-more-reply", classes: ["vc-morereply"], box: { x: 0, y: 0, w: 0, h: 0 }, children: [] },   // 0-size twin only
  ] } }];
  const skelProblems = skeletonProblems(skelPlan, stackedSnap, skelSpec);
  if (!skelProblems.some((p) => p.kind === "missing-class" && p.class === "vc-thread-connector")) problems.push(`a planned class absent from the DOM must be caught by name; got ${JSON.stringify(skelProblems.map((p) => p.kind + ":" + p.class))}`);
  if (!skelProblems.some((p) => p.kind === "zero-size-class" && p.class === "vc-morereply")) problems.push("a planned class bound only to a 0-size twin must be caught (the mis-mounted-template class)");
  if (!skelProblems.some((p) => p.kind === "arrangement" && p.class === "vc-card__header" && p.want === "row" && p.got === "column")) problems.push("a design ROW rendered as a COLUMN (the stacked header) must be caught from geometry alone");
  const rowSnap = [{ blockId: "b1", tree: { tag: "div", classes: ["vc-panel"], box: { x: 0, y: 0, w: 320, h: 600 }, children: [
    { tag: "div", classes: ["vc-card__header"], box: { x: 0, y: 0, w: 300, h: 20 }, children: [
      { tag: "div", classes: ["vc-avatar"], box: { x: 0, y: 0, w: 20, h: 20 }, paints: { background: "rgb(51,63,64)" }, children: [] },
      { tag: "span", classes: ["vc-name"], box: { x: 28, y: 2, w: 90, h: 16 }, text: "Wilson", children: [] },
      { tag: "span", classes: ["vc-time"], box: { x: 124, y: 2, w: 24, h: 16 }, text: "1m", children: [] },
    ] },
    { tag: "velt-more-reply", classes: ["vc-morereply"], box: { x: 0, y: 40, w: 266, h: 33 }, text: "Show 2 replies", children: [] },
    { tag: "div", classes: ["vc-thread-connector"], box: { x: 9, y: 20, w: 1, h: 40 }, children: [] },
  ] } }];
  if (skeletonProblems(skelPlan, rowSnap, skelSpec).length) problems.push(`a correct skeleton must pass skeleton-check; got ${JSON.stringify(skeletonProblems(skelPlan, rowSnap, skelSpec))}`);
  // hollow-container (the v4 empty-composer class): a sized container with NO visible content
  // anywhere inside must be caught; the content-bearing one (above) passes.
  const hollowSnap = JSON.parse(JSON.stringify(rowSnap));
  const hdr = hollowSnap[0].tree.children[0];
  hdr.children.forEach((c) => { delete c.text; c.paints = {}; c.box = { ...c.box, w: 0, h: 0 }; });
  const hollow = skeletonProblems(skelPlan, hollowSnap, skelSpec, { presenceOnly: true });
  if (!hollow.some((p) => p.kind === "hollow-container" && p.class === "vc-card__header")) problems.push(`a sized container with no visible content must be caught as hollow-container; got ${JSON.stringify(hollow.map((p) => p.kind + ":" + p.class))}`);

  // (g2) style coverage (the v3 raw-chrome class): a visible painted element claimed by NO rule
  //      must be flagged; a claimed one and a defaultOk-excused one must pass; ancestor claims count.
  const covSnap = [{ blockId: "b1", tree: { tag: "div", classes: ["vc-panel"], box: { x: 0, y: 0, w: 320, h: 600 }, visible: true, paints: {}, children: [
    { tag: "div", classes: ["vc-card"], box: { x: 0, y: 0, w: 300, h: 90 }, visible: true, paints: { background: "rgb(255,255,255)" }, children: [
      { tag: "span", classes: ["vc-name"], box: { x: 28, y: 8, w: 90, h: 16 }, visible: true, paints: {}, text: "Wilson", children: [] },
      { tag: "span", classes: ["vc-time-inherits"], box: { x: 124, y: 8, w: 24, h: 16 }, visible: true, paints: {}, text: "1m", children: [] },
      { tag: "div", classes: ["s-inner-chip"], box: { x: 28, y: 40, w: 60, h: 18 }, visible: true, paints: { background: "rgb(200,200,200)" }, children: [] },
    ] },
    { tag: "velt-composer", classes: ["velt-composer-strip"], box: { x: 0, y: 100, w: 300, h: 18 }, visible: true, paints: { border: "1px solid rgb(0,0,0)" }, children: [] },   // raw, unclaimed
    { tag: "div", classes: ["velt-scrollbar-chrome"], box: { x: 310, y: 0, w: 8, h: 600 }, visible: true, paints: { background: "rgb(240,240,240)" }, children: [] },   // excused
  ] } }];
  const covRules = [{ selector: ".vc-card" }, { selector: ".vc-name" }];
  const covGaps = styleCoverageGaps(covRules, covSnap, [{ selector: ".velt-scrollbar-chrome", reason: "native scrollbar ok" }]);
  if (!(covGaps.length === 2 && covGaps.some((g) => /velt-composer/.test(g.selector)) && covGaps.some((g) => /s-inner-chip/.test(g.selector))))
    problems.push(`coverage must flag the raw unclaimed painted elements (composer strip + inner chip) and ONLY those — text under a claimed ancestor inherits, defaultOk excuses; got ${JSON.stringify(covGaps)}`);
  if (styleCoverageGaps([{ selector: ".velt-composer-strip" }, { selector: ".s-inner-chip" }, ...covRules], covSnap, [{ selector: ".velt-scrollbar-chrome", reason: "native scrollbar ok" }]).length) problems.push("rules claiming the painted elements must clear their coverage gaps");

  // (g) structure fingerprint (the stale-style-plan gate): applying CSS (boxes/paints change) must
  //     NOT change it; a markup regroup MUST; transient state classes must not.
  const fpBase = structureFingerprint(rowSnap);
  const restyled = JSON.parse(JSON.stringify(rowSnap));
  restyled[0].tree.children[0].box = { x: 0, y: 0, w: 298, h: 24 };   // style build moved boxes
  restyled[0].tree.children[0].children[1].classes.push("velt-comment-dialog--selected");   // transient state
  if (structureFingerprint(restyled) !== fpBase) problems.push("box/paint/state-class changes must NOT change the structure fingerprint (a style build must not invalidate its own plan)");
  const regrouped = JSON.parse(JSON.stringify(rowSnap));
  regrouped[0].tree.children[0].children = [{ tag: "div", classes: ["vc-card__header-row"], box: { x: 0, y: 0, w: 300, h: 20 }, children: regrouped[0].tree.children[0].children }];
  if (structureFingerprint(regrouped) === fpBase) problems.push("a markup regroup MUST change the structure fingerprint (the stale-plan gate's trigger)");
  const dataGrew = JSON.parse(JSON.stringify(rowSnap));
  dataGrew[0].tree.children.splice(1, 0, JSON.parse(JSON.stringify(dataGrew[0].tree.children[0])));   // another identical card posted (smoke test data)
  if (structureFingerprint(dataGrew) !== fpBase) problems.push("REPEATED same-shape siblings (new comment posted during verification) must NOT change the fingerprint — data growth is not a structure change");

  // (h) nodeKind classification (the v4 root cause): a Figma auto-layout wrapper (only layout props)
  //     is "layout-frame" (flattens live, no own selector/box); a painted box is "paint"; a glyph
  //     fill is "paint"; text is "text". Misclassifying scaffolding as a real element is the 49%-noise
  //     + collision-split regression source.
  if (nodeKindOf({ cssDecls: { display: "flex", "flex-direction": "row", gap: "8px", "align-items": "center" } }) !== "layout-frame") problems.push("a pure auto-layout wrapper (display/flex/gap/align only) must classify as layout-frame");
  if (nodeKindOf({ cssDecls: { background: "#fff", "border-radius": "8px", "box-shadow": "0 0 0 1px #0001" } }) !== "paint") problems.push("a painted box (background/radius/shadow) must classify as paint");
  if (nodeKindOf({ type: "VECTOR", cssDecls: { fill: "#1a1917", width: "12px", height: "12px" } }) !== "paint") problems.push("a glyph with a fill must classify as paint");
  if (nodeKindOf({ text: { content: "Wilson" }, cssDecls: { color: "#1a1917", "font-size": "12px" } }) !== "text") problems.push("a text run must classify as text");

  // (i) selector-collision is NOT a defect (the v4 regression): the REAL BROWSER_PROBE, run over a
  //     DOM where 2 layout-frame rows share one live class, must NOT FAIL on collision and must NOT
  //     emit a selector-collision diff row — only advisory metadata.
  {
    const cs2 = () => ({ display: "flex", gap: "8px", getPropertyValue(p) { return this[p] || ""; } });
    const rect2 = (w, h) => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h });
    const header = { tagName: "DIV", classList: ["vc-card__header"], _r: rect2(300, 20), getBoundingClientRect() { return this._r; }, closest: () => null };
    const panel = { tagName: "DIV", classList: ["vc-panel"], _r: rect2(320, 200), getBoundingClientRect() { return this._r; }, closest: () => null };
    const doc2 = { body: panel, querySelectorAll: (sel) => (sel === ".vc-panel" ? [panel] : sel === ".vc-card__header" ? [header] : []), querySelector: (sel) => (sel === ".vc-panel" ? panel : null) };
    const spec = { surfaceSelector: ".vc-panel", elements: [
      { name: "item", selector: ".vc-card__header", expected: { display: "flex" } },               // layout-frame A
      { name: "profile-picture-and-name", selector: ".vc-card__header", expected: { gap: "8px" } }, // layout-frame B (same live element)
    ] };
    try {
      const run = new Function("document", "getComputedStyle", "SPEC", "return (" + BROWSER_PROBE + ")(SPEC);");
      const res = run(doc2, cs2, spec);
      if ((res.diffs || []).some((d) => d.property === "selector-collision")) problems.push("selector-collision must NOT be emitted as a diff row (benign design→live flatten)");
    } catch (e) { problems.push("BROWSER_PROBE threw on the collision calibration: " + e.message); }
  }

  // (j) regression guard (the missing build-over-build gate): a painted+sized element going
  //     transparent/collapsed is a regression; an IMPROVEMENT (fewer diffs, newly painted) is not.
  {
    const baseline = { b1: { els: {
      card: { paint: true, box: true, present: true },
      avatar: { paint: true, box: true, present: true },
      msg: { paint: false, box: true, present: true },
    }, diffCount: 5 } };
    const current = { b1: { els: {
      card: { paint: false, box: true, present: true },   // REGRESSION: lost paint (border/bg gone)
      avatar: { paint: true, box: false, present: true },  // REGRESSION: box collapsed to 0
      msg: { paint: true, box: true, present: true },       // improvement: now painted (must NOT flag)
    }, diffCount: 3 } };                                     // fewer diffs overall (improvement)
    const regs = findRegressions(baseline, current);
    const hard = regs.filter((r) => !r.advisory);
    if (!hard.some((r) => r.kind === "paint-lost" && r.element === "card")) problems.push("regression guard must flag a painted element going transparent (the lost-card-border class)");
    if (!hard.some((r) => r.kind === "box-collapsed" && r.element === "avatar")) problems.push("regression guard must flag a sized element collapsing to 0 (the chrome-on-0-height-wrapper class)");
    if (hard.some((r) => r.element === "msg")) problems.push("regression guard must NOT flag an IMPROVEMENT (element newly painted) as a regression");
    // a strictly-better build (no paint/box loss) must produce zero hard regressions
    const betterOnly = findRegressions(baseline, { b1: { els: { card: { paint: true, box: true, present: true } }, diffCount: 2 } }).filter((r) => !r.advisory);
    if (betterOnly.length) problems.push("a strictly-improved build must produce no hard regressions");
  }

  if (problems.length) { for (const p of problems) console.error("  ✗ two-phase-calibration: " + p); return false; }
  console.log(`✓ Two-phase gates calibrated — guessed style-plan selector caught by name; the REAL snapshot string flags the planted extra glyph (suppression-row source); plan-vs-spec value conflict emits plan-error(style); leaf-without-container-chain caught by name (the graded-trial gap class); nesting-wrong drive selector repaired to its snapshot-real suffix; skeleton-check catches missing/zero-size planned classes + design-row-rendered-as-column (the stacked header); structure fingerprint survives restyling but trips on a markup regroup (the stale-style-plan gate); nodeKind classifies layout-frame/paint/text; selector-collision is advisory-not-defect; regression guard catches paint-lost/box-collapsed but never punishes improvements`);
  return true;
}

/** Accuracy-plan calibrations: expectedTexts from n.text.content, compareText, probe misbind, coverage floor, invariants. */
async function calibrateAccuracyFixes() {
  const problems = [];

  // (a) textContentOf reads object OR string
  if (textContentOf({ text: { content: "Comment or tag others with @" } }) !== "Comment or tag others with @")
    problems.push("textContentOf must read n.text.content objects (extractor shape)");
  if (textContentOf({ text: "Hello" }) !== "Hello") problems.push("textContentOf must still accept bare strings");

  // (b) expectedTexts derives from object text on chrome nodes
  const slice = [
    { id: "root", name: "Frame", cssDecls: { display: "flex" } },
    { id: "p1", name: "Placeholder", cssDecls: { color: "#848079", "font-size": "14px" }, text: { content: "Comment or tag others with @", family: "Poppins" } },
    { id: "m1", name: "Message body", cssDecls: { color: "#1a1917", "font-size": "14px" }, text: { content: "This is a long example comment that should NOT be fixture-gated as chrome", family: "Poppins" } },
  ];
  const brief = scaffoldProbes({ id: "b1", role: "state", figmaNodeId: "root", component: "VeltCommentDialogWireframe" }, slice, {
    name: "VeltCommentDialogWireframe",
    contract: { parts: [
      { part: "ThreadCard", selectorHint: "velt-comment-dialog-thread-card-wireframe", requiredAncestorHint: "velt-comment-dialog-threads-wireframe" },
      { part: "Reply", selectorHint: "velt-comment-dialog-thread-card-reply-wireframe", requiredAncestorHint: "velt-comment-dialog-thread-card-wireframe" },
    ] },
    slots: [],
  });
  if (!(brief.fixture.expectedTexts || []).includes("Comment or tag others with @"))
    problems.push(`scaffold must put placeholder chrome into expectedTexts; got ${JSON.stringify(brief.fixture.expectedTexts)}`);
  if ((brief.fixture.expectedTexts || []).some((t) => /long example comment/i.test(t)))
    problems.push("long message bodies must NOT enter expectedTexts (data, not chrome)");
  const ph = (brief.browser.elements || []).find((e) => e.name === "placeholder");
  if (!ph?.expectedText) problems.push("placeholder element must carry expectedText for delta-compare");
  if (!(brief.coverage?.minAssert >= 2)) problems.push("coverage.minAssert must be stamped on briefs");
  if (!deriveThreadStructureContracts({ name: "VeltCommentDialogWireframe", contract: { parts: [{ part: "Reply" }, { part: "ThreadCard" }] } }).some((c) => c.part === "Reply.insideCard"))
    problems.push("deriveThreadStructureContracts must emit Reply.insideCard");

  // (c) compareText gates empty placeholder
  const empty = compareText("Comment or tag others with @", "");
  if (empty.pass) problems.push("compareText must FAIL on empty rendered placeholder");
  const ok = compareText("Comment or tag others with @", "Comment or tag others with @");
  if (!ok.pass) problems.push("compareText must PASS on exact match");

  // (d) probeBindingProblems catches Placeholder → .vc-message
  const badBrief = { browser: { elements: [{ name: "placeholder", selector: ".vc-message", expected: { color: "#1a1917" }, sourceNodeId: "p1" }] } };
  const binds = probeBindingProblems(badBrief, new Map([["p1", { id: "p1", cssDecls: { color: "#848079" }, text: { content: "Comment or tag others with @" } }]]));
  if (!binds.some((p) => p.kind === "placeholder-misbound")) problems.push("probeBindingProblems must catch Placeholder → .vc-message");
  if (!binds.some((p) => p.kind === "probe-value-conflict" && p.prop === "color")) problems.push("probeBindingProblems must catch color conflict vs designSpec");

  // (e) coverage floor uses minAssert from report
  const rich = verdictGateBlocks(
    { blocks: [{ id: "b1", role: "state", familyId: "fam", component: "Card" }] },
    { blocks: { b1: {
      built: true, driven: true, capturePng: "c.png", framePng: "f.png",
      visualDiff: { diffPct: 0, regions: [] },
      deltaCompare: { ok: true, diffs: [], checked: ["a", "b", "c"], gaps: [], coverage: { paintText: 10, minAssert: 6 } },
      stability: { ok: true, targets: [] },
    } } },
  );
  if (rich.verdict !== "INCOMPLETE" || !rich.missing.some((m) => /need ≥6|too thin/.test(m)))
    problems.push(`coverage floor must INCOMPLETE when checked(3) < minAssert(6); got ${rich.verdict} ${JSON.stringify(rich.missing)}`);

  // (f) structural invariant: reply outside card
  const inv = evaluateInvariantResult({ cards: 1, replies: 1, composers: 1, problems: [{ kind: "reply-outside-card" }] }, { expectCards: true });
  if (inv.ok) problems.push("evaluateInvariantResult must FAIL on reply-outside-card");

  // (g) isStaticChromeText — instructional placeholder yes; sentence-like "Placeholder" body no
  if (!isStaticChromeText({ name: "Placeholder", text: { content: "Comment or tag others with @" } }))
    problems.push("placeholder must count as static chrome text");
  if (isStaticChromeText({ name: "Placeholder", text: { content: "Make sure to update the NDA to our standards." } }))
    problems.push("sentence-like message bodies named Placeholder must NOT count as chrome");

  // (h) painted root surface stays measurable (card/panel chrome on the frame)
  const withRoot = scaffoldProbes(
    { id: "dlg", role: "state", figmaNodeId: "root", component: "VeltCommentDialogWireframe" },
    [
      { id: "root", name: "Single Comment Dialog", cssDecls: { display: "flex", "border-radius": "12px", "box-shadow": "0 0 0 1px #e0e0e0", background: "#fff", width: "320px" }, box: { x: 0, y: 0, w: 320, h: 200 } },
      { id: "p1", name: "Placeholder", cssDecls: { color: "#848079" }, text: { content: "Comment or tag others with @" } },
    ],
    { name: "VeltCommentDialogWireframe", contract: { parts: [] }, slots: [] },
  );
  if (!(withRoot.browser.elements || []).some((e) => e.surfaceRoot || e.sourceNodeId === "root"))
    problems.push("painted root surfaces must be scaffolded as measurable elements");

  // (i) emit-judge-defects classification — no silent drop; avatar→plan; layout-frame→noise;
  // content-height→noise ONLY below the F9 severity floor (>30% off surfaces as layout-spacing)
  const av = classifyDiff({ element: "avatar", property: "background", spec: "#eee", rendered: "transparent" }, { nodeKind: "paint" });
  if (av.attribution !== "plan-error(style)") problems.push("avatar diffs must be plan-error(style)");
  const lf = classifyDiff({ element: "frame-1", property: "padding", spec: "8px", rendered: "0px" }, { nodeKind: "layout-frame" });
  if (lf.attribution !== "noise") problems.push("layout-frame padding must be noise ledger, not silent drop");
  const chSmall = classifyDiff({ element: "(gross)", property: "content-height", spec: "100px", rendered: "110px" }, {});
  if (chSmall.attribution !== "noise") problems.push("content-height within floor must be noise (data-density)");
  const chBig = classifyDiff({ element: "(gross)", property: "content-height", spec: "100px", rendered: "400px" }, {});
  if (chBig.attribution !== "builder-error" || chBig.severityFloor !== true)
    problems.push("F9: content-height >30% off must cross the severity floor to builder-error, not noise");
  const gapBig = classifyDiff({ element: "card↔card", property: "gap.y", spec: "16px", rendered: "8px" }, {});
  if (gapBig.attribution !== "builder-error" || gapBig.severityFloor !== true)
    problems.push("F9: gap 2x off spec must cross the severity floor");
  if (workOrderPriority({ issueKey: "x.gap.y", property: "gap.y", severityFloor: true }).label !== "layout-spacing")
    problems.push("F9: severity-floor rows must rank P1 layout-spacing");
  const dataText = classifyDiff({ element: "name", property: "text", spec: "Reply", rendered: "Me" }, {});
  if (dataText.attribution !== "noise") problems.push("F5: user-data text rows (name/timestamp) must be noise — data is never a defect");
  const phText = classifyDiff({ element: "composer-placeholder", property: "text", spec: "Comment or tag others", rendered: "" }, {});
  if (phText.attribution !== "builder-error") problems.push("placeholder text rows must stay builder-error");
  const key = issueKey({ element: "iconbutton", property: "box.w" });
  if (!/\.size$/.test(key)) problems.push("width/height must collapse to issueKey …size");
  if (workOrderPriority({ issueKey: "host-wiring.collapsedComments" }).tier !== "P0")
    problems.push("host-wiring must be workOrder P0");
  if (workOrderPriority({ issueKey: "x.content-height", property: "content-height", element: "(gross)" }).tier !== "P3")
    problems.push("content-height (below floor) must be workOrder P3");
  // F1: templated region ids can never rank as composed-vision P0
  if (workOrderPriority({ issueKey: "composed.flow.visual-chrome-0", composed: false, unnamedRegion: true }).tier !== "P1")
    problems.push("F1: unnamed regions must rank P1, never P0");
  if (!isTemplatedMiss({ id: "visual-chrome-0", issue: "significant chrome mismatch vs Figma in region 24,132 288x60" }))
    problems.push("F1: region-templated glance rows must be detected as laundered");
  if (isTemplatedMiss({ id: "card-border-chrome", issue: "thread cards render as a flat divider list — no border/radius" }))
    problems.push("F1: named semantic misses must NOT be flagged as templated");
  // F6: box IoU identity
  if (boxIoU({ x: 0, y: 0, w: 100, h: 100 }, { x: 5, y: 5, w: 100, h: 100 }) < 0.8)
    problems.push("F6: near-identical boxes must exceed IoU 0.8");
  if (boxIoU({ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 200, w: 50, h: 50 }) !== 0)
    problems.push("F6: disjoint boxes must have IoU 0");
  // F5: canonical comparisons — identical box-shadow written two ways must PASS
  const shadowSame = compareProp("box-shadow", "0 0 0 1px #e4e1dd", "rgb(228, 225, 221) 0px 0px 0px 1px");
  if (!shadowSame.pass) problems.push("F5: identical box-shadow (hex vs rgb, colour-first) must pass canonical compare");
  const shadowDiff = compareProp("box-shadow", "0 4px 12px rgba(0,0,0,.04)", "none");
  if (shadowDiff.pass !== false) problems.push("F5: missing shadow must still fail");
  const bgSame = compareProp("border-width", "1px #e4e1dd", "1px rgb(228, 225, 221)");
  if (!bgSame.pass) problems.push("F5: embedded colour tokens must canonicalize in default string compare");

  // (j) style-plan thin authorship must fail closed (no deterministic spec-join)
  const thin = stylePlanAuthorshipProblems({
    generatedBy: "orchestrator deterministic spec-join (style planner looped)",
    rules: Array.from({ length: 28 }, (_, i) => ({ selector: `.vc-x${i}`, decls: { color: "#000" } })),
  }, { blocks: Array.from({ length: 8 }, (_, i) => ({ id: `b${i}` })) });
  if (!thin.some((p) => p.kind === "thin-authorship")) problems.push("deterministic generatedBy must be refused by stylePlanAuthorshipProblems");

  // (k) host-wiring prop presence + required collection
  const hostSrc = `export function X(){ return (<><VeltCustomization/><VeltComments shadowDom={false} collapsedComments commentPlaceholder="Hi" /><VeltCommentsSidebar embedMode pageMode shadowDom={false} /></>); }`;
  if (checkPropInSource(hostSrc, "VeltComments", "collapsedComments", true) !== true) problems.push("checkPropInSource must see bare boolean collapsedComments");
  const req = collectRequiredWiring({
    components: [{ id: "c", veltComponents: { onComponent: "VeltComments" }, hostProps: [{ prop: "collapsedComments", value: true }] }],
  }, { alwaysOn: [{ id: "velt-customization-mount", check: "<VeltCustomization />" }] });
  const ev = evaluateHostSource([{ file: "x.tsx", text: hostSrc }], req);
  if (ev.missing.length) problems.push("evaluateHostSource should find customization mount + collapsedComments");

  // (l) mechanism checklist requires recorded pass/na
  const appl = applicableChecklist({ checklist: [{ id: "sidebar-list-scrolls", surface: "comments sidebar" }] }, [{ id: "flow", familyId: "flows", component: "sidebar" }]);
  const badCheck = evaluateChecklistDoc({ items: [] }, appl);
  if (badCheck.ok) problems.push("empty mechanism checklist must not evaluate ok");
  const goodCheck = evaluateChecklistDoc({ items: [{ id: "sidebar-list-scrolls", status: "pass", evidence: "scrollTop=200" }] }, appl);
  if (!goodCheck.ok) problems.push("recorded pass must evaluate ok");

  // (m) host-chrome notes → noise ledger
  const hc = classifyDiff({ element: "filter", property: "box.x", spec: "0", rendered: "15", note: "host-chrome offset (R18 out of shared-stylesheet scope)" }, { nodeKind: "paint" });
  if (hc.attribution !== "noise") problems.push("host-chrome offset note must classify as noise");

  // (n) golden-path-check fails closed on thin style + missing host/checklist
  {
    const tmp = await fs.mkdtemp(path.join(ROOT, "golden", ".gp-"));
    try {
      await fs.writeFile(path.join(tmp, "blocks.json"), JSON.stringify({ blocks: [{ id: "flow", component: "sidebar" }] }));
      await fs.writeFile(path.join(tmp, "plan-style.json"), JSON.stringify({
        generatedBy: "orchestrator deterministic spec-join",
        rules: Array.from({ length: 40 }, (_, i) => ({ selector: `.a${i}`, decls: { color: "#000" } })),
      }));
      await fs.writeFile(path.join(tmp, "host-wiring.json"), JSON.stringify({ ok: false, missing: [{ prop: "collapsedComments" }] }));
      const gps = await goldenPathProblems(tmp);
      if (!gps.some((p) => p.gate === "host-wiring")) problems.push("goldenPathProblems must flag host-wiring");
      if (!gps.some((p) => p.gate === "style-plan")) problems.push("goldenPathProblems must flag thin style authorship");
      if (!gps.some((p) => p.gate === "mechanism-checklist")) problems.push("goldenPathProblems must flag missing mechanism-checklist");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (problems.length) { for (const p of problems) console.error("  ✗ accuracy-fixes: " + p); return false; }
  console.log("✓ Accuracy-fix calibrations — expectedTexts; compareText; placeholder misbind; coverage; thread contracts; structural invariants; emit; golden-path authorship/host/checklist");
  return true;
}

async function main() {
  let failed = 0;
  // (the June golden-design fixtures — designs/ + expected/ — were removed 2026-07-22; the
  // calibration suites below are the regression net. Guide integrity is check-guide.mjs's job.)

  console.log("\n--- E2E checklist (run with the live plugin + Chrome + the playground) ---");
  console.log("  1. Serve the target app; connect the Cursor's native browser tool (design intake is REST — no Figma MCP).");
  console.log("  2. `node scripts/figma-extract.mjs token status` — a Figma token is REQUIRED for REST extraction (no MCP fallback).");
  console.log("  3. /velt-customize against the Figma frame → Planner EXTRACTS a designSpec + emits a Connect Map.");
  console.log("  4. At the MANDATORY approach gate, state or confirm the approach (--mode, else halt-and-ask).");
  console.log("  5. Build executes the Connect Map: every mustSupply slot supplied (icons from exported SVGs), host props set, exact cssDecls applied.");
  console.log("  6. Judge MEASURES per block: cheap delta-compare + probes every iteration, expensive capture + visual-diff at iter-1 + PASS-candidate. PASS only when style+layout deltas are empty AND no significant visual region AND contract+stability clean, across ALL blocks (Flows + State).");
  console.log("  7. Termination is the MECHANICAL verdict-gate-blocks.mjs exit code over blocks.json (PASS/STOPPED), never /goal. The Judge writes block-report.json + surfaces evidence; builder/runtime never declares 'matched'. Acceptance: re-running on harvey-playground reproduces the velt-harvey-demo shape AND the gate FAILs/INCOMPLETEs any blown-gap / wrong-row / 210px-filter / hover-not-revealed surface.");

  const calibrated = await calibrateJudge();
  if (!calibrated) failed++;
  const layoutCalibrated = await calibrateLayout();
  if (!layoutCalibrated) failed++;
  const iconCalibrated = await calibrateIconResolver();
  if (!iconCalibrated) failed++;
  const probeCalibrated = calibrateProbeRuntime();
  if (!probeCalibrated) failed++;
  const boxCalibrated = calibrateBoxNormalization();
  if (!boxCalibrated) failed++;
  const selectorsCalibrated = await calibrateManifestSelectors();
  if (!selectorsCalibrated) failed++;
  const layerCalibrated = calibrateLayerReconciliation();
  if (!layerCalibrated) failed++;
  const contractCalibrated = calibrateContractOracle();
  if (!contractCalibrated) failed++;
  const verdictCalibrated = calibrateVerdictGate();
  if (!verdictCalibrated) failed++;
  const contentIndepCalibrated = calibrateContentIndependentGate();
  if (!contentIndepCalibrated) failed++;
  const stabilityCalibrated = calibrateStabilityGate();
  if (!stabilityCalibrated) failed++;
  const twoPhaseCalibrated = calibrateTwoPhase();
  if (!twoPhaseCalibrated) failed++;
  const accuracyCalibrated = await calibrateAccuracyFixes();
  if (!accuracyCalibrated) failed++;
  const judgeValidationCalibrated = await calibrateJudgeValidation();
  if (!judgeValidationCalibrated) failed++;
  const defectContractCalibrated = await calibrateDefectContract();
  if (!defectContractCalibrated) failed++;
  const compiledOracleCalibrated = await calibrateCompiledOracle();
  if (!compiledOracleCalibrated) failed++;

  if (failed) { console.error(`\n✗ golden offline guard FAILED for ${failed} check(s)`); process.exit(1); }
  console.log(`\n✓ golden offline guard passed (probe/gate/judge calibration suites all green)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

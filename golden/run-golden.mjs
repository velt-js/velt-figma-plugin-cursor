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
import { compareDecls, verdictOf, BROWSER_PROBE, LAYER_PROBE, reconcilePlan, mountMapDiff, CONTRACT_PROBE, STABILITY_PROBE } from "../scripts/delta-compare.mjs";
import { verdictGateBlocks } from "../scripts/verdict-gate-blocks.mjs";
import { assignIcons, normalizeBoxes } from "../scripts/figma-extract.mjs";
import { verdictGate } from "../scripts/verdict-gate.mjs";
import { buildChecklist } from "../scripts/build-checklist.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUIDE = path.join(ROOT, "guide");
const EXPECTED_DIR = path.join(ROOT, "golden", "expected");
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
// `BROWSER_PROBE` into the page via the browser tool (CDP Runtime.evaluate); if any module-scope identifier the
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
  const base = (extra) => ({ built: true, driven: true, visualDiff: { diffPct: 0, regions: [] }, deltaCompare: { ok: true, diffs: [] }, ...extra });
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

async function guideText() {
  // concatenate all guide/reference + key guide pages once, for fast substring checks
  const files = [];
  async function walk(d) {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".md")) files.push(full);
    }
  }
  await walk(GUIDE);
  return (await Promise.all(files.map((f) => fs.readFile(f, "utf8")))).join("\n");
}

async function main() {
  const text = await guideText();
  const catalog = await fs.readFile(path.join(GUIDE, "reference", "component-catalog.md"), "utf8");
  const fixtures = (await fs.readdir(EXPECTED_DIR)).filter((f) => f.endsWith(".expected.json"));

  let failed = 0;
  for (const file of fixtures) {
    const exp = JSON.parse(await fs.readFile(path.join(EXPECTED_DIR, file), "utf8"));
    const problems = [];

    if (!catalog.includes(exp.surface)) problems.push(`surface not in component-catalog: ${exp.surface}`);
    if (!["css", "wireframe", "primitive", "headless", "mixed"].includes(exp.layer))
      problems.push(`invalid layer: ${exp.layer}`);
    for (const id of exp.identifiers || []) {
      if (!text.includes(id)) problems.push(`identifier not found in guide (R10 drift!): ${id}`);
    }

    if (problems.length) {
      failed++;
      console.error(`✗ ${exp.design}`);
      for (const p of problems) console.error("    - " + p);
    } else {
      console.log(`✓ ${exp.design} — surface + ${exp.identifiers.length} identifiers verified in guide (expect ${exp.expectedVerdict})`);
    }
  }

  console.log("\n--- E2E checklist (run with the live plugin + Cursor's browser tool + the playground) ---");
  console.log("  1. Serve the target app; confirm Cursor's native browser tool can reach it (design intake is REST — no Figma MCP).");
  console.log("  2. `node scripts/figma-extract.mjs token status` — a Figma token is REQUIRED for REST extraction (no MCP fallback).");
  console.log("  3. /velt-customize-run against the Figma frame → Planner EXTRACTS a designSpec + emits a Connect Map.");
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
  const stabilityCalibrated = calibrateStabilityGate();
  if (!stabilityCalibrated) failed++;

  if (failed) { console.error(`\n✗ golden offline guard FAILED for ${failed} check(s)`); process.exit(1); }
  console.log(`\n✓ golden offline guard passed (${fixtures.length} designs + style & layout Judge calibration; all identifiers valid in the guide)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

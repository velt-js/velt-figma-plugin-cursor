// compiled-oracle.mjs — offline calibration for the design-compiled assertion oracle
// (Master Fix Plan Phase 1+). Proves compilation invariants R-B/R-C/R-E/R-F/R-G hold
// mechanically, on the committed judge-validation fixture plus synthetic cases.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileAssertions, compileDecl, compileSlotRelations, compileStateFramePaint,
  validateAssertion, gapTolerance, sizeTolerance, GEOMETRY_TOL_MAX,
} from "../scripts/compile-assertions.mjs";
import { stateCoverageProblems, unionCarryForward } from "../scripts/emit-judge-defects.mjs";
import { validateBindings } from "../scripts/state-capture.mjs";
import { evaluateStructuralContract, validateContractDoc } from "../scripts/structural-contract-validate.mjs";
import { reconcileContradictions, unresolvedContradictions, regionId } from "../scripts/contradiction-resolver.mjs";
import { planDrift } from "../scripts/plan-drift.mjs";
import { scoreDrill, randomMutations } from "../scripts/mutation-drill.mjs";
import { ensureFixture } from "./judge-validation.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "judge-validation-fixture");

export async function calibrateCompiledOracle() {
  const problems = [];

  // R-E tolerance calibration: a 2× spacing defect can never hide inside the tolerance.
  if (gapTolerance(8) > 2) problems.push("gapTolerance(8) must be ≤2 so 8-vs-4 fails");
  if (gapTolerance(16) !== 4) problems.push("gapTolerance(16) must be 4");
  if (gapTolerance(4) !== 1) problems.push("gapTolerance(4) must be 1 so 4-vs-10 fails");
  if (sizeTolerance(16) !== 1) problems.push("atomic sizes (≤24px) must be ±1 so 12-vs-16 icons fail");
  if (sizeTolerance(112) !== GEOMETRY_TOL_MAX) problems.push("large rects use the R-E cap");

  // R-F: spacing decls compile to RECT assertions, never property reads.
  const gapC = compileDecl({ selector: ".vc-body", state: "default", property: "gap", value: "4px", specNodeId: "1:1", ruleIndex: 0 });
  if (gapC.assertions?.[0]?.kind !== "rect-gap") problems.push("gap decl must compile to rect-gap (R-F)");
  const padC = compileDecl({ selector: ".vc-body", state: "default", property: "padding", value: "12px", specNodeId: "1:1", ruleIndex: 0 });
  if (padC.assertions?.[0]?.kind !== "rect-inset") problems.push("padding decl must compile to rect-inset (R-F)");
  const marC = compileDecl({ selector: ".vc-x", state: "default", property: "margin", value: "8px", specNodeId: "1:1", ruleIndex: 0 });
  if (!marC.unsupported?.reason) problems.push("margin must be explicit unsupported with reason (G1), never silent");

  // R-B: hand-authored expectations (no provenance) are invalid.
  const bad = validateAssertion({ id: "x", kind: "paint", expected: "#fff", tolerance: 0, expectedSource: "plan-style.json", specNodeId: "1:1" });
  if (bad.ok) problems.push("assertion without designPath must be invalid (R-B)");
  const live = validateAssertion({ id: "x", kind: "paint", expected: "#fff", tolerance: 0, expectedSource: "live-dom", designPath: "rules[0]", specNodeId: "1:1" });
  if (live.ok) problems.push("expectedSource=live-dom must be invalid (R-B)");
  const wide = validateAssertion({ id: "x", kind: "rect-gap", expected: 8, tolerance: 9, expectedSource: "plan-style.json", designPath: "rules[0]", specNodeId: "1:1" });
  if (wide.ok) problems.push("tolerance above the R-E cap without a justification row must be invalid (G4)");
  const justified = validateAssertion({ id: "x", kind: "rect-gap", expected: 8, tolerance: 9, justification: "documented in plan", expectedSource: "plan-style.json", designPath: "rules[0]", specNodeId: "1:1" });
  if (!justified.ok) problems.push("a written justification row must permit a wider tolerance (R-E)");

  // Sibling relations: row-banding must keep left-row pairs (Name→Time) even when a
  // right-aligned control (Options) sits between them in (y,x) order; root-level parents
  // (cross-context boxes) must yield nothing.
  const rel = compileSlotRelations([
    { slot: "W.Card.Avatar", vcClass: ".vc-avatar", box: { x: 12, y: 12, w: 20, h: 20 }, specNodeId: "a", designPath: "s[0]" },
    { slot: "W.Card.Name", vcClass: ".vc-name", box: { x: 40, y: 12, w: 93, h: 20 }, specNodeId: "b", designPath: "s[1]" },
    { slot: "W.Card.Time", vcClass: ".vc-time", box: { x: 140, y: 15, w: 27, h: 16 }, specNodeId: "c", designPath: "s[2]" },
    { slot: "W.Card.Options", vcClass: ".vc-options", box: { x: 296, y: 12, w: 16, h: 16 }, specNodeId: "d", designPath: "s[3]" },
    { slot: "W.Card.Message", vcClass: ".vc-message", box: { x: 40, y: 36, w: 270, h: 40 }, specNodeId: "e", designPath: "s[4]" },
  ]);
  const ids = rel.map((r) => `${r.id}=${r.expected}`);
  if (!ids.includes("vc-avatar--vc-name.rect-gap=8")) problems.push("avatar→name rect-gap 8 must compile from sibling boxes");
  if (!ids.includes("vc-name--vc-time.rect-gap=7")) problems.push("name→time rect-gap 7 must survive row-banding (the interleave bug)");
  const rootRel = compileSlotRelations([
    { slot: "W.Composer", vcClass: ".vc-composer", box: { x: 12, y: 88, w: 298, h: 40 }, specNodeId: "f", designPath: "s[5]" },
    { slot: "W.MoreReply", vcClass: ".vc-more-reply", box: { x: 16, y: 180, w: 180, h: 24 }, specNodeId: "g", designPath: "s[6]" },
  ]);
  if (rootRel.length) problems.push("root-level cross-context siblings must not compile relations");

  // Full compile on the committed fixture: G2 provenance on every assertion, G3 no "na",
  // coverage machinery present, gates catch nothing on a valid plan.
  await ensureFixture();
  const { doc, invalid } = await compileAssertions(FIXTURE, { family: "single comment dialog|selected", blocks: "." });
  if (invalid.length) problems.push(`fixture compile must be gate-clean, got: ${invalid.map((v) => v.reason).join("; ")}`);
  if (!doc.assertions.length) problems.push("fixture compile must produce assertions");
  for (const a of doc.assertions) {
    const v = validateAssertion(a);
    if (!v.ok) { problems.push(`fixture assertion ${a.id} invalid: ${v.reason}`); break; }
  }
  if (JSON.stringify(doc).includes('"na"')) problems.push('G3: compiled doc must not contain "na"');
  if (!Array.isArray(doc.planHoles)) problems.push("coverage diff (planHoles) must be present");
  if (doc.resultVocabulary.join(",") !== "pass,fail,blocked") problems.push("result vocabulary must be exactly pass|fail|blocked (R-C)");

  // ---- Phase 2: state machinery ----
  // State-frame paint deltas: hover/selected bg (#f7f6f4) compiles from the frame diff;
  // unchanged props (radius/shadow) never duplicate into state assertions.
  const sf = compileStateFramePaint([
    { id: "f0", name: "Single Comment Dialog", cssDecls: { background: "#ffffff", "border-radius": "8px", "box-shadow": "0 0 0 1px #1a191714" } },
    { id: "f1", name: "Single Comment Dialog / Hover", cssDecls: { background: "#f7f6f4", "border-radius": "8px", "box-shadow": "0 0 0 1px #1a191714" } },
    { id: "f2", name: "Selected State", cssDecls: { background: "#f7f6f4", "border-radius": "8px", "box-shadow": "0 0 0 1px #1a191714" } },
  ]);
  if (!sf.some((a) => a.state === "hover" && a.property === "background" && a.expected === "#f7f6f4"))
    problems.push("hover-bg must compile from the state-frame diff (designSpec provenance)");
  if (sf.some((a) => a.property === "border-radius")) problems.push("unchanged props must not duplicate into state assertions");
  if (sf.some((a) => !a.requiresState)) problems.push("state-frame assertions must be requiresState");
  for (const a of sf) { const v = validateAssertion(a); if (!v.ok) { problems.push(`state-frame assertion invalid: ${v.reason}`); break; } }

  // Binding schema: an unverifiable state (no guard) is not a binding.
  const bindProblems = validateBindings({ bindings: [{ state: "hover", frameId: "f1", drive: [{ action: "hover", selector: ".x" }] }] });
  if (!bindProblems.some((p) => /guard/.test(p))) problems.push("binding without guard must be rejected");
  if (validateBindings({ bindings: [{ state: "hover", frameId: "f1", drive: [{ action: "hover", selector: ".x" }], guard: { kind: "pseudo", selector: ".x:hover" } }] }).length)
    problems.push("valid binding must pass schema");

  // Emit state-coverage gate: bound state block without a confirmed fresh capture refuses.
  const gateArgs = {
    blockIds: ["b-hover", "b-rest"],
    bindings: [{ state: "hover", blockIds: ["b-hover"] }],
    restingMtime: 1000,
    captureMtime: (c) => c._m,
  };
  if (!stateCoverageProblems({ ...gateArgs, captures: [] }).length) problems.push("missing state capture must gate");
  if (!stateCoverageProblems({ ...gateArgs, captures: [{ state: "hover", guard: { ok: false, reason: "x" }, _m: 2000 }] }).length)
    problems.push("guard-failed capture must gate");
  if (!stateCoverageProblems({ ...gateArgs, captures: [{ state: "hover", guard: { ok: true }, _m: 500 }] }).length)
    problems.push("capture older than resting must gate");
  if (stateCoverageProblems({ ...gateArgs, captures: [{ state: "hover", guard: { ok: true }, _m: 2000 }] }).length)
    problems.push("confirmed fresh capture must pass the gate");

  // ---- Phase 3: structural contract (M10/M11 — pixels compensate, structure lies) ----
  const contract = {
    contracts: [
      { id: "reply-inside-card", kind: "containment", child: ".vc-reply", ancestor: ".vc-body" },
      { id: "header-order", kind: "sibling-order", parent: ".vc-body", order: [".vc-avatar", ".vc-name", ".vc-time"], axis: "x" },
      { id: "card-present", kind: "cardinality", selector: ".vc-body", min: 1 },
      { id: "options-owns-pointer", kind: "interaction-ownership", selector: ".vc-options", owner: ".vc-options" },
    ],
    substitutions: [
      { id: "chevron-css-mask", what: "chevron via CSS mask", sdkGap: "no icon slot", reverify: { selector: ".vc-more-reply svg", expect: "absent" } },
    ],
  };
  if (validateContractDoc(contract).length) problems.push("valid structural contract must pass schema");
  if (!validateContractDoc({ contracts: [{ id: "x", kind: "containment", child: ".a", ancestor: ".b" }], substitutions: [{ id: "s", what: "w", sdkGap: "g" }] }).some((p) => /reverify/.test(p)))
    problems.push("substitution without reverify must be rejected — it would outlive its excuse silently");
  const healthy = evaluateStructuralContract(contract, {
    contracts: {
      "reply-inside-card": { contained: true },
      "header-order": { order: [".vc-avatar", ".vc-name", ".vc-time"] },
      "card-present": { count: 3 },
      "options-owns-pointer": { ownerHit: true, hit: "div.vc-options" },
    },
    substitutions: { "chevron-css-mask": { reverifyMatched: false } },
  });
  if (healthy.some((r) => r.status !== "pass")) problems.push("healthy structure must pass the contract validator");
  const m10 = evaluateStructuralContract(contract, {
    contracts: {
      "reply-inside-card": { contained: false }, // M10: Reply reparented outside the card, pixels compensated
      "header-order": { order: [".vc-avatar", ".vc-name", ".vc-time"] },
      "card-present": { count: 3 },
      "options-owns-pointer": { ownerHit: true },
    },
    substitutions: { "chevron-css-mask": { reverifyMatched: false } },
  });
  if (!m10.some((r) => r.id === "contract.reply-inside-card" && r.status === "fail"))
    problems.push("M10 (reply reparented, pixels compensated) must FAIL the containment contract");
  const m11 = evaluateStructuralContract(contract, {
    contracts: {
      "reply-inside-card": { contained: true },
      "header-order": { order: [".vc-avatar", ".vc-time", ".vc-name"] }, // M11: timestamp reordered
      "card-present": { count: 3 },
      "options-owns-pointer": { ownerHit: true },
    },
    substitutions: { "chevron-css-mask": { reverifyMatched: false } },
  });
  if (!m11.some((r) => r.id === "contract.header-order" && r.status === "fail"))
    problems.push("M11 (timestamp reordered) must FAIL the sibling-order contract");
  const outlived = evaluateStructuralContract(contract, {
    contracts: { "reply-inside-card": { contained: true }, "header-order": { order: [".vc-avatar", ".vc-name", ".vc-time"] }, "card-present": { count: 1 }, "options-owns-pointer": { ownerHit: true } },
    substitutions: { "chevron-css-mask": { reverifyMatched: true } }, // SDK now renders its own chevron
  });
  if (!outlived.some((r) => r.id === "substitution.chevron-css-mask" && r.status === "fail"))
    problems.push("a substitution whose SDK gap closed must FAIL re-justification");
  const unobserved = evaluateStructuralContract(contract, { contracts: {}, substitutions: {} });
  if (!unobserved.every((r) => r.status === "blocked")) problems.push("unobserved contract rows must be blocked, never pass");

  // ---- Phase 4: contradiction ladder (RC4 — dissent can no longer be subordinated) ----
  const box = { x: 24, y: 136, w: 288, h: 64 };
  const rid = regionId(box);
  const lad = (over = {}) => reconcileContradictions({ regions: [{ cssBox: box }], ...over });
  if (lad({ openDefects: [{ cssBox: { x: 26, y: 138, w: 284, h: 60 } }] })[0].status !== "named")
    problems.push("region overlapped by an open finding must be named (explained)");
  if (lad({})[0].status !== "needs-glance") problems.push("unexplained region with no verdict must be needs-glance");
  if (lad({ verdicts: { [rid]: { verdict: "identical" } } })[0].status !== "needs-sweep")
    problems.push("glance 'identical' without a computed sweep must be needs-sweep — never accepted");
  if (lad({ verdicts: { [rid]: { verdict: "identical" } }, sweeps: { [rid]: { mismatches: [{ selector: ".vc-name", property: "line-height" }] } } })[0].status !== "named")
    problems.push("sweep mismatches must override an 'identical' glance (vision backstop)");
  const accepted = lad({ verdicts: { [rid]: { verdict: "identical" } }, sweeps: { [rid]: { mismatches: [] } }, hashes: { [rid]: "h1" } })[0];
  if (accepted.status !== "accepted-residual") problems.push("identical + clean sweep must become accepted-residual");
  const residual = { regionId: rid, status: "accepted-residual", crops: { live: "l.png", figma: "f.png" }, expiry: { pixelHash: "h1" } };
  if (reconcileContradictions({ regions: [{ cssBox: box }], priorLedger: [residual], hashes: { [rid]: "h2" } })[0].status !== "needs-glance")
    problems.push("residual must EXPIRE and re-arbitrate when region pixels change");
  if (reconcileContradictions({ regions: [{ cssBox: box }], priorLedger: [residual], hashes: { [rid]: "h1" } })[0].status !== "accepted-residual")
    problems.push("valid residual with unchanged pixels must persist");
  const invalidResidual = { regionId: rid, status: "accepted-residual", expiry: { pixelHash: "h1" } }; // no crops
  if (reconcileContradictions({ regions: [{ cssBox: box }], priorLedger: [invalidResidual], hashes: { [rid]: "h1" } })[0].status !== "needs-glance")
    problems.push("residual without crops must be invalid → re-arbitrate");
  if (!unresolvedContradictions([{ status: "needs-glance" }, { status: "named" }]).length)
    problems.push("needs-glance must count as unresolved (PASS ban input)");

  // ---- Phase 5: plan drift guard (the silent hover-bg loss can never recur) ----
  const prevPlan = { rules: [{ selector: ".vc-body", state: "hover", decls: { background: "#f7f6f4" } }, { selector: ".vc-list", decls: { gap: "16px" } }] };
  const droppedPlan = { rules: [{ selector: ".vc-list", decls: { gap: "16px" } }] };
  if (!planDrift(prevPlan, droppedPlan, null).removed.length)
    problems.push("silently dropped decl must be flagged as drift");
  if (planDrift(prevPlan, { ...droppedPlan, removals: [{ selector: ".vc-body", state: "hover", property: "background", reason: "moved to state-frame assertion" }] }, null).removed.length)
    problems.push("a documented removal (reason row) must not flag");
  if (planDrift(prevPlan, { rules: [{ selector: ".vc-body", state: "hover", decls: { background: "#ffffff" } }, prevPlan.rules[1]] }, null).removed.length)
    problems.push("a changed value is a revision, not a removal");

  // ---- Phase 6: mutation drill scoring ----
  const drill = scoreDrill([
    { mutation: { id: "M1", category: "style" }, detected: true, expectedHits: 1, falseAlarms: 0 },
    { mutation: { id: "M2", category: "style" }, detected: true, expectedHits: 1, falseAlarms: 1 },
    { mutation: { id: "M10", category: "structure" }, detected: false, expectedHits: 0, falseAlarms: 0 },
  ], { style: { recall: 0.9, precision: 0.95 }, structure: { recall: 0.8, precision: 0.9 } });
  if (drill.scores.style.recall !== 1) problems.push("drill recall math wrong");
  if (drill.scores.style.precision >= 0.95) problems.push("false alarms must drag precision below target");
  if (!drill.regressions.some((r) => /structure recall/.test(r))) problems.push("a missed structure mutation must be a category regression");
  const suiteStub = { assertions: [{ id: "a.color", kind: "paint", property: "color", selector: ".a", state: "default", expected: "#111", tolerance: 0 }, { id: "b.gap", kind: "rect-gap", property: "gap", selector: ".b", state: "default", expected: 8, tolerance: 2 }] };
  const r1 = randomMutations(suiteStub, 2, 7).map((m) => m.id);
  if (JSON.stringify(r1) !== JSON.stringify(randomMutations(suiteStub, 2, 7).map((m) => m.id)))
    problems.push("random mutations must be deterministic per seed");
  if (!randomMutations(suiteStub, 2, 7).every((m) => m.apply?.css && m.expectDetect?.length))
    problems.push("random mutations must carry an override + expected detection");

  // ---- Phase 7: union carry-forward (RC7 — leaving the open set requires evidence) ----
  const union = { "comment-gap": { lastSeen: "t1" }, "card-ring": { lastSeen: "t1" }, "fixed-one": { lastSeen: "t1", assertionId: "vc-body.gap" } };
  const cf1 = unionCarryForward({ unionEntries: union, currentIdentities: new Set(["card-ring"]), passingAssertions: new Set(["vc-body.gap"]) });
  if (!cf1.regressionRows.some((r) => r.canonicalId === "comment-gap"))
    problems.push("an open issue that vanished without evidence must re-emit as regression-lost-coverage");
  if (cf1.regressionRows.some((r) => r.canonicalId === "card-ring"))
    problems.push("an issue still in the current workOrder must not regress");
  if (cf1.regressionRows.some((r) => r.canonicalId === "fixed-one"))
    problems.push("an issue whose compiled assertion now passes has resolution evidence — no regression");
  if (!cf1.resolutions.some((r) => r.identity === "fixed-one"))
    problems.push("passing-assertion resolutions must be recorded with evidence");
  const cf2 = unionCarryForward({ unionEntries: { x: { lastSeen: "t1" } }, currentIdentities: new Set(), passingAssertions: new Set(), resolvedDoc: { resolved: [{ identity: "x", evidence: "state capture live-hover.png @sha" }] } });
  if (cf2.regressionRows.length) problems.push("an explicit evidence row must resolve without regression");

  if (problems.length) {
    console.error("  ✗ compiled-oracle: " + problems.join("\n  ✗ compiled-oracle: "));
    return false;
  }
  console.log("✓ Compiled-oracle calibrated — R-B provenance; R-E tolerances; R-F rect compilation; row-banding; state-frame hover-bg from frame diff; state-coverage gate; structural contract (M10 reparent + M11 reorder FAIL; substitution re-justification; unobserved→blocked)");
  return true;
}

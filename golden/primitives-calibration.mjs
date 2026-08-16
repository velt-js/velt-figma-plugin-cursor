// primitives-calibration.mjs — offline regression net for the PRIMITIVES path (R1/R2/R3).
//
// Additive: the wireframe calibration suites in run-golden.mjs are untouched and do not import this.
//
// What it pins:
//   1. the capability manifest's load-bearing invariants (a silent under-count here would make
//      `strictly primitives` look achievable on surfaces where it is not);
//   2. the reachability gate's verdicts for a reachable and an unreachable surface;
//   3. that lint-primitives actually catches the dead-compound-trigger bug from PR snippyly/sdk#4506
//      (issues #3/#4) and does NOT fire on the correctly-composed equivalent.
//
// (3) is the one that matters most: that defect renders pixel-perfect, so no chromatic judge can see
// it, and the SDK states the class is not instrumented upstream.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (script, args) => {
  try { return { code: 0, out: execFileSync("node", [path.join(ROOT, "scripts", script), ...args], { encoding: "utf8" }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") }; }
};

export async function calibratePrimitives() {
  const checks = [];
  const ok = (name, cond, detail = "") => { checks.push({ name, pass: !!cond, detail }); return !!cond; };

  const M = JSON.parse(await fs.readFile(path.join(ROOT, "manifest/velt-primitives.json"), "utf8"));

  // --- 1. manifest invariants ---------------------------------------------------------------
  const paritySum = Object.values(M.parity.byRegistry).reduce((a, b) => a + b, 0);
  ok("parity rows sum to the stated total", paritySum === M.parity.slotsWithNoPrimitive, `${paritySum} vs ${M.parity.slotsWithNoPrimitive}`);
  ok("parity total is the measured 392/770", M.parity.slotsWithNoPrimitive === 392 && M.parity.wireframeSlotKeys === 770);
  ok("tag registry count matches the SDK snapshot", M.counts.tagsAcceptingChildren === 441, String(M.counts.tagsAcceptingChildren));
  ok("all 13 SDK families are present", Object.keys(M.families).length === 13);
  ok("exactly 6 R3 getters are recorded as published", Object.keys(M.r3.getters).length === 6);

  // Element accessors, verified against a RUNNING local SDK build (v1.0.0). These were the one
  // place a family-name-derived guess slipped through: the activity log hangs off
  // getActivityElement, not getActivityLogElement, and the wrong name throws on undefined.
  const ACCESSORS_VERIFIED_LIVE = {
    CommentDialogPrimitive: "getCommentElement", SidebarV2: "getCommentElement",
    InlineSection: "getCommentElement", MultiThread: "getCommentElement",
    NotificationsPanel: "getNotificationElement", ActivityLog: "getActivityElement",
  };
  for (const [fam, el] of Object.entries(ACCESSORS_VERIFIED_LIVE))
    ok(`${fam} R3 accessor is ${el} (verified live)`, M.r3.getters[fam]?.element === el, M.r3.getters[fam]?.element);
  ok("families without a named R3 getter are listed, not inferred", Array.isArray(M.r3.familiesWithoutNamedGetter) && M.r3.familiesWithoutNamedGetter.length === 7);

  // The dialog ROOT does not accept children (capability exception); the COMPOSER does. Getting this
  // backwards would have the builder wrap everything in <VeltCommentDialog> and render nothing.
  ok("dialog root is absent from the children registry", !("velt-comment-dialog" in M.primitives));
  ok("dialog thread host is absent from the children registry", !("velt-comment-dialog-thread" in M.primitives));
  ok("dialog composer IS in the children registry", "velt-comment-dialog-composer" in M.primitives);

  const triggerLeaves = Object.values(M.primitives).filter((p) => p.requiresTriggerAncestor);
  ok("compound-trigger leaves are indexed", triggerLeaves.length >= 20, `${triggerLeaves.length} leaves`);
  const gated = Object.values(M.primitives).filter((p) => p.parentOwnedConditions);
  ok("parent-owned conditions are indexed", gated.length >= 70, `${gated.length} primitives`);
  ok("availability is flagged unpublished", M.availability.published === false);

  // --- 2. reachability gate ------------------------------------------------------------------
  const reach = run("check-primitive-reachability.mjs", ["--surface", "dialog,sidebar", "--json"]);
  ok("reachable surfaces exit 0", reach.code === 0);
  const blocked = run("check-primitive-reachability.mjs", ["--surface", "recorder,cursor", "--mode", "strictly primitives", "--json"]);
  ok("unreachable surfaces exit 1 under strictly primitives", blocked.code === 1);
  const blockedJson = JSON.parse(blocked.out);
  ok("recorder is MODE_BLOCKED, not silently downgraded", blockedJson.results.every((r) => r.verdict === "MODE_BLOCKED"));
  const mixed = run("check-primitive-reachability.mjs", ["--surface", "recorder", "--mode", "wireframes + primitives", "--json"]);
  ok("under a mixed mode the same surface is NEEDS_WIREFRAME, not blocked", mixed.code === 0 && JSON.parse(mixed.out).results[0].verdict === "NEEDS_WIREFRAME");

  // --- 3. lint catches the real defect --------------------------------------------------------
  const bad = run("lint-primitives.mjs", [path.join(ROOT, "golden/primitives/bad"), "--json"]);
  const badJson = JSON.parse(bad.out);
  const p1 = badJson.findings.filter((f) => f.rule === "P1");
  ok("lint FAILS the dead-chip fixture", bad.code === 1);
  ok("P1 fires on BOTH compound-trigger leaves", p1.length === 2, `${p1.length} P1 finding(s)`);
  ok("P7 names the dialog root as a non-container", badJson.findings.some((f) => f.rule === "P7" && /VeltCommentDialog\b/.test(f.message)));
  ok("P3 blames the element that actually holds the text", badJson.findings.some((f) => f.rule === "P3" && /ThreadCardName/.test(f.message)));
  ok("P8 rejects an unpublished config hook", badJson.findings.some((f) => f.rule === "P8"));

  const good = run("lint-primitives.mjs", [path.join(ROOT, "golden/primitives/good"), "--json"]);
  const goodJson = JSON.parse(good.out);
  ok("lint PASSES the correctly-composed fixture", good.code === 0, `${goodJson.errors} error(s)`);
  ok("no P1 on the correct composition", !goodJson.findings.some((f) => f.rule === "P1"));
  ok("no P3 false positive on wrapped text", !goodJson.findings.some((f) => f.rule === "P3"));

  // --- 4. the agents are actually REACHABLE ---------------------------------------------------
  // The scripts and agent files can all be perfect and still never run. This pins the dispatch wiring:
  // without it, `strictly primitives` silently falls through to the wireframe planner/builder.
  const orch = await fs.readFile(path.join(ROOT, "agents/velt-orchestrator.md"), "utf8");
  ok("orchestrator dispatches the primitives planner", orch.includes("velt-planner-primitives"));
  ok("orchestrator dispatches the primitives builder", orch.includes("velt-builder-primitives"));
  ok("orchestrator runs the reachability gate before planning", orch.includes("check-primitive-reachability.mjs"));
  ok("orchestrator gates handoff on the primitives lint", orch.includes("lint-primitives.mjs"));
  const judge = await fs.readFile(path.join(ROOT, "agents/velt-judge-2.md"), "utf8");
  ok("judge carries a primitives probe block", judge.includes("primitives-probe"));

  // The primitives branch must be MODE-SCOPED, or it would change wireframe runs.
  ok("primitives branch is scoped to `strictly primitives`", /PRIMITIVES BRANCH \(mode `strictly primitives` ONLY/.test(orch));
  ok("primitives build stage is scoped to `strictly primitives`", /5a-P\. BUILD-PRIMITIVES \(mode `strictly primitives` ONLY/.test(orch));

  for (const f of ["agents/velt-planner-primitives.md", "agents/velt-builder-primitives.md"]) {
    const src = await fs.readFile(path.join(ROOT, f), "utf8").catch(() => "");
    ok(`${f} exists and pins an Opus model`, /^---[\s\S]*?\bmodel:\s*(opus|claude-opus-)/m.test(src));
  }

  // --- 5. the plan scaffold + plan-time gate (end-to-end, on a synthetic phase) ----------------
  // Without a scaffold the planner hand-authors the compose tree — the sprawl failure mode the
  // architecture exists to prevent — and then hits pre-build gates keyed to the slot-shaped plan.
  const os = await import("node:os");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "velt-prim-"));
  await fs.writeFile(path.join(tmp, "blocks.json"), JSON.stringify({
    families: [
      { id: "fam-comment-dialog", role: "state", component: "Comment Dialog", blockIds: ["b1"], buildOrder: 0 },
      { id: "fam-screen-recorder", role: "state", component: "Screen Recorder", blockIds: ["b2"], buildOrder: 1 },
    ],
    blocks: [
      { id: "b1", role: "state", component: "Comment Dialog", state: "default", order: 0, figmaNodeId: "1:1" },
      { id: "b2", role: "state", component: "Screen Recorder", state: "default", order: 1, figmaNodeId: "1:2" },
    ],
  }));
  // The scaffold now REFUSES to run without designSpec.json and per-block spec slices (fail-loud —
  // both were silently absent on the first real run and the style stage enriched nothing).
  await fs.writeFile(path.join(tmp, "designSpec.json"), JSON.stringify({ nodes: [], designTokens: {} }));
  await fs.mkdir(path.join(tmp, "briefs"), { recursive: true });
  for (const id of ["b1", "b2"]) {
    await fs.writeFile(path.join(tmp, "briefs", `${id}.spec.json`), JSON.stringify({
      nodes: [{ id: "1:1", name: "Card", cssDecls: [{ prop: "background", value: "#ffffff" }], box: { x: 0, y: 0, w: 10, h: 10 } }],
    }));
  }

  const sc = run("scaffold-primitives.mjs", [tmp]);
  ok("scaffold emits both plan files", sc.code === 0);
  const pp = JSON.parse(await fs.readFile(path.join(tmp, "plan-primitives.json"), "utf8"));
  const ps = JSON.parse(await fs.readFile(path.join(tmp, "plan-structure.json"), "utf8"));
  ok("an unreachable surface is excluded from the projection", ps.components.length === 1 && ps.components[0].id === "fam-comment-dialog");
  ok("the unreachable surface is recorded mode_blocked with a reason", !!pp.surfaces.find((s) => s.id === "fam-screen-recorder")?.modeBlocked?.reason);
  ok("the projection declares no wireframe slots", ps.components.every((c) => Array.isArray(c.slots) && !c.slots.length));
  ok("the projection carries vcClasses for the style stage", Array.isArray(ps.vcClasses) && ps.vcClasses.length > 0);

  // The SHARED wireframe-path validator must accept the projection unchanged.
  const { planStructureProblems } = await import("../scripts/brief-scaffold.mjs");
  const codeconnect = JSON.parse(await fs.readFile(path.join(ROOT, "manifest/velt-codeconnect.json"), "utf8"));
  ok("shared planStructureProblems() accepts the projection", planStructureProblems(ps, codeconnect).length === 0);

  ok("plan gate FAILS an unfilled scaffold", run("scaffold-primitives.mjs", [tmp, "--lint"]).code === 2);

  // Fill it the way a Planner would, but with the dead-trigger bug — the gate must catch it.
  const dlg = pp.surfaces.find((s) => s.id === "fam-comment-dialog");
  const stripTodos = (o) => { if (!o || typeof o !== "object") return; for (const k of Object.keys(o)) { if (k.startsWith("_todo_")) delete o[k]; else stripTodos(o[k]); } };
  dlg.root.children = [{ primitive: "velt-comment-dialog-status-dropdown", children: [{ primitive: "velt-comment-dialog-status-dropdown-trigger-icon", children: [] }] }];
  dlg.contextAnchor = { node: "vc-comment-dialog", attributes: { "annotation-id": "{id}" } };
  dlg.r3.reads = []; dlg.shadowDom = false; dlg.parentConditions = [];
  stripTodos(pp);
  await fs.writeFile(path.join(tmp, "plan-primitives.json"), JSON.stringify(pp, null, 2));
  const buggy = run("scaffold-primitives.mjs", [tmp, "--lint", "--json"]);
  ok("plan gate catches a dead compound trigger BEFORE any code exists", buggy.code === 2 && JSON.parse(buggy.out).problems.some((p) => p.kind === "dead-trigger"));

  // Registry-but-not-an-element. Found on the first real run: a planner picked
  // velt-comment-dialog-body as the R2 anchor for a whole thread card. It is in the SDK's tag
  // registry and is NOT a registered custom element, so it renders as HTMLUnknownElement — nothing,
  // with no error — and every descendant loses its context. Six of the eight such tags are
  // container-shaped names, which is exactly what a planner reaches for to wrap and anchor.
  ok("unregistered tags are marked in the manifest", M.primitives["velt-comment-dialog-body"]?.registered === false);
  ok("registered tags are marked true", M.primitives["velt-comment-dialog-thread-card"]?.registered === true);
  ok("the singular sidebar host is flagged unregistered", M.primitives["velt-comment-sidebar-v2"]?.registered === false);
  ok("manifest counts the unregistered tags", M.counts.notRegisteredAtRuntime === 8, String(M.counts.notRegisteredAtRuntime));
  dlg.root.children = [{ primitive: "velt-comment-dialog-body", children: [] }];
  await fs.writeFile(path.join(tmp, "plan-primitives.json"), JSON.stringify(pp, null, 2));
  const unreg = run("scaffold-primitives.mjs", [tmp, "--lint", "--json"]);
  ok("plan gate REJECTS a tag that is not a registered custom element", unreg.code === 2 && JSON.parse(unreg.out).problems.some((p) => p.kind === "not-registered"));

  // Correct it: the trigger wraps its leaves.
  dlg.root.children = [{ primitive: "velt-comment-dialog-status-dropdown", children: [{ primitive: "velt-comment-dialog-status-dropdown-trigger", children: [{ primitive: "velt-comment-dialog-status-dropdown-trigger-icon", children: [] }] }] }];
  dlg.parentConditions = [{ primitive: "velt-comment-dialog-status-dropdown-trigger", condition: "hasCustomTrigger", decision: "re-express", how: "hide default content when children supplied" }];
  await fs.writeFile(path.join(tmp, "plan-primitives.json"), JSON.stringify(pp, null, 2));
  ok("plan gate PASSES a correct compose tree", run("scaffold-primitives.mjs", [tmp, "--lint"]).code === 0);
  await fs.rm(tmp, { recursive: true, force: true });

  const orch2 = await fs.readFile(path.join(ROOT, "agents/velt-orchestrator.md"), "utf8");
  ok("orchestrator scaffolds before dispatching the primitives planner", orch2.includes("scaffold-primitives.mjs"));

  // --- 6. FAIL LOUD ---------------------------------------------------------------------------
  // Every expensive detour in the first real run was a step that silently did nothing and reported
  // success: --style enriched 0 briefs and exited 0; six state blocks captured the same card while
  // every gate stayed green. A missing prerequisite must stop the run, not produce artifacts that
  // pass every gate and measure nothing.
  const t2 = await fs.mkdtemp(path.join(os.tmpdir(), "velt-loud-"));
  const blocksDoc = { families: [{ id: "fam-x", role: "state", component: "Comment Dialog", blockIds: ["b1"], buildOrder: 0 }],
                      blocks: [{ id: "b1", role: "state", component: "Comment Dialog", state: "default", order: 0 }] };
  await fs.writeFile(path.join(t2, "blocks.json"), JSON.stringify(blocksDoc));
  ok("scaffold REFUSES to run without designSpec.json", run("scaffold-primitives.mjs", [t2]).code === 1);
  await fs.writeFile(path.join(t2, "designSpec.json"), JSON.stringify({ nodes: [] }));
  ok("scaffold REFUSES to run without spec slices", run("scaffold-primitives.mjs", [t2]).code === 1);

  const t3 = await fs.mkdtemp(path.join(os.tmpdir(), "velt-empty-"));
  await fs.writeFile(path.join(t3, "a.tsx"), "export const x = 1;\n");
  const emptyLint = run("lint-primitives.mjs", [t3, "--json"]);
  ok("lint FAILS on a scan that found no primitives (not a clean pass)",
     emptyLint.code === 1 && JSON.parse(emptyLint.out).findings.some((f) => f.rule === "P0"));

  // --- 7. DRIVE CONTRACT ----------------------------------------------------------------------
  // The three rules that produced false passes on the first run, now mechanically enforced.
  const t4 = await fs.mkdtemp(path.join(os.tmpdir(), "velt-drive-"));
  await fs.writeFile(path.join(t4, "plan-primitives.json"), JSON.stringify({
    surfaces: [{ id: "fam-x", surface: "dialog", reachable: true, blockIds: ["b1"],
      root: { element: "div", vcClass: "vc-x", children: [] },
      contextAnchor: { node: "x", attributes: {} }, r3: { getter: "getCommentDialogConfig", reads: [] },
      parentConditions: [], shadowDom: false, hostProps: [] }],
  }));
  await fs.mkdir(path.join(t4, "briefs"), { recursive: true });
  const writeBrief = (drive, liveSelector) => fs.writeFile(path.join(t4, "briefs", "b1.probes.json"),
    JSON.stringify({ blockId: "b1", state: "with-replies", liveSelector, drive }));

  await writeBrief({ steps: [{ action: "click", selector: "button" }], assert: ".vc-x--reply" }, ".vc-x:has(.r)");
  let out = JSON.parse(run("scaffold-primitives.mjs", [t4, "--lint", "--json"]).out);
  ok("drive contract catches a non-idempotent (toggle) first step", out.problems.some((p) => p.kind === "non-idempotent-drive"));

  await writeBrief({ steps: [{ action: "eval", js: "…" }], assert: null }, ".vc-x:has(.r)");
  out = JSON.parse(run("scaffold-primitives.mjs", [t4, "--lint", "--json"]).out);
  ok("drive contract catches steps with no assert", out.problems.some((p) => p.kind === "drive-without-assert"));

  await writeBrief({ steps: [{ action: "eval", js: "…" }], assert: ".vc-x" }, ".vc-x");
  out = JSON.parse(run("scaffold-primitives.mjs", [t4, "--lint", "--json"]).out);
  ok("drive contract catches a state block measuring the generic surface", out.problems.some((p) => p.kind === "state-block-measures-generic-surface"));
  ok("drive contract catches an assert that only proves the surface", out.problems.some((p) => p.kind === "assert-proves-surface-not-state"));

  for (const d of [t2, t3, t4]) await fs.rm(d, { recursive: true, force: true });

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n— primitives (R1/R2/R3) calibration —`);
  for (const c of checks) console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  if (failed.length) { console.error(`  ✗ ${failed.length} primitives calibration check(s) failed`); return false; }
  console.log(`  ✓ ${checks.length} primitives checks green`);
  return true;
}

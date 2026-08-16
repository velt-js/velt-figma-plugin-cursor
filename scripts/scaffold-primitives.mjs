#!/usr/bin/env node
// scaffold-primitives.mjs — the PRIMITIVES plan scaffold + plan gate (the analogue of
// brief-scaffold.mjs --structure / --lint-structure, which stay wireframe-only and untouched).
//
// WHY THIS EXISTS
// Planning here is mechanically scaffolded on purpose: the orchestrator generates skeletons and the
// Planner only FILLS `_todo` fields, because "hand-authoring these files is what made planning
// sprawl". The primitives planner had no scaffold, so it would have hand-authored a compose tree
// from scratch — the exact failure mode the architecture exists to prevent — and then hit
// pre-build gates keyed to the slot-shaped plan and never reached the builder.
//
// TWO OUTPUTS, ON PURPOSE
//   plan-primitives.json   the compose tree (primitives-native: children, context anchors, R3 reads)
//   plan-structure.json    a PROJECTION carrying only the LAYER-AGNOSTIC fields the shared gates
//                          read — vcClasses, designTokens, baseStyling, hostProps — with `slots: []`.
//                          That is honest (a primitives build genuinely has no wireframe slots) and
//                          it lets verify-host-wiring / skeleton-check / resume-check / the whole
//                          STYLE stage run UNCHANGED. The style stage is layer-agnostic already: it
//                          plans selectors against a dom-snapshot of the REAL DOM plus vcClasses,
//                          neither of which cares how the DOM was produced.
//
// USAGE
//   node scripts/scaffold-primitives.mjs <phaseDir>            # scaffold both files
//   node scripts/scaffold-primitives.mjs <phaseDir> --lint     # the pre-build gate
//   ... --json for machine-readable lint output
//
// EXIT: 0 clean · 2 unfilled _todo / contract violations · 1 usage or missing inputs.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Reused from the shared scaffolder, NOT reimplemented. scaffoldProbes builds the per-element rows
// (`browser.elements`) that the STYLE stage iterates; it is wireframe-agnostic apart from a
// rootWireframe fallback for the live selector, which a primitives build supplies itself.
// Without these rows `brief-scaffold --style` enriches nothing and exits 0 — silently (finding F14).
import { scaffoldProbes } from "./brief-scaffold.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const phaseDir = argv.find((a) => !a.startsWith("--"));
if (!phaseDir) { console.error("usage: scaffold-primitives.mjs <phaseDir> [--lint] [--json]"); process.exit(1); }

const P = (f) => path.join(phaseDir, f);
const readJson = async (p, dflt = undefined) => {
  try { return JSON.parse(await fs.readFile(p, "utf8")); }
  catch (e) { if (dflt !== undefined) return dflt; console.error(`✗ cannot read ${p}: ${e.message}`); process.exit(1); }
};

const M = await readJson(path.join(ROOT, "manifest/velt-primitives.json"));
const DRIVE_VERBS = "click|dblclick|hover|waitFor|type|press|sleep|eval|clear|selectUser";
// enumerate-blocks' prose hints are strings; an executable drive is an array of {action,...} objects.
const isExecutableDrive = (d) => Array.isArray(d?.steps) && d.steps.length > 0 && d.steps.every((x) => x && typeof x === "object" && typeof x.action === "string");

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Map a block's component/name onto the reachability vocabulary. Order matters — first match wins,
// and the UNREACHABLE families are tested first so a recorder surface can never be mis-read as a
// dialog and quietly planned as primitives.
const SURFACE_RULES = [
  [/record|transcri/i, "recorder"],
  [/cursor/i, "cursor"],
  [/presence/i, "presence"],
  [/reaction/i, "reactions"],
  [/live.?state|state.?sync/i, "live-state-sync"],
  [/notification.*tool|bell/i, "notifications-tool"],
  [/notification/i, "notifications"],
  [/activity.?log/i, "activity-log"],
  [/inline.*(section|comment)/i, "inline-section"],
  [/multi.?thread/i, "multi-thread"],
  [/autocomplete|mention/i, "autocomplete"],
  [/sidebar.?button/i, "sidebar-button"],
  [/sidebar/i, "sidebar"],
  [/bubble/i, "bubble"],
  [/text.?comment/i, "text-comment"],
  [/comments?.?tool/i, "comments-tool"],
  [/pin/i, "pin"],
  [/dialog|thread|comment/i, "dialog"],
];
const surfaceFor = (s) => (SURFACE_RULES.find(([re]) => re.test(String(s || "")))?.[1]) || null;

const FAMILY_FOR_SURFACE = Object.fromEntries(
  Object.entries(M.surfaceReachability).filter(([, v]) => v.reachable).map(([k, v]) => [k, v.family]));

// ---------------------------------------------------------------------------------- scaffold ----
async function scaffold() {
  const blocks = await readJson(P("blocks.json"));
  // FAIL LOUD, do not record null. The first run of this pipeline reached the STYLE stage before
  // anyone noticed designSpec.json had never been produced (figma-extract was skipped in intake) —
  // the scaffold had quietly written `designSpec: null` and everything downstream inherited a run
  // with no design numbers at all. Fine for structure, fatal for styling, and invisible until the
  // style stage silently enriched nothing.
  const spec = await readJson(P("designSpec.json"), null);
  if (!spec) {
    console.error(`✗ designSpec.json missing in ${phaseDir}`);
    console.error(`  The style stage needs per-element design values; without it every style rule is unplannable.`);
    console.error(`  Run intake's extraction step first:`);
    console.error(`    node scripts/figma-extract.mjs rest <fileKey> <nodeId> --svg --out ${phaseDir}`);
    process.exit(1);
  }
  const families = blocks.families || [];
  if (!families.length) { console.error("✗ blocks.json has no families — run enumerate-blocks.mjs first"); process.exit(1); }

  const surfaces = [];
  const vcClasses = [];
  for (const fam of families) {
    if (fam.role === "flow") continue;                       // flows compose already-planned surfaces
    const label = fam.component || fam.id;
    const surface = surfaceFor(label);
    const reach = surface ? M.surfaceReachability[surface] : null;
    const primFamily = surface ? FAMILY_FOR_SURFACE[surface] : null;
    const r3 = primFamily ? M.r3.getters[primFamily] : null;
    const vc = `vc-${slug(label)}`;
    vcClasses.push(vc);

    surfaces.push({
      id: fam.id,
      component: label,
      blockIds: fam.blockIds || [],
      surface,
      reachable: reach ? reach.reachable : null,
      ...(reach && !reach.reachable
        ? { modeBlocked: { reason: reach.reason, unmatchedSlots: reach.unmatchedSlots, note: "No primitive exists for these positions. Report mode_blocked; do NOT insert a wireframe (the mode forbids the layer switch) and do NOT plan this surface." } }
        : {}),
      ...(surface ? {} : { _todo_surface: `could not classify '${label}' — set one of: ${Object.keys(M.surfaceReachability).join(", ")}` }),

      // The compose tree. The Planner fills `children`; every node it adds must be a real primitive.
      root: {
        element: "div",
        vcClass: vc,
        _todo_children: "the compose tree for this surface. Each node: { primitive: <velt-* tag from manifest/velt-primitives.json>, children: [...], ownAttributes: {}, vcClass?: string, specNodeId?: string }. RULES: (a) a primitive whose manifest entry has requiresTriggerAncestor MUST sit inside that ancestor or the control renders and does nothing; (b) velt-comment-dialog / velt-comment-dialog-thread are NOT containers (velt-comment-dialog-composer is); (c) children on a repeating container render ONCE — own the loop instead.",
        children: [],
      },

      // R2 — anchor the id ONCE; the consuming primitives inherit it.
      contextAnchor: {
        _todo_anchor: "which attribute(s) this subtree anchors and on which node, e.g. { node: '<vcClass or primitive>', attributes: { 'annotation-id': '<expr>' } }. Put an attribute on a DESCENDANT only to override an inherited value.",
      },

      // R3 — only the six published getters exist.
      r3: r3
        ? { getter: r3.getter, element: r3.element, args: r3.args, reactHook: r3.reactHook, _todo_reads: "the exact state fields this surface's conditionals read, e.g. ['uiState.darkMode','data.annotation.status']. [] if none. Never name a field you have not verified." }
        : { getter: null, note: primFamily ? `no published config getter for family ${primFamily} — state reads are NOT available for this surface; do not invent a getter name` : "surface unclassified", _todo_reads: "[] — or record a gap if the design needs state this surface cannot expose" },

      // Decisions the Planner must make explicitly rather than leave implicit.
      _todo_parentConditions: "for every planned primitive carrying parentOwnedConditions in the manifest: { primitive, condition, decision: 're-express' | 'accept-divergence', how }. [] if none apply.",
      _todo_shadowDom: "the RESOLVED effective shadowDom value for this surface (true|false) — hand-placed primitives INHERIT it, and with it on, class-based CSS silently stops applying while --velt-* variables keep working. Decide it here; the style stage depends on it.",
      hostProps: [],
      _todo_hostProps: "structure-producing host props this surface needs (collapsedComments, collapsedRepliesPreview, pageMode…), each gated on a recognized design cue (R24). [] if none. CSS cannot fake these.",
    });
  }

  const planPrimitives = {
    _doc: "PRIMITIVES compose plan (R1 children / R2 context / R3 data). Scaffolded by scripts/scaffold-primitives.mjs; the Planner FILLS the _todo_* fields and never authors this from scratch. Gate: scaffold-primitives.mjs <phaseDir> --lint (exit 0) before the build.",
    layer: "primitives",
    mode: "strictly primitives",
    availability: M.availability,
    generatedFrom: { blocks: "blocks.json", designSpec: spec ? "designSpec.json" : null, manifest: "manifest/velt-primitives.json" },
    surfaces,
  };

  // The layer-agnostic projection. Deliberately `slots: []` — a primitives build has no wireframe
  // slots, and planStructureProblems() iterates slots, so this validates clean and honestly.
  const planStructure = {
    _doc: "PROJECTION of plan-primitives.json — the layer-agnostic fields the shared gates and the STYLE stage read (vcClasses, designTokens, baseStyling, hostProps). `slots` is empty because a primitives build has no wireframe slots. Do not hand-edit: regenerate with scaffold-primitives.mjs.",
    derivedFrom: "plan-primitives.json",
    layer: "primitives",
    components: surfaces.filter((s) => s.reachable !== false).map((s) => ({
      id: s.id, veltComponents: {}, slots: [], hostProps: s.hostProps || [],
    })),
    vcClasses,
    designTokens: spec?.designTokens || {},
    baseStyling: { unstyledBase: true, note: "Every run works on the unstyled base — client.setUnstyledMode(true, { keepFunctionalStyles: true })." },
  };

  await fs.writeFile(P("plan-primitives.json"), JSON.stringify(planPrimitives, null, 2) + "\n");
  await fs.writeFile(P("plan-structure.json"), JSON.stringify(planStructure, null, 2) + "\n");

  // PROBE BRIEFS — one per block. dom-snapshot.mjs reads briefs/<blockId>.probes.json for the block's
  // liveSelector and refuses to snapshot without one; the style stage and the Judge then read the
  // snapshot. Without these the whole post-build half of the pipeline has nothing to run against.
  //
  // A primitives build can DERIVE the selector deterministically, which the wireframe path cannot:
  // the vcClass is authored by our own builder onto our own markup, so it is post-build-stable by
  // construction. (The wireframe path has to guess a selector that survives Velt replacing the tree.)
  //
  // Scoping matters: a block gets its SURFACE's vcClass, so a thread-card block snapshots ONE card
  // rather than the whole list. Snapshotting the list root captured 7,315 nodes on this design,
  // because a hand-composed loop renders every row where the built-in virtualises.
  const briefDir = P("briefs");
  await fs.mkdir(briefDir, { recursive: true });
  const blockById = new Map((blocks.blocks || []).map((b) => [b.id, b]));
  let briefCount = 0;
  for (const s of surfaces) {
    if (s.reachable === false) continue;
    for (const id of s.blockIds || []) {
      const b = blockById.get(id);
      if (!b) continue;
      const primary = `.${s.root.vcClass.split(/\s+/)[0]}`;

      // Per-element style rows, built from the block's spec slice (spec-slice.mjs must have run).
      //
      // Per-element selectors are deliberately LEFT AS _todo for the style planner to resolve against
      // the dom-snapshot. It is tempting to auto-fill `.vc-<figma-layer-name>` — the plan does own its
      // vcClasses — but those are per-SURFACE ("vc-comment-thread-components"), while the per-element
      // classes are chosen by the builder from the DOM it is building ("vc-comment", "vc-comment-avatar").
      // Deriving a selector from a Figma layer name invents classes that never render: on this design
      // it produced `.vc-single-comment-dialog` and `.vc-avatar` against a build that emits
      // `.vc-comment` and `.vc-comment-avatar`. Only the snapshot knows the real ones.
      // FAIL LOUD. enrichBriefForStyle iterates brief.browser.elements; with no slice there are no
      // elements, so `--style` enriches nothing and still exits 0. A missing prerequisite must stop
      // the scaffold, not produce a brief that passes every gate and measures nothing.
      const slice = await readJson(path.join(briefDir, `${id}.spec.json`), null);
      if (!slice) {
        console.error(`✗ no spec slice for block '${id}' (briefs/${id}.spec.json)`);
        console.error(`  Without it the STYLE stage has no per-element rows and silently enriches nothing.`);
        console.error(`  Run this BEFORE scaffolding:`);
        console.error(`    node scripts/spec-slice.mjs ${phaseDir}/designSpec.json ${phaseDir}/blocks.json --out-dir ${phaseDir}`);
        process.exit(1);
      }
      const probes = scaffoldProbes({ ...b, liveSelector: primary }, slice.nodes || slice, null, { mode: "full" });
      const browser = probes.browser || probes;

      await fs.writeFile(path.join(briefDir, `${id}.probes.json`), JSON.stringify({
        blockId: id,
        browser,
        state: b.state || null,
        surface: s.surface,
        familyId: s.id,
        // Post-build-stable by construction — our builder owns this class.
        liveSelector: primary,
        selectorProvenance: "derived from the primitives plan's vcClass (authored by our own builder, not Velt's DOM)",
        // enumerate-blocks emits PROSE steps ("seed one root comment") as a starting hint. dom-snapshot
        // needs machine-executable step OBJECTS and records the block state-unreachable otherwise —
        // which silently degrades every style rule for that block to unknown→verify. So carry the
        // prose as a hint and make the conversion an explicit _todo, exactly as the wireframe path does.
        drive: isExecutableDrive(b.drive)
          ? b.drive
          : {
              steps: [],
              assert: null,
              _hint_prose: (b.drive?.steps || []).join(" · ") || null,
              // Three rules, each learned from a real false pass on the first run of this pipeline.
              _todo_steps: `Machine-executable step OBJECTS to reach state '${b.state}'. Shape: [{"action":"click","selector":"<sel>"}]. Vocabulary: ${DRIVE_VERBS}.
  (1) IDEMPOTENT — every block shares ONE reused page. A bare toggle click makes block 1 open the surface and block 2 close it; that scored 1/8 captured while the same block passed 1/1 in isolation. Reach the state if it is not already reached; never toggle. Use {"action":"eval","js":"if(!document.querySelector('<marker>')){ …open… }"}.
  (2) REACH THE STATE, not just the surface — opening a sidebar is not reaching "has 2+ replies". Six state blocks once captured the SAME first card and every gate stayed green.
  (3) An empty drive on a surface that must be opened is the classic false-pass: the capture succeeds against nothing.`,
              _todo_assert: `a live selector proving THIS STATE is active — not merely that the surface rendered. Asserting the generic surface marker is what let six states pass while capturing one card; for a "more than 1 reply" state assert the reply-collapser, not the card.`,
              _todo_liveSelector: `OPTIONAL override. The default '${primary}' matches EVERY instance of this surface and the snapshot roots at the FIRST VISIBLE one. If this block is a per-instance STATE, scope it to the instance that exhibits the state (e.g. ':has(<state marker>)' / ':not(:has(<marker>))'), or you will measure a different instance than the one you drove.`,
            },
        frame: b.framePng || null,
        specNodeId: b.figmaNodeId || null,
      }, null, 2) + "\n");
      briefCount++;
    }
  }

  const blockedList = surfaces.filter((s) => s.reachable === false);
  // FLOW blocks still need a brief. A flow family is not PLANNED (it composes already-planned
  // surfaces), but every downstream consumer iterates blocks.blocks — and brief-scaffold --style
  // exits(2) on the first block without a brief, so one missing flow brief silently blocks style
  // enrichment for the entire phase. The wireframe path briefs every block; so must this one.
  const covered = new Set(surfaces.flatMap((s) => s.blockIds || []));
  const rootSurface = surfaces.find((s) => s.reachable !== false);
  for (const b of blocks.blocks || []) {
    if (covered.has(b.id) || !rootSurface) continue;
    const slice = await readJson(path.join(briefDir, `${b.id}.spec.json`), null);
    const sel = `.${rootSurface.root.vcClass.split(/\s+/)[0]}`;
    let browser = null;
    if (slice) browser = (scaffoldProbes({ ...b, liveSelector: sel }, slice.nodes || slice, null, { mode: "full" })).browser || null;
    await fs.writeFile(path.join(briefDir, `${b.id}.probes.json`), JSON.stringify({
      blockId: b.id,
      state: b.state || null,
      role: b.role || null,
      composesSurfaces: surfaces.filter((s) => s.reachable !== false).map((s) => s.id),
      liveSelector: sel,
      selectorProvenance: "flow block — composes already-planned surfaces; rooted at the first planned surface",
      ...(browser ? { browser } : {}),
      drive: { steps: [], assert: null, _todo_steps: `Machine-executable step OBJECTS for this flow. Vocabulary: ${DRIVE_VERBS}. Steps run against a REUSED page shared with every other block — they must be IDEMPOTENT (reach the state if it is not already reached; never toggle).`, _todo_assert: "a live selector proving the flow's end state" },
      frame: b.framePng || null,
      specNodeId: b.figmaNodeId || null,
    }, null, 2) + "\n");
    briefCount++;
  }

  // SMOKE SPEC per family — `--lint-style` requires one per family and fails with
  // "family <id>: smoke.json MISSING" otherwise. The wireframe scaffolder emits these; mine did not.
  for (const fam of families) {
    const s = surfaces.find((x) => x.id === fam.id);
    await fs.writeFile(path.join(briefDir, `${fam.id}.smoke.json`), JSON.stringify({
      familyId: fam.id,
      component: fam.component || null,
      role: fam.role || null,
      blockIds: fam.blockIds || [],
      layer: "primitives",
      ...(s?.reachable === false ? { modeBlocked: s.modeBlocked } : {}),
      surfaceSelector: s ? `.${s.root.vcClass.split(/\s+/)[0]}` : null,
      // Behavioural smoke checks for a primitives build. The compound-trigger one is the important
      // one: a dead control renders pixel-perfect, so only a real click can tell you it is dead.
      checks: [
        { id: "renders", assert: s ? `.${s.root.vcClass.split(/\s+/)[0]}` : null, note: "the composed surface is present and non-zero-size" },
        { id: "no-wireframe-registered", assert: "velt-wireframe", expectCount: 0, note: "a primitives build must register no wireframe" },
        { id: "interactive-controls-live", note: "click every composed interactive element with a REAL pointer at freshly-measured coordinates and assert something changed — synthetic .click() silently fails on Velt controls, and a compound-trigger leaf without its -trigger renders perfectly and does nothing" },
      ],
      _todo_expectedTexts: "canonical visible strings this family must render (author/message/counts) taken from the frame text — or [] if none",
    }, null, 2) + "\n");
  }

  const skippedFlows = families.filter((f) => f.role === "flow").map((f) => f.id);
  console.log(`✓ scaffolded plan-primitives.json (${surfaces.length} surface(s)) + plan-structure.json projection + ${briefCount} probe brief(s)`);
  // Say what was dropped. "Intentionally skipped" and "lost" look identical otherwise (finding F5).
  if (skippedFlows.length) console.log(`  ⓘ skipped ${skippedFlows.length} flow family/families (${skippedFlows.join(", ")}) — flows compose already-planned surfaces. Anything appearing ONLY in a flow frame must be adopted by a surface or it is planned nowhere.`);
  console.log(`  vcClasses: ${vcClasses.join(", ") || "(none)"}`);
  if (blockedList.length) {
    console.log(`  ⚠ ${blockedList.length} surface(s) are NOT reachable by primitives and are excluded from planning:`);
    for (const b of blockedList) console.log(`      ${b.component} → ${b.surface} (${b.modeBlocked.unmatchedSlots} slots, ${b.modeBlocked.reason})`);
  }
  const todos = JSON.stringify(planPrimitives).match(/"_todo_/g)?.length || 0;
  console.log(`  ${todos} _todo field(s) for the Planner to fill · gate with: node scripts/scaffold-primitives.mjs ${phaseDir} --lint`);
}

// -------------------------------------------------------------------------------------- lint ----
// The PLAN-TIME contract gate. Catching a dead compound trigger here is strictly better than
// catching it in the built code: nothing has been written yet.
function walk(node, ancestors, fn) {
  if (!node || typeof node !== "object") return;
  fn(node, ancestors);
  for (const c of node.children || []) walk(c, [...ancestors, node], fn);
}

async function lint() {
  const plan = await readJson(P("plan-primitives.json"));
  const problems = [];
  const bad = (kind, where, note) => problems.push({ kind, where, note });

  // 1. no unfilled scaffolding
  const leftovers = [];
  (function scan(o, p = "") {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith("_todo_")) leftovers.push(`${p}${k}`);
      else if (typeof v === "object") scan(v, `${p}${k}.`);
    }
  })(plan);
  for (const l of leftovers) bad("unfilled-todo", l, "the Planner must fill or explicitly empty this field");

  for (const s of plan.surfaces || []) {
    const at = s.id || s.component;

    // 2. reachability was honoured
    if (s.reachable === false && (s.root?.children || []).length)
      bad("planned-unreachable", at, `${s.surface} has no primitive layer — it must be mode_blocked, not planned`);
    if (s.reachable === false) continue;

    // 3. every primitive is real, and every compound-trigger leaf has its ancestor
    walk(s.root, [], (node, ancestors) => {
      const tag = node.primitive;
      if (!tag) return;
      const meta = M.primitives[tag];
      if (!meta) {
        const isRoot = tag === "velt-comment-dialog" || tag === "velt-comment-dialog-thread";
        bad("unknown-primitive", `${at} → ${tag}`, isRoot
          ? "the dialog root/thread host is NOT a container — markup inside it does not render; compose its parts directly (the composer IS a container)"
          : "not in the SDK primitive registry — never invent an identifier (R10)");
        return;
      }
      // In the SDK's tag registry but never registered as a custom element: the browser creates an
      // HTMLUnknownElement, which renders nothing and throws nothing. Neither the compiler nor a
      // pixel diff can see it, and if it is the context anchor the whole subtree is silently dead.
      if (meta.registered === false)
        bad("not-registered", `${at} → ${tag}`,
          `present in the SDK tag registry but NOT registered as a custom element — it would render as HTMLUnknownElement (nothing). ${meta.notRegisteredReason || ""}`);

      if (meta.requiresTriggerAncestor && !ancestors.some((a) => a.primitive === meta.requiresTriggerAncestor))
        bad("dead-trigger", `${at} → ${tag}`, `missing ancestor ${meta.requiresTriggerAncestor} — the click handler lives on the trigger, so this control would render pixel-perfect and do nothing`);

      // 4. parent-owned conditions must be DECIDED, not left implicit
      if (meta.parentOwnedConditions) {
        const decided = (s.parentConditions || []).some((d) => d.primitive === tag);
        if (!decided) bad("undecided-condition", `${at} → ${tag}`,
          `carries parent-owned condition(s) [${meta.parentOwnedConditions.map((c) => c.condition).join(", ")}] it cannot evaluate standalone — record a decision: re-express or accept-divergence`);
      }
    });

    // 5. R3 reads only name published getters
    const reads = s.r3?.reads;
    if (Array.isArray(reads) && reads.length && !s.r3?.getter)
      bad("no-getter", at, "state reads are planned but this surface has no published config getter — record a gap instead of inventing one");
    if (s.r3?.getter && !Object.values(M.r3.getters).some((g) => g.getter === s.r3.getter))
      bad("unpublished-getter", `${at} → ${s.r3.getter}`, `not one of the published getters: ${Object.values(M.r3.getters).map((g) => g.getter).join(", ")}`);

    // 6. shadowDom must be resolved before the style stage plans against it
    if (typeof s.shadowDom !== "boolean")
      bad("unresolved-shadowdom", at, "resolve the effective shadowDom value — with it on, class-based CSS silently stops applying while --velt-* variables keep working");
  }

  // --- drive contract, mechanically enforced ------------------------------------------------
  // The three rules above are only worth stating if something checks them. Each of these caught a
  // real false pass on the first run, where every other gate stayed green.
  const briefDir = P("briefs");
  const briefFiles = (await fs.readdir(briefDir).catch(() => [])).filter((f) => f.endsWith(".probes.json"));
  if (!briefFiles.length) bad("no-briefs", "briefs/", "no probe briefs — dom-snapshot has nothing to capture and the whole post-build half of the pipeline silently no-ops");

  const stateBlocks = new Map();
  for (const s of plan.surfaces || []) for (const id of s.blockIds || []) stateBlocks.set(id, s);

  for (const f of briefFiles) {
    const b = await readJson(path.join(briefDir, f), null);
    if (!b) continue;
    const steps = b.drive?.steps || [];
    const at = b.blockId || f;

    // (1) idempotent: a bare click as the FIRST step toggles across the reused page.
    if (steps[0]?.action === "click")
      bad("non-idempotent-drive", at,
        "the first step is a bare click — every block shares ONE reused page, so this toggles what the previous block set up. Guard it: {\"action\":\"eval\",\"js\":\"if(!document.querySelector('<marker>')){ …open… }\"}");

    // (3) a surface that needs opening must assert something.
    if (steps.length && !b.drive?.assert)
      bad("drive-without-assert", at, "drive has steps but no assert — the capture can succeed against nothing (classic false-pass)");

    // (2) a per-instance STATE block must not measure the generic surface selector.
    const surf = stateBlocks.get(b.blockId);
    const generic = surf ? `.${surf.root.vcClass.split(/\s+/)[0]}` : null;
    const isStateBlock = b.state && !/^(default|state)$/.test(b.state);
    if (isStateBlock && generic && b.liveSelector === generic)
      bad("state-block-measures-generic-surface", at,
        `state '${b.state}' uses the generic surface selector '${generic}', which matches every instance — the snapshot roots at the FIRST VISIBLE one, so this measures whichever instance happens to be first, not the one you drove. Scope it with :has()/:not(:has()).`);
    if (isStateBlock && b.drive?.assert && generic && b.drive.assert === generic)
      bad("assert-proves-surface-not-state", at,
        `assert '${b.drive.assert}' only proves the surface rendered, not that state '${b.state}' was reached`);
  }

  if (flag("--json")) { console.log(JSON.stringify({ problems, ok: !problems.length }, null, 2)); }
  else if (problems.length) {
    for (const p of problems) console.error(`✗ ${p.kind.padEnd(20)} ${p.where}\n    ${p.note}`);
    console.error(`\n✗ ${problems.length} primitives-plan problem(s) — the build must not start`);
  } else console.log("✓ primitives plan gate clean (compose tree, triggers, conditions, getters, shadowDom)");

  process.exit(problems.length ? 2 : 0);
}

if (flag("--lint")) await lint(); else await scaffold();

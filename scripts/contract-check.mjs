#!/usr/bin/env node
// contract-check.mjs — PIPELINE CONTRACT GATE. Run 2's autopsy: first-shot-css.mjs silently
// generated 0 rules against the run's Connect Map (schema drift between producer and consumer),
// and nobody noticed until the builder had burned 50+ min re-discovering values by iteration —
// the exact failure mode first-shot exists to prevent. Producer→consumer handoffs between the
// deterministic scripts must be SELF-VERIFYING: a producer that emits nothing useful is a HALT
// at preflight/plan time, never a silent no-op the loop pays for.
//
// Two modes:
//   contract-check.mjs selftest
//       Runs the real CLIs (first-shot-css.mjs, spec-slice.mjs) against a built-in golden
//       fixture in a temp dir and asserts the consumer-visible invariants. Catches schema
//       drift introduced by editing one script without its counterpart. Run at PREFLIGHT —
//       seconds, no phase artifacts needed.
//   contract-check.mjs check <phaseDir>
//       Validates the REAL phase artifacts before the build loop starts:
//         · blocks.json exists with ≥1 block
//         · every block has frames/<id>.png (the visual-diff reference)
//         · every block has briefs/<id>.spec.json and it is not THIN (>2 nodes — a thin slice
//           means empty text masks and false visual diffs downstream)
//         · designSpec.json has nodes
//         · if connect-map.json exists: firstShotCss() over it yields ≥1 rule and at least one
//           entry carries cssDecls (0 rules = the run-2 failure — HALT, fix the map or the script).
//           TWO-PHASE EXCEPTION: when plan-structure.json exists the connect map is structure-only
//           (plan-structure is forbidden to carry cssDecls), so the map is checked structurally and
//           the stylesheet contract is enforced against plan-style.json instead.
//
// Exit codes: 0 = all contracts hold · 2 = violation(s), each printed with a plain-language fix ·
//             1 = usage/internal error.

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { firstShotCss, normalizeEntries, stylePlanCss } from "./first-shot-css.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const run = (args, cwd) => new Promise((res) => execFile("node", args, { cwd }, (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
const exists = (p) => fs.access(p).then(() => true, () => false);
const loadJson = async (p, fallback) => { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; } };
const countRules = (css) => (css.match(/\{/g) || []).length;

// ---- golden fixtures (minimal but exercising the real shapes the planner emits) ----
const FIXTURE_CONNECT_MAP = {
  tokenMap: { "--velt-accent": "#6c5ce7", "--velt-radius": "8px" },
  entries: [
    { element: "Composer", slot: "composer", cssDecls: { root: "padding:12px 16px; border-radius:8px; display:flex", button: "background:#6c5ce7; color:#fff" } },
    { element: "ThreadCard", slot: "thread-card", cssDecls: { root: "gap:8px; border:1px solid #e5e5e5" } },
  ],
  paddingResets: [{ selector: ".velt-comment-dialog--body", decls: "padding:0", why: "wrapper neutralization" }],
};
// the run-2 planner shape: families{} + prop-object cssDecls (the drift that silently no-opped)
const FIXTURE_CONNECT_MAP_FAMILIES = {
  tokenMap: { "--velt-accent": "#6c5ce7" },
  families: {
    "fam-composer": {
      entries: [
        { element: "Composer", slot: "composer", cssDecls: { root: { padding: "12px 16px", "border-radius": "8px" }, button: { background: "#6c5ce7" } } },
      ],
    },
    "fam-thread": [
      { element: "ThreadCard", slot: "thread-card", cssDecls: { gap: "8px", border: "1px solid #e5e5e5" } },
    ],
  },
};
const FIXTURE_DESIGN_SPEC = {
  source: "contract-fixture", fileKey: "FIX", nodeId: "1:1", boxSpace: "frame-relative",
  nodes: [
    { id: "1:100", name: "Composer / Default", frameId: "0:1", box: { x: 0, y: 0, w: 320, h: 96 } },
    { id: "1:101", name: "Input", frameId: "1:100", box: { x: 12, y: 12, w: 240, h: 32 }, text: "Add a comment", cssDecls: { "font-size": "14px" } },
    { id: "1:102", name: "16 send", frameId: "1:100", box: { x: 280, y: 40, w: 16, h: 16 } },
    { id: "1:103", name: "Avatar", frameId: "1:100", box: { x: 12, y: 56, w: 24, h: 24 } },
  ],
  frames: [{ id: "1:100", name: "Composer / Default" }],
  assets: [], iconAssignments: {}, unassignedIcons: [],
};
const FIXTURE_BLOCKS = { blocks: [{ id: "state-composer-default", role: "state", figmaNodeId: "1:100", component: "composer" }] };
// two-phase: the style planner's plan-style.json shape (rules[] — selector real, decls verbatim)
const FIXTURE_STYLE_PLAN = {
  tokenMap: { "--velt-accent": "#6c5ce7" },
  rules: [
    { selector: ".vc-composer", decls: { padding: "12px 16px", background: "#ffffff", border: "1px solid #f1efec" }, specNodeId: "1:100", purpose: "style", state: "default", blockIds: ["state-composer-default"] },
    { selector: "velt-comment-composer-wireframe > div", decls: { padding: "0", margin: "0" }, purpose: "neutralize-wrapper", state: "default", blockIds: ["state-composer-default"] },
    { selector: ".vc-card", decls: { background: "#faf9f7" }, specNodeId: "1:101", purpose: "state-rule", state: "hover", blockIds: ["state-composer-default"] },
  ],
};

async function selftest() {
  const problems = [];
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "velt-contract-"));
  try {
    // 1. first-shot-css: the Connect Map contract — CLI must emit a stylesheet with rules.
    const cmP = path.join(tmp, "connect-map.json");
    const cssP = path.join(tmp, "first-shot.css");
    await fs.writeFile(cmP, JSON.stringify(FIXTURE_CONNECT_MAP, null, 2));
    const fsc = await run([path.join(SCRIPTS, "first-shot-css.mjs"), cmP, "--out", cssP], tmp);
    if (fsc.code !== 0) problems.push(`first-shot-css.mjs CLI failed on the golden Connect Map (exit ${fsc.code}): ${fsc.stderr.trim() || fsc.stdout.trim()} — fix the script/schema before any run`);
    else {
      const css = await fs.readFile(cssP, "utf8").catch(() => "");
      const rules = countRules(css);
      // fixture: :root + 3 entry sub-rules + 1 paddingReset = 5 rule blocks
      if (rules < 5) problems.push(`first-shot-css.mjs emitted ${rules} rule(s) for a fixture that must yield 5 — schema drift between the Connect Map shape and the generator (run 2 burned 50+ min on exactly this)`);
      if (!css.includes(":root")) problems.push("first-shot-css.mjs dropped the tokenMap → :root block — token contract broken");
      if (!css.includes("!important")) problems.push("first-shot-css.mjs no longer applies !important (R9b) — overrides will lose to Velt defaults");
    }
    // 1b. first-shot-css: the FAMILIES shape (run-2 planner output) must also yield rules.
    const cmFamP = path.join(tmp, "connect-map-families.json");
    const cssFamP = path.join(tmp, "first-shot-families.css");
    await fs.writeFile(cmFamP, JSON.stringify(FIXTURE_CONNECT_MAP_FAMILIES, null, 2));
    const fscFam = await run([path.join(SCRIPTS, "first-shot-css.mjs"), cmFamP, "--out", cssFamP], tmp);
    if (fscFam.code !== 0) problems.push(`first-shot-css.mjs CLI failed on the FAMILIES-shape golden map (exit ${fscFam.code}): ${fscFam.stderr.trim() || fscFam.stdout.trim()} — the run-2 planner shape regressed`);
    else {
      const cssFam = await fs.readFile(cssFamP, "utf8").catch(() => "");
      // fixture: :root + 3 entry sub-rules (composer root+button, thread-card root) = 4 rule blocks
      if (countRules(cssFam) < 4) problems.push(`first-shot-css.mjs emitted ${countRules(cssFam)} rule(s) for the FAMILIES fixture that must yield 4 — families{}/prop-object normalization regressed (the run-2 silent 0-rule failure)`);
    }
    // 1c. plan-style.json (two-phase): the CLI must emit a stylesheet with rules, hover pseudo
    // appended mechanically, and HALT (≠0) on an empty rules[] — never a silent no-op.
    const spP = path.join(tmp, "plan-style.json");
    const spCssP = path.join(tmp, "style-plan.css");
    await fs.writeFile(spP, JSON.stringify(FIXTURE_STYLE_PLAN, null, 2));
    const fscSp = await run([path.join(SCRIPTS, "first-shot-css.mjs"), spP, "--out", spCssP], tmp);
    if (fscSp.code !== 0) problems.push(`first-shot-css.mjs CLI failed on the golden plan-style.json (exit ${fscSp.code}): ${fscSp.stderr.trim() || fscSp.stdout.trim()} — the two-phase style-plan contract regressed`);
    else {
      const spCss = await fs.readFile(spCssP, "utf8").catch(() => "");
      // fixture: :root + 3 rules = 4 rule blocks
      if (countRules(spCss) < 4) problems.push(`first-shot-css.mjs emitted ${countRules(spCss)} rule(s) for a plan-style fixture that must yield 4 — the rules[] consumption drifted`);
      if (!spCss.includes(".vc-card:hover")) problems.push("first-shot-css.mjs no longer appends :hover for state:'hover' rules whose selector carries no pseudo");
      if (!spCss.includes("!important")) problems.push("first-shot-css.mjs style-plan output lost !important (R9b)");
    }
    const emptySpP = path.join(tmp, "plan-style-empty.json");
    await fs.writeFile(emptySpP, JSON.stringify({ rules: [] }));
    const fscEmpty = await run([path.join(SCRIPTS, "first-shot-css.mjs"), emptySpP, "--out", path.join(tmp, "empty.css")], tmp);
    if (fscEmpty.code === 0) problems.push("first-shot-css.mjs exited 0 on an EMPTY plan-style.json (0 rules) — the silent-no-op HALT contract regressed");
    // 2. spec-slice: the designSpec/blocks contract — every block must get a NON-THIN brief.
    const specP = path.join(tmp, "designSpec.json");
    const blocksP = path.join(tmp, "blocks.json");
    await fs.writeFile(specP, JSON.stringify(FIXTURE_DESIGN_SPEC, null, 2));
    await fs.writeFile(blocksP, JSON.stringify(FIXTURE_BLOCKS, null, 2));
    const ss = await run([path.join(SCRIPTS, "spec-slice.mjs"), specP, blocksP, "--out-dir", tmp], tmp);
    if (ss.code !== 0) problems.push(`spec-slice.mjs CLI failed on the golden designSpec (exit ${ss.code}): ${ss.stderr.trim() || ss.stdout.trim()}`);
    else {
      const brief = await loadJson(path.join(tmp, "briefs", "state-composer-default.spec.json"), null);
      if (!brief) problems.push("spec-slice.mjs wrote no briefs/<blockId>.spec.json for the fixture block — output-path contract broken");
      else if (!Array.isArray(brief.nodes) || brief.nodeCount <= 2) problems.push(`spec-slice.mjs produced a THIN slice (${brief ? brief.nodeCount : 0} nodes) from a 4-node fixture frame — the frameId/geometry keying regressed (the 1-node-slice bug)`);
    }
  } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
  return problems;
}

async function check(phaseDir) {
  const problems = [];
  const blocksJ = await loadJson(path.join(phaseDir, "blocks.json"), null);
  const blocks = (blocksJ && blocksJ.blocks) || [];
  if (!blocks.length) { problems.push(`no blocks in ${path.join(phaseDir, "blocks.json")} — run enumerate-blocks.mjs first`); return problems; }

  const spec = await loadJson(path.join(phaseDir, "designSpec.json"), null);
  if (!spec || !Array.isArray(spec.nodes) || !spec.nodes.length) problems.push("designSpec.json missing or has no nodes[] — run figma-extract.mjs rest before the loop");

  for (const b of blocks) {
    if (!(await exists(path.join(phaseDir, "frames", `${b.id}.png`)))) problems.push(`block '${b.id}': frames/${b.id}.png missing — the visual-diff reference doesn't exist; re-run enumerate-blocks.mjs rest`);
    const brief = await loadJson(path.join(phaseDir, "briefs", `${b.id}.spec.json`), null);
    if (!brief) problems.push(`block '${b.id}': briefs/${b.id}.spec.json missing — run spec-slice.mjs before the loop`);
    else if ((brief.nodeCount ?? (brief.nodes || []).length) <= 2) problems.push(`block '${b.id}': THIN slice (${brief.nodeCount} nodes) — text masks will be empty and visual diffs false; fix the designSpec/frameId keying before building`);
  }

  // two-phase runs split VALUES out of the connect map: plan-structure.json carries structure only
  // (cssDecls are forbidden there), and plan-style.json is the stylesheet authority.
  const twoPhase = await exists(path.join(phaseDir, "plan-structure.json"));

  // two-phase: plan-style.json → first-shot contract (0 rules = HALT, same as the connect map)
  const spP = path.join(phaseDir, "plan-style.json");
  if (await exists(spP)) {
    const sp = await loadJson(spP, null);
    if (!sp) problems.push("plan-style.json exists but is not valid JSON");
    else {
      const stats = {};
      const rules = countRules(stylePlanCss(sp, stats));
      if (!stats.entries || !stats.entryRules || !rules) problems.push("plan-style.json yields 0 stylesheet rules — an empty/malformed style plan; HALT and fix before dispatching the style builder");
      else console.log(`✓ first-shot over plan-style.json: ${rules} rule(s) from ${stats.entries} plan rules`);
    }
  }

  const cmP = path.join(phaseDir, "connect-map.json");
  if (await exists(cmP)) {
    const cm = await loadJson(cmP, null);
    if (!cm) problems.push("connect-map.json exists but is not valid JSON");
    else {
      // normalizeEntries flattens BOTH shapes (entries[] and families{}) — count what the generator sees
      const entries = normalizeEntries(cm);
      if (twoPhase) {
        // TWO-PHASE: plan-structure is FORBIDDEN to carry cssDecls (values are the style planner's,
        // checked above against plan-style.json). Validate the map STRUCTURALLY here instead.
        const withSlot = entries.filter((e) => String(e.slot || "").trim());
        if (!entries.length) problems.push("connect-map.json has no entries — the structure plan mapped nothing; fix the Planner's map");
        else if (!withSlot.length) problems.push("connect-map.json: no entry names a slot — a structure map without slots builds nothing; fix the Planner's map");
        else console.log(`✓ connect-map.json (structure stage): ${entries.length} entries, ${withSlot.length} with a slot — CSS values deferred to plan-style.json`);
      } else {
        const withDecls = entries.filter((e) => Object.values(e._groups).some((d) => String(d).trim()));
        if (entries.length && !withDecls.length) problems.push("connect-map.json: no entry carries usable cssDecls — first-shot will be empty and the builder will re-discover every value (the run-2 failure); fix the Planner's map");
        const stats = {};
        const rules = countRules(firstShotCss(cm, {}, stats));
        if (!rules || (stats.entries > 0 && stats.entryRules === 0)) problems.push("first-shot-css over this connect-map.json yields 0 entry rules — schema drift or an empty map; HALT and fix before dispatching any builder");
        else console.log(`✓ first-shot over connect-map.json: ${rules} rule(s) (${stats.entryRules} entry rule(s)) from ${entries.length} entries`);
      }
    }
  }
  return problems;
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "selftest") {
    const problems = await selftest();
    if (problems.length) { console.error(`✗ pipeline contract SELFTEST failed (${problems.length}):`); for (const p of problems) console.error("  · " + p); process.exit(2); }
    console.log("✓ pipeline contract selftest: first-shot-css + spec-slice hold their producer→consumer contracts");
  } else if (cmd === "check") {
    if (!arg) { console.error("usage: contract-check.mjs check <phaseDir>"); process.exit(1); }
    const problems = await check(path.resolve(arg));
    if (problems.length) { console.error(`✗ phase artifact contracts VIOLATED (${problems.length}) — do NOT start the build loop:`); for (const p of problems) console.error("  · " + p); process.exit(2); }
    console.log("✓ phase artifacts hold: blocks, frames, non-thin briefs, designSpec, first-shot generatable");
  } else {
    console.error("usage: contract-check.mjs selftest | check <phaseDir>");
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

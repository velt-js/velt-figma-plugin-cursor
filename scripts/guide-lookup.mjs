#!/usr/bin/env node
// guide-lookup.mjs — the DETERMINISTIC guide router. Agents must never read a large reference
// file whole "to be safe": this script returns the exact, ordered reading list for a task
// (role × approach × feature × surface), and extracts individual SECTIONS from the big
// reference files by heading match — so a Builder styling one sidebar block reads ~200 lines
// of guide, not 16k. The routing table below is the mechanical form of guide/README.md's
// "how to use this guide"; knowledge stays in guide/, this file only routes to it.
//
// Usage:
//   node scripts/guide-lookup.mjs files --role plan|build|judge
//        [--approach css|wireframes|primitives|headless|mixed[,another]]
//        [--feature comments|notifications] [--surface sidebar|dialog|pin|...] [--json]
//   node scripts/guide-lookup.mjs section <guide-relative-file> <query terms...>
//        [--list]            # list matching headings + line ranges only (no content)
//        [--max-lines 400]   # total content cap (truncation is REPORTED, never silent)
//
// `files` marks big files [SECTION-INDEXED]: those must be read ONLY via the `section`
// subcommand (or via the exact line-range the `--list` output names) — never whole.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUIDE = path.join(ROOT, "guide");

// files above ~400 lines: whole-file reads are forbidden, section extraction only.
const SECTION_INDEXED = new Set([
  "reference/wireframe-components.md",
  "reference/css-classes.md",
  "reference/component-definitions.md",
  "reference/props.md",
  "reference/apis.md",
  "reference/css-variables.md",
  "reference/primitives.md",
  "reference/data-models.md",
  "reference/wireframe-variables.md",   // per-component ## sections — a builder needs ONE surface's variables, not the 23-component catalog
]);

// guide/rules.md is RULE-INDEXED, not section-indexed: it is read ONLY via the `rules`
// subcommand (per-ID slices from RULE_INDEX — base + approach + role + the items' stamped
// ruleIds), never whole. Its one non-rule section (the Quick gate checklist) is extracted
// via `section rules.md "Quick gate"` (judge only).
const RULE_INDEXED = new Set(["rules.md"]);

// surface → the behaviors file that owns it (see each file's own scope line).
const SURFACE_BEHAVIORS = {
  sidebar: "reference/behaviors/sidebar.md",
  dialog: "reference/behaviors/dialog.md",
  inline: "reference/behaviors/dialog.md",
  composer: "reference/behaviors/dialog.md",
  thread: "reference/behaviors/dialog.md",
  comments: "reference/behaviors/comments-core.md",
  pin: "reference/behaviors/pins-tools.md",
  bubble: "reference/behaviors/pins-tools.md",
  tool: "reference/behaviors/pins-tools.md",
  notifications: "reference/behaviors/notifications.md",
  presence: "reference/behaviors/presence-reactions.md",
  cursor: "reference/behaviors/presence-reactions.md",
  reactions: "reference/behaviors/presence-reactions.md",
  recorder: "reference/behaviors/recorder-huddle.md",
  huddle: "reference/behaviors/recorder-huddle.md",
};

const FEATURE_FILES = {
  // reactions.md rides with comments: reaction slots (ReactionPin/Reactions/ReactionTool) live on the
  // comment thread-card, and its default-reaction-id list is otherwise unreachable (the `reactions`
  // SURFACE key routes to presence-reactions.md, which is the video/presence picker) — a comments
  // builder once escalated a solvable thumbs-up blocker because no route surfaced these ids.
  comments: ["features/comment-surfaces.md", "features/mentions-and-autocomplete.md", "features/reactions.md"],
  notifications: ["features/notifications.md"],
  reactions: ["features/reactions.md"],
};

// per-approach reference sets (the Builder's procedure + identifier sources for that layer).
const APPROACH_FILES = {
  css: [
    ["approaches/css.md", "the per-layer procedure"],
    ["reference/css-variables.md", "only the sections for this surface's components"],
    ["reference/css-classes.md", "only the sections for this surface's components"],
  ],
  wireframes: [
    ["approaches/wireframes.md", "the per-layer procedure"],
    ["reference/wireframe-components.md", "only this surface's slot tree + the appendix rows you map"],
    ["reference/wireframe-variables.md", "only this surface's component section of the {…} variable catalog"],
    ["reference/wireframe-tokens.md", "the {…} syntax"],
  ],
  primitives: [
    ["approaches/primitives.md", "the per-layer procedure"],
    ["reference/primitives.md", "only this surface's primitive"],
    ["reference/primitives-capabilities.md", "R1 children / R2 context / R3 data — capabilities, limits, reachability"],
    ["reference/props.md", "only this surface's component part"],
    ["reference/component-config.md", "config sub-components"],
    ["reference/hooks.md", "hooks catalog (small)"],
  ],
  headless: [
    ["approaches/headless.md", "the per-layer procedure"],
    ["reference/apis.md", "only the APIs the plan names"],
    ["reference/data-models.md", "only the objects the plan names"],
  ],
};

function roleFiles({ role, approaches, feature, surface }) {
  const out = []; // [relPath, why]
  const add = (rel, why) => { if (!out.some(([r]) => r === rel)) out.push([rel, why]); };

  if (role === "plan") {
    add("02-decision-tree.md", "layer decision (Q1–Q4, S1–S8) — within the run's mode");
    add("build-methodology.md", "Step 1 — the design-overview procedure");
    add("reference/component-catalog.md", "Surface lookup — surface → identifiers");
    add("reference/component-definitions.md", "recognition catalog — only the in-scope feature sections");
    add("reference/manifest.md", "Connect-Map fields: slots, roles, mustSupply, contract, hostProps");
    add("extraction.md", "designSpec extraction contract");
    if (surface && SURFACE_BEHAVIORS[surface]) add(SURFACE_BEHAVIORS[surface], "prop behavior for the recognized surface");
    else add("reference/behaviors.md", "behaviors index — then open only the per-surface file");
    add("reference/css-variables.md", "token mapping (Figma vars → --velt-*) — sections only");
    add("reference/data-models.md", "ONLY when judging primitives/headless feasibility — sections only");
    add("edge-cases-and-limitations.md", "coverage-matrix achievability");
    add("rules.md", "the applicable rule slices (base + plan) — via the rules subcommand, never whole");
  } else if (role === "build") {
    add("build-methodology.md", "Step 2 — structure, then small pixel-perfect patches");
    add("build-gotchas.md", "the traps — read BEFORE building");
    add("rules.md", "the stamped ruleIds' slices — via the rules subcommand, never whole");
    for (const ap of approaches) for (const [rel, why] of APPROACH_FILES[ap] || []) add(rel, why);
    if (approaches.length > 1) add("approaches/combining-approaches.md", "mixing layers on one surface");
    if (surface && SURFACE_BEHAVIORS[surface]) add(SURFACE_BEHAVIORS[surface], "what the surface's props do at runtime");
  } else if (role === "judge") {
    add("verifying-a-customization.md", "the what-to-verify flow + verdicts");
    add("rules.md", "rule slices + the Quick gate checklist — via the rules/section subcommands, never whole");
    add("reference/manifest.md", "mustSupply / roles / layout / contract — the expectations");
    if (surface && SURFACE_BEHAVIORS[surface]) add(SURFACE_BEHAVIORS[surface], "expected default behaviors to drive");
    add("debugging.md", "ONLY on a non-render (app-vs-build triage)");
    add("cross-cutting.md", "ONLY for dark-mode / responsive states");
  }
  for (const f of FEATURE_FILES[feature] || []) add(f, `feature notes (${feature})`);
  return out;
}

// ---- rule index (P1-6) ----
// Maps context → the rule IDs that apply, so the Planner can stamp `ruleIds` per work item and
// the Builder/Judge load ONLY those rules' text. guide/rules.md stays the single canonical source
// (no per-feature rule forks to drift); this table only routes into it.
const RULE_INDEX = {
  base: ["R0", "R10", "R11", "R15", "R16", "R17", "R18", "R20", "R26"],
  approach: {
    css: ["R6", "R8", "R9", "R9b", "R22", "R23"],
    wireframes: ["R1", "R2", "R4", "R5", "R7", "R14", "R19", "R21", "R22", "R23", "R25", "R27", "R28"],
    primitives: ["R3", "R5", "R12", "R13", "R24"],
    headless: ["R13"],
  },
  role: {
    plan: ["R3", "R12", "R21", "R24", "R30"],          // R30: the Planner authors each family's smoke spec
    build: ["R21", "R24"],
    judge: ["R25", "R26", "R27", "R29", "R30"],        // R29: accepted glyph residue · R30: family smoke gate
  },
};

// slice guide/rules.md into per-rule text: rules appear as `**R<n> — …**` bold markers
// (and R0 as a `## R0 —` heading); a rule runs to the next rule marker / heading / hr.
function parseRules(lines) {
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    let m = lines[i].match(/^\*\*(R\d+b?) —/);
    if (!m) m = lines[i].match(/^##\s+(R\d+b?) —/);
    if (m) marks.push({ id: m[1], start: i, title: lines[i].replace(/\*\*/g, "") });
  }
  return marks.map((mk, idx) => {
    let end = lines.length;
    for (let j = mk.start + 1; j < end; j++) {
      const l = lines[j];
      if (/^\*\*R\d+b? —/.test(l) || /^##/.test(l) || /^---/.test(l)) { end = j; break; }
    }
    if (idx + 1 < marks.length) end = Math.min(end, marks[idx + 1].start);
    return { ...mk, end };
  });
}

async function rulesCmd({ approach, role, list }) {
  const approaches = (approach || "").split(",").map((s) => s.trim()).filter(Boolean)
    .flatMap((a) => (a === "mixed" ? ["wireframes", "css"] : [a]));
  const ids = new Set(RULE_INDEX.base);
  for (const a of approaches) { if (!RULE_INDEX.approach[a]) { console.error(`✗ unknown approach '${a}'`); process.exit(1); } for (const r of RULE_INDEX.approach[a]) ids.add(r); }
  if (role) { if (!RULE_INDEX.role[role]) { console.error(`✗ unknown role '${role}' (plan|build|judge)`); process.exit(1); } for (const r of RULE_INDEX.role[role]) ids.add(r); }
  const src = await fs.readFile(path.join(GUIDE, "rules.md"), "utf8");
  const lines = src.split("\n");
  const rules = parseRules(lines);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const ordered = [...ids].sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)) || a.localeCompare(b));
  const missing = ordered.filter((id) => !byId.has(id));
  if (missing.length) console.error(`⚠ rule IDs not found in guide/rules.md (index drift — fix RULE_INDEX): ${missing.join(", ")}`);
  console.log(`${ordered.length} applicable rule(s)${approaches.length ? " for " + approaches.join("+") : ""}${role ? " role=" + role : ""}: ${ordered.join(" ")}`);
  for (const id of ordered) {
    const r = byId.get(id);
    if (!r) continue;
    if (list) console.log(`  ${id}  guide/rules.md:${r.start + 1}-${r.end}  ${r.title.slice(0, 100)}`);
    else console.log(`\n── ${id} (guide/rules.md:${r.start + 1}-${r.end}) ─────\n${lines.slice(r.start, r.end).join("\n").trim()}`);
  }
}

// ---- section extraction ----
function parseSections(lines) {
  const heads = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const m = lines[i].match(/^(#{1,4})\s+(.*)/);
    if (m) heads.push({ level: m[1].length, text: m[2].trim(), start: i });
  }
  return heads.map((h, idx) => {
    let end = lines.length;
    for (let j = idx + 1; j < heads.length; j++) if (heads[j].level <= h.level) { end = heads[j].start; break; }
    return { ...h, end };
  });
}

async function sectionCmd(rel, terms, { list, maxLines }) {
  const abs = path.join(GUIDE, rel);
  const src = await fs.readFile(abs, "utf8").catch(() => null);
  if (src === null) { console.error(`✗ no such guide file: ${rel}`); process.exit(1); }
  const lines = src.split("\n");
  const sections = parseSections(lines);
  const t = terms.map((s) => s.toLowerCase()).filter(Boolean);
  if (!t.length) { console.error("✗ give at least one query term (e.g. a component, slot, or class name)"); process.exit(1); }

  const headHit = (s) => t.every((q) => s.text.toLowerCase().includes(q));
  const bodyHit = (s) => { const body = lines.slice(s.start, s.end).join("\n").toLowerCase(); return t.every((q) => body.includes(q)); };
  let hits = sections.filter(headHit);
  let via = "heading";
  if (!hits.length) { hits = sections.filter(bodyHit); via = "body"; }
  // prefer the DEEPEST matching sections — drop any hit that fully contains another hit.
  hits = hits.filter((a) => !hits.some((b) => b !== a && b.start >= a.start && b.end <= a.end));
  if (!hits.length) { console.log(`no section of ${rel} matches [${terms.join(", ")}] — try fewer/other terms, or --list on a broader term`); process.exit(0); }

  console.log(`${hits.length} section(s) of ${rel} match [${terms.join(", ")}] (by ${via}):`);
  let budget = maxLines, truncated = 0;
  for (const s of hits) {
    const range = `${rel}:${s.start + 1}-${s.end}`;
    if (list) { console.log(`  · ${"#".repeat(s.level)} ${s.text}  (${range}, ${s.end - s.start} lines)`); continue; }
    const body = lines.slice(s.start, s.end);
    console.log(`\n── ${range} ─────`);
    if (body.length <= budget) { console.log(body.join("\n")); budget -= body.length; }
    else if (budget > 20) { console.log(body.slice(0, budget).join("\n")); console.log(`… [section truncated at ${budget} of ${body.length} lines — Read ${range} for the rest]`); budget = 0; }
    else truncated++;
  }
  if (truncated) console.log(`\n… ${truncated} matching section(s) not printed (line budget ${maxLines} spent) — re-run with --list to get their exact line ranges, then Read those ranges.`);
}

// ---- files command ----
async function filesCmd(opts) {
  const role = opts.role;
  if (!["plan", "build", "judge"].includes(role || "")) { console.error("✗ --role plan|build|judge is required"); process.exit(1); }
  const approaches = (opts.approach || "").split(",").map((s) => s.trim()).filter(Boolean)
    .flatMap((a) => (a === "mixed" ? ["wireframes", "css"] : [a]));
  for (const a of approaches) if (!APPROACH_FILES[a]) { console.error(`✗ unknown approach '${a}' (css|wireframes|primitives|headless|mixed)`); process.exit(1); }
  if (role === "build" && !approaches.length) { console.error("✗ role=build requires --approach"); process.exit(1); }
  if (opts.surface && !SURFACE_BEHAVIORS[opts.surface]) console.error(`⚠ unknown surface '${opts.surface}' — no behaviors file routed (known: ${Object.keys(SURFACE_BEHAVIORS).join(", ")})`);

  const entries = roleFiles({ role, approaches, feature: opts.feature, surface: opts.surface });
  const resolved = [];
  for (const [rel, why] of entries) {
    const ok = await fs.access(path.join(GUIDE, rel)).then(() => true, () => false);
    if (!ok) { console.error(`⚠ routing table names a missing guide file: ${rel} (fix guide-lookup.mjs or the guide)`); continue; }
    resolved.push({ file: `guide/${rel}`, why, sectionIndexed: SECTION_INDEXED.has(rel), ruleIndexed: RULE_INDEXED.has(rel) });
  }
  if (opts.json) { console.log(JSON.stringify({ role, approaches, feature: opts.feature || null, surface: opts.surface || null, files: resolved }, null, 2)); return; }

  console.log(`Reading list — role=${role}${approaches.length ? " approach=" + approaches.join("+") : ""}${opts.feature ? " feature=" + opts.feature : ""}${opts.surface ? " surface=" + opts.surface : ""}`);
  resolved.forEach((e, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${e.file}${e.ruleIndexed ? "  [RULE-INDEXED]" : e.sectionIndexed ? "  [SECTION-INDEXED]" : ""}`);
    console.log(`      ${e.why}`);
    if (e.ruleIndexed) {
      console.log(`      → node scripts/guide-lookup.mjs rules --role ${role}${approaches.length ? " --approach " + approaches.join(",") : ""}   # per-ID slices (+ the items' stamped ruleIds)`);
      if (role === "judge") console.log(`      → node scripts/guide-lookup.mjs section rules.md "Quick gate"   # the shipping checklist`);
    } else if (e.sectionIndexed) console.log(`      → node scripts/guide-lookup.mjs section ${e.file.replace(/^guide\//, "")} "<component/slot/class>"`);
  });
  console.log(`\nRule: read ONLY these files. [SECTION-INDEXED] files are read ONLY via the section subcommand, [RULE-INDEXED] (rules.md) ONLY via the rules subcommand — never whole.`);
}

// ---- main ----
async function main() {
  const a = process.argv.slice(2);
  const cmd = a[0];
  const flag = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  if (cmd === "files") {
    await filesCmd({ role: flag("--role"), approach: flag("--approach"), feature: flag("--feature"), surface: flag("--surface"), json: a.includes("--json") });
  } else if (cmd === "section") {
    const rel = a[1];
    if (!rel) { console.error("usage: guide-lookup.mjs section <guide-relative-file> <query terms...>"); process.exit(1); }
    const terms = a.slice(2).filter((x) => !x.startsWith("--") && x !== flag("--max-lines"));
    await sectionCmd(rel.replace(/^guide\//, ""), terms, { list: a.includes("--list"), maxLines: +flag("--max-lines", "400") });
  } else if (cmd === "rules") {
    await rulesCmd({ approach: flag("--approach"), role: flag("--role"), list: a.includes("--list") });
  } else {
    console.error("usage:\n  guide-lookup.mjs files --role plan|build|judge [--approach …] [--feature …] [--surface …] [--json]\n  guide-lookup.mjs section <file> <query terms...> [--list] [--max-lines N]\n  guide-lookup.mjs rules [--approach …] [--role plan|build|judge] [--list]");
    process.exit(1);
  }
}

main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

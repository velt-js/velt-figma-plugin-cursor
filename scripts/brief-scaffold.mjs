#!/usr/bin/env node
// brief-scaffold.mjs — deterministic SKELETONS for the per-block probe briefs + per-family smoke
// specs, so the Planner FILLS briefs instead of AUTHORING them. The first --auto cloud run sprawled
// ~80+ min in planning largely because we asked an LLM to hand-write 13 probes.json + 5 smoke.json
// machine-exact files. Everything below is derivable from artifacts that already exist:
//   * `browser` probe elements  ← the block's spec slice (nodes with cssDecls + boxes)
//   * `contract` probe entries  ← the manifest component's contract.parts (selectorHints)
//   * `stability` targets       ← the manifest's interactive-role slots (trigger/action/item)
//   * `liveSelector` default    ← the block's component root wireframe tag
// The Planner's remaining job is the genuinely cognitive part: fill `drive.steps`, verify selectors
// against the live DOM (post-build-stable ones — contract wireframe tags / stable velt-* / .vc-*),
// tune relations/gaps, and flesh out the smoke steps. Every field it must complete is marked with a
// "_todo" key; `--lint` fails while any remains, so a half-filled brief can't reach measure-block.
//
// Usage:
//   node scripts/brief-scaffold.mjs <phaseDir> [--connect-map <file>] [--manifest <file>]
//   node scripts/brief-scaffold.mjs <phaseDir> --lint      # exit 0 clean · 2 _todo leftovers remain
//
// Existing briefs are never overwritten (the Planner's filled work is sacred); missing ones are
// scaffolded. Run spec-slice.mjs FIRST (skeletons read the slices).

import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function loadJson(p) { return JSON.parse(await fs.readFile(p, "utf8")); }
async function exists(p) { return fs.access(p).then(() => true, () => false); }

// "padding:12px 16px; display:flex" | {sub: "decls"} → flat {prop: value}
function declsToObject(decls) {
  if (!decls) return {};
  if (typeof decls === "object") {
    // node cssDecls from figma-extract are already {prop: value}
    if (Object.values(decls).every((v) => typeof v === "string" && !v.includes(":"))) return decls;
    const out = {};
    for (const v of Object.values(decls)) if (typeof v === "string") for (const d of v.split(";")) {
      const i = d.indexOf(":"); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
    return out;
  }
  const out = {};
  for (const d of String(decls).split(";")) { const i = d.indexOf(":"); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim(); }
  return out;
}

// which manifest component does this block belong to? match the block's component/surface name
// against component names loosely; default to the first component (single-surface designs).
function componentFor(manifest, block) {
  const names = Object.keys(manifest.components || {});
  const hint = slug(`${block.component || ""} ${block.surface || ""} ${block.id}`);
  const scored = names.map((n) => {
    const parts = slug(n.replace(/^Velt|Wireframe$/g, "")).split("-").filter(Boolean);
    return { n, score: parts.filter((p) => hint.includes(p)).length };
  }).sort((a, b) => b.score - a.score);
  return manifest.components[scored[0]?.score ? scored[0].n : names[0]] || null;
}

const INTERACTIVE_ROLES = new Set(["trigger", "action", "item", "button"]);

export function scaffoldProbes(block, sliceNodes, comp) {
  const rootTag = comp?.rootWireframe || null;
  const liveSelector = block.liveSelector || rootTag || null;
  const elements = (sliceNodes || [])
    .filter((n) => n.id !== block.figmaNodeId && n.cssDecls && Object.keys(n.cssDecls).length)
    .map((n) => ({
      name: slug(n.name) || n.id,
      selector: null,
      _todo_selector: `live selector for '${n.name}' — post-build-STABLE only: a contract wireframe tag, a stable velt-* class, or the builder's .vc-${slug(n.name)} class; NEVER pre-build DOM the wireframe will replace`,
      expected: declsToObject(n.cssDecls),
      box: n.box || null,
    }));
  const contractEntries = (comp?.contract?.parts || []).map((p) => ({
    part: p.part,
    selector: p.selectorHint,
    ...(p.requiredAncestorHint ? { requiredAncestor: p.requiredAncestorHint } : {}),
    ...(p.singleton ? { singleton: true } : {}),
  }));
  const stabilityTargets = (comp?.slots || [])
    .filter((s) => INTERACTIVE_ROLES.has(s.role))
    .map((s) => ({ name: slug(s.reactPath.split(".").pop()), selector: s.tag }));
  return {
    blockId: block.id,
    liveSelector,
    ...(liveSelector ? {} : { _todo_liveSelector: "the element that DEFINES this block, verified live" }),
    drive: {
      steps: [],
      _todo_steps: `machine actions to reach state '${block.state}' (vocabulary: click|dblclick|hover|type|press|waitFor|sleep|eval|clear|selectUser). Prose hints from enumeration: ${JSON.stringify((block.drive && block.drive.steps) || [])}`,
      assert: (block.drive && block.drive.assert) || null,
      ...((block.drive && block.drive.assert) ? {} : { _todo_assert: "a live selector proving the state is active (a blank/default capture is the classic false-pass)" }),
    },
    browser: {
      surfaceSelector: liveSelector,
      tol: {},
      elements,
      relations: [],
      gaps: [],
      _todo_relations: "add the layout relations/gaps the design shows (name left-of time, message below header, …) from the connect-map layout block",
    },
    layer: null,
    _todo_layer: "LAYER_PROBE spec(s) for each painted node the design styles (ownerSelector + expectedBox + designPaint), or [] if none",
    contract: contractEntries.length ? { surfaceSelector: liveSelector, entries: contractEntries } : null,
    stability: { surfaceSelector: liveSelector, targets: stabilityTargets },
    scaffoldedBy: "brief-scaffold.mjs",
  };
}

export function scaffoldSmoke(family) {
  const step = (name, todo) => ({ name, actions: [], _todo_actions: todo, assert: null });
  return {
    familyId: family.id,
    steps: [
      step("short-message", "type a SHORT message (1-2 words) end-to-end and assert it posts — a full-width fixture masked a flex-end bug in the baseline run"),
      step("max-length-message", "type a MAX-LENGTH message; assert growth/scroll behavior and no dead band (never pin min-height to a multi-line fixture)"),
      step("every-dialog-context", "exercise this family's surface in EVERY dialog context it appears in (sidebar card / popover open-dialog / hover preview) — shared classes leak across contexts"),
      step("affordances-once", "click every affordance once (reply, resolve, edit, options) asserting the outcome fires and nothing shifts"),
    ],
    resize: { width: 1100, height: 800, assert: null, _todo_assert: "selector that must stay visible/laid-out after resize" },
    forbidConsoleErrors: true,
    scaffoldedBy: "brief-scaffold.mjs",
  };
}

function findTodos(obj, trail = "", out = []) {
  if (Array.isArray(obj)) obj.forEach((v, i) => findTodos(v, `${trail}[${i}]`, out));
  else if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("_todo")) out.push(`${trail}.${k}`);
    else findTodos(v, trail ? `${trail}.${k}` : k, out);
  }
  return out;
}

async function main() {
  const [phaseDir, ...rest] = process.argv.slice(2);
  if (!phaseDir) { console.error("usage: brief-scaffold.mjs <phaseDir> [--connect-map f] [--manifest f] [--lint]"); process.exit(1); }
  const flag = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  const briefsDir = path.join(phaseDir, "briefs");
  const blocks = await loadJson(path.join(phaseDir, "blocks.json"));

  if (rest.includes("--lint")) {
    let dirty = 0, checked = 0;
    for (const b of blocks.blocks || []) {
      const p = path.join(briefsDir, `${b.id}.probes.json`);
      if (!(await exists(p))) { console.log(`✗ ${b.id}: probes.json MISSING`); dirty++; continue; }
      const todos = findTodos(await loadJson(p)); checked++;
      if (todos.length) { console.log(`✗ ${b.id}: ${todos.length} unfilled _todo field(s): ${todos.slice(0, 4).join(", ")}${todos.length > 4 ? ", …" : ""}`); dirty++; }
    }
    for (const f of blocks.families || []) {
      const p = path.join(briefsDir, `${f.id}.smoke.json`);
      if (!(await exists(p))) { console.log(`✗ family ${f.id}: smoke.json MISSING`); dirty++; continue; }
      const todos = findTodos(await loadJson(p));
      if (todos.length) { console.log(`✗ family ${f.id}: ${todos.length} unfilled _todo field(s)`); dirty++; }
    }
    console.log(dirty ? `✗ ${dirty} brief(s) incomplete — the Planner must fill every _todo before the build loop starts` : `✓ all briefs complete (${checked} blocks + ${(blocks.families || []).length} families, zero _todo leftovers)`);
    process.exit(dirty ? 2 : 0);
  }

  const manifest = await loadJson(path.resolve(flag("--manifest", path.join(PLUGIN_ROOT, "manifest", "velt-codeconnect.json"))));
  await fs.mkdir(briefsDir, { recursive: true });
  let made = 0, kept = 0;
  for (const b of blocks.blocks || []) {
    const p = path.join(briefsDir, `${b.id}.probes.json`);
    if (await exists(p)) { kept++; continue; }   // never clobber the Planner's filled work
    const slicePath = path.join(briefsDir, `${b.id}.spec.json`);
    let slice = { nodes: [] };
    if (await exists(slicePath)) {
      try { slice = await loadJson(slicePath); }
      catch { console.error(`⚠ ${b.id}: slice unreadable/truncated — scaffolding with 0 elements (re-run spec-slice.mjs for this block)`); }
    } else console.error(`⚠ ${b.id}: no spec slice found — scaffolding with 0 elements (run spec-slice.mjs first)`);
    const comp = componentFor(manifest, b);
    await fs.writeFile(p, JSON.stringify(scaffoldProbes(b, slice.nodes, comp), null, 2));
    made++;
  }
  for (const f of blocks.families || []) {
    const p = path.join(briefsDir, `${f.id}.smoke.json`);
    if (await exists(p)) { kept++; continue; }
    await fs.writeFile(p, JSON.stringify(scaffoldSmoke(f), null, 2));
    made++;
  }
  console.log(`✓ scaffolded ${made} brief(s) (${kept} existing kept) → ${path.relative(process.cwd(), briefsDir)}`);
  console.log(`  The Planner now FILLS the _todo fields only (drive steps, selectors, relations, smoke actions) — then 'brief-scaffold.mjs ${phaseDir} --lint' must pass before the build loop.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

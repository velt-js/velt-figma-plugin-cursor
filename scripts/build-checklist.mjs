#!/usr/bin/env node
// build-checklist.mjs — GENERATE the Judge's checklist deterministically from the designSpec + manifest.
// This is the mechanism that makes "passed on a sample" impossible: the checklist is DERIVED, not
// hand-authored by the Judge. Coverage is then enforced by verdict-gate.mjs — a judge report that
// measures fewer entries than this checklist is INCOMPLETE (cannot terminate), no matter how many
// of the sampled entries pass. (This is the fix for the M5 sampling failure reproduced in the E2E run.)
//
// The checklist's `elements` = every DISTINCT styled appearance in the design (deduped by the set of
// box-painting/typography declarations). If the design has a teal mention, a tag-others placeholder,
// a filter row — each distinct style is an entry the Judge must account for (measure / flag / waive).
//
// Usage: node scripts/build-checklist.mjs --spec <designSpec.json> [--manifest <path>] [--out <path>]

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

// the declarations that constitute a "distinct styled appearance" worth verifying
const STYLE_KEYS = ["color", "background", "border", "border-radius", "padding", "font-size", "font-weight", "line-height", "letter-spacing"];
const MEANINGFUL = new Set(["color", "background", "border", "font-size"]); // a node must carry at least one of these

function styleSig(cssDecls) {
  const picked = {};
  for (const k of STYLE_KEYS) if (cssDecls[k] != null) picked[k] = cssDecls[k];
  return picked;
}
function sigKey(sig) { return STYLE_KEYS.map((k) => k + ":" + (sig[k] ?? "")).join("|"); }

export function buildChecklist(designSpec, manifest) {
  const nodes = designSpec.nodes || [];
  // 1. distinct styled appearances (the design's full visible style set — the anti-sampling core)
  const bySig = new Map();
  for (const n of nodes) {
    const css = n.cssDecls || {};
    if (!STYLE_KEYS.some((k) => k in css) || !STYLE_KEYS.some((k) => MEANINGFUL.has(k) && k in css)) continue;
    const sig = styleSig(css);
    const key = sigKey(sig);
    if (!bySig.has(key)) bySig.set(key, { expected: sig, count: 0, sample: "" });
    const e = bySig.get(key);
    e.count++;
    if (!e.sample && n.text) e.sample = (typeof n.text === "string" ? n.text : Array.isArray(n.text) ? n.text.join("") : String(n.text)).slice(0, 28);
    if (!e.sample && n.name && !/^(frame|group|rectangle|vector|__)/i.test(n.name)) e.sample = n.name.slice(0, 28);
  }
  const elements = [...bySig.values()]
    .sort((a, b) => b.count - a.count)
    .map((e, i) => ({ id: "style-" + (i + 1), name: e.sample || "(unnamed style)", expected: e.expected, instances: e.count }));

  // 2. manifest-driven obligations (mustSupply slots + behavioral contract parts) across all overlay components
  const mustSupply = [], contractParts = [];
  const states = new Set(["default"]);
  for (const c of Object.values(manifest.components || {})) {
    for (const s of c.slots || []) if (s.mustSupply) mustSupply.push({ id: "supply:" + s.reactPath, reactPath: s.reactPath, slotType: s.slotType });
    for (const p of (c.contract && c.contract.parts) || []) contractParts.push({ id: "mount:" + p.reactPath, part: p.part, requiredAncestorHint: p.requiredAncestorHint, singleton: p.singleton });
    // states declared in the layout block (e.g. hover-reveal) become required states
    for (const grp of Object.values(c.layout || {})) for (const v of Object.values(grp.states || {})) {
      if (/hover/.test(v)) states.add("hover");
      if (/open/.test(v)) states.add("popup-open");
    }
  }
  // standard states a comments surface must be driven in
  ["hover", "filter-open", "options-open", "empty", "resolved", "composer-active"].forEach((s) => states.add(s));

  return {
    surface: designSpec.nodeId || "surface",
    generatedFrom: { source: designSpec.source, boxSpace: designSpec.boxSpace, manifestHash: manifest.version && manifest.version.hash },
    elements,            // distinct styled appearances — EVERY one must get a Judge disposition
    mustSupply,          // every mustSupply slot must be supplied + verified
    contractParts,       // every behavioral primitive must mount (mount-map)
    states: [...states], // every state must be driven
    requiredArtifacts: ["styleDelta", "layout", "reconciliation", "contract", "visualSideBySide"],
  };
}

async function main() {
  const specPath = argv("--spec");
  if (!specPath) { console.error("usage: build-checklist.mjs --spec <designSpec.json> [--manifest <path>] [--out <path>]"); process.exit(1); }
  const manifestPath = argv("--manifest", path.join(ROOT, "manifest/velt-codeconnect.json"));
  const outPath = argv("--out", path.join(path.dirname(specPath), "checklist.json"));
  const designSpec = JSON.parse(await fs.readFile(specPath, "utf8"));
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8").catch(() => "{}"));
  const checklist = buildChecklist(designSpec, manifest);
  await fs.writeFile(outPath, JSON.stringify(checklist, null, 2) + "\n");
  console.log(`✓ checklist generated → ${path.relative(process.cwd(), outPath)}`);
  console.log(`  ${checklist.elements.length} distinct styled appearances · ${checklist.mustSupply.length} mustSupply · ${checklist.contractParts.length} mount-map parts · ${checklist.states.length} states`);
  console.log(`  The Judge MUST produce a disposition for every one (verdict-gate enforces coverage — a sample is INCOMPLETE, not PASS).`);
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

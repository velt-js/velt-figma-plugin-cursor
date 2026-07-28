#!/usr/bin/env node
// first-shot-css.mjs — the DETERMINISTIC FIRST-SHOT STYLESHEET. The run autopsies showed the builder
// "discovering" CSS values across up to 8 thinking-model patch iterations — values that already sit,
// exact, in the Connect Map's cssDecls (extracted from Figma). This script writes the initial
// stylesheet FROM the Connect Map, before any LLM turn: the builder then only wires selectors and
// reconciles residual diffs (typical 8 iterations → 2-3). No LLM, no eyeballing, sub-second.
//
// Selector resolution, per entry sub-element, in order:
//   1. --selector-map <json>: { "<entrySlug>.<subKey>" | "<subKey>": "<live selector>" } — from
//      memory.json mappings / a prior block's discovered classes;
//   2. otherwise a `.vc-<entrySlug>-<subKey>` PLACEHOLDER class: the builder puts that class on the
//      wireframe markup it writes (it controls the markup), or swaps the placeholder for the real
//      Velt class it discovers live. Either way the NUMBERS are already final — only wiring remains.
//
// Every declaration gets `!important` (R9b — overriding Velt defaults). tokenMap entries become
// :root custom-property assignments up top.
//
// Accepted Connect-Map shapes (run 2's planner wrote families{}; both are first-class now):
//   { entries: [ {element, slot, cssDecls} ] }                     — flat
//   { families: { <famId>: [entry,…] | {entries:[…]} } }           — per-family
//   cssDecls: "p:v; p:v" | {sub:"p:v"} | {prop:"v"} | {sub:{prop:"v"}}
// A non-empty map that yields 0 entry rules exits ≠0 (schema drift must HALT, never no-op).
//
// TWO-PHASE PLANNING: also accepts plan-style.json (the style planner's output) — detected by a
// top-level rules[] array:
//   { rules: [ { selector (REAL, from dom-snapshot), decls {prop:value} (VERBATIM from the spec,
//                specNodeId cited), purpose: style|neutralize-wrapper|suppress-default|state-rule,
//                state: default|hover|selected|focus|menu-open, blockIds[] } ], tokenMap? }
// Selectors are emitted VERBATIM (they come from the snapshot, never placeholders); a hover/focus
// state whose selector carries no pseudo gets `:hover`/`:focus-within` appended mechanically
// (selected/menu-open must already be stable-class selectors in the plan). 0 rules = exit ≠0.
//
// Usage:
//   node scripts/first-shot-css.mjs <connect-map.json|plan-style.json> [--out <styles.css>]
//        [--selector-map <map.json>]
//        [--append]   # append to an existing stylesheet instead of overwriting (R8: ONE stylesheet)

import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { cssFixBlock } from "./knowledge.mjs";   // plugin knowledge base: bake known SDK gotcha fixes into first-shot

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// "padding:12px 16px; display:flex" → ["padding:12px 16px", "display:flex"], each !important'd.
function importantize(declStr) {
  return String(declStr).split(";").map((d) => d.trim()).filter(Boolean)
    .map((d) => (/!important\s*$/i.test(d) ? d : `${d} !important`));
}

// {prop: value} → "prop:value; prop:value" (planner maps often carry prop-objects, not decl strings)
const declStringOf = (v) => typeof v === "string" ? v
  : v && typeof v === "object" ? Object.entries(v).map(([p, val]) => `${p}:${val}`).join("; ") : "";

// NORMALIZE the Connect Map into flat entries with {subKey: declString} groups. Run 2's planner
// wrote `families{}` + prop-object cssDecls while this script consumed only flat `entries[]` +
// decl strings — first-shot silently emitted 0 rules and the builder burned 50+ min re-deriving
// values it already had. Both shapes are now first-class:
//   entries[]                                      (flat — original shape)
//   families: { <famId>: [entry,…] | {entries:[…]} }   (planner family shape)
//   cssDecls: "decl string" | {sub: "decl string"} | {prop: value} | {sub: {prop: value}}
export function normalizeEntries(connectMap) {
  const raw = [...(Array.isArray(connectMap.entries) ? connectMap.entries : [])];
  if (connectMap.families && typeof connectMap.families === "object" && !Array.isArray(connectMap.families)) {
    for (const [famId, fam] of Object.entries(connectMap.families)) {
      const famEntries = Array.isArray(fam) ? fam : (fam && (fam.entries || fam.map)) || [];
      for (const e of famEntries) if (e && typeof e === "object") raw.push({ family: famId, ...e });
    }
  }
  // surfaces[] — the two-phase structure planner groups its map per surface. Flattening it here keeps
  // the consumer general instead of forcing the producer to restate a shape it already expresses.
  if (Array.isArray(connectMap.surfaces)) {
    for (const s of connectMap.surfaces) {
      const sEntries = (s && (Array.isArray(s.entries) ? s.entries : s.map)) || [];
      for (const e of sEntries) if (e && typeof e === "object") raw.push({ surface: s.surface || s.name, ...e });
    }
  }
  return raw.map((e) => {
    const eSlug = slug(e.element || e.slot || e.name);
    const decls = e.cssDecls || e.css || {};
    let groups = {};
    if (typeof decls === "string") groups = { [eSlug || "root"]: decls };
    else if (decls && typeof decls === "object") {
      const vals = Object.values(decls);
      // flat prop-object ({padding:"12px", display:"flex"} — values never contain ':') → one root group
      if (vals.length && vals.every((v) => typeof v === "string" && !v.includes(":"))) groups = { root: declStringOf(decls) };
      else for (const [k, v] of Object.entries(decls)) { const d = declStringOf(v); if (d.trim()) groups[k] = d; }
    }
    return { ...e, _slug: eSlug, _groups: groups };
  });
}

// A tokenMap carries META keys next to real tokens (`_source`, `_doc`, …) and their prose values
// contain `;`, which terminates the custom-property early and makes the WHOLE stylesheet a
// CssSyntaxError (postcss/turbopack refuse the file, so every rule silently disappears). Only emit
// rows that are safe as a single declaration.
const isTokenRow = ([k, v]) => !String(k).replace(/^--/, "").startsWith("_") && !/[;{}]/.test(String(v));

export function firstShotCss(connectMap, selectorMap = {}, stats = {}) {
  const out = [];
  out.push("/* ---- velt-customize: DETERMINISTIC FIRST-SHOT (generated by first-shot-css.mjs) ----");
  out.push("   Values come 1:1 from the Connect Map's cssDecls (Figma-extracted, exact).");
  out.push("   .vc-* selectors are placeholders: wire them to your wireframe markup or swap for the");
  out.push("   live Velt class — do NOT re-derive or eyeball the numbers. */");
  // 1. design tokens → :root
  const tokens = connectMap.tokenMap || {};
  const tokenRows = (Array.isArray(tokens)
    ? tokens.map((t) => [t.velt || t.var || t.name, t.value]).filter(([k, v]) => k && v)
    : Object.entries(tokens).filter(([k, v]) => typeof v === "string" || typeof v === "number")
  ).filter(isTokenRow);
  if (tokenRows.length) {
    out.push("", ":root {");
    for (const [k, v] of tokenRows) out.push(`  ${String(k).startsWith("--") ? k : "--" + k}: ${v};`);
    out.push("}");
  }
  // 2. per-entry rules (entries[] and families{} both flow through normalizeEntries)
  const entries = normalizeEntries(connectMap);
  stats.entries = entries.length; stats.entryRules = 0;
  for (const e of entries) {
    const eSlug = e._slug;
    const keys = Object.keys(e._groups);
    if (!keys.length) continue;
    out.push("", `/* ${e.element || e.slot || e.name}  —  ${e.slot || ""}${e.family ? "  (" + e.family + ")" : ""}${e.tag ? "  [" + e.tag + "]" : ""} */`);
    for (const subKey of keys) {
      const sel = selectorMap[`${eSlug}.${subKey}`] || selectorMap[subKey] || `.vc-${eSlug}-${slug(subKey)}`;
      const lines = importantize(e._groups[subKey]);
      if (!lines.length) continue;
      out.push(`${sel} {`);
      for (const l of lines) out.push(`  ${l};`);
      out.push("}");
      stats.entryRules++;
    }
  }
  // 3. paddingResets from the manifest slice (wrapper neutralization the map already decided — R22)
  for (const r of connectMap.paddingResets || []) {
    if (r && r.selector && r.decls) {
      out.push("", `/* paddingReset: ${r.why || r.selector} */`, `${r.selector} {`);
      for (const l of importantize(r.decls)) out.push(`  ${l};`);
      out.push("}");
    }
  }
  out.push("", "/* ---- end first-shot (builder patches BELOW this line only) ---- */", "");
  return out.join("\n");
}

// plan-style.json rules[] → stylesheet. Selector verbatim (snapshot-real); hover/focus states get
// their pseudo appended when the plan's selector carries none (mechanical, documented above).
export function stylePlanCss(planStyle, stats = {}) {
  const out = [];
  out.push("/* ---- velt-customize: STYLE PLAN (generated by first-shot-css.mjs from plan-style.json) ----");
  out.push("   Selectors are REAL (from dom-snapshot); decls VERBATIM from the designSpec (node ids cited).");
  out.push("   Do NOT re-derive values; unknowns go back to the planner as style-plan-gap. */");
  const tokens = planStyle.tokenMap || {};
  const tokenRows = Object.entries(tokens)
    .filter(([k, v]) => typeof v === "string" || typeof v === "number")
    .filter(isTokenRow);
  if (tokenRows.length) {
    out.push("", ":root {");
    for (const [k, v] of tokenRows) out.push(`  ${String(k).startsWith("--") ? k : "--" + k}: ${v};`);
    out.push("}");
  }
  const rules = planStyle.rules || [];
  stats.entries = rules.length; stats.entryRules = 0;
  for (const r of rules) {
    if (!r || !r.selector || !r.decls) continue;
    let sel = r.selector;
    if (r.state === "hover" && !/:hover/.test(sel)) sel = sel.split(",").map((s) => s.trim() + ":hover").join(", ");
    if (r.state === "focus" && !/:focus/.test(sel)) sel = sel.split(",").map((s) => s.trim() + ":focus-within").join(", ");
    const lines = importantize(declStringOf(r.decls));
    if (!lines.length) continue;
    out.push("", `/* ${r.purpose || "style"}${r.state && r.state !== "default" ? ` [${r.state}]` : ""}${r.specNodeId ? `  spec:${r.specNodeId}` : ""}${r.blockIds?.length ? `  blocks:${r.blockIds.join(",")}` : ""} */`);
    out.push(`${sel} {`);
    for (const l of lines) out.push(`  ${l};`);
    out.push("}");
    stats.entryRules++;
  }
  out.push("", "/* ---- end style plan (builder patches BELOW this line only) ---- */", "");
  return out.join("\n");
}

async function main() {
  const [cmP, ...rest] = process.argv.slice(2);
  if (!cmP) { console.error("usage: first-shot-css.mjs <connect-map.json> [--out <styles.css>] [--selector-map <map.json>] [--append]"); process.exit(1); }
  const argv = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  const outP = argv("--out", null), mapP = argv("--selector-map", null), append = rest.includes("--append");
  const veltVersion = argv("--velt-version", null), noKnowledge = rest.includes("--no-knowledge");
  const cm = JSON.parse(await fs.readFile(cmP, "utf8"));
  const selMap = mapP ? JSON.parse(await fs.readFile(mapP, "utf8")) : {};
  const stats = {};
  const isStylePlan = Array.isArray(cm.rules);   // plan-style.json (two-phase) vs a Connect Map
  let css = isStylePlan ? stylePlanCss(cm, stats) : firstShotCss(cm, selMap, stats);
  // KNOWLEDGE BASE: inject confirmed SDK gotcha CSS fixes (send-button opacity, scrollbar clip, …)
  // BEFORE the "builder patches below" marker so they're part of first-shot, not builder churn.
  if (!noKnowledge) {
    const kb = await cssFixBlock(veltVersion);
    const endMarker = isStylePlan ? "\n/* ---- end style plan" : "\n/* ---- end first-shot";
    if (kb) css = css.replace(endMarker, kb + endMarker);
  }
  // HARD-FAIL, never a silent no-op: a non-empty map/plan that yields 0 entry rules IS the run-2
  // failure (schema drift) — exit ≠0 so no caller can mistake it for success.
  if (stats.entries > 0 && stats.entryRules === 0) {
    console.error(`✗ 0 rules generated from ${stats.entries} ${isStylePlan ? "plan-style rule" : "Connect-Map entr"}${stats.entries === 1 ? (isStylePlan ? "" : "y") : (isStylePlan ? "s" : "ies")} — no ${isStylePlan ? "rule carries selector+decls" : "entry carries usable cssDecls"}, or the shape drifted.`);
    console.error("  Run `node scripts/contract-check.mjs selftest`; fix the plan/map (or this script) BEFORE any builder is dispatched.");
    process.exit(2);
  }
  if (isStylePlan && stats.entries === 0) {
    console.error("✗ plan-style.json has 0 rules — an empty style plan is a HALT (the style build would silently no-op).");
    process.exit(2);
  }
  if (outP) {
    if (append) await fs.appendFile(outP, "\n" + css);
    else await fs.writeFile(outP, css);
    const rules = (css.match(/\{/g) || []).length;
    console.log(`✓ first-shot stylesheet: ${rules} rule(s) (${stats.entryRules} entry rule(s) from ${stats.entries} Connect-Map entries) → ${path.relative(process.cwd(), outP)}${append ? " (appended)" : ""}`);
  } else process.stdout.write(css);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

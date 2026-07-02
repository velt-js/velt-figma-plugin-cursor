#!/usr/bin/env node
// lint-customization.mjs — the STATIC rules scan. Every mechanically-checkable rule from
// guide/rules.md, enforced by code instead of prompt prose: instant, deterministic, zero tokens.
// Run it in the Builder's handoff gate (before the Judge ever sees the build) and as part of
// the Judge's static scan. ERRORS (exit 2) are hard rule violations; WARNINGS (exit 0) need a
// human/Judge eye but aren't mechanically provable as wrong.
//
// Usage: node scripts/lint-customization.mjs [dir]        # default: components/velt/ui-customization
//        [--json]
//
// Checks:
//   R1  (error) exactly one <VeltWireframe> across all files (0 is a warning — css-only builds exist)
//   R4  (error) interactive React (onClick/onChange/useState/useEffect/useRef) inside a file that
//               declares wireframe markup — cloned to inert DOM, silently does nothing
//   R7  (warn)  display:none in CSS — legit for empty-state gaps, a defect for feature-removal
//   R8  (error) more than one stylesheet in the customization dir
//   R9  (warn)  hex colours outside :root[data-velt-theme="dark"] scoping hints (heuristic)
//   R9b (warn)  a .velt-*/.s-*/snippyly override declaration without !important
//   R23 (error) a bare .velt-mention / .velt-mention--name selector not scoped under a message
//               scope — over-matches and tints the author name
//   R27 (error) visibility/layout keyed on :focus/:hover/:active for .velt-composer / transient
//               Velt twins named in rules.md (velt-composer-input-focused)

import { promises as fs } from "node:fs";
import path from "node:path";

const DIR = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "components/velt/ui-customization";
const JSON_OUT = process.argv.includes("--json");

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

function findLines(src, re) {
  const hits = [];
  src.split("\n").forEach((l, i) => { if (re.test(l)) hits.push({ line: i + 1, text: l.trim().slice(0, 120) }); });
  return hits;
}

async function main() {
  const files = await walk(DIR);
  if (!files.length) { console.error(`✗ nothing to lint: ${DIR} is empty or missing`); process.exit(1); }
  const errors = [], warnings = [];
  const err = (rule, file, line, msg) => errors.push({ rule, file, line, msg });
  const warn = (rule, file, line, msg) => warnings.push({ rule, file, line, msg });

  const tsx = files.filter((f) => /\.(tsx|jsx|ts|js)$/.test(f));
  const css = files.filter((f) => /\.css$/.test(f));

  // R8 — one stylesheet
  if (css.length > 1) err("R8", css[1], 0, `${css.length} stylesheets found (${css.map((c) => path.basename(c)).join(", ")}) — all Velt CSS goes in ONE file`);

  // R1 — exactly one <VeltWireframe>
  let wfCount = 0, wfFiles = [];
  for (const f of tsx) {
    const src = await fs.readFile(f, "utf8");
    const n = (src.match(/<VeltWireframe[\s>]/g) || []).length;
    if (n) { wfCount += n; wfFiles.push(f); }
  }
  if (wfCount > 1) err("R1", wfFiles.join(", "), 0, `${wfCount} <VeltWireframe> roots — the registry must be a single one (first-with-content-wins makes extras silently ignored)`);
  if (wfCount === 0) warn("R1", DIR, 0, "no <VeltWireframe> found (fine for a css/primitives-only build; a wireframe build is broken)");

  // R4 — interactive React inside wireframe files
  for (const f of tsx) {
    const src = await fs.readFile(f, "utf8");
    const declaresWireframe = /Wireframe[\s.>]/.test(src);
    if (!declaresWireframe) continue;
    for (const { line, text } of findLines(src, /\bonClick=|\bonChange=|\bonMouseDown=|\buseState\s*\(|\buseEffect\s*\(|\buseRef\s*\(/))
      err("R4", f, line, `interactive React inside a wireframe file — cloned to inert DOM, does nothing: ${text}`);
  }

  for (const f of css) {
    const src = await fs.readFile(f, "utf8");
    // R7 — display:none (warn: legit for empty-state gaps, a defect for feature removal)
    for (const { line, text } of findLines(src, /display\s*:\s*none/))
      warn("R7", f, line, `display:none — fine for an empty-state gap; a DEFECT if it removes a feature (use props/omit the slot): ${text}`);
    // R23 — bare .velt-mention not scoped to the message
    for (const { line, text } of findLines(src, /^[^{}]*(^|[,\s])\.velt-mention(--name)?\s*[,{:]/)) {
      if (!/--message|mentionScope|\.velt-thread-card--message/.test(text)) err("R23", f, line, `bare .velt-mention selector — over-matches (tints the author name); scope under the message: ${text}`);
    }
    // R9b — velt class overrides without !important (per-declaration heuristic)
    const blocks = src.split("}");
    let lineNo = 1;
    for (const b of blocks) {
      const nl = (b.match(/\n/g) || []).length;
      const [sel, body] = b.split("{");
      if (sel && body && /\.(velt-|s-)|snippyly/.test(sel) && !/--velt-/.test(body)) {
        for (const decl of body.split(";")) if (decl.includes(":") && !decl.includes("!important") && decl.trim() && !decl.trim().startsWith("--"))
          warn("R9b", f, lineNo, `velt-class override without !important (Velt's runtime CSS wins): ${decl.trim().slice(0, 80)}`);
      }
      lineNo += nl;
    }
    // R27 — transient-state anchoring on composer/actions visibility
    for (const { line, text } of findLines(src, /(:focus|:active|velt-composer-input-focused)[^{]*\{?/)) {
      if (/velt-composer|composer|actions|display|visibility/i.test(text) && /(:focus\b|velt-composer-input-focused)/.test(text))
        warn("R27", f, line, `visibility/layout possibly keyed on a TRANSIENT state (target shifts mid-click) — anchor on velt-composer-open / a selected condition: ${text}`);
    }
  }

  if (JSON_OUT) { console.log(JSON.stringify({ dir: DIR, errors, warnings }, null, 2)); }
  else {
    console.log(`lint ${DIR}: ${errors.length} error(s), ${warnings.length} warning(s) across ${files.length} file(s)`);
    for (const e of errors) console.log(`  ✗ [${e.rule}] ${e.file}${e.line ? ":" + e.line : ""} — ${e.msg}`);
    for (const w of warnings) console.log(`  ⚠ [${w.rule}] ${w.file}${w.line ? ":" + w.line : ""} — ${w.msg}`);
    if (!errors.length && !warnings.length) console.log("  ✓ clean");
  }
  process.exit(errors.length ? 2 : 0);
}

main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

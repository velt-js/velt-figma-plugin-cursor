#!/usr/bin/env node
// icon-lint.mjs — MECHANICAL ICON FIDELITY GATE. Both judge FAILs of the claude-cloud run were
// icons — a send-glyph redrawn missing its concave notch, strokes #465169 where the design says
// #9aa8c3, a wrong emoji-plus shape — and each cost a ~20-minute judge audit round to discover.
// R17 already mandates exported-SVGs-verbatim; this script ENFORCES it before any judge runs:
// the builder runs it in the self-certify loop (cheap, sub-second, no browser), the Judge cites
// its result instead of re-deriving icon identity by eye.
//
// What it checks, from the written icon source (icons.tsx / *.tsx / *.svg) against the
// extraction's exported SVG assets dir:
//   1. GLYPH IDENTITY — every <path d="…"> in the source must byte-match (whitespace/comma
//      normalized) a `d` from some exported SVG. A path that matches nothing was REDRAWN — the
//      exact defect class R17 forbids. (Non-path glyphs — circle/rect/line — are not compared.)
//   2. COLOR FIDELITY — every fill/stroke color literal in the source must appear in the exported
//      SVG set (or be structural: none/currentColor/inherit/transparent/url()/var()/#fff-white
//      backgrounds are allowed). A color that appears nowhere in the exports is a re-derived
//      value, not a design value.
//
// Usage:
//   node scripts/icon-lint.mjs <iconsSrc(.tsx|dir)> <exportedSvgDir> [--json]
// Exit codes: 0 = all glyphs + colors trace to the exports · 2 = mismatches (each printed) ·
//             1 = usage/error. A missing/empty svg dir is exit 1 (can't lint against nothing).

import { promises as fs } from "node:fs";
import path from "node:path";

const normPath = (d) => String(d).replace(/[\s,]+/g, " ").trim();
const normColor = (c) => String(c).trim().toLowerCase();
// #abc → #aabbcc so shorthand and longhand compare equal
const expandHex = (c) => /^#[0-9a-f]{3}$/i.test(c) ? "#" + [...c.slice(1)].map((x) => x + x).join("") : c;
const canonColor = (c) => expandHex(normColor(c));

const STRUCTURAL_COLORS = new Set(["none", "currentcolor", "inherit", "transparent", "initial", "unset", "white", "#ffffff", "black", "#000000"]);
const isStructural = (c) => STRUCTURAL_COLORS.has(canonColor(c)) || /^(url\(|var\()/i.test(c);

function extractPaths(text) {
  const out = [];
  // d="…" | d='…' | d={"…"} | d={'…'} | d={`…`}
  const re = /\bd\s*=\s*(?:\{\s*)?(["'`])([^"'`]+)\1/g;
  let m; while ((m = re.exec(text))) out.push(normPath(m[2]));
  return out;
}
function extractColors(text) {
  const out = new Set();
  // fill/stroke as attribute or JSX prop: fill="#abc" | stroke={'#abc'} ; also style objects fill: "#abc"
  const re = /\b(?:fill|stroke)\s*[:=]\s*(?:\{\s*)?(["'`])([^"'`]+)\1/g;
  let m; while ((m = re.exec(text))) out.add(m[2].trim());
  return [...out];
}

async function collect(p, exts) {
  const st = await fs.stat(p).catch(() => null);
  if (!st) return [];
  if (st.isFile()) return exts.some((e) => p.endsWith(e)) ? [p] : [];
  const files = [];
  for (const f of await fs.readdir(p)) files.push(...(await collect(path.join(p, f), exts)));
  return files;
}

async function main() {
  const [srcArg, svgDirArg, ...rest] = process.argv.slice(2);
  if (!srcArg || !svgDirArg) { console.error("usage: icon-lint.mjs <iconsSrc(.tsx|dir)> <exportedSvgDir> [--json]"); process.exit(1); }
  const asJson = rest.includes("--json");

  const svgFiles = await collect(path.resolve(svgDirArg), [".svg"]);
  if (!svgFiles.length) { console.error(`✗ no exported SVGs found under ${svgDirArg} — cannot lint icons against nothing (run figma-extract first)`); process.exit(1); }
  const designPaths = new Map();   // normPath → source svg file (first seen)
  const designColors = new Set();
  for (const f of svgFiles) {
    const text = await fs.readFile(f, "utf8");
    for (const d of extractPaths(text)) if (!designPaths.has(d)) designPaths.set(d, path.basename(f));
    for (const c of extractColors(text)) designColors.add(canonColor(c));
  }

  const srcFiles = await collect(path.resolve(srcArg), [".tsx", ".jsx", ".ts", ".js", ".svg"]);
  if (!srcFiles.length) { console.error(`✗ no icon source files found at ${srcArg}`); process.exit(1); }

  const problems = [];
  let pathsChecked = 0, colorsChecked = 0;
  for (const f of srcFiles) {
    const text = await fs.readFile(f, "utf8");
    const rel = path.relative(process.cwd(), f);
    for (const d of extractPaths(text)) {
      pathsChecked++;
      if (!designPaths.has(d)) problems.push({ kind: "redrawn-glyph", file: rel, detail: `path data (${d.length} chars, starts "${d.slice(0, 42)}…") matches NO exported SVG — the glyph was redrawn; copy the export's d verbatim (R17)` });
    }
    for (const c of extractColors(text)) {
      if (isStructural(c)) continue;
      colorsChecked++;
      if (!designColors.has(canonColor(c))) problems.push({ kind: "off-design-color", file: rel, detail: `fill/stroke '${c}' appears in NO exported SVG — a re-derived value, not a design value (the claude-cloud run shipped #465169 where the design says #9aa8c3)` });
    }
  }

  if (asJson) console.log(JSON.stringify({ ok: !problems.length, pathsChecked, colorsChecked, svgAssets: svgFiles.length, problems }, null, 2));
  if (problems.length) {
    if (!asJson) { console.error(`✗ icon lint: ${problems.length} defect(s) across ${srcFiles.length} source file(s):`); for (const p of problems) console.error(`  · [${p.kind}] ${p.file}: ${p.detail}`); }
    process.exit(2);
  }
  if (!asJson) console.log(`✓ icon lint: ${pathsChecked} glyph path(s) + ${colorsChecked} color(s) all trace to the ${svgFiles.length} exported SVG(s)`);
}

main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

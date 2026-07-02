#!/usr/bin/env node
// check-guide.mjs — self-sufficiency + integrity gate for guide/ (the single source of truth).
// The plugin reads guide/ directly; there is no separate bundle and no sync step.
// Hard-fails on: a missing required entry file, any external/SDK path leak, or a broken internal link.
// Usage: node scripts/check-guide.mjs [--dir guide]

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dirIdx = args.indexOf("--dir");
const DIR = path.resolve(ROOT, dirIdx >= 0 ? args[dirIdx + 1] : "guide");

// Entry files that must always be present (sanity of a complete guide).
const REQUIRED = [
  "README.md",
  "02-decision-tree.md",
  "rules.md",
  "verifying-a-customization.md",
  "sdk-gaps-and-blockers.md",
  "reference/component-definitions.md",
  "reference/component-catalog.md",
];

// Self-sufficiency invariant: the guide must contain ZERO external/SDK paths.
const FORBIDDEN_PATTERNS = [
  /\bsdk-react\/src\b/,
  /\/sdk\/src\b/,
  /\/Users\//,
  /\bcomponents-map\.ts\b/,
  /node_modules/,
];

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(path.relative(base, full));
  }
  return out;
}

async function selfCheck(files, baseDir) {
  const problems = [];
  // 1. required entry files present
  for (const r of REQUIRED) if (!files.includes(r)) problems.push(`missing required file: ${r}`);
  // 2. zero external/SDK paths
  for (const f of files.filter((f) => f.endsWith(".md"))) {
    const text = await fs.readFile(path.join(baseDir, f), "utf8");
    for (const pat of FORBIDDEN_PATTERNS) {
      if (pat.test(text)) problems.push(`self-sufficiency violation in ${f}: matches ${pat}`);
    }
  }
  // 3. internal relative links resolve
  const set = new Set(files);
  const linkRe = /\]\((\.{1,2}\/[^)#]+\.md)(#[^)]*)?\)/g;
  for (const f of files.filter((f) => f.endsWith(".md"))) {
    const text = await fs.readFile(path.join(baseDir, f), "utf8");
    let m;
    while ((m = linkRe.exec(text))) {
      const target = path.normalize(path.join(path.dirname(f), m[1]));
      if (!set.has(target)) problems.push(`broken link in ${f} -> ${m[1]}`);
    }
  }
  return problems;
}

async function main() {
  const files = await walk(DIR);
  const problems = await selfCheck(files, DIR);
  if (problems.length) {
    console.error("✗ guide self-check FAILED:");
    for (const p of problems) console.error("  - " + p);
    process.exit(1);
  }
  console.log(`✓ guide self-check passed (${files.length} files, 0 external paths, links resolve)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

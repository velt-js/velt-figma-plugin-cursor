#!/usr/bin/env node
// check-parity.mjs — cross-repo drift guard between the Claude and Cursor ports of this plugin.
// The two repos are the SAME plugin with a thin host adapter; everything else must stay in
// lockstep or fixes land in one and silently rot in the other (this happened: a portability
// fix lived only in the Cursor repo while the Claude repo's scripts were broken on paths
// with spaces).
//
//   IDENTICAL set — must be byte-identical: guide/, manifest/, templates/, and scripts/
//     (minus the per-host exceptions below). Drift here = exit 2.
//   ADAPTER set — expected to differ only by host renames (browser tool, command names,
//     model slugs, frontmatter form): agents/, skills/, commands/, golden/. Reported as
//     info; a MISSING counterpart file is still an error.
//
// Usage: node scripts/check-parity.mjs [--other /path/to/sibling-repo]
//        (default sibling: ../velt-figma-plugin-cursor or ../velt-figma-plugin-claude,
//         inferred from this repo's own directory name)

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const IDENTICAL_DIRS = ["guide", "manifest", "templates", "scripts"];
const ADAPTER_DIRS = ["agents", "skills", "commands", "golden"];
// per-host files allowed to differ (or exist in only one repo) inside the IDENTICAL set:
const EXCEPTIONS = new Set([
  "scripts/validate.mjs",       // validates different manifests per host
  "scripts/progress.mjs",       // host-specific labels
  "scripts/deploy-skills.mjs",  // cursor-only
  "scripts/clear.mjs",          // user-visible command name differs per host
]);
// command files are renamed per host: claude commands/<x>.md ↔ cursor commands/velt-customize-<x>.md
const cmdCounterpart = (rel, otherIsCursor) => {
  const m = rel.match(/^commands\/(?:velt-customize-)?(.+)$/);
  if (!m) return rel;
  return otherIsCursor ? `commands/velt-customize-${m[1]}` : `commands/${m[1]}`;
};

async function walk(dir, base) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, base)));
    else out.push(path.relative(base, p));
  }
  return out;
}

async function main() {
  const a = process.argv.slice(2);
  const i = a.indexOf("--other");
  const selfIsCursor = path.basename(ROOT).includes("cursor");
  const other = path.resolve(i >= 0 ? a[i + 1] : path.join(ROOT, "..", selfIsCursor ? "velt-figma-plugin-claude" : "velt-figma-plugin-cursor"));
  const otherIsCursor = !selfIsCursor;
  if (!(await fs.stat(other).catch(() => null))) { console.error(`✗ sibling repo not found: ${other} (pass --other <path>)`); process.exit(1); }

  const errors = [], info = [];
  for (const dir of [...IDENTICAL_DIRS, ...ADAPTER_DIRS]) {
    const strict = IDENTICAL_DIRS.includes(dir);
    const mine = await walk(path.join(ROOT, dir), ROOT);
    const theirsSet = new Set(await walk(path.join(other, dir), other));
    for (const rel of mine) {
      if (EXCEPTIONS.has(rel)) continue;
      const counterpart = dir === "commands" ? cmdCounterpart(rel, otherIsCursor) : rel;
      if (!theirsSet.has(counterpart)) {
        (strict ? errors : errors).push(`${rel}: no counterpart in sibling (expected ${counterpart})`);
        continue;
      }
      theirsSet.delete(counterpart);
      const [mineB, theirsB] = await Promise.all([fs.readFile(path.join(ROOT, rel)), fs.readFile(path.join(other, counterpart))]);
      if (!mineB.equals(theirsB)) (strict ? errors : info).push(`${rel}${counterpart !== rel ? " ↔ " + counterpart : ""}: ${strict ? "DRIFT in identical set" : "differs (adapter dir — verify it's only host renames)"}`);
    }
    for (const leftover of theirsSet) {
      const rel = path.join(dir, path.basename(leftover));
      if (EXCEPTIONS.has(leftover) || EXCEPTIONS.has(rel)) continue;
      (strict ? errors : info).push(`${leftover}: exists only in sibling`);
    }
  }

  console.log(`parity vs ${other}`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  for (const m of info) console.log(`  ~ ${m}`);
  if (!errors.length && !info.length) console.log("  ✓ full parity");
  else if (!errors.length) console.log(`  ✓ identical set clean (${info.length} adapter-dir difference(s) — expected)`);
  else console.log(`  ${errors.length} drift error(s) — fix both repos or add a deliberate exception`);
  process.exit(errors.length ? 2 : 0);
}

main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

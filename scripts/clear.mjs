#!/usr/bin/env node
// clear.mjs — wipe velt-customize RUN STATE for a fresh start (cross-phase memory + all phase artifacts).
//
// All run state lives under <repo>/.velt-customize/ (cwd): memory.json (tokens/mappings/naming/corrections/
// gaps/phases ledger) + phases/<phaseId>/ (journal, blocks.json, frames, shots, diffs, block-report,
// progress.log). This resets that so the next /velt-customize-run re-plans from scratch with no advisory
// memory and no stale phase journal.
//
// SAFE BY DESIGN:
//  - Dry-run by DEFAULT — lists exactly what would be removed and exits without touching anything.
//    Pass --yes to actually delete.
//  - NEVER touches the generated customization code (components/velt/ui-customization/) — that's real
//    output, not run state. It's only reported, with the manual command to remove it if you truly want a
//    bare repo. It also never touches anything outside .velt-customize/.
//
// Usage:
//   node scripts/clear.mjs                 # dry-run: show what a full clear would remove
//   node scripts/clear.mjs --yes           # remove .velt-customize/ (memory + ALL phases)
//   node scripts/clear.mjs --memory --yes  # remove ONLY memory.json (keep phase artifacts)
//   node scripts/clear.mjs --phases --yes  # remove ONLY phases/ (keep memory.json)
//   node scripts/clear.mjs --phase <id> --yes   # remove ONE phase dir
//   [--dir <repo>]   run against a repo other than cwd

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const a = process.argv.slice(2);
const has = (f) => a.includes(f);
const argv = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };

const dir = path.resolve(argv("--dir") || ".");
const root = path.join(dir, ".velt-customize");
const memFile = path.join(root, "memory.json");
const phasesDir = path.join(root, "phases");
const codeDir = path.join(dir, "components", "velt", "ui-customization");

const onlyMemory = has("--memory");
const onlyPhases = has("--phases");
const onePhase = argv("--phase");
const apply = has("--yes");

const rel = (p) => path.relative(dir, p) || ".";
function du(p) { // rough dir/file size for the summary
  try {
    const s = statSync(p);
    if (!s.isDirectory()) return s.size;
    return readdirSync(p).reduce((n, c) => n + du(path.join(p, c)), 0);
  } catch { return 0; }
}
const kb = (n) => n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

// ---- resolve the target set ----
const targets = [];
if (onePhase) {
  const p = path.join(phasesDir, onePhase);
  if (existsSync(p)) targets.push(p);
  else { console.error(`✗ no such phase: ${rel(p)}`); process.exit(1); }
} else if (onlyMemory) {
  if (existsSync(memFile)) targets.push(memFile);
} else if (onlyPhases) {
  if (existsSync(phasesDir)) targets.push(phasesDir);
} else {
  // full clear = the whole run-state root
  if (existsSync(root)) targets.push(root);
}

if (!targets.length) {
  console.log("nothing to clear — no velt-customize run state found" +
    (existsSync(root) ? " for that selector." : ` (no ${rel(root)}/).`));
  process.exit(0);
}

// ---- report ----
const phaseIds = existsSync(phasesDir)
  ? readdirSync(phasesDir).filter((n) => { try { return statSync(path.join(phasesDir, n)).isDirectory(); } catch { return false; } })
  : [];
console.log(`${apply ? "Clearing" : "Would clear"} velt-customize run state in ${rel(dir)}/:`);
for (const t of targets) console.log(`  • ${rel(t)}${statSync(t).isDirectory() ? "/" : ""}   (${kb(du(t))})`);
if (!onlyMemory && !onePhase && phaseIds.length) console.log(`    phases: ${phaseIds.join(", ")}`);
if (existsSync(codeDir)) {
  console.log(`\nPRESERVED (generated code, not run state): ${rel(codeDir)}/`);
  console.log(`  To also start from a bare repo, remove it yourself: rm -rf ${rel(codeDir)}`);
}

if (!apply) {
  console.log(`\nDry run — nothing deleted. Re-run with --yes to apply.`);
  process.exit(0);
}

// ---- apply ----
for (const t of targets) rmSync(t, { recursive: true, force: true });
console.log(`\n✓ cleared. Next \`/velt-customize-run\` starts fresh — no advisory memory, no prior phase journal.`);

#!/usr/bin/env node
// phase-init.mjs — make the heartbeat EXIST at second zero, before anything silent runs.
//
// The whole "watch it live" promise is a lie until `.velt-customize/phases/<id>/progress.log`
// exists on disk. Previously the first write happened in Step 2 (enumerate-blocks --out), i.e.
// AFTER all of preflight — so `tail`/`--watch` found nothing (zsh: "no matches found") for the
// entire preflight window, and if preflight HALTed the file was never created at all (silent
// black box). This script is the deterministic FIRST action of setup: it derives the STABLE
// phaseId (the single source of truth, reused by the orchestrator, /fix, and re-runs), creates
// the phase dir, writes the first progress line, and prints the exact watch command. After this,
// every preflight item + any HALT lands in progress.log and is watchable from the very start.
//
// Usage:
//   node scripts/phase-init.mjs <figma-url>                 # parse fileKey + node-id from the URL
//   node scripts/phase-init.mjs <fileKey> <nodeId>          # explicit
//   node scripts/phase-init.mjs --id <phaseId>              # re-enter a known phase (e.g. /fix)
// Prints the absolute phaseDir on the LAST stdout line (machine-readable); everything else is human.

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const a = process.argv.slice(2);
const argv = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };

// Derive the STABLE phaseId — same scheme everywhere so /fix and re-runs re-enter the same dir.
// A run is one Loop node within one file, so key on fileKey + nodeId (both sanitized).
function parseFigma(input) {
  if (!input) return {};
  // full URL: https://www.figma.com/design/<fileKey>/<name>?node-id=<n>-<m>
  const key = input.match(/\/(?:design|file|proto)\/([A-Za-z0-9]+)/)?.[1];
  const node = input.match(/[?&]node-id=([0-9]+[-:][0-9]+)/)?.[1];
  return { fileKey: key, nodeId: node };
}

function phaseIdFrom({ fileKey, nodeId }) {
  const san = (s) => String(s).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const fk = fileKey ? san(fileKey).slice(0, 12) : "file";
  const nd = nodeId ? san(nodeId) : "node";
  return `${fk}-${nd}`;
}

let phaseId = argv("--id");
if (!phaseId) {
  let parts = parseFigma(a[0]);
  // explicit "<fileKey> <nodeId>" form
  if (!parts.fileKey && a[0] && a[1] && !a[0].includes("/")) parts = { fileKey: a[0], nodeId: a[1] };
  if (!parts.nodeId) {
    console.error("✗ could not find a node-id. Pass a node-specific Figma URL (…?node-id=133-4052),");
    console.error("  or `<fileKey> <nodeId>`, or `--id <phaseId>` to re-enter a known phase.");
    process.exit(1);
  }
  phaseId = phaseIdFrom(parts);
}

const phaseDir = path.resolve(".velt-customize/phases", phaseId);
mkdirSync(phaseDir, { recursive: true });
const t = new Date().toTimeString().slice(0, 8);
appendFileSync(path.join(phaseDir, "progress.log"),
  `[${t}] setup started — phase ${phaseId} (preflight next; lines will stream here)\n`);

const rel = path.relative(process.cwd(), phaseDir) || ".";
console.error(`✓ heartbeat live: ${rel}/progress.log`);
console.error(`  Watch it in a second terminal (zsh-safe, follows before the file grows):`);
console.error(`    node <plugin>/scripts/progress.mjs --watch     # auto-resolves the newest phase`);
console.error(`  Reliable liveness (no heartbeat-compliance needed):`);
console.error(`    node <plugin>/scripts/progress.mjs --activity`);
// LAST line = the absolute phaseDir, for the caller to pass to the orchestrator / enumerate --out
console.log(phaseDir);

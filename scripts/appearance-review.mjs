#!/usr/bin/env node
// appearance-review.mjs — persist / validate Builder triple-image appearance artifacts.
//
// Artifact shape (per block): <phaseDir>/appearance/<blockId>.json
// {
//   blockId, figmaFramePng, mockScreenshot, liveScreenshot,
//   regions: [], unresolved: [], disposition: "clean"|"blocked-for-replan"|"plan-error"|"accepted-noise",
//   status: "appearance-reviewed"
// }
//
// Usage:
//   node scripts/appearance-review.mjs init <phaseDir> <blockId> --figma <png> --mock <png> --live <png>
//   node scripts/appearance-review.mjs check <phaseDir> [--family <id>]
// Exit 2 if any required block lacks a complete appearance-reviewed artifact.

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function exists(p) { return fs.access(p).then(() => true, () => false); }

async function init(phaseDir, blockId, opts) {
  const dir = path.join(phaseDir, "appearance");
  await fs.mkdir(dir, { recursive: true });
  const doc = {
    blockId,
    figmaFramePng: opts.figma || null,
    mockScreenshot: opts.mock || null,
    liveScreenshot: opts.live || null,
    regions: [],
    unresolved: opts.unresolved ? JSON.parse(opts.unresolved) : [],
    disposition: opts.disposition || (opts.unresolved && JSON.parse(opts.unresolved).length ? "blocked-for-replan" : "clean"),
    status: "appearance-reviewed",
    at: new Date().toISOString(),
  };
  const out = path.join(dir, `${blockId}.json`);
  await fs.writeFile(out, JSON.stringify(doc, null, 2) + "\n");
  console.log(`✓ appearance artifact → ${out}`);
}

async function check(phaseDir, familyId) {
  const blocks = JSON.parse(await fs.readFile(path.join(phaseDir, "blocks.json"), "utf8"));
  const list = (blocks.blocks || []).filter((b) => !familyId || b.familyId === familyId);
  const missing = [];
  const blocked = [];
  const silentClean = [];
  let composedAudit = null;
  try { composedAudit = JSON.parse(await fs.readFile(path.join(phaseDir, "composed-audit.json"), "utf8")); } catch { /* optional until Judge runs */ }
  for (const b of list) {
    const p = path.join(phaseDir, "appearance", `${b.id}.json`);
    if (!(await exists(p))) { missing.push(b.id); continue; }
    const doc = JSON.parse(await fs.readFile(p, "utf8"));
    if (doc.status !== "appearance-reviewed") missing.push(b.id);
    if (!doc.figmaFramePng && !doc.mockScreenshot) missing.push(b.id + "(no-ref-image)");
    if (!doc.liveScreenshot) missing.push(b.id + "(no-live)");
    if ((doc.unresolved || []).length && !["blocked-for-replan", "plan-error", "accepted-noise", "open"].includes(doc.disposition)) {
      blocked.push(b.id);
    }
    if (doc.disposition === "blocked-for-replan" || doc.disposition === "open") blocked.push(b.id);
    // Ban silent clean: disposition clean/resolved with empty unresolved while composed-audit failed
    if (composedAudit && composedAudit.ok === false
      && (!doc.unresolved || !doc.unresolved.length)
      && (doc.disposition === "clean" || doc.disposition === "resolved")) {
      silentClean.push(b.id);
    }
  }
  if (composedAudit && composedAudit.ok === false && !composedAudit.blocks) {
    console.error("✗ appearance-review: composed-audit.json ok:false — re-run composed-audit.mjs before claiming clean");
    process.exit(2);
  }
  if (silentClean.length) {
    console.error(`✗ appearance-review SILENT_CLEAN (composed-audit failed): ${silentClean.join(", ")}`);
    process.exit(2);
  }
  if (missing.length) {
    console.error(`✗ appearance-review incomplete: ${missing.join(", ")}`);
    process.exit(2);
  }
  if (blocked.length) {
    console.error(`✗ appearance-review has unresolved composed misses: ${[...new Set(blocked)].join(", ")}`);
    process.exit(2);
  }
  console.log(`✓ appearance-review: ${list.length} block(s) reviewed`);
}

async function main() {
  const [cmd, phaseDir, blockId, ...rest] = process.argv.slice(2);
  const flag = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
  if (cmd === "init") {
    await init(phaseDir, blockId, {
      figma: flag("--figma"), mock: flag("--mock"), live: flag("--live"),
      disposition: flag("--disposition"), unresolved: flag("--unresolved"),
    });
    return;
  }
  if (cmd === "check") {
    await check(phaseDir, flag("--family"));
    return;
  }
  console.error("usage: appearance-review.mjs init|check …");
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });

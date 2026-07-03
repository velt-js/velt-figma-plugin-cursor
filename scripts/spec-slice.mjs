#!/usr/bin/env node
// spec-slice.mjs — cut the full designSpec into PER-BLOCK slices. The privado run's judges
// re-ingested the whole 176 KB / 7,700-line designSpec.json on every fresh-context visit (9 visits);
// a block only ever needs ITS frame's nodes. Run once after extraction; every builder/judge/measure
// invocation then reads `briefs/<blockId>.spec.json` (a few KB) instead of the corpus.
//
// A slice keeps: the spec header (source/fileKey/boxSpace/scale), the block's frame entry, the nodes
// tagged with the block's frameId (boxes already frame-relative under boxSpace:"frame-relative"),
// the iconAssignments/unassignedIcons whose nodes live in this frame, and the asset list filtered to
// the SVGs those assignments reference. textMasksFromSpec/iconBoxesFromSpec work on a slice unchanged.
//
// Usage:
//   node scripts/spec-slice.mjs <designSpec.json> <blocks.json> [--block <id>] [--out-dir <phaseDir>]
// Default: slices EVERY block → <phaseDir>/briefs/<blockId>.spec.json (out-dir defaults to the
// blocks.json directory).

import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

function sliceFor(spec, block) {
  const frameId = block.figmaNodeId;
  const nodes = (spec.nodes || []).filter((n) => n.frameId === frameId || n.id === frameId);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const iconAssignments = {};
  for (const [k, v] of Object.entries(spec.iconAssignments || {})) {
    const nid = v && (v.nodeId || v.id);
    if (!nid || nodeIds.has(nid)) iconAssignments[k] = v;   // keep unattributed assignments (cheap, safe)
  }
  const unassignedIcons = (spec.unassignedIcons || []).filter((u) => !u.nodeId || nodeIds.has(u.nodeId));
  const referenced = new Set([
    ...Object.values(iconAssignments).map((v) => v && (v.file || v.asset)).filter(Boolean),
    ...unassignedIcons.flatMap((u) => (u.candidates || []).map((c) => c.file || c)).filter(Boolean),
  ]);
  const assets = (spec.assets || []).filter((a) => referenced.has(a.file || a) || referenced.size === 0);
  const frames = (spec.frames || []).filter((f) => (f.id || f.frameId) === frameId);
  return {
    source: spec.source, fileKey: spec.fileKey, nodeId: spec.nodeId, boxSpace: spec.boxSpace,
    slicedFrom: "designSpec.json", blockId: block.id, frameId,
    frames, nodeCount: nodes.length, nodes, assets, iconAssignments, unassignedIcons,
  };
}

async function main() {
  const [specP, blocksP, ...rest] = process.argv.slice(2);
  if (!specP || !blocksP) { console.error("usage: spec-slice.mjs <designSpec.json> <blocks.json> [--block <id>] [--out-dir <phaseDir>]"); process.exit(1); }
  const argv = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  const only = argv("--block", null);
  const outDir = path.join(path.resolve(argv("--out-dir", path.dirname(path.resolve(blocksP)))), "briefs");
  const spec = JSON.parse(await fs.readFile(specP, "utf8"));
  const blocks = JSON.parse(await fs.readFile(blocksP, "utf8")).blocks || [];
  const targets = only ? blocks.filter((b) => b.id === only) : blocks;
  if (!targets.length) { console.error(`✗ block '${only}' not found in ${blocksP}`); process.exit(1); }
  await fs.mkdir(outDir, { recursive: true });
  for (const b of targets) {
    const s = sliceFor(spec, b);
    const p = path.join(outDir, `${b.id}.spec.json`);
    await fs.writeFile(p, JSON.stringify(s, null, 2));
    console.log(`✓ ${b.id}: ${s.nodeCount} nodes, ${Object.keys(s.iconAssignments).length} icon assignment(s) → ${path.relative(process.cwd(), p)}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

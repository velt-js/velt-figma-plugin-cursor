#!/usr/bin/env node
// enumerate-blocks.mjs — derive the BLOCK LIST (the completeness oracle) from a Figma node.
//
// A PHASE is one "Loop" node. The expected authoring template (documented; asked of the user) is:
//
//   Loop N                       ← the phase node passed to this script
//     State                      ← component-level states (the building blocks)
//       <Component>              ← e.g. "Composer States" → its variant frames (write / typing / …)
//       …
//     Flows                      ← assembled full-surface screens, in sequence (the acceptance views)
//       <screen frame>           ← e.g. "default sidebar", "empty state", "adding comment", …
//
// Every leaf mockup FRAME (under State or Flows) is one BLOCK the build must reach + match.
// - `Flows` frames  → role "flow"  (full-surface acceptance blocks — anchor the visual gate).
// - `State` frames  → role "state" (component states/variants — feed the Connect Map + CSS state).
// Enumerating from the frames (not a hardcoded list) is what makes "stopped at the happy path"
// impossible: an unbuilt frame is an unaccounted block → the verdict gate returns INCOMPLETE.
//
// SURFACE-AGNOSTIC + DESIGN-DERIVED: nothing is hardwired to any reference design. Each block's
// geometry comes from its OWN frame box (no fixed 354px width) and its state identity from its OWN
// label/name (no fixed taxonomy). A Loop of sidebar, dialog, or notification frames enumerates the
// same way. If a node has no recognizable State/Flows groups it falls back to LEGACY flat mode
// (every same-width top-level frame = a block) and warns — so older flat-layout designs still work.
//
// Deterministic skeleton only: id, figma node, exported frame PNG, the label, a best-guess state slug
// + drive/fixture/liveSelector DEFAULTS (comments-surface HINTS, applied best-effort). The Planner
// (LLM) refines drive/fixture/liveSelector per block against the live DOM; the list is shown at the
// coverage gate before it is frozen.
//
// Usage:
//   node scripts/enumerate-blocks.mjs rest <fileKey> <nodeId> [--out <dir>] [--scale 2] [--width <n>]
//   node scripts/enumerate-blocks.mjs from-nodes <nodes.json> <nodeId> [--out <dir>] [--scale 2]
// --width forces the legacy same-width filter; omit it to derive the dominant width from the design.
// Token: FIGMA_TOKEN env, else the OS keychain entry used by figma-extract (never the repo .env).

import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SERVICE = "velt-customize", ACCOUNT = "figma-token";
const API = "https://api.figma.com/v1";

// ---- token (same resolution order as figma-extract: env, then OS secure store; never repo .env) ----
function keychainGet() {
  try {
    if (process.platform === "darwin")
      return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
    if (process.platform === "linux")
      return execFileSync("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch { /* not stored */ }
  return null;
}
const resolveToken = () => process.env.FIGMA_TOKEN || keychainGet() || null;

// ---- state slug + drive HINTS, keyed by the label text (comments-surface heuristics, best-effort) ----
// These are only DEFAULTS the Planner overrides; on a non-comments surface they simply don't match and
// the block carries a null assert for the Planner to fill. drive.steps hint how to REACH the state;
// drive.assert proves it's active.
const LABEL_HINTS = [
  [/empty/i,                      { state: "empty",               drive: { steps: ["render with no content OR all filtered out"], assert: null } }],
  [/input focused|focus/i,        { state: "composer-focus",      drive: { steps: ["focus the composer input"], assert: null } }],
  [/@ ?mention|mention/i,         { state: "mention-autocomplete",drive: { steps: ["focus composer", "type '@'"], assert: null } }],
  [/input filled|filled/i,        { state: "composer-filled",     drive: { steps: ["focus composer", "type a message"], assert: null } }],
  [/double click|double-click/i,  { state: "thread-open",         drive: { steps: ["double-click / click a card to open its thread"], assert: null } }],
  [/adding comment|adding com/i,  { state: "reply-adding",        drive: { steps: ["open a thread", "focus its reply composer", "type a reply"], assert: null } }],
  [/submitted|submit/i,           { state: "reply-submitted",     drive: { steps: ["open a thread", "submit a reply"], assert: null } }],
  [/overflow threaded|overflow.*comment/i, { state: "thread-overflow", drive: { steps: ["seed a thread with > preview replies"], assert: null } }],
  [/threaded.*input|reply.*input/i,{ state: "thread-composer",     drive: { steps: ["open a thread", "focus its reply composer"], assert: null } }],
  [/threaded.*left|threaded|thread/i,{ state: "threaded",          drive: { steps: ["seed a thread with >= 1 reply"], assert: null } }],
  [/additional|multiple/i,        { state: "multiple",            drive: { steps: ["seed >= 2 separate comments"], assert: null } }],
  [/filter dropdown|filter.*open|sort by|reduction/i,{ state: "filter-open", drive: { steps: ["click the filter/sort trigger"], assert: null } }],
  [/overflow menu|options|assign/i,{ state: "options-open",        drive: { steps: ["hover a card", "click its kebab/options trigger"], assert: null } }],
  [/resolved.*toast|toast/i,      { state: "resolved-toast",      drive: { steps: ["resolve a comment", "capture the toast"], assert: null } }],
  [/link copied|copied/i,         { state: "link-copied",         drive: { steps: ["open options", "click Copy link", "capture the tooltip/toast"], assert: null } }],
  [/resolved.*filter/i,           { state: "filter-resolved",     drive: { steps: ["open filter", "enable Show resolved comments"], assert: null } }],
  [/resolved/i,                   { state: "resolved",            drive: { steps: ["resolve a comment", "show resolved"], assert: null } }],
  [/hover/i,                      { state: "hover",               drive: { steps: ["seed content", "hover the card"], assert: null } }],
  [/affirmative|dialog|delete|lost/i,{ state: "confirm-dialog",   drive: { steps: ["trigger the confirmation dialog"], assert: null } }],
  [/composer/i,                   { state: "composer",            drive: { steps: ["focus the composer"], assert: null } }],
  [/comment left|^comment/i,      { state: "default",             drive: { steps: ["seed one root comment"], assert: null } }],
];
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function classifyLabel(label) {
  for (const [re, v] of LABEL_HINTS) if (re.test(label)) return v;
  return { state: slug(label) || "state", drive: { steps: [`reach the "${label}" state`], assert: null } };
}

// ---- tree helpers ----
const box = (n) => n.absoluteBoundingBox;
const CONTAINER = new Set(["SECTION", "FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "INSTANCE"]);
function descendants(node, out = []) {
  for (const c of node.children || []) { out.push(c); descendants(c, out); }
  return out;
}
// The template nests mockups: a `Flows` section holds SCREEN frames; a `State` section holds component
// containers, each holding VARIANT frames. We want that SHALLOW level — the first depth under a container
// that actually holds frames — NOT the innermost leaves. (Descending to leaves pulls sub-components like
// an avatar or a button out as false "blocks" and misses the real screens — verified against a live Loop.)
const BLOCKISH = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP"]); // a mockup artboard (NOT a SECTION, which is organizational)
function shallowestFrames(container) {
  let level = (container.children || []).slice();
  while (level.length) {
    const blocks = level.filter((n) => box(n) && BLOCKISH.has(n.type));
    if (blocks.length) return blocks;
    level = level.flatMap((n) => n.children || []);
  }
  return [];
}
// nearest TEXT label sitting just above/near a frame (fallback when the frame's own name is generic)
function nearestLabelChars(frame, labels) {
  const fb = box(frame); let best = null, bd = Infinity;
  for (const l of labels) {
    const lb = box(l); if (!lb) continue;
    const dx = Math.abs(lb.x - fb.x), dy = fb.y - (lb.y + lb.height);
    const score = dx + (dy >= 0 ? dy : 1000 + Math.abs(dy));
    if (score < bd) { bd = score; best = l; }
  }
  return (best?.characters || "").trim() || null;
}
const isGeneric = (n) => !n || /^(frame|group|component|instance|state|flows?)\b/i.test(n.trim());
function firstNamed(root, re) {
  for (const n of descendants(root)) if (CONTAINER.has(n.type) && re.test((n.name || "").trim())) return n;
  return null;
}

// ---- enumeration ----
export function enumerateBlocks(rootDoc, { width, scale = 2, forceWidth } = {}) {
  const loopId = slug(rootDoc.name || "loop") || "loop";
  const labels = descendants(rootDoc).filter((c) => c.type === "TEXT" && box(c));
  const stateGroup = firstNamed(rootDoc, /^\s*state\b/i);
  const flowGroup = firstNamed(rootDoc, /^\s*flows?\b/i);

  let raw = [];       // { frame, role, component?, label }
  let mode;

  if (stateGroup || flowGroup) {
    mode = "loop";
    const labelOf = (f) => String((isGeneric(f.name) ? nearestLabelChars(f, labels) : f.name) || f.name || "(unlabeled)").trim();
    // Flows → the SCREEN frames (the shallow level of the Flows section).
    if (flowGroup) for (const f of shallowestFrames(flowGroup))
      raw.push({ frame: f, role: "flow", component: null, label: labelOf(f) });
    // State → for each component container, its VARIANT frames (the shallow level of that component).
    if (stateGroup) {
      const comps = (stateGroup.children || []).filter((c) => CONTAINER.has(c.type));
      const groups = comps.length ? comps.map((c) => [c.name, shallowestFrames(c)]) : [[null, shallowestFrames(stateGroup)]];
      for (const [comp, frames] of groups) for (const f of frames)
        raw.push({ frame: f, role: "state", component: comp ? String(comp).trim() : null, label: labelOf(f) });
    }
  } else {
    // LEGACY flat mode: every same-width top-level FRAME is a block, width DERIVED from the design.
    mode = "legacy";
    const top = (rootDoc.children || []).filter((c) => c.type === "FRAME" && box(c));
    const derivedWidth = forceWidth ?? width ?? dominantWidth(top);
    const frames = derivedWidth ? top.filter((f) => Math.abs(box(f).width - derivedWidth) < 6) : top;
    for (const f of frames) {
      const label = (isGeneric(f.name) ? nearestLabelChars(f, labels) : f.name) || f.name || "(unlabeled)";
      raw.push({ frame: f, role: "flow", component: null, label: String(label).trim() });
    }
  }

  // stable source order: top-to-bottom, then left-to-right
  raw.sort((a, b) => (box(a.frame).y - box(b.frame).y) || (box(a.frame).x - box(b.frame).x));

  const seen = new Set();
  const uniq = (base) => { let id = base || "block", i = 2; while (seen.has(id)) id = `${base}-${i++}`; seen.add(id); return id; };

  const blocks = raw.map((r, i) => {
    const f = r.frame, b = box(f);
    const { state, drive } = classifyLabel(r.label);
    const baseId = slug([r.role === "state" ? "state" : "flow", r.component, r.label].filter(Boolean).join("-")) || f.id.replace(":", "-");
    const id = uniq(baseId);
    return {
      id,
      name: r.label,
      figmaNodeId: f.id,
      framePng: `frames/${id}.png`,
      loopId,
      role: r.role,                         // "state" | "flow"
      component: r.component || null,        // for role=state: the owning component's name
      flowStep: r.role === "flow" ? r.label : null,
      surface: null,                         // Planner infers/fills (no hardcoded "sidebar")
      state, drive,
      liveSelector: null,                    // Planner resolves against the live DOM (no design-specific defaults)
      // frameBox = this frame's own box on the Figma canvas (device-independent px). Geometry is
      // DERIVED here — never a hardcoded width.
      frameBox: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      // frameRegion = the defining element's box in the frame (device px) — the Judge crops the frame
      // to this. The Planner fills it from the designSpec node box × scale.
      frameRegion: null,
      fixture: { note: "Planner fills canonical content from the frame text (author/message/replyCount)" },
      order: i,
    };
  });

  // FAMILIES — the unit of BUILD (verification stays per block). The harvey run proved the win:
  // its builder covered the 6-block thread-card family in ONE 36-min pass (shared wireframe subtree
  // + stylesheet region), while the strictly block-by-block sibling run averaged ~60-90 min/block.
  // `state` blocks group by their owning component; `flow` blocks form the LAST family — flows
  // compose already-verified states (harvey's flow-2 passed with 0 iterations because of this).
  const famMap = new Map();
  for (const b of blocks) {
    const famId = b.role === "flow" ? "flows" : `fam-${slug(b.component || "misc")}`;
    b.familyId = famId;
    if (!famMap.has(famId)) famMap.set(famId, { id: famId, role: b.role, component: b.component || null, blockIds: [], minOrder: b.order });
    const fam = famMap.get(famId);
    fam.blockIds.push(b.id);
    fam.minOrder = Math.min(fam.minOrder, b.order);
  }
  const families = [...famMap.values()]
    .sort((a, b) => (a.id === "flows") - (b.id === "flows") || a.minOrder - b.minOrder)   // flows LAST
    .map(({ minOrder, ...f }, i) => ({ ...f, buildOrder: i }));

  return { mode, loopId, scale, count: blocks.length, blocks, families };
}

// AUTO-SPLIT (--auto mode): pack families into sequential sub-phases of ≤ maxBlocks, NEVER splitting
// a family (its states share one wireframe subtree). Previously this packing was orchestrator
// judgment — it happened to get it right on the first --auto run, but load-bearing `--auto` behavior
// must be script-decided, not LLM-decided. A family larger than the cap gets its own sub-phase with
// a warning (family coherence beats the cap). Flows land last by family order.
export function autoSplit(families, maxBlocks = 8) {
  const subPhases = [];
  let cur = null;
  for (const f of families) {
    const n = f.blockIds.length;
    if (n > maxBlocks) {
      if (cur) { subPhases.push(cur); cur = null; }
      subPhases.push({ blockIds: [...f.blockIds], familyIds: [f.id], oversizedFamily: true });
      continue;
    }
    if (!cur || cur.blockIds.length + n > maxBlocks) { if (cur) subPhases.push(cur); cur = { blockIds: [], familyIds: [] }; }
    cur.blockIds.push(...f.blockIds);
    cur.familyIds.push(f.id);
  }
  if (cur) subPhases.push(cur);
  return subPhases.map((s, i) => ({ id: String.fromCharCode(65 + i), ...s }));   // A, B, C…
}

function dominantWidth(frames) {
  if (!frames.length) return null;
  const counts = new Map();
  for (const f of frames) { const w = Math.round(box(f).width); counts.set(w, (counts.get(w) || 0) + 1); }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}

// ---- main: fetch node + export frame PNGs via the Figma REST API ----
async function figmaGet(url, token) {
  const r = await fetch(url, { headers: { "X-Figma-Token": token } });
  const j = await r.json();
  if (!r.ok || j.err || j.error) throw new Error(`Figma API: ${j.err || j.error || r.status}`);
  return j;
}
async function exportFrames(fileKey, ids, scale, token, outDir) {
  const images = {};
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30).join(",");
    const j = await figmaGet(`${API}/images/${fileKey}?ids=${encodeURIComponent(chunk)}&format=png&scale=${scale}`, token);
    Object.assign(images, j.images || {});
  }
  await fs.mkdir(path.join(outDir, "frames"), { recursive: true });
  return images;
}

// WRITE-ONCE (resume clobber guard): once blocks.json exists it is FINALIZED state — the Planner
// annotates it (drive/fixture/liveSelector) and the loop keys everything to it. A resumed cloud
// run once re-enumerated over it, clobbering the annotations + fixture URLs on a phase that was
// one audit from done (~40 min of redundant work + a manual git-restore). Re-enumeration is only
// ever intentional: pass --force.
async function guardExistingBlocks(outDir, force) {
  const p = path.join(outDir, "blocks.json");
  if (!(await fs.access(p).then(() => true, () => false))) return;
  if (force) { console.error("⚠ --force: overwriting the existing blocks.json (prior annotations are LOST)"); return; }
  console.error(`✗ blocks.json already exists in ${outDir} — this phase is already enumerated.`);
  console.error("  A resumed run must NOT re-enumerate (it clobbers planner annotations + fixture URLs).");
  console.error("  Run `node scripts/resume-check.mjs check <phaseDir>` and obey its verdict, or pass --force to intentionally re-enumerate.");
  process.exit(5);
}

async function main() {
  const [mode, ...a] = process.argv.slice(2);
  const argv = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const scale = +argv("--scale", "2");
  const forceWidth = a.includes("--width") ? +argv("--width", "0") : undefined;
  const outDir = path.resolve(argv("--out", "."));
  const maxBlocks = +argv("--max-blocks", "8");
  const autoSplitFlag = a.includes("--auto-split");        // --auto runs: split instead of halting
  const allowLarge = a.includes("--allow-large") || autoSplitFlag;
  await fs.mkdir(outDir, { recursive: true });
  await guardExistingBlocks(outDir, a.includes("--force"));

  let rootDoc, fileKey;
  if (mode === "rest") {
    const [fk, nodeId] = a; fileKey = fk;
    const token = resolveToken();
    if (!token) { console.error("✗ no Figma token (set FIGMA_TOKEN or store it via figma-extract token set)"); process.exit(1); }
    const id = nodeId.replace(/-/g, ":");
    const j = await figmaGet(`${API}/files/${fileKey}/nodes?ids=${id}`, token);
    rootDoc = j.nodes[id]?.document;
    if (!rootDoc) { console.error(`✗ node ${id} not found in ${fileKey}`); process.exit(1); }

    const result = enumerateBlocks(rootDoc, { scale, forceWidth });
    guardEmpty(result, { maxBlocks, allowLarge });
    if (autoSplitFlag && result.count > maxBlocks) result.subPhases = autoSplit(result.families, maxBlocks);
    const images = await exportFrames(fileKey, result.blocks.map((b) => b.figmaNodeId), scale, token, outDir);
    for (const b of result.blocks) {
      const url = images[b.figmaNodeId];
      if (!url) { b.framePngMissing = true; continue; }
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      await fs.writeFile(path.join(outDir, b.framePng), buf);
    }
    result.source = `figma:${fileKey}`; result.nodeId = id;
    await fs.writeFile(path.join(outDir, "blocks.json"), JSON.stringify(result, null, 2) + "\n");
    report(result, outDir);
  } else if (mode === "from-nodes") {
    const [nodesPath, nodeId] = a;
    const id = nodeId.replace(/-/g, ":");
    const j = JSON.parse(await fs.readFile(nodesPath, "utf8"));
    rootDoc = (j.nodes?.[id]?.document) || j.document || j;
    const result = enumerateBlocks(rootDoc, { scale, forceWidth });
    guardEmpty(result, { maxBlocks, allowLarge });
    if (autoSplitFlag && result.count > maxBlocks) result.subPhases = autoSplit(result.families, maxBlocks);
    result.source = `nodes:${path.basename(nodesPath)}`; result.nodeId = id;
    await fs.writeFile(path.join(outDir, "blocks.json"), JSON.stringify(result, null, 2) + "\n");
    report(result, outDir);
  } else {
    console.error("usage: enumerate-blocks.mjs rest <fileKey> <nodeId> | from-nodes <nodes.json> <nodeId> [--out <dir>] [--scale 2] [--width <n>]");
    process.exit(1);
  }
}
function guardEmpty(result, { maxBlocks = 8, allowLarge = false } = {}) {
  if (result.count === 0) {
    console.error("✗ no blocks found. Expected a 'Loop' node containing 'State' and/or 'Flows' groups of mockup frames,");
    console.error("  or a flat node with same-width state frames. Confirm the passed node is a Loop (or point at one).");
    process.exit(2);
  }
  // HARD halt on an oversized phase (P1-7): an accidental 16-block Loop is a multi-hour/token
  // marathon. The cap is mechanical — the old prompt-only "warn at ~8" was never enforced.
  if (result.count > maxBlocks && !allowLarge) {
    console.error(`✗ ${result.count} blocks exceeds the per-phase cap of ${maxBlocks}. A phase should be ONE bounded Loop.`);
    console.error(`  Fix: split the Loop in Figma into smaller Loops (e.g. 'Loop 1: composer states', 'Loop 2: thread states')`);
    console.error(`  and run them as separate phases — or override deliberately with --allow-large [--max-blocks N].`);
    process.exit(3);
  }
  if (result.count > maxBlocks) console.warn(`⚠ ${result.count} blocks > cap ${maxBlocks} — proceeding under --allow-large; expect a long phase.`);
  if (result.mode === "legacy")
    console.warn("⚠ no State/Flows groups found — using LEGACY flat mode (every same-width top-level frame = a block).");
}
function report(result, outDir) {
  console.log(`✓ ${result.count} blocks (${result.mode}) → ${path.relative(process.cwd(), path.join(outDir, "blocks.json"))}`);
  for (const b of result.blocks)
    console.log(`  ${String(b.order).padStart(2)}. ${b.id.padEnd(28)} role=${b.role.padEnd(5)} state=${b.state.padEnd(18)} ${b.component ? "[" + b.component + "]" : ""}`);
  console.log(`  families (BUILD units — verify stays per block): ${(result.families || []).map((f) => `${f.id}(${f.blockIds.length})`).join(" → ")}`);
  if (result.subPhases) for (const s of result.subPhases)
    console.log(`  sub-phase ${s.id}: ${s.familyIds.join(" + ")} (${s.blockIds.length} blocks)${s.oversizedFamily ? "  ⚠ single family exceeds the cap — kept whole (family coherence beats the cap)" : ""}`);
  console.log("  The verdict gate requires a PASS for EVERY block — a run that builds fewer is INCOMPLETE.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

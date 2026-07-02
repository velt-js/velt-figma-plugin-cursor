#!/usr/bin/env node
// figma-extract.mjs — deterministic Figma design extraction for velt-customize.
// Turns Figma nodes into a `designSpec`: EXACT spacing/sizing/radius/typography/colours as
// CSS-ready declarations (so the Builder/Judge use real numbers, never eyeballed), plus
// per-node SVG icon export. One source, one schema:
//   * REST (Figma token required): api.figma.com node JSON -> designSpec  [fully deterministic]
// Also the secure Figma-token helpers (resolve/set/status/remove) — see plan §G.
//
// Usage:
//   node scripts/figma-extract.mjs token status|remove
//   node scripts/figma-extract.mjs token set            (reads token from STDIN, not argv)
//   node scripts/figma-extract.mjs rest <fileKey> <nodeId> [--out <dir>] [--svg]
//
// Layout mapping follows bernaferrari/FigmaToCode: auto-layout -> flex, with the two
// non-obvious rules — gap is suppressed on SPACE_BETWEEN, and "fill" is axis-dependent
// (flex:1 on the parent's primary axis vs align-self:stretch on the counter axis).

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import { execFileSync } from "node:child_process";

const SERVICE = "velt-customize";
const ACCOUNT = "figma-token";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.resolve(HERE, "../manifest/velt-codeconnect.json");

// ---------------- secure token handling (plan §G) ----------------
function keychainGet() {
  try {
    if (process.platform === "darwin")
      return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
    if (process.platform === "linux")
      return execFileSync("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch { /* not stored */ }
  return null;
}
function keychainSet(token) {
  if (process.platform === "darwin")
    execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", token], { stdio: "ignore" });
  else if (process.platform === "linux")
    execFileSync("secret-tool", ["store", "--label=velt-customize Figma token", "service", SERVICE, "account", ACCOUNT], { input: token, stdio: ["pipe", "ignore", "ignore"] });
  else throw new Error(`secure store not supported on ${process.platform}; use the FIGMA_TOKEN env var instead`);
}
function keychainRemove() {
  try {
    if (process.platform === "darwin") execFileSync("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT], { stdio: "ignore" });
    else if (process.platform === "linux") execFileSync("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT], { stdio: "ignore" });
    return true;
  } catch { return false; }
}
// Resolution order: env var first, then OS secure store. NEVER reads the repo's .env.
function resolveToken() {
  return process.env.FIGMA_TOKEN || keychainGet() || null;
}
const mask = (t) => (t && t.length > 4 ? `${t.slice(0, 4)}…${t.slice(-4)}` : "set");

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString().trim();
}

// ---------------- colour + helpers ----------------
function hex({ r, g, b }, a = 1) {
  const h = (n) => Math.round(n * 255).toString(16).padStart(2, "0");
  const base = `#${h(r)}${h(g)}${h(b)}`;
  return a >= 1 ? base : `${base}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
}
function firstSolid(fills) {
  const f = (fills || []).find((x) => x.type === "SOLID" && x.visible !== false);
  return f ? hex(f.color, f.opacity ?? f.color.a ?? 1) : null;
}
function concisePadding(t, r, b, l) {
  if (t === r && r === b && b === l) return t ? `${t}px` : null;
  if (t === b && l === r) return `${t}px ${r}px`;
  return `${t}px ${r}px ${b}px ${l}px`;
}
const JUSTIFY = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", SPACE_BETWEEN: "space-between" };
const ALIGN = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", BASELINE: "baseline" };

// ---------------- node -> designSpec node (FigmaToCode rules) ----------------
function mapNode(node, parent) {
  const css = {};
  const box = node.absoluteBoundingBox || {};
  const pMode = parent?.layoutMode && parent.layoutMode !== "NONE" ? parent.layoutMode : null;

  // auto-layout container -> flex
  if (node.layoutMode && node.layoutMode !== "NONE") {
    css.display = "flex";
    css["flex-direction"] = node.layoutMode === "VERTICAL" ? "column" : "row";
    const primary = node.primaryAxisAlignItems || "MIN";
    const counter = node.counterAxisAlignItems || "MIN";
    if (JUSTIFY[primary] && primary !== "MIN") css["justify-content"] = JUSTIFY[primary];
    if (ALIGN[counter] && counter !== "MIN") css["align-items"] = ALIGN[counter];
    // gap — suppressed on SPACE_BETWEEN (the browser distributes the space)
    if (node.itemSpacing && primary !== "SPACE_BETWEEN") css.gap = `${node.itemSpacing}px`;
    if (node.layoutWrap === "WRAP") css["flex-wrap"] = "wrap";
    const pad = concisePadding(node.paddingTop || 0, node.paddingRight || 0, node.paddingBottom || 0, node.paddingLeft || 0);
    if (pad) css.padding = pad;
  }

  // sizing — axis-dependent fill (the rule naive converters get wrong)
  const sh = node.layoutSizingHorizontal, sv = node.layoutSizingVertical;
  if (pMode === "HORIZONTAL") {
    if (sh === "FILL") css.flex = "1 1 0";
    else if (sh === "FIXED" && box.width) css.width = `${Math.round(box.width)}px`;
    if (sv === "FILL") css["align-self"] = "stretch";
    else if (sv === "FIXED" && box.height) css.height = `${Math.round(box.height)}px`;
  } else if (pMode === "VERTICAL") {
    if (sv === "FILL") css.flex = "1 1 0";
    else if (sv === "FIXED" && box.height) css.height = `${Math.round(box.height)}px`;
    if (sh === "FILL") css["align-self"] = "stretch";
    else if (sh === "FIXED" && box.width) css.width = `${Math.round(box.width)}px`;
  } else {
    if (sh === "FIXED" && box.width) css.width = `${Math.round(box.width)}px`;
    if (sv === "FIXED" && box.height) css.height = `${Math.round(box.height)}px`;
  }
  // HUG (content-driven) => emit nothing for that axis

  // radius
  const radius = node.cornerRadius ?? (Array.isArray(node.rectangleCornerRadii) ? node.rectangleCornerRadii : null);
  if (typeof radius === "number" && radius) css["border-radius"] = `${radius}px`;
  else if (Array.isArray(radius)) css["border-radius"] = radius.map((n) => `${n}px`).join(" ");

  // strokes -> border
  const stroke = firstSolid(node.strokes);
  if (stroke && node.strokeWeight) css.border = `${node.strokeWeight}px solid ${stroke}`;

  // fills: text -> color, else background
  const fill = firstSolid(node.fills);
  const isText = node.type === "TEXT";
  if (fill) css[isText ? "color" : "background"] = fill;

  // typography
  let text;
  if (isText && node.style) {
    const s = node.style;
    css["font-family"] = `"${s.fontFamily}"`;
    css["font-size"] = `${Math.round(s.fontSize)}px`;
    if (s.fontWeight) css["font-weight"] = String(s.fontWeight);
    if (s.lineHeightPx) css["line-height"] = `${Math.round(s.lineHeightPx)}px`;
    if (s.letterSpacing) css["letter-spacing"] = `${+s.letterSpacing.toFixed(2)}px`;
    text = { content: node.characters || "", family: s.fontFamily, size: s.fontSize, weight: s.fontWeight, lineHeight: s.lineHeightPx, letterSpacing: s.letterSpacing };
  }

  return {
    id: node.id, name: node.name, type: node.type,
    box: box.width ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } : null,
    cssDecls: css,
    ...(text ? { text } : {}),
  };
}

// normalize (AltNode-lite) + recurse, dropping invisibles, promoting groups.
// frameId = the top-level block-frame this node descends from (so normalizeBoxes can make every node
// relative to ITS frame, and a per-block consumer can select its nodes by frameId === block.figmaNodeId).
function walk(node, parent, out, frameId = null, blockFrameIds = null) {
  if (node.visible === false) return;
  const myFrameId = blockFrameIds && blockFrameIds.has(node.id) ? node.id : frameId;
  const type = node.type === "GROUP" ? "FRAME" : node.type;
  const mapped = mapNode({ ...node, type }, parent);
  mapped.frameId = myFrameId;
  out.push(mapped);
  for (const child of node.children || []) walk(child, node, out, myFrameId, blockFrameIds);
}

// PER-FRAME normalization. Figma emits ABSOLUTE canvas coords; the Judge measures surface-RELATIVE
// (getBoundingClientRect − surface-root). A single-frame extraction has ONE coord space (the root).
// But a SECTION / multi-state board (e.g. node 1:3398 = 16 sidebar frames laid out across the canvas)
// is exported as one frame PNG per frame, each at its OWN 0,0 — so every node must be relative to ITS
// frame, not the section. Each node carries `frameId` (its top-level block-frame ancestor, set in
// walk); we subtract each frame's own origin from its subtree. (Subtracting one root origin — the old
// bug — left section nodes ~1500px off, so `visual-diff --mask-text-from` mislocated every mask and
// the visual gate went blind, passing wrong icons / structure / spacing.)
export function normalizeBoxes(nodes) {
  const byFrame = new Map();
  for (const n of nodes) { const f = n.frameId || "__root__"; if (!byFrame.has(f)) byFrame.set(f, []); byFrame.get(f).push(n); }
  for (const [fid, group] of byFrame) {
    const frameNode = group.find((n) => n.id === fid) || group.find((n) => n.box && n.box.x != null);
    if (!frameNode || !frameNode.box) continue;
    const ox = frameNode.box.x || 0, oy = frameNode.box.y || 0;
    if (!ox && !oy) continue;
    for (const n of group) if (n.box && n.box.x != null) { n.box.x = Math.round(n.box.x - ox); n.box.y = Math.round(n.box.y - oy); }
  }
}

// The top-level "block frames" of an extraction: a SECTION's (or a multi-frame board's) direct frame
// children are each their OWN coord space; a single extracted frame is its own only frame.
export function blockFramesOf(root) {
  const kids = (root.children || []).filter((c) => c.type === "FRAME" || c.type === "SECTION" || c.type === "GROUP");
  if (root.type === "SECTION" || kids.length >= 2) return kids;
  return [root];
}

// likely-icon heuristic (FigmaToCode) — small vector-only subtree
function isIconNode(node) {
  if (["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"].includes(node.type)) return true;
  const b = node.absoluteBoundingBox;
  if (b && b.width <= 64 && b.height <= 64 && ["FRAME", "GROUP", "INSTANCE", "COMPONENT"].includes(node.type)) {
    const onlyVec = (n) => (n.children || []).every((c) => ["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE", "ELLIPSE", "RECTANGLE"].includes(c.type) && onlyVec(c));
    return (node.children || []).length > 0 && onlyVec(node);
  }
  return false;
}
function firstText(node, depth = 0) {
  if (!node || depth > 3) return null;
  if (node.type === "TEXT" && node.characters) return node.characters;
  for (const c of node.children || []) { const t = firstText(c, depth + 1); if (t) return t; }
  return null;
}
function collectIcons(node, parents, out) {
  if (node.visible === false) return;
  if (isIconNode(node)) {
    const parent = parents[parents.length - 1];
    // the label/ancestry are how we deterministically assign an icon to a slot: a menu row is
    // [icon, "Edit"], the reply affordance is [icon, "Reply"]; icon-only controls fall back to
    // an ancestry frame-name keyword.
    const b = node.absoluteBoundingBox;
    out.push({
      id: node.id, name: node.name, type: node.type,
      // component-signal (S3 layer): a named Figma icon component/instance (e.g. an `iconButton`/`Icon`)
      // is a strong "this is a deliberate icon" cue even with no adjacent label — M2a was exactly this.
      isComponent: ["INSTANCE", "COMPONENT", "COMPONENT_SET"].includes(node.type),
      label: parent ? firstText(parent) : null,
      ancestry: parents.map((p) => p.name).filter(Boolean),
      box: b ? { w: Math.round(b.width), h: Math.round(b.height) } : null,
    });
    return; // don't descend into an icon
  }
  for (const c of node.children || []) collectIcons(c, [...parents, node], out);
}

// glyph → name synonyms: the icon (or its component) is frequently NAMED for what it is even when it
// has no adjacent label. This is the layer that resolves the M2a filter/kebab icons that nearText +
// ancestry both missed (the filter was a named `iconButton`/`Icon` component).
export const GLYPH_SYNONYMS = {
  "filter-lines": ["filter", "filters", "funnel", "sliders", "adjust", "sort"],
  "kebab": ["kebab", "more", "ellipsis", "dots", "overflow", "options", "menu"],
  "check-circle": ["check", "resolve", "tick", "done", "complete", "circlecheck", "checkcircle"],
  "reply-arrow": ["reply", "respond", "arrowreply"],
  "pencil": ["pencil", "edit", "write"],
  "link": ["link", "copy", "chain", "url"],
  "trash": ["trash", "delete", "bin", "remove", "garbage"],
};
export function glyphTerms(h) {
  const out = new Set();
  if (h.glyph) { out.add(h.glyph.toLowerCase().replace(/[^a-z0-9]/g, "")); for (const s of GLYPH_SYNONYMS[h.glyph] || []) out.add(s); }
  if (h.nearText) out.add(h.nearText.toLowerCase());
  return [...out];
}
export function nameMatches(icon, terms) {
  const hay = [icon.name, ...(icon.ancestry || [])].filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9 ]/g, "");
  return terms.some((t) => t && hay.includes(t));
}

// Assign exported icons → slots via the manifest's iconHint, in CONFIDENCE LAYERS (S3):
//   1. nearText      — the icon's adjacent label ("Edit"/"Reply"). Strongest.
//   2. name/component-signal — the icon (or its named component) is named for the glyph (filter/kebab).
//   3. ancestryKeyword — a unique free icon under a matching ancestry frame.
// Anything still unmatched is reported UNASSIGNED with a RENDER-AND-RECOGNIZE candidate shortlist
// (the free SVGs to rasterize + identify by vision) — never guessed.
export async function assignIcons(icons, assets) {
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8")); }
  catch { return { assignments: {}, unassigned: [], note: "manifest not built — run scripts/build-manifest.mjs to enable icon→slot assignment" }; }
  const assetByNode = Object.fromEntries(assets.map((a) => [a.nodeId, a.file]));
  const assignments = {}, unassigned = [];
  const used = new Set(); // one SVG file → one slot (a kebab is not a reply arrow)
  const free = (i) => assetByNode[i.id] && !used.has(assetByNode[i.id]);
  const cand = (i) => ({ file: assetByNode[i.id], name: i.name, isComponent: i.isComponent, ancestry: i.ancestry, box: i.box });
  for (const comp of Object.values(manifest.components || {})) {
    for (const slot of comp.slots || []) {
      const h = slot.iconHint;
      if (!h) continue;
      let match = null, by = null;
      // layer 1 — nearText (the icon's adjacent label): assign the first free match.
      if (h.nearText) { const c = icons.filter((i) => i.label && i.label.toLowerCase().includes(h.nearText.toLowerCase()) && free(i)); if (c.length) { match = c[0]; by = `nearText:"${h.nearText}"`; } }
      // layer 2 — name/component-signal: the icon or its component is named for the glyph.
      if (!match) {
        const terms = glyphTerms(h);
        const c = icons.filter((i) => free(i) && nameMatches(i, terms));
        if (c.length === 1) { match = c[0]; by = `nameSignal:${terms.find((t) => nameMatches(c[0], [t]))}`; }
        else if (c.length > 1) { const comps = c.filter((i) => i.isComponent); if (comps.length === 1) { match = comps[0]; by = "nameSignal+component"; } }
      }
      // layer 3 — ancestryKeyword: accept ONLY when it resolves to a single free icon (unambiguous).
      if (!match && h.ancestryKeyword) { const c = icons.filter((i) => i.ancestry.some((a) => a.toLowerCase().includes(h.ancestryKeyword.toLowerCase())) && free(i)); if (c.length === 1) { match = c[0]; by = `ancestry:"${h.ancestryKeyword}"(unique)`; } }
      if (match) { assignments[slot.reactPath] = { file: assetByNode[match.id], by, glyph: h.glyph || null }; used.add(assetByNode[match.id]); }
      else {
        // render-and-recognize shortlist: name-hit free icons first, else all free icon-component candidates.
        const terms = glyphTerms(h);
        const freeIcons = icons.filter(free);
        const hits = freeIcons.filter((i) => nameMatches(i, terms));
        const pool = hits.length ? hits : freeIcons.filter((i) => i.isComponent).length ? freeIcons.filter((i) => i.isComponent) : freeIcons;
        unassigned.push({
          slot: slot.reactPath, hint: h, renderRecognize: true,
          candidates: pool.slice(0, 8).map(cand),
          note: `no deterministic match — RENDER each candidate SVG and recognize the glyph by vision, then wire the one matching '${h.glyph || h.nearText}'. ${hits.length ? "Shortlisted by name." : "No name hit; all free icon candidates listed."}`,
        });
      }
    }
  }
  return { assignments, unassigned };
}

// ---------------- REST ----------------
async function figmaFetch(url, token) {
  const res = await fetch(url, { headers: { "X-Figma-Token": token } });
  if (!res.ok) throw new Error(`Figma REST ${res.status} ${res.statusText} for ${url.replace(/ids=[^&]*/, "ids=…")}`);
  return res.json();
}
async function extractRest(fileKey, nodeId, outDir, doSvg) {
  const token = resolveToken();
  if (!token) throw new Error("no Figma token (env FIGMA_TOKEN or keychain) — set one: `export FIGMA_TOKEN=figd_…` or run `figma-extract token set`");
  const id = nodeId.replace(/-/g, ":");
  const data = await figmaFetch(`https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(id)}&geometry=paths`, token);
  const root = data.nodes?.[id]?.document;
  if (!root) throw new Error(`node ${id} not found in file ${fileKey}`);

  const nodes = [];
  const blockFrames = blockFramesOf(root);
  walk(root, null, nodes, null, new Set(blockFrames.map((f) => f.id)));
  normalizeBoxes(nodes);
  const frames = blockFrames.map((f) => ({ id: f.id, name: f.name, type: f.type }));

  const icons = [];
  collectIcons(root, [], icons);
  const assets = [];
  if (doSvg && icons.length) {
    const ids = icons.map((i) => i.id).join(",");
    const img = await figmaFetch(`https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(ids)}&format=svg`, token);
    await fs.mkdir(path.join(outDir, "assets"), { recursive: true });
    for (const ic of icons) {
      const u = img.images?.[ic.id];
      if (!u) continue;
      const svg = await (await fetch(u)).text();
      // Disambiguate with the node id — Figma layer names are often generic ("Icon", "Vector")
      // and would collide/overwrite otherwise.
      const slug = (ic.name || "icon").replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "") || "icon";
      const fname = `${slug}-${ic.id.replace(/[^a-z0-9]+/gi, "-")}.svg`;
      await fs.writeFile(path.join(outDir, "assets", fname), svg);
      assets.push({ nodeId: ic.id, name: ic.name, file: `assets/${fname}` });
    }
  }
  const iconAssign = doSvg ? await assignIcons(icons, assets) : { assignments: {}, unassigned: [] };
  return { source: "rest", fileKey, nodeId: id, boxSpace: "frame-relative", frames, nodeCount: nodes.length, nodes, assets, icons: icons.length,
    iconAssignments: iconAssign.assignments, unassignedIcons: iconAssign.unassigned };
}

// ---------------- main ----------------
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const outIdx = rest.indexOf("--out");
  const outDir = outIdx >= 0 ? path.resolve(rest[outIdx + 1]) : process.cwd();

  if (cmd === "token") {
    const sub = rest[0];
    if (sub === "status") {
      const env = process.env.FIGMA_TOKEN ? `env FIGMA_TOKEN (${mask(process.env.FIGMA_TOKEN)})` : null;
      const kc = keychainGet();
      if (env) console.log(`✓ token from ${env}`);
      else if (kc) console.log(`✓ token in OS keychain (${mask(kc)})`);
      else console.log("✗ no token — REST extraction (the only design-intake path) is unavailable. Set one: `figma-extract token set` (or export FIGMA_TOKEN).");
      return;
    }
    if (sub === "remove") { console.log(keychainRemove() ? "✓ token removed from keychain" : "no keychain token to remove"); return; }
    if (sub === "set") {
      if (process.stdin.isTTY) console.error("Paste the Figma token then Ctrl-D (it is read from STDIN, never argv/history):");
      const tok = await readStdin();
      if (!tok) throw new Error("no token on STDIN");
      keychainSet(tok);
      console.log(`✓ stored in OS keychain (${mask(tok)}). Read-only/file-content-scoped PATs recommended.`);
      return;
    }
    throw new Error("usage: token status|set|remove");
  }

  let spec;
  if (cmd === "rest") {
    const [fileKey, nodeId] = rest;
    if (!fileKey || !nodeId) throw new Error("usage: rest <fileKey> <nodeId> [--out <dir>] [--svg]");
    spec = await extractRest(fileKey, nodeId, outDir, rest.includes("--svg"));
  } else {
    throw new Error("usage: figma-extract.mjs token|rest …");
  }

  await fs.mkdir(outDir, { recursive: true });
  const out = path.join(outDir, "designSpec.json");
  await fs.writeFile(out, JSON.stringify(spec, null, 2) + "\n");
  const nA = spec.iconAssignments ? Object.keys(spec.iconAssignments).length : 0;
  const nU = spec.unassignedIcons ? spec.unassignedIcons.length : 0;
  console.log(`✓ wrote ${path.relative(process.cwd(), out)} — source=${spec.source}, ${spec.nodeCount} nodes${spec.assets ? `, ${spec.assets.length} SVG assets` : ""}${spec.iconAssignments ? `, ${nA} icon→slot assigned${nU ? `, ${nU} unassigned (inspect SVGs)` : ""}` : ""}`);
}

// run as CLI only — importable for unit tests (golden icon-resolver calibration)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

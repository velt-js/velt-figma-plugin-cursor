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
import crypto from "node:crypto";
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
// Figma paints fills bottom-to-top; CSS `background` holds ONE color — composite the visible
// solid fills (top over bottom, standard source-over) into the color the eye actually sees.
function compositedSolid(fills) {
  const solids = (fills || []).filter((x) => x.type === "SOLID" && x.visible !== false);
  if (!solids.length) return null;
  if (solids.length === 1) return hex(solids[0].color, solids[0].opacity ?? solids[0].color.a ?? 1);
  let acc = null; // {r,g,b,a} in 0..1
  for (const s of solids) { // fills array is bottom-first
    const a = s.opacity ?? s.color.a ?? 1;
    const top = { r: s.color.r, g: s.color.g, b: s.color.b, a };
    if (!acc) { acc = top; continue; }
    const outA = top.a + acc.a * (1 - top.a);
    acc = outA === 0 ? { r: 0, g: 0, b: 0, a: 0 } : {
      r: (top.r * top.a + acc.r * acc.a * (1 - top.a)) / outA,
      g: (top.g * top.a + acc.g * acc.a * (1 - top.a)) / outA,
      b: (top.b * top.a + acc.b * acc.a * (1 - top.a)) / outA,
      a: outA,
    };
  }
  return hex(acc, acc.a);
}
// effects -> box-shadow (DROP_SHADOW / INNER_SHADOW, in order); zero-alpha shadows paint nothing.
function boxShadowOf(effects) {
  const parts = [];
  for (const e of effects || []) {
    if (e.visible === false) continue;
    if (e.type !== "DROP_SHADOW" && e.type !== "INNER_SHADOW") continue;
    const a = e.color?.a ?? 1;
    if (a === 0) continue;
    const inset = e.type === "INNER_SHADOW" ? "inset " : "";
    const { x = 0, y = 0 } = e.offset || {};
    parts.push(`${inset}${x}px ${y}px ${e.radius ?? 0}px ${e.spread ? `${e.spread}px ` : ""}${hex(e.color, a)}`);
  }
  return parts.length ? parts.join(", ") : null;
}
function concisePadding(t, r, b, l) {
  if (t === r && r === b && b === l) return t ? `${t}px` : null;
  if (t === b && l === r) return `${t}px ${r}px`;
  return `${t}px ${r}px ${b}px ${l}px`;
}
const JUSTIFY = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", SPACE_BETWEEN: "space-between" };
const ALIGN = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", BASELINE: "baseline" };

// characterStyleOverrides + styleOverrideTable -> [{content, decls}] runs. decls carry ONLY the
// properties that differ from the node's base style. Returns null when the text is single-style.
function styleRuns(node, base) {
  const ov = node.characterStyleOverrides;
  if (!Array.isArray(ov) || !ov.some((k) => k !== 0) || !node.styleOverrideTable) return null;
  const chars = [...(node.characters || "")];
  const runs = [];
  let curKey; // characters beyond the overrides array are base-styled (key 0)
  for (let i = 0; i < chars.length; i++) {
    const key = ov[i] || 0;
    if (key !== curKey) { runs.push({ key, content: "" }); curKey = key; }
    runs[runs.length - 1].content += chars[i];
  }
  const declsOf = (o) => {
    const d = {};
    if (o.fontWeight && o.fontWeight !== base.fontWeight) d["font-weight"] = String(o.fontWeight);
    if (o.fontFamily && o.fontFamily !== base.fontFamily) d["font-family"] = `'${o.fontFamily}'`;
    if (o.fontSize && Math.round(o.fontSize) !== Math.round(base.fontSize)) d["font-size"] = `${Math.round(o.fontSize)}px`;
    if (o.textDecoration === "UNDERLINE") d["text-decoration"] = "underline";
    if (o.textDecoration === "STRIKETHROUGH") d["text-decoration"] = "line-through";
    if (o.letterSpacing != null && o.letterSpacing !== base.letterSpacing) d["letter-spacing"] = `${+o.letterSpacing.toFixed(2)}px`;
    const c = firstSolid(o.fills);
    if (c) d.color = c;
    if (o.fontStyle === "Italic" || o.italic) d["font-style"] = "italic";
    return d;
  };
  return runs.map((r) => ({ content: r.content, decls: r.key ? declsOf(node.styleOverrideTable[String(r.key)] || {}) : {} }));
}

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

  // strokes -> border ONLY when Figma paints them INSIDE the box (CSS border-box semantics).
  // OUTSIDE strokes (avatar ring, comment-card outline) paint beyond the box — a CSS border
  // there both hides under same-size children and shrinks the content area; the faithful CSS
  // is a 0-blur spread box-shadow ring. CENTER (icon vectors, exported as SVG) ≈ border.
  const stroke = firstSolid(node.strokes);
  const strokeRing = [];
  if (stroke && node.strokeWeight) {
    const w = +(+node.strokeWeight).toFixed(2);
    if (node.strokeAlign === "OUTSIDE") strokeRing.push(`0px 0px 0px ${w}px ${stroke}`);
    else css.border = `${w}px solid ${stroke}`;
  }

  // effects -> box-shadow (the card ring / composer shadow class of misses);
  // the outside-stroke ring is painted above the effect shadows, so it lists first.
  const shadow = boxShadowOf(node.effects);
  const shadowParts = [...strokeRing, ...(shadow ? [shadow] : [])];
  if (shadowParts.length) css["box-shadow"] = shadowParts.join(", ");

  // node opacity (muted icon buttons are opacity, not a lighter fill)
  if (node.opacity != null && node.opacity < 1) css.opacity = String(+node.opacity.toFixed(2));

  // fills: text -> color; a VECTOR/glyph -> `fill` (it is an SVG shape, NOT a box — emitting
  // `background` on a glyph paints a SOLID SQUARE over the line-art, the black-filter-icon bug);
  // a box frame -> background (multiple solid fills composited to the seen color).
  const isText = node.type === "TEXT";
  const VECTOR_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);
  const isGlyph = VECTOR_TYPES.has(node.type);
  const fill = isText ? firstSolid(node.fills) : compositedSolid(node.fills);
  if (fill) css[isText ? "color" : (isGlyph ? "fill" : "background")] = fill;

  // typography
  let text;
  if (isText && node.style) {
    const s = node.style;
    // single quotes — cssDecls values must survive inside style="…" attributes too
    css["font-family"] = `'${s.fontFamily}'`;
    css["font-size"] = `${Math.round(s.fontSize)}px`;
    if (s.fontWeight) css["font-weight"] = String(s.fontWeight);
    if (s.lineHeightPx) css["line-height"] = `${Math.round(s.lineHeightPx)}px`;
    if (s.letterSpacing) css["letter-spacing"] = `${+s.letterSpacing.toFixed(2)}px`;
    // alignment (Figma default LEFT/TOP): text-align for horizontal; align-content (block
    // containers, Chrome 123+) for vertical centering of the line box inside the exact node box.
    const AH = { LEFT: null, CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" };
    const AV = { TOP: null, CENTER: "center", BOTTOM: "end" };
    if (AH[s.textAlignHorizontal]) css["text-align"] = AH[s.textAlignHorizontal];
    if (AV[s.textAlignVertical]) css["align-content"] = AV[s.textAlignVertical];
    // Figma leadingTrim CAP_HEIGHT sizes the text box to the glyph caps (the avatar "W" box is
    // 8px for a 12px font) — CSS text-box (Chrome 133+) reproduces the exact vertical metrics.
    if (s.leadingTrim === "CAP_HEIGHT") css["text-box"] = "trim-both cap alphabetic";
    // fixed-size text boxes CLIP in Figma (textAutoResize NONE); TRUNCATE ellipsizes. Without
    // this a 178-char comment in a 2-line box overflows its card in any faithful render.
    if (s.textAutoResize === "NONE" || node.style.textTruncation === "ENDING") css.overflow = "hidden";
    text = { content: node.characters || "", family: s.fontFamily, size: s.fontSize, weight: s.fontWeight, lineHeight: s.lineHeightPx, letterSpacing: s.letterSpacing,
             ...(s.textAlignHorizontal && s.textAlignHorizontal !== "LEFT" ? { alignH: s.textAlignHorizontal } : {}),
             ...(s.textAlignVertical && s.textAlignVertical !== "TOP" ? { alignV: s.textAlignVertical } : {}) };
    // character-level style runs (a bold "Mention", an underlined purple doc link): Figma stores
    // these as characterStyleOverrides + styleOverrideTable INSIDE one TEXT node; flattening them
    // to the base style silently un-bolds mentions and un-links links. Emit styled runs.
    const runs = styleRuns(node, s);
    if (runs) text.runs = runs;
  }

  return {
    id: node.id, name: node.name, type: node.type,
    box: box.width ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } : null,
    cssDecls: css,
    // a Figma mask node clips its following siblings — without this flag a consumer paints
    // the masked layers at full size (the caret bug: 8x20 black bar instead of a 1px caret)
    ...(node.isMask ? { isMask: true } : {}),
    ...(node.__brokenOverride ? { brokenOverride: true } : {}),
    ...(node.type === "INSTANCE" && node.componentId ? { componentId: node.componentId } : {}),
    ...(text ? { text } : {}),
  };
}

// normalize (AltNode-lite) + recurse, dropping invisibles, promoting groups.
// frameId = the top-level block-frame this node descends from (so normalizeBoxes can make every node
// relative to ITS frame, and a per-block consumer can select its nodes by frameId === block.figmaNodeId).
function walk(node, parent, out, frameId = null, blockFrameIds = null, inIcon = false) {
  if (node.visible === false) return;
  // a TEXT node Figma's SERVER renderer paints NO ink for (absoluteRenderBounds: null):
  //  - plain / empty text → genuinely unrendered: drop it.
  //  - instance-internal with characters → a BROKEN OVERRIDE: REST reports override chars the
  //    client doesn't apply; the client falls back to the COMPONENT MASTER's text clipped to
  //    the stale box. Keep the node flagged for master-text recovery (post-pass in extractRest).
  const brokenOverride = node.type === "TEXT" && node.absoluteRenderBounds === null;
  if (brokenOverride && (!node.id.includes(";") || !node.characters)) return;
  if (brokenOverride) node.__brokenOverride = true;
  const myFrameId = blockFrameIds && blockFrameIds.has(node.id) ? node.id : frameId;
  const type = node.type === "GROUP" ? "FRAME" : node.type;
  const mapped = mapNode({ ...node, type }, parent);
  mapped.frameId = myFrameId;
  // nodes INSIDE an icon subtree are the glyph's internal build layers (masks, color plates);
  // the exported SVG asset paints them — a consumer that also paints these nodes double-paints
  // (the caret bug: an 8x20 black "Color layer" rect over the 1px masked caret).
  if (inIcon) mapped.inIcon = true;
  out.push(mapped);
  const childInIcon = inIcon || isIconNode(node);
  // paint order: within an auto-layout parent, Figma renders layoutPositioning:ABSOLUTE
  // children BELOW the in-flow siblings (verified against Figma's own section render — the
  // absolute "Sidebar frame" chrome paints behind the in-flow comment list). Emit them first
  // so document order == paint order for consumers.
  let kids = node.children || [];
  if (node.layoutMode && node.layoutMode !== "NONE" && kids.some((k) => k.layoutPositioning === "ABSOLUTE")) {
    kids = [...kids.filter((k) => k.layoutPositioning === "ABSOLUTE"), ...kids.filter((k) => k.layoutPositioning !== "ABSOLUTE")];
  }
  for (const child of kids) walk(child, node, out, myFrameId, blockFrameIds, childInIcon);
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
// Match the icon's OWN name (and its component name) ONLY — never its ancestry. Ancestry frame
// names carry unrelated words ("Single Comment with MORE than 1 replies" contains the kebab
// synonym "more") and were the root cause of confidently-wrong assignments; ancestry evidence
// is only ever used via the explicit layer-3 ancestryKeyword check.
export function nameMatches(icon, terms) {
  const hay = (icon.name || "").toLowerCase().replace(/[^a-z0-9 ]/g, "");
  return terms.some((t) => t && hay.includes(t));
}

// STRONG name match — required for a DETERMINISTIC assignment (weak matches only shortlist).
// A compound icon name where the synonym is a substring of a different concept must not assign:
// "Icon / Outline / text-options" contains the kebab synonym "options" but names a TEXT-options
// glyph. Rule: after stripping generic tokens (icon/outline/sizes/numbers) and every glyph
// term, nothing meaningful may remain in the name.
const GENERIC_NAME_TOKENS = new Set(["icon", "icons", "outline", "solid", "filled", "fill", "px", "size", "small", "medium", "large", "mini", "variant", "default", "light", "dark", "left", "right"]);
export function strongNameMatch(icon, hint) {
  const terms = glyphTerms(hint);
  const words = (icon.name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w && !GENERIC_NAME_TOKENS.has(w));
  const joined = words.join(" ");
  if (!terms.some((t) => t && joined.replace(/ /g, "").includes(t))) return false;
  const glyphWords = (hint.glyph || "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
  let rest = joined;
  for (const t of [...terms, ...glyphWords].sort((a, b) => b.length - a.length)) rest = rest.split(t).join(" ");
  return rest.replace(/[^a-z]/g, "").length <= 2;
}

// The feature word a component's slots require in the design ("VeltNotificationsPanelWireframe"
// → "notification"): if NO node in the design mentions it, the surface isn't in this design and
// its icon slots must not be filled (the phantom-surface failure mode).
export function featureWord(componentName) {
  const first = componentName.replace(/^Velt/, "").replace(/Wireframe$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ")[0] || componentName;
  return first.toLowerCase().replace(/s$/, "");
}

// Assign exported icons → slots via the manifest's iconHint, in CONFIDENCE LAYERS (S3):
//   0. feature-scope gate — skip a component's slots entirely when the design names never
//      mention its feature (no phantom surfaces); skips are reported, never silent.
//   1. nearText      — the icon's adjacent label ("Edit"/"Reply"). Strongest.
//   2. name/component-signal — the icon ITSELF is named for the glyph (filter/kebab); identical
//      duplicate exports (same SVG content hash) count as ONE glyph and assign deterministically.
//   3. ancestryKeyword — a unique free icon under a matching ancestry frame.
// Anything still unmatched is reported UNASSIGNED with a RENDER-AND-RECOGNIZE candidate shortlist
// (the free SVGs to rasterize + identify by vision) — never guessed; and if no candidate matches
// the glyph, the honest answer is "not in this design", not a forced pick.
export async function assignIcons(icons, assets, designNames = null) {
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8")); }
  catch { return { assignments: {}, unassigned: [], skipped: [], note: "manifest not built — run scripts/build-manifest.mjs to enable icon→slot assignment" }; }
  const assetByNode = Object.fromEntries(assets.map((a) => [a.nodeId, a.file]));
  // glyph identity = SVG content hash when available (duplicate exports are ONE glyph), else the file name.
  const glyphIdByFile = Object.fromEntries(assets.map((a) => [a.file, a.hash || a.file]));
  const glyphId = (i) => glyphIdByFile[assetByNode[i.id]];
  const assignments = {}, unassigned = [], skipped = [];
  const used = new Set(); // one GLYPH → one slot (a kebab is not a reply arrow)
  const free = (i) => assetByNode[i.id] && !used.has(glyphId(i));
  const cand = (i) => ({ file: assetByNode[i.id], name: i.name, isComponent: i.isComponent, ancestry: i.ancestry, box: i.box });
  const dedupeByGlyph = (list) => { const seen = new Set(); return list.filter((i) => { const g = glyphId(i); if (seen.has(g)) return false; seen.add(g); return true; }); };
  const designHay = designNames ? designNames.filter(Boolean).join(" ").toLowerCase() : null;
  for (const [compName, comp] of Object.entries(manifest.components || {})) {
    const iconSlots = (comp.slots || []).filter((s) => s.iconHint);
    if (!iconSlots.length) continue;
    // layer 0 — feature-scope gate (only when design names are available).
    if (designHay) {
      const word = featureWord(compName);
      if (!designHay.includes(word)) {
        skipped.push({ component: compName, slots: iconSlots.map((s) => s.reactPath), reason: `design never mentions "${word}" — surface not in this design` });
        continue;
      }
    }
    for (const slot of iconSlots) {
      const h = slot.iconHint;
      let match = null, by = null;
      // layer 1 — nearText (the icon's adjacent label): assign the first free match.
      if (h.nearText) { const c = icons.filter((i) => i.label && i.label.toLowerCase().includes(h.nearText.toLowerCase()) && free(i)); if (c.length) { match = c[0]; by = `nearText:"${h.nearText}"`; } }
      // layer 2 — name/component-signal: the icon itself is named for the glyph (STRONG match
      // only — compound names like "text-options" shortlist but never assign).
      if (!match) {
        const terms = glyphTerms(h);
        const c = dedupeByGlyph(icons.filter((i) => free(i) && strongNameMatch(i, h)));
        if (c.length === 1) { match = c[0]; by = `nameSignal:${terms.find((t) => nameMatches(c[0], [t]))}`; }
        else if (c.length > 1) { const comps = c.filter((i) => i.isComponent); if (comps.length === 1) { match = comps[0]; by = "nameSignal+component"; } }
      }
      // layer 3 — ancestryKeyword: accept ONLY when it resolves to a single free glyph (unambiguous).
      if (!match && h.ancestryKeyword) { const c = dedupeByGlyph(icons.filter((i) => i.ancestry.some((a) => a.toLowerCase().includes(h.ancestryKeyword.toLowerCase())) && free(i))); if (c.length === 1) { match = c[0]; by = `ancestry:"${h.ancestryKeyword}"(unique)`; } }
      if (match) { assignments[slot.reactPath] = { file: assetByNode[match.id], by, glyph: h.glyph || null }; used.add(glyphId(match)); }
      else {
        // render-and-recognize shortlist: name-hit free glyphs first, else ALL free glyphs
        // (never filtered to named components — an anonymous "Frame" icon can be the real match).
        const terms = glyphTerms(h);
        const freeIcons = dedupeByGlyph(icons.filter(free));
        const hits = freeIcons.filter((i) => nameMatches(i, terms));
        const pool = hits.length ? hits : freeIcons;
        unassigned.push({
          slot: slot.reactPath, hint: h, renderRecognize: true,
          candidates: pool.slice(0, 8).map(cand),
          note: `no deterministic match — RENDER each candidate SVG and recognize the glyph by vision, then wire the one matching '${h.glyph || h.nearText}'. ${hits.length ? "Shortlisted by name." : "No name hit; all free glyph candidates listed."} If NO candidate matches, the glyph is NOT in this design — mark the slot not-present, never force a pick.`,
        });
      }
    }
  }
  return { assignments, unassigned, skipped };
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
      // content hash = glyph identity: duplicate exports of the same glyph collapse to one.
      assets.push({ nodeId: ic.id, name: ic.name, file: `assets/${fname}`, hash: crypto.createHash("md5").update(svg.trim()).digest("hex") });
    }
  }
  // broken-override recovery: REST reports override characters Figma's client never applies
  // (server render bounds: null → no ink). The client falls back to the COMPONENT MASTER's
  // text, clipped to the stale box. Recover that client truth: resolve the instance's component
  // to its (possibly remote library) master via /v1/components/:key, and take the master text
  // node's content + style runs. No master reachable → drop (matches the server render).
  const broken = nodes.filter((n) => n.brokenOverride);
  if (broken.length) {
    const compMeta = data.nodes?.[id]?.components || {};
    const componentIdByInstance = Object.fromEntries(nodes.filter((n) => n.componentId).map((n) => [n.id, n.componentId]));
    const masterCache = new Map();
    const masterDocOf = async (componentId) => {
      if (masterCache.has(componentId)) return masterCache.get(componentId);
      let doc = null;
      try {
        const key = compMeta[componentId]?.key;
        if (key) {
          const c = await figmaFetch(`https://api.figma.com/v1/components/${key}`, token);
          if (c.meta?.file_key && c.meta?.node_id) {
            const lib = await figmaFetch(`https://api.figma.com/v1/files/${c.meta.file_key}/nodes?ids=${encodeURIComponent(c.meta.node_id)}`, token);
            doc = lib.nodes?.[c.meta.node_id]?.document || null;
          }
        }
      } catch { doc = null; }
      masterCache.set(componentId, doc);
      return doc;
    };
    for (const n of broken) {
      const segs = n.id.split(";");
      const leafId = segs[segs.length - 1];
      const rootComponent = componentIdByInstance[segs[0].replace(/^I/, "")];
      let masterText = null;
      const doc = rootComponent ? await masterDocOf(rootComponent) : null;
      if (doc) {
        let masterNode = null;
        (function find(m) { if (m.id === leafId) masterNode = m; else (m.children || []).forEach(find); })(doc);
        if (masterNode) masterText = mapNode(masterNode, null).text || null;
      }
      if (masterText) {
        n.text = masterText;
        n.cssDecls.overflow = "hidden"; // the stale box clips the master text (client behavior)
        n.recoveredFrom = `component-master:${rootComponent}/${leafId}`;
      } else {
        n.__drop = true;
      }
    }
  }
  const finalNodes = nodes.filter((n) => !n.__drop);
  const designNames = finalNodes.map((n) => n.name);
  const iconAssign = doSvg ? await assignIcons(icons, assets, designNames) : { assignments: {}, unassigned: [], skipped: [] };
  return { source: "rest", fileKey, nodeId: id, boxSpace: "frame-relative", frames, nodeCount: finalNodes.length, nodes: finalNodes, assets, icons: icons.length,
    iconAssignments: iconAssign.assignments, unassignedIcons: iconAssign.unassigned, skippedIconSlots: iconAssign.skipped || [] };
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
  const nS = spec.skippedIconSlots ? spec.skippedIconSlots.length : 0;
  console.log(`✓ wrote ${path.relative(process.cwd(), out)} — source=${spec.source}, ${spec.nodeCount} nodes${spec.assets ? `, ${spec.assets.length} SVG assets` : ""}${spec.iconAssignments ? `, ${nA} icon→slot assigned${nU ? `, ${nU} unassigned (inspect SVGs)` : ""}${nS ? `, ${nS} component(s) skipped (surface not in design)` : ""}` : ""}`);
}

// run as CLI only — importable for unit tests (golden icon-resolver calibration)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

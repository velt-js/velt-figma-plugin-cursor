#!/usr/bin/env node
// brief-scaffold.mjs — deterministic SKELETONS for the per-block probe briefs + per-family smoke
// specs, so the Planner FILLS briefs instead of AUTHORING them. The first --auto cloud run sprawled
// ~80+ min in planning largely because we asked an LLM to hand-write 13 probes.json + 5 smoke.json
// machine-exact files. Everything below is derivable from artifacts that already exist:
//   * `browser` probe elements  ← the block's spec slice (nodes with cssDecls + boxes)
//   * `contract` probe entries  ← the manifest component's contract.parts (selectorHints)
//   * `stability` targets       ← the manifest's interactive-role slots (trigger/action/item)
//   * `liveSelector` default    ← the block's component root wireframe tag
// The Planner's remaining job is the genuinely cognitive part: fill `drive.steps`, verify selectors
// against the live DOM (post-build-stable ones — contract wireframe tags / stable velt-* / .vc-*),
// tune relations/gaps, and flesh out the smoke steps. Every field it must complete is marked with a
// "_todo" key; `--lint` fails while any remains, so a half-filled brief can't reach measure-block.
//
// Usage:
//   node scripts/brief-scaffold.mjs <phaseDir> [--connect-map <file>] [--manifest <file>]
//   node scripts/brief-scaffold.mjs <phaseDir> --lint      # exit 0 clean · 2 _todo leftovers remain
//
// TWO-PHASE PLANNING (plan-structure → build-structure → dom-snapshot → plan-style → build-style):
//   node scripts/brief-scaffold.mjs <phaseDir> --structure          # structure briefs: drive +
//        contract/cardinality + slot-adoption rows, NO style rows (gates the structure build)
//   node scripts/brief-scaffold.mjs <phaseDir> --lint-structure     # exit 0 gates BUILD-STRUCTURE
//   node scripts/brief-scaffold.mjs <phaseDir> --style [--from-snapshot <dir>]
//        # ENRICH the structure briefs with style rows: per-element expected decls (from the spec
//        # slices) + gaps, PLUS the loop1 blind-spot row classes pre-filled from dom-snapshot/:
//        # wrapper/internal rows, suppression rows (expected paint none / count 0), clip-visibility
//        # rows, focus/outline rows. The style planner fills the remaining _todos.
//   node scripts/brief-scaffold.mjs <phaseDir> --lint-style         # exit 0 gates BUILD-STYLE
//        # (also validates plan-style.json selectors against the snapshots when both exist)
//
// Existing briefs are never overwritten (the Planner's filled work is sacred); missing ones are
// scaffolded. Run spec-slice.mjs FIRST (skeletons read the slices).

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { DRIVE_VOCAB, validateDriveSteps } from "./measure-block.mjs";   // shared drive contract + validator
import { obsEvent } from "./obs.mjs";   // session-replay record (fail-safe, VELT_OBS=0 disables)

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRIVE_VERBS = Object.keys(DRIVE_VOCAB).join("|");

// A surface that must be OPENED before it can be measured (sidebar / dialog / any flow). For these an
// empty drive is a false-pass (a closed sidebar renders nothing), so we pre-fill a deterministic open:
// Velt's own toggleCommentSidebar() API + a real panel assert. The Planner may refine (a custom toggle
// button, a specific state), but it must never be left empty. Returns a drive object, or null (the block
// is an always-visible surface whose open the Planner must author, still gated by validateDriveSteps).
function defaultDriveFor(block, liveSelector) {
  const surf = `${block.component || ""} ${block.surface || ""} ${block.state || ""} ${liveSelector || ""}`.toLowerCase();
  const isSidebar = block.role === "flow" || /sidebar|comments-sidebar|comment-list|feed/.test(surf);
  if (!isSidebar) return null;
  const assert = "velt-comments-sidebar, velt-comments-sidebar-v2, [class*='velt-sidebar'], [class*='comment-sidebar']";
  return {
    steps: [
      { action: "eval", js: "try{window.Velt?.getCommentElement?.()?.toggleCommentSidebar?.(true);}catch(e){}" },
      { action: "waitFor", selector: assert, ms: 8000 },
    ],
    assert,
    _auto_open: "sidebar opened via Velt toggleCommentSidebar() (deterministic default). Refine ONLY if this app uses a custom toggle; NEVER leave drive.steps empty — an empty drive on a closed sidebar is a false-pass.",
  };
}
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function loadJson(p) { return JSON.parse(await fs.readFile(p, "utf8")); }
async function exists(p) { return fs.access(p).then(() => true, () => false); }

// Classify a designSpec node by what it IS in the live DOM:
//   "paint"        — a visible box: carries any of background/border/box-shadow/border-radius/fill/outline/stroke.
//   "text"         — a text run: has text content or font/color typography props.
//   "layout-frame" — a Figma AUTO-LAYOUT wrapper carrying ONLY layout props (display/flex*/gap/justify*/
//                    align*/padding/width/height). These flatten in the live Velt DOM (several collapse
//                    onto one element); they must NOT each demand their own live selector + box assertion.
const PAINT_PROPS = new Set(["background", "background-color", "color", "border", "border-color", "border-width", "border-top", "border-right", "border-bottom", "border-left", "box-shadow", "border-radius", "fill", "stroke", "outline", "opacity"]);
const TEXT_PROPS = new Set(["color", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "text-box"]);
// Chrome container names that must keep geometry even when Figma only listed layout props on a
// sibling — promote to paint when the name clearly denotes a card/panel/composer surface.
const CHROME_NAME_RE = /\b(card|panel|composer|sidebar|dialog|thread|container|surface)\b/i;

export function textContentOf(node) {
  if (!node) return "";
  if (typeof node.text === "string") return node.text.trim();
  if (node.text && typeof node.text === "object" && typeof node.text.content === "string") return node.text.content.trim();
  return "";
}

/** Static UI chrome strings (placeholders, affordance labels, section titles) — not comment bodies / user data. */
export function isStaticChromeText(node) {
  const t = textContentOf(node);
  if (!t || t.length < 2) return false;
  const name = String(node?.name || "");
  // Explicit chrome copy (placeholders / affordances / section titles)
  if (/^(comment or tag|reply to\b|show\s+\d+\s+replies|add a comment|write a comment|type a)/i.test(t)) return true;
  if (/^(comments|reply|filter|options|resolve)$/i.test(t.trim())) return true;
  if (/(reply|show\s*replies|filter|options|resolve)/i.test(name) && t.length <= 48) return true;
  // Figma often names BOTH the composer hint AND the message body "Placeholder".
  // Only the instructional short string is chrome; sentence-like bodies are data.
  if (/placeholder/i.test(name)) {
    if (t.length > 72) return false;
    const words = t.trim().split(/\s+/).length;
    if (/[.!?]$/.test(t.trim()) && words >= 6) return false;
    if (/@|tag others|comment or|reply|add |write |type /i.test(t)) return true;
    if (t.length <= 40 && !/[.!?]$/.test(t.trim())) return true;
    return false;
  }
  return false;
}

export function nodeKindOf(node) {
  const d = (node && (typeof node.cssDecls === "object" ? node.cssDecls : declsToObject(node?.cssDecls))) || {};
  const keys = Object.keys(d);
  const text = textContentOf(node);
  if (text) return "text";
  if (node?.text && typeof node.text === "object") return "text";
  if (keys.some((k) => k.startsWith("font-") || k === "line-height" || k === "letter-spacing")) return "text";
  // a fill/stroke (glyph) or any box paint ⇒ visible painted element
  if (keys.some((k) => k === "fill" || k === "stroke")) return "paint";
  const boxPaint = keys.filter((k) => PAINT_PROPS.has(k) && !TEXT_PROPS.has(k));
  if (boxPaint.length) return "paint";
  // Promote obvious chrome containers that carry size/radius even when paint landed on a sibling
  // token — keeps box geometry measurable for card/panel/composer surfaces.
  if (CHROME_NAME_RE.test(String(node?.name || "")) && (d["border-radius"] != null || d.width != null || d.height != null)) {
    return "paint";
  }
  return "layout-frame";
}

// "padding:12px 16px; display:flex" | {sub: "decls"} → flat {prop: value}
function declsToObject(decls) {
  if (!decls) return {};
  if (typeof decls === "object") {
    // node cssDecls from figma-extract are already {prop: value}
    if (Object.values(decls).every((v) => typeof v === "string" && !v.includes(":"))) return decls;
    const out = {};
    for (const v of Object.values(decls)) if (typeof v === "string") for (const d of v.split(";")) {
      const i = d.indexOf(":"); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
    return out;
  }
  const out = {};
  for (const d of String(decls).split(";")) { const i = d.indexOf(":"); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim(); }
  return out;
}

// which manifest component does this block belong to? match the block's component/surface name
// against component names loosely; default to the first component (single-surface designs).
function componentFor(manifest, block) {
  const names = Object.keys(manifest.components || {});
  const hint = slug(`${block.component || ""} ${block.surface || ""} ${block.familyId || ""} ${block.id}`);
  const scored = names.map((n) => {
    const parts = slug(n.replace(/^Velt|Wireframe$/g, "")).split("-").filter(Boolean);
    let score = parts.filter((p) => hint.includes(p)).length;
    // Prefer CommentDialog for thread/dialog state blocks; CommentsSidebar for sidebar/flow/header.
    if (/commentdialog|threadcard/i.test(n) && /thread|dialog|annotation/i.test(hint)) score += 3;
    if (/commentssidebar/i.test(n) && /sidebar|header|flow|composer|page-mode/i.test(hint) && !/thread|dialog/i.test(hint)) score += 3;
    return { n, score };
  }).sort((a, b) => b.score - a.score);
  return manifest.components[scored[0]?.score ? scored[0].n : names[0]] || null;
}

const INTERACTIVE_ROLES = new Set(["trigger", "action", "item", "button"]);

// AUTO-DERIVE the inter-card gap for repeating/list surfaces — closes the "2 vs 11" blind spot. The
// NUMBER of cards varies with real data; the GAP between them is a fixed style property, so we assert the
// gap (content-independent) instead of pixel-diffing the whole list against a dummy-data design frame.
// Group boxed elements by shared left edge + width (cards line up and share a width), take the tallest
// such stack, and emit a compareGap between its first two cards. Identical whether the app shows 2 or 200.
export function deriveCardGaps(els, isRepeating) {
  if (!isRepeating) return [];
  const boxed = (els || []).filter((e) => e.box && e.box.w >= 120 && e.box.h >= 40 && e.box.y != null);
  const groups = new Map();
  for (const e of boxed) {
    const key = `${Math.round(e.box.x / 8)}:${Math.round(e.box.w / 24)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  let stack = [];
  for (const g of groups.values()) if (g.length > stack.length) stack = g;
  if (stack.length < 2) return [];
  stack.sort((a, b) => a.box.y - b.box.y);
  const [a, b] = stack;
  const gap = Math.round(b.box.y - (a.box.y + a.box.h));
  if (!Number.isFinite(gap) || gap < 0 || gap > 80) return [];
  return [{ a: a.name, b: b.name, axis: "y", expected: gap, _auto: "inter-card gap (content-independent; refine the pair if the slice mis-grouped)" }];
}

/** Extra structure contracts for comment-thread surfaces (Reply inside card, etc.). */
export function deriveThreadStructureContracts(comp, block = null) {
  const name = String(comp?.name || comp?.reactImport || "");
  const blockHint = `${block?.familyId || ""} ${block?.component || ""} ${block?.id || ""}`;
  const looksThread = /CommentDialog|ThreadCard/i.test(name)
    || /comment-thread|thread-card|comment-dialog|annotation/i.test(blockHint)
    || (comp?.contract?.parts || []).some((p) => /ThreadCard|Reply|MoreReply/i.test(p.part || ""));
  if (!looksThread) return [];
  const extras = [];
  const parts = comp?.contract?.parts || [];
  const has = (re) => parts.some((p) => re.test(p.part || ""));
  // Emit card/reply contracts whenever the surface looks like a thread — even if the Connect Map
  // host component's manifest parts omit ThreadCard (common when family name ≠ wireframe name).
  const wantCard = has(/ThreadCard/i) || looksThread;
  const wantReply = has(/Reply/i) || looksThread;
  const wantMore = has(/MoreReply/i) || /more-than-1|multiple|n-replies/i.test(blockHint);
  if (wantCard) {
    extras.push({
      part: "ThreadCard.vc",
      selector: ".vc-card, velt-comment-dialog-thread-card-wireframe, velt-comment-dialog-thread-card-internal",
      singleton: false,
      _auto: "thread-card presence (builder-class + wireframe)",
    });
  }
  if (wantReply) {
    extras.push({
      part: "Reply.insideCard",
      selector: ".vc-reply, velt-comment-dialog-thread-card-reply-wireframe, velt-comment-dialog-thread-card-reply-internal",
      requiredAncestor: ".vc-card, velt-comment-dialog-thread-card-wireframe, velt-comment-dialog-thread-card-internal",
      _auto: "Reply affordance must live inside its thread card",
    });
  }
  if (wantMore) {
    extras.push({
      part: "MoreReply.vc",
      selector: ".vc-more-reply, .velt-hidden-count, velt-comment-dialog-more-reply-wireframe",
      requiredAncestor: ".vc-card, velt-comment-dialog-body-wireframe, velt-comment-dialog-thread-card-wireframe, velt-comment-dialog-thread-card-internal",
      _auto: "collapsed multi-reply control must be mounted in the thread",
    });
  }
  return extras;
}

/** Probe selector/value sanity — catches chrome Placeholder → .vc-message + wrong color class. */
export function probeBindingProblems(brief, specNodesById = new Map()) {
  const problems = [];
  for (const el of brief?.browser?.elements || []) {
    const name = String(el.name || "");
    const sel = String(el.selector || "");
    const nodeId = el.sourceNodeId;
    const specNode = nodeId && specNodesById.has(nodeId) ? specNodesById.get(nodeId) : null;
    // Only instructional composer placeholders are poisoned by .vc-message — message bodies named
    // "Placeholder" in Figma legitimately bind to .vc-message.
    const chromePlaceholder = (specNode && isStaticChromeText(specNode))
      || (el.expectedText && /comment or tag|tag others with @/i.test(el.expectedText));
    if (chromePlaceholder && /placeholder/i.test(name) && sel && /\.vc-message\b/.test(sel) && !/composer|placeholder|input/i.test(sel)) {
      problems.push({ kind: "placeholder-misbound", element: name, selector: sel, note: "Placeholder node must not bind to .vc-message (comment body) — use composer placeholder/input selector", attribution: "plan-error(style)" });
    }
    if (specNode && el.expected) {
      const specDecls = declsToObject(specNode.cssDecls || {});
      const norm = (v) => String(v).trim().toLowerCase().replace(/\s+/g, " ").replace(/['"]/g, "");
      // Value conflicts only gate chrome poison (composer ink / labels). Beyond-plan spacing on
      // cards/data text is Builder/Judge territory, not a style-plan lint fail.
      if (isStaticChromeText(specNode)) {
        for (const [prop, val] of Object.entries(el.expected)) {
          if (specDecls[prop] != null && norm(specDecls[prop]) !== norm(val)) {
            problems.push({ kind: "probe-value-conflict", element: name, prop, probe: String(val), spec: String(specDecls[prop]), specNodeId: nodeId, attribution: "plan-error(style)" });
          }
        }
        const specText = textContentOf(specNode);
        if (el.expectedText && norm(el.expectedText) !== norm(specText)) {
          problems.push({ kind: "probe-text-conflict", element: name, probe: el.expectedText, spec: specText, specNodeId: nodeId, attribution: "plan-error(style)" });
        }
      }
    }
  }
  return problems;
}

export function scaffoldProbes(block, sliceNodes, comp, { mode = "full" } = {}) {
  const rootTag = comp?.rootWireframe || null;
  const liveSelector = block.liveSelector || rootTag || null;
  const isRepeating = /flow/i.test(block.role || "") || /comment|thread|list|feed/i.test(String(block.familyId || "") + String(block.component || ""));
  const structureOnly = mode === "structure";
  const elements = (sliceNodes || [])
    .filter((n) => {
      if (!n.cssDecls || !Object.keys(n.cssDecls).length) return false;
      // Painted root surfaces (card/panel chrome often lives on the frame itself) stay measurable.
      if (n.id === block.figmaNodeId) return nodeKindOf(n) === "paint";
      return true;
    })
    .map((n) => {
      const kind = nodeKindOf(n);
      const chromeText = isStaticChromeText(n) ? textContentOf(n) : "";
      const isRoot = n.id === block.figmaNodeId;
      return {
        name: isRoot ? (slug(n.name) || "surface") : (slug(n.name) || n.id),
        selector: null,
        // nodeKind classifies the design node so the judge/planner know what it IS live:
        //   paint  = a visible box (background/border/shadow/radius/fill) → styled + measured
        //   text   = a text run (color/font) → styled + measured
        //   layout-frame = a Figma AUTO-LAYOUT wrapper (only display/flex/gap/justify/align/padding).
        //     These do NOT survive 1:1 into the flattened live Velt DOM — several collapse onto one
        //     live element. We keep their LAYOUT intent but suppress BOX geometry (unattributable),
        //     and the judge dedupes/never-collides them. Emitting each as its own measured element
        //     with its own live selector is what produced the 49%-noise + the split regression.
        nodeKind: kind,
        _todo_selector: `live selector for '${n.name}' — post-build-STABLE only: a contract wireframe tag, a stable velt-* class, or the builder's .vc-${slug(n.name)} class; NEVER pre-build DOM the wireframe will replace`,
        ...(structureOnly ? {} : { expected: declsToObject(n.cssDecls) }),
        // Per-element visible text for static chrome (placeholder/labels) — measured by delta-compare.
        ...(!structureOnly && chromeText ? { expectedText: chromeText } : {}),
        // a layout-frame flattens live → its box is not attributable; keep box only for paint/text
        box: kind === "layout-frame" ? null : (n.box || null),
        sourceNodeId: n.id,
        ...(isRoot ? { surfaceRoot: true } : {}),
      };
    });
  const paintTextCount = elements.filter((e) => e.nodeKind === "paint" || e.nodeKind === "text").length;
  const contractEntries = [
    ...(comp?.contract?.parts || []).map((p) => ({
      part: p.part,
      selector: p.selectorHint,
      ...(p.requiredAncestorHint ? { requiredAncestor: p.requiredAncestorHint } : {}),
      ...(p.singleton ? { singleton: true } : {}),
    })),
    ...deriveThreadStructureContracts(comp, block),
  ];
  const stabilityTargets = (comp?.slots || [])
    .filter((s) => INTERACTIVE_ROLES.has(s.role))
    .map((s) => ({ name: slug(s.reactPath.split(".").pop()), selector: s.tag }));
  // FIXTURE CONTENT CONTRACT (auto-derived, no _todo): the design's own text nodes. A fixture
  // seeded with different content produces false layout diffs (a 1-line comment where the design
  // shows 2 lines shifted everything below by 18px in a live run) — measure-block verifies these
  // strings are present post-drive and says "reseed the fixture", never "fudge the layout" (R0).
  // Extractor emits text as {content, family, …} OR a bare string — accept both.
  const expectedTexts = [...new Set((sliceNodes || [])
    .filter((n) => n.id !== block.figmaNodeId && isStaticChromeText(n))
    .map((n) => textContentOf(n))
    .filter((t) => t.length > 1))];
  const autoDrive = defaultDriveFor(block, liveSelector);   // deterministic sidebar-open, or null
  return {
    blockId: block.id,
    ...(mode !== "full" ? { briefMode: mode } : {}),
    liveSelector,
    ...(liveSelector ? {} : { _todo_liveSelector: "the element that DEFINES this block, verified live" }),
    fixture: {
      expectedTexts,
      note: "seeded fixture content must SHOW these design strings (timestamps/user-variable strings may be pruned by the Planner; adding entries is better than deleting). Auto-derived from static chrome TEXT nodes (n.text.content or string).",
    },
    // Floor: ≥4 when the slice is rich; ~50% of paint/text slots, capped at 12 so large flows
    // don't force permanent INCOMPLETE while still banning the old "assert 2 and declare done".
    coverage: { paintText: paintTextCount, minAssert: paintTextCount >= 5 ? Math.min(paintTextCount, Math.max(4, Math.min(12, Math.ceil(paintTextCount * 0.5)))) : 2 },
    drive: autoDrive
      ? {
          steps: autoDrive.steps,                                              // deterministic sidebar-open OBJECTS
          assert: (block.drive && block.drive.assert) || autoDrive.assert,
          _auto_open: autoDrive._auto_open,
          ...((block.drive && block.drive.steps && block.drive.steps.length)
            ? { _hint_steps: `enumeration hints (PROSE — fold into the step objects above if useful; do NOT paste as-is): ${JSON.stringify(block.drive.steps)}` } : {}),
        }
      : {
          // NOT a sidebar auto-open — the Planner authors the drive. The value is now a machine-object
          // TEMPLATE (not the enumerate prose, which used to prime string steps); the prose hints are a
          // clearly-non-executable `_hint`. `--lint` (validateDriveSteps) rejects prose/empty for any
          // non-default surface, so a half-filled drive can't reach measure-block.
          steps: [],
          _todo_steps: `Fill with machine-executable step OBJECTS (NOT prose) to reach state '${block.state}'. Shape: [{"action":"click","selector":"<sel>"},{"action":"waitFor","selector":"<sel>"}]. Vocabulary: ${DRIVE_VERBS}. A surface that must be opened REQUIRES real steps + a drive.assert (empty = false-pass).`,
          ...((block.drive && block.drive.steps && block.drive.steps.length)
            ? { _hint_steps: `enumeration hints (PROSE — turn these into step objects, do NOT paste as-is): ${JSON.stringify(block.drive.steps)}` } : {}),
          assert: (block.drive && block.drive.assert) || null,
          ...((block.drive && block.drive.assert) ? {} : { _todo_assert: "a live selector proving the state is active (REQUIRED — a blank/default capture is the classic false-pass)" }),
        },
    browser: {
      surfaceSelector: liveSelector,
      tol: {},
      elements,
      relations: [],
      // gaps/relations/layer are STYLE-phase concerns — the structure brief certifies only that the
      // skeleton renders, adopts, and drives; the style enrichment adds the measurement rows.
      ...(structureOnly ? { gaps: [] } : {
        gaps: deriveCardGaps(elements, isRepeating),
        _todo_relations: "add the layout relations the design shows (name left-of time, message below header, …) from the connect-map layout block. The inter-card gap is AUTO-derived for list surfaces (content-independent) — verify/refine its card pair; ADD any other fixed gaps the design shows (avatar↔name, header↔body).",
      }),
    },
    ...(structureOnly
      ? { layer: [] }
      : { layer: null, _todo_layer: "LAYER_PROBE spec(s) for each painted node the design styles (ownerSelector + expectedBox + designPaint), or [] if none" }),
    contract: contractEntries.length ? { surfaceSelector: liveSelector, entries: contractEntries } : null,
    ...(structureOnly ? {
      // SLOT-ADOPTION rows (structure-phase gate): each child-bearing wireframe slot must render the
      // builder's OWN markup inside its live host — a slot that ignores its template falls back to the
      // Velt default SILENTLY. The builder/judge assert each row's ownClass appears inside hostSelector.
      adoption: (comp?.slots || [])
        .filter((s) => s.role !== "infra")
        .map((s) => ({ slot: s.reactPath, hostSelector: s.tag || null, ownClass: `.vc-${slug(s.reactPath.split(".").pop())}`, _auto: "assert ownClass renders INSIDE hostSelector post-build (adoption); prune slots the plan doesn't fill" })),
    } : {}),
    stability: { surfaceSelector: liveSelector, targets: stabilityTargets },
    scaffoldedBy: "brief-scaffold.mjs",
  };
}

// ---------------- STYLE enrichment (two-phase step 4b: --style [--from-snapshot]) ----------------
// Takes a filled STRUCTURE brief + the block's spec slice + the mechanical dom-snapshot, and adds
// the style-phase rows: per-element expected decls (VERBATIM from the slice), the auto inter-card
// gap, and the four loop1 blind-spot row classes pre-filled from the snapshot hints. The style
// planner FILLS the remaining _todos (it never authors briefs from scratch).
export function enrichBriefForStyle(brief, block, sliceNodes, snapshot, comp = null) {
  const out = { ...brief, briefMode: "style" };
  const byId = new Map((sliceNodes || []).map((n) => [n.id, n]));
  const bySlug = new Map();
  for (const n of sliceNodes || []) {
    const k = slug(n.name) || n.id;
    // Prefer the first chrome/paint match per slug; duplicates (two "Placeholder" layers) must use sourceNodeId.
    if (!bySlug.has(k)) bySlug.set(k, n);
  }
  const isRepeating = /flow/i.test(block.role || "") || /comment|thread|list|feed/i.test(String(block.familyId || "") + String(block.component || ""));
  for (const el of out.browser?.elements || []) {
    const n = (el.sourceNodeId && byId.get(el.sourceNodeId)) || bySlug.get(el.name) || null;
    if (n && !el.expected) el.expected = declsToObject(n.cssDecls);
    // (re)classify + suppress layout-frame geometry (idempotent with scaffoldProbes)
    if (n) el.nodeKind = nodeKindOf(n);
    if (el.nodeKind === "layout-frame") el.box = null;
    else if (n?.box && !el.box) el.box = n.box;
    if (n && isStaticChromeText(n)) {
      // Chrome strings + their typography must stay VERBATIM from the cited spec node
      // (fixes Placeholder→.vc-message poison where expected.color was overwritten to body ink).
      el.expected = declsToObject(n.cssDecls);
      el.expectedText = textContentOf(n);
    } else if (n && /placeholder/i.test(String(el.name || ""))) {
      // Message bodies also named "Placeholder" in Figma — heal any prior chrome overwrite.
      el.expected = declsToObject(n.cssDecls);
      delete el.expectedText;
    } else if (n && el.expectedText && !isStaticChromeText(n)) {
      delete el.expectedText;
    }
  }
  // Ensure painted root surfaces exist as measurable elements (card/panel chrome on the frame).
  const root = (sliceNodes || []).find((n) => n.id === block.figmaNodeId);
  if (root && nodeKindOf(root) === "paint") {
    const els = out.browser?.elements || [];
    if (!els.some((e) => e.sourceNodeId === root.id || e.surfaceRoot)) {
      els.unshift({
        name: slug(root.name) || "surface",
        selector: out.browser?.surfaceSelector || null,
        nodeKind: "paint",
        expected: declsToObject(root.cssDecls),
        box: root.box || null,
        sourceNodeId: root.id,
        surfaceRoot: true,
      });
      out.browser.elements = els;
    }
  }
  const paintTextCount = (out.browser?.elements || []).filter((e) => e.nodeKind === "paint" || e.nodeKind === "text").length;
  out.coverage = {
    paintText: paintTextCount,
    minAssert: paintTextCount >= 5 ? Math.min(paintTextCount, Math.max(4, Math.min(12, Math.ceil(paintTextCount * 0.5)))) : 2,
  };
  // Rebuild chrome expectedTexts from the slice (drop stale data strings from older scaffolds).
  const chromeTexts = [...new Set((sliceNodes || []).filter(isStaticChromeText).map(textContentOf).filter((t) => t.length > 1))];
  out.fixture = out.fixture || {};
  out.fixture.expectedTexts = chromeTexts;
  // Merge auto thread structure contracts (Reply inside card, etc.) without dropping planner entries.
  if (comp) {
    const extras = deriveThreadStructureContracts(comp, block);
    if (extras.length) {
      const entries = [...(out.contract?.entries || [])];
      const have = new Set(entries.map((e) => e.part));
      for (const e of extras) if (!have.has(e.part)) entries.push(e);
      out.contract = { ...(out.contract || {}), surfaceSelector: out.contract?.surfaceSelector || out.liveSelector || null, entries };
    }
  }
  if (out.browser) {
    if (!(out.browser.gaps || []).length) out.browser.gaps = deriveCardGaps(out.browser.elements, isRepeating);
    if (!out.browser.relations?.length && out.browser._todo_relations == null) {
      out.browser._todo_relations = "add the layout relations the design shows (from the structure plan's layout block) + any fixed gaps beyond the auto inter-card gap";
    }
  }
  if (!Array.isArray(out.layer) || !out.layer.length) {
    out.layer = out.layer || [];
    out._todo_layer = "LAYER_PROBE spec(s) for each painted node the design styles (ownerSelector + expectedBox + designPaint), or [] if none";
  }
  // snapshot-derived rows — the loop1 miss classes, pre-filled mechanically:
  const hints = snapshot?.hints || null;
  out.styleRows = {
    // (a) Velt wrappers/internals BETWEEN own-markup elements that paint a box the design never drew
    //     → the style planner decides: neutralize (zero the box props) or adopt (design wants it).
    wrapperRows: (hints?.unstyledVeltInternals || []).map((w) => ({
      selector: w.selector, snapshotPaints: w.paints, box: w.box, disposition: null,
      _todo_disposition: "neutralize-wrapper (zero the painted box props) OR style (cite the designSpec node that draws this box) — from the snapshot, never guessed",
    })),
    // (b) suppression rows — default glyphs/paints that must NOT render (overlap scan feeds these)
    suppressionRows: (hints?.overlaps || []).map((o) => ({
      a: o.a, b: o.b, overlap: o.overlap, expectedCount: 1,
      _todo_keep: "which of a/b is the DESIGN's glyph (cite the exported SVG); the other gets a suppress-default rule (paint none / display suppressed)",
    })),
    // (b2) DEFAULT-SPACING rows (loop2 root cause — the compounded message indent): every
    //     SDK-internal element carrying non-zero default spacing is a live layout input; the plan
    //     must DISPOSITION each (zero it, or adopt it as the design's own offset). Un-dispositioned
    //     defaults compound under planned design values.
    spacingRows: (hints?.defaultSpacing || []).map((s) => ({
      selector: s.selector, snapshotSpacing: s.spacing, box: s.box, disposition: null,
      _todo_disposition: "zero (the design owns this offset elsewhere — emit a neutralize rule resetting these spacing props) OR adopt (this default IS the design's offset — cite the designSpec node and account for it in the planned value)",
    })),
    // (c) clip-visibility rows — asserted decorations (hairlines/shadows) must be INSIDE the visible
    //     clip region; the planner names each decoration the design draws at a surface edge.
    clipRows: [],
    _todo_clipRows: "one row per design decoration at a clip-risk edge (hairline borders, card shadows): { selector, decoration, mustBeVisibleWithin: <scroll/clip container selector> } — or [] if none",
    // (d) focus/outline rows — the focus state is driven with a real keyboard, then asserted.
    focusRows: [],
    _todo_focusRows: "one row per focusable input/affordance: { selector, state:'focus', expected:{outline/box-shadow/border decls VERBATIM from the spec node (cite id) — or the explicit suppression 'outline: none' if the design draws no focus ring} } — or [] if none",
    ...(snapshot && snapshot.stateUnreachable ? { stateUnreachable: true, note: "snapshot could not drive this state — tag every rule for it unknown→verify; the judge treats them unverified, never passed" } : {}),
    ...(snapshot ? {} : { _noSnapshot: "no dom-snapshot for this block — wrapper/suppression rows could not be pre-filled; the style planner must read the snapshot dir or tag rules unknown→verify" }),
  };
  return out;
}

// ---- style-plan authorship / thinness (lint-style + golden calibration) ----
// A verified failure class: the style planner wedged → orchestrator wrote a deterministic
// "spec-join" plan-style.json with a thin rule set and proceeded. That cannot produce a
// golden-class demo. Fail closed: refuse deterministic/assumed authorship; require a floor
// of rules relative to block count.
export function stylePlanAuthorshipProblems(planStyle, blocksDoc = null) {
  const problems = [];
  if (!planStyle) { problems.push({ kind: "missing", note: "plan-style.json missing" }); return problems; }
  const gen = String(planStyle.generatedBy || planStyle.authorship || "");
  if (/deterministic|spec-join|assume|fallback|dead-planner|orchestrator deterministic/i.test(gen)) {
    problems.push({
      kind: "thin-authorship",
      note: `generatedBy/authorship is a dead-planner fallback (${gen.slice(0, 80)}) — re-dispatch velt-planner-style; do NOT ship a deterministic join as the style plan`,
    });
  }
  if (planStyle.assumedFills || planStyle.assumed === true || planStyle.authorship === "assumed") {
    problems.push({ kind: "assumed", note: "style plan marked assumed — HALT and re-plan style; --assume-remaining is forbidden for --stage style" });
  }
  const rules = planStyle.rules || [];
  const blockN = (blocksDoc?.blocks || []).length || 0;
  const minRules = Math.max(12, blockN * 3);
  if (rules.length && rules.length < minRules) {
    problems.push({
      kind: "thin-rules",
      note: `only ${rules.length} style rule(s); need ≥${minRules} for ${blockN || "?"} block(s) — style planner under-shipped`,
    });
  }
  return problems;
}

// ---- style-plan selector validation (lint-style + golden calibration) ----
// Every selector in plan-style.json must be REAL — its class/tag tokens must exist in a dom-snapshot.
// A guessed selector binds to nothing and fails SILENTLY (half of a verified run's defects). Pseudo
// classes/elements and attribute selectors are stripped before the token check (state rules are fine).
export function selectorTokensExist(selector, corpus /* {classes:Set, tags:Set} */) {
  const missing = [];
  const cleaned = String(selector)
    .replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, " ")   // pseudo-classes/elements incl. :not(...)
    .replace(/\[[^\]]*\]/g, " ");                  // attribute selectors
  for (const m of cleaned.matchAll(/\.([A-Za-z_][\w-]*)/g)) if (!corpus.classes.has(m[1])) missing.push(`.${m[1]}`);
  for (const m of cleaned.matchAll(/(?:^|[\s>+~,(])([a-zA-Z][\w-]*)/g)) {
    const tag = m[1].toLowerCase();
    if (/^(html|body|div|span|svg|img|button|input|textarea|a|p|ul|li|header|footer|section)$/.test(tag)) continue;
    if (!corpus.tags.has(tag)) missing.push(tag);
  }
  return missing;
}
// ---- style coverage (the unstyled-base completeness gate) ----
// On the unstyled base WE own every visible pixel: any visible element that carries text or paint
// and is claimed by NO plan rule (self or ancestor) renders as raw browser chrome — the v3 failure
// class (raw composer strip, unclipped avatar innards). Mechanical check: every such element must
// match a rule's rightmost simple selector (or an ancestor must), or be excused by an explicit
// plan-style `defaultOk: [{selector, reason}]` row. "Looks covered in prose" is not coverage.
export function styleCoverageGaps(rules, snapshots, defaultOk = []) {
  const parseSimple = (sel) => {
    const cleaned = String(sel).replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, "").replace(/\[[^\]]*\]/g, "").trim();
    const tag = (cleaned.match(/^[a-zA-Z][\w-]*/) || [null])[0];
    const classes = [...cleaned.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
    return (tag || classes.length) ? { tag: tag ? tag.toLowerCase() : null, classes } : null;
  };
  const rightmost = (selector) => String(selector).split(",").map((alt) => {
    const parts = alt.trim().replace(/\s*>\s*/g, " ").split(/\s+/).filter(Boolean);
    return parseSimple(parts[parts.length - 1] || "");
  }).filter(Boolean);
  const claims = (rules || []).flatMap((r) => rightmost(r.selector || ""));
  const excuses = (defaultOk || []).flatMap((d) => rightmost(d.selector || ""));
  const nodeMatches = (n, s) => (!s.tag || s.tag === n.tag) && s.classes.every((c) => (n.classes || []).includes(c));
  const gaps = [], seen = new Set();
  const visit = (n, covered) => {
    const self = claims.some((s) => nodeMatches(n, s)) || excuses.some((s) => nodeMatches(n, s));
    const nowCovered = covered || self;
    const visible = n.visible !== false && n.box && n.box.w > 4 && n.box.h > 4;
    const painted = n.paints && Object.keys(n.paints).length > 0;
    // PAINT DOES NOT INHERIT: a painted element needs a DIRECT claim (an ancestor's layout rule
    // doesn't touch its raw border/background). TEXT inherits typography, so ancestor claims count.
    const uncovered = painted ? !self : (n.text ? !nowCovered : false);
    if (visible && uncovered) {
      const key = `${n.tag}${(n.classes || []).length ? "." + n.classes.slice(0, 2).join(".") : ""}`;
      if (!seen.has(key)) { seen.add(key); gaps.push({ selector: key, hasText: !!n.text, paints: n.paints || {} }); }
    }
    for (const c of n.children || []) visit(c, nowCovered);
  };
  for (const s of snapshots || []) if (s.tree) visit(s.tree, false);
  return gaps;
}

// ---- structure fingerprint (the stale-style-plan gate) ----
// A style plan is only valid against the exact rendered STRUCTURE it was planned on (the two-phase
// premise). This hashes the snapshots' structural shape — tags + classes + hierarchy, NOTHING
// paint- or box-derived — so applying CSS does NOT change it, but any markup regroup/add/move DOES.
// apply-plan-fills embeds it into plan-style.json; --lint-style verifies it before the style build
// (and before any later style patching). Mismatch = "structure changed → re-run plan-style".
// Transient state classes (--selected/--hover/…) are stripped: the same drive can leave a card
// selected or not between captures without that being a structure change.
export function structureFingerprint(snapshots) {
  const shape = (n) => {
    // consecutive SAME-SHAPE siblings collapse to one: repeated data (another comment card posted
    // during verification) is NOT a structure change and must not invalidate the style plan.
    const kids = (n.children || []).map(shape);
    const dedup = kids.filter((k, i) => k !== kids[i - 1]);
    return `${n.tag || "?"}[${(n.classes || []).filter((c) => !/--(selected|hover|active|open|focused)\b/.test(c)).sort().join(".")}]` +
      `(${dedup.join(",")})`;
  };
  const perBlock = snapshots
    .filter((s) => s.tree)
    .sort((a, b) => String(a.blockId).localeCompare(String(b.blockId)))
    .map((s) => `${s.blockId}:${shape(s.tree)}`)
    .join("\n");
  return createHash("sha1").update(perBlock).digest("hex");
}

export function snapshotCorpus(snapshots) {
  const classes = new Set(), tags = new Set();
  const walk = (n) => { if (!n) return; tags.add(n.tag); for (const c of n.classes || []) classes.add(c); for (const ch of n.children || []) walk(ch); };
  for (const s of snapshots) walk(s.tree);
  return { classes, tags };
}

// ---- structure-plan completeness (lint-structure + golden calibration) ----
// The plan-structure trial vs the golden demo found the one recurring gap class: leaves planned
// without their CONTAINER CHAIN. Containers drop undeclared children and list/repeater containers
// route the item template — a missing List/Threads container means the template silently never
// adopts, discovered only at build time. The manifest knows the chain two ways: dotted-path
// ancestors that are themselves slots, and contract parts' requiredAncestorHint tags. Enforce both
// mechanically, plus slot-name hygiene (own markup belongs in vcClasses, never in slot rows).
export function planStructureProblems(plan, manifest) {
  const problems = [];
  const comps = manifest.components || {};
  const manifestPaths = new Map();   // reactPath -> slot
  const tagToPath = new Map();       // wireframe tag -> reactPath
  const rootNames = new Set();
  const rootTagToName = new Map();
  for (const [name, c] of Object.entries(comps)) {
    rootNames.add(name);
    if (c.rootWireframe) rootTagToPath(c.rootWireframe, name);
    for (const s of c.slots || []) {
      manifestPaths.set(s.reactPath, s);
      if (s.tag) tagToPath.set(s.tag, s.reactPath);
    }
  }
  function rootTagToPath(tag, name) { tagToPath.set(tag, name); rootTagToName.set(tag, name); }

  // collect the plan's slot paths (normalize: strip parenthetical prose, resolve bare sub-paths)
  const planPaths = new Set();
  const rows = [];
  for (const comp of plan.components || []) {
    const wf = (comp.veltComponents || {}).wireframe || "";
    if (wf) planPaths.add(wf);
    for (const s of comp.slots || []) {
      if (/NOT USED/i.test(String(s.fillWith || ""))) continue;
      const raw = String(s.slot || "");
      const cleaned = raw.replace(/\s*\(.*\)\s*/g, "").replace(/\s*→.*$/, "").trim();
      const full = cleaned.startsWith("Velt") ? cleaned : (wf && cleaned ? `${wf}.${cleaned}` : cleaned);
      rows.push({ raw, full, comp: comp.id });
      planPaths.add(full);
    }
  }
  for (const r of rows) {
    // hygiene: every slot row must be a REAL manifest identifier (own markup → vcClasses)
    if (!manifestPaths.has(r.full) && !rootNames.has(r.full)) {
      problems.push({ kind: "not-a-slot", slot: r.raw, note: "not a manifest reactPath/component — own-markup elements belong in vcClasses, never in slot rows (R10 hygiene)" });
      continue;
    }
    // container chain (dotted ancestors that are manifest slots must be planned)
    const parts = r.full.split(".");
    for (let i = parts.length - 1; i >= 2; i--) {
      const anc = parts.slice(0, i).join(".");
      if (manifestPaths.has(anc) && !planPaths.has(anc)) {
        problems.push({ kind: "missing-container", slot: r.full, missing: anc, note: "containers drop undeclared children — declare the full chain" });
      }
    }
    // render-tree ancestors from the contract (requiredAncestorHint tag → slot path)
    const compEntry = Object.values(comps).find((c) => (c.slots || []).some((s) => s.reactPath === r.full));
    const leafName = parts[parts.length - 1];
    for (const p of (compEntry?.contract?.parts) || []) {
      if (p.part !== leafName || !p.requiredAncestorHint) continue;
      const ancPath = tagToPath.get(p.requiredAncestorHint);
      if (ancPath && !planPaths.has(ancPath)) {
        problems.push({ kind: "missing-container", slot: r.full, missing: ancPath, note: `contract requires ancestor ${p.requiredAncestorHint} — declare its slot in the plan` });
      }
    }
  }
  // Structure-producing host props: if the plan maps MoreReply / Show-N, collapsed* must be listed
  const planBlob = JSON.stringify(plan || {});
  const needsCollapsed = /MoreReply|Show\s*\d+\s*replies|collapsedRepliesPreview|collapsedComments/i.test(planBlob);
  if (needsCollapsed) {
    const allHp = (plan.components || []).flatMap((c) => (c.hostProps || []).map((h) => h.prop));
    for (const need of ["collapsedComments", "collapsedRepliesPreview"]) {
      if (!allHp.includes(need)) {
        problems.push({
          kind: "missing-host-prop",
          slot: need,
          note: "design/plan references collapsed Show-N / MoreReply structure — list collapsedComments + collapsedRepliesPreview on the VeltComments hostProps (R21); CSS cannot fake this",
        });
      }
    }
  }

  // dedupe
  const seen = new Set();
  return problems.filter((p) => { const k = JSON.stringify(p); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---- plan-vs-spec value conflict (lint-style + golden calibration) ----
// The HARD RULE of two-phase planning: a style rule's decls come VERBATIM from its cited spec node.
// A verified failure class: a plan paraphrased the composer bg as #f1efec where the spec node says
// background:#ffffff + a #f1efec border — the builder faithfully built the wrong thing. So: for any
// rule citing a specNodeId with purpose style/state-rule, a prop present in BOTH the rule and the
// spec node with a DIFFERENT value is a plan-error(style) — caught at lint time, not judge time.
// (Props the rule adds that the spec node doesn't carry are fine — composition; only conflicts fail.)
export function planSpecValueConflicts(rule, specNode) {
  if (!rule || !specNode || !["style", "state-rule", undefined].includes(rule.purpose)) return [];
  const norm = (v) => String(v).trim().toLowerCase().replace(/\s+/g, " ").replace(/['"]/g, "");
  const specDecls = declsToObject(specNode.cssDecls || {});
  const conflicts = [];
  for (const [prop, val] of Object.entries(rule.decls || {})) {
    if (specDecls[prop] != null && norm(specDecls[prop]) !== norm(val)) {
      conflicts.push({ prop, plan: String(val), spec: String(specDecls[prop]), specNodeId: rule.specNodeId, attribution: "plan-error(style)" });
    }
  }
  return conflicts;
}

export function scaffoldSmoke(family) {
  const step = (name, todo) => ({ name, actions: [], _todo_actions: todo, assert: null });
  return {
    familyId: family.id,
    steps: [
      step("short-message", "type a SHORT message (1-2 words) end-to-end and assert it posts — a full-width fixture masked a flex-end bug in the baseline run"),
      step("max-length-message", "type a MAX-LENGTH message; assert growth/scroll behavior and no dead band (never pin min-height to a multi-line fixture)"),
      step("every-dialog-context", "exercise this family's surface in EVERY dialog context it appears in (sidebar card / popover open-dialog / hover preview) — shared classes leak across contexts"),
      step("affordances-once", "click every affordance once (reply, resolve, edit, options) asserting the outcome fires and nothing shifts"),
    ],
    resize: { width: 1100, height: 800, assert: null, _todo_assert: "selector that must stay visible/laid-out after resize" },
    forbidConsoleErrors: true,
    scaffoldedBy: "brief-scaffold.mjs",
  };
}

function findTodos(obj, trail = "", out = []) {
  if (Array.isArray(obj)) obj.forEach((v, i) => findTodos(v, `${trail}[${i}]`, out));
  else if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("_todo")) out.push(`${trail}.${k}`);
    else findTodos(v, trail ? `${trail}.${k}` : k, out);
  }
  return out;
}

async function main() {
  const [phaseDir, ...rest] = process.argv.slice(2);
  if (!phaseDir) { console.error("usage: brief-scaffold.mjs <phaseDir> [--structure|--style [--from-snapshot d]] [--connect-map f] [--manifest f] [--lint|--lint-structure|--lint-style]"); process.exit(1); }
  const flag = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  const briefsDir = path.join(phaseDir, "briefs");
  const blocks = await loadJson(path.join(phaseDir, "blocks.json"));

  // --lint-style: the standard lint PLUS the plan-style.json selector-reality check against the
  // dom-snapshot corpus (a selector whose class/tag tokens exist in no snapshot = a guessed
  // selector that binds to nothing — HALT before the style build, never a silent no-op).
  if (rest.includes("--lint-style")) {
    let bad = 0;
    const planStyle = await loadJson(path.join(phaseDir, "plan-style.json")).catch(() => null);
    const snapDir = path.join(phaseDir, "dom-snapshot");
    const snaps = [];
    for (const f of await fs.readdir(snapDir).catch(() => [])) {
      if (f.endsWith(".json")) { const s = await loadJson(path.join(snapDir, f)).catch(() => null); if (s && s.tree) snaps.push(s); }
    }
    if (!planStyle) { console.log("✗ plan-style.json missing — the style planner must emit it before the style build"); bad++; }
    else if (!snaps.length) { console.log("✗ no dom-snapshot/*.json with a tree — run dom-snapshot.mjs after the structure build"); bad++; }
    else {
      const blocksDoc = await loadJson(path.join(phaseDir, "blocks.json")).catch(() => null);
      for (const p of stylePlanAuthorshipProblems(planStyle, blocksDoc)) {
        console.log(`✗ plan-style authorship: ${p.note}`);
        bad++;
      }
      const corpus = snapshotCorpus(snaps);
      const rules = planStyle.rules || [];
      if (!rules.length) { console.log("✗ plan-style.json has 0 rules — an empty style plan is the silent no-op failure class; HALT"); bad++; }
      const spec = await loadJson(path.join(phaseDir, "designSpec.json")).catch(() => null);
      const specById = new Map((spec?.nodes || []).map((n) => [n.id, n]));
      for (const [i, r] of rules.entries()) {
        if (!r.selector) { console.log(`✗ plan-style rules[${i}]: no selector`); bad++; continue; }
        const missing = selectorTokensExist(r.selector, corpus);
        if (missing.length && !r.stateUnreachable) { console.log(`✗ plan-style rules[${i}] '${r.selector}': token(s) not in any dom-snapshot: ${missing.join(", ")} — selectors come FROM the snapshot, never guessed`); bad++; }
        if (!r.decls || !Object.keys(r.decls).length) { console.log(`✗ plan-style rules[${i}] '${r.selector}': no decls`); bad++; }
        // VERBATIM-value check: decls must match the cited spec node (the paraphrase failure class)
        if (r.specNodeId && specById.has(r.specNodeId)) {
          for (const c of planSpecValueConflicts(r, specById.get(r.specNodeId))) {
            console.log(`✗ plan-style rules[${i}] '${r.selector}': ${c.prop} = '${c.plan}' CONFLICTS with spec node ${c.specNodeId} ('${c.spec}') — decls are VERBATIM from the spec [${c.attribution}]`); bad++;
          }
        }
      }
      // COVERAGE GATE (unstyled base = we own every visible pixel): a visible text/painted element
      // claimed by NO rule renders raw (the v3 composer-strip class). Gaps must be ruled or excused
      // via plan-style `defaultOk: [{selector, reason}]` — explicitly, never silently.
      const covGaps = styleCoverageGaps(rules, snaps, planStyle.defaultOk || []);
      for (const g of covGaps.slice(0, 15)) { console.log(`✗ style-coverage: visible ${g.hasText ? "TEXT" : "painted"} element '${g.selector}' is claimed by NO rule (and not defaultOk) — renders RAW on the unstyled base`); bad++; }
      if (covGaps.length > 15) { console.log(`✗ style-coverage: … and ${covGaps.length - 15} more uncovered element(s)`); }
      // STALE-PLAN GATE: the plan must have been made against THIS rendered structure. A structure
      // change after plan-style (the fix-pass failure class, seen live loop2) invalidates every
      // selector/placement decision in it — patching onto a stale plan is what turns "fixed" into
      // "worse". The fingerprint ignores boxes/paints (applying CSS must NOT invalidate the plan).
      const nowFp = structureFingerprint(snaps);
      if (!planStyle.structureFingerprint) console.log(`⚠ plan-style.json carries no structureFingerprint (written before this gate existed) — cannot verify the plan matches the current structure`);
      else if (planStyle.structureFingerprint !== nowFp) { console.log(`✗ STRUCTURE CHANGED since plan-style was made (fingerprint ${planStyle.structureFingerprint.slice(0, 12)}… → ${nowFp.slice(0, 12)}…) — the style plan is STALE. Re-run dom-snapshot + plan-style; do NOT patch styles onto the old plan`); bad++; }
      if (!bad) console.log(`✓ plan-style.json: ${rules.length} rule(s), every selector token present in the dom-snapshot corpus, no plan-vs-spec value conflicts${planStyle.structureFingerprint ? ", structure fingerprint matches" : ""}`);
    }
    // Probe binding sanity (Placeholder → .vc-message, probe value ≠ designSpec)
    {
      const spec = await loadJson(path.join(phaseDir, "designSpec.json")).catch(() => null);
      const specById = new Map((spec?.nodes || []).map((n) => [n.id, n]));
      for (const f of await fs.readdir(briefsDir).catch(() => [])) {
        if (!f.endsWith(".probes.json")) continue;
        const brief = await loadJson(path.join(briefsDir, f)).catch(() => null);
        if (!brief?.browser?.elements) continue;
        for (const p of probeBindingProblems(brief, specById)) {
          console.log(`✗ probe-binding ${f}: ${p.kind} '${p.element}'${p.selector ? ` → ${p.selector}` : ""}${p.prop ? ` ${p.prop}: probe='${p.probe}' spec='${p.spec}'` : ""} — ${p.note || p.attribution}`);
          bad++;
        }
      }
    }
    // then fall through to the standard brief lint below (todos + drive)
    rest.push("--lint");
    obsEvent(phaseDir, { type: "lint", src: "brief-scaffold", stage: "plan-style", ok: !bad, summary: bad ? `lint-style FAILED: ${bad} style-plan problem(s) (guessed selector / value conflict / empty plan / probe bind)` : `lint-style: plan-style.json selectors snapshot-real, values spec-verbatim, probes sane` });
    if (bad) { console.log(`✗ ${bad} style-plan problem(s) — the style build cannot start`); process.exit(2); }
  }
  if (rest.includes("--lint-structure")) {
    // structure-plan completeness: container chains + slot-name hygiene (mechanical; see
    // planStructureProblems). A leaf without its container chain silently fails to adopt at
    // build time — fail HERE, sub-second, with the missing container named.
    const planStructure = await loadJson(path.join(phaseDir, "plan-structure.json")).catch(() => null);
    if (planStructure) {
      const manifest = await loadJson(path.resolve(flag("--manifest", path.join(PLUGIN_ROOT, "manifest", "velt-codeconnect.json"))));
      const probs = planStructureProblems(planStructure, manifest);
      for (const p of probs) console.log(`✗ plan-structure ${p.kind}: '${p.slot}'${p.missing ? ` → missing '${p.missing}'` : ""} — ${p.note}`);
      obsEvent(phaseDir, { type: "lint", src: "brief-scaffold", stage: "plan-structure", ok: !probs.length, summary: probs.length ? `lint-structure FAILED: ${probs.length} plan problem(s) (missing containers / non-slot rows)` : "lint-structure: container chains complete, slot names real" });
      if (probs.length) { console.log(`✗ ${probs.length} structure-plan problem(s) — the structure build cannot start`); process.exit(2); }
      console.log(`✓ plan-structure.json: container chains complete, every slot row a real manifest identifier`);
    }
    rest.push("--lint");   // structure briefs carry no style rows; the standard brief lint completes the gate
  }

  // --style enrichment: add style rows to the existing (structure) briefs, pre-filled from the
  // spec slices + dom-snapshot hints. Never scaffolds from scratch — structure briefs must exist.
  if (rest.includes("--style") && !rest.includes("--lint")) {
    const snapDir = flag("--from-snapshot", path.join(phaseDir, "dom-snapshot"));
    const force = rest.includes("--force") || rest.includes("--refresh-assertions");
    const manifest = await loadJson(path.resolve(flag("--manifest", path.join(PLUGIN_ROOT, "manifest", "velt-codeconnect.json")))).catch(() => null);
    let enriched = 0, missingSnaps = 0;
    for (const b of blocks.blocks || []) {
      const p = path.join(briefsDir, `${b.id}.probes.json`);
      const brief = await loadJson(p).catch(() => null);
      if (!brief) { console.error(`✗ ${b.id}: no structure brief to enrich — run --structure scaffolding + the structure plan first`); process.exit(2); }
      if (brief.briefMode === "style" && !force) { console.log(`· ${b.id}: already style-enriched (kept; pass --force to refresh coverage/expectedTexts)`); continue; }
      const slice = await loadJson(path.join(briefsDir, `${b.id}.spec.json`)).catch(() => ({ nodes: [] }));
      const snap = await loadJson(path.join(snapDir, `${b.id}.json`)).catch(() => null);
      if (!snap) missingSnaps++;
      const comp = manifest ? componentFor(manifest, b) : null;
      await fs.writeFile(p, JSON.stringify(enrichBriefForStyle(brief, b, slice.nodes, snap, comp), null, 2));
      enriched++;
    }
    console.log(`✓ style-enriched ${enriched} brief(s)${missingSnaps ? ` (⚠ ${missingSnaps} without a dom-snapshot — their wrapper/suppression rows are unfilled)` : ""} — the style planner fills the remaining _todos, then '--lint-style' gates the style build`);
    return;
  }

  if (rest.includes("--lint")) {
    let dirty = 0, checked = 0;
    for (const b of blocks.blocks || []) {
      const p = path.join(briefsDir, `${b.id}.probes.json`);
      if (!(await exists(p))) { console.log(`✗ ${b.id}: probes.json MISSING`); dirty++; continue; }
      const brief = await loadJson(p); checked++;
      const todos = findTodos(brief);
      if (todos.length) { console.log(`✗ ${b.id}: ${todos.length} unfilled _todo field(s): ${todos.slice(0, 4).join(", ")}${todos.length > 4 ? ", …" : ""}`); dirty++; }
      // DRIVE STEPS must be MACHINE-EXECUTABLE step objects (not prose) — the sub-second pre-loop gate
      // that replaces the ~35-min per-block runtime discovery ("unknown drive action 'undefined'").
      // Surfaces that must be opened (flow / sidebar / dialog) ALSO require a non-empty drive + assert:
      // an empty drive that self-certifies is the empty-surface false-pass this whole fix closes.
      const mustOpen = b.role === "flow" || /sidebar|comments-sidebar|dialog|panel|thread|comment-list|feed/i.test(`${b.component || ""} ${b.surface || ""} ${b.state || ""} ${b.familyId || ""}`);
      const driveProblems = validateDriveSteps(brief.drive, { requireSteps: mustOpen, label: `${b.id} drive` });
      if (driveProblems.length) { console.log(`✗ ${b.id}: ${driveProblems.length} drive problem(s): ${driveProblems.slice(0, 3).join(" · ")}${driveProblems.length > 3 ? " · …" : ""}`); dirty++; }
    }
    for (const f of blocks.families || []) {
      const p = path.join(briefsDir, `${f.id}.smoke.json`);
      if (!(await exists(p))) { console.log(`✗ family ${f.id}: smoke.json MISSING`); dirty++; continue; }
      const todos = findTodos(await loadJson(p));
      if (todos.length) { console.log(`✗ family ${f.id}: ${todos.length} unfilled _todo field(s)`); dirty++; }
    }
    // CROSS-FRAME EXPECTATION CONFLICTS (OBS-R2-1) — same selector, different expected values
    // across blocks. Often legitimate (states differ!), but the Builder must know which value is
    // the shared wireframe base; discovered late this costs a measure iteration. WARNINGS only —
    // they never change the exit code; the Planner resolves intentionally (state-scope the
    // selector or confirm the divergence).
    const bySel = new Map();
    for (const b of blocks.blocks || []) {
      const brief = await loadJson(path.join(briefsDir, `${b.id}.probes.json`)).catch(() => null);
      for (const el of brief?.browser?.elements || []) {
        if (!el.selector) continue;
        const rec = bySel.get(el.selector) || [];
        rec.push({ block: b.id, expected: el.expected || {} });
        bySel.set(el.selector, rec);
      }
    }
    let conflicts = 0;
    for (const [sel, recs] of bySel) {
      if (recs.length < 2) continue;
      const props = new Map();
      for (const r of recs) for (const [prop, val] of Object.entries(r.expected)) {
        const m = props.get(prop) || new Map();
        (m.get(String(val)) || m.set(String(val), []).get(String(val))).push(r.block);
        props.set(prop, m);
      }
      for (const [prop, vals] of props) if (vals.size > 1) {
        conflicts++;
        console.log(`⚠ cross-frame conflict: '${sel}' expects ${prop} = ${[...vals.entries()].map(([v, ids]) => `${v} [${ids.join(", ")}]`).join("  vs  ")}`);
      }
    }
    if (conflicts) console.log(`⚠ ${conflicts} cross-frame expectation conflict(s) — resolve intentionally (state-scope the selector or confirm the divergence); left ambiguous they surface as measure iterations`);
    console.log(dirty ? `✗ ${dirty} brief(s) incomplete — the Planner must fill every _todo before the build loop starts` : `✓ all briefs complete (${checked} blocks + ${(blocks.families || []).length} families, zero _todo leftovers)`);
    process.exit(dirty ? 2 : 0);
  }

  const manifest = await loadJson(path.resolve(flag("--manifest", path.join(PLUGIN_ROOT, "manifest", "velt-codeconnect.json"))));
  const mode = rest.includes("--structure") ? "structure" : "full";
  await fs.mkdir(briefsDir, { recursive: true });
  let made = 0, kept = 0;
  for (const b of blocks.blocks || []) {
    const p = path.join(briefsDir, `${b.id}.probes.json`);
    if (await exists(p)) { kept++; continue; }   // never clobber the Planner's filled work
    const slicePath = path.join(briefsDir, `${b.id}.spec.json`);
    let slice = { nodes: [] };
    if (await exists(slicePath)) {
      try { slice = await loadJson(slicePath); }
      catch { console.error(`⚠ ${b.id}: slice unreadable/truncated — scaffolding with 0 elements (re-run spec-slice.mjs for this block)`); }
    } else console.error(`⚠ ${b.id}: no spec slice found — scaffolding with 0 elements (run spec-slice.mjs first)`);
    const comp = componentFor(manifest, b);
    await fs.writeFile(p, JSON.stringify(scaffoldProbes(b, slice.nodes, comp, { mode }), null, 2));
    made++;
  }
  for (const f of blocks.families || []) {
    const p = path.join(briefsDir, `${f.id}.smoke.json`);
    if (await exists(p)) { kept++; continue; }
    await fs.writeFile(p, JSON.stringify(scaffoldSmoke(f), null, 2));
    made++;
  }
  console.log(`✓ scaffolded ${made} brief(s) (${kept} existing kept) → ${path.relative(process.cwd(), briefsDir)}`);
  console.log(`  The Planner now FILLS the _todo fields only (drive steps, selectors, relations, smoke actions) — then 'brief-scaffold.mjs ${phaseDir} --lint' must pass before the build loop.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

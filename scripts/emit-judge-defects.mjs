#!/usr/bin/env node
// emit-judge-defects.mjs — mechanical Judge work-order assembler.
//
// FORWARDING ENGINE, NOT A DERIVATION ENGINE (fix F1, 2026-07-24 forensic):
// the Judge's vision record (appearance/*.json glance rows) is the SOURCE OF TRUTH for
// composed P0s. Audit visual-diff regions are only (a) CONFIRM evidence attached to a named
// miss they overlap, or (b) P1 `unnamed-region` rows — never P0. Provenance is carried
// honestly per row (`source`), never templated. Emit REFUSES to run when the vision record
// predates the current live capture (force a re-glance instead of emitting stale truth).
//
// Reads results/<block>/delta.json (+ contract/smoke) and emits judge-defects.json where EVERY
// measured FAIL is either:
//   - builder-error (actionable),
//   - plan-error(structure|style) (planner ticket — routed, never dropped),
//   - noise (explicit ledger with reason; F9 severity floor: big spacing deltas may NOT be binned).
// Ban: diffCount>0 with actionableForBuilder+routeToPlanner==0 and empty noise ledger.
//
// Dedupe (F6): canonical identity = semantic miss id, or box IoU ≥ 0.8 for anonymous regions.
// Cross-block fan-out of the same miss collapses to ONE row with affectedBlocks[].
// A deliveryLedger records where each unique issue was delivered (judge-evidence.mjs updates it).
//
// Routing (F8/F10): typed defect contract via defect-contract.mjs + trap-routing.json
// (category / detector / requiredMode / confidence / affectedComponent). Judge reports
// facts + type; Builder chooses mechanism. Uncertain → replan — never CSS-default unknowns.
// Related spacing symptoms merge into one vertical-rhythm root cause (symptoms[] retained).
//
// Usage: node scripts/emit-judge-defects.mjs <phaseDir> [--write] [--allow-stale-vision]
// Exit 0 writes analysis to stdout; --write persists <phaseDir>/judge-defects.json
// Exit 2 = vision record stale/invalid — re-glance required (no emit performed).

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { enrichWorkOrder, routeForContract, classifyDefect } from "./defect-contract.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Layout-only props that are noise on flattenable wrappers / text leaves. */
const LAYOUT_ONLY_PROPS = new Set([
  "align-self", "align-content", "align-items", "justify-content", "justify-items", "justify-self",
  "display", "flex", "flex-grow", "flex-shrink", "flex-basis", "flex-wrap",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "width", "height", "min-width", "min-height", "max-width", "max-height",
]);

// Props that must NEVER be silenced as layout-frame / text-layout noise
// NOTE: content-height / element-count are NOT here — they are DATA vs dummy-mock noise
// UNLESS the delta crosses the F9 severity floor (see severityFloor()).
const NEVER_NOISE = new Set([
  "text", "gap", "gap.y", "gap.x",
  "background", "background-color", "border", "border-radius", "box-shadow",
  "opacity", "font-size", "font-family", "font-weight", "color",
  "flex-direction", "line-height", "letter-spacing",
]);

// Elements whose TEXT CONTENT is user data, never chrome — "data is never a defect" (F5).
const USER_DATA_ELEMENT_RE = /(^|[^a-z])(name|author|user|timestamp|time|date|initial|avatar|message|body|comment-text)([^a-z]|$)/i;
const CHROME_TEXT_ELEMENT_RE = /placeholder|label|title|header|button|reply|show|filter|resolve/i;

/** Templated / laundered miss detector (F1): region-derived ids masquerading as glance rows. */
export function isTemplatedMiss(m) {
  const id = String((m && m.id) || "");
  const issue = String((m && (m.issue || m.summary)) || "");
  if (/^(visual-)?(chrome|region)[-_]?\d+$/i.test(id)) return true;
  if (/significant (chrome|visual) (mismatch|diff)/i.test(issue)) return true;
  // a bare pixel box with no semantic words is not a named miss
  if (/^\s*(region\s*)?-?\d+\s*,\s*-?\d+\s+\d+x\d+\s*$/i.test(issue)) return true;
  return false;
}

/** Parse a css box out of evidence: {x,y,w,h} object, region.cssBox "24,132 288x60", or miss text. */
export function evidenceCssBox(ev) {
  if (!ev) return null;
  const r = ev.region || ev.box || ev;
  const fromStr = (s) => {
    const m = String(s || "").match(/(-?\d+)\s*,\s*(-?\d+)\s+(\d+)x(\d+)/);
    return m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : null;
  };
  if (r && typeof r === "object") {
    const css = fromStr(r.cssBox);
    if (css) return css;
    if (typeof r.x === "number" && typeof r.w === "number" && r.w > 0) {
      // region device coords are 2x css on retina captures; cssBox preferred above
      return { x: r.x, y: r.y, w: r.w, h: r.h };
    }
  }
  return fromStr(ev.cssBox) || fromStr(ev.miss) || fromStr(ev.issue) || null;
}

export function boxIoU(a, b) {
  if (!a || !b) return 0;
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Priority for the Builder work order — P0 is what a human demo-fix prompt actually says. */
export function workOrderPriority(row) {
  const key = String(row.issueKey || "");
  const prop = String(row.property || "");
  const el = String(row.element || "");
  if (/^host-wiring\./.test(key) || prop === "host-wiring") return { tier: "P0", rank: 10, label: "host-wiring" };
  if (/^mechanism\./.test(key) || prop === "mechanism-checklist") return { tier: "P0", rank: 20, label: "mechanism" };
  if (row.unnamedRegion === true) return { tier: "P1", rank: 55, label: "unnamed-region" };
  if (/^composed\./.test(key) || row.composed === true) return { tier: "P0", rank: 30, label: "composed-vision" };
  if (/^smoke\./.test(key) || prop === "interaction") return { tier: "P0", rank: 40, label: "interaction" };
  if (row.severityFloor === true) return { tier: "P1", rank: 52, label: "layout-spacing" };
  if (/placeholder|text/i.test(prop) || /placeholder/i.test(el)) return { tier: "P1", rank: 50, label: "chrome-text" };
  if (/^contract\./.test(key) || /containment|cardinality|phantom/i.test(prop)) return { tier: "P1", rank: 60, label: "mount-map" };
  if (/background|border|border-radius|box-shadow|opacity|font-|color|fill|gap/i.test(prop)) return { tier: "P1", rank: 70, label: "chrome-paint" };
  if (prop === "content-height" || prop === "element-count" || el === "(gross)") return { tier: "P3", rank: 90, label: "data-density" };
  if (prop === "(present)" && /^frame-|^group-/i.test(el)) return { tier: "P3", rank: 95, label: "figma-wrapper-absent" };
  return { tier: "P2", rank: 80, label: "delta-micro" };
}

export function issueKey(diff) {
  const el = String(diff.element || "").toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
  const prop = String(diff.property || "").toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
  // Collapse width+height on same element into one key
  const p = prop === "box.w" || prop === "width" || prop === "box.h" || prop === "height"
    ? "size" : prop;
  // Avatar/initials cluster into one plan-error root
  if (/^(avatar|initials)\b/.test(el)) return `avatar-initials.${p === "size" ? "size" : "render"}`;
  return `${el}.${p}`;
}

const numsOf = (s) => (String(s ?? "").match(/-?\d+(\.\d+)?/g) || []).map(Number);

/**
 * F9 severity floor — a delta too big to be "density noise". Returns a reason string or null.
 * content-height off >30%, or a spacing value (gap/margin/padding) ≥2× / ≤½ of spec.
 * Does NOT apply to flattened Figma wrappers (layout-frame/text nodeKinds) — their
 * margin/padding legitimately disappears when the wrapper flattens out of the live DOM.
 */
export function severityFloor(diff, nodeKind = "") {
  const prop = String(diff.property || "");
  const spec = numsOf(diff.spec)[0];
  const rendered = numsOf(diff.rendered)[0];
  if (!Number.isFinite(spec) || !Number.isFinite(rendered)) return null;
  if (prop === "content-height" && spec > 0) {
    const off = Math.abs(rendered - spec) / spec;
    if (off > 0.30) return `content height ${rendered}px vs spec ${spec}px (${Math.round(off * 100)}% off — above 30% floor)`;
  }
  if (/^(gap|gap\.[xy])$/.test(prop) && spec > 0) {
    if (rendered >= spec * 2 || rendered <= spec / 2) {
      return `${prop} ${rendered}px vs spec ${spec}px (≥2× off — above severity floor)`;
    }
  }
  if (/^(margin|margin-.*|padding|padding-.*)$/.test(prop) && spec > 0
      && nodeKind !== "layout-frame" && nodeKind !== "text") {
    if (rendered >= spec * 2 || rendered <= spec / 2) {
      return `${prop} ${rendered}px vs spec ${spec}px (≥2× off — above severity floor)`;
    }
  }
  return null;
}

export function classifyDiff(diff, elementMeta = {}) {
  const prop = String(diff.property || "");
  const el = String(diff.element || "");
  const note = String(diff.note || diff.delta || "");
  const nodeKind = elementMeta.nodeKind || "";
  const base = prop.split(".")[0];

  if (prop === "text") {
    // F5: data is never a defect — user-data text (names/timestamps/message bodies) differing
    // from the dummy mock is NOT chrome. Placeholder/label/button text stays actionable.
    if (USER_DATA_ELEMENT_RE.test(el) && !CHROME_TEXT_ELEMENT_RE.test(el) && !/placeholder/i.test(note)) {
      return { attribution: "noise", KIND: "pixel", reason: "user-data text vs dummy mock (data is never a defect)" };
    }
    return { attribution: "builder-error", KIND: "pixel", reason: "visible text / placeholder" };
  }
  if (/placeholder|visible text/i.test(note)) {
    return { attribution: "builder-error", KIND: "pixel", reason: "visible text / placeholder" };
  }
  // F9 severity floor beats every noise bin below.
  const floor = severityFloor(diff, nodeKind);
  if (floor) {
    return { attribution: "builder-error", KIND: "pixel", reason: `layout-spacing: ${floor}`, severityFloor: true };
  }
  // DATA vs dummy mock — never the primary Builder work order (human demo fixes ignore these).
  if (el === "(gross)" || prop === "content-height" || prop === "element-count") {
    return { attribution: "noise", KIND: "pixel", reason: "data-density vs dummy mock (not a customization defect)" };
  }
  // Missing Figma auto-layout wrapper frames are expected on the flatter live DOM.
  if (prop === "(present)" && /^frame-|^group-|^rectangle/i.test(el)) {
    return { attribution: "noise", KIND: "pixel", reason: "figma wrapper absent in live DOM (expected flatten)" };
  }
  if (/selector-binding|probe.?bind|misbind|::before|caret/i.test(note + el + prop)) {
    return { attribution: "plan-error(style)", KIND: "pixel", reason: "probe binding" };
  }
  // Avatar/initials are SDK-rendered (::before / component internals) — Builder CSS rarely owns them.
  if (/^(avatar|initials)\b/i.test(el)) {
    return { attribution: "plan-error(style)", KIND: "pixel", reason: "avatar/initials SDK binding" };
  }
  if (prop === "flex-direction" && /column|row/i.test(note + String(diff.spec) + String(diff.rendered))) {
    return { attribution: "builder-error", KIND: "pixel", reason: "flex-direction row≠column" };
  }
  if (NEVER_NOISE.has(prop) || NEVER_NOISE.has(base)) {
    return { attribution: "builder-error", KIND: "pixel", reason: "gated style/box/gap" };
  }
  // layout-frame: geometry-only wrapper props → noise ledger (not silent drop)
  if (nodeKind === "layout-frame") {
    if (LAYOUT_ONLY_PROPS.has(prop) || /^box\./.test(prop)) {
      return { attribution: "noise", KIND: "pixel", reason: "layout-frame wrapper flatten (geometry-only prop)" };
    }
  }
  // text leaves: Figma often dumps flex/align onto text runs — not Builder-actionable paint
  if (nodeKind === "text" && (LAYOUT_ONLY_PROPS.has(prop) || /^box\./.test(prop))) {
    return { attribution: "noise", KIND: "pixel", reason: "layout prop on text leaf (unattributable)" };
  }
  // Explicit flatten / selector-collision advisory notes → noise (never a "split the class" order)
  if (/flatten|selector-collision|collision|unattributable|layout-frame/i.test(note + el)) {
    if (LAYOUT_ONLY_PROPS.has(prop) || /^box\./.test(prop) || prop === "display") {
      return { attribution: "noise", KIND: "pixel", reason: "flatten/collision advisory (geometry-only)" };
    }
  }
  // Host-chrome gutter offsets (sidebar padding around header) — not shared-stylesheet scope
  if (/host-chrome|host chrome|R18|out of (shared-)?stylesheet scope/i.test(note)) {
    return { attribution: "noise", KIND: "pixel", reason: "host-chrome offset (out of customization scope)" };
  }
  return { attribution: "builder-error", KIND: "pixel", reason: "default measured fail" };
}

/**
 * Phase-2 state-coverage gate (pure): every state frame bound in state-bindings.json whose
 * blockIds appear in blocks.json must have a guard-CONFIRMED capture NEWER than the resting
 * live-panel capture. A state block judged only against the resting panel manufactures
 * diff regions and hides state defects (RC5).
 * @returns string[] problems (empty = gate green)
 */
export function stateCoverageProblems({ blockIds, bindings, captures, restingMtime, captureMtime }) {
  const problems = [];
  const blockSet = new Set(blockIds || []);
  for (const b of bindings || []) {
    const bound = (b.blockIds || []).filter((id) => blockSet.has(id));
    if (!bound.length) continue;
    const cap = (captures || []).find((c) => c.state === b.state);
    if (!cap) { problems.push(`state '${b.state}' (blocks ${bound.join(",")}): no capture row — run state-capture.mjs`); continue; }
    if (!cap.guard?.ok) { problems.push(`state '${b.state}' (blocks ${bound.join(",")}): capture guard failed — ${cap.guard?.reason || "unconfirmed"}`); continue; }
    const mt = captureMtime ? captureMtime(cap) : null;
    if (restingMtime && mt && mt < restingMtime) {
      problems.push(`state '${b.state}' (blocks ${bound.join(",")}): capture is OLDER than the resting live-panel capture — re-run state-capture.mjs`);
    }
  }
  return problems;
}

/**
 * Phase-7 union carry-forward (RC7 — history laundering). Pure.
 * An issue may leave the historically-open set ONLY with resolution evidence (a compiled
 * assertion for it now PASSING, or an explicit evidence row). Anything else that vanished
 * is re-emitted as `regression-lost-coverage` — a detector losing sight of a defect is
 * itself a defect.
 *
 * @param unionEntries      {identity: {firstSeen, lastSeen, tier}} union of ALL prior ledgers
 * @param currentIdentities Set<string> identities in this emit's workOrder
 * @param passingAssertions Set<string> compiled assertion ids passing on the CURRENT build
 * @param resolvedDoc       {resolved: [{identity, evidence}]} explicit resolution rows
 */
export function unionCarryForward({ unionEntries = {}, currentIdentities = new Set(), passingAssertions = new Set(), resolvedDoc = null }) {
  const regressionRows = [];
  const resolutions = [];
  const explicit = new Map((resolvedDoc?.resolved || []).map((r) => [r.identity, r.evidence]));
  for (const [identity, meta] of Object.entries(unionEntries)) {
    if (currentIdentities.has(identity)) continue;
    if (meta.resolved) continue;
    // resolution evidence: the compiled assertion for this identity passes now
    const passing = passingAssertions.has(identity)
      || [...passingAssertions].some((id) => id === meta.assertionId || (identity.length > 6 && id.endsWith(identity)));
    if (passing) { resolutions.push({ identity, evidence: `compiled assertion passing on current build` }); continue; }
    if (explicit.has(identity)) { resolutions.push({ identity, evidence: explicit.get(identity) }); continue; }
    regressionRows.push({
      element: "(ledger)",
      property: "regression-lost-coverage",
      spec: "open issue remains visible to a detector (or carries resolution evidence)",
      rendered: `historically-open '${identity}' (last seen ${meta.lastSeen || "?"}) vanished with NO resolution evidence`,
      KIND: "pixel",
      attribution: "builder-error",
      issueKey: `ledger.${identity}`,
      canonicalId: identity,
      source: "ledger-union",
      unnamedRegion: false,
      severityFloor: true, // ranks P1 layout-spacing band — never silently buried
      rootCause: "detector or plan lost sight of an open issue (RC7) — restore coverage or attach passing-assertion evidence",
    });
  }
  return { regressionRows, resolutions };
}

// ---- routing manifest (F8) ----
async function loadRoutingManifest() {
  try {
    return JSON.parse(await fs.readFile(path.join(ROOT, "knowledge", "trap-routing.json"), "utf8"));
  } catch {
    return { defaultRoute: { mode: "replan", remedy: "uncertain root cause — replan; never guess with CSS" }, traps: [] };
  }
}

export function routeFor(row, manifest) {
  return routeForContract(row, manifest);
}

export { classifyDefect, enrichWorkOrder };

async function loadJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

async function fileFingerprint(p) {
  try {
    const [buf, st] = [await fs.readFile(p), await fs.stat(p)];
    return { sha256: createHash("sha256").update(buf).digest("hex"), mtime: st.mtime.toISOString(), path: p };
  } catch { return null; }
}

function slugOfMiss(uObj, i) {
  return String(uObj.id || uObj.issue || uObj.summary || `miss-${i}`).slice(0, 48).replace(/\W+/g, "-") || `miss-${i}`;
}

async function main() {
  const [phaseDir, ...rest] = process.argv.slice(2);
  if (!phaseDir) { console.error("usage: emit-judge-defects.mjs <phaseDir> [--write] [--allow-stale-vision]"); process.exit(1); }
  const write = rest.includes("--write");
  const allowStale = rest.includes("--allow-stale-vision");
  const resultsDir = path.join(phaseDir, "results");
  const briefsDir = path.join(phaseDir, "briefs");
  const blocks = await loadJson(path.join(phaseDir, "blocks.json")) || { blocks: [] };
  const manifest = await loadRoutingManifest();
  const outBlocks = {};
  const issueIndex = new Map(); // issueKey → {…, affectedBlocks:[]}
  const plannerTickets = [];
  let smokeDefects = [];

  // Build fingerprint of the live capture this emit is judging (F3 freshness).
  const livePanelPath = path.join(phaseDir, "composed-audit", "live-panel.png");
  const buildFingerprint = await fileFingerprint(livePanelPath);

  for (const b of blocks.blocks || []) {
    const bid = b.id;
    const delta = await loadJson(path.join(resultsDir, bid, "delta.json"));
    const contract = await loadJson(path.join(resultsDir, bid, "contract.json"));
    const brief = await loadJson(path.join(briefsDir, `${bid}.probes.json`))
      || await loadJson(path.join(briefsDir, `${bid}.json`));
    const metaByName = Object.fromEntries((brief?.browser?.elements || []).map((e) => [e.name, e]));
    const diffs = delta?.diffs || [];
    const defectRows = [];
    const noiseLedger = [];

    for (const d of diffs) {
      const cls = classifyDiff(d, metaByName[d.element] || {});
      const key = issueKey(d);
      const row = {
        block: bid,
        element: d.element,
        property: d.property,
        spec: d.spec,
        rendered: d.rendered,
        delta: d.note || d.delta || "",
        KIND: cls.KIND,
        attribution: cls.attribution,
        issueKey: key,
        source: "delta-compare",
        ...(cls.severityFloor ? { severityFloor: true } : {}),
        pass: false,
      };
      if (cls.attribution === "noise") {
        noiseLedger.push({ ...row, noiseReason: cls.reason });
        continue;
      }
      defectRows.push(row);
      if (/^plan-error/.test(cls.attribution)) {
        plannerTickets.push({
          block: bid, element: d.element, property: d.property, spec: d.spec, rendered: d.rendered,
          issueKey: key, reason: cls.reason, attribution: cls.attribution,
          mode: cls.attribution === "plan-error(structure)" ? "replan-structure" : "replan-style",
        });
      }
      if (!issueIndex.has(key)) {
        issueIndex.set(key, { issueKey: key, ...row, affectedBlocks: [bid], rootCause: cls.reason });
      } else {
        const g = issueIndex.get(key);
        if (!g.affectedBlocks.includes(bid)) g.affectedBlocks.push(bid);
      }
    }

    // Contract MISSING / CONTAINMENT failures
    for (const v of contract?.violations || contract?.diffs || []) {
      const kind = v.kind || "contract";
      const row = {
        block: bid,
        element: v.part || v.selector || "contract",
        property: kind,
        spec: v.requiredAncestor || "present",
        rendered: kind,
        delta: v.note || "",
        KIND: "pixel",
        attribution: "builder-error",
        issueKey: `contract.${v.part || kind}`,
        contractKind: kind,
        source: "contract-probe",
        pass: false,
      };
      defectRows.push(row);
    }

    const builderRows = defectRows.filter((r) => r.attribution === "builder-error");
    const planRows = defectRows.filter((r) => /^plan-error/.test(r.attribution));
    const silent = (delta && delta.ok === false && diffs.length && !builderRows.length && !planRows.length && !noiseLedger.length);

    outBlocks[bid] = {
      deltaOk: delta ? !!delta.ok : null,
      diffCount: diffs.length,
      defectRows,
      noiseLedger,
      actionableForBuilder: builderRows.length,
      routeToPlanner: planRows.length,
      ...(silent ? { note: "ILLEGAL silent drop prevented — classify residuals" } : {}),
      ...(noiseLedger.length && !builderRows.length && !planRows.length
        ? { note: `all ${noiseLedger.length} residual(s) in noise ledger (layout-frame / collision)` }
        : {}),
    };
  }

  // Smoke defects
  const smokeDir = path.join(resultsDir, "smoke");
  for (const fam of blocks.families || []) {
    const smoke = await loadJson(path.join(smokeDir, `${fam.id}.json`));
    if (!smoke || smoke.ok) continue;
    const failedSteps = (smoke.steps || []).filter((s) => s && s.ok === false);
    for (const step of failedSteps) {
      smokeDefects.push({
        family: fam.id,
        element: step.selector || step.element || step.name,
        property: "interaction",
        spec: "smoke step succeeds",
        rendered: step.error || step.rendered || "failed",
        KIND: /hover/i.test(String(step.name || "") + String(step.error || "")) ? "hover" : "click",
        attribution: "builder-error",
        smokeStep: step.name,
        issueKey: `smoke.${fam.id}.${step.name}`,
        source: "smoke",
        causePacket: step.causePacket || null,
      });
    }
  }

  // GOLDEN-PATH: host-wiring + mechanism-checklist fails become first-class builder-errors
  // (so strict-fix cannot plateau on flatten noise while Show-N / scroll / kebab are broken).
  const goldenPathDefects = [];
  const hostWiring = await loadJson(path.join(phaseDir, "host-wiring.json"));
  if (hostWiring && hostWiring.ok === false) {
    for (const m of hostWiring.missing || []) {
      const key = `host-wiring.${m.prop || m.id || "missing"}`;
      goldenPathDefects.push({
        element: m.tag || "host",
        property: m.prop || m.id || "host-wiring",
        spec: m.value !== undefined ? String(m.value) : m.check || "present",
        rendered: "missing",
        KIND: "pixel",
        attribution: "builder-error",
        issueKey: key,
        source: "host-wiring",
        rootCause: "plan hostProps / always-on infra not baked (R18 exception — APPLY+KEEP)",
        designEvidence: m.designEvidence || null,
      });
      if (!issueIndex.has(key)) issueIndex.set(key, { issueKey: key, ...goldenPathDefects[goldenPathDefects.length - 1], affectedBlocks: ["(host)"] });
    }
  }
  const mech = await loadJson(path.join(phaseDir, "mechanism-checklist.json"));
  if (mech) {
    for (const it of mech.items || []) {
      if (it.status !== "fail") continue;
      const key = `mechanism.${it.id}`;
      const row = {
        element: it.surface || it.id,
        property: "mechanism-checklist",
        spec: "pass",
        rendered: "fail",
        KIND: /scroll/i.test(it.id) ? "scroll" : /hover|options|kebab/i.test(it.id) ? "hover" : "pixel",
        attribution: "builder-error",
        issueKey: key,
        source: "mechanism",
        evidence: it.evidence || null,
        rootCause: "DEMO-POLISH checklist fail — mechanism CSS / host wiring, not plan hex values",
      };
      goldenPathDefects.push(row);
      if (!issueIndex.has(key)) issueIndex.set(key, { ...row, affectedBlocks: Object.keys(mech.blocks || {}) });
    }
  } else if ((blocks.blocks || []).length) {
    goldenPathDefects.push({
      element: "(design)",
      property: "mechanism-checklist",
      spec: "recorded",
      rendered: "missing",
      KIND: "pixel",
      attribution: "builder-error",
      issueKey: "mechanism.checklist-missing",
      source: "mechanism",
      rootCause: "mechanism-checklist.json absent — Builder must run DEMO-POLISH and record results",
    });
  }

  // ---- COMPOSED LAYER (F1: forward the vision record; never regenerate from regions) ----
  // P0 sources: named glance rows (source=composed-vision.glance, semantic id) and named DOM-probe
  // rows (source=composed-audit.dom-probe). visual-diff regions attach as CONFIRM evidence to a
  // named miss they overlap (IoU ≥ 0.5), else become P1 unnamed-region rows.
  const composedDefects = [];
  const unnamedRegionRows = [];
  const appearanceDir = path.join(phaseDir, "appearance");
  const visionMissing = [];
  const staleVision = [];   // blocks whose glance predates the current live capture
  const launderedVision = []; // blocks whose "glance" rows are region-templated (not a real glance)
  const recordedGlanceIds = []; // {block, id} — for the exactly-once self-check
  const canonical = new Map(); // canonicalId → emitted row (cross-block dedupe)

  const livePanelMtime = buildFingerprint ? Date.parse(buildFingerprint.mtime) : 0;

  for (const b of blocks.blocks || []) {
    const ap = await loadJson(path.join(appearanceDir, `${b.id}.json`));
    if (!ap || !ap.visionReviewed) visionMissing.push(b.id);
    if (!ap) continue;

    const reviewedAt = Date.parse(ap.visionReviewedAt || 0) || 0;
    if (ap.needsReGlance === true || (livePanelMtime && reviewedAt && reviewedAt < livePanelMtime - 2000)) {
      staleVision.push(b.id);
    }

    const rows = (ap.unresolved || []).map((u, i) => (u && typeof u === "object") ? u : { issue: String(u), id: `miss-${i}` });
    const named = [];   // glance + dom-probe rows (P0 candidates)
    const regions = []; // visual-diff rows

    for (const [i, uObj] of rows.entries()) {
      const src = uObj.source || "";
      if (src === "composed-vision.glance") {
        if (isTemplatedMiss(uObj)) {
          if (!launderedVision.includes(b.id)) launderedVision.push(b.id);
          regions.push({ ...uObj, _laundered: true });
        } else {
          recordedGlanceIds.push({ block: b.id, id: slugOfMiss(uObj, i) });
          named.push({ ...uObj, _provenance: "vision" });
        }
      } else if (src === "composed-audit.visual-diff") {
        regions.push(uObj);
      } else {
        // dom-probe (or unknown-but-named) — semantic detections like composer-placeholder-painted
        if (isTemplatedMiss(uObj)) regions.push(uObj);
        else named.push({ ...uObj, _provenance: src === "composed-audit.dom-probe" ? "composed-audit" : (src || "appearance") });
      }
    }

    // Named rows → P0 (canonical dedupe across blocks by slug)
    for (const [i, uObj] of named.entries()) {
      const slug = slugOfMiss(uObj, i);
      const canonId = slug;
      if (canonical.has(canonId)) {
        const g = canonical.get(canonId);
        if (!g.affectedBlocks.includes(b.id)) g.affectedBlocks.push(b.id);
        continue;
      }
      const key = `composed.${b.id}.${slug}`;
      const row = {
        block: b.id,
        element: uObj.selector || uObj.region || "(composed)",
        property: "composed-vision",
        spec: "matches mock/Figma chrome",
        rendered: uObj.issue || uObj.summary || "unresolved appearance miss",
        KIND: uObj.kind || "pixel",
        attribution: "builder-error",
        issueKey: key,
        canonicalId: canonId,
        composed: true,
        source: uObj._provenance,
        evidence: uObj.evidence || ap.liveScreenshot || null,
        affectedBlocks: [b.id],
        rootCause: uObj._provenance === "vision"
          ? "Judge glance-named miss (recorded via composed-vision-record.mjs)"
          : "composed-audit DOM probe fail (named semantic check)",
      };
      composedDefects.push(row);
      canonical.set(canonId, row);
      issueIndex.set(key, row);
    }

    // Region rows → confirm-evidence on an overlapping named row, else P1 unnamed-region
    for (const [i, uObj] of regions.entries()) {
      const rBox = evidenceCssBox(uObj.evidence) || evidenceCssBox({ issue: uObj.issue });
      let attached = false;
      if (rBox) {
        for (const nRow of composedDefects) {
          const nBox = evidenceCssBox(nRow.evidence);
          if (nBox && boxIoU(rBox, nBox) >= 0.5) {
            nRow.confirmEvidence = [...(nRow.confirmEvidence || []), { source: "composed-audit.visual-diff", region: uObj.evidence?.region || rBox, block: b.id }];
            attached = true;
            break;
          }
        }
      }
      if (attached) continue;
      // canonical identity for anonymous regions: box IoU ≥ 0.8 against already-emitted regions
      let canonId = null;
      if (rBox) {
        for (const [cid, cRow] of canonical) {
          if (!cid.startsWith("region@")) continue;
          if (boxIoU(rBox, cRow._cssBox) >= 0.8) { canonId = cid; break; }
        }
      }
      if (canonId && canonical.has(canonId)) {
        const g = canonical.get(canonId);
        if (!g.affectedBlocks.includes(b.id)) g.affectedBlocks.push(b.id);
        continue;
      }
      canonId = rBox ? `region@${Math.round(rBox.x / 8) * 8},${Math.round(rBox.y / 8) * 8}` : `region#${b.id}-${i}`;
      const slug = slugOfMiss(uObj, i);
      const row = {
        block: b.id,
        element: "(composed)",
        property: "composed-vision",
        spec: "matches mock/Figma chrome",
        rendered: uObj.issue || uObj.summary || "visual-diff region (unnamed)",
        KIND: uObj.kind || "pixel",
        attribution: "builder-error",
        issueKey: `composed.${b.id}.${slug}`,
        canonicalId: canonId,
        unnamedRegion: true,
        composed: false, // NOT composed-vision P0 — never rank these as the demo-fix prompt
        source: uObj._laundered ? "vision-invalid" : "visual-diff",
        evidence: uObj.evidence || null,
        _cssBox: rBox,
        affectedBlocks: [b.id],
        rootCause: uObj._laundered
          ? "region-templated row recorded as glance (laundered) — demoted; Judge must re-glance and NAME misses"
          : "visual-diff region with no named vision miss overlapping it — inspect crop; name it to promote to P0",
      };
      unnamedRegionRows.push(row);
      canonical.set(canonId, row);
      issueIndex.set(row.issueKey, row);
    }
  }

  if (visionMissing.length) {
    const flow = (blocks.blocks || []).find((b) => b.role === "flow") || (blocks.blocks || [])[0];
    const key = `composed.${flow?.id || "design"}.vision-pass-missing`;
    const row = {
      block: flow?.id || "(design)",
      element: "(composed)",
      property: "composed-vision",
      spec: "Judge must Read live+frame PNGs and record via composed-vision-record.mjs",
      rendered: `visionReviewed missing on: ${visionMissing.join(", ")}`,
      KIND: "pixel",
      attribution: "builder-error",
      issueKey: key,
      composed: true,
      source: "emit-gate",
      evidence: { visionMissing },
      rootCause: "Judge skipped the human glance — re-run vision-first pipeline before claiming P0 clear",
    };
    composedDefects.push(row);
    if (!issueIndex.has(key)) issueIndex.set(key, { ...row, affectedBlocks: visionMissing });
  }

  // F1 freshness gate: emitting from a stale or laundered vision record fabricates truth.
  if ((staleVision.length || launderedVision.length) && !allowStale) {
    console.error(`✗ emit refused — vision record is not trustworthy for the current live capture:`);
    if (staleVision.length) console.error(`  stale (glance predates live-panel.png): ${staleVision.join(", ")}`);
    if (launderedVision.length) console.error(`  laundered (region-templated rows recorded as glance): ${launderedVision.join(", ")}`);
    console.error(`  Fix: re-run the Judge glance (Read live+frame PNGs, composed-vision-record.mjs with NAMED misses), then re-emit.`);
    console.error(`  Override (diagnosis only): --allow-stale-vision demotes laundered rows to P1 unnamed-region.`);
    process.exit(2);
  }

  // Phase-2 state-coverage gate: state blocks bound in state-bindings.json need confirmed,
  // fresh state captures — judging a hover/selected frame against the resting panel is banned.
  let stateCoverageWarnings = null;
  const stateBindings = await loadJson(path.join(phaseDir, "state-bindings.json"));
  const stateCaptures = await loadJson(path.join(phaseDir, "state-captures.json"));
  if (stateBindings?.bindings?.length) {
    const capMtime = async (c) => { try { return (await fs.stat(c.capture || path.join(phaseDir, "composed-audit", `live-${c.captureId || c.state}.png`))).mtime.getTime(); } catch { return 0; } };
    const capsWithM = [];
    for (const c of stateCaptures?.captures || []) capsWithM.push({ ...c, _mtime: await capMtime(c) });
    const problems = stateCoverageProblems({
      blockIds: (blocks.blocks || []).map((b) => b.id),
      bindings: stateBindings.bindings,
      captures: capsWithM,
      restingMtime: livePanelMtime || 0,
      captureMtime: (c) => c._mtime,
    });
    if (problems.length && !rest.includes("--allow-missing-state-captures")) {
      console.error(`✗ emit refused — state coverage incomplete (state frames judged without their state driven):`);
      for (const p of problems) console.error(`  - ${p}`);
      console.error(`  Fix: node scripts/state-capture.mjs <phaseDir> --connect <ws>; then re-glance the state captures and re-emit.`);
      console.error(`  Override (diagnosis only): --allow-missing-state-captures.`);
      process.exit(2);
    }
    if (problems.length) stateCoverageWarnings = problems;
  }

  // Build ranked workOrder — Builder MUST consume this top-down (P0 before P2 micro-deltas).
  const actionable = [];
  for (const row of [...goldenPathDefects, ...composedDefects, ...unnamedRegionRows, ...smokeDefects]) {
    if (row.attribution !== "builder-error") continue;
    const pri = workOrderPriority(row);
    actionable.push({ ...row, ...pri });
  }
  for (const [bid, blk] of Object.entries(outBlocks)) {
    for (const row of blk.defectRows || []) {
      if (row.attribution !== "builder-error") continue;
      const pri = workOrderPriority(row);
      actionable.push({ ...row, block: bid, ...pri });
    }
  }
  // Dedupe by canonical identity first (cross-block), then by issueKey; keep best (lowest) rank.
  const byKey = new Map();
  for (const row of actionable) {
    const k = row.canonicalId || row.issueKey;
    const cur = byKey.get(k);
    if (!cur || row.rank < cur.rank) byKey.set(k, row);
  }
  // F6 real ranking: within a rank band, order by provenance (vision first) then evidence area
  // (bigger miss first) — "top N" must mean the N most important, not array order.
  const sourceWeight = (r) => (r.source === "vision" ? 0 : r.source === "composed-audit" ? 1 : r.source === "visual-diff" ? 3 : 2);
  const areaOf = (r) => { const b = evidenceCssBox(r.evidence) || r._cssBox; return b ? b.w * b.h : 0; };
  const workOrder = [...byKey.values()]
    .map((r) => ({ ...r, subRank: sourceWeight(r) * 1e6 - Math.min(999999, areaOf(r)) }))
    .sort((a, b) => a.rank - b.rank || a.subRank - b.subRank || String(a.issueKey).localeCompare(b.issueKey));
  for (const r of workOrder) delete r._cssBox;
  const workOrderP0 = workOrder.filter((r) => r.tier === "P0");

  // §6 guard: P0 rows must carry semantic ids — anonymous region ids can never be P0.
  const badP0 = workOrderP0.filter((r) => /(^|\.)((visual-)?(region|chrome)-?\d+)$/i.test(String(r.issueKey)));
  if (badP0.length) {
    throw new Error(`BUG: templated region ids ranked P0: ${badP0.map((r) => r.issueKey).join(", ")}`);
  }
  // F1 exactly-once self-check: every recorded named glance miss must be represented in the emit.
  // F8/F10: typed defect contract + routing. Merge spacing symptoms; never CSS-default unknowns.
  // Orphan check runs AFTER merge — symptom slugs on merged rows still count as emitted.
  const enriched = enrichWorkOrder(workOrder, { merge: true });
  workOrder.length = 0;
  workOrder.push(...enriched);
  const emittedSlugs = new Set();
  for (const r of workOrder) {
    emittedSlugs.add(String(r.issueKey).split(".").pop());
    for (const s of r.symptoms || []) emittedSlugs.add(String(s.issueKey || "").split(".").pop());
  }
  const orphanedGlance = recordedGlanceIds.filter((g) => !emittedSlugs.has(g.id));
  if (orphanedGlance.length) {
    throw new Error(`BUG: recorded glance misses dropped by emit: ${orphanedGlance.map((g) => `${g.block}/${g.id}`).join(", ")}`);
  }
  for (const r of workOrder) {
    const viaTrap = routeFor(r, manifest);
    r.route = { ...viaTrap, ...r.route, mode: r.requiredMode || r.route?.mode || viaTrap.mode };
  }
  for (const t of plannerTickets) {
    const c = classifyDefect(t);
    Object.assign(t, {
      category: c.category,
      detector: c.detector,
      requiredMode: c.requiredMode,
      confidence: c.confidence,
      affectedComponent: c.affectedComponent,
      route: routeFor(t, manifest),
    });
  }
  // Phase 7 corroboration: a vision miss whose evidence box overlaps a MECHANICAL finding
  // (compiled assertion / probe) is the same issue seen twice — merge vision INTO the probe
  // row (kills triple-packets). The glance id survives in corroboratedBy[] for the orphan gate.
  {
    const MECH = new Set(["compiled-assertion", "composed-audit", "interaction-state-probe", "appearance"]);
    for (const v of [...workOrder]) {
      if (v.source !== "vision") continue;
      const vBox = evidenceCssBox(v.evidence);
      if (!vBox) continue;
      const mate = workOrder.find((m) => m !== v && MECH.has(String(m.source))
        && evidenceCssBox(m.evidence) && boxIoU(vBox, evidenceCssBox(m.evidence)) >= 0.5);
      if (!mate) continue;
      mate.corroboratedBy = [...(mate.corroboratedBy || []), { issueKey: v.issueKey, id: String(v.issueKey).split(".").pop(), source: "vision" }];
      if (v.tier === "P0" && mate.tier !== "P0") { mate.tier = "P0"; mate.rank = Math.min(mate.rank, v.rank); }
      workOrder.splice(workOrder.indexOf(v), 1);
    }
  }

  // Phase 7 union carry-forward (RC7): diff against the UNION of all historical ledgers.
  // Leaving the open set requires resolution evidence; otherwise regression-lost-coverage.
  const unionPath = path.join(phaseDir, "ledger-union.json");
  const unionDoc = (await loadJson(unionPath)) || { identities: {} };
  {
    const passing = new Set();
    const compiledResults = await loadJson(path.join(phaseDir, "compiled-results.json"));
    for (const r of compiledResults?.results || []) if (r.status === "pass") passing.add(r.id);
    const currentIdentities = new Set(workOrder.map((r) => r.canonicalId || r.issueKey));
    const resolvedDoc = await loadJson(path.join(phaseDir, "resolved-issues.json"));
    const { regressionRows, resolutions } = unionCarryForward({
      unionEntries: unionDoc.identities, currentIdentities, passingAssertions: passing, resolvedDoc,
    });
    for (const row of regressionRows) {
      const pri = workOrderPriority(row);
      workOrder.push({ ...row, ...pri, route: routeFor(row, manifest) });
    }
    const nowIso = new Date().toISOString();
    for (const res of resolutions) {
      const u = unionDoc.identities[res.identity];
      if (u) u.resolved = { at: nowIso, evidence: res.evidence };
    }
    for (const r of workOrder) {
      const id = r.canonicalId || r.issueKey;
      const u = unionDoc.identities[id] || { firstSeen: nowIso };
      u.lastSeen = nowIso;
      u.tier = r.tier;
      delete u.resolved;
      unionDoc.identities[id] = u;
    }
    if (regressionRows.length) unionDoc.lastRegressions = regressionRows.map((r) => r.canonicalId);
  }
  workOrder.sort((a, b) => a.rank - b.rank || (a.subRank ?? 0) - (b.subRank ?? 0) || String(a.issueKey).localeCompare(b.issueKey));

  workOrderP0.length = 0;
  workOrderP0.push(...workOrder.filter((r) => r.tier === "P0"));

  // F6 delivery ledger — one entry per unique issue; judge-evidence.mjs marks packets/prompt.
  const deliveryLedger = workOrder.map((r) => ({
    identity: r.canonicalId || r.issueKey,
    issueKey: r.issueKey,
    tier: r.tier,
    routeMode: r.route?.mode,
    category: r.category || null,
    requiredMode: r.requiredMode || r.route?.mode || null,
    detector: r.detector || null,
    confidence: r.confidence || null,
    affectedComponent: r.affectedComponent || null,
    symptoms: (r.symptoms || []).map((s) => s.issueKey),
    source: r.source || "delta-compare",
    blocks: r.affectedBlocks || (r.block ? [r.block] : []),
    deliveredIn: { workOrder: true, builderPackets: false, prompt: false },
  }));
  {
    const seen = new Set();
    for (const l of deliveryLedger) {
      if (seen.has(l.identity)) throw new Error(`BUG: duplicate identity in deliveryLedger: ${l.identity}`);
      seen.add(l.identity);
    }
  }

  const totals = {
    builder: Object.values(outBlocks).reduce((n, b) => n + b.actionableForBuilder, 0)
      + smokeDefects.filter((s) => s.attribution === "builder-error").length
      + goldenPathDefects.length
      + composedDefects.length,
    plan: Object.values(outBlocks).reduce((n, b) => n + b.routeToPlanner, 0),
    noise: Object.values(outBlocks).reduce((n, b) => n + (b.noiseLedger?.length || 0), 0),
    uniqueIssues: byKey.size,
    goldenPath: goldenPathDefects.length,
    composed: composedDefects.length,
    unnamedRegions: unnamedRegionRows.length,
    plannerTickets: plannerTickets.length,
    workOrderP0: workOrderP0.length,
    workOrderTotal: workOrder.length,
    ...(stateCoverageWarnings ? { stateCoverageProblems: stateCoverageWarnings } : {}),
    ...(staleVision.length ? { staleVisionBlocks: staleVision } : {}),
    ...(launderedVision.length ? { launderedVisionBlocks: launderedVision } : {}),
  };

  // Ban silent drop at document level
  const illegalSilent = Object.entries(outBlocks).filter(([, b]) => b.diffCount > 0 && b.actionableForBuilder + b.routeToPlanner === 0 && !(b.noiseLedger || []).length);
  if (illegalSilent.length) {
    totals.illegalSilentBlocks = illegalSilent.map(([k]) => k);
  }

  const doc = {
    stage: "judge",
    run: path.basename(phaseDir),
    generatedAt: new Date().toISOString(),
    emitter: "emit-judge-defects.mjs",
    buildFingerprint,
    doctrine: "FORWARD the vision record; never regenerate P0s from pixel regions. VISION/COMPOSED + HOST/MECHANISM first (P0). Unnamed visual-diff regions are P1. Delta micro-rows are P2. Data-density is noise UNLESS above the F9 severity floor.",
    notes: [
      "Each defect carries category|detector|evidence|affectedComponent|requiredMode|confidence. Judge types; Builder chooses mechanism.",
      "requiredMode: style|structure|wireframe|host-wiring|behavior|replan — NEVER treat unknown findings as CSS by default.",
      "Before editing: confirm visual vs structural vs wireframe vs behavioral. Never CSS-imitate a missing component or hide wrong DOM.",
      "After fixing: rerun relevant DOM + visual + interaction checks — not screenshot comparison alone.",
      "Builder MUST follow workOrder[] top-down by requiredMode/route.mode (structure/wireframe/behavior ≠ DEMO-POLISH CSS).",
      "After emit, run judge-evidence.mjs --write so each P0 gets liveCrop+figmaCrop.",
      "Every delta FAIL is builder-error, plan-error(*) (→ planner-tickets.json), or noise-ledger — silent drop banned.",
      "source field per row is provenance-truthful: vision | composed-audit | visual-diff | delta-compare | host-wiring | mechanism | smoke | contract-probe | interaction | emit-gate.",
    ],
    doctrineContract: "Judge reports facts + defect type; Builder chooses fixing mechanism. Uncertain → replan.",
    workOrder,
    workOrderP0,
    smokeDefects,
    goldenPathDefects,
    composedDefects,
    unnamedRegionRows,
    plannerTickets,
    deliveryLedger,
    issueIndex: [...issueIndex.values()],
    blocks: outBlocks,
    totals,
  };

  console.log(JSON.stringify({
    totals,
    workOrderP0: workOrderP0.slice(0, 12).map((r) => ({
      issueKey: r.issueKey, block: r.block, source: r.source,
      category: r.category, requiredMode: r.requiredMode || r.route?.mode, detector: r.detector, confidence: r.confidence,
    })),
    uniqueIssues: totals.uniqueIssues,
  }, null, 2));
  if (write) {
    await fs.writeFile(path.join(phaseDir, "judge-defects.json"), JSON.stringify(doc, null, 2) + "\n");
    await fs.writeFile(unionPath, JSON.stringify(unionDoc, null, 2) + "\n"); // Phase 7: the union only grows; resolutions carry evidence
    console.log(`✓ wrote ${path.join(phaseDir, "judge-defects.json")}`);
    if (plannerTickets.length) {
      await fs.writeFile(path.join(phaseDir, "planner-tickets.json"), JSON.stringify({
        generatedAt: doc.generatedAt, run: doc.run, tickets: plannerTickets,
      }, null, 2) + "\n");
      console.log(`✓ wrote ${path.join(phaseDir, "planner-tickets.json")} (${plannerTickets.length} ticket(s))`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// dom-snapshot.mjs — the MECHANICAL per-state live-DOM dump (two-phase planning, step 5a2).
// The loop1 autopsy: every judged defect lived in the gap between the PLANNED DOM and Velt's
// RENDERED DOM — wrapper-defeated gaps, un-neutralized wrapper boxes, overlapping default glyphs,
// clipped hairlines, a focus outline. Style placement decisions were being made against a DOM
// that did not exist at plan time. This script closes the gap: after the STRUCTURE build renders,
// it drives every block to its state (same executor as measure-block) and dumps the surface
// subtree — real tags, real classes, real paints — as the ground truth the STYLE planner and the
// Judge's unexpected-paint/overlap probes both read. Mechanical, ~seconds per state, no LLM.
//
// Usage:
//   node scripts/dom-snapshot.mjs <phaseDir> --url <appUrl> --connect <browserWs>
//        [--blocks id1,id2] [--select-user u] [--timeout 30000]
//
// BASE POLICY: every run works STRICTLY on the UNSTYLED base — the structure build wires
// `client.setUnstyledMode(true, { keepFunctionalStyles: true })` into the host as a standard host
// change, so what this script captures IS the unstyled DOM. There is no styled-vs-unstyled
// comparison step (policy decision, 2026-07-20).
//
// Per block: briefs/<blockId>.probes.json supplies drive.steps/assert + liveSelector; output is
// dom-snapshot/<blockId>.json — { blockId, state, surfaceSelector, driven, tree, hints }.
//   tree node: { tag, id?, classes[], box {x,y,w,h} (surface-relative), visible, text?,
//               paints { background, border, boxShadow, outline, borderRadius, svgPathHash? },
//               children[] }
//   hints (pre-computed for the style planner + judge probes):
//     zeroSizeWithContent[]  — 0-size elements that still carry content (dropped/collapsed markup)
//     overlaps[]             — visible glyph/img/leaf boxes intersecting a sibling's (default-glyph
//                              overlap, the loop1 D-class)
//     unstyledVeltInternals[] — velt-* / deep wrappers painting a non-transparent box the design
//                              never drew (candidates for neutralize/suppress rows)
// A block whose drive fails is recorded { driven:false, stateUnreachable:true } — the style
// planner tags its rules `unknown→verify`, the judge treats it unverified, never passed.

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadChromium, acquireBrowser, openPage, resetState, runSteps, waitVisible, vis } from "./measure-block.mjs";
import { obsEvent, obsActiveStage } from "./obs.mjs";   // session-replay record (fail-safe, VELT_OBS=0 disables)

// Injected into the page. Serializes the subtree rooted at the surface selector with computed
// paints, then computes the three hint classes. Kept dependency-free (stringified + evaluated).
// Exported so golden/run-golden.mjs can execute the REAL string against a fake DOM (probe-runtime
// calibration pattern) — the overlap/zero-size hints are what the suppression rows are built from.
export function SNAPSHOT_FN(surfaceSelector, maxDepth) {
  // VISIBLE-FIRST root resolution (the registry-twin trap): a wireframe tag's FIRST DOM match is
  // the permanently-hidden 0-size registry copy under <velt-wireframe> — snapshotting it yields a
  // 22-node all-invisible tree that poisons the style plan (found live in loop2). Root at the first
  // VISIBLE match across the selector alternatives; refuse to snapshot an invisible surface.
  const surf = [...document.querySelectorAll(surfaceSelector)]
    .find((el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; });
  if (!surf) {
    const invisible = document.querySelectorAll(surfaceSelector).length;
    return { error: `no VISIBLE element matches '${surfaceSelector}'${invisible ? ` (${invisible} invisible match(es) — likely the 0-size registry twin; the live clone renders under different selectors)` : ""}` };
  }
  const sr = surf.getBoundingClientRect();
  const round = (n) => Math.round(n * 10) / 10;
  const boxOf = (el) => { const r = el.getBoundingClientRect(); return { x: round(r.left - sr.left), y: round(r.top - sr.top), w: round(r.width), h: round(r.height) }; };
  const TRANSPARENT = /^(rgba\(0, 0, 0, 0\)|transparent)$/;
  const NONE_SHADOW = /^none$/;
  function paintsOf(el, cs) {
    const p = {};
    const bg = cs.backgroundColor;
    if (bg && !TRANSPARENT.test(bg)) p.background = bg;
    const bw = cs.borderTopWidth;
    if (bw && bw !== "0px" && cs.borderTopStyle !== "none") p.border = `${bw} ${cs.borderTopStyle} ${cs.borderTopColor}`;
    if (cs.boxShadow && !NONE_SHADOW.test(cs.boxShadow)) p.boxShadow = cs.boxShadow;
    if (cs.outlineWidth && cs.outlineWidth !== "0px" && cs.outlineStyle !== "none") p.outline = `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}`;
    if (cs.borderTopLeftRadius && cs.borderTopLeftRadius !== "0px") p.borderRadius = cs.borderTopLeftRadius;
    if (el.tagName === "svg" || el.tagName === "SVG") {
      const d = [...el.querySelectorAll("path")].map((x) => x.getAttribute("d") || "").join("|");
      if (d) { let h = 0; for (let i = 0; i < d.length; i++) { h = (h * 31 + d.charCodeAt(i)) | 0; } p.svgPathHash = (h >>> 0).toString(16); }
    }
    return p;
  }
  function visibleOf(el, cs, box) {
    return cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity !== 0 && box.w > 0 && box.h > 0;
  }
  // SPACING (the default-spacing blindness fix, found live loop2): Velt's default stylesheet puts
  // real layout offsets on INNER elements (`.velt-thread-card--message { padding-left: calc(3rem*…);
  // margin-top: .8em }`, `padding: var(--velt-spacing-lg)` on containers). Paints alone made those
  // invisible to the style planner, so design values were planned ON TOP of un-audited default
  // spacing and compounded. Record non-zero computed spacing per node so defaults are AUDITABLE.
  const ZEROISH = /^0(px)?$/;
  function spacingOf(cs) {
    const s = {};
    const z = (v) => v == null || v === "" || ZEROISH.test(v);   // missing (fake-DOM calibration) counts as zero
    const four = (t, r, b, l) => (z(t) && z(r) && z(b) && z(l)) ? null : `${t || "0px"} ${r || "0px"} ${b || "0px"} ${l || "0px"}`;
    const pad = four(cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft);
    const mar = four(cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft);
    if (pad) s.padding = pad;
    if (mar) s.margin = mar;
    if (cs.rowGap && !z(cs.rowGap) && cs.rowGap !== "normal") s.rowGap = cs.rowGap;
    if (cs.columnGap && !z(cs.columnGap) && cs.columnGap !== "normal") s.columnGap = cs.columnGap;
    if (cs.flexGrow && cs.flexGrow !== "0") s.flexGrow = cs.flexGrow;
    return Object.keys(s).length ? s : null;
  }
  const flat = [];   // for hint computation: {node, el, parentIdx}
  function ser(el, depth, parentIdx) {
    if (depth > maxDepth || el.nodeType !== 1) return null;
    const cs = getComputedStyle(el);
    const box = boxOf(el);
    const node = {
      tag: el.tagName.toLowerCase(),
      ...(el.id ? { id: el.id } : {}),
      classes: [...el.classList],
      box,
      visible: visibleOf(el, cs, box),
      paints: paintsOf(el, cs),
      children: [],
    };
    const sp = spacingOf(cs);
    if (sp) node.spacing = sp;
    const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
    if (ownText) node.text = ownText.slice(0, 120);
    const idx = flat.push({ node, el, parentIdx }) - 1;
    for (const c of el.children) {
      const cn = ser(c, depth + 1, idx);
      if (cn) node.children.push(cn);
    }
    return node;
  }
  const tree = ser(surf, 0, -1);
  // ---- hints ----
  const zeroSizeWithContent = [];
  const overlaps = [];
  const unstyledVeltInternals = [];
  const sel = (f) => {
    const parts = [f.node.tag]; if (f.node.id) parts.push("#" + f.node.id);
    if (f.node.classes.length) parts.push("." + f.node.classes.slice(0, 2).join("."));
    return parts.join("");
  };
  const defaultSpacing = [];
  const strippedPainters = [];
  for (const f of flat) {
    const n = f.node;
    if ((n.box.w === 0 || n.box.h === 0) && (n.text || n.children.length)) {
      zeroSizeWithContent.push({ selector: sel(f), box: n.box, hasText: !!n.text, childCount: n.children.length });
    }
    const isVeltInternal = n.tag.startsWith("velt-") || n.classes.some((c) => c.startsWith("velt-") || c.startsWith("s-"));
    const ownMarkup = n.classes.some((c) => c.startsWith("vc-") || c.startsWith("hw-"));
    if (isVeltInternal && !ownMarkup && n.visible && (n.paints.background || n.paints.border || n.paints.boxShadow || n.paints.outline)) {
      unstyledVeltInternals.push({ selector: sel(f), box: n.box, paints: n.paints });
    }
    // DEFAULT-SPACING hint (loop2 root cause): an SDK-internal element carrying non-zero computed
    // spacing is a live layout input the plan must DISPOSITION (keep or zero) — planning design
    // values on top of it compounds offsets (the 28px + calc(3rem) message indent, measured live).
    if (isVeltInternal && !ownMarkup && n.visible && n.spacing) {
      defaultSpacing.push({ selector: sel(f), box: n.box, spacing: n.spacing });
    }
    // STRIPPED-PAINTER hint (v4 avatar-initial class): the SDK carries content in a data-* attribute
    // and paints it via CSS content:attr(...) — the unstyled base strips that painter, leaving a
    // textless element that LOOKS fine to coverage (not painted, no text) while the design shows a
    // letter/placeholder. Flag: content-bearing data attr + no own text + no pseudo content.
    if (!n.text && !n.children.length) {
      try {
        const attr = [...f.el.attributes].find((a) => /initial|placeholder|content|label|count/i.test(a.name) && a.name.startsWith("data-") && a.value && a.value.length <= 60);
        if (attr) {
          const pb = getComputedStyle(f.el, "::before").content, pa = getComputedStyle(f.el, "::after").content;
          if ((pb === "none" || pb === "normal") && (pa === "none" || pa === "normal")) {
            strippedPainters.push({ selector: sel(f), attr: `${attr.name}="${attr.value.slice(0, 30)}"`, box: n.box });
          }
        }
      } catch (e) { /* fake-DOM calibration has no attributes iterator */ }
    }
  }
  // sibling overlap among visible LEAF/glyph boxes (svg, img, leaf elements) — the loop1 D-class
  const byParent = new Map();
  for (const f of flat) {
    if (f.parentIdx < 0) continue;
    if (!(byParent.has(f.parentIdx))) byParent.set(f.parentIdx, []);
    byParent.get(f.parentIdx).push(f);
  }
  const isGlyphish = (n) => n.visible && n.box.w > 2 && n.box.h > 2 && (n.tag === "svg" || n.tag === "img" || !n.children.length);
  for (const sibs of byParent.values()) {
    const g = sibs.filter((f) => isGlyphish(f.node));
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      const a = g[i].node.box, b = g[j].node.box;
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 2 && oy > 2) overlaps.push({ a: sel(g[i]), b: sel(g[j]), overlap: { w: Math.round(ox), h: Math.round(oy) } });
    }
  }
  return { tree, hints: { zeroSizeWithContent, overlaps, unstyledVeltInternals, defaultSpacing, strippedPainters } };
}

async function main() {
  const [phaseDir, ...rest] = process.argv.slice(2);
  const argv = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  if (!phaseDir || !argv("--url")) {
    console.error("usage: dom-snapshot.mjs <phaseDir> --url <appUrl> --connect <browserWs> [--blocks id1,id2] [--select-user u] [--timeout ms] [--max-depth 24]");
    process.exit(1);
  }
  const url = argv("--url"), connect = argv("--connect", null), timeout = +argv("--timeout", "30000");
  const selectUser = argv("--select-user", null), maxDepth = +argv("--max-depth", "24");
  const only = argv("--blocks", null)?.split(",").map((s) => s.trim()).filter(Boolean);
  const blocksJ = JSON.parse(await fs.readFile(path.join(phaseDir, "blocks.json"), "utf8"));
  const blocks = (blocksJ.blocks || []).filter((b) => !only || only.includes(b.id));
  if (!blocks.length) { console.error("✗ no blocks to snapshot"); process.exit(1); }
  const outDir = path.join(phaseDir, "dom-snapshot");
  await fs.mkdir(outDir, { recursive: true });

  const chromium = await loadChromium();
  const browser = await acquireBrowser(chromium, connect, { requireConnect: !!connect });
  let ok = 0, unreachable = 0, page = null, reused = false, keepTab = false;
  try {
    const o = await openPage(browser, url, { scale: 1, selectUser, timeout, reuseContext: !!connect });
    page = o.page; reused = o.reused; keepTab = o.persistentTab;
    await page.waitForFunction(
      () => !!(window.Velt || document.querySelector('velt-comments, velt-comment-tool, [class*="velt-"]')),
      { timeout: Math.min(timeout, 20000) },
    ).catch(() => {});
    for (const b of blocks) {
      const briefP = path.join(phaseDir, "briefs", `${b.id}.probes.json`);
      const brief = JSON.parse(await fs.readFile(briefP, "utf8").catch(() => "null"));
      const liveSelector = brief?.liveSelector || b.liveSelector;
      const outP = path.join(outDir, `${b.id}.json`);
      if (!brief || !liveSelector) {
        await fs.writeFile(outP, JSON.stringify({ blockId: b.id, state: b.state || null, driven: false, stateUnreachable: true, reason: brief ? "no liveSelector" : `probe brief missing: ${briefP}` }, null, 2));
        console.error(`✗ ${b.id}: ${brief ? "no liveSelector" : "probe brief missing"} — recorded stateUnreachable`);
        unreachable++; continue;
      }
      let driven = false, failReason = null;
      // PAINT-TRUTH GUARD (found live, black-screenshot bug): a drive that OPENS a surface via a
      // TOGGLE (e.g. the host's sidebar button) is not idempotent — on the reused run tab the
      // surface may already be open, so the click CLOSES it. Playwright's `visible=true` still
      // matches (the panel keeps its layout box; z-order occlusion is not "visibility"), the assert
      // false-passes, and every screenshot captures the dark page painted OVER the surface. So after
      // the drive, verify the surface is actually TOP-MOST (elementsFromPoint at its center hits a
      // descendant); if occluded, re-run the drive ONCE (a second toggle re-opens), then re-verify.
      // Occlusion proof: a docked panel is often a TALL container whose lower half is empty and
      // transparent (cards only fill the top), so hit-testing the CONTAINER's geometric center
      // lands on the page behind it — a false "occluded". Test the CONTENT proof element instead
      // (the drive's assert target — a card/panel that must be painted for the state to exist), and
      // hit-test near its TOP (where content actually is), accepting a hit that lands on the surface
      // or any of its descendants. Fall back to the surface's top region if no assert element.
      const paintTrue = (surfSel, contentSel) => page.evaluate(({ surfSel, contentSel }) => {
        const surf = [...document.querySelectorAll(surfSel)].find((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; });
        if (!surf) return false;
        const probe = (contentSel && [...document.querySelectorAll(contentSel)].find((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; })) || surf;
        // SCROLL-POSITION GUARD (found live): a docked list that auto-scrolls to its newest item leaves
        // the FIRST content row far outside the viewport (measured firstCardY = -8115 on a 40-card doc).
        // The clamped probe point below then lands on whatever happens to sit at the viewport edge —
        // the app's own header — and the surface is reported "occluded" when it is merely scrolled away.
        // Bring the probe into view FIRST so this tests paint-truth rather than scroll position.
        try { probe.scrollIntoView({ block: "center", inline: "nearest" }); } catch { /* detached */ }
        const r = probe.getBoundingClientRect();
        // hit-test a point solidly INSIDE the probe near its top-left content area (not the empty center)
        const clamp = (v, hi) => Math.max(2, Math.min(v, hi - 2));
        const x = clamp(r.x + Math.min(r.width / 2, 40), innerWidth);
        const y = clamp(r.y + Math.min(r.height / 2, 12), innerHeight);
        const hit = document.elementFromPoint(x, y);
        if (!hit) return false;
        if (surf === hit || surf.contains(hit) || probe === hit || probe.contains(hit)) return true;
        // The hit is OUTSIDE the surface — but many apps stack a TRANSPARENT full-page overlay
        // (doc stage / comment-mode layer) above a docked panel; it wins elementFromPoint yet does
        // NOT visually cover the panel (element.screenshot still captures it). Only treat it as a
        // real occlusion if the covering element is OPAQUE (has a non-transparent background or is
        // an image/video) AND actually overlaps the probe's rect.
        const cs = getComputedStyle(hit);
        const bg = cs.backgroundColor || "";
        const opaqueBg = bg && bg !== "transparent" && !/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(bg);
        const isMedia = /^(img|video|canvas)$/i.test(hit.tagName);
        return !(opaqueBg || isMedia);
      }, { surfSel, contentSel });
      try {
        await resetState(page);
        await runSteps(page, brief.drive?.steps, { timeout });
        const proofSel = brief.drive?.assert || liveSelector;
        await waitVisible(page, proofSel, brief.drive?.assert ? 10000 : 8000);
        if (!(await paintTrue(liveSelector, brief.drive?.assert))) {
          await resetState(page);
          await runSteps(page, brief.drive?.steps, { timeout });
          await waitVisible(page, proofSel, 10000);
          if (!(await paintTrue(liveSelector, brief.drive?.assert))) throw new Error(`surface '${liveSelector}' is occluded (content proof '${proofSel}' hit-test fails) — toggle drive likely closed an already-open surface`);
        }
        driven = true;
      } catch (e) { failReason = String(e.message).slice(0, 300); }
      if (!driven) {
        await fs.writeFile(outP, JSON.stringify({ blockId: b.id, state: b.state || null, surfaceSelector: liveSelector, driven: false, stateUnreachable: true, reason: failReason }, null, 2));
        console.error(`✗ ${b.id}: drive failed (${failReason}) — recorded stateUnreachable (style rules for it become unknown→verify)`);
        obsEvent(phaseDir, { type: "dom-snapshot", src: "dom-snapshot", stage: "dom-snapshot", blockId: b.id, ok: false, summary: `'${b.id}' stateUnreachable: ${String(failReason).slice(0, 200)}`, artifacts: { snapshot: path.relative(phaseDir, outP) } });
        unreachable++; continue;
      }
      await page.waitForTimeout(400);
      // widen the root candidates: the brief's liveSelector may be a wireframe tag whose only DOM
      // match is the registry twin — the drive.assert alternatives name the selectors that PROVED
      // the state visible, so include them in the visible-first root search.
      const rootSel = [liveSelector, brief.drive?.assert].filter(Boolean).join(", ");
      // SCREENSHOT FIRST, RE-VERIFYING PAINT AT CAPTURE TIME (black-screenshot bug, part 2): a
      // host that listens to Velt's sidebar API can flip the surface ASYNC — after the post-drive
      // paint check passed but before the capture (measured live: flow's toggle+API double-open
      // settled closed during the 400ms wait). So verify occlusion again NOW, re-open once if
      // needed, and take the pixels before the (slow) DOM eval; the DOM read itself is
      // occlusion-insensitive so it can safely come after.
      if (!(await paintTrue(liveSelector))) {
        await runSteps(page, brief.drive?.steps, { timeout }).catch(() => {});
        await page.waitForTimeout(600);
      }
      let shotRel = null;
      const shotP = path.join(outDir, `${b.id}.png`);
      if (await paintTrue(liveSelector)) {
        await vis(page, rootSel).screenshot({ path: shotP }).then(() => { shotRel = path.relative(phaseDir, shotP); }, () => {});
      } else {
        console.error(`⚠ ${b.id}: surface occluded at capture time even after re-open — screenshot skipped (DOM snapshot still taken)`);
      }
      const snap = await page.evaluate(`(${SNAPSHOT_FN})(${JSON.stringify(rootSel)}, ${maxDepth})`);
      if (snap.error) {
        await fs.writeFile(outP, JSON.stringify({ blockId: b.id, state: b.state || null, surfaceSelector: liveSelector, driven: true, stateUnreachable: true, reason: snap.error }, null, 2));
        console.error(`✗ ${b.id}: ${snap.error}`);
        unreachable++; continue;
      }
      const out = { blockId: b.id, state: b.state || null, surfaceSelector: liveSelector, driven: true, capturedAt: new Date().toISOString(), ...snap };
      await fs.writeFile(outP, JSON.stringify(out, null, 2));
      const h = snap.hints;
      const refRel = b.framePng ? b.framePng : null;   // frames/<id>.png (phaseDir-relative already)
      console.log(`✓ ${b.id}: snapshot written (${h.overlaps.length} overlap(s), ${h.zeroSizeWithContent.length} zero-size-with-content, ${h.unstyledVeltInternals.length} painting velt-internal(s))${shotRel ? " + screenshot" : ""}`);
      const phase = obsActiveStage(phaseDir);   // gallery cards read as a PHASE filmstrip, not wall-clock
      obsEvent(phaseDir, {
        type: "dom-snapshot", src: "dom-snapshot", stage: "dom-snapshot", blockId: b.id, ok: true,
        summary: `'${b.id}' snapshot: ${h.overlaps.length} overlap(s), ${h.zeroSizeWithContent.length} zero-size-with-content, ${h.unstyledVeltInternals.length} painting velt-internal(s)`,
        data: { group: b.id, label: phase ? `after ${phase}` : `dom-snapshot ${new Date().toISOString().slice(11, 19)}Z`, overlaps: h.overlaps.length, zeroSizeWithContent: h.zeroSizeWithContent.length, unstyledVeltInternals: h.unstyledVeltInternals.length },
        ...(shotRel || refRel ? { shots: { ...(shotRel ? { live: shotRel } : {}), ...(refRel ? { ref: refRel } : {}) } } : {}),
        artifacts: { snapshot: path.relative(phaseDir, outP) },
      });
      ok++;
    }
  } finally {
    if (reused && page && !keepTab) await page.close().catch(() => {});   // the ONE run tab stays open across invocations
    await browser.close().catch(() => {});
  }
  console.log(`${unreachable ? "⚠" : "✓"} dom-snapshot: ${ok}/${blocks.length} block(s) captured${unreachable ? `, ${unreachable} state-unreachable (recorded, not skipped)` : ""} → ${path.relative(process.cwd(), outDir)}`);
  process.exit(unreachable ? 2 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

#!/usr/bin/env node
// composed-audit.mjs — JUDGE VISION GATE (what a human demo-fix prompt actually sees).
//
// Problem this fixes: appearance/*.json were marked clean with unresolved:[] while the UI
// was still far from the design. Judge then emitted workOrderP0:[]. This script FORCES
// composed defects from (1) live DOM probes and (2) significant visual-diff regions vs
// the Figma frame — and rewrites appearance artifacts so emit-judge-defects gets P0 rows.
//
// Usage:
//   node scripts/composed-audit.mjs <phaseDir> --url <appUrl> --connect <ws>
//        [--block <id>] [--skip-visual]
// Exit 0 = no unresolved composed defects
// Exit 2 = one or more composed defects (appearance + composed-audit.json written)

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { loadProbeExpectations } from "./judge-probe-expectations.mjs";

const require = createRequire(import.meta.url);
const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    "playwright-core",
    path.join(process.env.HOME || "", ".claude/skills/gstack/node_modules/playwright-core/index.js"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const mod = c.startsWith("/") || c.startsWith(".") ? require(c) : await import(c);
      const pw = mod.default || mod;
      if (pw.chromium) return pw.chromium;
    } catch { /* try next */ }
  }
  throw new Error("playwright-core not found — set $PLAYWRIGHT_CORE or npm i -D playwright-core");
}

export const DEMO_PROBE = `async function(DESIGN_EXPECT){
  // DESIGN_EXPECT = { fonts:[], byId:{ id: { expected, tolerance, expectedSource, designPath, match? } } }
  // Every numeric/text expectation MUST carry expectedSource from plan-style / plan-fills — never live-DOM.
  const EXPECTED_FONTS = (DESIGN_EXPECT && DESIGN_EXPECT.fonts) || [];
  const EX = (DESIGN_EXPECT && DESIGN_EXPECT.byId) || {};
  function designEv(id, extra) {
    const e = EX[id] || {};
    return Object.assign({ expected: e.expected, expectedSource: e.expectedSource || null, designPath: e.designPath || null, tolerance: e.tolerance }, extra || {});
  }
  function vis(el){ if(!el||!el.getBoundingClientRect) return false; const r=el.getBoundingClientRect(); const cs=getComputedStyle(el); return r.width>2 && r.height>2 && cs.display!=='none' && cs.visibility!=='hidden'; }
  function box(el){ if(!el) return null; const r=el.getBoundingClientRect(); return {w:Math.round(r.width),h:Math.round(r.height),x:Math.round(r.x),y:Math.round(r.y)}; }
  function q(sel){ try { return [...document.querySelectorAll(sel)]; } catch(e){ return []; } }
  function qv(sel){ return q(sel).filter(vis); }
  function firstVis(sel){ return qv(sel)[0] || null; }
  function radiusPx(el){ if(!el) return 0; const cs=getComputedStyle(el); return Math.max(parseFloat(cs.borderTopLeftRadius)||0, parseFloat(cs.borderRadius)||0); }
  function borderPx(el){ if(!el) return 0; const cs=getComputedStyle(el); return Math.max(parseFloat(cs.borderTopWidth)||0, parseFloat(cs.borderLeftWidth)||0); }
  // Card ring may be border OR box-shadow ring (e.g. rgb(...) 0px 0px 0px 1px).
  function ringPx(el){
    if (!el) return 0;
    const bw = borderPx(el);
    const sh = getComputedStyle(el).boxShadow || '';
    if (!sh || sh === 'none') return bw;
    let shadowRing = 0;
    for (const m of sh.matchAll(/0px\s+0px\s+0px\s+(\d+(?:\.\d+)?)px/g)) {
      shadowRing = Math.max(shadowRing, parseFloat(m[1]) || 0);
    }
    return Math.max(bw, shadowRing);
  }
  function containsBox(outer, inner){ if(!outer||!inner) return false; return inner.x>=outer.x-2 && inner.y>=outer.y-2 && (inner.x+inner.w)<=(outer.x+outer.w)+2 && (inner.y+inner.h)<=(outer.y+outer.h)+2; }

  // open sidebar if collapsed
  const rail = firstVis('.hw-rail') || document.querySelector('.hw-rail');
  if (rail && (rail.getBoundingClientRect().width < 50)) {
    const tog = firstVis('.hw-sidebar-toggle') || document.querySelector('.hw-sidebar-toggle, [aria-label*="comment" i]');
    if (tog) tog.click();
    await new Promise(r => setTimeout(r, 500));
  }

  // Leave inline Reply / thread-detail view so list chrome is what we audit
  const replyBack = [...document.querySelectorAll('button, [role="button"], a')].find(el => {
    if (!vis(el)) return false;
    const t = (el.textContent || '').trim();
    return /^reply$/i.test(t) && el.querySelector('svg') && el.getBoundingClientRect().y < 120;
  });
  // Prefer an explicit back control near a Reply header
  const backBtn = firstVis('[aria-label*="back" i], .vc-back, button[class*="back"]')
    || [...document.querySelectorAll('button, [role="button"]')].find(el => {
      if (!vis(el)) return false;
      const r = el.getBoundingClientRect();
      return r.y < 100 && r.width <= 40 && r.height <= 40 && /reply/i.test((el.closest('.vc-panel, app-comment-sidebar-panel') || document.body).innerText.slice(0, 80));
    });
  if (backBtn) { backBtn.click(); await new Promise(r => setTimeout(r, 400)); }
  void replyBack;

  // ALWAYS first VISIBLE — duplicate hidden .vc-panel/.vc-header shells are common false fails
  const panel = firstVis('app-comment-sidebar-panel') || firstVis('.vc-panel') || firstVis('.hw-rail-inner') || firstVis('.hw-rail');
  const list = firstVis('.vc-list') || firstVis('app-comment-sidebar-list');
  const pageComposer = firstVis('app-comment-sidebar-page-mode-composer') || firstVis('.velt-sidebar-page-mode-composer') || firstVis('[class*="page-mode-composer"]');
  const pageInput = pageComposer && (pageComposer.querySelector('[contenteditable], .velt-composer-input--message, textarea, input'));
  const moreReply = qv('.vc-more-reply, velt-comment-dialog-more-reply-internal, [class*="more-reply"]');
  // Prefer the PAINTED wireframe .vc-body (ring lives here after DEMO-POLISH grouping).
  // Do NOT prefer empty velt-comment-dialog-body-internal hosts — they wrap .vc-body
  // and win a naive outermost filter, false-failing card-border (radius 0 / no ring).
  // Never mix body + nested thread-card (gap:-88 class of bug).
  const cards = (() => {
    const painted = qv('.vc-body').filter((el) => {
      const hasThread = !!el.querySelector('velt-comment-dialog-thread-card-internal, .vc-card');
      return hasThread || ringPx(el) >= 1 || radiusPx(el) >= 4;
    });
    const top = painted.filter((b) => !painted.some((o) => o !== b && o.contains(b)));
    if (top.length) return top;
    const hosts = qv('velt-comment-dialog-thread-card-internal');
    if (hosts.length) return hosts;
    return qv('.vc-card');
  })();
  const replies = qv('.vc-reply, .vc-togglereply, [class*="toggle-reply"]');
  const headerTitle = firstVis('.vc-header-title') || firstVis('.vc-header h1, .vc-header h2, [class*="sidebar-header"] [class*="title"]');

  // hover first card to reveal actions
  let optionsAfterHover = { count: 0, sized: 0 };
  if (cards[0]) {
    cards[0].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    cards[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    const opts = qv('.vc-options, .vc-options-trigger, [class*="options-dropdown"]');
    optionsAfterHover = {
      count: opts.length,
      sized: opts.filter(o => { const b = o.getBoundingClientRect(); return b.width >= 12 && b.height >= 12; }).length,
    };
  }

  const listBox = list ? list.getBoundingClientRect() : null;
  const listScrolls = !!(list && list.scrollHeight > list.clientHeight + 8);
  const pagePhAttr = pageInput ? (pageInput.getAttribute('data-placeholder') || pageInput.getAttribute('placeholder') || pageInput.getAttribute('aria-placeholder') || '') : '';
  const pageBox = box(pageComposer);
  const pageInputBox = box(pageInput);

  // painted composer chrome: find the visible bordered pill (host or child)
  let composerPill = null;
  if (pageComposer) {
    const candidates = [pageComposer, ...qv('.velt-sidebar-page-mode-composer, .velt-composer, [class*="composer"]')].filter(vis);
    for (const c of candidates) {
      if (borderPx(c) >= 1 || radiusPx(c) >= 8) { composerPill = c; break; }
    }
    if (!composerPill) composerPill = pageComposer;
  }
  const pillBox = box(composerPill);
  const pillRadius = radiusPx(composerPill);
  const pillBorder = borderPx(composerPill);
  const avatarsInComposer = pageComposer ? [...pageComposer.querySelectorAll('img, [class*="avatar"], .velt-avatar')].filter(vis) : [];
  const avatarInsidePill = !!(composerPill && avatarsInComposer.some(a => containsBox(pillBox, box(a))));

  // placeholder must be PAINTED (attribute alone is not enough — classic silent miss)
  let placeholderPainted = false;
  if (pageInput) {
    const t = (pageInput.textContent || '').trim();
    if (!t && /comment|tag|@/i.test(pagePhAttr)) {
      // empty contenteditable with placeholder attr — check ::before/::after or sibling placeholder node
      const phNode = pageComposer && [...pageComposer.querySelectorAll('[class*="placeholder"], .velt-composer-placeholder')].find(vis);
      if (phNode && /comment|tag|@/i.test(phNode.textContent || '')) placeholderPainted = true;
      else {
        // computed: many SDKs paint via attr + CSS; accept if input empty AND attr ok AND pill wide enough
        // still require a visible gray placeholder string in the composer bounding box via tree walker
        const walkerText = (pageComposer.innerText || '');
        placeholderPainted = /comment or tag|tag others/i.test(walkerText);
      }
    } else if (/comment|tag|@/i.test(t)) placeholderPainted = true;
  }

  const checks = [];
  function fail(id, detail, evidence){ checks.push({ id, status: 'fail', detail, evidence }); }
  function pass(id, detail, evidence){ checks.push({ id, status: 'pass', detail, evidence }); }

  const bodyText = (panel && panel.innerText) || '';

  if (!panel || !vis(panel)) fail('sidebar-panel-visible', 'comments sidebar panel not visible', { panel: !!panel });
  else pass('sidebar-panel-visible', 'panel visible', box(panel));

  // Sidebar shape — design often has a large bottom (or all-corner) radius on the panel shell
  if (panel && vis(panel)) {
    const cs = getComputedStyle(panel);
    const br = Math.max(
      parseFloat(cs.borderBottomLeftRadius) || 0,
      parseFloat(cs.borderBottomRightRadius) || 0,
      parseFloat(cs.borderRadius) || 0
    );
    // Also check painted parent (.hw-rail) — radius may live on host shell
    const rail = firstVis('.hw-rail') || panel.parentElement;
    const rcs = rail ? getComputedStyle(rail) : null;
    const railBr = rcs ? Math.max(parseFloat(rcs.borderBottomLeftRadius)||0, parseFloat(rcs.borderRadius)||0) : 0;
    const best = Math.max(br, railBr);
    if (best < 8) fail('sidebar-shape-radius', 'sidebar panel shell lacks design corner radius (flat rectangle)', { panelBr: br, railBr, box: box(panel) });
    else pass('sidebar-shape-radius', 'sidebar has corner radius', { best });
  }

  if (!headerTitle || !vis(headerTitle)) fail('header-title-visible', 'Comments header title not visible (0×0 shell common)', { title: !!headerTitle });
  else pass('header-title-visible', 'header title visible', { ...box(headerTitle), fontSize: getComputedStyle(headerTitle).fontSize, text: (headerTitle.textContent||'').trim().slice(0,40) });

  // Header layout: design = title LEFT + filter RIGHT on SAME row (not filter stacked under title)
  const filterBtn = firstVis('.vc-filter, [class*="filter"] button, button[aria-label*="ilter" i]') || firstVis('[class*="filter"]');
  const filterIcon = firstVis('.vc-filter svg, [class*="filter"] svg, button[aria-label*="ilter" i] svg') || filterBtn;
  if (headerTitle && filterIcon && vis(headerTitle) && vis(filterIcon)) {
    const tb = box(headerTitle), fb = box(filterIcon);
    const sameRow = Math.abs(tb.y - fb.y) <= 12;
    const filterOnRight = fb.x > tb.x + tb.w + 40;
    if (!sameRow || !filterOnRight) {
      fail('header-row-layout', 'header filter not on same row / right of title (design: title left, filter right)', { title: tb, filter: fb, sameRow, filterOnRight });
    } else pass('header-row-layout', 'header title+filter same row, filter right', { title: tb, filter: fb });
  }

  // Typeface: design is sans; browser default serif on "Comments" is an obvious miss
  if (headerTitle && vis(headerTitle)) {
    const ff = (getComputedStyle(headerTitle).fontFamily || '').toLowerCase();
    if (/times|georgia|garamond|serif/.test(ff) && !/sans-serif/.test(ff)) {
      fail('header-font-sans', 'Comments title uses serif/default font — design is sans-serif', { fontFamily: ff });
    } else pass('header-font-sans', 'header font not obvious serif', { fontFamily: ff.slice(0, 80) });
  }

  // F7 — FONT PROBE: enumerate the FontFaceSet vs the plan's expected families.
  // fonts.check() returns true for unknown families — read document.fonts directly.
  // Catches "Poppins not loaded at all" (fallback-stack text renders Inter; bare-family
  // stacks render Times serif) — trap id renders-serif → Builder font-verify-and-fit shim.
  {
    const loadedFamilies = [];
    try { document.fonts.forEach(function(f){ if (f.status === 'loaded') loadedFamilies.push(String(f.family).replace(/["']/g, '')); }); } catch (e) {}
    const uniqLoaded = [...new Set(loadedFamilies)];
    const expected = (EXPECTED_FONTS || []).filter(Boolean);
    if (expected.length) {
      const missingFaces = expected.filter(function(f){ return !uniqLoaded.some(function(l){ return l.toLowerCase() === f.toLowerCase(); }); });
      const samples = [
        ['header', headerTitle],
        ['name', cards[0] && cards[0].querySelector('.vc-name, [class*="name"]')],
        ['message', cards[0] && cards[0].querySelector('.vc-message, [class*="message"]')],
        ['timestamp', cards[0] && cards[0].querySelector('.vc-time, [class*="time"], [class*="timestamp"]')],
        ['reply', replies[0]],
        ['show-replies', moreReply[0]],
        ['composer-input', pageInput],
      ];
      const offenders = [];
      for (const s of samples) {
        const label = s[0], el = s[1];
        if (!el || !vis(el)) continue;
        const stack = getComputedStyle(el).fontFamily || '';
        const first = stack.split(',')[0].replace(/["']/g, '').trim();
        const genericOnly = /^(serif|sans-serif|monospace|system-ui|ui-serif|cursive|fantasy)$/i.test(first);
        const firstLoaded = uniqLoaded.some(function(l){ return l.toLowerCase() === first.toLowerCase(); });
        if (genericOnly || (expected.some(function(f){ return f.toLowerCase() === first.toLowerCase(); }) && !firstLoaded)) {
          offenders.push({ el: label, fontFamily: stack.slice(0, 80), firstFamily: first, faceLoaded: firstLoaded });
        }
      }
      if (missingFaces.length || offenders.length) {
        fail('renders-serif', 'design font face(s) not loaded — text renders in fallback stack (missing: ' + (missingFaces.join(', ') || 'per-element fallback') + ')', { expectedFamilies: expected, loadedFamilies: uniqLoaded.slice(0, 20), missingFaces, offenders });
      } else {
        pass('renders-serif', 'all expected font faces loaded', { expectedFamilies: expected, loadedFamilies: uniqLoaded.slice(0, 20) });
      }
    }
  }

  // Avatar must be a circle, not a clipped square over a circular ghost.
  // Verified miss: outer .vc-avatar can be 20×20 + 999px while a child paints 20×32 @ radius 0.
  function avatarRoundOk(el) {
    if (!el || !vis(el)) return { ok: false, reason: 'missing' };
    const offenders = [];
    const nodes = [el, ...el.querySelectorAll('*')].filter(vis).slice(0, 12);
    for (const n of nodes) {
      const b = box(n);
      const cs = getComputedStyle(n);
      const br = Math.max(parseFloat(cs.borderTopLeftRadius)||0, parseFloat(cs.borderRadius)||0);
      const roundEnough = br >= Math.min(b.w, b.h) / 2 - 1 || /50%|999/.test(cs.borderRadius);
      const tallSquare = b.h >= b.w * 1.2 && b.w >= 12;
      const bg = cs.backgroundColor || '';
      const paints = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
      if (tallSquare && (!roundEnough || paints)) {
        offenders.push({ cls: (n.className||'').toString().slice(0,40), box: b, borderRadius: cs.borderRadius, bg });
      }
    }
    const root = box(el);
    const rcs = getComputedStyle(el);
    const rootRound = Math.max(parseFloat(rcs.borderTopLeftRadius)||0, parseFloat(rcs.borderRadius)||0) >= Math.min(root.w, root.h) / 2 - 1
      || /50%|999/.test(rcs.borderRadius);
    if (offenders.length) return { ok: false, reason: 'square-child-paint', offenders, root };
    if (!rootRound && root.w >= 12) return { ok: false, reason: 'not-round', box: root, borderRadius: rcs.borderRadius };
    return { ok: true, box: root, borderRadius: rcs.borderRadius };
  }
  const avInComposer = pageComposer ? [...pageComposer.querySelectorAll('[class*="avatar"], .velt-avatar, img')].filter(vis)[0] : null;
  const cardAv = cards[0] && [...cards[0].querySelectorAll('[class*="avatar"], .velt-avatar, img, .vc-avatar')].filter(vis)[0];
  for (const [id, el] of [['composer-avatar-circle', avInComposer], ['card-avatar-circle', cardAv]]) {
    if (!el) { checks.push({ id, status: 'na', detail: 'avatar not found', evidence: {} }); continue; }
    const r = avatarRoundOk(el);
    if (!r.ok) fail(id, 'avatar is not a clean circle (square clip / wrong radius) — obvious vs design', r);
    else pass(id, 'avatar circular', r);
  }

  // Composer avatar inset — jammed into top/left border is the crop bug
  if (pageComposer && avInComposer && composerPill) {
    const pb = box(composerPill), ab = box(avInComposer);
    const insetX = ab.x - pb.x, insetY = ab.y - pb.y;
    if (insetX < 4 || insetY < 4) fail('composer-avatar-inset', 'composer avatar jammed into pill edge (no inset)', { insetX, insetY, avatar: ab, pill: pb });
    else pass('composer-avatar-inset', 'composer avatar has inset', { insetX, insetY });
  }

  if (!pageComposer || !pageBox || pageBox.h < 24) fail('page-mode-composer-visible', 'page-mode composer missing or ~0 height', { box: pageBox });
  else pass('page-mode-composer-visible', 'page-mode composer has height', pageBox);

  if (!pageInput || !pageInputBox || pageInputBox.w < 40) fail('page-mode-composer-input', 'page-mode composer has no typeable input', { input: !!pageInput, box: pageInputBox });
  else pass('page-mode-composer-input', 'page-mode input present', pageInputBox);

  if (!/comment|tag|@/i.test(String(pagePhAttr))) fail('page-mode-composer-placeholder', 'page-mode placeholder attr missing/wrong', { placeholder: pagePhAttr });
  else pass('page-mode-composer-placeholder', 'placeholder attr ok', { placeholder: pagePhAttr });

  if (!placeholderPainted) fail('composer-placeholder-painted', 'composer placeholder not visibly painted in UI (attr alone is insufficient)', { attr: pagePhAttr, innerTextSample: (pageComposer && pageComposer.innerText || '').slice(0,80) });
  else pass('composer-placeholder-painted', 'placeholder text visible in composer', {});

  // Design: rounded bordered pill with avatar INSIDE. Live often ships square/0-radius or avatar outside.
  if (!composerPill || pillRadius < 8 || pillBorder < 1) {
    fail('composer-pill-chrome', 'composer is not a rounded bordered pill (radius/border)', { radius: pillRadius, border: pillBorder, box: pillBox });
  } else pass('composer-pill-chrome', 'composer pill has radius+border', { radius: pillRadius, border: pillBorder, box: pillBox });

  if (avatarsInComposer.length && !avatarInsidePill) fail('composer-avatar-inside-pill', 'composer avatar not inside the bordered pill', { avatars: avatarsInComposer.length, pill: pillBox });
  else if (!avatarsInComposer.length) fail('composer-avatar-inside-pill', 'composer avatar missing', {});
  else pass('composer-avatar-inside-pill', 'avatar inside pill', {});

  // nested border / double wrapper
  let doubleBorder = false;
  if (pageComposer) {
    const bordered = [pageComposer, ...pageComposer.querySelectorAll('div')].filter(vis).filter(el => borderPx(el) >= 1 && el.getBoundingClientRect().height > 20);
    if (bordered.length >= 2) {
      const a = bordered[0].getBoundingClientRect(), b = bordered[1].getBoundingClientRect();
      if (Math.abs(a.width - b.width) < 24 && Math.abs(a.height - b.height) < 24) doubleBorder = true;
    }
  }
  if (doubleBorder) fail('composer-one-pill', 'page-mode composer shows nested/double borders', {});
  else pass('composer-one-pill', 'no nested composer border detected', {});

  if (cards.length < 1) fail('thread-cards-present', 'no visible thread cards', { cards: cards.length });
  else pass('thread-cards-present', 'cards present', { cards: cards.length });

  // Card chrome: design shows bordered rounded cards; flat separators = broken card border.
  // Ring may live on annotation .vc-body (box-shadow) while per-comment rows stay borderless.
  if (cards[0]) {
    const c0 = cards[0];
    const cBorder = ringPx(c0);
    const cRadius = radiusPx(c0);
    const cs = getComputedStyle(c0);
    const nameEl = c0.querySelector('.vc-name, [class*="name"]');
    const msgEl = c0.querySelector('.vc-message, [class*="message"]');
    const nameBox = box(nameEl);
    const msgBox = box(msgEl);
    if (cBorder < 1 && cRadius < 4) fail('card-border-chrome', 'thread card has no visible border/radius (flat divider list)', { border: cBorder, radius: cRadius, box: box(c0) });
    else pass('card-border-chrome', 'card has border or radius', { border: cBorder, radius: cRadius });

    // Structure: design stacks avatar/name/message/reply vertically — short row OR message not below name
    const stacked = !!(nameBox && msgBox && msgBox.y >= nameBox.y + 8);
    if ((cs.flexDirection === 'row' && box(c0).h < 72) || (nameBox && msgBox && !stacked)) {
      fail('card-stack-structure', 'thread card does not stack name above message (collapsed single-line / wrong flex)', { flexDirection: cs.flexDirection, box: box(c0), nameBox, msgBox });
    } else pass('card-stack-structure', 'card stacks name above message', { flexDirection: cs.flexDirection, box: box(c0) });

    // Reply should be inside the annotation card shell (.vc-body / card host), not a detached strip
    const replyInCard = !![...c0.querySelectorAll('.vc-reply, .vc-togglereply, [class*="toggle-reply"]')].filter(vis).length;
    if (!replyInCard && replies.length) fail('reply-inside-card-dom', 'Reply control is not a child of the thread card (detached between cards)', { cardText: (c0.innerText||'').slice(0,60) });
    else if (replyInCard) pass('reply-inside-card-dom', 'Reply is inside card DOM', {});
    else pass('reply-inside-card-dom', 'no reply controls to attach', {});

    // Card typography — oversized name/message vs design (~12–14px body)
    if (msgEl) {
      const fs = parseFloat(getComputedStyle(msgEl).fontSize) || 0;
      if (fs > 16) fail('card-typography', 'card message font-size oversized vs design template', { fontSize: fs });
      else pass('card-typography', 'message font-size in band', { fontSize: fs });
    }

    // Content grid: message should share a left edge with the name (not a large offset)
    if (nameBox && msgBox && Math.abs(msgBox.x - nameBox.x) > 28) {
      fail('content-alignment', 'message x-offset from name exceeds 28px (inconsistent content grid)', { nameBox, msgBox, dx: Math.abs(msgBox.x - nameBox.x) });
    } else if (nameBox && msgBox) {
      pass('content-alignment', 'message aligns with name column', { dx: Math.abs(msgBox.x - nameBox.x) });
    }
  }

  // Inter-annotation list gap — design-sourced from plan-style .vc-list gap (typically 16px).
  // Prefer list-item boxes (one per annotation). Falling back to .vc-body can false-fail
  // when nested/overlapping body hosts exist in the tree.
  {
    const gapEx = EX['list-gap'] || EX['comment-gap'];
    if (cards.length >= 2 && gapEx && typeof gapEx.expected === 'number') {
      const items = qv('app-comment-sidebar-list-item');
      const aEl = items[0] || cards[0];
      const bEl = items[1] || cards[1];
      const a = aEl.getBoundingClientRect();
      const b = bEl.getBoundingClientRect();
      const gap = Math.round(b.top - a.bottom);
      const tol = typeof gapEx.tolerance === 'number' ? gapEx.tolerance : 2;
      const id = 'list-gap';
      if (Math.abs(gap - gapEx.expected) > tol) {
        fail(id, 'list gap ' + gap + 'px off design expected ' + gapEx.expected + 'px', designEv(id, { gap, measured: gap }));
        // keep legacy alias row for emit mapCheckToBlocks
        fail('comment-gap', 'list gap ' + gap + 'px off design expected ' + gapEx.expected + 'px', designEv('list-gap', { gap, measured: gap }));
      } else {
        pass(id, 'list gap matches design', designEv(id, { gap, measured: gap }));
        pass('comment-gap', 'list gap matches design', designEv('list-gap', { gap, measured: gap }));
      }
    } else if (cards.length >= 2 && !gapEx) {
      fail('list-gap', 'no design-sourced list-gap expectation (plan-style .vc-list gap missing)', { expectedSource: null });
    }
  }

  // Major internal spacing — .vc-body gap from plan-style
  {
    const sp = EX['card-internal-spacing'];
    if (sp && typeof sp.expected === 'number' && cards[0]) {
      const cs = getComputedStyle(cards[0]);
      const gap = parseFloat(cs.gap) || parseFloat(cs.rowGap) || 0;
      const tol = typeof sp.tolerance === 'number' ? sp.tolerance : 2;
      if (Math.abs(gap - sp.expected) > tol) {
        fail('card-internal-spacing', 'card internal gap ' + gap + 'px off design ' + sp.expected + 'px', designEv('card-internal-spacing', { gap, measured: gap }));
      } else {
        pass('card-internal-spacing', 'card internal gap matches design', designEv('card-internal-spacing', { gap, measured: gap }));
      }
    }
  }

  // Single-card height near design value
  {
    const ch = EX['single-card-height'];
    if (ch && typeof ch.expected === 'number' && cards[0]) {
      const h = box(cards[0]).h;
      const tol = typeof ch.tolerance === 'number' ? ch.tolerance : 24;
      if (Math.abs(h - ch.expected) > tol) {
        fail('single-card-height', 'card height ' + h + 'px far from design ' + ch.expected + 'px', designEv('single-card-height', { height: h, measured: h }));
      } else {
        pass('single-card-height', 'card height near design', designEv('single-card-height', { height: h, measured: h }));
      }
    }
  }

  // Selected reply-composer placeholder (design replyPlaceholder)
  {
    const phEx = EX['selected-reply-placeholder'];
    if (phEx && phEx.expected) {
      const replyComposer = firstVis('.vc-composer:not(.vc-pagemode-composer-inner), velt-comment-dialog-composer-internal, [class*="comment-dialog"] .vc-composer');
      const input = replyComposer && (replyComposer.querySelector('[contenteditable], textarea, input, .vc-input, .vc-placeholder'));
      const attr = (input && (input.getAttribute('placeholder') || input.getAttribute('data-placeholder'))) || '';
      const text = ((replyComposer && replyComposer.innerText) || '') + ' ' + attr;
      const re = phEx.match ? new RegExp(String(phEx.match), 'i') : /reply\\s*to/i;
      const ok = re.test(text) || text.indexOf(String(phEx.expected).slice(0, 8)) >= 0;
      // Only fail when a selected/reply composer is actually open
      if (replyComposer && vis(replyComposer) && replyComposer.getBoundingClientRect().height > 20) {
        if (!ok) fail('selected-reply-placeholder', 'selected reply composer placeholder missing/wrong vs design', designEv('selected-reply-placeholder', { text: text.slice(0, 80), attr }));
        else pass('selected-reply-placeholder', 'selected reply placeholder matches design', designEv('selected-reply-placeholder', { text: text.slice(0, 80) }));
      } else {
        checks.push({ id: 'selected-reply-placeholder', status: 'na', detail: 'reply composer not open', evidence: designEv('selected-reply-placeholder', {}) });
      }
    }
  }

  // Connector line when replies / Show-N present — design draws a vertical thread connector
  if (moreReply.length || /show\\s+\\d+\\s+replies/i.test(bodyText || '')) {
    const connectors = qv('[class*="connector"], [class*="thread-line"], .vc-connector, svg[class*="line"]').filter(el => {
      const r = el.getBoundingClientRect();
      return r.height >= 16 && r.width <= 8;
    });
    if (!connectors.length) fail('connector-line', 'thread connector line missing on multi-reply threads', { moreReply: moreReply.length });
    else pass('connector-line', 'connector-like element present', { n: connectors.length });
  }

  // Composer height band (design pill ~40–48; >64 is the "too tall" gold miss)
  if (pageBox && pageBox.h > 64) fail('composer-height', 'page-mode composer taller than design pill', pageBox);
  else if (pageBox) pass('composer-height', 'composer height in band', pageBox);

  // Header typography
  if (headerTitle && vis(headerTitle)) {
    const fs = parseFloat(getComputedStyle(headerTitle).fontSize) || 0;
    if (fs > 20) fail('header-typography', 'Comments header font-size oversized', { fontSize: fs });
    else pass('header-typography', 'header font-size in band', { fontSize: fs });
  }

  // Filter icon: must be a real glyph, not a solid black box
  const filterSvg = firstVis('.vc-filter svg, [class*="filter"] svg, button[aria-label*="ilter" i] svg');
  if (filterSvg) {
    const fb = box(filterSvg);
    const paths = filterSvg.querySelectorAll('path, line, polyline, circle').length;
    const fill = (filterSvg.getAttribute('fill') || getComputedStyle(filterSvg).fill || '').toLowerCase();
    if ((fb && (fb.w > 28 || fb.h > 28)) || (paths === 0 && /#000|black|rgb\\(0/.test(fill))) {
      fail('filter-icon-glyph', 'filter icon looks like a solid/oversized black mark', { box: fb, paths, fill });
    } else pass('filter-icon-glyph', 'filter icon present with paths', { box: fb, paths });
  } else {
    checks.push({ id: 'filter-icon-glyph', status: 'na', detail: 'no filter svg found', evidence: {} });
  }

  if (/show\\s+\\d+\\s+replies/i.test(bodyText) || moreReply.length) {
    if (!moreReply.length) fail('show-n-replies-control', 'Show N text/control not mounted as .vc-more-reply', { textHit: true, moreReply: 0 });
    else pass('show-n-replies-control', 'Show N control present', { moreReply: moreReply.length, box: box(moreReply[0]) });
  } else {
    checks.push({ id: 'show-n-replies-control', status: 'na', detail: 'no Show-N text in panel', evidence: { moreReply: moreReply.length } });
  }

  if (replies.length < 1) fail('reply-affordance-visible', 'no visible Reply / ToggleReply on unselected threads', { replies: 0 });
  else {
    pass('reply-affordance-visible', 'reply affordance visible', { replies: replies.length, box: box(replies[0]) });
    // Reply should sit inside its card, left-aligned — not a detached centered strip
    if (cards[0] && replies[0]) {
      const cb = box(cards[0]), rb = box(replies[0]);
      if (!containsBox(cb, rb) && Math.abs(rb.y - (cb.y + cb.h)) > 40) {
        fail('reply-inside-card', 'Reply control detached from card bounds', { card: cb, reply: rb });
      } else pass('reply-inside-card', 'Reply near/inside card', { card: cb, reply: rb });
    }
  }

  // PER-CONTROL hover reveal (Phase 2, step 5): the any-action form ("some action sized")
  // passed for six runs while the resolve button was absent — the kebab alone satisfied it.
  // Each control the hover frame shows must reveal INDIVIDUALLY. The any-action assertion
  // is deleted, not weakened.
  if (cards[0]) {
    const sizedOk = (el) => { const b = el.getBoundingClientRect(); return b.width >= 12 && b.height >= 12; };
    const resolveEls = qv('.vc-resolvebutton, .vc-resolve, velt-comment-dialog-resolve-button-internal, [class*="resolve-button"], [aria-label*="esolve" i]').filter(sizedOk);
    const optionEls = qv('.vc-options, .vc-options-trigger, [class*="options-dropdown"]').filter(sizedOk);
    if (resolveEls.length < 1) fail('hover-reveal-resolve', 'Resolve control not revealed (≥12px) after card hover — kebab alone is NOT a pass', { resolve: resolveEls.length, options: optionEls.length });
    else pass('hover-reveal-resolve', 'resolve revealed on hover', { resolve: resolveEls.length });
    if (optionEls.length < 1) fail('hover-reveal-options', 'options/kebab not revealed (≥12px) after card hover', { options: optionEls.length });
    else pass('hover-reveal-options', 'options revealed on hover', { options: optionEls.length });
  }

  // Subtle paint — shadow / ring (quiet misses the glance often skips)
  if (composerPill || pageComposer) {
    const el = composerPill || pageComposer;
    const sh = getComputedStyle(el).boxShadow || 'none';
    if (!sh || sh === 'none') fail('paint-composer-shadow', 'composer missing box-shadow (subtle paint)', { boxShadow: sh });
    else pass('paint-composer-shadow', 'composer has box-shadow', { boxShadow: sh.slice(0, 80) });
  }
  if (cards[0]) {
    const ring = ringPx(cards[0]);
    const br = getComputedStyle(cards[0]).borderTopColor;
    if (ring < 1) fail('paint-card-ring', 'card missing border/ring paint token', { ring, borderTopColor: br });
    else pass('paint-card-ring', 'card ring/border present', { ring, borderTopColor: br });
  }

  // (resolve-on-hover is covered per-control above — the combined resolve-OR-options form
  //  was the any-action assertion this fix deletes.)

  if (list && listBox && listBox.height > 80 && !listScrolls && cards.length >= 3) {
    fail('sidebar-list-scrolls', 'list does not scroll with multiple cards', { scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, cards: cards.length });
  } else if (list) {
    pass('sidebar-list-scrolls', listScrolls ? 'list scrollport active' : 'list present (few cards — scroll N/A)', { scrollHeight: list?.scrollHeight, clientHeight: list?.clientHeight, cards: cards.length });
  } else {
    fail('sidebar-list-scrolls', 'list element missing', {});
  }

  return { checks, meta: { cards: cards.length, replies: replies.length, moreReply: moreReply.length, pageBox, pagePhAttr, pillRadius, pillBorder } };
}`;

async function loadJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

/** Expected font families for the F7 probe — from the plan/spec, first family per stack. */
async function expectedFontFamilies(phaseDir) {
  const fams = new Set();
  for (const f of ["plan-style.json", "designSpec.json", "plan-fills-style.json"]) {
    let txt;
    try { txt = await fs.readFile(path.join(phaseDir, f), "utf8"); } catch { continue; }
    for (const m of txt.matchAll(/"(?:font-family|fontFamily)"\s*:\s*"([^"]+)"/g)) {
      const first = m[1].split(",")[0].replace(/["']/g, "").trim();
      if (first && !/^(serif|sans-serif|monospace|system-ui|ui-serif|cursive|fantasy|inherit|initial|unset|var\()/i.test(first)) {
        fams.add(first);
      }
    }
  }
  return [...fams].slice(0, 8);
}

function mapCheckToBlocks(checkId, blocks) {
  const all = blocks.map((b) => b.id);
  const notHeader = (id) => !/sidebar-header/i.test(id);
  if (/renders-serif/.test(checkId)) return all; // font loading is global — every block renders wrong
  if (/page-mode-composer|sidebar-panel|sidebar-list|sidebar-shape|composer-|header-|filter-icon/.test(checkId)) {
    return all.filter((id) => /flow|sidebar/i.test(id));
  }
  if (/show-n|more-reply/.test(checkId)) {
    const hit = all.filter((id) => /more-than-1|multiple/i.test(id));
    return hit.length ? hit : all.filter((id) => /thread|comment|flow/i.test(id) && notHeader(id));
  }
  if (/hover-actions/.test(checkId)) {
    return all.filter((id) => /hover|dialog|thread|flow/i.test(id) && notHeader(id));
  }
  if (/reply-|thread-cards|card-|content-alignment|comment-gap|list-gap|card-internal|single-card-height|selected-reply-placeholder|connector-line/.test(checkId)) {
    return all.filter((id) => /thread|dialog|flow|selected|replies|multiple/i.test(id) && notHeader(id));
  }
  return all.filter((id) => (/flow|thread|dialog/i.test(id)) && notHeader(id));
}

async function runVisualForBlock(phaseDir, blockId, livePng, framePng) {
  if (!(await exists(livePng)) || !(await exists(framePng))) return null;
  const outDir = path.join(phaseDir, "composed-audit", "diffs");
  await fs.mkdir(outDir, { recursive: true });
  const diffPng = path.join(outDir, `${blockId}.png`);
  const jsonOut = path.join(outDir, `${blockId}.json`);
  const r = spawnSync("node", [
    path.join(SCRIPTS, "visual-diff.mjs"), framePng, livePng,
    "--out", diffPng, "--json-out", jsonOut,
    "--threshold", "0.12", "--min-fill", "0.08", "--min-region", "80",
  ], { encoding: "utf8" });
  const doc = await loadJson(jsonOut);
  if (!doc) return { ok: false, error: r.stderr || r.stdout, regions: [] };
  const regions = (doc.regions || []).slice(0, 8);
  return { ok: regions.length === 0, regions, diffPct: doc.diffPct, diffPng, jsonOut };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const phaseDir = args.find((a, i) => !a.startsWith("--") && (i === 0 || !["--url", "--connect", "--block"].includes(args[i - 1])));
  const url = flag("--url");
  const ws = flag("--connect");
  const onlyBlock = flag("--block");
  const skipVisual = args.includes("--skip-visual");
  if (!phaseDir || !url || !ws) {
    console.error("usage: composed-audit.mjs <phaseDir> --url <url> --connect <ws> [--block id] [--skip-visual]");
    process.exit(1);
  }

  let chromium;
  try { chromium = await loadPlaywright(); }
  catch (e) { console.error("✗ " + e.message); process.exit(1); }

  const blocksDoc = await loadJson(path.join(phaseDir, "blocks.json")) || { blocks: [] };
  const blocks = (blocksDoc.blocks || []).filter((b) => !onlyBlock || b.id === onlyBlock);

  const browser = await chromium.connectOverCDP(ws.startsWith("http") ? ws : ws);
  const context = browser.contexts()[0] || await browser.newContext();
  let page = context.pages().find((p) => /localhost|127\\.0\\.0\\.1/.test(p.url())) || context.pages()[0];
  if (!page) page = await context.newPage();
  if (!page.url().includes(new URL(url).host)) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(800);

  // DEMO_PROBE is a function-source string — must IIFE it; bare `async function(){…}` returns undefined.
  // Design-sourced expectations (plan-style / plan-fills) — never live-DOM values.
  const designBundle = await loadProbeExpectations(phaseDir);
  const expectedFonts = designBundle.fonts.length ? designBundle.fonts : await expectedFontFamilies(phaseDir);
  const byId = {};
  for (const p of designBundle.probes) {
    byId[p.id] = p;
    for (const a of p.aliases || []) byId[a] = p;
  }
  const designExpect = { fonts: expectedFonts, byId };
  const probe = await page.evaluate(`(${DEMO_PROBE})(${JSON.stringify(designExpect)})`);
  // Stamp provenance on every check that has a design expectation
  for (const c of probe.checks || []) {
    const ex = byId[c.id];
    if (ex) {
      c.evidence = { ...(c.evidence || {}), expected: ex.expected, expectedSource: ex.expectedSource, designPath: ex.designPath, tolerance: ex.tolerance };
    }
  }
  const fails = (probe.checks || []).filter((c) => c.status === "fail");
  const auditDir = path.join(phaseDir, "composed-audit");
  await fs.mkdir(auditDir, { recursive: true });
  await fs.mkdir(path.join(phaseDir, "appearance"), { recursive: true });

  // Capture live panel screenshot — pick first VISIBLE match (hidden .vc-panel shells exist)
  const livePanelPath = path.join(auditDir, "live-panel.png");
  const panelHandle = await page.evaluateHandle(() => {
    const sels = ["app-comment-sidebar-panel", ".vc-panel", ".hw-rail-inner", ".hw-rail"];
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        if (r.width > 40 && r.height > 40 && getComputedStyle(el).visibility !== "hidden") return el;
      }
    }
    return null;
  });
  const panelEl = panelHandle.asElement();
  if (panelEl) {
    try { await panelEl.screenshot({ path: livePanelPath, timeout: 8000 }); }
    catch { await page.screenshot({ path: livePanelPath, fullPage: false }); }
  } else {
    await page.screenshot({ path: livePanelPath, fullPage: false });
  }

  // Phase 2: map state blocks → their guard-confirmed state captures (state-capture.mjs)
  const stateCapturesDoc = await loadJson(path.join(phaseDir, "state-captures.json"));
  const stateCaptureByBlock = {};
  for (const c of stateCapturesDoc?.captures || []) {
    if (!c.guard?.ok || !c.capture) continue;
    if (!(await exists(c.capture))) continue;
    for (const bid of c.blockIds || []) stateCaptureByBlock[bid] = c.capture;
  }

  const perBlock = {};
  for (const b of blocks) {
    const unresolved = [];
    for (const f of fails) {
      const targets = mapCheckToBlocks(f.id, blocks);
      if (!targets.includes(b.id)) continue;
      unresolved.push({
        id: f.id,
        issue: f.detail,
        summary: f.detail,
        kind: /hover|scroll|click/i.test(f.id) ? (/scroll/.test(f.id) ? "scroll" : "hover") : "pixel",
        evidence: f.evidence || null,
        source: "composed-audit.dom-probe",
      });
    }

    // Require Show-N on more-than-1 blocks even if panel text didn't match
    if (/more-than-1|multiple/i.test(b.id)) {
      const show = (probe.checks || []).find((c) => c.id === "show-n-replies-control");
      if (show && show.status !== "pass") {
        if (!unresolved.some((u) => u.id === "show-n-replies-control")) {
          unresolved.push({
            id: "show-n-replies-control",
            issue: show.detail || "Show N replies control missing on multi-reply block",
            summary: show.detail,
            kind: "pixel",
            evidence: show.evidence,
            source: "composed-audit.dom-probe",
          });
        }
      }
    }

    // Visual-diff per state (Phase 2): a state block with a guard-CONFIRMED state capture
    // diffs against ITS OWN capture (hover live vs hover frame). Comparing the undriven
    // resting panel to every state frame manufactured duplicate anonymous regions — that
    // path is gone: without a confirmed capture, a state block gets NO pixel diff at all
    // (the emit state-coverage gate demands the capture instead).
    const isFlow = b.role === "flow" || /^flow/i.test(b.id);
    const stateCap = (stateCaptureByBlock && stateCaptureByBlock[b.id]) || null;
    if (!skipVisual && (isFlow || onlyBlock || stateCap)) {
      const framePng = path.join(phaseDir, "frames", `${b.id}.png`);
      const captureCandidates = stateCap ? [stateCap] : [
        path.join(phaseDir, "results", b.id, "capture.png"),
        path.join(phaseDir, "results", b.id, "live.png"),
        livePanelPath,
      ];
      let livePng = stateCap || livePanelPath;
      for (const c of captureCandidates) { if (await exists(c)) { livePng = c; break; } }
      if (await exists(framePng)) {
        const vis = await runVisualForBlock(phaseDir, b.id, livePng, framePng);
        if (vis && !vis.ok && (vis.regions || []).length) {
          // Cap + require DOM named fails to exist; regions are supporting evidence for flow only
          for (const [i, r] of vis.regions.slice(0, 3).entries()) {
            unresolved.push({
              id: `visual-region-${i}`,
              issue: `significant visual diff vs Figma frame (${r.cssBox || r.w + "x" + r.h}, fill=${r.fill}) — convert via DEMO-POLISH`,
              summary: `visual region ${r.cssBox || ""}`,
              kind: "pixel",
              evidence: { region: r, diffPct: vis.diffPct, diffPng: vis.diffPng },
              source: "composed-audit.visual-diff",
            });
          }
        }
      }
    }

    const prev = (await loadJson(path.join(phaseDir, "appearance", `${b.id}.json`))) || {};
    const framePng = path.join(phaseDir, "frames", `${b.id}.png`);
    // F2: this audit just re-captured live-panel.png — a glance taken before this capture no
    // longer describes the pixels on disk. Mark needs-re-glance; NEVER delete/invalidate the
    // prior glance rows silently (they stay until the Judge re-records).
    const priorGlanceAt = Date.parse(prev.visionReviewedAt || 0) || 0;
    const needsReGlance = !!prev.visionReviewed && priorGlanceAt < Date.now() - 2000;
    // Keep Judge glance rows; replace only this script's prior mechanical rows
    const glanceKeep = (prev.unresolved || []).filter((u) => u && u.source === "composed-vision.glance");
    const merged = [...glanceKeep];
    for (const u of unresolved) {
      if (!merged.some((m) => m.id === u.id && m.source === u.source)) merged.push(u);
    }
    const doc = {
      ...prev,
      blockId: b.id,
      figmaFramePng: prev.figmaFramePng || ((await exists(framePng)) ? framePng : null),
      mockScreenshot: prev.mockScreenshot || null,
      // Phase 2: a state block's glance target is ITS OWN confirmed state capture —
      // the Judge Reads hover-live vs hover-frame, never resting-live vs hover-frame.
      liveScreenshot: stateCaptureByBlock[b.id] || livePanelPath,
      regions: merged.filter((u) => u.source === "composed-audit.visual-diff").map((u) => u.evidence?.region).filter(Boolean),
      unresolved: merged,
      disposition: merged.length ? "open" : (prev.visionReviewed ? "clean" : "open"),
      status: "appearance-reviewed",
      visionReviewed: prev.visionReviewed || false,
      visionReviewedAt: prev.visionReviewedAt || null,
      needsReGlance,
      composedAuditAt: new Date().toISOString(),
      at: new Date().toISOString(),
    };
    // Ban silent "resolved/clean" while probes fail
    if (merged.length) doc.disposition = "open";
    await fs.writeFile(path.join(phaseDir, "appearance", `${b.id}.json`), JSON.stringify(doc, null, 2) + "\n");
    perBlock[b.id] = { unresolved: merged.length, ids: merged.map((u) => u.id) };
  }

  const summary = {
    at: new Date().toISOString(),
    url,
    ok: fails.length === 0 && Object.values(perBlock).every((b) => b.unresolved === 0),
    probeFails: fails,
    checks: probe.checks,
    meta: probe.meta,
    blocks: perBlock,
    doctrine: "appearance cannot be clean while composed-audit has fails — Judge workOrderP0 must list these",
  };
  await fs.writeFile(path.join(phaseDir, "composed-audit.json"), JSON.stringify(summary, null, 2) + "\n");

  const nFail = fails.length;
  const nUnresolved = Object.values(perBlock).reduce((n, b) => n + b.unresolved, 0);
  if (!summary.ok) {
    console.error(`✗ composed-audit: ${nFail} probe fail(s), ${nUnresolved} appearance unresolved row(s)`);
    for (const f of fails) console.error(`  - ${f.id}: ${f.detail}`);
    for (const [id, b] of Object.entries(perBlock)) {
      if (b.unresolved) console.error(`  · ${id}: ${b.ids.join(", ")}`);
    }
    process.exit(2);
  }
  console.log(`✓ composed-audit: all probes pass, appearance unresolved cleared (${blocks.length} block(s))`);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

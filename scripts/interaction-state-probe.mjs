#!/usr/bin/env node
// interaction-state-probe.mjs — CDP probes for hover / selected / focus / click states
// plus subtle paint checks (shadow, border token, ring, hover background).
//
// Usage:
//   node scripts/interaction-state-probe.mjs <phaseDir> --url <url> --connect <ws> [--write]
// Exit 2 when any required interaction/paint check fails.

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { loadProbeExpectations } from "./judge-probe-expectations.mjs";

const require = createRequire(import.meta.url);

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    "playwright-core",
    path.join(process.env.HOME || "", ".claude/skills/gstack/node_modules/playwright-core/index.js"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const mod = c.startsWith("/") ? require(c) : await import(c);
      const pw = mod.default || mod;
      if (pw.chromium) return pw.chromium;
    } catch { /* next */ }
  }
  throw new Error("playwright-core not found");
}

async function loadJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

const BROWSER_PROBE = `async function(DESIGN){
  const EX = (DESIGN && DESIGN.byId) || {};
  const checks = [];
  const fail = (id, detail, evidence) => checks.push({ id, status: 'fail', detail, evidence, kind: 'interaction' });
  const pass = (id, detail, evidence) => checks.push({ id, status: 'pass', detail, evidence, kind: 'interaction' });
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  const qv = (sel) => [...document.querySelectorAll(sel)].filter(vis);
  const first = (sel) => qv(sel)[0] || null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ringPx = (el) => {
    if (!el) return 0;
    const cs = getComputedStyle(el);
    const b = ['Top','Right','Bottom','Left'].map((s) => parseFloat(cs['border'+s+'Width']) || 0);
    const border = Math.max(...b);
    const sh = cs.boxShadow || 'none';
    const m = sh.match(/0px\\s+0px\\s+0px\\s+(\\d+(?:\\.\\d+)?)px/);
    const ring = m ? parseFloat(m[1]) : 0;
    return Math.max(border, ring);
  };
  const shadowStrength = (el) => {
    const sh = getComputedStyle(el).boxShadow || 'none';
    if (!sh || sh === 'none') return 0;
    // crude: count shadow layers + blur
    const parts = sh.split(/,(?![^(]*\\))/);
    let score = parts.length;
    const blur = sh.match(/(\\d+(?:\\.\\d+)?)px\\s+(\\d+(?:\\.\\d+)?)px\\s+(\\d+(?:\\.\\d+)?)px/);
    if (blur) score += parseFloat(blur[3]) / 4;
    return score;
  };

  const card = first('.vc-body, velt-comment-dialog-thread-card-internal, .vc-card');
  const composer = first('.vc-pagemode-composer-inner, .vc-composer, app-comment-sidebar-page-mode-composer');

  // --- subtle paint (static) ---
  if (card) {
    const cs = getComputedStyle(card);
    const ring = ringPx(card);
    const radius = parseFloat(cs.borderRadius) || 0;
    if (ring < 1 && radius < 4) fail('paint-card-ring', 'card missing border/ring token', { ring, radius, borderColor: cs.borderTopColor });
    else pass('paint-card-ring', 'card has ring or radius', { ring, radius, borderColor: cs.borderTopColor });

    const borderEx = EX['card-border-token'];
    if (borderEx && borderEx.expected) {
      const live = (cs.borderTopColor || '').replace(/\\s/g, '');
      const exp = String(borderEx.expected).replace(/\\s/g, '');
      // loose: accept if either matches rgb/hex loosely
      const ok = live.toLowerCase().includes(exp.toLowerCase().slice(0, 8)) || exp.toLowerCase().includes(live.toLowerCase().slice(0, 8));
      if (!ok) fail('paint-border-token', 'card border color off design token', { live: cs.borderTopColor, expected: borderEx.expected, expectedSource: borderEx.expectedSource, designPath: borderEx.designPath });
      else pass('paint-border-token', 'border token ok', { live: cs.borderTopColor });
    }
  } else {
    fail('paint-card-ring', 'no card to measure paint', {});
  }

  if (composer) {
    const sh = shadowStrength(composer);
    if (sh < 0.5) fail('paint-composer-shadow', 'composer missing visible box-shadow', { shadow: getComputedStyle(composer).boxShadow });
    else pass('paint-composer-shadow', 'composer has shadow', { strength: sh });
  }

  // --- hover state ---
  let hoverBgBefore = null, hoverBgAfter = null;
  let resolveSized = 0, optionsSized = 0;
  if (card) {
    hoverBgBefore = getComputedStyle(card).backgroundColor;
    card.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await sleep(400);
    hoverBgAfter = getComputedStyle(card).backgroundColor;
    const resolve = qv('.vc-resolve, [class*="resolve"], [aria-label*="esolve" i]');
    const options = qv('.vc-options-trigger, .vc-options, [class*="options"]');
    resolveSized = resolve.filter((el) => { const b = el.getBoundingClientRect(); return b.width >= 10 && b.height >= 10; }).length;
    optionsSized = options.filter((el) => { const b = el.getBoundingClientRect(); return b.width >= 10 && b.height >= 10; }).length;
  }
  if (resolveSized < 1 && optionsSized < 1) {
    fail('interaction-hover-actions', 'resolve/options not sized after hover', { resolveSized, optionsSized });
  } else {
    pass('interaction-hover-actions', 'hover reveals actions', { resolveSized, optionsSized });
  }
  if (card && hoverBgBefore && hoverBgAfter && hoverBgBefore === hoverBgAfter) {
    // advisory soft — some designs have no hover tint
    checks.push({ id: 'paint-hover-background', status: 'na', detail: 'hover background unchanged (may be design-ok)', evidence: { hoverBgBefore, hoverBgAfter }, kind: 'interaction' });
  } else if (card) {
    pass('paint-hover-background', 'hover background changed', { hoverBgBefore, hoverBgAfter });
  }

  // --- selected state (look for --selected / selected class already in DOM) ---
  const selected = first('.vc-body--selected, [class*="--selected"], [data-selected="true"], .velt-selected');
  if (selected) {
    const ring = ringPx(selected);
    if (ring < 1) fail('interaction-selected-paint', 'selected card has no stronger ring/border', { ring });
    else pass('interaction-selected-paint', 'selected card paint ok', { ring });
    const replyPh = selected.querySelector('.vc-composer [placeholder], .vc-composer [data-placeholder], .vc-placeholder, [contenteditable]');
    const ph = replyPh && (replyPh.getAttribute('placeholder') || replyPh.getAttribute('data-placeholder') || replyPh.textContent || '');
    if (replyPh && !/reply/i.test(String(ph) + (selected.innerText || ''))) {
      fail('interaction-selected-reply-placeholder', 'selected reply composer placeholder missing', { ph: String(ph).slice(0, 60) });
    } else if (replyPh) {
      pass('interaction-selected-reply-placeholder', 'selected reply placeholder present', {});
    }
  } else {
    checks.push({ id: 'interaction-selected-paint', status: 'na', detail: 'no selected card in DOM', evidence: {}, kind: 'interaction' });
  }

  // --- focus state on page-mode composer input ---
  const input = first('.vc-pagemode-composer-inner [contenteditable], .vc-composer [contenteditable], textarea, input');
  if (input) {
    input.focus();
    await sleep(200);
    const cs = getComputedStyle(input);
    const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
    const ring = ringPx(input) >= 1 || ringPx(input.parentElement) >= 1;
    if (!outline && !ring) {
      fail('interaction-focus-state', 'focused composer input has no outline/ring', { outline: cs.outline, border: cs.borderTopWidth });
    } else {
      pass('interaction-focus-state', 'focus paint present', { outline: cs.outlineStyle, ring });
    }
    input.blur();
  } else {
    checks.push({ id: 'interaction-focus-state', status: 'na', detail: 'no composer input', evidence: {}, kind: 'interaction' });
  }

  // --- click state: click filter trigger if present; ensure it toggles aria/open ---
  const filterBtn = first('.vc-filter, .vc-filter-trigger, button[aria-label*="ilter" i]');
  if (filterBtn) {
    const before = filterBtn.getAttribute('aria-expanded') || filterBtn.getAttribute('data-state') || '';
    filterBtn.click();
    await sleep(300);
    const after = filterBtn.getAttribute('aria-expanded') || filterBtn.getAttribute('data-state') || '';
    const menu = first('[class*="filter"][class*="menu"], [class*="dropdown"], [role="menu"]');
    if (before === after && !menu) {
      fail('interaction-click-filter', 'filter click did not open menu / toggle state', { before, after, menu: !!menu });
    } else {
      pass('interaction-click-filter', 'filter click toggled UI', { before, after, menu: !!menu });
    }
    // close
    try { filterBtn.click(); } catch {}
  } else {
    checks.push({ id: 'interaction-click-filter', status: 'na', detail: 'no filter button', evidence: {}, kind: 'interaction' });
  }

  return { checks };
}`;

export async function runInteractionStateProbe(phaseDir, { url, ws, write = false } = {}) {
  if (!url || !ws) throw new Error("url and connect ws required");
  const chromium = await loadPlaywright();
  const designBundle = await loadProbeExpectations(phaseDir).catch(() => ({ probes: [], fonts: [] }));
  const byId = {};
  for (const p of designBundle.probes || []) {
    byId[p.id] = p;
    for (const a of p.aliases || []) byId[a] = p;
  }
  // Optional border token from plan-style
  const planStyle = await loadJson(path.join(phaseDir, "plan-style.json"));
  const body = (planStyle?.rules || []).find((r) => r.selector === ".vc-body");
  if (body?.decls?.border || body?.decls?.["border-color"]) {
    const raw = body.decls["border-color"] || String(body.decls.border).split(/\s+/).pop();
    byId["card-border-token"] = {
      id: "card-border-token",
      expected: raw,
      expectedSource: "plan-style.json",
      designPath: "rules[selector=.vc-body].decls.border-color|border",
    };
  }

  const browser = await chromium.connectOverCDP(ws.startsWith("http") ? ws : ws);
  try {
    const context = browser.contexts()[0] || await browser.newContext();
    let page = context.pages().find((p) => /localhost|127\.0\.0\.1/.test(p.url())) || context.pages()[0];
    if (!page) page = await context.newPage();
    if (!page.url().includes(new URL(url).host)) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    }
    await page.waitForTimeout(500);
    const probe = await page.evaluate(`(${BROWSER_PROBE})(${JSON.stringify({ byId })})`);
    const fails = (probe.checks || []).filter((c) => c.status === "fail");
    const doc = {
      at: new Date().toISOString(),
      url,
      checks: probe.checks,
      fails: fails.length,
      detector: "interaction",
    };
    if (write) {
      await fs.mkdir(path.join(phaseDir, "results"), { recursive: true });
      await fs.writeFile(path.join(phaseDir, "interaction-state-probe.json"), JSON.stringify(doc, null, 2) + "\n");
      // Merge fails into appearance/flow unresolved for emit
      const apPath = path.join(phaseDir, "appearance", "flow.json");
      const ap = (await loadJson(apPath)) || { blockId: "flow", unresolved: [] };
      for (const f of fails) {
        if (!(ap.unresolved || []).some((u) => u.id === f.id)) {
          ap.unresolved = ap.unresolved || [];
          ap.unresolved.push({
            id: f.id,
            issue: f.detail,
            kind: /hover|click|focus|selected/i.test(f.id) ? "hover" : "pixel",
            source: "interaction-state-probe",
            evidence: f.evidence,
          });
        }
      }
      await fs.mkdir(path.dirname(apPath), { recursive: true });
      await fs.writeFile(apPath, JSON.stringify(ap, null, 2) + "\n");
    }
    return doc;
  } finally {
    // do not close shared CDP browser — just exit
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const phaseDir = args.find((a, i) => !a.startsWith("--") && (i === 0 || !["--url", "--connect"].includes(args[i - 1])));
  const url = flag("--url");
  const ws = flag("--connect");
  const write = args.includes("--write");
  if (!phaseDir || !url || !ws) {
    console.error("usage: interaction-state-probe.mjs <phaseDir> --url <url> --connect <ws> [--write]");
    process.exit(1);
  }
  runInteractionStateProbe(phaseDir, { url, ws, write }).then((doc) => {
    console.log(JSON.stringify({ fails: doc.fails, checks: (doc.checks || []).map((c) => `${c.status}:${c.id}`) }, null, 2));
    process.exit(doc.fails ? 2 : 0);
  }).catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

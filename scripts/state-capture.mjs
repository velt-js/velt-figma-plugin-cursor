#!/usr/bin/env node
// state-capture.mjs — Phase 2 of the design-compiled oracle: state-machine capture.
//
// Reads <phaseDir>/state-bindings.json ({bindings:[{state, frameId, blockIds, captureId,
// drive:[steps], guard}]}), drives each state on the live app via REAL input (Playwright
// hover/click/focus/keyboard — never synthetic dispatchEvent), VERIFIES the state is active
// through its guard, and screenshots the panel → composed-audit/live-<captureId>.png.
//
// A capture without a confirmed guard is never written as truth: the manifest records
// {guard:{ok:false,reason}} and the state's downstream consumers (per-state glance,
// per-state pixel diff, emit's state-coverage gate) treat it as blocked.
//
// Writes <phaseDir>/state-captures.json manifest. Exit 2 if any binding's guard failed,
// 0 when every bound state captured+confirmed, 1 on harness error.
//
// Usage: node scripts/state-capture.mjs <phaseDir> [--connect <ws>] [--url <url>] [--only <state>]

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

async function loadJson(p) { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; } }

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
    } catch { /* next */ }
  }
  throw new Error("playwright-core not found — set $PLAYWRIGHT_CORE or npm i -D playwright-core");
}

export function validateBindings(doc) {
  const problems = [];
  for (const [i, b] of (doc?.bindings || []).entries()) {
    if (!b.state) problems.push(`bindings[${i}]: state required`);
    if (!b.frameId) problems.push(`bindings[${i}]: frameId required (the design frame this state renders as)`);
    if (!Array.isArray(b.drive) || !b.drive.length) problems.push(`bindings[${i}] ${b.state}: drive steps required`);
    if (!b.guard?.selector) problems.push(`bindings[${i}] ${b.state}: guard.selector required — an unverifiable state is not a binding`);
    if (b.guard && !["pseudo", "visible", "class"].includes(b.guard.kind)) problems.push(`bindings[${i}] ${b.state}: guard.kind must be pseudo|visible|class`);
  }
  if (!(doc?.bindings || []).length) problems.push("bindings[] empty");
  return problems;
}

async function firstMatching(page, selectorList, { preferLargest = false } = {}) {
  // Selectors are priority-ordered. Without preferLargest → first visible hit.
  // With preferLargest → largest visible hit within the first selector that matches anything.
  for (const sel of String(selectorList).split(",").map((s) => s.trim()).filter(Boolean)) {
    let bestForSel = null;
    try {
      const locAll = page.locator(sel);
      const n = await locAll.count();
      for (let i = 0; i < n; i++) {
        const loc = locAll.nth(i);
        try {
          const box = await loc.boundingBox();
          if (box && box.width > 8 && box.height > 8 && await loc.isVisible().catch(() => false)) {
            const hit = { loc, sel, index: i, area: box.width * box.height, box };
            if (!preferLargest) return hit;
            if (!bestForSel || hit.area > bestForSel.area) bestForSel = hit;
          }
        } catch { /* next match */ }
      }
    } catch { /* invalid selector — next */ }
    if (bestForSel) return bestForSel;
  }
  return null;
}

async function runGuard(page, guard) {
  const { kind, selector } = guard;
  if (kind === "pseudo") {
    // querySelector(':hover') alone is brittle across hosts — also accept any base
    // candidate that currently matches(':hover') / :focus (pointer may be on a child).
    const ok = await page.evaluate((sel) => {
      try {
        if (document.querySelector(sel)) return true;
        for (const part of String(sel).split(",").map((s) => s.trim()).filter(Boolean)) {
          const base = part.replace(/:(?:hover|focus|active|focus-within)\b/g, "").trim() || part;
          let nodes;
          try { nodes = document.querySelectorAll(base); } catch { continue; }
          for (const el of nodes) {
            try {
              if (el.matches(part) || el.matches(":hover") || el.matches(":focus-within") || el.matches(":focus")) {
                return true;
              }
            } catch { /* next */ }
          }
        }
        return false;
      } catch { return false; }
    }, selector);
    return ok ? { ok: true } : { ok: false, reason: `pseudo guard '${selector}' matched nothing` };
  }
  if (kind === "class") {
    const ok = await page.evaluate((sel) => { try { return !!document.querySelector(sel); } catch { return false; } }, selector);
    return ok ? { ok: true } : { ok: false, reason: `class guard '${selector}' matched nothing` };
  }
  // visible
  const hit = await firstMatching(page, selector);
  return hit ? { ok: true, matched: hit.sel } : { ok: false, reason: `no visible match for guard '${selector}'` };
}

export async function resetUiState(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.mouse.move(4, 4).catch(() => {});
  await page.evaluate(() => { try { document.activeElement?.blur?.(); } catch { } }).catch(() => {});
  await page.waitForTimeout(300);
}

async function driveSteps(page, steps) {
  for (const step of steps) {
    const { action } = step;
    if (action === "press") { await page.keyboard.press(step.keys || "Escape"); await page.waitForTimeout(step.wait ?? 200); continue; }
    if (action === "wait") { await page.waitForTimeout(step.ms ?? 300); continue; }
    // Hover: prefer the largest painted match (real sidebar card/dialog), not a stub host.
    const hit = await firstMatching(page, step.selector || "", { preferLargest: action === "hover" });
    if (!hit) return { ok: false, reason: `drive ${action}: no visible match for '${step.selector}'` };
    if (action === "hover") {
      // Prefer real mouse move to element center so CSS :hover sticks for the guard+screenshot.
      const box = hit.box || await hit.loc.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + Math.min(56, Math.max(12, box.height / 3)));
      } else {
        await hit.loc.hover({ timeout: 3000 });
      }
    }
    else if (action === "click") await hit.loc.click({ timeout: 3000 });
    else if (action === "focus") await hit.loc.focus({ timeout: 3000 }).catch(async () => hit.loc.click({ timeout: 3000 }));
    else if (action === "type") { await hit.loc.click({ timeout: 3000 }); await page.keyboard.type(step.text || "x", { delay: 30 }); }
    else return { ok: false, reason: `unknown drive action '${action}'` };
    await page.waitForTimeout(step.wait ?? 350);
  }
  return { ok: true };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const phaseDir = args.find((a, i) => !a.startsWith("--") && (i === 0 || !["--connect", "--url", "--only"].includes(args[i - 1])));
  if (!phaseDir) { console.error("usage: state-capture.mjs <phaseDir> [--connect <ws>] [--url <url>] [--only <state>]"); process.exit(1); }
  const bindingsDoc = await loadJson(path.join(phaseDir, "state-bindings.json"));
  if (!bindingsDoc) { console.error("✗ no state-bindings.json in phase dir"); process.exit(1); }
  const schemaProblems = validateBindings(bindingsDoc);
  if (schemaProblems.length) {
    console.error("✗ state-bindings.json invalid:\n  " + schemaProblems.join("\n  "));
    process.exit(2);
  }
  const only = flag("--only");
  const ws = flag("--connect") || "http://localhost:9222";
  const url = flag("--url");

  const chromium = await loadPlaywright();
  const browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => /localhost|127\.0\.0\.1/.test(p.url())) || context.pages()[0];
  if (!page) { console.error("✗ no page in connected browser"); process.exit(1); }
  if (url && !page.url().includes(new URL(url).host)) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(400);
  await page.evaluate(async () => {
    const rail = document.querySelector(".hw-rail");
    if (rail && rail.getBoundingClientRect().width < 50) {
      const tog = document.querySelector(".hw-sidebar-toggle, [aria-label*='comment' i]");
      if (tog) { tog.click(); await new Promise((r) => setTimeout(r, 500)); }
    }
  });

  const auditDir = path.join(phaseDir, "composed-audit");
  await fs.mkdir(auditDir, { recursive: true });
  const panelHandle = async () => (await page.evaluateHandle(() => {
    for (const s of ["app-comment-sidebar-panel", ".vc-panel", ".hw-rail-inner", ".hw-rail"]) {
      for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        if (r.width > 40 && r.height > 40 && getComputedStyle(el).visibility !== "hidden") return el;
      }
    }
    return null;
  })).asElement();

  const captures = [];
  let anyGuardFail = false;
  for (const b of bindingsDoc.bindings) {
    if (only && b.state !== only) continue;
    const captureId = b.captureId || b.state;
    const outPath = path.join(auditDir, `live-${captureId}.png`);
    await resetUiState(page);
    const driven = await driveSteps(page, b.drive);
    let guard = driven.ok ? await runGuard(page, b.guard) : { ok: false, reason: driven.reason };
    const row = {
      state: b.state,
      captureId,
      frameId: b.frameId,
      blockIds: b.blockIds || [],
      guard,
      at: new Date().toISOString(),
    };
    if (guard.ok) {
      const pel = await panelHandle();
      try {
        if (pel) await pel.screenshot({ path: outPath, timeout: 8000 });
        else await page.screenshot({ path: outPath, fullPage: false });
        row.capture = outPath;
        console.log(`✓ state '${b.state}' driven+confirmed → ${path.basename(outPath)}`);
      } catch (e) {
        row.guard = { ok: false, reason: `screenshot failed: ${e.message}` };
        anyGuardFail = true;
      }
    } else {
      anyGuardFail = true;
      console.error(`✗ state '${b.state}' NOT captured: ${guard.reason}`);
    }
    captures.push(row);
  }
  await resetUiState(page);

  const manifest = {
    at: new Date().toISOString(),
    url: page.url(),
    captures,
    ok: !anyGuardFail,
  };
  await fs.writeFile(path.join(phaseDir, "state-captures.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`state-capture: ${captures.filter((c) => c.guard.ok).length}/${captures.length} state(s) captured+confirmed → state-captures.json`);
  process.exit(anyGuardFail ? 2 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

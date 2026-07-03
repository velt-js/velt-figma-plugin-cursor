#!/usr/bin/env node
// measure-block.mjs — the ONE-COMMAND verification pipeline. The privado autopsy's #1 sink was the
// judge pipeline itself: ~129 min across 9 fresh-context agent visits, each hand-orchestrating
// reset → seed/drive → capture → visual-diff → 4 probes → report assembly, at 12-22 min per visit —
// and the builder's ad-hoc self-probes never predicted what that pipeline would flag, forcing ~1.8
// judge visits per block. This script IS that pipeline, end to end, in one command against a
// persistent browser:
//   * the BUILDER runs it as its self-probe — its feedback signal becomes IDENTICAL to the verdict
//     signal, so a PASS-candidate is already a measured PASS;
//   * the JUDGE runs (or re-runs) it fresh for the audit — same artifacts, same gate.
// maker≠checker still holds where it matters: every number here is SCRIPT-measured and persisted,
// report-block.mjs validates shapes, and the gate's artifact audit rejects hand-edits either way.
//
// Requires the Planner's per-block PROBE BRIEF (briefs/<blockId>.probes.json) with MACHINE-EXECUTABLE
// drive steps — prose steps ("focus the composer") can't be executed by a script:
//   { drive: { steps: [ {action, selector?, text?, key?, ms?, js?} ], assert: "<selector>" },
//     browser: <BROWSER_PROBE SPEC>, layer: <LAYER_PROBE SPEC or SPEC[]>,
//     contract: <CONTRACT_PROBE SPEC>, stability: <STABILITY_PROBE SPEC> }
// action vocabulary: click | dblclick | hover | type (selector+text) | press (key) |
//   waitFor (selector) | sleep (ms) | eval (js) | selectUser (text) | clear
// Selectors are resolved VISIBLE-FIRST (`sel >> visible=true`) — a 0-size registry twin never
// swallows a click.
//
// Usage:
//   node scripts/measure-block.mjs <phaseDir> <blockId> --url <appUrl>
//        [--connect <ws>] [--scale 2] [--timeout 30000] [--select-user u]
//        [--probes <file>] [--spec <file>] [--accept-glyph-residuals] [--no-report] [--structure-only]
//   node scripts/measure-block.mjs smoke <phaseDir> <familyId> --url <appUrl>
//        [--connect <ws>] [--spec-file <file>] [--timeout 30000] [--select-user u]
//
// Exit codes: 0 = pipeline ran, block measured CLEAN (diffCount 0) · 2 = ran, diffs found (count
// printed; feed it to block-iter record) · 3 = could not drive/measure (env or missing brief) · 1 = usage.
// smoke: 0 = all steps ok + no console errors · 2 = failures (smoke.json written either way).

import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BROWSER_PROBE, LAYER_PROBE, CONTRACT_PROBE, STABILITY_PROBE } from "./delta-compare.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

async function loadChromium() {
  const candidates = [process.env.PLAYWRIGHT_CORE, "playwright-core",
    path.join(process.env.HOME || "", ".claude/skills/gstack/node_modules/playwright-core/index.js")].filter(Boolean);
  for (const c of candidates) { try { const m = await import(c); return (m.default || m).chromium; } catch { /* next */ } }
  throw new Error("playwright-core not found — `npm i -D playwright-core` or set $PLAYWRIGHT_CORE");
}
async function acquireBrowser(chromium, connectWs) {
  if (!connectWs) return chromium.launch({ headless: true });
  const looksCdp = /^https?:|\/devtools\//.test(connectWs);
  try { return await (looksCdp ? chromium.connectOverCDP(connectWs) : chromium.connect({ wsEndpoint: connectWs })); }
  catch { return await (looksCdp ? chromium.connect({ wsEndpoint: connectWs }) : chromium.connectOverCDP(connectWs)); }
}
const vis = (page, sel) => page.locator(`${sel} >> visible=true`).first();

async function resetState(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => {
    for (const ed of document.querySelectorAll("[contenteditable]:not([contenteditable='false'])")) {
      if ((ed.textContent ?? "").length) { ed.focus(); document.execCommand("selectAll", false); document.execCommand("delete", false); }
    }
    document.activeElement?.blur?.();
    document.body?.click?.();
  }).catch(() => {});
  await page.waitForTimeout(400);
}

async function runSteps(page, steps, { timeout = 15000 } = {}) {
  for (const s of steps || []) {
    const a = s.action;
    if (a === "click") await vis(page, s.selector).click({ timeout });
    else if (a === "dblclick") await vis(page, s.selector).dblclick({ timeout });
    else if (a === "hover") await vis(page, s.selector).hover({ timeout });
    else if (a === "type") { if (s.selector) await vis(page, s.selector).click({ timeout }); await page.keyboard.type(s.text ?? "", { delay: 20 }); }
    else if (a === "press") await page.keyboard.press(s.key || s.text);
    else if (a === "waitFor") await page.waitForSelector(s.selector, { timeout: s.ms || timeout });
    else if (a === "sleep") await page.waitForTimeout(s.ms || 300);
    else if (a === "eval") await page.evaluate(`(async()=>{ ${s.js} })()`);
    else if (a === "clear") await resetState(page);
    else if (a === "selectUser") await page.evaluate(async (u) => {
      const sel = document.querySelector("select");
      if (sel) { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(sel, u); sel.dispatchEvent(new Event("change", { bubbles: true })); await new Promise((r) => setTimeout(r, 600)); }
    }, s.text);
    else throw new Error(`unknown drive action '${a}' (click|dblclick|hover|type|press|waitFor|sleep|eval|clear|selectUser)`);
  }
}

async function openPage(browser, url, { scale = 2, selectUser = null, timeout = 30000 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1512, height: 900 }, deviceScaleFactor: scale });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 300)));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  if (selectUser) await runSteps(page, [{ action: "selectUser", text: selectUser }]);
  return { page, consoleErrors };
}

const probeEval = (page, probe, spec) => page.evaluate(`${probe}(${JSON.stringify(spec)})`);

// ---------------------------------- measure (default mode) ----------------------------------
async function measure(phaseDir, blockId, opts) {
  const blocks = JSON.parse(await fs.readFile(path.join(phaseDir, "blocks.json"), "utf8"));
  const block = (blocks.blocks || []).find((b) => b.id === blockId);
  if (!block) { console.error(`✗ block '${blockId}' not in blocks.json`); process.exit(3); }

  const probesPath = opts.probes || path.join(phaseDir, "briefs", `${blockId}.probes.json`);
  const probes = JSON.parse(await fs.readFile(probesPath, "utf8").catch(() => "null"));
  if (!probes) { console.error(`✗ probe brief missing: ${probesPath}\n  The Planner must author machine-executable drive steps + probe SPECs per block (briefs/<blockId>.probes.json).`); process.exit(3); }
  const specPath = opts.spec
    || (await fs.access(path.join(phaseDir, "briefs", `${blockId}.spec.json`)).then(() => path.join(phaseDir, "briefs", `${blockId}.spec.json`), () => path.join(phaseDir, "designSpec.json")));

  const resDir = path.join(phaseDir, "results", blockId);
  await fs.mkdir(resDir, { recursive: true });
  const framePng = path.join(phaseDir, block.framePng);
  const shotPng = path.join(resDir, "shot.png");
  const liveSelector = probes.liveSelector || block.liveSelector;
  if (!liveSelector) { console.error(`✗ no liveSelector for '${blockId}' (blocks.json or the probe brief must set it)`); process.exit(3); }

  const chromium = await loadChromium();
  const browser = await acquireBrowser(chromium, opts.connect);
  let driven = false, consoleErrors = [];
  try {
    const o = await openPage(browser, opts.url, { scale: opts.scale, selectUser: opts.selectUser, timeout: opts.timeout });
    const page = o.page; consoleErrors = o.consoleErrors;
    await page.waitForSelector(liveSelector, { timeout: opts.timeout });
    await resetState(page);
    // DRIVE to the block's state, then prove it (a blank/default capture is the classic false-pass)
    try {
      await runSteps(page, probes.drive?.steps, { timeout: opts.timeout });
      if (probes.drive?.assert) { await page.waitForSelector(probes.drive.assert, { timeout: 10000 }); driven = true; }
      else driven = (probes.drive?.steps || []).length === 0;   // a stateless default block needs no drive
    } catch (e) {
      console.error(`✗ drive failed for '${blockId}': ${e.message}`);
      await fs.writeFile(path.join(resDir, "triage.json"), JSON.stringify({ error: String(e.message), consoleErrors, at: new Date().toISOString() }, null, 2));
      process.exit(3);
    }
    await page.waitForTimeout(500);

    // CAPTURE (device-res element PNG)
    const el = vis(page, liveSelector);
    await el.screenshot({ path: shotPng });

    if (opts.structureOnly) {
      // structural visit: capture + visual-diff only (gross-structure catch, before styling compounds)
      const vd = runVisualDiff({ framePng, shotPng, specPath, block, resDir, acceptGlyph: false });
      console.log(JSON.stringify({ mode: "structure-only", driven, regions: vd.regions?.length ?? -1, consoleErrors: consoleErrors.length }));
      process.exit((vd.regions || []).length ? 2 : 0);
    }

    // PROBES (live DOM, persisted verbatim)
    const put = async (name, obj) => { await fs.writeFile(path.join(resDir, name), JSON.stringify(obj, null, 2)); };
    const delta = probes.browser ? await probeEval(page, BROWSER_PROBE, probes.browser) : { ok: false, verdict: "FAIL", diffs: [{ note: "no BROWSER_PROBE spec in the probe brief" }] };
    delta.ok = typeof delta.ok === "boolean" ? delta.ok : delta.verdict === "PASS";
    await put("delta.json", delta);
    let reconciliation = null;
    if (probes.layer) {
      const specs = Array.isArray(probes.layer) ? probes.layer : [probes.layer];
      const plans = []; for (const s of specs) plans.push(await probeEval(page, LAYER_PROBE, s));
      reconciliation = specs.length === 1 ? plans[0] : { plans, ok: plans.every((p) => p.found !== false && !(p.neutralize || []).length && !p.ownerMismatch) };
      await put("reconciliation.json", reconciliation);
    }
    let contract = null;
    if (probes.contract) { contract = await probeEval(page, CONTRACT_PROBE, probes.contract); await put("contract.json", contract); }
    const stability = await probeEval(page, STABILITY_PROBE, probes.stability || { surfaceSelector: liveSelector, targets: [] });
    await put("stability.json", stability);
    await put("console.json", { consoleErrors, generatedAt: new Date().toISOString() });

    // VISUAL DIFF (child process — same CLI the docs name, artifacts identical)
    const vd = runVisualDiff({ framePng, shotPng, specPath, block, resDir, acceptGlyph: opts.acceptGlyph });

    // ASSEMBLE the report entry from the artifacts (script-written end to end)
    if (!opts.noReport) {
      const args = ["measure", phaseDir, blockId,
        "--capture", shotPng, "--frame", framePng,
        "--visual", path.join(resDir, "visual.json"), "--delta", path.join(resDir, "delta.json"),
        "--stability", path.join(resDir, "stability.json"),
        ...(reconciliation ? ["--reconciliation", path.join(resDir, "reconciliation.json")] : []),
        ...(contract ? ["--contract", path.join(resDir, "contract.json")] : []),
        ...(driven ? ["--driven"] : [])];
      const r = spawnSync("node", [path.join(SCRIPTS, "report-block.mjs"), ...args], { stdio: "inherit" });
      if (r.status !== 0) process.exit(3);
    }

    // summary → diffCount is what the builder feeds to `block-iter record`
    const sigRegions = (vd.regions || []).filter((r) => (r.fill ?? 1) >= 0.05);
    const deltaFails = delta.ok ? 0 : Math.max(1, (delta.diffs || []).length);
    const contractFails = contract && !contract.ok ? (contract.violations || []).length || 1 : 0;
    const stabilityFails = stability.ok ? 0 : 1;
    const diffCount = sigRegions.length + deltaFails + contractFails + stabilityFails;
    console.log(JSON.stringify({
      blockId, driven, diffCount,
      visual: { significantRegions: sigRegions.length, acceptedResiduals: (vd.acceptedResiduals || []).length },
      delta: { ok: delta.ok, diffs: (delta.diffs || []).length },
      contract: contract ? { ok: contract.ok, violations: (contract.violations || []).length } : null,
      stability: { ok: stability.ok }, consoleErrors: consoleErrors.length,
    }, null, 2));
    process.exit(diffCount === 0 && driven && consoleErrors.length === 0 ? 0 : 2);
  } finally {
    if (opts.connect) await browser.close().catch(() => {});
    else await browser.close();
  }
}

function runVisualDiff({ framePng, shotPng, specPath, block, resDir, acceptGlyph }) {
  const args = [path.join(SCRIPTS, "visual-diff.mjs"), framePng, shotPng,
    "--mask-text-from", specPath, "--mask-frame", block.figmaNodeId, "--min-fill", "0.05",
    "--out", path.join(resDir, "diff.png"), "--json-out", path.join(resDir, "visual.json")];
  if (block.frameRegion) args.push("--crop-ref", [block.frameRegion.x, block.frameRegion.y, block.frameRegion.w, block.frameRegion.h].join(","));
  if (acceptGlyph) args.push("--accept-glyph-residuals");
  const r = spawnSync("node", args, { encoding: "utf8" });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); throw new Error("visual-diff failed"); }
  return JSON.parse(r.stdout);
}

// ---------------------------------- smoke (per-family real paths, R30) ----------------------------------
// The harvey run's largest avoidable sink (~80 min): every seeded fixture passed while REAL interaction
// paths were broken — fixtures typed full-width text (masking a flex-end bug), never opened the POPOVER
// dialog context, and a min-height pinned to a 2-line fixture dead-banded 1-line real text. The smoke
// spec (Planner-authored per family) drives the real paths: short AND long text, every dialog context
// the surface appears in, every affordance once, a resize — asserting no error, no dead band, no shift.
async function smoke(phaseDir, familyId, opts) {
  const specPath = opts.specFile || path.join(phaseDir, "briefs", `${familyId}.smoke.json`);
  const spec = JSON.parse(await fs.readFile(specPath, "utf8").catch(() => "null"));
  if (!spec) { console.error(`✗ smoke spec missing: ${specPath} — the Planner authors one per family (R30)`); process.exit(3); }
  const outDir = path.join(phaseDir, "results", "smoke");
  await fs.mkdir(outDir, { recursive: true });
  const chromium = await loadChromium();
  const browser = await acquireBrowser(chromium, opts.connect);
  const results = [];
  let consoleErrors = [];
  try {
    const o = await openPage(browser, opts.url, { scale: 1, selectUser: opts.selectUser, timeout: opts.timeout });
    const page = o.page; consoleErrors = o.consoleErrors;
    for (const step of spec.steps || []) {
      const before = consoleErrors.length;
      try {
        await runSteps(page, step.actions, { timeout: opts.timeout });
        if (step.assert) await page.waitForSelector(step.assert, { timeout: 8000 });
        if (step.assertAbsent) {
          const still = await page.locator(`${step.assertAbsent} >> visible=true`).count();
          if (still) throw new Error(`'${step.assertAbsent}' still visible (${still})`);
        }
        const newErr = consoleErrors.slice(before);
        results.push({ name: step.name, ok: newErr.length === 0 || !(spec.forbidConsoleErrors ?? true), consoleErrors: newErr });
      } catch (e) {
        results.push({ name: step.name, ok: false, error: String(e.message).slice(0, 300) });
      }
      if (step.resetAfter !== false) await resetState(page);
    }
    if (spec.resize) {   // one viewport resize sanity pass
      try {
        await page.setViewportSize({ width: spec.resize.width || 1100, height: spec.resize.height || 800 });
        await page.waitForTimeout(600);
        if (spec.resize.assert) await page.waitForSelector(spec.resize.assert, { timeout: 8000 });
        results.push({ name: "resize", ok: true });
      } catch (e) { results.push({ name: "resize", ok: false, error: String(e.message).slice(0, 300) }); }
    }
  } finally {
    if (opts.connect) await browser.close().catch(() => {});
    else await browser.close();
  }
  const ok = results.every((r) => r.ok) && (!(spec.forbidConsoleErrors ?? true) || consoleErrors.length === 0);
  const out = { familyId, ok, steps: results, consoleErrors, spec: path.basename(specPath), generatedAt: new Date().toISOString() };
  const p = path.join(outDir, `${familyId}.json`);
  await fs.writeFile(p, JSON.stringify(out, null, 2));
  console.log(`${ok ? "✓" : "✗"} smoke '${familyId}': ${results.filter((r) => r.ok).length}/${results.length} steps ok, ${consoleErrors.length} console error(s) → ${path.relative(process.cwd(), p)}`);
  if (!ok) for (const r of results.filter((x) => !x.ok)) console.log(`    · ${r.name}: ${r.error || (r.consoleErrors || []).join(" | ")}`);
  process.exit(ok ? 0 : 2);
}

async function main() {
  let a = process.argv.slice(2);
  const isSmoke = a[0] === "smoke";
  if (isSmoke) a = a.slice(1);
  const [phaseDir, id, ...rest] = a;
  const argv = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  if (!phaseDir || !id || !argv("--url") && !isSmoke) { console.error("usage: measure-block.mjs [smoke] <phaseDir> <blockId|familyId> --url <appUrl> [--connect ws] [--probes f] [--spec f] [--scale 2] [--select-user u] [--accept-glyph-residuals] [--structure-only] [--no-report]"); process.exit(1); }
  const opts = {
    url: argv("--url"), connect: argv("--connect", null), scale: +argv("--scale", "2"),
    timeout: +argv("--timeout", "30000"), selectUser: argv("--select-user", null),
    probes: argv("--probes", null), spec: argv("--spec", null), specFile: argv("--spec-file", null),
    acceptGlyph: rest.includes("--accept-glyph-residuals"), noReport: rest.includes("--no-report"),
    structureOnly: rest.includes("--structure-only"),
  };
  if (!opts.url) { console.error("✗ --url <appUrl> is required (the PINNED appUrl from the run journal — never a guessed :3000)"); process.exit(1); }
  if (isSmoke) await smoke(phaseDir, id, opts);
  else await measure(phaseDir, id, opts);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

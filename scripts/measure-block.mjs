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
async function acquireBrowser(chromium, connectWs, { requireConnect = false } = {}) {
  if (!connectWs) {
    // FAIL LOUD, never a silent blank headless browser. A throwaway headless Chromium has no auth/
    // session and can't open the React-state-gated Velt sidebar — it would measure an empty surface
    // and false-pass. When a real browser is expected (any live measurement), refuse and instruct.
    if (requireConnect) {
      console.error("✗ --require-connect is set but no real browser endpoint (--connect <ws>) was provided.\n" +
        "  Measurement will NOT silently fall back to a blank headless browser (it can't open the Velt\n" +
        "  sidebar and would report a false PASS on an empty surface). Resolve one first:\n" +
        "    node scripts/browser-endpoint.mjs   # prints a ws for a Chrome started with --remote-debugging-port=9222\n" +
        "  then pass its output as --connect <ws>. (Unattended --auto launches its own server browser.)");
      process.exit(3);
    }
    return chromium.launch({ headless: true });   // bare headless: golden/offline calibration only
  }
  const looksCdp = /^https?:|\/devtools\//.test(connectWs);
  try { return await (looksCdp ? chromium.connectOverCDP(connectWs) : chromium.connect({ wsEndpoint: connectWs })); }
  catch { return await (looksCdp ? chromium.connect({ wsEndpoint: connectWs }) : chromium.connectOverCDP(connectWs)); }
}
const vis = (page, sel) => page.locator(`${sel} >> visible=true`).first();
// waitVisible (BUG-4b, found live): plain page.waitForSelector(sel, {state:'visible'}) targets the
// FIRST DOM match for `sel` and waits for THAT element to become visible. For any wireframe tag,
// the first DOM match is the permanently-hidden 0-size registry twin under <velt-wireframe> — it
// never becomes visible, so the wait hangs/times out even though a live, visible clone matching the
// same selector exists elsewhere in the DOM. Route every "wait until this becomes visible" through
// the same visible-first locator the click/hover helper (`vis`) already uses.
const waitVisible = (page, sel, timeout) => page.locator(`${sel} >> visible=true`).first().waitFor({ state: "visible", timeout });

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

// selectUser, HYDRATION-SAFE (BUG-2, found live on the first --auto run): the old version fired the
// change right after DOMContentLoaded and raced the app's hydration — the selection sometimes didn't
// stick, silently poisoning every downstream drive. Now: wait for the select to be hydrated (present,
// enabled, and the app alive — a velt-* element or window.Velt), set + dispatch, then VERIFY the value
// took and the app reaches an identified state; retry up to 3 times; fail loudly, never silently.
async function selectUserRobust(page, user, timeout = 20000) {
  await page.waitForFunction(() => {
    const sel = document.querySelector("select");
    const alive = !!window.Velt || [...document.querySelectorAll("*")].some((el) => el.tagName.toLowerCase().startsWith("velt-"));
    return !!sel && !sel.disabled && alive;
  }, { timeout });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.evaluate((u) => {
      const sel = document.querySelector("select");
      if (!sel) return;   // already consumed by a successful sign-in (see below)
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(sel, u);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }, user);
    const stuck = await page.waitForFunction((u) => {
      const sel = document.querySelector("select");
      const alive = !!window.Velt || [...document.querySelectorAll("*")].some((el) => el.tagName.toLowerCase().startsWith("velt-"));
      if (!alive) return false;
      // Some hosts REPLACE the select with signed-in UI on success (BUG-3, found live on the
      // harvey app): a vanished select right after our dispatched change IS the success signal —
      // the old `sel.value === u` predicate timed out on it, then attempt 2 crashed calling the
      // native value setter on null ("Illegal invocation").
      return sel ? sel.value === u : true;
    }, user, { timeout: 5000 }).then(() => true, () => false);
    if (stuck) { await page.waitForTimeout(600); return; }
    await page.waitForTimeout(500 * attempt);
  }
  throw new Error(`selectUser '${user}' did not stick after 3 attempts (hydration race) — the app never reached an identified state with that user; treat as BLOCKED (env), not FAIL`);
}

// The drive-step vocabulary + the required companion field(s) per action. ONE source of truth: the
// executor (runSteps) AND the pre-loop gate (validateDriveSteps, imported by brief-scaffold --lint and
// apply-plan-fills) both read it, so the gate can never drift from what the browser can actually run.
export const DRIVE_VOCAB = {
  click: ["selector"], dblclick: ["selector"], hover: ["selector"], waitFor: ["selector"],
  type: ["text"], press: ["key|text"], sleep: [], eval: ["js"], clear: [], selectUser: ["text"],
};

// Validate a brief's `drive` is MACHINE-EXECUTABLE (step OBJECTS, not prose) BEFORE any browser boots —
// turning the old ~35-min per-block runtime discovery ("unknown drive action 'undefined'") into a
// sub-second pre-loop hard-fail that names the offending block + step index. With requireSteps (any
// surface that must be opened/driven) it also rejects an empty drive with no assert — the empty-drive
// self-certification that produced the empty-surface false-pass. Returns problems[] (empty = ok).
export function validateDriveSteps(drive, { requireSteps = false, label = "drive" } = {}) {
  const problems = [];
  const steps = drive && drive.steps;
  if (steps != null && !Array.isArray(steps)) { problems.push(`${label}.steps must be an ARRAY of step objects, got ${typeof steps}`); return problems; }
  (steps || []).forEach((s, i) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      problems.push(`${label}.steps[${i}] is ${typeof s === "string" ? `the string ${JSON.stringify(String(s)).slice(0, 60)}` : typeof s} — expected a step OBJECT like {action:"click", selector:"…"}`);
      return;
    }
    const a = s.action;
    if (!a || !Object.prototype.hasOwnProperty.call(DRIVE_VOCAB, a)) {
      problems.push(`${label}.steps[${i}].action ${JSON.stringify(a)} is not a valid action (${Object.keys(DRIVE_VOCAB).join("|")})`);
      return;
    }
    for (const req of DRIVE_VOCAB[a]) {
      if (!req.split("|").some((f) => s[f] != null && String(s[f]).length)) problems.push(`${label}.steps[${i}] action '${a}' requires field '${req}'`);
    }
  });
  if (requireSteps) {
    if (!(Array.isArray(steps) && steps.length > 0)) problems.push(`${label}.steps is EMPTY on a surface that must be opened/driven — a blank capture would be a false-pass; author real step objects that OPEN the surface`);
    if (!(drive && drive.assert && String(drive.assert).trim())) problems.push(`${label}.assert is MISSING on a surface that must be opened/driven — provide a live selector proving the surface is open (the driven-state proof)`);
  }
  return problems;
}

async function runSteps(page, steps, { timeout = 15000 } = {}) {
  for (const s of steps || []) {
    const a = s.action;
    if (a === "click") await vis(page, s.selector).click({ timeout });
    else if (a === "dblclick") await vis(page, s.selector).dblclick({ timeout });
    else if (a === "hover") await vis(page, s.selector).hover({ timeout });
    else if (a === "type") { if (s.selector) await vis(page, s.selector).click({ timeout }); await page.keyboard.type(s.text ?? "", { delay: 20 }); }
    else if (a === "press") await page.keyboard.press(s.key || s.text);
    else if (a === "waitFor") await waitVisible(page, s.selector, s.ms || timeout);
    else if (a === "sleep") await page.waitForTimeout(s.ms || 300);
    else if (a === "eval") await page.evaluate(`(async()=>{ ${s.js} })()`);
    else if (a === "clear") await resetState(page);
    else if (a === "selectUser") await selectUserRobust(page, s.text, timeout);
    else throw new Error(`unknown drive action '${a}' (${Object.keys(DRIVE_VOCAB).join("|")})`);
  }
}

async function openPage(browser, url, { scale = 2, selectUser = null, timeout = 30000 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1512, height: 900 }, deviceScaleFactor: scale });
  const page = await ctx.newPage();
  const consoleErrors = [];
  // keep the source URL: network-noise errors ("Failed to load resource") are only
  // attributable/filterable by origin (see allowedConsoleErrorPatterns in smoke()).
  page.on("console", (m) => { const loc = m.location && m.location(); consoleErrors.push(...(m.type() === "error" ? [(m.text().slice(0, 300)) + (loc && loc.url ? ` [${loc.url.slice(0, 120)}]` : "")] : [])); });
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
  // spec resolution (BUG-1b): prefer the block's slice; if missing, generate it ON THE FLY via
  // spec-slice.mjs (geometric slicing + box rebase — the ONLY correct masking basis). Falling back
  // to the full designSpec with `--mask-frame <block.figmaNodeId>` silently emptied every text mask
  // (frameIds key to the top-level State/Flows groups, never per-block frames).
  let specPath = opts.spec, maskFrameOk = true;
  if (!specPath) {
    const slicePath = path.join(phaseDir, "briefs", `${blockId}.spec.json`);
    if (!(await fs.access(slicePath).then(() => true, () => false))) {
      const r = spawnSync("node", [path.join(SCRIPTS, "spec-slice.mjs"), path.join(phaseDir, "designSpec.json"), path.join(phaseDir, "blocks.json"), "--block", blockId, "--out-dir", phaseDir], { encoding: "utf8" });
      if (r.status === 0) console.error(`⚠ slice for '${blockId}' was missing — generated on the fly via spec-slice.mjs`);
    }
    if (await fs.access(slicePath).then(() => true, () => false)) specPath = slicePath;
    else {
      specPath = path.join(phaseDir, "designSpec.json");
      maskFrameOk = false;   // full spec: --mask-frame would match nothing — omit it and warn
      console.error(`⚠ no slice available for '${blockId}' and on-the-fly slicing failed — using the FULL designSpec WITHOUT --mask-frame; text masking will be degraded (expect false text diffs)`);
    }
  }

  const resDir = path.join(phaseDir, "results", blockId);
  await fs.mkdir(resDir, { recursive: true });
  const framePng = path.join(phaseDir, block.framePng);
  const shotPng = path.join(resDir, "shot.png");
  const liveSelector = probes.liveSelector || block.liveSelector;
  if (!liveSelector) { console.error(`✗ no liveSelector for '${blockId}' (blocks.json or the probe brief must set it)`); process.exit(3); }

  const chromium = await loadChromium();
  const browser = await acquireBrowser(chromium, opts.connect, { requireConnect: opts.requireConnect });
  let driven = false, consoleErrors = [];
  try {
    const o = await openPage(browser, opts.url, { scale: opts.scale, selectUser: opts.selectUser, timeout: opts.timeout });
    const page = o.page; consoleErrors = o.consoleErrors;
    // Pre-drive boot wait: state 'attached', NOT the default 'visible' (BUG-4, found live): a
    // wireframe liveSelector's FIRST DOM match is the hidden 0-size registry twin under
    // <velt-wireframe>, and the visible clone often only renders after the drive signs in /
    // opens the surface — the visible-wait deadlocked here. The drive's own `assert` is the
    // real driven-state gate; the capture below resolves visible-first.
    // BOOT readiness — wait for Velt to be DEFINED (booted), NOT the block's liveSelector. The
    // liveSelector's visible clone often only mounts AFTER the drive opens the surface, and a
    // class-based liveSelector may not exist at all pre-drive — waiting on it would time out before
    // the drive that creates it ever ran (the old ordering bug behind "measure-block never ran"). The
    // OPENED surface is proven post-drive, below.
    await page.waitForFunction(
      () => !!(window.Velt || document.querySelector('velt-comments, velt-comment-tool, [class*="velt-"]')),
      { timeout: Math.min(opts.timeout, 20000) },
    ).catch(() => { /* boot signal absent — the post-drive visibility proof is the real gate */ });
    await resetState(page);
    // DRIVE to the block's state, then PROVE the surface actually opened. driven=true REQUIRES a
    // VISIBLE proof selector (drive.assert, else the block's own liveSelector) — never an empty or
    // assumed drive. This is what kills the empty-surface false-pass: a closed sidebar/dialog's content
    // never becomes visible, so we refuse to certify it instead of screenshotting a blank shell.
    try {
      await runSteps(page, probes.drive?.steps, { timeout: opts.timeout });
      const proofSel = probes.drive?.assert || liveSelector;
      await waitVisible(page, proofSel, probes.drive?.assert ? 10000 : 8000);
      driven = true;
    } catch (e) {
      const why = probes.drive?.assert
        ? `drive/assert failed: ${e.message}`
        : `the surface never became VISIBLE after the drive (proof selector '${liveSelector}') — it likely never opened (e.g. a closed sidebar/dialog). A blank capture is a false-pass; the brief must OPEN the surface (drive.steps) and PROVE it (drive.assert).`;
      console.error(`✗ '${blockId}': ${why}`);
      await fs.writeFile(path.join(resDir, "triage.json"), JSON.stringify({ error: String(e.message), reason: why, driven: false, consoleErrors, at: new Date().toISOString() }, null, 2));
      process.exit(3);
    }
    await page.waitForTimeout(500);

    // FIXTURE CONTENT CHECK (found live: a fixture comment seeded 1-line where the design frame
    // shows 2 lines shifted everything below by 18px — false diffs until traced). The brief's
    // fixture.expectedTexts are the design's own strings; missing ones mean the FIXTURE is wrong:
    // the fix is RESEED, never fudging layout to compensate (R0).
    let fixtureCheck = null;
    const expectedTexts = probes.fixture?.expectedTexts || [];
    if (expectedTexts.length) {
      const surfaceText = await page.evaluate((sel) => {
        const roots = [...document.querySelectorAll(sel)];
        const text = roots.map((r) => r.innerText || r.textContent || "").join("\n");
        return text.trim() ? text : (document.body?.innerText || "");
      }, liveSelector).catch(() => "");
      const missing = expectedTexts.filter((t) => !surfaceText.includes(t));
      fixtureCheck = { ok: !missing.length, expected: expectedTexts.length, missing };
      await fs.writeFile(path.join(resDir, "fixture.json"), JSON.stringify(fixtureCheck, null, 2));
      if (missing.length) console.error(`⚠ FIXTURE MISMATCH: ${missing.length}/${expectedTexts.length} design string(s) absent from the live surface (first: ${JSON.stringify(missing[0]).slice(0, 80)}). RESEED the fixture to match the design content — do NOT patch layout around wrong content (R0). Visual diffs below are unreliable until the fixture is right.`);
    }

    // CAPTURE (device-res element PNG)
    const el = vis(page, liveSelector);
    // LAYOUT-ANOMALY GUARD: an element grossly beyond the viewport is an immediate defect (a
    // sidebar once rendered 34,000px wide from an unconstrained max-content rule and was only
    // found via a smoke-click timeout). Fail fast with the named defect — never screenshot it
    // (a 34k-px capture is its own hazard) or let smoke discover it the expensive way.
    const vp = page.viewportSize() || { width: 1512, height: 900 };
    const bb = await el.boundingBox().catch(() => null);
    if (bb && (bb.width > vp.width * 3 || bb.height > vp.height * 5)) {
      const anomaly = { blockId, layoutAnomaly: { width: Math.round(bb.width), height: Math.round(bb.height), viewport: vp }, hint: "an unconstrained rule (max-content / missing width) — pin the design's real dimension" };
      await fs.writeFile(path.join(resDir, "triage.json"), JSON.stringify({ ...anomaly, consoleErrors, at: new Date().toISOString() }, null, 2));
      console.error(`✗ LAYOUT ANOMALY: '${liveSelector}' measures ${Math.round(bb.width)}×${Math.round(bb.height)}px against a ${vp.width}×${vp.height} viewport — fix the runaway dimension before any visual measurement.`);
      console.log(JSON.stringify(anomaly));
      process.exit(2);
    }
    // EMPTY-SHELL BACKSTOP: a null or near-zero capture means we're about to screenshot a closed/empty
    // surface — the false-pass. The visible-first locator + the post-drive visibility proof should
    // already prevent it, but never certify a measurement of nothing.
    if (!bb || bb.width < 8 || bb.height < 8) {
      const empty = { blockId, emptyCapture: { box: bb, liveSelector }, hint: "the surface is missing or collapsed to ~0px — it likely never opened; a blank capture is not a valid measurement" };
      await fs.writeFile(path.join(resDir, "triage.json"), JSON.stringify({ ...empty, consoleErrors, at: new Date().toISOString() }, null, 2));
      console.error(`✗ '${blockId}': captured surface is missing/near-zero (${bb ? Math.round(bb.width) + "×" + Math.round(bb.height) : "no box"}px) — refusing to measure an empty shell.`);
      process.exit(3);
    }
    await el.screenshot({ path: shotPng });

    if (opts.structureOnly) {
      // structural visit: capture + visual-diff only (gross-structure catch, before styling compounds)
      const vd = runVisualDiff({ framePng, shotPng, specPath, block, resDir, acceptGlyph: false, maskFrameOk });
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
    const vd = runVisualDiff({ framePng, shotPng, specPath, block, resDir, acceptGlyph: opts.acceptGlyph, maskFrameOk });

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

    // summary → diffCount is what the builder feeds to `block-iter record`. CONTENT-INDEPENDENT ONLY:
    // deltaCompare (per-element style/box/gap) + contract + stability drive the fix loop. Whole-surface
    // visualDiff is ADVISORY — it compares live pixels (REAL data) against the design frame (DUMMY data),
    // so on any content-bearing surface it lights up on data differences (2 vs 11 cards, different text,
    // real names/timestamps) that are NOT defects. Counting them sent the builder chasing phantom fixes.
    // It stays in the summary so the Judge can spot regions worth investigating, but it is no longer a
    // fix-defect. (A data-controlled capture that WANTS pixel gating carries dataMatched — honoured by the
    // GATE, not this loop.) The corollary: deltaCompare must actually COVER the template (every slot + the
    // inter-card gap + reaction icons), or a clean loop means nothing — enforced by the gate's coverage floor.
    const sigRegions = (vd.regions || []).filter((r) => (r.fill ?? 1) >= 0.05);
    const deltaFails = delta.ok ? 0 : Math.max(1, (delta.diffs || []).length);
    const contractFails = contract && !contract.ok ? (contract.violations || []).length || 1 : 0;
    const stabilityFails = stability.ok ? 0 : 1;
    const diffCount = deltaFails + contractFails + stabilityFails;
    console.log(JSON.stringify({
      blockId, driven, diffCount,
      visualAdvisory: { significantRegions: sigRegions.length, acceptedResiduals: (vd.acceptedResiduals || []).length, note: "advisory: pixel-diff vs dummy-data design — investigate, do not treat as a defect on content-bearing surfaces" },
      delta: { ok: delta.ok, diffs: (delta.diffs || []).length, checked: (delta.checked || []).length, gaps: (delta.gaps || []).length },
      contract: contract ? { ok: contract.ok, violations: (contract.violations || []).length } : null,
      stability: { ok: stability.ok }, consoleErrors: consoleErrors.length,
      ...(fixtureCheck ? { fixture: fixtureCheck } : {}),
    }, null, 2));
    process.exit(diffCount === 0 && driven && consoleErrors.length === 0 ? 0 : 2);
  } finally {
    if (opts.connect) await browser.close().catch(() => {});
    else await browser.close();
  }
}

function runVisualDiff({ framePng, shotPng, specPath, block, resDir, acceptGlyph, maskFrameOk = true }) {
  const args = [path.join(SCRIPTS, "visual-diff.mjs"), framePng, shotPng,
    "--mask-text-from", specPath, "--min-fill", "0.05",
    "--out", path.join(resDir, "diff.png"), "--json-out", path.join(resDir, "visual.json")];
  if (maskFrameOk) args.push("--mask-frame", block.figmaNodeId);   // only meaningful against a slice (frameIds restamped)
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
  // spec.allowedConsoleErrorPatterns: regex strings for KNOWN environment noise that no build can
  // fix (e.g. the Velt SDK's own Firestore Listen channel intermittently answers 400 on this demo
  // key — pre-exists the customization, live-verified against the DEFAULT UI). Anything else fails.
  const allowed = (spec.allowedConsoleErrorPatterns || []).map((p) => new RegExp(p));
  const isAllowed = (e) => allowed.some((re) => re.test(e));
  const outDir = path.join(phaseDir, "results", "smoke");
  await fs.mkdir(outDir, { recursive: true });
  const chromium = await loadChromium();
  const browser = await acquireBrowser(chromium, opts.connect, { requireConnect: opts.requireConnect });
  const results = [];
  let consoleErrors = [];
  try {
    const o = await openPage(browser, opts.url, { scale: 1, selectUser: opts.selectUser, timeout: opts.timeout });
    const page = o.page; consoleErrors = o.consoleErrors;
    for (const step of spec.steps || []) {
      const before = consoleErrors.length;
      try {
        await runSteps(page, step.actions, { timeout: opts.timeout });
        if (step.assert) await waitVisible(page, step.assert, 8000);
        if (step.assertAbsent) {
          const still = await page.locator(`${step.assertAbsent} >> visible=true`).count();
          if (still) throw new Error(`'${step.assertAbsent}' still visible (${still})`);
        }
        const newErr = consoleErrors.slice(before).filter((e) => !isAllowed(e));
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
        if (spec.resize.assert) await waitVisible(page, spec.resize.assert, 8000);
        results.push({ name: "resize", ok: true });
      } catch (e) { results.push({ name: "resize", ok: false, error: String(e.message).slice(0, 300) }); }
    }
  } finally {
    if (opts.connect) await browser.close().catch(() => {});
    else await browser.close();
  }
  const disallowed = consoleErrors.filter((e) => !isAllowed(e));
  const allowedSeen = consoleErrors.filter(isAllowed);
  const ok = results.every((r) => r.ok) && (!(spec.forbidConsoleErrors ?? true) || disallowed.length === 0);
  const out = { familyId, ok, steps: results, consoleErrors: disallowed, allowedConsoleErrors: allowedSeen, spec: path.basename(specPath), generatedAt: new Date().toISOString() };
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
    // --require-connect: refuse to run in a blank headless browser (the silent false-pass). The
    // orchestrator/judge pass this for every LIVE measurement; only golden/offline calibration omits it.
    requireConnect: rest.includes("--require-connect"),
  };
  if (!opts.url) { console.error("✗ --url <appUrl> is required (the PINNED appUrl from the run journal — never a guessed :3000)"); process.exit(1); }
  if (isSmoke) await smoke(phaseDir, id, opts);
  else await measure(phaseDir, id, opts);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

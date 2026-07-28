#!/usr/bin/env node
// trials.mjs — the STAGE-ISOLATED TRIAL RUNNER for fail-fast validation of pipeline stages.
// A full E2E run costs hours and exercises new code for the first time mid-flight; a trial runs
// ONE stage, N times, against FROZEN inputs, screenshots every attempt, scores it mechanically
// (visual-diff vs the Figma reference PNG), and records everything to the obs layer — so the
// replay player's Gallery view shows attempt-by-attempt images side by side with scores.
//
// Modes:
//   node scripts/trials.mjs extract <fileKey> <nodeId> --dir <trialDir> [--runs 3] [--scale 2]
//       Stage-1 trial: run the DETERMINISTIC extraction N times. Checks:
//         (a) determinism — every run's designSpec.json must hash IDENTICAL (raw + canonical);
//         (b) accuracy   — each spec is rendered mechanically (make-test-html.mjs), each design
//             frame is screenshotted headlessly and pixel-diffed against the reference frame PNG
//             (exported once via enumerate-blocks into <trialDir>/reference/). The spec render
//             hardcodes the design's own content, so the pixel score is a FAIR comparison here
//             (unlike live-app-vs-frame, where real data pollutes it).
//   node scripts/trials.mjs score-mock <trialDir> --mock <file.html> --ref <framePng>
//        --label "<model>/<attempt>" [--group <name>] [--selector <css>] [--scale 2]
//       Stage-2 trial scoring: screenshot ONE mock html (whole page, or --selector element) and
//       diff it against a reference frame PNG. The AI dispatch (which model draws the mock) is
//       the orchestrating agent's job; this is the mechanical scoring half. One obs event per call.
//
// Every attempt lands in <trialDir>/obs/events.jsonl as { type:"trial", data:{group,label,diffPct,…},
// shots:{live,ref,diff} } — `obs.mjs build/serve <trialDir>` then shows the Gallery.
// NOTE on scores: the pixel diff includes Figma-vs-Chrome glyph-placement noise (~a few %); the
// score is for COMPARING attempts and catching regressions, not an absolute quality grade.

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadChromium } from "./measure-block.mjs";
import { obsEvent } from "./obs.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
export const MOCK_GATE_PCT = 2.0;   // Δspec pass threshold for a mock (see trialScoreMock)
const sh = (args, opts = {}) => spawnSync("node", args, { encoding: "utf8", ...opts });
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const relTo = (dir, p) => path.relative(dir, p);
const frameElId = (figmaId) => "frame-" + String(figmaId).replace(/[^a-z0-9]+/gi, "-");

// canonical hash: key-sorted JSON — catches "same content, different key order/whitespace"
function canonicalHash(jsonText) {
  const sort = (v) => Array.isArray(v) ? v.map(sort)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return sha(JSON.stringify(sort(JSON.parse(jsonText))));
}

// DIMENSION-STABLE element capture. playwright's element .screenshot() captures the element's
// sub-pixel bounding box rounded UP, so a 40.0-css element and a 40.4-css element yield 80 vs 82
// device px — a +1px reference inflation that made the mock (exactly box-sized) mismatch the
// spec-render reference by a whole row (~2.5% on a 40px block, harmless on big ones). Fix: capture
// BOTH the reference and the mock through the SAME rounded-clip path (Math.round on x/y/w/h, at
// device scale), so identical layout → identical pixels regardless of sub-pixel bbox rounding.
async function clipShot(page, loc, outPng, scale) {
  const bb = await loc.boundingBox();
  if (!bb) return false;
  await page.screenshot({
    path: outPng, fullPage: true,
    clip: { x: Math.round(bb.x), y: Math.round(bb.y), width: Math.round(bb.width), height: Math.round(bb.height) },
  });
  return true;
}

async function screenshotPage(htmlPath, { scale = 2, selector = null, outPng, outDirForFrames = null, frames = [] }) {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: true });   // static local HTML — no auth/session needed
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: scale });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    // WHITE compositing: Figma's per-block PNG export composites transparency to WHITE, but a
    // block clipped out of the rendered board keeps the board's own (often dark) background —
    // an 81% false diff on the header row. Neutralize the board/frame + page backgrounds so a
    // block's undrawn pixels compare as white on both sides (only DRAWN pixels differ).
    await page.addStyleTag({ content: "body, .frame { background: #ffffff !important; }" }).catch(() => {});
    // make-test-html sets body[data-font-fit-done] after fonts.ready + the font-fit shim
    await page.waitForSelector("body[data-font-fit-done]", { timeout: 20000 }).catch(() => {});
    await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
    await page.waitForTimeout(400);
    const shots = {};
    if (frames.length && outDirForFrames) {
      for (const f of frames) {
        // a block's node is NESTED inside a top-level State/Flows group frame (spec frameIds key to
        // the groups, never per-block frames) — so locate the group frame element and CLIP the
        // block's frame-relative box out of it (CSS px; the page's deviceScaleFactor applies).
        const p = path.join(outDirForFrames, `${f.blockId}.png`);
        try {
          // ELEMENT-SCREENSHOT the block's ROOT node (make-test-html stamps data-nid on every
          // node). This is the SAME capture path a mock uses (element-screenshot of #mock sized to
          // the root box), so the two align pixel-for-pixel regardless of any frame border/offset —
          // coordinate-clipping the board instead created a spurious (1,1) shift that no mock could
          // beat. SUBTREE ISOLATION: hide sibling nodes outside this block so only its subtree paints.
          const rootSel = `[data-nid="${f.figmaNodeId}"]`;
          const loc = page.locator(rootSel);
          if (!(await loc.count())) { shots[f.blockId] = null; continue; }
          if (f.keepIds) await page.evaluate(({ keep }) => {
            const set = new Set(keep);
            for (const el of document.querySelectorAll("[data-nid]")) el.style.visibility = set.has(el.dataset.nid) ? "" : "hidden";
          }, { keep: f.keepIds }).catch(() => {});
          const okShot = await clipShot(page, loc.first(), p, scale);   // rounded-clip (dimension-stable)
          if (f.keepIds) await page.evaluate(() => {
            for (const el of document.querySelectorAll("[data-nid]")) el.style.visibility = "";
          }).catch(() => {});
          shots[f.blockId] = okShot ? p : null;
        } catch { shots[f.blockId] = null; }
      }
    }
    if (outPng) {
      if (selector) await clipShot(page, page.locator(selector).first(), outPng, scale);   // same rounded-clip path as the reference
      else await page.screenshot({ path: outPng, fullPage: true });
    }
    return shots;
  } finally { await browser.close(); }
}

function runVisualDiff(refPng, livePng, outDiff, outJson) {
  const r = sh([path.join(SCRIPTS, "visual-diff.mjs"), refPng, livePng, "--out", outDiff, "--json-out", outJson]);
  if (r.status !== 0 && !r.stdout.trim()) return { error: (r.stderr || "visual-diff failed").slice(0, 200) };
  try { return JSON.parse(r.stdout); } catch { return { error: "unparseable visual-diff output" }; }
}

// ------------------------------------------------ extract mode (stage 1)
async function trialExtract(fileKey, nodeId, { dir, runs, scale }) {
  await fs.mkdir(dir, { recursive: true });
  obsEvent(dir, { type: "run.start", src: "trials", stage: "extract", summary: `extraction trial: ${runs} run(s) of ${fileKey}/${nodeId}` });

  // 0. reference (once, frozen): frame PNGs + blocks
  const refDir = path.join(dir, "reference");
  const blocksP = path.join(refDir, "blocks.json");
  if (!(await fs.access(blocksP).then(() => true, () => false))) {
    console.log("→ exporting reference frames (enumerate-blocks, once)…");
    const r = sh([path.join(SCRIPTS, "enumerate-blocks.mjs"), "rest", fileKey, nodeId, "--out", refDir, "--scale", String(scale)]);
    process.stdout.write(r.stdout); process.stderr.write(r.stderr || "");
    if (r.status !== 0) { obsEvent(dir, { type: "trial", src: "trials", stage: "extract", ok: false, summary: "reference export failed" }); process.exit(2); }
  } else console.log("→ reference already exists (frozen) — reusing");
  const blocks = JSON.parse(await fs.readFile(blocksP, "utf8")).blocks || [];
  const frames = blocks.map((b) => ({ blockId: b.id, figmaNodeId: b.figmaNodeId, refPng: path.join(refDir, b.framePng) }));

  const hashes = [];
  const scores = {};   // blockId -> [diffPct per run]
  for (let i = 1; i <= runs; i++) {
    const runDir = path.join(dir, `run-${i}`);
    await fs.mkdir(runDir, { recursive: true });
    console.log(`\n━━ run ${i}/${runs} ━━`);
    // 1. extract
    const rx = sh([path.join(SCRIPTS, "figma-extract.mjs"), "rest", fileKey, nodeId, "--out", runDir, "--svg"]);
    process.stdout.write(rx.stdout); if (rx.status !== 0) { process.stderr.write(rx.stderr || ""); obsEvent(dir, { type: "trial", src: "trials", stage: "extract", ok: false, summary: `run ${i}: extraction FAILED`, data: { group: "determinism", label: `run-${i}` } }); continue; }
    // 2. hash (raw + canonical)
    const specText = await fs.readFile(path.join(runDir, "designSpec.json"), "utf8");
    const h = { raw: sha(specText), canonical: canonicalHash(specText) };
    hashes.push({ run: i, ...h });
    // 3. render + per-frame screenshots — each block's node is nested inside a top-level
    // State/Flows group frame; resolve its group frame element + frame-relative box from THIS
    // run's spec so the screenshot clips exactly the block's region.
    const rr = sh([path.join(SCRIPTS, "make-test-html.mjs"), runDir, path.join(runDir, "test.html")]);
    if (rr.status !== 0) { process.stderr.write(rr.stderr || ""); continue; }
    const spec = JSON.parse(specText);
    const byId = new Map((spec.nodes || []).map((n) => [n.id, n]));
    const frameTargets = frames.map((f) => {
      const n = byId.get(f.figmaNodeId);
      if (!n) return { ...f, box: null, frameSel: null };
      // subtree = the block node + every same-frame node whose box sits INSIDE it (tol 3 —
      // line-height boxes overflow their frame slightly; spec-slice uses the identical rule)
      const fb = n.box, tol = 3;
      const inside = (b) => b && fb && b.x >= fb.x - tol && b.y >= fb.y - tol && b.x + b.w <= fb.x + fb.w + tol && b.y + b.h <= fb.y + fb.h + tol;
      const keepIds = [n.id, ...(spec.nodes || []).filter((x) => x.frameId === n.frameId && x.id !== n.id && inside(x.box)).map((x) => x.id)];
      return { ...f, box: fb || null, frameSel: n.frameId ? "#" + frameElId(n.frameId) : null, keepIds };
    });
    const shotsDir = path.join(runDir, "shots"), diffsDir = path.join(runDir, "diffs");
    await fs.mkdir(shotsDir, { recursive: true }); await fs.mkdir(diffsDir, { recursive: true });
    const shots = await screenshotPage(path.join(runDir, "test.html"), { scale, outDirForFrames: shotsDir, frames: frameTargets });
    // 4. score each frame vs its reference
    for (const f of frames) {
      const live = shots[f.blockId];
      if (!live) {
        obsEvent(dir, { type: "trial", src: "trials", stage: "extract", blockId: f.blockId, ok: false, summary: `run ${i} · ${f.blockId}: frame missing from the spec render`, data: { group: f.blockId, label: `run-${i}`, runIdx: i } });
        continue;
      }
      const diffPng = path.join(diffsDir, `${f.blockId}.diff.png`);
      const vd = runVisualDiff(f.refPng, live, diffPng, path.join(diffsDir, `${f.blockId}.json`));
      const diffPct = vd.diffPct ?? null;
      (scores[f.blockId] = scores[f.blockId] || []).push(diffPct);
      obsEvent(dir, {
        type: "trial", src: "trials", stage: "extract", blockId: f.blockId,
        ok: diffPct != null && diffPct < 12,   // advisory threshold — comparison across runs is the real signal
        summary: `run ${i} · ${f.blockId}: diffPct ${diffPct ?? "?"}%${vd.error ? ` (${vd.error})` : ""}`,
        data: { group: f.blockId, label: `run-${i}`, runIdx: i, diffPct, specHash: h.canonical.slice(0, 12) },
        shots: { live: relTo(dir, live), ref: relTo(dir, f.refPng), diff: relTo(dir, diffPng) },
      });
      console.log(`  ${f.blockId}: diffPct ${diffPct ?? "?"}%`);
    }
  }

  // 5. verdicts
  const uniqRaw = new Set(hashes.map((h) => h.raw)).size;
  const uniqCanon = new Set(hashes.map((h) => h.canonical)).size;
  const deterministic = uniqCanon === 1 && hashes.length === runs;
  console.log(`\n━━ determinism: ${deterministic ? "✓ IDENTICAL" : `✗ ${uniqCanon} distinct canonical hash(es)`} across ${hashes.length}/${runs} run(s) (raw: ${uniqRaw})`);
  console.log("━━ accuracy (diffPct per run — lower is better; cross-run variance should be ~0):");
  for (const [bid, arr] of Object.entries(scores)) {
    const nums = arr.filter((x) => x != null);
    const mean = nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2) : "?";
    console.log(`  ${bid}: [${arr.map((x) => x ?? "?").join(", ")}] mean ${mean}%`);
  }
  obsEvent(dir, {
    type: "verdict", src: "trials", stage: "extract", ok: deterministic,
    summary: `extraction trial done: ${deterministic ? "DETERMINISTIC" : "NON-DETERMINISTIC (" + uniqCanon + " canonical hashes)"} over ${hashes.length}/${runs} runs`,
    data: { verdict: deterministic ? "PASS" : "FAIL", hashes, meanDiffPct: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, +(v.filter((x) => x != null).reduce((a, b) => a + b, 0) / Math.max(1, v.filter((x) => x != null).length)).toFixed(2)])) },
  });
  sh([path.join(SCRIPTS, "obs.mjs"), "build", dir], { stdio: "inherit" });
  console.log(`\n▶ view: node scripts/obs.mjs serve ${dir}   (Gallery button top-right shows every attempt: rendered | Figma | diff + score)`);
}

// ------------------------------------------------ score-mock mode (stage 2)
async function trialScoreMock(dir, { mock, ref, refSpec, label, group, selector, scale }) {
  await fs.mkdir(dir, { recursive: true });
  // artifact names must be unique per (group, label) — label alone collided across blocks and the
  // gallery showed the last-scored block's image on every card
  const safe = `${(group || path.basename(ref, ".png"))}-${label}`.replace(/[^a-z0-9._-]+/gi, "-");
  const attemptsDir = path.join(dir, "attempts");
  await fs.mkdir(attemptsDir, { recursive: true });
  const live = path.join(attemptsDir, `${safe}.png`);
  const diffPng = path.join(attemptsDir, `${safe}.diff.png`);
  const mockCopy = path.join(attemptsDir, `${safe}.html`);
  await fs.copyFile(mock, mockCopy).catch(() => {});   // keep the attempt's source with its score
  await screenshotPage(path.resolve(mock), { scale, selector, outPng: live });
  // score vs the Figma export (ground truth — carries the ~4-9% cross-rasterizer floor)
  const vd = runVisualDiff(path.resolve(ref), live, diffPng, path.join(attemptsDir, `${safe}.json`));
  const diffPct = vd.diffPct ?? null;
  // score vs the SPEC RENDER (same Chrome, same fonts → the rasterizer noise cancels; ~0% is
  // actually achievable, so THIS is the 100%-accuracy gate; any residue is a real mock error)
  let specDiffPct = null, diffSpecPng = null;
  if (refSpec) {
    diffSpecPng = path.join(attemptsDir, `${safe}.diff-spec.png`);
    const vds = runVisualDiff(path.resolve(refSpec), live, diffSpecPng, path.join(attemptsDir, `${safe}.spec.json`));
    specDiffPct = vds.diffPct ?? null;
  }
  const gatePct = specDiffPct ?? diffPct;
  // 2% gate vs the spec render: an order of magnitude tighter than the old figma-only 4-11% scores,
  // and above the irreducible text-glyph-rendering floor that text-dense blocks legitimately hit
  // (verified: their diff is text-outline drift with zero structural offset, not a mock defect).
  const pass = gatePct != null && gatePct < (refSpec ? MOCK_GATE_PCT : 15);
  obsEvent(dir, {
    type: "trial", src: "trials", stage: "mock",
    ok: pass,
    summary: `mock ${label}: ${refSpec ? `Δspec ${specDiffPct ?? "?"}% · ` : ""}Δfigma ${diffPct ?? "?"}%${vd.error ? ` (${vd.error})` : ""}`,
    data: { group: group || path.basename(ref, ".png"), label, diffPct, ...(refSpec ? { specDiffPct } : {}), mock: relTo(dir, mockCopy) },
    // the DIFF image shown is the gate's diff (vs spec render when available — real errors only)
    shots: { live: relTo(dir, live), ref: relTo(dir, path.resolve(ref)), diff: relTo(dir, diffSpecPng || diffPng) },
    artifacts: { mockHtml: relTo(dir, mockCopy), diffVsFigma: relTo(dir, diffPng), ...(diffSpecPng ? { diffVsSpec: relTo(dir, diffSpecPng) } : {}) },
  });
  console.log(`${pass ? "✓" : "✗"} ${label}: ${refSpec ? `Δspec ${specDiffPct ?? "?"}% · ` : ""}Δfigma ${diffPct ?? "?"}% → recorded (${path.relative(process.cwd(), dir)})`);
}

// ------------------------------------------------ regress mode (mock stage lock)
// Re-score every frozen golden mock (golden/mock-baseline/<design>/) against its frozen spec-render
// reference and FAIL if any block regresses past the gate. This is the mock-stage equivalent of the
// extraction determinism check — a mock-prompt or renderer change that breaks fidelity fails HERE,
// in ~1 min offline, instead of surfacing three stages downstream.
async function trialRegress(baselineDir, { scale }) {
  const designs = (await fs.readdir(baselineDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  let failed = 0, checked = 0;
  for (const design of designs.sort()) {
    const d = path.join(baselineDir, design);
    const mocks = (await fs.readdir(path.join(d, "mocks"))).filter((f) => f.endsWith(".html"));
    console.log(`\n━━ ${design} (${mocks.length} block(s)) ━━`);
    for (const m of mocks.sort()) {
      const bid = m.replace(/\.html$/, "");
      const ref = path.join(d, "ref-spec", `${bid}.png`);
      if (!(await fs.access(ref).then(() => true, () => false))) { console.log(`  ✗ ${bid}: frozen reference missing`); failed++; continue; }
      const live = path.join(os.tmpdir(), `regress-${design}-${bid}.png`);
      await screenshotPage(path.join(d, "mocks", m), { scale, selector: "#mock", outPng: live });
      const vd = runVisualDiff(ref, live, path.join(os.tmpdir(), `regress-${design}-${bid}.diff.png`), path.join(os.tmpdir(), `regress-${design}-${bid}.json`));
      const s = vd.diffPct; checked++;
      const ok = s != null && s < MOCK_GATE_PCT;
      console.log(`  ${ok ? "✓" : "✗"} ${bid}: Δspec ${s ?? "?"}%${ok ? "" : ` — REGRESSED past ${MOCK_GATE_PCT}% gate`}`);
      if (!ok) failed++;
    }
  }
  console.log(failed ? `\n✗ mock regression FAILED: ${failed}/${checked} block(s) past the ${MOCK_GATE_PCT}% gate` : `\n✓ mock stage locked: all ${checked} golden block(s) across ${designs.length} design(s) hold under ${MOCK_GATE_PCT}% Δspec`);
  process.exit(failed ? 1 : 0);
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const flag = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  // positionals = tokens that are neither --flags nor a flag's value
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) { i++; continue; }
    positionals.push(rest[i]);
  }
  if (mode === "extract") {
    const [fileKey, nodeId] = positionals;
    const dir = flag("--dir", null);
    if (!fileKey || !nodeId || !dir) { console.error("usage: trials.mjs extract <fileKey> <nodeId> --dir <trialDir> [--runs 3] [--scale 2]"); process.exit(1); }
    await trialExtract(fileKey, nodeId, { dir: path.resolve(dir), runs: +flag("--runs", "3"), scale: +flag("--scale", "2") });
  } else if (mode === "score-mock") {
    const [dir] = positionals;
    const mock = flag("--mock"), ref = flag("--ref"), label = flag("--label");
    if (!dir || !mock || !ref || !label) { console.error("usage: trials.mjs score-mock <trialDir> --mock <file.html> --ref <figmaPng> [--ref-spec <specRenderPng>] --label <model/attempt> [--group g] [--selector css] [--scale 2]"); process.exit(1); }
    await trialScoreMock(path.resolve(dir), { mock, ref, refSpec: flag("--ref-spec", null), label, group: flag("--group", null), selector: flag("--selector", null), scale: +flag("--scale", "2") });
  } else if (mode === "regress") {
    const [dir] = positionals;
    await trialRegress(path.resolve(dir || path.join(SCRIPTS, "..", "golden", "mock-baseline")), { scale: +flag("--scale", "2") });
  } else {
    console.error("usage: trials.mjs extract <fileKey> <nodeId> --dir d | score-mock <dir> --mock … --ref … | regress [baselineDir]");
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

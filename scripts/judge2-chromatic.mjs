#!/usr/bin/env node
// judge2-chromatic.mjs — chromatic-style visual compare: Figma frame (baseline) vs live demo.
//
// Deliberately simple. No probe suite, no emit ledger, no trap routing.
// 1) Capture RESTING live panel
// 2) Drive hover / selected / focus (+ other state-bindings) via REAL Playwright input;
//    capture live-<state>.png only when the guard confirms the state
// 3) Diff each block's Figma frame against the MATCHING live capture (never resting vs hover-frame)
// 4) State-bound blocks whose guard failed → status blocked-state (finding, not silent skip)
//
// Usage:
//   node scripts/judge2-chromatic.mjs <phaseDir> --url <url> --connect <ws> [--write]
// Exit 2 when diffs OR blocked states exist.

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  decodePNG, encodePNG, visualDiff, cropImage, textMasksFromSpec, textBoxesFromSpec,
} from "./visual-diff.mjs";
import { runJudge2ChromeProbes } from "./judge2-chrome-probes.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

/** Default bindings when phase has none — hover / selected / focus must never be skipped. */
const HOVER_DRIVE_SELECTOR = [
  // Prefer the painted sidebar dialog (largest match), then generic card/dialog hosts.
  ".velt-comment-dialog--sidebar-mode",
  ".velt-comment-dialog.sidebar",
  ".velt-comment-dialog--sidebar-mode .vc-card",
  ".vc-card",
  ".velt-comment-dialog",
  ".vc-body",
  "velt-comment-dialog-thread-card-internal",
].join(", ");
const HOVER_GUARD_SELECTOR = [
  ".velt-comment-dialog--sidebar-mode:hover",
  ".velt-comment-dialog.sidebar:hover",
  ".velt-comment-dialog--sidebar-mode .vc-card:hover",
  ".vc-card:hover",
  ".velt-comment-dialog:hover",
  ".vc-body:hover",
].join(", ");

const DEFAULT_BINDINGS = {
  note: "judge2 default state bindings — hover/selected/focus required",
  bindings: [
    {
      state: "hover",
      frameId: "(hover-frame)",
      blockIds: ["state-comment-thread-components-single-comment-dialog-hover"],
      captureId: "hover",
      drive: [{ action: "hover", selector: HOVER_DRIVE_SELECTOR, wait: 800 }],
      // Gate on a real :hover host — sidebar dialog first (Harvey + typical Velt apps).
      guard: { kind: "pseudo", selector: HOVER_GUARD_SELECTOR },
    },
    {
      state: "selected",
      frameId: "(selected-frame)",
      blockIds: ["state-comment-thread-components-selected-state"],
      captureId: "selected",
      drive: [{ action: "click", selector: ".velt-comment-dialog--sidebar-mode .vc-body, .vc-body, velt-comment-dialog-thread-card-internal, .vc-card", wait: 700 }],
      guard: {
        kind: "visible",
        selector: "velt-comment-dialog-composer-internal, .vc-composer:not(.vc-pagemode-composer-inner), [class*='dialog-composer'], [contenteditable][data-placeholder*='eply' i], [class*='--selected']",
      },
    },
    {
      state: "focus",
      frameId: "(focus-frame)",
      blockIds: [],
      captureId: "focus",
      drive: [
        { action: "click", selector: "app-comment-sidebar-page-mode-composer [contenteditable], .vc-pagemode-composer-inner [contenteditable], .vc-composer [contenteditable]", wait: 400 },
      ],
      guard: { kind: "pseudo", selector: "[contenteditable]:focus" },
    },
  ],
};

function inferStateFromBlockId(blockId) {
  const id = String(blockId || "").toLowerCase();
  if (/hover/.test(id)) return "hover";
  if (/selected/.test(id)) return "selected";
  if (/focus|typing/.test(id)) return "focus";
  return null;
}

function regionBand(y, h, panelH) {
  const mid = y + h / 2;
  const t = mid / Math.max(1, panelH);
  if (t < 0.12) return "header";
  if (t < 0.22) return "composer";
  if (t > 0.85) return "footer";
  return "thread-list";
}

function suggestLabel(region, panelH, { state = null } = {}) {
  if (region.detector === "mean-shift") {
    if (state === "hover") {
      return { id: "hover-bg-tint-mismatch", issue: `hover card background tint differs from Figma (mean luminance Δ${region.meanLumDelta ?? "?"}) — sub-threshold uniform fill` };
    }
    return { id: "bg-tint-mismatch", issue: `uniform background tint differs from Figma (mean luminance Δ${region.meanLumDelta ?? "?"})` };
  }
  if (region.detector === "text-gap") {
    return { id: "text-adjacent-gap-mismatch", issue: `micro-gap between adjacent text/avatar chrome differs from Figma (Δlum ${region.meanLumDelta ?? "?"})` };
  }
  const band = regionBand(region.y, region.h, panelH);
  const area = region.w * region.h;
  if (state === "hover") {
    if (region.w < 48 && region.h < 48) {
      return { id: "resolve-on-hover-missing", issue: "hover-state chrome: resolve/options glyph area differs from Figma (likely missing or wrong reveal)" };
    }
    return { id: "hover-actions-chrome-mismatch", issue: "hover-state thread chrome differs from Figma (actions/resolve/options reveal)" };
  }
  if (state === "selected") {
    if (band === "composer" || /composer/.test(band)) {
      return { id: "selected-reply-composer-mismatch", issue: "selected-state reply composer chrome differs from Figma" };
    }
    return { id: "selected-card-chrome-mismatch", issue: "selected-state card chrome differs from Figma" };
  }
  if (state === "focus") {
    return { id: "focus-state-chrome-mismatch", issue: "focus-state composer chrome differs from Figma" };
  }
  if (band === "header" && region.h < 80) return { id: "header-chrome-mismatch", issue: "header / filter chrome differs from Figma" };
  if (band === "composer" && region.h < 120) return { id: "composer-chrome-mismatch", issue: "composer pill / avatar / placeholder chrome differs from Figma" };
  if (region.w < 40 && region.h < 40) return { id: "icon-glyph-mismatch", issue: `small icon/glyph mismatch in ${band}` };
  if (area > 20000 && band === "thread-list") return { id: "card-chrome-mismatch", issue: "thread card chrome/layout differs from Figma in this region" };
  if (region.h < 28 && region.w > 80) return { id: "row-control-mismatch", issue: `row control (Reply / Show-N / actions) differs from Figma in ${band}` };
  return { id: `visual-${band}-${Math.round(region.x)}-${Math.round(region.y)}`, issue: `chrome mismatch vs Figma in ${band} @ ${region.cssBox || `${region.x},${region.y}`}` };
}

function padImg(img, w, h) {
  if (img.width === w && img.height === h) return img;
  const data = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < Math.min(h, img.height); y++) {
    for (let x = 0; x < Math.min(w, img.width); x++) {
      const si = (y * img.width + x) * 4;
      const di = (y * w + x) * 4;
      data[di] = img.data[si]; data[di + 1] = img.data[si + 1];
      data[di + 2] = img.data[si + 2]; data[di + 3] = img.data[si + 3];
    }
  }
  return { width: w, height: h, data };
}

/** Upgrade weak hover drive/guard on existing phase bindings (core fix, not a one-off probe). */
function normalizeStateBindings(doc) {
  if (!doc?.bindings?.length) return { doc: DEFAULT_BINDINGS, changed: true };
  let changed = false;
  for (const b of doc.bindings) {
    if (b.state !== "hover") continue;
    const guardSel = b.guard?.selector || "";
    const driveSel = (b.drive || []).find((s) => s.action === "hover")?.selector || "";
    const weakGuard = !/sidebar-mode|sidebar:hover/i.test(guardSel);
    const weakDrive = !/sidebar-mode|sidebar\b/i.test(driveSel);
    if (weakGuard) {
      b.guard = { kind: "pseudo", selector: HOVER_GUARD_SELECTOR };
      changed = true;
    }
    if (weakDrive) {
      const hoverStep = (b.drive || []).find((s) => s.action === "hover");
      if (hoverStep) {
        hoverStep.selector = HOVER_DRIVE_SELECTOR;
        hoverStep.wait = Math.max(hoverStep.wait || 0, 800);
      } else {
        b.drive = [{ action: "hover", selector: HOVER_DRIVE_SELECTOR, wait: 800 }, ...(b.drive || [])];
      }
      changed = true;
    }
  }
  return { doc, changed };
}

async function ensureStateBindings(phaseDir) {
  const p = path.join(phaseDir, "state-bindings.json");
  if (!(await exists(p))) {
    await fs.writeFile(p, JSON.stringify(DEFAULT_BINDINGS, null, 2) + "\n");
    console.log("· wrote default state-bindings.json (hover/selected/focus)");
    return DEFAULT_BINDINGS;
  }
  const existing = await loadJson(p);
  const { doc, changed } = normalizeStateBindings(existing);
  if (changed) {
    await fs.writeFile(p, JSON.stringify(doc, null, 2) + "\n");
    console.log("· upgraded state-bindings.json hover drive/guard (sidebar-aware)");
  }
  return doc;
}

/** Downscale grayscale for coarse template match (isolated Figma frame → live panel). */
function grayDown(img, factor) {
  const w = Math.max(1, Math.floor(img.width / factor));
  const h = Math.max(1, Math.floor(img.height / factor));
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const sx = x * factor + dx, sy = y * factor + dy;
          if (sx >= img.width || sy >= img.height) continue;
          const i = (sy * img.width + sx) * 4;
          s += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
          n++;
        }
      }
      g[y * w + x] = s / Math.max(1, n);
    }
  }
  return { w, h, g };
}

/**
 * Find where an isolated Figma frame sits inside a full-panel live capture.
 * Returns device-px crop {x,y,w,h,score} or null if not isolated / no good match.
 */
export function findBestTemplateMatch(refImg, liveImg, { factor = 4, maxScore = 42 } = {}) {
  const wr = refImg.width / liveImg.width;
  const hr = refImg.height / liveImg.height;
  // Full-panel (or near) — no alignment needed
  if (wr > 0.85 && hr > 0.85) return { x: 0, y: 0, w: liveImg.width, h: liveImg.height, score: 0, mode: "full-panel" };
  if (refImg.width > liveImg.width + 4 || refImg.height > liveImg.height + 4) {
    return { x: 0, y: 0, w: liveImg.width, h: liveImg.height, score: 0, mode: "full-panel" };
  }
  const R = grayDown(refImg, factor);
  const L = grayDown(liveImg, factor);
  if (R.w >= L.w || R.h >= L.h) {
    return { x: 0, y: 0, w: liveImg.width, h: liveImg.height, score: 0, mode: "full-panel" };
  }
  let best = { score: Infinity, x: 0, y: 0 };
  for (let y = 0; y <= L.h - R.h; y++) {
    for (let x = 0; x <= L.w - R.w; x++) {
      let sad = 0;
      for (let j = 0; j < R.h; j++) {
        const ri = j * R.w;
        const li = (y + j) * L.w + x;
        for (let i = 0; i < R.w; i++) sad += Math.abs(R.g[ri + i] - L.g[li + i]);
      }
      const score = sad / (R.w * R.h);
      if (score < best.score) best = { score, x: x * factor, y: y * factor };
    }
  }
  if (best.score > maxScore) return null;
  return {
    x: best.x,
    y: best.y,
    w: refImg.width,
    h: refImg.height,
    score: +best.score.toFixed(2),
    mode: "template-match",
  };
}

/** Crop live to the isolated frame's matched region (same geometry for visualDiff). */
function alignIsolatedLive(refImg, liveImg) {
  const match = findBestTemplateMatch(refImg, liveImg);
  if (!match || match.mode === "full-panel") {
    return { refImg, liveImg, alignment: { mode: "full-panel" } };
  }
  const cropped = cropImage(liveImg, match.x, match.y, match.w, match.h);
  const liveAligned = padImg(cropped, refImg.width, refImg.height);
  return {
    refImg,
    liveImg: liveAligned,
    alignment: {
      mode: match.mode,
      x: match.x,
      y: match.y,
      w: match.w,
      h: match.h,
      score: match.score,
    },
  };
}

/**
 * Drive states via existing state-capture.mjs (real Playwright hover/click/focus).
 * Copies captures into judge2/live-<id>.png and returns the manifest.
 */
async function captureStates(phaseDir, { url, ws }) {
  const outRoot = path.join(phaseDir, "judge2");
  await fs.mkdir(outRoot, { recursive: true });
  // state-capture writes composed-audit/live-<id>.png — point it there then copy
  const r = spawnSync(process.execPath, [
    path.join(ROOT, "scripts/state-capture.mjs"),
    phaseDir,
    "--url", url,
    "--connect", ws,
  ], { encoding: "utf8" });
  // exit 2 = some guards failed — still usable for confirmed ones
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);

  const manifest = (await loadJson(path.join(phaseDir, "state-captures.json"))) || { captures: [], ok: false };
  const byCaptureId = {};
  for (const c of manifest.captures || []) {
    if (c.guard?.ok && c.capture && await exists(c.capture)) {
      const dest = path.join(outRoot, `live-${c.captureId}.png`);
      await fs.copyFile(c.capture, dest);
      c.judge2Live = dest;
      byCaptureId[c.captureId] = c;
      byCaptureId[c.state] = c;
    }
  }
  return { manifest, byCaptureId, exitCode: r.status };
}

async function captureResting(phaseDir, { url, ws }) {
  // Reuse composed-audit-style capture via a tiny inline CDP shot through state-capture's browser:
  // simplest: run playwright here once for resting only.
  const chromiumCandidates = [
    process.env.PLAYWRIGHT_CORE,
    "playwright-core",
    path.join(process.env.HOME || "", ".claude/skills/gstack/node_modules/playwright-core/index.js"),
  ].filter(Boolean);
  let chromium = null;
  for (const c of chromiumCandidates) {
    try {
      const mod = c.startsWith("/") ? require(c) : await import(c);
      const pw = mod.default || mod;
      if (pw.chromium) { chromium = pw.chromium; break; }
    } catch { /* next */ }
  }
  if (!chromium) throw new Error("playwright-core not found");
  const browser = await chromium.connectOverCDP(ws.startsWith("http") ? ws : ws);
  const context = browser.contexts()[0] || await browser.newContext();
  let page = context.pages().find((p) => /localhost|127\.0\.0\.1/.test(p.url())) || context.pages()[0];
  if (!page) page = await context.newPage();
  // Prefer the pinned run URL (documentId isolation) — host match alone can leave the wrong doc.
  try {
    const want = new URL(url);
    const have = new URL(page.url());
    if (have.host !== want.host || have.search !== want.search || have.pathname !== want.pathname) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    }
  } catch {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  }
  await page.waitForTimeout(600);
  // Open the comments sidebar if collapsed — WITHOUT this, panel selectors match a
  // zero/transparent closed shell and every resting chromatic region fires ~97% bogus.
  await page.evaluate(async () => {
    const rail = document.querySelector(".hw-rail");
    const railNarrow = rail && rail.getBoundingClientRect().width < 50;
    const tog = document.querySelector(".hw-sidebar-toggle, [aria-label*='comment' i]");
    if (!tog) return;
    const open = tog.classList.contains("hw-sidebar-toggle--active")
      || /hide/i.test(tog.getAttribute("aria-label") || "");
    if (!open || railNarrow) {
      tog.click();
      await new Promise((r) => setTimeout(r, 800));
    }
  });
  await page.waitForTimeout(400);
  // Reset any lingering hover/selection (keep sidebar open)
  await page.keyboard.press("Escape").catch(() => {});
  await page.mouse.move(4, 4).catch(() => {});
  await page.waitForTimeout(300);
  const out = path.join(phaseDir, "judge2", "live-panel.png");
  await fs.mkdir(path.dirname(out), { recursive: true });
  const handle = await page.evaluateHandle(() => {
    for (const s of ["app-comment-sidebar-panel", ".vc-panel", ".hw-rail-inner", ".hw-rail"]) {
      for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        if (r.width > 40 && r.height > 40 && getComputedStyle(el).visibility !== "hidden"
            && getComputedStyle(el).opacity !== "0") return el;
      }
    }
    return null;
  });
  const el = handle.asElement();
  if (!el) {
    throw new Error(
      "judge2 captureResting: comments sidebar panel not visible after open attempt — " +
      "refusing full-page screenshot (that produced bogus ~97% chromatic diffs)"
    );
  }
  try { await el.screenshot({ path: out, timeout: 8000 }); }
  catch { await page.screenshot({ path: out, fullPage: false }); }
  return out;
}

const REQUIRED_INTERACTION_STATES = new Set(["hover", "selected", "focus", "focus-typing"]);

function resolveLiveForBlock(block, { restingPath, bindings, byCaptureId }) {
  const id = block.id;
  // Prefer explicit binding.blockIds membership
  for (const b of bindings?.bindings || []) {
    if ((b.blockIds || []).includes(id)) {
      const cap = byCaptureId[b.captureId] || byCaptureId[b.state];
      if (cap?.judge2Live) {
        return { livePath: cap.judge2Live, state: b.state, captureId: b.captureId, driven: true, blocked: false };
      }
      const required = REQUIRED_INTERACTION_STATES.has(b.state) || REQUIRED_INTERACTION_STATES.has(inferStateFromBlockId(id) || "");
      if (!required || b.optional) {
        // Optional / content-variant binding failed — fall back to resting (do not pretend state was judged)
        return {
          livePath: restingPath,
          state: "resting",
          captureId: "resting",
          driven: true,
          blocked: false,
          note: `optional state '${b.state}' not driven (${cap?.guard?.reason || "guard failed"}); using resting live`,
        };
      }
      return {
        livePath: null,
        state: b.state,
        captureId: b.captureId,
        driven: false,
        blocked: true,
        reason: cap?.guard?.reason || `state '${b.state}' guard failed — cannot compare resting live to ${b.state} Figma frame`,
      };
    }
  }
  // Infer from block id — hover/selected/focus MUST be driven
  const inferred = inferStateFromBlockId(id);
  if (inferred) {
    const cap = byCaptureId[inferred] || byCaptureId["focus-typing"] || byCaptureId["focus"];
    if (cap?.judge2Live) {
      return { livePath: cap.judge2Live, state: inferred, captureId: cap.captureId, driven: true, blocked: false };
    }
    return {
      livePath: null,
      state: inferred,
      captureId: inferred,
      driven: false,
      blocked: true,
      reason: `state '${inferred}' required by block id but was not driven/confirmed`,
    };
  }
  return { livePath: restingPath, state: "resting", captureId: "resting", driven: true, blocked: false };
}

async function diffBlock(b, { phaseDir, outRoot, designSpec, livePath, state, threshold, minFill, minChanged }) {
  const framePath = path.join(phaseDir, "frames", `${b.id}.png`);
  if (!(await exists(framePath))) {
    return { blockId: b.id, status: "skip", reason: "no figma frame", findings: [] };
  }
  if (!(await exists(livePath))) {
    return { blockId: b.id, status: "skip", reason: `missing live capture ${livePath}`, findings: [] };
  }
  const refRaw = decodePNG(await fs.readFile(framePath));
  const liveRaw = decodePNG(await fs.readFile(livePath));
  // CORE: isolated State frames (single card) must NOT be top-left-padded into a full
  // panel — that invents bogus regions and buries real hover/selected chrome misses.
  const aligned = alignIsolatedLive(refRaw, liveRaw);
  const refImg = aligned.refImg;
  const liveImg = aligned.liveImg;
  let alignment = aligned.alignment;
  if (alignment.mode === "template-match") {
    console.log(`· ${b.id}: aligned isolated frame → live@${alignment.x},${alignment.y} score=${alignment.score}`);
  } else if (refRaw.width < liveRaw.width * 0.85 || refRaw.height < liveRaw.height * 0.75) {
    console.log(`· ${b.id}: WARN isolated frame but template-match failed — falling back to full-panel pad`);
    alignment = { ...alignment, mode: "unaligned-pad", warning: "isolated frame could not be matched inside live panel" };
  }
  const scale = liveImg.width > 500 || refImg.width > 500 ? 2 : 1;
  // Tight text masks (pad=1) — pad≥3 was swallowing avatar→name / name→timestamp micro-gaps.
  // Exact bboxes kept separately for gap detection alongside the chromatic pass.
  const maskFrameId = resolveMaskFrameId(b, designSpec);
  const masks = designSpec
    ? textMasksFromSpec(designSpec, { scale, pad: 1, frameId: maskFrameId })
    : [];
  const textBoxes = designSpec
    ? textBoxesFromSpec(designSpec, { scale, frameId: maskFrameId })
    : [];
  const diff = visualDiff(refImg, liveImg, {
    masks, threshold, cell: 28, scale, minChanged, minFill,
    meanShift: true, minLumDelta: 5,
    textBoxes, detectGaps: !!textBoxes.length,
  });
  const blockDir = path.join(outRoot, "blocks", b.id);
  await fs.mkdir(blockDir, { recursive: true });
  const diffPng = path.join(blockDir, "diff.png");
  await fs.writeFile(diffPng, encodePNG(diff._w, diff._h, diff._diff));
  // Persist the ALIGNED live crop the agent should read (not the raw full panel)
  const liveAlignedP = path.join(blockDir, "live-used.png");
  await fs.writeFile(liveAlignedP, encodePNG(liveImg.width, liveImg.height, liveImg.data));
  await fs.writeFile(path.join(blockDir, "figma-used.png"), encodePNG(refImg.width, refImg.height, refImg.data));

  const significant = (diff.regions || [])
    .filter((r) => r.changed >= minChanged && r.fill >= minFill)
    .sort((a, c) => (c.w * c.h) - (a.w * a.h))
    .slice(0, 12);

  const regionFindings = [];
  for (let i = 0; i < significant.length; i++) {
    const r = significant[i];
    const pad = 8;
    const box = {
      x: Math.max(0, r.x - pad),
      y: Math.max(0, r.y - pad),
      w: Math.min(diff._w - Math.max(0, r.x - pad), r.w + pad * 2),
      h: Math.min(diff._h - Math.max(0, r.y - pad), r.h + pad * 2),
    };
    const liveCrop = cropImage(liveImg, box.x, box.y, box.w, box.h);
    const figCrop = cropImage(padImg(refImg, diff._w, diff._h), box.x, box.y, box.w, box.h);
    const slug = `r${i}-${box.x}-${box.y}`;
    const liveCropP = path.join(blockDir, `${slug}-live.png`);
    const figCropP = path.join(blockDir, `${slug}-figma.png`);
    await fs.writeFile(liveCropP, encodePNG(liveCrop.width, liveCrop.height, liveCrop.data));
    await fs.writeFile(figCropP, encodePNG(figCrop.width, figCrop.height, figCrop.data));
    const sug = suggestLabel(r, diff._h, { state });
    regionFindings.push({
      id: `${b.id}.${sug.id}`,
      blockId: b.id,
      state,
      issue: sug.issue,
      kind: "visual",
      detector: r.detector || "chromatic-diff",
      meanLumDelta: r.meanLumDelta,
      region: { x: r.x, y: r.y, w: r.w, h: r.h, fill: r.fill, changed: r.changed, cssBox: r.cssBox },
      evidence: {
        liveCrop: liveCropP,
        figmaCrop: figCropP,
        diffPng,
        liveUsed: liveAlignedP,
        livePanel: livePath,
        alignment,
        band: regionBand(r.y, r.h, diff._h),
        state,
      },
      named: false,
      confidence: alignment.mode === "template-match" ? "medium" : "low",
    });
  }

  return {
    blockId: b.id,
    status: significant.length ? "diff" : "match",
    state,
    liveUsed: liveAlignedP,
    livePanel: livePath,
    alignment,
    diffPct: diff.diffPct,
    changedPixels: diff.changedPixels,
    regionCount: significant.length,
    meanShiftCount: diff.meanShiftCount || 0,
    gapCount: diff.gapCount || 0,
    masks: masks.length,
    textBoxes: textBoxes.length,
    frame: framePath,
    live: livePath,
    diffPng,
    findings: regionFindings,
  };
}

/**
 * Same-geometry pass: resting live vs driven-hover live.
 * Catches hover-bg tint (and other reveal chrome) that Figma-frame↔full-panel compare misses
 * because compositions don't align — per-pixel threshold also misses uniform Δlum≈8 fills.
 */
async function diffHoverLiveDelta({ outRoot, restingPath, hoverPath }) {
  if (!(await exists(restingPath)) || !(await exists(hoverPath))) return null;
  const refImg = decodePNG(await fs.readFile(restingPath));
  const liveImg = decodePNG(await fs.readFile(hoverPath));
  const scale = liveImg.width > 500 ? 2 : 1;
  const diff = visualDiff(refImg, liveImg, {
    masks: [],
    threshold: 0.12,
    cell: 28,
    scale,
    minChanged: 40,
    minFill: 0.05,
    meanShift: true,
    minLumDelta: 5,
    meanShiftMinArea: 32 * 32,
  });
  const blockDir = path.join(outRoot, "blocks", "_hover-live-delta");
  await fs.mkdir(blockDir, { recursive: true });
  const diffPng = path.join(blockDir, "diff.png");
  await fs.writeFile(diffPng, encodePNG(diff._w, diff._h, diff._diff));

  const significant = (diff.regions || [])
    .sort((a, c) => (c.w * c.h) - (a.w * a.h))
    .slice(0, 8);
  const findings = [];
  for (let i = 0; i < significant.length; i++) {
    const r = significant[i];
    const sug = r.detector === "mean-shift"
      ? { id: "hover-bg-tint-mismatch", issue: `hover vs resting: uniform card/panel tint shift (mean luminance Δ${r.meanLumDelta}) — sub-threshold fill caught by mean-shift` }
      : suggestLabel(r, diff._h, { state: "hover" });
    const pad = 8;
    const box = {
      x: Math.max(0, r.x - pad),
      y: Math.max(0, r.y - pad),
      w: Math.min(diff._w - Math.max(0, r.x - pad), r.w + pad * 2),
      h: Math.min(diff._h - Math.max(0, r.y - pad), r.h + pad * 2),
    };
    const liveCrop = cropImage(liveImg, box.x, box.y, box.w, box.h);
    const figCrop = cropImage(refImg, box.x, box.y, box.w, box.h); // resting as "baseline"
    const slug = `r${i}-${box.x}-${box.y}`;
    const liveCropP = path.join(blockDir, `${slug}-hover.png`);
    const restCropP = path.join(blockDir, `${slug}-resting.png`);
    await fs.writeFile(liveCropP, encodePNG(liveCrop.width, liveCrop.height, liveCrop.data));
    await fs.writeFile(restCropP, encodePNG(figCrop.width, figCrop.height, figCrop.data));
    findings.push({
      id: `hover-live-delta.${sug.id}`,
      blockId: "state-comment-thread-components-single-comment-dialog-hover",
      state: "hover",
      issue: sug.issue,
      kind: "visual",
      detector: r.detector || "hover-live-delta",
      meanLumDelta: r.meanLumDelta,
      region: { x: r.x, y: r.y, w: r.w, h: r.h, fill: r.fill, changed: r.changed, cssBox: r.cssBox },
      evidence: {
        liveCrop: liveCropP,
        figmaCrop: restCropP,
        diffPng,
        liveUsed: hoverPath,
        restingUsed: restingPath,
        band: regionBand(r.y, r.h, diff._h),
        state: "hover",
        compare: "resting-live-vs-hover-live",
      },
      named: false,
      confidence: r.detector === "mean-shift" ? "medium" : "low",
    });
  }
  const result = {
    blockId: "_hover-live-delta",
    status: findings.length ? "diff" : "match",
    state: "hover",
    compare: "resting-live-vs-hover-live",
    diffPct: diff.diffPct,
    changedPixels: diff.changedPixels,
    meanShiftCount: diff.meanShiftCount || 0,
    regionCount: findings.length,
    findings,
  };
  await fs.writeFile(path.join(blockDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

function resolveMaskFrameId(block, designSpec) {
  const nodes = designSpec?.nodes || [];
  if (!nodes.length) return null;
  if (block.figmaNodeId && nodes.some((n) => n.frameId === block.figmaNodeId)) return block.figmaNodeId;
  // State-frame ids often aren't tagged in designSpec — only apply section-frame fallback for
  // full-panel resting compares where section boxes roughly align with the sidebar capture.
  if (block.role === "flow" || block.id === "flow" || !inferStateFromBlockId(block.id)) {
    const counts = {};
    for (const n of nodes) {
      if (!n.frameId || !(n.text || /^(avatar|profile picture)$/i.test((n.name || "").trim()))) continue;
      counts[n.frameId] = (counts[n.frameId] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }
  return null;
}

export async function runJudge2Chromatic(phaseDir, { url, ws, write = true, threshold = 0.12, minFill = 0.08, minChanged = 80 } = {}) {
  if (!url || !ws) throw new Error("--url and --connect required");
  const blocksDoc = await loadJson(path.join(phaseDir, "blocks.json")) || { blocks: [] };
  const blocks = blocksDoc.blocks || [];
  const designSpec = await loadJson(path.join(phaseDir, "designSpec.json"));
  const outRoot = path.join(phaseDir, "judge2");
  await fs.mkdir(outRoot, { recursive: true });

  const bindings = await ensureStateBindings(phaseDir);

  console.log("· capturing RESTING live panel…");
  const restingPath = await captureResting(phaseDir, { url, ws });

  console.log("· driving hover / selected / focus states…");
  const { manifest: stateManifest, byCaptureId, exitCode: stateExit } = await captureStates(phaseDir, { url, ws });

  const findings = [];
  const blockResults = [];
  const blockedStates = [];

  for (const b of blocks) {
    const resolved = resolveLiveForBlock(b, { restingPath, bindings, byCaptureId });
    if (resolved.blocked) {
      const finding = {
        id: `${b.id}.state-not-driven`,
        blockId: b.id,
        state: resolved.state,
        issue: resolved.reason,
        kind: "state",
        detector: "state-drive",
        named: true,
        confidence: "high",
        discard: false,
        evidence: { band: "state", state: resolved.state },
      };
      findings.push(finding);
      blockedStates.push({ blockId: b.id, state: resolved.state, reason: resolved.reason });
      const result = {
        blockId: b.id,
        status: "blocked-state",
        state: resolved.state,
        reason: resolved.reason,
        findings: [finding],
      };
      blockResults.push(result);
      const blockDir = path.join(outRoot, "blocks", b.id);
      await fs.mkdir(blockDir, { recursive: true });
      await fs.writeFile(path.join(blockDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
      console.log(`· ${b.id}: blocked-state (${resolved.state}) — ${resolved.reason}`);
      continue;
    }

    const result = await diffBlock(b, {
      phaseDir, outRoot, designSpec,
      livePath: resolved.livePath,
      state: resolved.state,
      threshold, minFill, minChanged,
    });
    blockResults.push(result);
    for (const f of result.findings || []) findings.push(f);
    await fs.writeFile(path.join(outRoot, "blocks", b.id, "result.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(`· ${b.id}: ${result.status} state=${resolved.state} diffPct=${result.diffPct ?? "—"}% regions=${result.regionCount ?? 0}`);
  }

  // Same-geometry hover delta (resting live ↔ hover live) — catches hover-bg tint etc.
  const hoverCap = byCaptureId.hover || byCaptureId["hover"];
  if (hoverCap?.judge2Live) {
    console.log("· mean-shift pass: resting live vs hover live…");
    const delta = await diffHoverLiveDelta({
      outRoot,
      restingPath,
      hoverPath: hoverCap.judge2Live,
    });
    if (delta) {
      blockResults.push(delta);
      for (const f of delta.findings || []) findings.push(f);
      console.log(`· _hover-live-delta: ${delta.status} changed=${delta.changedPixels} meanShift=${delta.meanShiftCount} regions=${delta.regionCount}`);
    }
  }

  // Mechanical chrome probes chromatic MISSES (already named + demoBreaking):
  // clipped/invisible L/R card ring, Show-N "lines around arrow", inter-dialog gap.
  // Merged into findings[] so Builder sees them even when pixel regions bury the issue.
  console.log("· chrome probes (card sides + Show-N rail + list gap)…");
  let chromeProbes = null;
  try {
    chromeProbes = await runJudge2ChromeProbes(phaseDir, { url, ws, write: true });
    for (const f of chromeProbes.findings || []) findings.push(f);
    const n = (chromeProbes.findings || []).length;
    console.log(`· chrome-probes: ${n} finding(s)` + (n ? ` → ${chromeProbes.findings.map((f) => f.id).join(", ")}` : ""));
  } catch (e) {
    console.error("· chrome-probes failed: " + e.message);
  }

  const report = {
    kind: "judge2-chromatic",
    at: new Date().toISOString(),
    phaseDir,
    url,
    livePanel: restingPath,
    stateCaptures: stateManifest,
    stateExit,
    chromeProbes,
    threshold,
    blocks: blockResults,
    findings,
    blockedStates,
    summary: {
      blocksTotal: blocks.length,
      blocksDiff: blockResults.filter((b) => b.status === "diff").length,
      blocksMatch: blockResults.filter((b) => b.status === "match").length,
      blocksBlockedState: blockResults.filter((b) => b.status === "blocked-state").length,
      findingCount: findings.length,
      statesConfirmed: Object.keys(byCaptureId).filter((k, i, a) => a.indexOf(k) === i && byCaptureId[k]?.judge2Live).length,
    },
    note: "Baseline = Figma frame. Test = matching live capture (resting OR driven hover/selected/focus). State-bound blocks whose guard failed are blocked-state findings — never silently compared to resting.",
  };

  if (write) {
    await fs.writeFile(path.join(outRoot, "report.json"), JSON.stringify(report, null, 2) + "\n");
    const md = [
      `# Judge-2 Chromatic report`,
      ``,
      `Resting live: \`${restingPath}\``,
      `States confirmed: **${report.summary.statesConfirmed}** · blocked blocks: **${report.summary.blocksBlockedState}**`,
      `Blocks with diffs: **${report.summary.blocksDiff}** / ${report.summary.blocksTotal}`,
      `Regions/findings: **${report.summary.findingCount}**`,
      ``,
      `## State captures`,
      ``,
      ...(stateManifest.captures || []).map((c) =>
        `- **${c.state}** (${c.captureId}): guard=${c.guard?.ok ? "ok" : "FAIL"} ${c.guard?.ok ? `→ \`${c.judge2Live || c.capture}\`` : `— ${c.guard?.reason || ""}`}`),
      ``,
      `## Findings`,
      ``,
      ...findings.map((f, i) =>
        `${i + 1}. \`${f.id}\` [${f.state || "?"}] — ${f.issue}\n` +
        `   - block: ${f.blockId}` +
        (f.evidence?.liveCrop ? `\n   - live: \`${f.evidence.liveCrop}\`` : "") +
        (f.evidence?.figmaCrop ? `\n   - figma: \`${f.evidence.figmaCrop}\`` : "")),
      ``,
    ].join("\n");
    await fs.writeFile(path.join(outRoot, "REPORT.md"), md);
  }

  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const phaseDir = args.find((a, i) => !a.startsWith("--") && (i === 0 || !["--url", "--connect"].includes(args[i - 1])));
  const url = flag("--url");
  const ws = flag("--connect");
  if (!phaseDir || !url || !ws) {
    console.error("usage: judge2-chromatic.mjs <phaseDir> --url <url> --connect <ws> [--write]");
    process.exit(1);
  }
  runJudge2Chromatic(phaseDir, { url, ws, write: true }).then((r) => {
    console.log(JSON.stringify(r.summary, null, 2));
    const bad = r.summary.findingCount > 0 || r.summary.blocksBlockedState > 0;
    process.exit(bad ? 2 : 0);
  }).catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

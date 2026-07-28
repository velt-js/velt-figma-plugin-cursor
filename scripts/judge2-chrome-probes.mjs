#!/usr/bin/env node
// judge2-chrome-probes.mjs — mechanical chrome checks Judge-2 chromatic pixel-diff MISSES.
// These produce already-named, demo-breaking findings that must surface to Builder.
//
// Catches:
//   1) card L/R ring invisible (outside box-shadow clipped by overflow:auto, or no ring)
//   2) Show-N "lines around arrow" wrong vs Figma — missing segments above/below chevron,
//      OR through-line with no gap (Figma is segmented)
//   3) inter-dialog list gap vs plan-style 369:29437 (16px, band 12–20)
//
// Usage:
//   node scripts/judge2-chrome-probes.mjs <phaseDir> --url <url> --connect <ws> [--write]
// Exit 2 when any probe fails.

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { decodePNG } from "./visual-diff.mjs";

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

function lum(data, w, x, y) {
  const i = (y * w + x) * 4;
  return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
}

function isRailPixel(data, w, x, y) {
  if (x < 0 || y < 0 || x >= w) return false;
  const i = (y * w + x) * 4;
  const r = data[i], g = data[i + 1], b = data[i + 2];
  const L = 0.299 * r + 0.587 * g + 0.114 * b;
  return Math.abs(r - g) < 18 && Math.abs(g - b) < 18 && L < 232 && L > 150;
}

function railDensity(data, w, x, y0, y1) {
  let hits = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    n++;
    let f = false;
    for (let dx = -3; dx <= 3; dx++) {
      if (isRailPixel(data, w, x + dx, y)) { f = true; break; }
    }
    if (f) hits++;
  }
  return n ? hits / n : 0;
}

function edgeRingDensity(data, w, h, side /* "left"|"right" */) {
  // Sample a 2px column just inside the card edge for #e4e1dd-ish ring
  const x = side === "left" ? 1 : Math.max(0, w - 2);
  let hits = 0, n = 0;
  const y0 = Math.floor(h * 0.15);
  const y1 = Math.floor(h * 0.85);
  for (let y = y0; y <= y1; y++) {
    n++;
    const L = lum(data, w, x, y);
    // ring ~#e4e1dd (L≈225) on white (L≈255) — count mid-light gray
    if (L > 180 && L < 240) hits++;
  }
  return n ? hits / n : 0;
}

function chromeFinding(partial) {
  return {
    kind: "chrome",
    detector: "judge2-chrome-probe",
    confidence: "high",
    named: true,
    demoBreaking: true,
    priority: "high",
    state: "resting",
    ...partial,
  };
}

export async function runJudge2ChromeProbes(phaseDir, { url, ws, write = true } = {}) {
  if (!url || !ws) throw new Error("--url and --connect required");
  const chromium = await loadPlaywright();
  const browser = await chromium.connectOverCDP(ws.startsWith("http") ? ws : ws);
  const context = browser.contexts()[0] || await browser.newContext();
  let page = context.pages().find((p) => /localhost|127\.0\.0\.1/.test(p.url())) || context.pages()[0];
  if (!page) page = await context.newPage();
  if (!page.url().includes(new URL(url).host)) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  }
  await page.waitForTimeout(600);

  const logged = await page.evaluate(() => !!document.querySelector(".hw-user-name"));
  if (!logged) {
    const sel = page.locator("#hw-user-select");
    if (await sel.count()) {
      await sel.selectOption("user1").catch(() => {});
      await page.waitForTimeout(2500);
    }
  }
  await page.evaluate(async () => {
    const tog = document.querySelector(".hw-sidebar-toggle");
    if (!tog) return;
    const open = tog.classList.contains("hw-sidebar-toggle--active") || /hide/i.test(tog.getAttribute("aria-label") || "");
    if (!open) { tog.click(); await new Promise((r) => setTimeout(r, 800)); }
  });
  await page.waitForTimeout(1200);

  const outDir = path.join(phaseDir, "judge2");
  const cropDir = path.join(outDir, "chrome-probe-crops");
  if (write) await fs.mkdir(cropDir, { recursive: true });

  const result = await page.evaluate(() => {
    const findings = [];
    const list = document.querySelector("app-comment-sidebar-list, .vc-list");
    const listR = list?.getBoundingClientRect();
    const listOverflow = list ? getComputedStyle(list).overflow + "/" + getComputedStyle(list).overflowX : "";

    const bodies = [...document.querySelectorAll(".vc-body")].filter((el) => el.getBoundingClientRect().width > 40);
    let clippedSides = 0;
    let noRing = 0;
    const samples = [];
    for (const el of bodies.slice(0, 6)) {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const borderL = parseFloat(s.borderLeftWidth) || 0;
      const borderR = parseFloat(s.borderRightWidth) || 0;
      const hasBorderRing = borderL >= 1 && borderR >= 1 && s.borderLeftStyle !== "none";
      const shadow = s.boxShadow || "none";
      const hasShadowRing = /0px\s+0px\s+0px\s+1px/i.test(shadow);
      const leftInset = listR ? r.x - listR.x : 99;
      const rightInset = listR ? (listR.x + listR.width) - (r.x + r.width) : 99;
      const clipped = hasShadowRing && !hasBorderRing && leftInset < 1.5 && rightInset < 1.5 && /auto|hidden|scroll/.test(listOverflow);
      if (!hasBorderRing && !hasShadowRing) noRing++;
      if (clipped) clippedSides++;
      samples.push({
        w: Math.round(r.width), h: Math.round(r.height),
        leftInset: +leftInset.toFixed(1), rightInset: +rightInset.toFixed(1),
        borderL, borderR, hasBorderRing, hasShadowRing, clipped,
      });
    }
    if (bodies.length && (clippedSides > 0 || noRing === bodies.length)) {
      findings.push({
        id: "card-side-borders-invisible",
        issue: clippedSides
          ? "Card L/R ring exists as outside box-shadow but is clipped by overflow list (left/right flush) — top/bottom may still show"
          : "Card bodies have no visible L/R border or box-shadow ring",
        blockId: "flow",
        evidence: { samples, listOverflow, clippedSides, noRing, bodies: bodies.length },
        _domOnly: true,
      });
    }

    // Double border — Figma single-comment frames show ONE 1px ring. Live often stacks
    // .vc-body { border:1px } + dialog--selected { box-shadow:0 0 0 1px } (or body border+shadow).
    let doubleBorder = 0;
    const doubleSamples = [];
    for (const el of bodies.slice(0, 8)) {
      const s = getComputedStyle(el);
      const hasBorder = (parseFloat(s.borderLeftWidth) || 0) >= 1 && s.borderLeftStyle !== "none";
      const hasShadowRing = /0px\s+0px\s+0px\s+1px/i.test(s.boxShadow || "");
      const dialog = el.closest("velt-comment-dialog, .velt-comment-dialog") || el.parentElement;
      const ds = dialog ? getComputedStyle(dialog) : null;
      const dialogShadowRing = ds && /0px\s+0px\s+0px\s+1px/i.test(ds.boxShadow || "");
      const dialogBorder = ds && (parseFloat(ds.borderLeftWidth) || 0) >= 1;
      const stacked = (hasBorder && hasShadowRing)
        || (hasBorder && dialogShadowRing)
        || (hasShadowRing && dialogBorder && dialog !== el);
      if (stacked) {
        doubleBorder++;
        doubleSamples.push({
          bodyBorder: hasBorder, bodyShadow: hasShadowRing,
          dialogShadow: !!dialogShadowRing, dialogBorder: !!dialogBorder,
          selected: !!(dialog && /selected/i.test(dialog.className || "")),
        });
      }
    }
    if (doubleBorder > 0) {
      findings.push({
        id: "card-double-border",
        issue: `Card shows stacked rings (border + box-shadow on body and/or selected dialog) on ${doubleBorder} card(s) — Figma draws a single 1px #e4e1dd edge`,
        blockId: "state-comment-thread-components-single-comment-dialog",
        evidence: { doubleBorder, doubleSamples },
        _domOnly: true,
      });
    }

    // Thread rail ONLY when 2+ comments (Figma single-comment dialogs have NO vertical connector).
    // Fail when a card has ≤1 sized avatar, no populated Show-N, but a visible .vc-connector / continuous rail.
    let railOnSingle = 0;
    const railSingleSamples = [];
    for (const el of bodies.slice(0, 8)) {
      const avatars = [...el.querySelectorAll(".vc-avatar, velt-comment-dialog-thread-card-avatar-internal")]
        .filter((a) => {
          const r = a.getBoundingClientRect();
          return r.width >= 16 && r.height >= 16;
        });
      // de-dupe overlapping avatar wrappers (same centre)
      const uniqAv = [];
      for (const a of avatars) {
        const r = a.getBoundingClientRect();
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        if (uniqAv.some((u) => Math.hypot(u.cx - cx, u.cy - cy) < 4)) continue;
        uniqAv.push({ cx, cy });
      }
      const morePop = [...el.querySelectorAll("velt-comment-dialog-more-reply-internal")]
        .some((m) => m.getBoundingClientRect().height > 10 && m.querySelector('[role="button"]'));
      const threads = el.querySelector("velt-comment-dialog-threads-internal, .vc-threads");
      const connectors = [...(el.querySelectorAll(".vc-connector") || [])].filter((c) => {
        const r = c.getBoundingClientRect();
        const cs = getComputedStyle(c);
        return r.height > 8 && (parseFloat(cs.opacity) || 0) > 0.05;
      });
      const before = threads ? getComputedStyle(threads, "::before") : null;
      const contH = before && before.content !== "none" ? parseFloat(before.height) || 0 : 0;
      const contOn = contH >= 20 && parseFloat(before?.borderLeftWidth || "0") >= 1;
      const singleComment = uniqAv.length <= 1 && !morePop;
      if (singleComment && (connectors.length > 0 || contOn)) {
        railOnSingle++;
        railSingleSamples.push({
          avatars: uniqAv.length,
          morePop,
          connectorHeights: connectors.map((c) => Math.round(c.getBoundingClientRect().height)),
          continuousRailH: Math.round(contH),
          msg: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 48),
        });
      }
    }
    if (railOnSingle > 0) {
      findings.push({
        id: "thread-rail-on-single-comment",
        issue: `Vertical thread connector visible on ${railOnSingle} single-comment card(s) — Figma only draws the rail when there are 2+ comments/replies`,
        blockId: "state-comment-thread-components-single-comment-dialog",
        evidence: { railOnSingle, railSingleSamples },
        _domOnly: true,
      });
    }

    // Inter-dialog gap — plan-style .vc-list / .velt-sidebar-content gap 16px (369:29437)
    const uniqBodies = [];
    for (const el of bodies) {
      const r = el.getBoundingClientRect();
      if (uniqBodies.some((u) => Math.abs(u.y - r.y) < 2)) continue;
      uniqBodies.push({ y: r.y, bottom: r.bottom, h: r.height });
    }
    uniqBodies.sort((a, b) => a.y - b.y);
    const gaps = [];
    for (let i = 0; i < uniqBodies.length - 1; i++) {
      const g = uniqBodies[i + 1].y - uniqBodies[i].bottom;
      if (g > 0.5) gaps.push(+g.toFixed(1));
    }
    if (gaps.length) {
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      if (mean < 12 || mean > 20) {
        findings.push({
          id: "inter-dialog-gap-mismatch",
          issue: `Inter-dialog list gap mean ${mean.toFixed(1)}px — plan-style 369:29437 expects 16px (band 12–20)`,
          blockId: "state-comment-thread-components-multiple-comments",
          evidence: { gaps, mean: +mean.toFixed(1), expected: 16 },
          _domOnly: true,
        });
      }
    }

    // DOM pre-check for Show-N rail (pixel pass below confirms visually)
    const moreRows = [...document.querySelectorAll("velt-comment-dialog-more-reply-internal")]
      .filter((el) => el.getBoundingClientRect().height > 10 && el.querySelector('[role="button"]'));
    const moreTargets = moreRows.slice(0, 3).map((more, idx) => {
      const r = more.getBoundingClientRect();
      const threads = more.closest("velt-comment-dialog-threads-internal, .vc-threads");
      const body = more.closest(".vc-body");
      const av = body?.querySelector(".vc-avatar")?.getBoundingClientRect();
      const connectors = threads
        ? [...(threads.querySelectorAll(".vc-connector") || [])].map((c) => {
            const cr = c.getBoundingClientRect();
            const cs = getComputedStyle(c);
            return { h: cr.height, opacity: parseFloat(cs.opacity) || 0 };
          }).filter((c) => c.opacity > 0.05 && c.h > 2)
        : [];
      const beforeThreads = threads ? getComputedStyle(threads, "::before") : null;
      const afterMore = getComputedStyle(more, "::after");
      const threadsRailH = beforeThreads && beforeThreads.content !== "none"
        ? parseFloat(beforeThreads.height) || 0
        : 0;
      const threadsRailOn = threadsRailH >= 40 && parseFloat(beforeThreads?.borderLeftWidth || "0") >= 1;
      const maskH = afterMore && afterMore.content !== "none" ? parseFloat(afterMore.height) || 0 : 0;
      const maskBg = (afterMore.backgroundColor || "").replace(/\s/g, "");
      const maskIsWhite = /rgba?\(255,255,255/.test(maskBg) || maskBg === "rgb(255,255,255)";
      const hasGapMask = maskH >= 16 && maskIsWhite;
      const shortOnly = connectors.length > 0 && connectors.every((c) => c.h <= 28);
      const throughLine = threadsRailOn && !hasGapMask;
      const noRail = !threadsRailOn && (connectors.length === 0 || shortOnly);
      return {
        idx,
        hasThreads: !!threads,
        throughLine,
        noRail,
        threadsRailH: Math.round(threadsRailH),
        hasGapMask,
        maskH: Math.round(maskH),
        connectorHeights: connectors.map((c) => Math.round(c.h)),
        moreBox: { w: Math.round(r.width), h: Math.round(r.height) },
        // geometry for pixel crop (viewport)
        bodyBox: body ? {
          x: body.getBoundingClientRect().x,
          y: body.getBoundingClientRect().y,
          w: body.getBoundingClientRect().width,
          h: body.getBoundingClientRect().height,
        } : null,
        moreRel: body ? {
          top: r.top - body.getBoundingClientRect().y,
          bottom: r.bottom - body.getBoundingClientRect().y,
          mid: (r.top + r.bottom) / 2 - body.getBoundingClientRect().y,
        } : null,
        avCxRel: av && body ? (av.x + av.width / 2) - body.getBoundingClientRect().x : 25,
      };
    });

    return {
      findings,
      bodies: bodies.length,
      moreRows: moreRows.length,
      gaps,
      moreTargets,
      // first sized body for border pixel check
      borderTarget: bodies[0] ? (() => {
        const r = bodies[0].getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })() : null,
    };
  });

  const findings = (result.findings || []).map((f) => {
    const { _domOnly, ...rest } = f;
    return chromeFinding(rest);
  });

  // --- Pixel pass: card L/R ring visibility ---
  if (result.borderTarget && write) {
    const b = result.borderTarget;
    const cropPath = path.join(cropDir, "card-border-sample.png");
    try {
      await page.screenshot({
        path: cropPath,
        clip: {
          x: Math.max(0, b.x),
          y: Math.max(0, b.y),
          width: Math.ceil(b.w),
          height: Math.min(Math.ceil(b.h), 280),
        },
      });
      const img = decodePNG(await fs.readFile(cropPath));
      const leftD = edgeRingDensity(img.data, img.width, img.height, "left");
      const rightD = edgeRingDensity(img.data, img.width, img.height, "right");
      // Retina: edge may be 2 device px — also sample x=2 / w-3
      const leftD2 = edgeRingDensity(img.data, img.width, img.height, "left");
      const visible = leftD >= 0.25 && rightD >= 0.25;
      const already = findings.some((f) => f.id === "card-side-borders-invisible");
      if (!visible && !already) {
        findings.push(chromeFinding({
          id: "card-side-borders-invisible",
          issue: `Card L/R ring not visible in pixels (left density ${(leftD * 100).toFixed(0)}%, right ${(rightD * 100).toFixed(0)}%) — Figma draws a 1px #e4e1dd ring on all four sides`,
          blockId: "flow",
          evidence: {
            liveCrop: cropPath,
            leftDensity: +leftD.toFixed(3),
            rightDensity: +rightD.toFixed(3),
            note: "Pixel check on live card edge — catches clipped outside box-shadow",
          },
        }));
      } else if (already) {
        const f = findings.find((x) => x.id === "card-side-borders-invisible");
        f.evidence = { ...f.evidence, liveCrop: cropPath, leftDensity: +leftD.toFixed(3), rightDensity: +rightD.toFixed(3) };
      }
      void leftD2;
    } catch (e) {
      // non-fatal — DOM finding may still stand
      console.error("· border pixel probe skipped: " + e.message);
    }
  }

  // --- Pixel pass: lines around Show-N chevron (the issue pixel-diff buried) ---
  for (const t of result.moreTargets || []) {
    if (!t.bodyBox || !t.moreRel) {
      if (!t.hasThreads) {
        findings.push(chromeFinding({
          id: "thread-rail-show-n-mismatch",
          issue: "Show-N row present but no threads host for the avatar rail",
          blockId: "state-comment-thread-components-single-comment-with-more-than-1-replies",
          evidence: { moreBox: t.moreBox },
        }));
      }
      continue;
    }

    const cropPath = path.join(cropDir, `show-n-rail-${t.idx}.png`);
    let pixelFail = null;
    let pixelEvidence = { ...t, liveCrop: cropPath };

    try {
      if (write) {
        await page.screenshot({
          path: cropPath,
          clip: {
            x: Math.max(0, t.bodyBox.x),
            y: Math.max(0, t.bodyBox.y),
            width: Math.ceil(t.bodyBox.w),
            height: Math.ceil(t.bodyBox.h),
          },
        });
        const img = decodePNG(await fs.readFile(cropPath));
        // device-pixel ratio: screenshot is often 2x CSS box
        const scaleX = img.width / t.bodyBox.w;
        const scaleY = img.height / t.bodyBox.h;
        const railX = Math.round(t.avCxRel * scaleX);
        const moreTop = Math.round(t.moreRel.top * scaleY);
        const moreBottom = Math.round(t.moreRel.bottom * scaleY);
        const moreMid = Math.round(t.moreRel.mid * scaleY);
        // Figma: rail above + below chevron, gap at chevron centre.
        // "Above" band must sit BELOW the avatar (rail starts ~22 CSS px under card top) —
        // sampling from y=0 dilutes density with the avatar disc and false-fails healthy rails.
        const avBottom = Math.round(22 * scaleY);
        const above0 = Math.max(avBottom, moreTop - Math.round(40 * scaleY));
        const above1 = Math.max(above0 + 2, moreTop - Math.round(3 * scaleY));
        const at0 = moreMid - Math.round(5 * scaleY);
        const at1 = moreMid + Math.round(5 * scaleY);
        const below0 = Math.min(img.height - 2, moreBottom + Math.round(3 * scaleY));
        const below1 = Math.min(img.height - 1, Math.max(below0 + 2, moreBottom + Math.round(40 * scaleY)));

        const densAbove = railDensity(img.data, img.width, railX, above0, above1);
        const densAt = railDensity(img.data, img.width, railX, at0, at1);
        const densBelow = railDensity(img.data, img.width, railX, below0, below1);

        pixelEvidence = {
          liveCrop: cropPath,
          densAbove: +densAbove.toFixed(3),
          densAt: +densAt.toFixed(3),
          densBelow: +densBelow.toFixed(3),
          bands: { above0, above1, at0, at1, below0, below1 },
          railX, moreTop, moreBottom, scaleX: +scaleX.toFixed(2),
          dom: {
            throughLine: t.throughLine,
            noRail: t.noRail,
            threadsRailH: t.threadsRailH,
            hasGapMask: t.hasGapMask,
            connectorHeights: t.connectorHeights,
          },
        };

        const domHealthy = t.threadsRailH >= 40 && t.hasGapMask && !t.throughLine && !t.noRail;
        // Strong absence in pixels (both sides dead) — catches DOM lies / paint failures
        const pixelDead = densAbove < 0.12 && densBelow < 0.12;
        // Through-line in pixels when mask missing
        const throughVisual = densAt >= 0.50 && densAbove >= 0.30 && !t.hasGapMask;
        // Missing segments — only when DOM is also unhealthy (avoid false fail on AA/sampling)
        const missingAround = !domHealthy && (densAbove < 0.30 || densBelow < 0.18);

        if (pixelDead) {
          pixelFail = "Show-N chevron has no rail segments above/below (lines around arrow missing) — Figma draws segmented connector stopping short of the glyph";
        } else if (throughVisual) {
          pixelFail = "Show-N rail runs through the chevron — Figma segments it with a clear gap above/below the glyph";
        } else if (missingAround) {
          pixelFail = "Show-N chevron has no proper rail segments (missing or ≤28px stubs only) — Figma draws long segments that stop short of the chevron";
        }
      }
    } catch (e) {
      console.error("· show-n pixel probe skipped: " + e.message);
    }

    // Fire if DOM OR decisive pixel says fail
    if (t.throughLine || t.noRail || pixelFail) {
      const already = findings.some((f) => f.id === "thread-rail-show-n-mismatch" && f.evidence?.liveCrop === cropPath);
      if (!already) {
        findings.push(chromeFinding({
          id: "thread-rail-show-n-mismatch",
          issue: pixelFail
            || (t.throughLine
              ? "Show-N rail runs through the chevron — Figma segments it with a clear gap above/below the glyph"
              : "Show-N chevron has no proper rail segments (missing or ≤28px stubs only) — Figma draws long segments that stop short of the chevron"),
          blockId: "state-comment-thread-components-single-comment-with-more-than-1-replies",
          evidence: pixelEvidence,
        }));
      }
    }
  }

  if ((result.bodies || 0) < 1) {
    findings.push(chromeFinding({
      id: "chrome-probe-empty-sidebar",
      issue: "Chrome probes found no sized .vc-body cards — sidebar empty or not ready; results are inconclusive",
      blockId: "flow",
      evidence: { bodies: result.bodies, moreRows: result.moreRows },
    }));
  }

  // NOTE: Do NOT hardcode design-specific chrome (e.g. "resolve button on hover").
  // Those are caught by judge2-chromatic after isolated-frame alignment + a driven
  // hover capture. This file only covers mechanical classes pixel-diff buries
  // (overflow clip, double ring, rail geometry, list gap).

  const doc = {
    kind: "judge2-chrome-probes",
    at: new Date().toISOString(),
    url: page.url(),
    findings,
    bodies: result.bodies,
    moreRows: result.moreRows,
    gaps: result.gaps,
    summary: {
      findingCount: findings.length,
      pass: findings.length === 0,
      demoBreaking: findings.filter((f) => f.demoBreaking).length,
    },
  };

  if (write) {
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, "chrome-probes.json"), JSON.stringify(doc, null, 2) + "\n");
  }

  return doc;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const phaseDir = args.find((a, i) => !a.startsWith("--") && (i === 0 || !["--url", "--connect"].includes(args[i - 1])));
  const url = flag("--url");
  const ws = flag("--connect");
  if (!phaseDir || !url || !ws) {
    console.error("usage: judge2-chrome-probes.mjs <phaseDir> --url <url> --connect <ws>");
    process.exit(1);
  }
  runJudge2ChromeProbes(phaseDir, { url, ws, write: true }).then((r) => {
    const n = r.summary?.findingCount || 0;
    if (n === 0) console.log("✓ chrome probes clean\n" + JSON.stringify({ findingCount: 0, pass: true }, null, 2));
    else {
      console.log(JSON.stringify({ findingCount: n, pass: false, demoBreaking: r.summary.demoBreaking }, null, 2));
      for (const f of r.findings || []) console.log(`✗ ${f.id}: ${f.issue}`);
    }
    process.exit(n ? 2 : 0);
  }).catch((e) => { console.error(e); process.exit(1); });
}

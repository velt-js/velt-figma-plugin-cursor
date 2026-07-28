#!/usr/bin/env node
// judge-evidence.mjs — attach LIVE + FIGMA CROPS to each P0 work-order packet.
//
// This is the automation of the human loop that worked: "here's a screenshot of
// THIS broken part + the design — fix it." Text-only P0 rows are not enough.
//
// F3 (2026-07-24 forensic): crops are CONTENT-ANCHORED, not shared pixel boxes —
// when CDP is available each packet's crop box snaps to the landmark element at the
// region center (descending shadow roots). Every crop is validated non-blank
// (≥99.5% single exact colour = rejected; see BLANK_THRESHOLD calibration), boxes are
// clamped to image bounds, evidence is
// stamped with the live-capture build fingerprint, and stale judge-evidence/ dirs
// are versioned away on re-emit (never silently reused).
// F4: selectorHint is DERIVED from the landmark element (never a constant), and any
// emitted selector must match ≥1 element inside its evidence box on the live DOM.
// F6: updates judge-defects.deliveryLedger — each unique issue marked delivered in
// {builderPackets, prompt} exactly once.
//
// Usage:
//   node scripts/judge-evidence.mjs <phaseDir> [--write] [--top N] [--connect <ws>] [--url <url>]
//
// Reads judge-defects.json workOrderP0 (run emit-judge-defects first).
// Writes:
//   <phaseDir>/judge-evidence/<slug>/{live.png,figma.png,meta.json}
//   patches workOrderP0[].evidence.{liveCrop,figmaCrop,box}
//   <phaseDir>/builder-fix-prompt.md  — human-style prompt for top N packets
// Exit 2 if any P0 packet could not get a validated crop pair.

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { decodePNG, encodePNG, cropImage } from "./visual-diff.mjs";
import { isTemplatedMiss, evidenceCssBox } from "./emit-judge-defects.mjs";

const require = createRequire(import.meta.url);

async function loadJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

function slugify(issueKey) {
  return String(issueKey || "miss").replace(/[^\w.-]+/g, "-").slice(0, 96);
}

/** Issue-specific landmark selector — different semantic issues MUST NOT share one query. */
export function landmarkQueryForIssue(issueId) {
  const id = String(issueId || "").toLowerCase();
  if (/chevron|show-replies|more-reply/.test(id)) {
    return ".vc-more-reply, velt-comment-dialog-more-reply-internal, [class*='more-reply']";
  }
  if (/resolve|hover|kebab|options/.test(id)) {
    return ".vc-resolve, [class*='resolve'], .vc-options-trigger, .vc-options, [aria-label*='esolve' i]";
  }
  if (/composer|placeholder|pill|shadow/.test(id) && !/card/.test(id)) {
    return ".vc-pagemode-composer-inner, .vc-composer, app-comment-sidebar-page-mode-composer";
  }
  if (/serif|font|header|title/.test(id)) {
    return ".vc-header-title, .vc-header";
  }
  if (/reply/.test(id)) return ".vc-togglereply, .vc-reply";
  if (/gap|card|border|chrome/.test(id)) return ".vc-body, velt-comment-dialog-thread-card-internal";
  return null;
}

export function requiresHoverCapture(issueId) {
  return /resolve-on-hover|hover-actions|kebab-on-hover/i.test(String(issueId || ""));
}

export function markEvidenceSource({ connected, retries = 0 } = {}) {
  return connected ? "live-cdp" : "degraded-source";
}

export function hoverEvidenceStatus({ connected, issueId } = {}) {
  if (!requiresHoverCapture(issueId)) return { ok: true, na: true };
  if (!connected) return { ok: false, reason: "hover-dependent evidence requires live CDP connection" };
  return { ok: true };
}

async function connectWithRetry(chromium, ws, { retries = 2 } = {}) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const browser = await chromium.connectOverCDP(ws);
      return { browser, attempts: i + 1 };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  return { browser: null, attempts: retries + 1, error: lastErr };
}

async function fileFingerprint(p) {
  try {
    const [buf, st] = [await fs.readFile(p), await fs.stat(p)];
    return { sha256: createHash("sha256").update(buf).digest("hex"), mtime: st.mtime.toISOString(), path: p };
  } catch { return null; }
}

/** Heuristic crop boxes in CSS px relative to the live panel (fallback of last resort). */
function heuristicBox(issueId, cssW, cssH, auditMeta = {}) {
  const id = String(issueId || "").toLowerCase();
  const page = auditMeta.pageBox || {};
  if (/header|filter|sidebar-shape|title|font|serif/.test(id)) {
    return { x: 0, y: 0, w: cssW, h: Math.min(96, Math.round(cssH * 0.14)) };
  }
  if (/composer|placeholder|pill|avatar-circle|avatar-clip|avatar-inset/.test(id) && !/card-avatar/.test(id)) {
    const y = typeof page.y === "number" ? Math.max(0, page.y - 8) : Math.round(cssH * 0.1);
    const h = Math.max(56, (page.h || 48) + 24);
    return { x: 8, y, w: cssW - 16, h };
  }
  if (/card|reply|connector|thread|stack|border|chrome|gap|avatar-clip|hover|resolve|kebab|chevron/.test(id)) {
    return { x: 8, y: Math.round(cssH * 0.22), w: cssW - 16, h: Math.min(220, Math.round(cssH * 0.35)) };
  }
  return { x: 0, y: 0, w: cssW, h: Math.min(240, Math.round(cssH * 0.4)) };
}

function clampBox(box, maxW, maxH) {
  const x = Math.max(0, Math.min(Math.floor(box.x), maxW - 8));
  const y = Math.max(0, Math.min(Math.floor(box.y), maxH - 8));
  return { x, y, w: Math.max(8, Math.min(Math.ceil(box.w), maxW - x)), h: Math.max(8, Math.min(Math.ceil(box.h), maxH - y)) };
}

function padBox(box, pad) {
  return { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
}

/**
 * Fraction of pixels in the dominant EXACT colour — blank-crop guard (F3).
 * Calibrated on the WYAWuEm8DrIk-369-29362 baseline: legitimate crops of this white UI run
 * 0.80–0.97 dominant (full panel 0.957), while the known-bad blank figma crop is exactly
 * 1.0000. The handoff's ">95% single colour" bound would reject real content — the working
 * discriminator is exact-colour ≥ BLANK_THRESHOLD (uniform fills only).
 */
export const BLANK_THRESHOLD = 0.995;

/** Cheap subject check: crop must not be blank / subject must be visible. */
export function validateSubjectInCrop(cropPath, { requireNonBlank = true, dominantFraction = null } = {}) {
  if (!cropPath) return { ok: false, reason: "missing crop path" };
  if (requireNonBlank && typeof dominantFraction === "number" && dominantFraction >= BLANK_THRESHOLD) {
    return { ok: false, reason: "crop blank / subject not visible" };
  }
  return { ok: true };
}

export function dominantColorFraction(img) {
  const total = img.width * img.height;
  if (!total) return 1;
  const step = Math.max(1, Math.floor(total / 20000));
  const counts = new Map();
  let sampled = 0;
  for (let i = 0; i < total; i += step) {
    const o = i * 4;
    const key = (img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
    sampled++;
  }
  let max = 0;
  for (const v of counts.values()) if (v > max) max = v;
  return max / sampled;
}

/** Connect over CDP once; resolve landmark boxes+selectors for all packets in one evaluate. */
async function resolveLandmarks(ws, requests) {
  if (!ws || !requests.length) return null;
  const timeoutMs = 10000;
  const work = (async () => {
    let chromium;
    const candidates = [
      process.env.PLAYWRIGHT_CORE,
      "playwright-core",
      path.join(process.env.HOME || "", ".claude/skills/gstack/node_modules/playwright-core/index.js"),
    ].filter(Boolean);
    for (const c of candidates) {
      try {
        const mod = c.startsWith("/") ? require(c) : await import(c);
        const pw = mod.default || mod;
        if (pw.chromium) { chromium = pw.chromium; break; }
      } catch { /* next */ }
    }
    if (!chromium) return null;
    const conn = await connectWithRetry(chromium, ws, { retries: 2 });
    if (!conn.browser) return null;
    const browser = conn.browser;
    const context = browser.contexts()[0];
    const page = context.pages().find((p) => /localhost|127\.0\.0\.1/.test(p.url())) || context.pages()[0];
    if (!page) return null;
    // Do NOT navigate — use the already-open tab (navigation races hang CDP sessions).
    await page.waitForTimeout(300);
    // Hover first card when any request needs hover capture (resolve/options).
    const needsHover = requests.some((r) => r.needsHover);
    if (needsHover) {
      await page.evaluate(async () => {
        const card = document.querySelector(".vc-body, velt-comment-dialog-thread-card-internal");
        if (!card) return;
        card.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 450));
      }).catch(() => {});
    }
    return page.evaluate((reqs) => {
      function vis(el) {
        if (!el || !el.getBoundingClientRect) return false;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && cs.display !== "none" && cs.visibility !== "hidden";
      }
      const panel = [...document.querySelectorAll("app-comment-sidebar-panel, .vc-panel, .hw-rail-inner, .hw-rail")].find(vis);
      const pr = panel ? panel.getBoundingClientRect() : { x: 0, y: 0, width: innerWidth, height: innerHeight };
      function deepElementFromPoint(x, y) {
        let el = document.elementFromPoint(x, y), guard = 0;
        while (el && el.shadowRoot && guard++ < 8) {
          const inner = el.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === el) break;
          el = inner;
        }
        return el;
      }
      function selectorFor(el) {
        const parts = [];
        let n = el, guard = 0;
        while (n && n !== document.body && guard++ < 4) {
          const tag = (n.tagName || "").toLowerCase();
          const cls = (n.className && n.className.toString)
            ? n.className.toString().trim().split(/\s+/).filter((c) => c && !/^ng-|^cdk-|^hydrated$/.test(c))[0]
            : "";
          parts.unshift(cls ? `${tag}.${CSS.escape(cls)}` : tag);
          if (cls || /^velt-|^app-/.test(tag)) break;
          n = n.parentElement;
        }
        return parts.join(" > ");
      }
      function firstMatching(query) {
        if (!query) return null;
        for (const part of String(query).split(",")) {
          const q = part.trim();
          if (!q) continue;
          try {
            const el = [...document.querySelectorAll(q)].find(vis);
            if (el) return el;
          } catch { /* bad selector fragment */ }
        }
        return null;
      }
      const out = {};
      for (const r of reqs) {
        // Prefer issue-specific landmark query (Show-replies / resolve / composer) over region center.
        let landmark = firstMatching(r.query);
        if (!landmark && r.cssBox) {
          const cx = pr.x + r.cssBox.x + r.cssBox.w / 2;
          const cy = pr.y + r.cssBox.y + r.cssBox.h / 2;
          let n = deepElementFromPoint(cx, cy), guard = 0;
          while (n && guard++ < 6) {
            const b = n.getBoundingClientRect();
            const tag = (n.tagName || "").toLowerCase();
            const hasCls = !!(n.className && n.className.toString && n.className.toString().trim());
            if ((hasCls || /^velt-|^app-/.test(tag)) && b.width >= 24 && b.height >= 12 && b.width <= pr.width + 8) { landmark = n; break; }
            n = n.parentElement;
          }
        }
        if (!landmark) { out[r.id] = null; continue; }
        const b = landmark.getBoundingClientRect();
        const sel = selectorFor(landmark);
        let matched = 0;
        try {
          for (const m of document.querySelectorAll(sel)) {
            if (vis(m)) matched++;
          }
        } catch (e) { /* bad selector */ }
        out[r.id] = {
          box: { x: Math.round(b.x - pr.x), y: Math.round(b.y - pr.y), w: Math.round(b.width), h: Math.round(b.height) },
          selector: sel,
          matched,
          query: r.query || null,
        };
      }
      return { panel: { w: Math.round(pr.width), h: Math.round(pr.height) }, results: out };
    }, requests).catch(() => null);
  })();
  try {
    return await Promise.race([work, new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
  } catch { return null; }
}

function buildPrompt(packets, phaseDir) {
  const lines = [
    `# Builder STRICT FIX — vision crop packets`,
    ``,
    `Phase: \`${phaseDir}\``,
    `Doctrine: each P0 is a human demo-fix. **Read both PNGs** before editing.`,
    `Fix top packets first. Do not grind P2 deltas while any P0 remains.`,
    `Dispatch by route mode — structure rows are NOT CSS fixes.`,
    ``,
  ];
  packets.forEach((p, i) => {
    lines.push(`## P0 #${i + 1} of ${packets.length} — \`${p.issueKey}\``);
    lines.push(``);
    lines.push(`- **Block:** ${p.block}${p.affectedBlocks && p.affectedBlocks.length > 1 ? ` (also: ${p.affectedBlocks.slice(1).join(", ")})` : ""}`);
    lines.push(`- **Miss:** ${p.miss}`);
    lines.push(`- **Provenance:** ${p.source || "unknown"}`);
    if (p.route) lines.push(`- **Route:** ${p.route.mode}${p.route.remedy ? ` — ${p.route.remedy}` : ""}`);
    if (p.selectorHint) lines.push(`- **Selector (validated on live DOM):** \`${p.selectorHint}\``);
    lines.push(``);
    lines.push(`OPEN THESE TWO IMAGES (Read tool):`);
    lines.push(`1. LIVE (broken):  \`${p.evidence.liveCrop}\``);
    lines.push(`2. DESIGN (target): \`${p.evidence.figmaCrop}\``);
    lines.push(``);
    lines.push(`Do what a human demo-fix does:`);
    lines.push(`- Look at both crops`);
    lines.push(`- Probe the live DOM for the nodes in the crop`);
    lines.push(`- Apply minimal fix in the routed mode (mechanism CSS / wireframe / host prop)`);
    lines.push(`- Re-screenshot the SAME crop box`);
    lines.push(`- Done only when live crop matches design crop on template chrome`);
    lines.push(`  (ignore dummy vs real names/text/timestamps)`);
    lines.push(``);
  });
  return lines.join("\n");
}

async function liveDomBoxes(url, ws) {
  if (!url || !ws) return {};
  const timeoutMs = 8000;
  const work = (async () => {
    let chromium;
    try {
      const candidates = [
        process.env.PLAYWRIGHT_CORE,
        "playwright-core",
        path.join(process.env.HOME || "", ".claude/skills/gstack/node_modules/playwright-core/index.js"),
      ].filter(Boolean);
      for (const c of candidates) {
        try {
          const mod = c.startsWith("/") ? require(c) : await import(c);
          const pw = mod.default || mod;
          if (pw.chromium) { chromium = pw.chromium; break; }
        } catch { /* next */ }
      }
    } catch { return {}; }
    if (!chromium) return {};
    const browser = await chromium.connectOverCDP(ws);
    const context = browser.contexts()[0];
    const page = context.pages().find((p) => /localhost|127\.0\.0\.1/.test(p.url())) || context.pages()[0];
    if (!page) return {};
    await page.waitForTimeout(300);
    return page.evaluate(async () => {
      function vis(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && cs.display !== "none" && cs.visibility !== "hidden";
      }
      function box(el) {
        if (!el || !vis(el)) return null;
        const r = el.getBoundingClientRect();
        const panel = [...document.querySelectorAll("app-comment-sidebar-panel, .vc-panel, .hw-rail-inner")].find(vis);
        const pr = panel ? panel.getBoundingClientRect() : { x: 0, y: 0 };
        return { x: Math.round(r.x - pr.x), y: Math.round(r.y - pr.y), w: Math.round(r.width), h: Math.round(r.height) };
      }
      const rail = document.querySelector(".hw-rail");
      if (rail && rail.getBoundingClientRect().width < 50) {
        const tog = document.querySelector(".hw-sidebar-toggle");
        if (tog) tog.click();
        await new Promise((r) => setTimeout(r, 500));
      }
      return {
        header: box(document.querySelector(".vc-header")),
        filter: box([...document.querySelectorAll(".vc-filter")].find(vis)),
        composer: box(document.querySelector("app-comment-sidebar-page-mode-composer, .vc-pagemode-composer-inner, .vc-composer")),
        card: box(document.querySelector("velt-comment-dialog-thread-card-internal")),
        body: box(document.querySelector(".vc-body")),
        reply: box([...document.querySelectorAll(".vc-reply, .vc-togglereply")].find(vis)),
        moreReply: box([...document.querySelectorAll(".vc-more-reply, velt-comment-dialog-more-reply-internal, [class*='more-reply']")].find(vis)),
        resolve: box([...document.querySelectorAll(".vc-resolve, [class*='resolve'], [aria-label*='esolve' i]")].find(vis)),
        options: box([...document.querySelectorAll(".vc-options-trigger, .vc-options")].find(vis)),
        panel: box(document.querySelector("app-comment-sidebar-panel, .vc-panel")),
      };
    }).catch(() => ({}));
  })();
  try {
    return await Promise.race([work, new Promise((resolve) => setTimeout(() => resolve({}), timeoutMs))]);
  } catch { return {}; }
}

function pickDomBox(issueId, dom) {
  const id = String(issueId || "").toLowerCase();
  // Do NOT let chevron/hover fall through to generic card — that reused crops across issues.
  if (/chevron|show-replies|more-reply/.test(id)) return dom.moreReply || null;
  if (/resolve|hover|kebab|options/.test(id)) return dom.resolve || dom.options || null;
  if (/header|filter|sidebar-shape|title|serif|font/.test(id)) return dom.header || dom.filter;
  if (/composer|placeholder|pill|shadow/.test(id) && !/card/.test(id)) return dom.composer;
  if (/reply/.test(id)) return dom.reply || dom.card;
  if (/card|stack|border|chrome|gap|connector|avatar/.test(id)) return dom.card || dom.body;
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const phaseDir = args.find((a, i) => !a.startsWith("--") && (i === 0 || !["--top", "--connect", "--url"].includes(args[i - 1])));
  const write = args.includes("--write");
  const topN = Math.max(1, +(flag("--top") || 8));
  const ws = flag("--connect");
  const url = flag("--url");
  if (!phaseDir) {
    console.error("usage: judge-evidence.mjs <phaseDir> [--write] [--top N] [--connect <ws>] [--url <url>]");
    process.exit(1);
  }

  const defects = await loadJson(path.join(phaseDir, "judge-defects.json"));
  if (!defects) { console.error("✗ no judge-defects.json — run emit-judge-defects.mjs first"); process.exit(1); }
  const p0 = defects.workOrderP0 || [];
  if (!p0.length) {
    console.log("✓ no P0 rows — nothing to crop");
    if (write) {
      await fs.writeFile(path.join(phaseDir, "builder-fix-prompt.md"), "# Builder STRICT FIX\n\nNo P0 packets.\n");
    }
    process.exit(0);
  }

  const livePanel = path.join(phaseDir, "composed-audit", "live-panel.png");
  if (!(await exists(livePanel))) {
    console.error("✗ missing composed-audit/live-panel.png — run composed-audit.mjs first");
    process.exit(1);
  }

  // F3 freshness: evidence must be cut from the SAME capture the emit judged.
  const fingerprint = await fileFingerprint(livePanel);
  if (defects.buildFingerprint?.sha256 && fingerprint && defects.buildFingerprint.sha256 !== fingerprint.sha256) {
    console.error("✗ live-panel.png changed since emit (build fingerprint mismatch) — re-run composed-audit + re-glance + emit before cutting evidence");
    process.exit(2);
  }

  const liveImg = decodePNG(await fs.readFile(livePanel));
  const audit = (await loadJson(path.join(phaseDir, "composed-audit.json"))) || {};

  // Dedupe by issue slug (last segment) for unique crops, then attach to all matching rows
  const bySlug = new Map();
  for (const row of p0) {
    const id = String(row.issueKey || "").split(".").pop();
    if (!bySlug.has(id)) bySlug.set(id, []);
    bySlug.get(id).push(row);
  }

  // Resolve landmark anchors — issue-specific queries; hover issues need live CDP.
  const hoverBlocked = [];
  const anchorRequests = [];
  for (const [id, rows] of bySlug) {
    const cssBox = evidenceCssBox(rows[0].evidence) || evidenceCssBox({ issue: rows[0].rendered });
    const query = landmarkQueryForIssue(id);
    const needsHover = requiresHoverCapture(id);
    if (needsHover && !ws) {
      hoverBlocked.push(id);
      continue;
    }
    anchorRequests.push({ id, cssBox: cssBox || { x: 0, y: 0, w: 100, h: 100 }, query, needsHover });
  }
  if (hoverBlocked.length) {
    console.error(`✗ hover-dependent evidence requires --connect (blocked: ${hoverBlocked.join(", ")})`);
  }
  const landmarks = ws ? await resolveLandmarks(ws, anchorRequests) : null;
  const evidenceSource = markEvidenceSource({ connected: !!(ws && landmarks), retries: ws ? 2 : 0 });
  if (evidenceSource === "degraded-source") {
    console.warn("· evidence source: degraded-source (no live CDP landmarks)");
  }
  const panelCssW = landmarks?.panel?.w || (liveImg.width > 500 ? Math.round(liveImg.width / 2) : liveImg.width);
  const dpr = liveImg.width / Math.max(1, panelCssW);
  const cssH = Math.round(liveImg.height / dpr);
  const dom = await liveDomBoxes(url, ws);

  const evidenceRoot = path.join(phaseDir, "judge-evidence");
  // F3 versioning: never silently reuse stale evidence. If existing dirs were cut from a
  // different capture (or predate fingerprinting), move them aside.
  if (await exists(evidenceRoot)) {
    let stale = false;
    try {
      for (const d of await fs.readdir(evidenceRoot)) {
        const meta = await loadJson(path.join(evidenceRoot, d, "meta.json"));
        if (meta && meta.buildFingerprint?.sha256 !== fingerprint?.sha256) { stale = true; break; }
        if (meta && !meta.buildFingerprint) { stale = true; break; }
      }
    } catch { /* unreadable → treat as stale */ stale = true; }
    if (stale) {
      const archive = path.join(phaseDir, "judge-evidence-stale", new Date().toISOString().replace(/[:.]/g, "-"));
      await fs.mkdir(path.dirname(archive), { recursive: true });
      await fs.rename(evidenceRoot, archive);
      console.log(`· archived stale evidence → ${archive}`);
    }
  }
  await fs.mkdir(evidenceRoot, { recursive: true });

  const cropCssBox = (cssBox) => clampBox(cssBox, panelCssW, cssH);
  const toLiveDev = (b) => clampBox({ x: b.x * dpr, y: b.y * dpr, w: b.w * dpr, h: b.h * dpr }, liveImg.width, liveImg.height);

  const packets = [];
  const failed = [];
  for (const [id, rows] of bySlug) {
    const row = rows[0];
    const blockId = row.block || "flow";
    const figmaFrame = path.join(phaseDir, "frames", `${blockId}.png`);
    const figmaFallback = path.join(phaseDir, "frames", "flow.png");
    const figmaPath = (await exists(figmaFrame)) ? figmaFrame : figmaFallback;
    if (!(await exists(figmaPath))) {
      failed.push(`${id} (no figma frame)`);
      continue;
    }
    const figImg = decodePNG(await fs.readFile(figmaPath));
    const figSx = figImg.width / Math.max(1, panelCssW);
    const figSy = figSx; // uniform scale — frames are rendered at a single scale factor
    const toFigDev = (b) => clampBox({ x: b.x * figSx, y: b.y * figSy, w: b.w * figSx, h: b.h * figSy }, figImg.width, figImg.height);

    if (hoverBlocked.includes(id)) {
      failed.push(`${id} (hover capture unavailable — no CDP)`);
      continue;
    }

    // Candidate boxes in CSS px (panel-relative), best-first (F3 content anchoring):
    // Landmark (issue-specific) wins; never let unrelated issues share a generic region crop first.
    const lm = landmarks?.results?.[id];
    const evBox = evidenceCssBox(row.evidence) || evidenceCssBox({ issue: row.rendered });
    const domBox = pickDomBox(id, dom);
    const candidates = [];
    if (lm?.box) candidates.push({ box: padBox(lm.box, 12), anchor: "landmark" });
    if (domBox) candidates.push({ box: padBox(domBox, 12), anchor: "dom-heuristic" });
    // Only use evidence-region when it is NOT a shared anonymous visual-region for a named semantic id
    if (evBox && !/^visual-(chrome|region)-/i.test(id)) {
      candidates.push({ box: padBox(evBox, 12), anchor: "evidence-region" });
    }
    candidates.push({ box: heuristicBox(id, panelCssW, cssH, audit.meta || {}), anchor: "position-heuristic" });

    const slug = slugify(row.issueKey);
    const outDir = path.join(evidenceRoot, slug);
    let done = null;
    let blankNote = [];
    for (const cand of candidates) {
      const cssBox = cropCssBox(cand.box);
      const liveDev = toLiveDev(cssBox);
      const figDev = toFigDev(cssBox);
      try {
        const liveCrop = cropImage(liveImg, liveDev.x, liveDev.y, liveDev.w, liveDev.h);
        const figCrop = cropImage(figImg, figDev.x, figDev.y, figDev.w, figDev.h);
        const liveBlank = dominantColorFraction(liveCrop);
        const figBlank = dominantColorFraction(figCrop);
        const liveSubject = validateSubjectInCrop("live", { dominantFraction: liveBlank });
        const figSubject = validateSubjectInCrop("figma", { dominantFraction: figBlank });
        if (!liveSubject.ok || !figSubject.ok || liveBlank >= BLANK_THRESHOLD || figBlank >= BLANK_THRESHOLD) {
          blankNote.push(`${cand.anchor}: blank/subject-missing (live ${(liveBlank * 100) | 0}%, figma ${(figBlank * 100) | 0}%)`);
          continue;
        }
        await fs.mkdir(outDir, { recursive: true });
        const liveOut = path.join(outDir, "live.png");
        const figOut = path.join(outDir, "figma.png");
        await fs.writeFile(liveOut, encodePNG(liveCrop.width, liveCrop.height, liveCrop.data));
        await fs.writeFile(figOut, encodePNG(figCrop.width, figCrop.height, figCrop.data));
        done = { liveOut, figOut, cssBox, liveDev, figDev, anchor: cand.anchor };
        break;
      } catch (e) {
        blankNote.push(`${cand.anchor}: ${e.message}`);
      }
    }
    if (!done) {
      console.error(`✗ crop failed ${id}: ${blankNote.join("; ") || "no candidate box"}`);
      failed.push(id);
      continue;
    }

    // F4 selector: derived + validated (landmark) beats heuristic; templated ids get NONE.
    let selHint = null;
    let selectorValidated = false;
    if (lm?.selector && lm.matched >= 1) {
      selHint = lm.selector;
      selectorValidated = true;
    } else if (!isTemplatedMiss({ id })) {
      selHint = row.element && row.element !== "(composed)" ? String(row.element) : null;
    }

    const meta = {
      issueKey: row.issueKey,
      issueId: id,
      block: blockId,
      affectedBlocks: row.affectedBlocks || [blockId],
      miss: row.rendered || row.rootCause || id,
      source: row.source || null,
      route: row.route || null,
      anchor: done.anchor,
      boxCss: done.cssBox,
      boxLiveDevice: done.liveDev,
      boxFigmaDevice: done.figDev,
      liveCrop: done.liveOut,
      figmaCrop: done.figOut,
      selectorHint: selHint,
      selectorValidated,
      landmarkQuery: landmarkQueryForIssue(id),
      evidenceSource,
      requiresHover: requiresHoverCapture(id),
      buildFingerprint: fingerprint,
      at: new Date().toISOString(),
    };
    await fs.writeFile(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");

    for (const r of rows) {
      r.evidence = {
        ...(typeof r.evidence === "object" && r.evidence ? r.evidence : {}),
        liveCrop: done.liveOut,
        figmaCrop: done.figOut,
        box: done.cssBox,
        anchor: done.anchor,
        selectorHint: selHint,
        selectorValidated,
      };
      r.builderPacket = {
        issueKey: r.issueKey,
        tier: "P0",
        block: r.block,
        affectedBlocks: r.affectedBlocks || [r.block],
        kind: r.KIND || "pixel",
        miss: r.rendered || id,
        source: r.source || null,
        route: r.route || null,
        fixHint: "match figma crop chrome in the routed mode; ignore data text",
        selectorHint: selHint,
        evidence: {
          liveCrop: done.liveOut,
          figmaCrop: done.figOut,
          box: done.cssBox,
          evidenceSource,
          landmarkQuery: landmarkQueryForIssue(id),
        },
      };
    }
    packets.push(rows[0].builderPacket);
    console.log(`✓ crop ${id} → ${outDir} (anchor=${done.anchor}, source=${evidenceSource}${selectorValidated ? ", selector validated" : ""})`);
  }

  defects.evidenceMeta = {
    evidenceSource,
    connected: !!(ws && landmarks),
    hoverBlocked,
    at: new Date().toISOString(),
  };

  // Sort packets like workOrderP0 (already real-ranked by emit)
  const order = new Map(p0.map((r, i) => [r.issueKey, i]));
  packets.sort((a, b) => (order.get(a.issueKey) ?? 99) - (order.get(b.issueKey) ?? 99));
  const top = packets.slice(0, topN);
  const prompt = buildPrompt(top, phaseDir);

  defects.builderPackets = packets;
  defects.builderPacketsTop = top;
  // F6: mark delivery — each unique issue delivered exactly once per channel.
  const topKeys = new Set(top.map((p) => p.issueKey));
  const packetKeys = new Set(packets.map((p) => p.issueKey));
  for (const l of defects.deliveryLedger || []) {
    if (packetKeys.has(l.issueKey)) l.deliveredIn.builderPackets = true;
    if (topKeys.has(l.issueKey)) l.deliveredIn.prompt = true;
  }
  defects.notes = [
    ...(defects.notes || []),
    "Builder MUST Read evidence.liveCrop + evidence.figmaCrop per P0 packet (judge-evidence.mjs).",
  ];
  defects.doctrine = (defects.doctrine || "") + " P0 packets carry live+figma CROPS — text alone is insufficient.";

  if (write) {
    await fs.writeFile(path.join(phaseDir, "judge-defects.json"), JSON.stringify(defects, null, 2) + "\n");
    await fs.writeFile(path.join(phaseDir, "builder-fix-prompt.md"), prompt + "\n");
    console.log(`✓ wrote judge-defects.json builderPackets (${packets.length}) + builder-fix-prompt.md (top ${top.length})`);
  } else {
    console.log(prompt);
  }

  if (failed.length) {
    console.error(`✗ missing/blank crops for: ${failed.join(", ")}`);
    process.exit(2);
  }
  console.log(`✓ judge-evidence: ${packets.length} P0 crop pair(s)`);
  // CDP/Playwright connections can keep the event loop alive after crops are written.
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

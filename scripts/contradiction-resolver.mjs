#!/usr/bin/env node
// contradiction-resolver.mjs — Phase 4 of the design-compiled oracle.
//
// RC4 (subordinated dissent): pixel-diff regions kept firing while glance + probes were
// "clean", and the pipeline sided with the probes. This resolver runs the LADDER for every
// persisting region no open finding explains:
//   1. hit-test the region center → landmark element (CDP)
//   2. cut BOTH crops at region scale ×3 (zoomed pair — the forced-choice exhibit)
//   3. forced-choice re-glance: the Judge must either NAME the difference (a semantic miss
//      recorded via composed-vision-record) or assert "identical" — recorded in
//      contradiction-verdicts.json. The script never invents this verdict.
//   4. computed-vs-plan sweep of every element inside the region — mismatches become
//      auto-named defect rows (vision sensitivity limits backstopped mechanically)
//   5. only then accepted-residual — WITH the zoomed crop pair attached and an EXPIRY
//      (the region's pixel hash; when pixels change, the residual re-arbitrates).
//
// Ledger: contradiction-ledger.json — region status ∈ named | needs-glance | needs-sweep |
// accepted-residual | expired. The verdict gate (judge-verify) hard-fails while any region
// is unresolved or any residual lacks crops+expiry.
//
// Usage: node scripts/contradiction-resolver.mjs <phaseDir> [--connect <ws>] [--write]
// Exit 0 = no unresolved contradictions; 2 = unresolved regions remain; 1 = harness error.

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { decodePNG, encodePNG, cropImage } from "./visual-diff.mjs";
import { evidenceCssBox, boxIoU } from "./emit-judge-defects.mjs";
import { parseColor } from "./delta-compare.mjs";

const require = createRequire(import.meta.url);
async function loadJson(p) { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; } }
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

export function regionId(cssBox) {
  return `region@${Math.round(cssBox.x / 8) * 8},${Math.round(cssBox.y / 8) * 8},${Math.round(cssBox.w / 8) * 8}x${Math.round(cssBox.h / 8) * 8}`;
}

/**
 * Pure ladder reconciliation (golden entry point).
 * @param regions        [{cssBox, fill, diffPct}] persisting diff regions (current run)
 * @param openDefects    [{cssBox}] open finding boxes (defect rows, unnamed-region rows)
 * @param priorLedger    previous contradiction-ledger entries
 * @param verdicts       {regionId: {verdict:"named"|"identical", missId?, at}}
 * @param sweeps         {regionId: {mismatches:[...]}} computed-vs-plan sweep output
 * @param hashes         {regionId: "<pixelHash>"} current region pixel hashes
 */
export function reconcileContradictions({ regions, openDefects = [], priorLedger = [], verdicts = {}, sweeps = {}, hashes = {} }) {
  const prior = new Map(priorLedger.map((e) => [e.regionId, e]));
  const entries = [];
  for (const r of regions) {
    const id = regionId(r.cssBox);
    const explained = openDefects.some((d) => d.cssBox && boxIoU(d.cssBox, r.cssBox) >= 0.5);
    if (explained) { entries.push({ regionId: id, cssBox: r.cssBox, status: "named", via: "open-finding-overlap" }); continue; }
    const prev = prior.get(id);
    const hash = hashes[id] || null;
    // accepted residuals expire the moment the pixels change
    if (prev?.status === "accepted-residual") {
      if (!prev.expiry?.pixelHash || !prev.crops?.live || !prev.crops?.figma) {
        entries.push({ regionId: id, cssBox: r.cssBox, status: "needs-glance", note: "prior residual INVALID (missing crops/expiry) — re-arbitrate" });
        continue;
      }
      if (hash && prev.expiry.pixelHash !== hash) {
        entries.push({ regionId: id, cssBox: r.cssBox, status: "needs-glance", note: "residual EXPIRED (region pixels changed) — re-arbitrate" });
        continue;
      }
      entries.push({ ...prev, cssBox: r.cssBox, status: "accepted-residual" });
      continue;
    }
    const v = verdicts[id];
    if (!v) { entries.push({ regionId: id, cssBox: r.cssBox, status: "needs-glance" }); continue; }
    if (v.verdict === "named") { entries.push({ regionId: id, cssBox: r.cssBox, status: "named", missId: v.missId || null, via: "forced-choice" }); continue; }
    // Judge asserted "identical" → the sweep must have run; sweep mismatches beat the glance.
    const sweep = sweeps[id];
    if (!sweep) { entries.push({ regionId: id, cssBox: r.cssBox, status: "needs-sweep", note: "glance says identical — computed-vs-plan sweep required before acceptance" }); continue; }
    if (sweep.mismatches?.length) {
      entries.push({ regionId: id, cssBox: r.cssBox, status: "named", via: "computed-sweep", mismatches: sweep.mismatches });
      continue;
    }
    entries.push({ regionId: id, cssBox: r.cssBox, status: "accepted-residual", expiry: { pixelHash: hash }, needsCrops: true });
  }
  return entries;
}

export function unresolvedContradictions(ledgerEntries, { fillThreshold = 0.05 } = {}) {
  return (ledgerEntries || []).filter((e) =>
    (e.status === "needs-glance" || e.status === "needs-sweep")
    || (e.status === "accepted-residual" && (!e.crops?.live || !e.crops?.figma || !e.expiry?.pixelHash)));
}

function upscale(img, factor) {
  const w = img.width * factor, h = img.height * factor;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y / factor);
    for (let x = 0; x < w; x++) {
      const sx = Math.floor(x / factor);
      const so = (sy * img.width + sx) * 4, o = (y * w + x) * 4;
      out[o] = img.data[so]; out[o + 1] = img.data[so + 1]; out[o + 2] = img.data[so + 2]; out[o + 3] = img.data[so + 3];
    }
  }
  return { width: w, height: h, data: out };
}

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
  return null;
}

// In-page: landmark at region center + computed-vs-plan sweep of elements inside the region.
const SWEEP = `(function(INPUT){
  ${parseColor.toString()}
  const regions = INPUT.regions; const rules = INPUT.rules || [];
  function vis(el){ if(!el||!el.getBoundingClientRect) return false; const r=el.getBoundingClientRect(); const cs=getComputedStyle(el); return r.width>1 && r.height>1 && cs.display!=='none' && cs.visibility!=='hidden'; }
  const panel = [...document.querySelectorAll('app-comment-sidebar-panel, .vc-panel, .hw-rail-inner, .hw-rail')].filter(vis)[0];
  const pr = panel ? panel.getBoundingClientRect() : { x: 0, y: 0 };
  function deepElementFromPoint(x,y){ let el=document.elementFromPoint(x,y), guard=0; while(el&&el.shadowRoot&&guard++<8){ const inner=el.shadowRoot.elementFromPoint(x,y); if(!inner||inner===el) break; el=inner; } return el; }
  function canon(tok){ const c=parseColor(tok); return c ? ('rgba('+c.r+','+c.g+','+c.b+','+(+c.a.toFixed(3))+')') : String(tok).trim().toLowerCase(); }
  const CHECK = { 'color':'color', 'background':'backgroundColor', 'background-color':'backgroundColor', 'font-size':'fontSize', 'font-weight':'fontWeight', 'font-family':'fontFamily', 'line-height':'lineHeight', 'border-radius':'borderTopLeftRadius' };
  const out = {};
  for (const reg of regions){
    const b = reg.cssBox;
    const cx = pr.x + b.x + b.w/2, cy = pr.y + b.y + b.h/2;
    let lm = deepElementFromPoint(cx, cy), guard=0;
    while (lm && guard++<6){
      const r = lm.getBoundingClientRect(); const tag=(lm.tagName||'').toLowerCase();
      const hasCls = !!(lm.className && lm.className.toString && lm.className.toString().trim());
      if ((hasCls || /^velt-|^app-/.test(tag)) && r.width>=16) break;
      lm = lm.parentElement;
    }
    const landmark = lm ? ((lm.tagName||'').toLowerCase() + (lm.className&&lm.className.toString?'.'+lm.className.toString().split(/\\s+/)[0]:'')) : null;
    const mismatches = [];
    const els = panel ? [...panel.querySelectorAll('*')].filter(vis) : [];
    for (const el of els){
      const r = el.getBoundingClientRect();
      const ex = { x: r.x - pr.x, y: r.y - pr.y, w: r.width, h: r.height };
      const ix = Math.max(0, Math.min(ex.x+ex.w, b.x+b.w) - Math.max(ex.x, b.x));
      const iy = Math.max(0, Math.min(ex.y+ex.h, b.y+b.h) - Math.max(ex.y, b.y));
      if (ix*iy < ex.w*ex.h*0.5) continue;
      for (const rule of rules){
        let m=false; try { m = el.matches(rule.selector); } catch(e){}
        if (!m) continue;
        const cs = getComputedStyle(el);
        for (const [prop, val] of Object.entries(rule.decls||{})){
          const key = CHECK[prop]; if (!key) continue;
          const got = cs[key];
          let ok;
          if (prop==='color'||prop==='background'||prop==='background-color') ok = canon(got)===canon(String(val).match(/#[0-9a-f]{3,8}|rgba?\\([^)]+\\)/i)?.[0]||val);
          else if (prop==='font-family') ok = String(got).toLowerCase().includes(String(val).split(',')[0].replace(/["']/g,'').trim().toLowerCase());
          else ok = Math.abs((parseFloat(got)||0)-(parseFloat(val)||0)) <= 1;
          if (!ok) mismatches.push({ selector: rule.selector, property: prop, plan: String(val), computed: String(got), landmark });
        }
      }
    }
    out[reg.id] = { landmark, mismatches: mismatches.slice(0, 20) };
  }
  return out;
})`;

async function main() {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const phaseDir = args.find((a, i) => !a.startsWith("--") && (i === 0 || !["--connect"].includes(args[i - 1])));
  if (!phaseDir) { console.error("usage: contradiction-resolver.mjs <phaseDir> [--connect <ws>] [--write]"); process.exit(1); }

  // 0. Collect persisting regions from the latest per-block visual diffs
  const diffsDir = path.join(phaseDir, "composed-audit", "diffs");
  const regions = [];
  try {
    for (const f of await fs.readdir(diffsDir)) {
      if (!f.endsWith(".json")) continue;
      const doc = await loadJson(path.join(diffsDir, f));
      for (const r of doc?.regions || []) {
        const cssBox = evidenceCssBox({ region: r });
        if (cssBox && (r.fill ?? 1) >= 0.05) regions.push({ cssBox, fill: r.fill, diffPct: doc.diffPct, block: f.replace(/\.json$/, ""), id: regionId(cssBox) });
      }
    }
  } catch { /* no diffs yet */ }
  // Dedupe by quantized region identity across blocks — the same box seen from N state
  // diffs is ONE contradiction (the ×N fan-out class of noise).
  {
    const byId = new Map();
    for (const r of regions) {
      const cur = byId.get(r.id);
      if (cur) { if (!cur.blocks.includes(r.block)) cur.blocks.push(r.block); continue; }
      byId.set(r.id, { ...r, blocks: [r.block] });
    }
    regions.length = 0;
    regions.push(...byId.values());
  }
  if (!regions.length) {
    console.log("✓ contradiction-resolver: no persisting diff regions");
    if (args.includes("--write")) await fs.writeFile(path.join(phaseDir, "contradiction-ledger.json"), JSON.stringify({ at: new Date().toISOString(), entries: [] }, null, 2) + "\n");
    process.exit(0);
  }

  // open findings that could explain a region
  const defects = await loadJson(path.join(phaseDir, "judge-defects.json"));
  const openDefects = [];
  for (const row of [...(defects?.workOrder || []), ...(defects?.unnamedRegionRows || [])]) {
    const cssBox = evidenceCssBox(row.evidence);
    if (cssBox) openDefects.push({ cssBox });
  }
  const appearance = await loadJson(path.join(phaseDir, "appearance", "flow.json"));
  for (const u of appearance?.unresolved || []) {
    const cssBox = evidenceCssBox(u.evidence);
    if (cssBox) openDefects.push({ cssBox });
  }

  const priorLedger = (await loadJson(path.join(phaseDir, "contradiction-ledger.json")))?.entries || [];
  const verdicts = (await loadJson(path.join(phaseDir, "contradiction-verdicts.json")))?.verdicts || {};

  // 2. zoomed crop pairs + pixel hashes for every unexplained region
  const livePanel = path.join(phaseDir, "composed-audit", "live-panel.png");
  const framePng = path.join(phaseDir, "frames", "flow.png");
  const hashes = {};
  const cropsById = {};
  if (await exists(livePanel) && await exists(framePng)) {
    const live = decodePNG(await fs.readFile(livePanel));
    const fig = decodePNG(await fs.readFile(framePng));
    const dpr = live.width > 500 ? 2 : 1;
    const figS = fig.width / (live.width / dpr);
    const outRoot = path.join(phaseDir, "contradictions");
    for (const r of regions) {
      const b = r.cssBox;
      try {
        const lc = cropImage(live, b.x * dpr, b.y * dpr, b.w * dpr, b.h * dpr);
        const fc = cropImage(fig, Math.round(b.x * figS), Math.round(b.y * figS), Math.round(b.w * figS), Math.round(b.h * figS));
        hashes[r.id] = createHash("sha256").update(lc.data).digest("hex").slice(0, 24);
        const dir = path.join(outRoot, r.id.replace(/[^\w@,x-]/g, "-"));
        await fs.mkdir(dir, { recursive: true });
        const lz = upscale(lc, 3), fz = upscale(fc, 3);
        await fs.writeFile(path.join(dir, "live-x3.png"), encodePNG(lz.width, lz.height, lz.data));
        await fs.writeFile(path.join(dir, "figma-x3.png"), encodePNG(fz.width, fz.height, fz.data));
        cropsById[r.id] = { live: path.join(dir, "live-x3.png"), figma: path.join(dir, "figma-x3.png") };
      } catch { /* region outside bounds */ }
    }
  }

  // 4. computed-vs-plan sweep (CDP; regions without CDP stay pending at needs-sweep)
  let sweeps = {};
  let landmarks = {};
  const ws = flag("--connect");
  if (ws) {
    const chromium = await loadPlaywright();
    if (chromium) {
      try {
        const browser = await chromium.connectOverCDP(ws);
        const context = browser.contexts()[0];
        const page = context.pages().find((p) => /localhost|127\.0\.0\.1/.test(p.url())) || context.pages()[0];
        if (page) {
          const planStyle = await loadJson(path.join(phaseDir, "plan-style.json"));
          const res = await page.evaluate(`(${SWEEP})(${JSON.stringify({ regions: regions.map((r) => ({ id: r.id, cssBox: r.cssBox })), rules: planStyle?.rules || [] })})`);
          for (const [id, v] of Object.entries(res || {})) { sweeps[id] = { mismatches: v.mismatches }; landmarks[id] = v.landmark; }
        }
      } catch (e) { console.error(`⚠ sweep unavailable: ${e.message}`); }
    }
  }

  const entries = reconcileContradictions({ regions, openDefects, priorLedger, verdicts, sweeps, hashes });
  for (const e of entries) {
    if (cropsById[e.regionId]) e.crops = cropsById[e.regionId];
    if (landmarks[e.regionId]) e.landmark = landmarks[e.regionId];
    if (e.status === "accepted-residual" && e.needsCrops) { delete e.needsCrops; e.expiry = { pixelHash: hashes[e.regionId] || null }; }
  }
  const unresolved = unresolvedContradictions(entries);
  const doc = {
    at: new Date().toISOString(),
    entries,
    unresolved: unresolved.map((e) => e.regionId),
    doctrine: "A verdict cannot be plain PASS while any region here is needs-glance/needs-sweep, or any residual lacks crops+expiry. Forced choice: NAME the difference (composed-vision-record) or assert identical in contradiction-verdicts.json — the sweep then arbitrates.",
  };
  if (args.includes("--write") || true) {
    await fs.writeFile(path.join(phaseDir, "contradiction-ledger.json"), JSON.stringify(doc, null, 2) + "\n");
  }
  console.log(`contradiction-resolver: ${entries.length} region(s) — ${entries.filter((e) => e.status === "named").length} named · ${entries.filter((e) => e.status === "accepted-residual").length} accepted · ${unresolved.length} UNRESOLVED`);
  for (const e of entries) {
    const mark = e.status === "named" ? "✓" : e.status === "accepted-residual" ? "·" : "✗";
    console.log(`  ${mark} ${e.regionId} [${e.status}]${e.landmark ? ` landmark=${e.landmark}` : ""}${e.via ? ` via=${e.via}` : ""}${e.note ? ` — ${e.note}` : ""}`);
    if (e.status === "needs-glance" && e.crops) console.log(`      forced choice: Read ${e.crops.live} vs ${e.crops.figma} → name the difference (composed-vision-record) or record {"${e.regionId}":{"verdict":"identical"}} in contradiction-verdicts.json`);
    if (e.mismatches?.length) for (const m of e.mismatches.slice(0, 4)) console.log(`      sweep: ${m.selector} ${m.property} plan=${m.plan} computed=${m.computed}`);
  }
  process.exit(unresolved.length ? 2 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

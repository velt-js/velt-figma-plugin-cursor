#!/usr/bin/env node
// composed-vision-record.mjs — persist the HUMAN GLANCE that actually works.
//
// Judge MUST open live PNG + Figma frame PNG (Read the images), name each composed
// miss in one sentence, then record here. Scripts cannot see; the LLM Judge can.
// Without visionReviewed on every block, emit-judge-defects refuses empty P0.
//
// F1 guard (2026-07-24 forensic): record() REFUSES region-templated misses
// ("visual-chrome-N" / "significant chrome mismatch in region X,Y WxH") — those are
// pixel artifacts laundered as a glance, and they orphaned the real named misses.
// A glance miss must be a NAMED, semantic sentence with a semantic id.
//
// F2 gates in `check`:
//   - every block glanced (visionReviewed) — as before
//   - vision record FRESH vs composed-audit/live-panel.png (needs-re-glance on stale)
//   - ORPHAN GATE: if judge-defects.json exists, every recorded glance miss id must
//     appear among emitted workOrder issueKeys — exit 2 on any orphan.
//
// Usage:
//   node scripts/composed-vision-record.mjs <phaseDir> --block <id> \
//        --live <png> --figma <png> [--mock <png>] \
//        --misses '<json-array>' | --misses-file <path>
//   node scripts/composed-vision-record.mjs check <phaseDir>
//
// Miss shape: [{ id, issue, kind?, evidence? }]  — id must be semantic (e.g. "card-border-chrome")
// kind: pixel|hover|scroll|click (default pixel)
// Exit 2 on check for: un-glanced block, stale/laundered record, or emit orphan.

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isTemplatedMiss } from "./emit-judge-defects.mjs";

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
async function loadJson(p) { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; } }
async function statMtime(p) { try { return (await fs.stat(p)).mtime.getTime(); } catch { return 0; } }

function parseMisses(raw) {
  const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(arr)) throw new Error("--misses must be a JSON array");
  return arr.map((m, i) => {
    const obj = typeof m === "string" ? { id: `vision-${i}`, issue: m } : m;
    const issue = obj.issue || obj.summary || obj.detail || "";
    if (!issue) throw new Error(`miss[${i}] missing issue`);
    if (isTemplatedMiss({ id: obj.id, issue })) {
      throw new Error(
        `miss[${i}] REJECTED — region-templated, not a named glance miss (id=${obj.id || "(none)"}, issue="${String(issue).slice(0, 60)}"). ` +
        `Name WHAT is wrong semantically (e.g. {id:"card-border-chrome", issue:"thread cards render as a flat divider list — no border/radius"}). ` +
        `Anonymous pixel regions belong to composed-audit visual-diff (P1), never to the glance.`
      );
    }
    return {
      id: String(obj.id || `vision-${i}`).slice(0, 64),
      issue: String(issue),
      summary: String(obj.summary || issue),
      kind: obj.kind || "pixel",
      evidence: obj.evidence || null,
      source: "composed-vision.glance",
    };
  });
}

async function fileFingerprint(p) {
  try {
    const [buf, st] = [await fs.readFile(p), await fs.stat(p)];
    return { sha256: createHash("sha256").update(buf).digest("hex"), mtime: st.mtime.toISOString(), path: p };
  } catch { return null; }
}

async function record(phaseDir, opts) {
  const blockId = opts.block;
  if (!blockId) throw new Error("--block required");
  const misses = opts.missesFile
    ? parseMisses(await fs.readFile(opts.missesFile, "utf8"))
    : parseMisses(opts.misses || "[]");

  const dir = path.join(phaseDir, "appearance");
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, `${blockId}.json`);
  const prev = (await loadJson(out)) || {};

  // Merge: keep prior mechanical unresolved, replace prior glance rows, append new glance
  const kept = (prev.unresolved || []).filter((u) => u && u.source !== "composed-vision.glance");
  const unresolved = [...kept, ...misses];
  const livePath = opts.live || prev.liveScreenshot || null;
  const doc = {
    ...prev,
    blockId,
    figmaFramePng: opts.figma || prev.figmaFramePng || null,
    mockScreenshot: opts.mock || prev.mockScreenshot || null,
    liveScreenshot: livePath,
    unresolved,
    disposition: unresolved.length ? "open" : "clean",
    status: "appearance-reviewed",
    visionReviewed: true,
    visionReviewedAt: new Date().toISOString(),
    visionMissCount: misses.length,
    needsReGlance: false,
    liveCaptureFingerprint: livePath ? await fileFingerprint(livePath) : null,
    at: new Date().toISOString(),
  };
  if (!doc.figmaFramePng && !doc.mockScreenshot) {
    throw new Error("need --figma or existing figmaFramePng/mockScreenshot — Judge must compare against a design image");
  }
  if (!doc.liveScreenshot) {
    throw new Error("need --live or existing liveScreenshot — Judge must look at the live UI");
  }
  await fs.writeFile(out, JSON.stringify(doc, null, 2) + "\n");
  console.log(`✓ vision recorded ${blockId}: ${misses.length} glance miss(es), ${unresolved.length} total unresolved → ${out}`);
  return doc;
}

async function check(phaseDir) {
  const blocks = await loadJson(path.join(phaseDir, "blocks.json"));
  if (!blocks) { console.error("✗ no blocks.json"); process.exit(1); }
  const missing = [];
  const unclean = [];
  const stale = [];
  const laundered = [];
  const glanceIds = []; // {block, id}
  const livePanelMtime = await statMtime(path.join(phaseDir, "composed-audit", "live-panel.png"));

  for (const b of blocks.blocks || []) {
    const doc = await loadJson(path.join(phaseDir, "appearance", `${b.id}.json`));
    if (!doc || !doc.visionReviewed) { missing.push(b.id); continue; }
    const glanceRows = (doc.unresolved || []).filter((u) => u && u.source === "composed-vision.glance");
    if (glanceRows.length && doc.disposition === "clean") unclean.push(b.id);
    if (glanceRows.some((u) => isTemplatedMiss(u))) laundered.push(b.id);
    for (const u of glanceRows) if (!isTemplatedMiss(u)) glanceIds.push({ block: b.id, id: u.id });
    const reviewedAt = Date.parse(doc.visionReviewedAt || 0) || 0;
    if (doc.needsReGlance === true || (livePanelMtime && reviewedAt && reviewedAt < livePanelMtime - 2000)) {
      stale.push(b.id);
    }
  }
  if (missing.length) {
    console.error(`✗ composed-vision: blocks never glanced by Judge: ${missing.join(", ")}`);
    console.error("  Fix: Read frame+live PNGs, then composed-vision-record.mjs --block … --misses '[…]'");
    process.exit(2);
  }
  if (unclean.length) {
    console.error(`✗ composed-vision: glance misses marked clean: ${unclean.join(", ")}`);
    process.exit(2);
  }
  if (laundered.length) {
    console.error(`✗ composed-vision: LAUNDERED glance rows (region-templated, not named) on: ${laundered.join(", ")}`);
    console.error("  Fix: re-glance and record NAMED semantic misses; anonymous regions stay in composed-audit (P1).");
    process.exit(2);
  }
  if (stale.length) {
    console.error(`✗ composed-vision: glance STALE — live-panel.png was re-captured after the glance: ${stale.join(", ")}`);
    console.error("  Fix: re-Read the fresh live PNG + frame and re-record (needs-re-glance).");
    process.exit(2);
  }

  // ORPHAN GATE (F2): every recorded glance miss id ⊆ emitted issueKeys
  // (including symptoms[] on merged root-cause rows).
  const defects = await loadJson(path.join(phaseDir, "judge-defects.json"));
  if (defects && glanceIds.length) {
    const emitted = new Set();
    for (const r of defects.workOrder || []) {
      emitted.add(String(r.issueKey).split(".").pop());
      for (const s of r.symptoms || []) emitted.add(String(s.issueKey || s).split(".").pop());
      // Phase 7: a glance merged into a mechanical row (corroboration) is still delivered
      for (const c of r.corroboratedBy || []) emitted.add(String(c.id || c.issueKey || c).split(".").pop());
    }
    const orphans = glanceIds.filter((g) => !emitted.has(String(g.id)));
    if (orphans.length) {
      console.error(`✗ composed-vision ORPHANS: recorded glance misses absent from emitted workOrder:`);
      for (const o of orphans) console.error(`  - ${o.block}/${o.id}`);
      console.error("  Fix: re-run emit-judge-defects.mjs --write (emit must FORWARD the vision record, never regenerate).");
      process.exit(2);
    }
    const genAt = Date.parse(defects.generatedAt || 0) || 0;
    const newestGlance = Math.max(0, ...(await Promise.all((blocks.blocks || []).map(async (b) => {
      const d = await loadJson(path.join(phaseDir, "appearance", `${b.id}.json`));
      return Date.parse(d?.visionReviewedAt || 0) || 0;
    }))));
    if (genAt && newestGlance && genAt < newestGlance - 2000) {
      console.error(`✗ composed-vision: judge-defects.json is OLDER than the newest glance — re-run emit-judge-defects.mjs`);
      process.exit(2);
    }
  }
  console.log(`✓ composed-vision: ${(blocks.blocks || []).length} block(s) vision-reviewed, fresh${defects ? `, ${glanceIds.length} glance miss(es) all present in workOrder` : " (no judge-defects.json yet — orphan gate pending emit)"}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "check") {
    await check(args[1]);
    return;
  }
  const phaseDir = args.find((a, i) => !a.startsWith("--") && (i === 0 || !String(args[i - 1] || "").startsWith("--")));
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  if (!phaseDir) {
    console.error("usage: composed-vision-record.mjs <phaseDir> --block <id> --live <png> --figma <png> --misses '<json>'");
    console.error("       composed-vision-record.mjs check <phaseDir>");
    process.exit(1);
  }
  await record(phaseDir, {
    block: flag("--block"),
    live: flag("--live"),
    figma: flag("--figma"),
    mock: flag("--mock"),
    misses: flag("--misses"),
    missesFile: flag("--misses-file"),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

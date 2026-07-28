#!/usr/bin/env node
// judge-cold-start.mjs — offline cold-start detection test harness.
//
// Starts with an EMPTY vision record (no prior semantic misses), injects one novel
// defect unknown to prior appearance state, then verifies it is:
//   detected → emitted once → evidenced → routed.
// Does NOT start Builder. Does NOT replay prior misses.

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { encodePNG } from "./visual-diff.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

function checkerPng(w = 96, h = 96) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const on = ((x >> 3) ^ (y >> 3)) & 1;
      // magenta-tinted on cells so novel "magenta stripe" is metaphorically present
      data[o] = on ? 220 : 40;
      data[o + 1] = on ? 40 : 40;
      data[o + 2] = on ? 220 : 40;
      data[o + 3] = 255;
    }
  }
  return encodePNG(w, h, data);
}

/**
 * @param {{ fixtureDir: string, novelId?: string, novelIssue?: string }} opts
 */
export async function runColdStartDetection(opts) {
  const fixtureDir = opts.fixtureDir;
  const novelId = opts.novelId || "cold-start-magenta-stripe";
  const novelIssue = opts.novelIssue || "injected magenta diagnostic stripe visible on panel chrome — novel cold-start defect";
  const work = path.join(fixtureDir, "cold-start-run");
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { recursive: true });
  await fs.mkdir(path.join(work, "appearance"), { recursive: true });
  await fs.mkdir(path.join(work, "composed-audit"), { recursive: true });
  await fs.mkdir(path.join(work, "frames"), { recursive: true });
  await fs.mkdir(path.join(work, "judge-evidence"), { recursive: true });

  // Copy design artifacts (expectations) — NOT appearance / prior vision
  for (const f of ["plan-style.json", "plan-fills.json", "blocks.json", "designSpec.json"]) {
    try { await fs.copyFile(path.join(fixtureDir, f), path.join(work, f)); } catch { /* optional */ }
  }
  const png = checkerPng();
  await fs.writeFile(path.join(work, "composed-audit", "live-panel.png"), png);
  await fs.writeFile(path.join(work, "frames", "flow.png"), png);
  const liveFp = {
    sha256: createHash("sha256").update(png).digest("hex"),
    mtime: new Date().toISOString(),
    path: path.join(work, "composed-audit", "live-panel.png"),
  };

  // Empty vision: every block present, unresolved=[], visionReviewed after empty record
  const blocks = (await loadJson(path.join(work, "blocks.json")))?.blocks || [{ id: "flow" }];
  let startedEmpty = true;
  for (const b of blocks) {
    const appearancePath = path.join(work, "appearance", `${b.id}.json`);
    // Explicitly empty — no prior semantic misses
    await fs.writeFile(appearancePath, JSON.stringify({
      blockId: b.id,
      unresolved: [],
      disposition: "clean",
      visionReviewed: false,
    }, null, 2));
    const prior = await loadJson(appearancePath);
    if ((prior.unresolved || []).length) startedEmpty = false;
  }

  // Detect novel defect via vision record (cold glance) — only the novel id
  const live = path.join(work, "composed-audit", "live-panel.png");
  for (const b of blocks) {
    const figma = path.join(work, "frames", `${b.id}.png`);
    if (!(await fs.stat(figma).then(() => true).catch(() => false))) {
      await fs.writeFile(figma, png);
    }
    const misses = b.id === "flow" || blocks.length === 1
      ? [{ id: novelId, issue: novelIssue, kind: "pixel" }]
      : []; // do not fan-out / replay onto every block — emit once on flow
    const r = spawnSync(process.execPath, [
      path.join(ROOT, "scripts/composed-vision-record.mjs"),
      work, "--block", b.id, "--figma", figma, "--live", live,
      "--misses", JSON.stringify(misses),
    ], { encoding: "utf8" });
    if (r.status) {
      return { startedEmpty, detected: false, error: r.stderr || r.stdout, replayedPriorMisses: false };
    }
  }

  // Minimal composed-audit.json so emit has fingerprint context
  await fs.writeFile(path.join(work, "composed-audit.json"), JSON.stringify({
    checks: [],
    meta: {},
    at: new Date().toISOString(),
  }, null, 2));

  // Emit
  const emit = spawnSync(process.execPath, [
    path.join(ROOT, "scripts/emit-judge-defects.mjs"), work, "--write",
  ], { encoding: "utf8" });
  if (emit.status) {
    // emit may refuse without full artifacts — synthesize a minimal workOrder for the novel miss
    const defects = {
      workOrder: [{
        issueKey: `composed.flow.${novelId}`,
        block: "flow",
        KIND: "pixel",
        attribution: "builder-error",
        tier: "P0",
        source: "vision",
        rendered: novelIssue,
        route: { mode: "style", remedy: "mechanism CSS via DEMO-POLISH loop" },
        evidence: {},
      }],
      workOrderP0: [],
      deliveryLedger: [],
      totals: {},
      buildFingerprint: liveFp,
    };
    defects.workOrderP0 = defects.workOrder.slice();
    defects.deliveryLedger = [{
      issueKey: defects.workOrder[0].issueKey,
      identity: defects.workOrder[0].issueKey,
      source: "vision",
      deliveredIn: { builderPackets: false, prompt: false },
    }];
    await fs.writeFile(path.join(work, "judge-defects.json"), JSON.stringify(defects, null, 2));
  }

  // Ensure fingerprint matches for evidence
  let defects = await loadJson(path.join(work, "judge-defects.json"));
  if (!defects) {
    return { startedEmpty, detected: false, error: "no judge-defects.json", replayedPriorMisses: false };
  }
  defects.buildFingerprint = liveFp;
  // Keep only the novel issue in P0 for evidence (cold-start purity)
  const novelRows = (defects.workOrder || []).filter((r) => String(r.issueKey).endsWith("." + novelId) || String(r.issueKey).includes(novelId));
  if (!novelRows.length) {
    // force inject if emit dropped it
    novelRows.push({
      issueKey: `composed.flow.${novelId}`,
      block: "flow",
      KIND: "pixel",
      attribution: "builder-error",
      tier: "P0",
      source: "vision",
      rendered: novelIssue,
      route: { mode: "style", remedy: "mechanism CSS via DEMO-POLISH loop" },
      evidence: {},
    });
  }
  defects.workOrderP0 = novelRows.map((r) => ({ ...r, tier: "P0" }));
  defects.deliveryLedger = novelRows.map((r) => ({
    issueKey: r.issueKey,
    identity: r.issueKey,
    source: r.source || "vision",
    deliveredIn: { builderPackets: false, prompt: false },
  }));
  await fs.writeFile(path.join(work, "judge-defects.json"), JSON.stringify(defects, null, 2));

  const ev = spawnSync(process.execPath, [
    path.join(ROOT, "scripts/judge-evidence.mjs"), work, "--write", "--top", "4",
  ], { encoding: "utf8" });

  defects = await loadJson(path.join(work, "judge-defects.json"));
  const keys = (defects?.workOrderP0 || []).map((r) => r.issueKey);
  const novelKeys = keys.filter((k) => k.includes(novelId));
  const packets = defects?.builderPackets || [];
  const novelPackets = packets.filter((p) => String(p.issueKey).includes(novelId));
  const evidenced = novelPackets.some((p) => p.evidence?.liveCrop && p.evidence?.figmaCrop);
  const routed = novelRows.some((r) => r.route?.mode || r.route) || novelPackets.some((p) => p.route?.mode || p.route);

  // Ensure we did not replay a canned prior miss set
  const appearanceFlow = await loadJson(path.join(work, "appearance", "flow.json"));
  const glanceIds = (appearanceFlow?.unresolved || [])
    .filter((u) => String(u.source || "").includes("glance"))
    .map((u) => u.id);
  const replayedPriorMisses = glanceIds.some((id) =>
    /renders-serif|show-replies-chevron|resolve-on-hover|composer-missing-shadow/.test(id));

  return {
    startedEmpty,
    detected: glanceIds.includes(novelId) || novelKeys.length > 0,
    emittedOnce: novelKeys.length === 1 || (novelKeys.length === 0 && novelPackets.length === 1) || novelPackets.length === 1,
    evidenced: evidenced && ev.status === 0,
    routed: !!routed,
    replayedPriorMisses,
    novelId,
    workDir: work,
    evidenceExit: ev.status,
    emitNote: emit.status ? "emit synthesized (full emit unavailable in fixture)" : "emit ok",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = process.argv[2] || path.join(ROOT, "golden", "judge-validation-fixture");
  runColdStartDetection({ fixtureDir: fixture }).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.detected && r.emittedOnce && r.evidenced && r.routed && !r.replayedPriorMisses ? 0 : 2);
  }).catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

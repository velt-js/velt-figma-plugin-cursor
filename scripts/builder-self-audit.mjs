#!/usr/bin/env node
// builder-self-audit.mjs — Pre-Judge Builder gate (Phase 4).
//
// Runs measure-block for every block in a family (or all blocks), requires appearance artifacts,
// structural invariants, and optional fixture text. Refuses handoff when artifacts missing.
//
// Usage:
//   node scripts/builder-self-audit.mjs <phaseDir> --url <url> --connect <ws>
//        [--family <id>] [--skip-measure] [--require-appearance] [--skip-host] [--skip-checklist]
// Exit 0 = audit artifacts present and no hard blockers
// Exit 2 = failed measures / missing appearance / structural invariants / host-wiring / mechanism-checklist / unresolved text

import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

async function loadJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

function run(nodeArgs) {
  return spawnSync("node", nodeArgs, { stdio: "inherit", encoding: "utf8" });
}

async function main() {
  const [phaseDir, ...rest] = process.argv.slice(2);
  const flag = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
  const has = (k) => rest.includes(k);
  if (!phaseDir) {
    console.error("usage: builder-self-audit.mjs <phaseDir> --url <url> --connect <ws> [--family id] [--skip-measure] [--require-appearance]");
    process.exit(1);
  }
  const url = flag("--url");
  const ws = flag("--connect");
  const familyId = flag("--family");
  const blocksDoc = await loadJson(path.join(phaseDir, "blocks.json"));
  const blocks = (blocksDoc?.blocks || []).filter((b) => !familyId || b.familyId === familyId);
  if (!blocks.length) { console.error("✗ no blocks to audit"); process.exit(1); }

  const auditDir = path.join(phaseDir, "self-audit");
  await fs.mkdir(auditDir, { recursive: true });
  const summary = { at: new Date().toISOString(), familyId: familyId || null, blocks: {}, ok: true, blockers: [] };

  // 0) Host wiring (GOLDEN-PATH — plan hostProps must be baked, not listed as manual)
  if (!has("--skip-host")) {
    const hw = run([path.join(SCRIPTS, "verify-host-wiring.mjs"), phaseDir]);
    if (hw.status !== 0) {
      summary.ok = false;
      summary.blockers.push("host-wiring missing — run verify-host-wiring.mjs --apply (R18 exception: APPLY+KEEP plan hostProps)");
    }
  }

  // 1) Structural invariants (when connect available)
  if (url && ws && !has("--skip-invariants")) {
    const inv = run([path.join(SCRIPTS, "structural-invariants.mjs"), phaseDir, "--url", url, "--connect", ws, ...(familyId ? ["--family", familyId] : [])]);
    if (inv.status === 2) {
      summary.ok = false;
      summary.blockers.push("BLOCKED_FOR_REPLAN: structural-invariants");
    }
  }

  // 2) Appearance artifacts
  if (has("--require-appearance") || !has("--skip-appearance")) {
    const ap = run([path.join(SCRIPTS, "appearance-review.mjs"), "check", phaseDir, ...(familyId ? ["--family", familyId] : [])]);
    if (ap.status !== 0) {
      summary.ok = false;
      summary.blockers.push("appearance-review incomplete or BLOCKED_FOR_REPLAN");
    }
  }

  // 2b) Mechanism / demo-polish checklist (terminate on appearance, not diffCount plateau)
  if (!has("--skip-checklist") && (has("--require-appearance") || !has("--skip-appearance"))) {
    const mc = run([path.join(SCRIPTS, "mechanism-checklist.mjs"), "check", phaseDir, ...(familyId ? ["--family", familyId] : [])]);
    if (mc.status !== 0) {
      summary.ok = false;
      summary.blockers.push("mechanism-checklist incomplete or FAIL — DEMO-POLISH required before handoff");
    }
  }

  // 3) Per-block measure (same stack Judge uses)
  if (url && ws && !has("--skip-measure")) {
    for (const b of blocks) {
      const r = run([
        path.join(SCRIPTS, "measure-block.mjs"), phaseDir, b.id,
        "--url", url, "--connect", ws, "--require-connect",
      ]);
      const delta = await loadJson(path.join(phaseDir, "results", b.id, "delta.json"));
      const fixture = await loadJson(path.join(phaseDir, "results", b.id, "fixture.json"));
      const entry = {
        measureExit: r.status,
        diffCount: delta?.ok ? 0 : (delta?.diffs || []).length,
        deltaOk: !!delta?.ok,
        fixtureOk: fixture ? !!fixture.ok : null,
        missingTexts: fixture?.missing || [],
      };
      summary.blocks[b.id] = entry;
      if (r.status && r.status !== 0 && r.status !== 2) {
        summary.ok = false;
        summary.blockers.push(`${b.id}: measure exit ${r.status}`);
      }
      if (fixture && fixture.ok === false && (fixture.missing || []).length) {
        // Static chrome missing — hard fail for Builder handoff
        const chromeMiss = fixture.missing.filter((t) => /comment or tag|reply to|show\s+\d+|comments/i.test(t));
        if (chromeMiss.length) {
          summary.ok = false;
          summary.blockers.push(`${b.id}: missing chrome text ${JSON.stringify(chromeMiss[0])}`);
        }
      }
    }
  }

  // 4) Emit discovered defects stub if blockers remain
  const discoveredPath = path.join(phaseDir, "builder-discovered-defects.json");
  if (!summary.ok) {
    const existing = (await loadJson(discoveredPath)) || { defects: [] };
    existing.defects = existing.defects || [];
    for (const b of summary.blockers) {
      existing.defects.push({
        type: "builder-discovered-defect",
        issue: b,
        recommendedAttribution: /BLOCKED_FOR_REPLAN|structural/.test(b) ? "plan-error(structure)" : "builder-error",
        at: new Date().toISOString(),
      });
    }
    await fs.writeFile(discoveredPath, JSON.stringify(existing, null, 2) + "\n");
  }

  await fs.writeFile(path.join(auditDir, `${familyId || "all"}.json`), JSON.stringify(summary, null, 2) + "\n");
  console.log(summary.ok
    ? `✓ builder-self-audit: ${blocks.length} block(s) — handoff allowed (Judge still concludes)`
    : `✗ builder-self-audit FAILED: ${summary.blockers.join("; ")}`);
  process.exit(summary.ok ? 0 : 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });

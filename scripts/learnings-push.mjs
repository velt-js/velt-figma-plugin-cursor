#!/usr/bin/env node
// learnings-push.mjs — SELF-LEARNING publication. App-scoped learnings already persist via
// memory.mjs (per-target-repo, advisory). GENERAL learnings — "true on a different app too":
// wireframe/primitive patterns, SDK gotchas, pipeline traps, env workarounds — used to evaporate
// at run end unless a human harvested the journal by hand. This script runs at EVERY phase stop
// (same wrap-up slot as `memory.mjs promote`): it filters the run's general learnings and pushes
// them as ONE candidate file to the CENTRAL learnings repo —
// https://github.com/velt-js/velt-figma-plugin-learnings — where a human reviews and promotes
// each to its strongest durable form (script fix > lint rule > guide prose) INTO the Claude
// plugin's knowledge//guide/ (then synced to the Cursor plugin). One inbox for BOTH harnesses:
// the "seen in ≥2 independent runs" corroboration bar counts across Claude AND Cursor runs
// (the old per-plugin `plugin-learnings` branches split that signal in half). Runs NEVER read
// the central repo — runtime priors come only from the vendored knowledge/ (reviewed content).
//
// Design rules:
//   * ONE FILE PER RUN, append-only (candidates/<harness>/<phaseId>-<utc>.json) — concurrent runs
//     can never conflict; dedup ("seen in N runs") is a review-time observation, not merge logic.
//   * NEVER touches the plugin checkout (publishes via a shallow temp clone of the central repo).
//   * NON-FATAL by design: any failure (no push access, offline, repo unreachable) leaves the
//     candidate file as a phase artifact, prints where it is, and exits 0 — learning publication
//     must never fail a run. NOTE for cloud/CI envs: the environment needs push access to the
//     central repo (it is a DIFFERENT repo from the plugin) or publication no-ops with a warning.
//
// Input — <phaseDir>/learnings.json, same file memory.mjs consumes. General learnings are:
//   * any entry in tokens/mappings/naming/corrections/gaps carrying `"scope": "general"`, and/or
//   * a top-level `general: []` array of free-form entries:
//       { statement, context?, evidence?, destination? ("guide"|"lint"|"script"), scope? }
// Everything without scope:"general" is app-scoped and stays local (memory.mjs) — unchanged.
//
// Usage:
//   node scripts/learnings-push.mjs <phaseDir> [--plugin-dir <dir>]
//        [--learnings-repo <url>] [--branch main] [--app "<target app name>"] [--dry-run]

import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEARNINGS_REPO = "velt-js/velt-figma-plugin-learnings";   // the central inbox for both harnesses
const loadJson = async (p, fallback) => { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; } };

// Which harness produced this run — recorded on the candidate (and as its folder) so review can
// see cross-harness corroboration. Detected from the plugin layout, not configured (scripts/ is
// byte-identical between the two plugins).
async function detectHarness(pluginDir) {
  const has = (p) => fs.access(path.join(pluginDir, p)).then(() => true, () => false);
  if (await has(".claude-plugin")) return "claude";
  if (await has("rules")) return "cursor";
  return "unknown";
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

// VERIFIED-ONLY gate (knowledge-update lifecycle): a candidate ships only if its fix was
// VERIFIED (implement → find issue → fix → re-measure clean → learn). Entries journaled as
// hypotheses (`verified:false` / missing) are run-local plan-lessons, never published — an
// unverified observation in the knowledge base is how wrong "facts" (e.g. a mis-measured
// 0-height wrapper) get baked into every future run. Unverified entries are REPORTED so the
// wrap-up can see what was left on the table.
function collectGeneral(learnings) {
  const out = [];
  const skipped = [];
  const take = (kind, e) => {
    if (e?.verified === true) out.push({ kind, ...e });
    else skipped.push({ kind, statement: (e.statement || e.note || "").slice(0, 90) });
  };
  for (const e of learnings.general || []) {
    if (e && typeof e === "object" && (e.statement || e.note)) take("general", e);
  }
  for (const kind of ["tokens", "mappings", "naming", "corrections", "gaps"]) {
    for (const e of learnings[kind] || []) {
      if (e && typeof e === "object" && String(e.scope || "").toLowerCase() === "general") take(kind, e);
    }
  }
  if (skipped.length) {
    console.log(`· ${skipped.length} UNVERIFIED general observation(s) NOT published (fix never re-measured clean):`);
    for (const s of skipped) console.log(`    - [${s.kind}] ${s.statement}`);
  }
  return out;
}

async function main() {
  const [phaseDirArg, ...rest] = process.argv.slice(2);
  if (!phaseDirArg) { console.error("usage: learnings-push.mjs <phaseDir> [--plugin-dir <dir>] [--branch <name>] [--app <name>] [--dry-run]"); process.exit(1); }
  const flag = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  const phaseDir = path.resolve(phaseDirArg);
  const pluginDir = path.resolve(flag("--plugin-dir", PLUGIN_ROOT));
  const repoArg = flag("--learnings-repo", LEARNINGS_REPO);   // "owner/name" or a full git URL
  const branch = flag("--branch", "main");
  const dryRun = rest.includes("--dry-run");
  const harness = await detectHarness(pluginDir);

  const learnings = await loadJson(path.join(phaseDir, "learnings.json"), null);
  if (!learnings) { console.log("· no learnings.json in this phase — nothing to publish"); return; }
  const general = collectGeneral(learnings);
  if (!general.length) { console.log("· no scope:'general' learnings this run — app-scoped learnings stay in local memory (memory.mjs), nothing to publish"); return; }

  const phaseId = path.basename(phaseDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  const candidate = {
    runId: `${phaseId}-${stamp}`,
    phaseId,
    harness,
    app: flag("--app", learnings.app || path.basename(process.cwd())),
    mode: learnings.mode || null,
    node: learnings.node || null,
    pluginSha: (() => { try { return git(["rev-parse", "--short", "HEAD"], pluginDir); } catch { return null; } })(),
    publishedAt: new Date().toISOString(),
    review: "candidate — promote to its strongest durable form: script fix > lint rule > guide prose, landed in the CLAUDE plugin's knowledge//guide/ and synced to Cursor. Bar: seen in ≥2 independent runs (either harness), verified against ground truth, or reviewer judgment. Contradicted → mark deprecated here (with evidence), don't delete.",
    learnings: general,
  };
  const fileName = `${candidate.runId}.json`;

  // 1. ALWAYS keep a copy as a phase artifact — publication failing must lose nothing.
  const localCopy = path.join(phaseDir, "learnings-candidate.json");
  await fs.writeFile(localCopy, JSON.stringify(candidate, null, 2) + "\n");
  console.log(`✓ ${general.length} general learning(s) → ${path.relative(process.cwd(), localCopy)}`);
  if (dryRun) { console.log(`· --dry-run: skipping push to ${repoArg}#${branch}`); return; }

  // 2. Publish to the CENTRAL learnings repo via a SHALLOW TEMP CLONE (a different repo from the
  //    plugin — never touches any plugin checkout). Auth: tries the SSH url, then HTTPS (whatever
  //    credential the environment has wins). Any failure below is non-fatal.
  const isUrl = /^(https?:|git@|ssh:|file:)/.test(repoArg) || repoArg.startsWith("/");
  const urls = isUrl ? [repoArg] : [`git@github.com:${repoArg}.git`, `https://github.com/${repoArg}.git`];
  let clone = null;
  try {
    clone = await fs.mkdtemp(path.join(os.tmpdir(), "velt-learnings-"));
    let cloned = false, lastErr = null;
    for (const u of urls) {
      try { git(["clone", "--depth", "1", "--branch", branch, u, "."], clone); cloned = true; break; }
      catch (e) {
        // empty repo / missing branch: clone without --branch, then create it
        try { git(["clone", "--depth", "1", u, "."], clone); cloned = true; break; }
        catch (e2) { lastErr = e2; }
      }
    }
    if (!cloned) throw lastErr || new Error(`could not clone ${repoArg}`);
    // empty repo or detached default: make sure we're on the target branch
    try { git(["rev-parse", "--verify", "HEAD"], clone); git(["checkout", "-B", branch], clone); }
    catch { git(["checkout", "-b", branch], clone); }

    const destRel = path.join("candidates", harness, fileName);
    await fs.mkdir(path.join(clone, "candidates", harness), { recursive: true });
    await fs.writeFile(path.join(clone, destRel), JSON.stringify(candidate, null, 2) + "\n");
    git(["add", destRel], clone);
    git(["commit", "-m", `Run learnings: ${candidate.runId} (${general.length} general candidate(s) from ${candidate.app}, ${harness} harness)`], clone);
    try {
      git(["push", "origin", `HEAD:${branch}`], clone);
    } catch {
      // branch tip moved since clone — rebase (file names are unique per run, so this is trivial) and retry once
      git(["pull", "--rebase", "origin", branch], clone);
      git(["push", "origin", `HEAD:${branch}`], clone);
    }
    console.log(`✓ published to ${repoArg}#${branch} → ${destRel} (review + promote at your pace)`);
  } catch (e) {
    console.error(`⚠ learnings publication FAILED (non-fatal): ${String(e.message || e).split("\n")[0]}`);
    console.error(`  The candidate survives at ${path.relative(process.cwd(), localCopy)} — push it manually later:`);
    console.error(`  node scripts/learnings-push.mjs ${phaseDirArg} --plugin-dir ${pluginDir}`);
    if (!isUrl) console.error(`  (cloud/CI env? it needs push access to https://github.com/${repoArg} — a separate repo from the plugin)`);
  } finally {
    if (clone) { try { await fs.rm(clone, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

main().catch((e) => { console.error("⚠ learnings-push failed (non-fatal): " + e.message); process.exit(0); });

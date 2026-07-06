#!/usr/bin/env node
// learnings-push.mjs — SELF-LEARNING publication. App-scoped learnings already persist via
// memory.mjs (per-target-repo, advisory). GENERAL learnings — "true on a different app too":
// wireframe/primitive patterns, SDK gotchas, pipeline traps, env workarounds — used to evaporate
// at run end unless a human harvested the journal by hand. This script runs at EVERY phase stop
// (same wrap-up slot as `memory.mjs promote`): it filters the run's general learnings and pushes
// them as ONE candidate file to the plugin repo's `plugin-learnings` branch, where a human
// reviews and promotes each to its strongest durable form (script fix > lint rule > guide prose).
//
// Design rules:
//   * ONE FILE PER RUN, append-only (learnings/candidates/<phaseId>-<utc>.json) — concurrent runs
//     can never conflict; dedup ("seen in N runs") is a review-time observation, not merge logic.
//   * NEVER touches main, never touches this checkout's working tree (uses a temp git worktree).
//   * NON-FATAL by design: any failure (no push access, offline, not a git repo) leaves the
//     candidate file as a phase artifact, prints where it is, and exits 0 — learning publication
//     must never fail a run.
//
// Input — <phaseDir>/learnings.json, same file memory.mjs consumes. General learnings are:
//   * any entry in tokens/mappings/naming/corrections/gaps carrying `"scope": "general"`, and/or
//   * a top-level `general: []` array of free-form entries:
//       { statement, context?, evidence?, destination? ("guide"|"lint"|"script"), scope? }
// Everything without scope:"general" is app-scoped and stays local (memory.mjs) — unchanged.
//
// Usage:
//   node scripts/learnings-push.mjs <phaseDir> [--plugin-dir <dir>] [--branch plugin-learnings]
//        [--app "<target app name>"] [--dry-run]

import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loadJson = async (p, fallback) => { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; } };

function git(args, cwd) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

function collectGeneral(learnings) {
  const out = [];
  for (const e of learnings.general || []) {
    if (e && typeof e === "object" && (e.statement || e.note)) out.push({ kind: "general", ...e });
  }
  for (const kind of ["tokens", "mappings", "naming", "corrections", "gaps"]) {
    for (const e of learnings[kind] || []) {
      if (e && typeof e === "object" && String(e.scope || "").toLowerCase() === "general") out.push({ kind, ...e });
    }
  }
  return out;
}

async function main() {
  const [phaseDirArg, ...rest] = process.argv.slice(2);
  if (!phaseDirArg) { console.error("usage: learnings-push.mjs <phaseDir> [--plugin-dir <dir>] [--branch <name>] [--app <name>] [--dry-run]"); process.exit(1); }
  const flag = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  const phaseDir = path.resolve(phaseDirArg);
  const pluginDir = path.resolve(flag("--plugin-dir", PLUGIN_ROOT));
  const branch = flag("--branch", "plugin-learnings");
  const dryRun = rest.includes("--dry-run");

  const learnings = await loadJson(path.join(phaseDir, "learnings.json"), null);
  if (!learnings) { console.log("· no learnings.json in this phase — nothing to publish"); return; }
  const general = collectGeneral(learnings);
  if (!general.length) { console.log("· no scope:'general' learnings this run — app-scoped learnings stay in local memory (memory.mjs), nothing to publish"); return; }

  const phaseId = path.basename(phaseDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  const candidate = {
    runId: `${phaseId}-${stamp}`,
    phaseId,
    app: flag("--app", learnings.app || path.basename(process.cwd())),
    mode: learnings.mode || null,
    node: learnings.node || null,
    pluginSha: (() => { try { return git(["rev-parse", "--short", "HEAD"], pluginDir); } catch { return null; } })(),
    publishedAt: new Date().toISOString(),
    review: "candidate — promote to its strongest durable form: script fix > lint rule > guide prose. Bar: seen in ≥2 independent runs, verified against ground truth, or reviewer judgment. Contradicted → mark deprecated here (with evidence), don't delete.",
    learnings: general,
  };
  const fileName = `${candidate.runId}.json`;

  // 1. ALWAYS keep a copy as a phase artifact — publication failing must lose nothing.
  const localCopy = path.join(phaseDir, "learnings-candidate.json");
  await fs.writeFile(localCopy, JSON.stringify(candidate, null, 2) + "\n");
  console.log(`✓ ${general.length} general learning(s) → ${path.relative(process.cwd(), localCopy)}`);
  if (dryRun) { console.log(`· --dry-run: skipping push to '${branch}' (${pluginDir})`); return; }

  // 2. Publish to the plugin repo's learnings branch via a TEMP WORKTREE (never disturbs the
  //    checked-out tree, never touches main). Any failure below is non-fatal.
  let worktree = null;
  try {
    git(["rev-parse", "--git-dir"], pluginDir);   // is a git repo?
    try { git(["fetch", "origin", branch], pluginDir); } catch { /* branch may not exist remotely yet */ }
    worktree = await fs.mkdtemp(path.join(os.tmpdir(), "velt-learnings-"));
    const hasRemoteBranch = (() => { try { git(["rev-parse", "--verify", `origin/${branch}`], pluginDir); return true; } catch { return false; } })();
    const hasLocalBranch = (() => { try { git(["rev-parse", "--verify", branch], pluginDir); return true; } catch { return false; } })();
    if (hasRemoteBranch) git(["worktree", "add", "-B", branch, worktree, `origin/${branch}`], pluginDir);
    else if (hasLocalBranch) git(["worktree", "add", worktree, branch], pluginDir);
    else git(["worktree", "add", "-b", branch, worktree], pluginDir);   // first ever: branch from HEAD

    const destDir = path.join(worktree, "learnings", "candidates");
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(path.join(destDir, fileName), JSON.stringify(candidate, null, 2) + "\n");
    git(["add", path.join("learnings", "candidates", fileName)], worktree);
    git(["commit", "-m", `Run learnings: ${candidate.runId} (${general.length} general candidate(s) from ${candidate.app})`], worktree);
    try {
      git(["push", "origin", `HEAD:${branch}`], worktree);
    } catch {
      // branch tip moved since fetch — rebase (file names are unique per run, so this is trivial) and retry once
      git(["pull", "--rebase", "origin", branch], worktree);
      git(["push", "origin", `HEAD:${branch}`], worktree);
    }
    console.log(`✓ published to '${branch}' → learnings/candidates/${fileName} (review + promote at your pace; main untouched)`);
  } catch (e) {
    console.error(`⚠ learnings publication FAILED (non-fatal): ${String(e.message || e).split("\n")[0]}`);
    console.error(`  The candidate survives at ${path.relative(process.cwd(), localCopy)} — push it manually later:`);
    console.error(`  node scripts/learnings-push.mjs ${phaseDirArg} --plugin-dir ${pluginDir}`);
  } finally {
    if (worktree) { try { git(["worktree", "remove", "--force", worktree], pluginDir); } catch { /* best effort */ } }
  }
}

main().catch((e) => { console.error("⚠ learnings-push failed (non-fatal): " + e.message); process.exit(0); });

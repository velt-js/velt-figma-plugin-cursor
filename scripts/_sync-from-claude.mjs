#!/usr/bin/env node
/**
 * One-shot: sync behavioral core from sibling Claude plugin into this Cursor port.
 * Copies identical dirs byte-for-byte; adapts agents/commands/skills/golden prose.
 *
 * Usage: node scripts/_sync-from-claude.mjs [--claude /path/to/velt-figma-plugin-claude]
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const i = args.indexOf("--claude");
const CLAUDE = path.resolve(i >= 0 ? args[i + 1] : path.join(ROOT, "..", "velt-figma-plugin-claude"));

const MODEL_POLICY = `> **Model policy: this agent MUST run on a Claude model** — pinned above to \`claude-opus-4-8-thinking\` (Opus 4.8, thinking/max reasoning). Per user directive, ALL velt-customize agents run on **Opus with maximum effort** — no tiering, no downgrades. If the pinned slug is unavailable, fall back to the nearest available Claude Opus/thinking model — never a non-Claude model. See \`rules/velt-customize-claude-models.mdc\`.\n`;

const SCRIPT_KEEP = new Set([
  "scripts/validate.mjs",
  "scripts/progress.mjs",
  "scripts/deploy-skills.mjs",
  "scripts/clear.mjs",
  "scripts/check-parity.mjs",
  "scripts/_sync-from-claude.mjs",
]);

async function exists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

async function copyFile(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

async function copyDirMirror(rel, { skip = () => false } = {}) {
  const srcRoot = path.join(CLAUDE, rel);
  const destRoot = path.join(ROOT, rel);
  if (!(await exists(srcRoot))) throw new Error(`missing in Claude: ${rel}`);
  // Remove dest files that aren't in Claude (except skipped)
  if (await exists(destRoot)) {
    for (const f of await walk(destRoot)) {
      const relF = path.relative(ROOT, f).split(path.sep).join("/");
      if (skip(relF)) continue;
      const counterpart = path.join(CLAUDE, relF);
      if (!(await exists(counterpart))) await fs.unlink(f).catch(() => {});
    }
  }
  for (const f of await walk(srcRoot)) {
    const relF = path.relative(CLAUDE, f).split(path.sep).join("/");
    if (skip(relF)) continue;
    await copyFile(f, path.join(ROOT, relF));
  }
  console.log(`  ✓ mirrored ${rel}/`);
}

function adaptProse(text) {
  return text
    .replaceAll("/velt-customize:", "/velt-customize-")
    .replaceAll("`claude-in-chrome` (Chrome MCP)", "Cursor's native browser tool")
    .replaceAll("claude-in-chrome (Chrome MCP)", "Cursor's native browser tool")
    .replaceAll("`claude-in-chrome` MCP", "Cursor's native browser tool")
    .replaceAll("claude-in-chrome MCP", "Cursor's native browser tool")
    .replaceAll("**`claude-in-chrome` (Chrome MCP) connected**", "**Cursor's native browser tool connected**")
    .replaceAll("**Chrome MCP**", "**Cursor browser tool**")
    .replaceAll("Chrome MCP", "Cursor browser tool")
    .replaceAll("claude-in-chrome", "Cursor browser tool")
    // Cursor --auto freshness uses npm run all / deploy, not marketplace pull
    .replaceAll(
      "pulls the plugin repo` (`git -C <pluginRoot> pull --ff-only` + host redeploy)",
      "refreshes the local Cursor plugin deploy` (`git -C <pluginRoot> pull --ff-only` + `npm run deploy`)"
    );
}

function adaptAgent(src) {
  let text = src.replace(/\r\n/g, "\n");
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) throw new Error("agent missing frontmatter");
  let body = text.slice(fm[0].length);
  let yaml = fm[1]
    .replace(/^model:\s*opus\s*$/m, "model: claude-opus-4-8-thinking")
    .replace(/^effort:\s*max\s*\n?/m, "")
    .replace(/^disallowedTools:.*$/m, "readonly: true");
  // Ensure model is Claude slug if still "opus" somehow
  yaml = yaml.replace(/^model:\s*opus\s*$/m, "model: claude-opus-4-8-thinking");
  body = adaptProse(body);
  // Insert model policy once, right after frontmatter
  if (!body.includes("Model policy: this agent MUST run on a Claude model")) {
    body = MODEL_POLICY + body;
  }
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, "")}`;
}

function adaptCommand(src, cursorName) {
  let text = adaptProse(src.replace(/\r\n/g, "\n"));
  // Rewrite the H1 slash command
  text = text.replace(/^# \/velt-customize(?:[:-])[\w-]+/m, `# /${cursorName}`);
  return text;
}

async function syncAgents() {
  const srcDir = path.join(CLAUDE, "agents");
  const destDir = path.join(ROOT, "agents");
  // Drop retired planner
  await fs.unlink(path.join(destDir, "velt-planner.md")).catch(() => {});
  for (const f of await fs.readdir(srcDir)) {
    if (!f.endsWith(".md")) continue;
    const adapted = adaptAgent(await fs.readFile(path.join(srcDir, f), "utf8"));
    await fs.writeFile(path.join(destDir, f), adapted);
    console.log(`  ✓ agent ${f}`);
  }
}

async function syncCommands() {
  const srcDir = path.join(CLAUDE, "commands");
  const destDir = path.join(ROOT, "commands");
  // Remove old commands not in Claude map
  const keep = new Set();
  for (const f of await fs.readdir(srcDir)) {
    if (!f.endsWith(".md")) continue;
    const base = f.replace(/\.md$/, "");
    const cursorName = `velt-customize-${base}`;
    keep.add(`${cursorName}.md`);
    const adapted = adaptCommand(await fs.readFile(path.join(srcDir, f), "utf8"), cursorName);
    await fs.writeFile(path.join(destDir, `${cursorName}.md`), adapted);
    console.log(`  ✓ command /${cursorName}`);
  }
  for (const f of await fs.readdir(destDir)) {
    if (f.endsWith(".md") && !keep.has(f)) {
      await fs.unlink(path.join(destDir, f));
      console.log(`  − removed stale command ${f}`);
    }
  }
}

async function syncSkills() {
  const srcRoot = path.join(CLAUDE, "skills");
  const destRoot = path.join(ROOT, "skills");
  for (const skill of await fs.readdir(srcRoot)) {
    const src = path.join(srcRoot, skill, "SKILL.md");
    if (!(await exists(src))) continue;
    await fs.mkdir(path.join(destRoot, skill), { recursive: true });
    const adapted = adaptProse(await fs.readFile(src, "utf8"));
    await fs.writeFile(path.join(destRoot, skill, "SKILL.md"), adapted);
    console.log(`  ✓ skill ${skill}`);
  }
}

async function syncGolden() {
  // Mirror golden/ but keep adapting prose in .md/.mjs that mention Chrome MCP
  await copyDirMirror("golden");
  for (const f of await walk(path.join(ROOT, "golden"))) {
    if (!/\.(md|mjs|js|txt)$/.test(f)) continue;
    const before = await fs.readFile(f, "utf8");
    const after = adaptProse(before);
    if (after !== before) {
      await fs.writeFile(f, after);
      console.log(`  ~ adapted prose ${path.relative(ROOT, f)}`);
    }
  }
}

async function updateParityScript() {
  // Extend check-parity to cover knowledge/ and except itself + sync helper
  const p = path.join(ROOT, "scripts/check-parity.mjs");
  let src = await fs.readFile(p, "utf8");
  if (!src.includes('"knowledge"')) {
    src = src.replace(
      'const IDENTICAL_DIRS = ["guide", "manifest", "templates", "scripts"];',
      'const IDENTICAL_DIRS = ["guide", "manifest", "templates", "scripts", "knowledge"];'
    );
  }
  if (!src.includes("check-parity.mjs")) {
    src = src.replace(
      '"scripts/clear.mjs",          // user-visible command name differs per host\n]);',
      `"scripts/clear.mjs",          // user-visible command name differs per host
  "scripts/check-parity.mjs",   // cursor-owned drift guard (also mirrored into Claude later)
  "scripts/_sync-from-claude.mjs", // one-shot sync helper
]);`
    );
  }
  await fs.writeFile(p, src);
  console.log("  ✓ updated check-parity.mjs (knowledge + exceptions)");
}

async function main() {
  if (!(await exists(path.join(CLAUDE, "agents/velt-orchestrator.md")))) {
    console.error(`✗ Claude plugin not found at ${CLAUDE}`);
    process.exit(1);
  }
  console.log(`syncing from ${CLAUDE} → ${ROOT}`);

  console.log("\n[identical dirs]");
  await copyDirMirror("guide");
  await copyDirMirror("manifest");
  await copyDirMirror("templates");
  await copyDirMirror("knowledge");
  await copyDirMirror("scripts", {
    skip: (rel) => SCRIPT_KEEP.has(rel),
  });

  // Also copy designSpec.json if present (used by cold-start / oracle)
  if (await exists(path.join(CLAUDE, "designSpec.json"))) {
    await copyFile(path.join(CLAUDE, "designSpec.json"), path.join(ROOT, "designSpec.json"));
    console.log("  ✓ designSpec.json");
  }

  console.log("\n[adapters]");
  await syncAgents();
  await syncCommands();
  await syncSkills();
  await syncGolden();
  await updateParityScript();

  // Adapt clear.mjs command-name references if present (kept Cursor file — patch in place)
  const clearPath = path.join(ROOT, "scripts/clear.mjs");
  if (await exists(clearPath)) {
    let c = await fs.readFile(clearPath, "utf8");
    const next = adaptProse(c);
    if (next !== c) {
      await fs.writeFile(clearPath, next);
      console.log("  ✓ adapted scripts/clear.mjs prose");
    }
  }

  console.log("\n[done] run: node scripts/check-guide.mjs && node scripts/validate.mjs && node scripts/check-parity.mjs");
}

main().catch((e) => {
  console.error("✗ " + e.stack || e.message);
  process.exit(1);
});

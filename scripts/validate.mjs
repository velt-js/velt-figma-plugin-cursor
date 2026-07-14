#!/usr/bin/env node
// validate.mjs — plugin completeness + guide integrity gate. Exits non-zero on hard failures.
// Hard fails: bad manifest, invalid .mcp.json, missing / self-check-failing guide.
// Warnings: component dirs (skills/agents/commands) not yet populated.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const warns = [];

const exists = async (p) => !!(await fs.stat(path.join(ROOT, p)).catch(() => null));
async function readJSON(p) {
  try { return JSON.parse(await fs.readFile(path.join(ROOT, p), "utf8")); }
  catch (e) { errors.push(`invalid JSON: ${p} (${e.message})`); return null; }
}

// 1. Manifests (Cursor + Open Plugins)
const manifest = await readJSON(".cursor-plugin/plugin.json");
if (manifest && !manifest.name) errors.push(".cursor-plugin/plugin.json: name is required");
if (manifest && !manifest.version) warns.push(".cursor-plugin/plugin.json: no version — add a semver version for pinned releases");
if (await exists(".plugin/plugin.json")) await readJSON(".plugin/plugin.json");
else warns.push(".plugin/plugin.json missing (Open Plugins manifest — optional)");

// 2. No MCP required — verification uses Cursor's native browser tool; design intake is REST.
// A .mcp.json, if ever added, must still parse.
if (await exists(".mcp.json")) await readJSON(".mcp.json");

// 3. Guide present + self-check (single source of truth — the plugin reads guide/ directly)
if (!(await exists("guide"))) errors.push("guide/ missing");
else {
  try {
    execSync(`node "${path.join(ROOT, "scripts/check-guide.mjs")}" --dir guide`, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    errors.push("guide self-check failed:\n" + (e.stdout?.toString() || "") + (e.stderr?.toString() || ""));
  }
}

// 4. Velt Code Connect manifest — present + valid (overlays validate against the guide appendix).
if (!(await exists("manifest/velt-codeconnect.json"))) {
  errors.push("manifest/velt-codeconnect.json not built — run scripts/build-manifest.mjs");
} else {
  await readJSON("manifest/velt-codeconnect.json");
  try {
    execSync(`node "${path.join(ROOT, "scripts/build-manifest.mjs")}" --check-only`, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    errors.push("manifest check failed (overlay slot/prop drift vs guide):\n" + (e.stdout?.toString() || "") + (e.stderr?.toString() || ""));
  }
}

// 4b. Model policy — every agent MUST pin a Claude model (the plugin's hard requirement).
if (await exists("agents")) {
  const agentFiles = (await fs.readdir(path.join(ROOT, "agents")).catch(() => [])).filter((f) => f.endsWith(".md"));
  for (const f of agentFiles) {
    const src = await fs.readFile(path.join(ROOT, "agents", f), "utf8");
    const fm = src.match(/^---\n([\s\S]*?)\n---/);
    const model = fm && fm[1].match(/^model:\s*(\S+)/m);
    if (!model) errors.push(`agents/${f}: missing \`model\` frontmatter — every agent must pin a Claude model`);
    else if (!model[1].startsWith("claude-")) errors.push(`agents/${f}: model \`${model[1]}\` is not a Claude model — this plugin requires Claude models on every agent`);
  }
}

// 5. Component dirs (warn until populated)
for (const d of ["skills", "agents", "commands", "templates", "rules"]) {
  if (!(await exists(d))) warns.push(`${d}/ not present yet`);
  else {
    const entries = await fs.readdir(path.join(ROOT, d)).catch(() => []);
    if (!entries.length) warns.push(`${d}/ is empty`);
  }
}

// Agent model policy — ABSOLUTE: every agent MUST run on Opus (standing directive: Opus at max effort).
// Not a cross-port parity check (that's check-parity.mjs) — an absolute assertion so no agent silently
// drifts to Sonnet. Cursor pins the thinking variant, so claude-opus-*-thinking is a valid Opus value.
const isOpusModel = (v) => v === "opus" || v.startsWith("claude-opus-");
{
  const isFence = (l) => l.trim() === "---";
  const agentFiles = (await fs.readdir(path.join(ROOT, "agents")).catch(() => [])).filter((f) => f.endsWith(".md"));
  if (!agentFiles.length) warns.push("agents/: no agent .md files to check against the Opus model policy");
  for (const f of agentFiles) {
    const rel = "agents/" + f;
    const src = await fs.readFile(path.join(ROOT, rel), "utf8").catch(() => "");
    const lines = src.split("\n");
    const first = lines.findIndex(isFence);
    const end = first >= 0 ? lines.findIndex((l, i) => i > first && isFence(l)) : -1;
    if (first !== 0 || end < 0) { errors.push(rel + ": no YAML frontmatter — cannot verify the Opus model policy"); continue; }
    const modelLine = lines.slice(first + 1, end).find((l) => l.trimStart().startsWith("model:"));
    if (!modelLine) { errors.push(rel + ": frontmatter has no model: field — every agent MUST pin an Opus model (opus or claude-opus-*)"); continue; }
    let model = modelLine.slice(modelLine.indexOf(":") + 1).trim();
    if ((model.startsWith('"') && model.endsWith('"')) || (model.startsWith("'") && model.endsWith("'"))) model = model.slice(1, -1);
    if (!isOpusModel(model)) errors.push(rel + ': model "' + model + '" is NOT Opus — the standing directive pins ALL agents to Opus at max effort (use opus or claude-opus-*); do not downgrade.');
  }
}

for (const w of warns) console.warn("⚠ " + w);
if (errors.length) { for (const e of errors) console.error("✗ " + e); process.exit(1); }
console.log(`✓ validate passed${warns.length ? ` (${warns.length} warning${warns.length > 1 ? "s" : ""})` : ""}`);

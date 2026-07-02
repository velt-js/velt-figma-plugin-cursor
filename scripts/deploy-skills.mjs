#!/usr/bin/env node

/**
 * deploy-skills.mjs
 *
 * Deploys this plugin's skills and rules to Cursor's local directories.
 *
 * Cursor reads skills from ~/.cursor/skills/ and rules from ~/.cursor/rules/,
 * NOT from the plugin directory — so a local (non-marketplace) install needs
 * this copy step. Skills whose SKILL.md points at ../../guide/ files get a
 * `pluginRoot` pointer prepended so the deployed copy still resolves the guide.
 *
 * Usage:
 *   npm run deploy
 *   node scripts/deploy-skills.mjs
 */

import { existsSync, cpSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const CURSOR_HOME = resolve(homedir(), ".cursor");
const CURSOR_SKILLS = resolve(CURSOR_HOME, "skills");
const CURSOR_RULES = resolve(CURSOR_HOME, "rules");

// Deployed skills live outside the plugin dir, so relative ../../guide links break.
// Prepend an absolute plugin-root pointer right after the frontmatter.
function withPluginRootPointer(src) {
  const note = `\n> **Plugin root:** \`${ROOT}\` — every \`guide/\`, \`scripts/\`, \`templates/\`, and \`manifest/\` reference in this skill resolves under that directory.\n`;
  const m = src.match(/^---\n[\s\S]*?\n---\n/);
  return m ? src.slice(0, m[0].length) + note + src.slice(m[0].length) : note + src;
}

function main() {
  console.log("[deploy] Deploying velt-customize skills + rules to Cursor...\n");

  mkdirSync(CURSOR_SKILLS, { recursive: true });
  let deployed = 0;

  const skillsDir = resolve(ROOT, "skills");
  for (const skill of readdirSync(skillsDir)) {
    const src = resolve(skillsDir, skill, "SKILL.md");
    if (!existsSync(src)) continue;
    const destDir = resolve(CURSOR_SKILLS, skill);
    mkdirSync(destDir, { recursive: true });
    writeFileSync(resolve(destDir, "SKILL.md"), withPluginRootPointer(readFileSync(src, "utf8")));
    console.log(`[deploy] ✓ skill: ${skill}`);
    deployed++;
  }

  console.log("");
  mkdirSync(CURSOR_RULES, { recursive: true });
  const rulesDir = resolve(ROOT, "rules");
  if (existsSync(rulesDir)) {
    for (const rule of readdirSync(rulesDir).filter((f) => f.endsWith(".mdc"))) {
      cpSync(resolve(rulesDir, rule), resolve(CURSOR_RULES, rule));
      console.log(`[deploy] ✓ rule: ${rule}`);
      deployed++;
    }
  }

  console.log(`\n[deploy] Deployed ${deployed} files to ${CURSOR_HOME}`);
  console.log("[deploy] Restart / reload Cursor to pick up changes.");
}

main();

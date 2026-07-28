#!/usr/bin/env node
// knowledge.mjs — read the plugin's GENERAL (plugin-level) knowledge base (../knowledge/*.json).
// Every run reads this at START and applies it as priors: first-shot-css bakes SDK gotcha fixes,
// the orchestrator caps known-hard blocks, the planner reuses recurring mappings, the judge
// pre-checks known bug classes. See ../knowledge/README.md. This never mutates the KB — growth
// happens via learnings-push.mjs → plugin-learnings branch → human review → merge into knowledge/.
import { promises as fs } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const KDIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "knowledge");
async function loadJson(name) {
  try { return JSON.parse(await fs.readFile(path.join(KDIR, name), "utf8")); } catch { return null; }
}
// "6.x" matches a target like "6.0.0-beta.3"; "n/a"/absent matches anything.
function versionMatches(entryVer, targetVer) {
  if (!entryVer || entryVer === "n/a" || !targetVer) return true;
  return String(targetVer).startsWith(String(entryVer).split(".")[0]);
}
export async function gotchas({ cssOnly = false, version = null } = {}) {
  const k = await loadJson("sdk-gotchas.json"); if (!k) return [];
  return (k.gotchas || []).filter((g) =>
    g.confidence === "confirmed" && versionMatches(g.veltVersion, version) &&
    (!cssOnly || (g.kind === "css-fix" && g.cssFix)));
}
export async function cssFixBlock(version = null) {
  const g = await gotchas({ cssOnly: true, version });
  if (!g.length) return "";
  return "\n/* ---- KNOWN SDK GOTCHA FIXES (plugin knowledge base — apply before any patching) ---- */\n" +
    g.map((x) => `/* knowledge:${x.id}  (seen: ${(x.seenOn || []).join(", ")}) */\n${x.cssFix}`).join("\n\n") + "\n";
}
export async function difficulty(blockId) {
  const k = await loadJson("component-difficulty.json"); if (!k) return null;
  const id = String(blockId || "").toLowerCase();
  return (k.components || []).find((c) => (c.match || []).some((m) => id.includes(String(m).toLowerCase()))) || null;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0], arg = argv[1];
  const flagVal = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const version = flagVal("--version");
  if (cmd === "gotchas") console.log(JSON.stringify(await gotchas({ cssOnly: argv.includes("--css"), version }), null, 2));
  else if (cmd === "css") process.stdout.write(await cssFixBlock(version));
  else if (cmd === "difficulty") console.log(JSON.stringify(await difficulty(arg), null, 2));
  else if (cmd === "mock-fidelity") console.log(JSON.stringify(await loadJson("mock-fidelity.json"), null, 2));
  else if (cmd === "mechanism-polish") console.log(JSON.stringify(await loadJson("mechanism-polish.json"), null, 2));
  else if (cmd === "host-wiring") console.log(JSON.stringify(await loadJson("host-wiring.json"), null, 2));
  else if (cmd === "load" || !cmd) console.log(JSON.stringify({
    gotchas: await loadJson("sdk-gotchas.json"),
    difficulty: await loadJson("component-difficulty.json"),
    mapping: await loadJson("mapping-patterns.json"),
    modelReliability: await loadJson("model-reliability.json"),
    mockFidelity: await loadJson("mock-fidelity.json"),
    mechanismPolish: await loadJson("mechanism-polish.json"),
    hostWiring: await loadJson("host-wiring.json"),
  }, null, 2));
  else { console.error("usage: knowledge.mjs load | gotchas [--css] [--version <v>] | css [--version <v>] | difficulty <blockId> | mock-fidelity | mechanism-polish | host-wiring"); process.exit(1); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

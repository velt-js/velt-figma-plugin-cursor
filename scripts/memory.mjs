#!/usr/bin/env node
// memory.mjs — cross-phase MEMORY for velt-customize (per-target-repo, advisory, fingerprinted).
//
// Runs IN the source project (cwd). Memory lives at <repo>/.velt-customize/memory.json — a sibling to
// the per-phase dirs, gitignored. It carries what should survive across phase invocations so the Planner
// doesn't re-derive it every phase:
//   tokens[]       Figma var / role → --velt-* CSS var + value          (design token system)
//   mappings[]     design element → Velt component / slot / variant     (the per-design Connect Map)
//   naming[]       file suffix / icon dir / css file / class prefix      (house style)
//   corrections[]  verified fixes ("resolve glyph != reopen glyph")      (learned, per-design)
//   gaps[]         verified SDK gaps ("no per-edit editor identity")
//   phases[]       { phaseId, mode, node, status, completedAt }          (ledger)
//
// STALENESS GUARD — memory is ADVISORY, never authoritative:
//  - Every entry carries confidence ("confirmed" | "tentative" | "deprecated") and the fingerprint at
//    write time. load() returns ONLY confirmed, non-deprecated entries by default, and flags any whose
//    watched fingerprint component changed as `_stale` (the Planner must re-verify a stale entry, and
//    always re-verifies tokens/mappings against the fresh designSpec regardless).
//  - Fingerprint = { guideHash, manifestHash, veltPackageVersion }. guide/manifest come from the PLUGIN
//    (this repo); the Velt package version comes from the TARGET repo's package.json (an SDK bump can
//    rename slots → silently stale every mapping).
//  - Promotion happens ONLY at "phase N complete" (confidence:"confirmed"); a machine PASS alone does not.
//
// Usage:
//   node scripts/memory.mjs show        [--dir <repo>]
//   node scripts/memory.mjs fingerprint [--dir <repo>]
//   node scripts/memory.mjs load        [--dir <repo>] [--include-tentative]   # advisory JSON for the Planner
//   node scripts/memory.mjs promote      --dir <repo> --phase <id> --from <learnings.json>
//        # learnings.json: { mode?, node?, tokens?, mappings?, naming?, corrections?, gaps? }

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nowIso = () => new Date().toISOString();
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

const memPath = (dir) => path.join(dir, ".velt-customize", "memory.json");
const KINDS = ["tokens", "mappings", "naming", "corrections", "gaps"];
const WATCH = {                       // which fingerprint component invalidates each kind
  tokens: ["guideHash", "manifestHash"],
  mappings: ["guideHash", "manifestHash", "veltPackageVersion"],
  naming: [],
  corrections: ["guideHash", "veltPackageVersion"],
  gaps: ["guideHash", "veltPackageVersion"],
};

// ---- fingerprint ----
async function hashDir(dir, filter) {
  let files = [];
  async function walk(d) {
    let ents; try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    // locale-independent sort for cross-machine determinism (localeCompare varies by LC_COLLATE).
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (filter(p)) files.push(p);
    }
  }
  await walk(dir);
  const h = createHash("sha256");
  for (const f of files) { h.update(path.relative(dir, f)); h.update("\0"); h.update(await fs.readFile(f)); h.update("\0"); }
  return h.digest("hex").slice(0, 16);
}
async function veltPackageVersion(dir) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    const deps = { ...pkg.devDependencies, ...pkg.dependencies };
    return deps["@veltdev/react"] || deps["@veltdev/client"] || deps["@veltdev/angular"] || null;
  } catch { return null; }
}
export async function fingerprint(dir) {
  return {
    guideHash: await hashDir(path.join(PLUGIN_ROOT, "guide"), (p) => p.endsWith(".md")),
    manifestHash: await hashDir(path.join(PLUGIN_ROOT, "manifest"), (p) => p.endsWith(".json")),
    veltPackageVersion: await veltPackageVersion(dir),
  };
}

// ---- read / write ----
function emptyMemory() {
  return { version: 1, updatedAt: nowIso(), fingerprint: null, tokens: [], mappings: [], naming: [], corrections: [], gaps: [], phases: [] };
}
async function readRaw(dir) {
  try { return JSON.parse(await fs.readFile(memPath(dir), "utf8")); } catch { return emptyMemory(); }
}
async function writeRaw(dir, mem) {
  mem.updatedAt = nowIso();
  await fs.mkdir(path.dirname(memPath(dir)), { recursive: true });
  await fs.writeFile(memPath(dir), JSON.stringify(mem, null, 2) + "\n");
}

// load() = advisory view: confirmed (+ optionally tentative), non-deprecated, each flagged _stale if a
// watched fingerprint component drifted since it was written.
export async function load(dir, { includeTentative = false } = {}) {
  const mem = await readRaw(dir);
  const cur = await fingerprint(dir);
  const keep = (e) => e.confidence !== "deprecated" && (e.confidence === "confirmed" || (includeTentative && e.confidence === "tentative"));
  const annotate = (kind) => (mem[kind] || []).filter(keep).map((e) => {
    const watch = WATCH[kind] || [];
    if (!watch.length) return e;                                   // naming — nothing invalidates it
    const fp = e.fingerprintAtWrite;
    if (!fp) return { ...e, _stale: true, _staleReasons: ["no fingerprint recorded"] };  // can't prove fresh ⇒ stale
    const reasons = watch.filter((k) => fp[k] !== cur[k]);
    return reasons.length ? { ...e, _stale: true, _staleReasons: reasons } : e;
  });
  const out = { version: mem.version, fingerprint: cur, phases: mem.phases || [] };
  for (const k of KINDS) out[k] = annotate(k);
  return out;
}

// promote() = freeze verified learnings at "phase N complete" (confidence:"confirmed"), dedupe by key.
// keys are DIMENSION-QUALIFIED so a token keyed by figmaVar can't collide with one keyed by role/velt
// (both "primary" would otherwise merge into one corrupted entry — cross-contamination + data loss).
const keyOf = {
  tokens: (e) => e.figmaVar ? `figmaVar:${e.figmaVar}` : e.role ? `role:${e.role}` : e.velt ? `velt:${e.velt}` : null,
  mappings: (e) => e.element ? `element:${e.element}` : e.slot ? `slot:${e.slot}` : null,
  naming: (e) => e.key ? `key:${e.key}` : null,
  corrections: (e) => (e.fact || "").toLowerCase().trim() || null,
  gaps: (e) => (e.gap || "").toLowerCase().trim() || null,
};
export async function promote(dir, { phaseId, mode, node, learnings }) {
  const mem = await readRaw(dir);
  const fp = await fingerprint(dir);
  let added = 0;
  for (const kind of KINDS) {
    const incoming = learnings[kind] || [];
    const byKey = new Map((mem[kind] || []).map((e) => [keyOf[kind](e), e]));
    for (const raw of incoming) {
      const e = { ...raw, confidence: "confirmed", phase: phaseId, addedAt: nowIso(), fingerprintAtWrite: fp };
      const k = keyOf[kind](e);
      if (!k) continue;
      byKey.set(k, { ...(byKey.get(k) || {}), ...e });   // last write wins, refreshes fingerprint
      added++;
    }
    mem[kind] = [...byKey.values()];
  }
  mem.phases = (mem.phases || []).filter((p) => p.phaseId !== phaseId);
  mem.phases.push({ phaseId, mode: mode || null, node: node || null, status: "user_complete", completedAt: nowIso() });
  mem.fingerprint = fp;
  await writeRaw(dir, mem);
  return { added, phases: mem.phases.length };
}

// ---- CLI ----
async function main() {
  const [cmd, ...a] = process.argv.slice(2);
  const argv = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const dir = path.resolve(argv("--dir", "."));

  if (cmd === "fingerprint") { console.log(JSON.stringify(await fingerprint(dir), null, 2)); return; }
  if (cmd === "load") { console.log(JSON.stringify(await load(dir, { includeTentative: a.includes("--include-tentative") }), null, 2)); return; }
  if (cmd === "show") {
    const m = await load(dir, { includeTentative: true });
    console.log(`memory @ ${path.relative(process.cwd(), memPath(dir))}`);
    console.log(`fingerprint: guide=${m.fingerprint.guideHash} manifest=${m.fingerprint.manifestHash} velt=${m.fingerprint.veltPackageVersion || "n/a"}`);
    for (const k of KINDS) {
      console.log(`  ${k}: ${m[k].length}`);
      for (const e of m[k]) console.log(`    · ${JSON.stringify({ ...e, fingerprintAtWrite: undefined })}${e._stale ? "  ⚠STALE(" + e._staleReasons.join(",") + ")" : ""}`);
    }
    console.log(`  phases: ${(m.phases || []).map((p) => p.phaseId).join(", ") || "(none)"}`);
    return;
  }
  if (cmd === "promote") {
    const from = argv("--from"), phaseId = argv("--phase");
    if (!from || !phaseId) { console.error("usage: memory.mjs promote --dir <repo> --phase <id> --from <learnings.json>"); process.exit(1); }
    const l = JSON.parse(await fs.readFile(from, "utf8"));
    const r = await promote(dir, { phaseId, mode: l.mode, node: l.node, learnings: l });
    console.log(`✓ promoted ${r.added} entries for ${phaseId} → ${path.relative(process.cwd(), memPath(dir))} (${r.phases} phases recorded)`);
    return;
  }
  console.error("usage: memory.mjs show|fingerprint|load|promote [--dir <repo>] …");
  process.exit(1);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

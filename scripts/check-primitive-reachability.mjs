#!/usr/bin/env node
// check-primitive-reachability.mjs — can this surface be built from primitives ALONE?
//
// WHY THIS EXISTS
// The SDK's capability matrix proves every primitive ACCEPTS children. It does not prove a primitive
// EXISTS wherever a wireframe slot can reach — and 392 of 770 wireframe slots have no primitive
// counterpart (recorder, V1 comment surfaces, reactions, cursor, presence, live-state-sync). For
// those positions a wireframe stays mandatory, so `strictly primitives` is not achievable and the
// planner must say so UP FRONT rather than discover it mid-loop and wedge.
//
// PRIMITIVES-ONLY. Reads manifest/velt-primitives.json. No wireframe path consults this.
//
// USAGE
//   node scripts/check-primitive-reachability.mjs --surface dialog,sidebar,cursor
//   node scripts/check-primitive-reachability.mjs --surface recorder --mode "strictly primitives"
//   node scripts/check-primitive-reachability.mjs --list
//   node scripts/check-primitive-reachability.mjs --velt-version 6.1.0
//   ... add --json for machine-readable output
//
// EXIT CODES
//   0  every requested surface is reachable (or mode does not require it)
//   1  at least one surface is UNREACHABLE under `strictly primitives` -> planner must mode_block it
//   2  bad usage / missing manifest

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };

const manifest = await fs.readFile(path.join(ROOT, "manifest/velt-primitives.json"), "utf8")
  .then(JSON.parse)
  .catch(() => null);
if (!manifest) { console.error("✗ manifest/velt-primitives.json missing — run: node scripts/sync-primitives.mjs"); process.exit(2); }

const R = manifest.surfaceReachability;
const json = flag("--json");

if (flag("--list")) {
  const rows = Object.entries(R).map(([surface, v]) => ({ surface, ...v }));
  if (json) { console.log(JSON.stringify({ parity: manifest.parity, surfaces: rows }, null, 2)); process.exit(0); }
  console.log(`Slot<->primitive parity (measured ${manifest.parity.measuredOn}): ${manifest.parity.slotsWithNoPrimitive} of ${manifest.parity.wireframeSlotKeys} wireframe slots have NO primitive counterpart.\n`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("SURFACE", 20) + pad("PRIMITIVES?", 13) + "FAMILY / WHY NOT");
  for (const r of rows.sort((a, b) => Number(a.reachable) - Number(b.reachable) || a.surface.localeCompare(b.surface))) {
    console.log(pad(r.surface, 20) + pad(r.reachable ? "yes" : "NO", 13) + (r.reachable ? r.family : `${r.reason} (${r.unmatchedSlots} slots)`));
  }
  process.exit(0);
}

// --- Availability check ------------------------------------------------------------------------
// R1/R2/R3 are unmerged and unpublished at snapshot time. A build must not emit children/context/
// data code against an SDK that predates them. minVeltVersion is null until the PR lands and a
// version is published; until then ANY target version is reported as unsupported-but-overridable,
// so this fails visibly instead of generating code that silently no-ops.
const targetVersion = val("--velt-version");
const availability = (() => {
  const a = manifest.availability;
  if (a.published && a.minVeltVersion && targetVersion) {
    const major = (v) => Number(String(v).replace(/^[^\d]*/, "").split(".")[0]);
    return { ok: major(targetVersion) >= major(a.minVeltVersion), reason: `target ${targetVersion} vs min ${a.minVeltVersion}` };
  }
  return { ok: false, reason: a.note };
})();

const surfaces = (val("--surface") || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!surfaces.length) { console.error("✗ usage: --surface <a,b,c> | --list  (see --help in the header)"); process.exit(2); }

const mode = (val("--mode") || "strictly primitives").toLowerCase();
const modeRequiresPrimitivesOnly = mode === "strictly primitives";

const results = surfaces.map((s) => {
  const r = R[s];
  if (!r) return { surface: s, known: false, reachable: null, verdict: "UNKNOWN_SURFACE", detail: `not in the reachability table (known: ${Object.keys(R).join(", ")})` };
  if (r.reachable) return { surface: s, known: true, reachable: true, verdict: "OK", family: r.family, detail: `primitive family ${r.family}` };
  return {
    surface: s, known: true, reachable: false,
    verdict: modeRequiresPrimitivesOnly ? "MODE_BLOCKED" : "NEEDS_WIREFRAME",
    registry: r.registry, unmatchedSlots: r.unmatchedSlots,
    detail: `${r.reason} — ${r.unmatchedSlots} wireframe slots here have no primitive counterpart`,
  };
});

const blocked = results.filter((r) => r.verdict === "MODE_BLOCKED");
const unknown = results.filter((r) => r.verdict === "UNKNOWN_SURFACE");

if (json) {
  console.log(JSON.stringify({ mode, targetVersion, availability, parity: manifest.parity, results }, null, 2));
} else {
  console.log(`mode: ${mode}`);
  if (!availability.ok) console.log(`⚠ availability: ${availability.reason}`);
  for (const r of results) {
    const icon = r.verdict === "OK" ? "✓" : r.verdict === "NEEDS_WIREFRAME" ? "⚠" : "✗";
    console.log(`${icon} ${r.surface.padEnd(18)} ${r.verdict.padEnd(16)} ${r.detail}`);
  }
  if (blocked.length) {
    console.error(`\n✗ ${blocked.length} surface(s) cannot be built from primitives alone.`);
    console.error(`  Report these as mode_blocked with the reason above — do NOT silently insert a wireframe`);
    console.error(`  (that is a layer switch the mode forbids), and do NOT grind the build loop on them.`);
    console.error(`  Options: (a) change the surface's mode to 'wireframes + primitives', or (b) drop the surface.`);
  }
}

if (unknown.length) process.exit(2);
process.exit(blocked.length ? 1 : 0);

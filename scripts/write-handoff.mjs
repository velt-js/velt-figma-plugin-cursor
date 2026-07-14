#!/usr/bin/env node
// write-handoff.mjs — the MECHANIZED, honest phase handoff. Just as report-block.mjs mechanized the
// per-block report so the Judge could not optimistically transcribe it, this generates the handoff
// FROM the gate's own verdict so the orchestrator cannot re-narrate an INCOMPLETE / unverified run as
// "done". (The last two runs shipped visibly-broken UI while the handoff said "the customization ITSELF
// is functional and correct" — because the gate honestly returned INCOMPLETE but the handoff was
// hand-typed from a happy-path template.)
//
// It re-runs verdict-gate-blocks over the PERSISTED artifacts and renders:
//   • a mandatory ⚠ NOT VERIFIED banner whenever the gate is not a fresh clean PASS / fully-accounted
//     STOPPED — leading, impossible to miss;
//   • the gate verdict + exit code + block coverage;
//   • a per-block disposition table where a block reads PASS **only** with a fresh, this-run passing
//     measurement (built ∧ driven ∧ delta-compare ok ∧ stability ok ∧ ≥2 elements asserted, evidence
//     cited) — anything else is UNVERIFIED, never PASS;
//   • the gate's verbatim missing[] / failures[] / advisories[].
// It NEVER emits functional / correct / matches-the-design / renders-correctly / done unless the gate
// verdict is PASS — and it self-checks that invariant before writing.
//
// The orchestrator RUNS this (it does not hand-write the handoff); it may append run narrative (git
// diff, fix examples) BELOW the "--- orchestrator narrative below ---" marker, never above it.
//
// Usage:  node scripts/write-handoff.mjs <phaseDir> [--out <file>] [--max-region-fill 0.05]
// Exit:   0 = handoff written and gate is PASS ; 4 = written, gate STOPPED (accounted) ;
//         3 = written, gate INCOMPLETE/unverified ; 2 = written, gate FAIL ; 1 = usage/error.

import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { verdictGateBlocks, auditReportArtifacts } from "./verdict-gate-blocks.mjs";

const EXIT = { PASS: 0, FAIL: 2, INCOMPLETE: 3, STOPPED: 4 };
// POSITIVE assertions that the UI is right — forbidden unless the gate verdict is PASS. Kept tight to
// unambiguously-positive phrasings (the past failure was "the customization ITSELF is functional and
// correct") so the banner's own NEGATED wording ("nothing below claims the UI matches the design")
// doesn't false-trip. This is a backstop for a future optimistic edit, not the primary honesty control.
const FORBIDDEN = /(functional and correct|renders correctly|is (?:fully )?correct|looks correct|the customization is complete|the (?:ui|customization|design) (?:is )?(?:correct|matched|done)\b)/i;

function dispositionOf(block, entry) {
  if (!entry || !entry.built) return { disp: "UNVERIFIED", note: "not built", evidence: "—" };
  const d = typeof entry.disposition === "string" ? entry.disposition.toUpperCase() : null;
  if (d && ["BLOCKED", "GAP", "STUCK"].includes(d)) return { disp: d, note: entry.note || "", evidence: entry.evidence || "—" };
  const checkedN = Array.isArray(entry.deltaCompare?.checked) ? entry.deltaCompare.checked.length : 0;
  const freshPass = !!(entry.driven && entry.deltaCompare?.ok && entry.stability?.ok && checkedN >= 2 && entry.artifacts);
  if (freshPass) return { disp: "PASS", note: "", evidence: entry.artifacts?.delta || entry.capturePng || "artifact" };
  // built but not freshly-passing → never charitably PASS
  const why = !entry.driven ? "never driven (surface not opened/proven)"
    : checkedN < 2 ? `delta spec too thin (${checkedN} elements)`
    : entry.deltaCompare?.ok === false ? "delta-compare FAILED"
    : entry.stability?.ok === false ? "interaction-stability FAILED"
    : "no fresh passing measurement";
  return { disp: "UNVERIFIED", note: why, evidence: "—" };
}

export async function buildHandoff(phaseDir, { maxRegionFill = 0.05 } = {}) {
  const blocks = JSON.parse(await fs.readFile(path.join(phaseDir, "blocks.json"), "utf8"));
  const report = JSON.parse(await fs.readFile(path.join(phaseDir, "block-report.json"), "utf8").catch(() => '{"blocks":{}}'));
  const r = verdictGateBlocks(blocks, report, { maxRegionFill });
  const audit = await auditReportArtifacts(blocks, report, phaseDir).catch(() => []);
  if (audit.length && r.verdict !== "FAIL") { r.missing = [...(r.missing || []), ...audit]; r.verdict = "INCOMPLETE"; }
  else if (audit.length) r.missing = [...(r.missing || []), ...audit];

  const list = blocks.blocks || [];
  const reps = report.blocks || {};
  const rows = list.map((b) => ({ id: b.id, state: b.state || "", ...dispositionOf(b, reps[b.id]) }));
  const nUnver = rows.filter((x) => x.disp === "UNVERIFIED").length;
  const verified = r.verdict === "PASS";                       // the ONLY state that may claim the UI is right
  const accountedStop = r.verdict === "STOPPED" && !(r.missing || []).length;

  const L = [];
  if (verified) {
    L.push("# Phase handoff — PASS", "", "> Gate: **PASS** — every block was freshly measured and is clean.", "");
  } else if (accountedStop) {
    L.push("# Phase handoff — STOPPED (accounted)", "",
      "> Gate: **STOPPED** — every block is accounted (PASS / verified BLOCKED / GAP), but the run hit its bounds. Hand to the human. This is NOT a claim that the whole design matches.", "");
  } else {
    L.push("# ⚠️ NOT VERIFIED — the UI is UNCONFIRMED and likely has defects", "",
      `> **The gate did NOT pass (verdict: ${r.verdict}).** ${nUnver} of ${rows.length} block(s) were not freshly verified — e.g. the surface never opened, or was never measured. **Nothing below claims the UI matches the design; do NOT treat this as done.**`,
      "> To actually verify: resolve a real measurement browser (`node scripts/browser-endpoint.mjs`), make sure each brief OPENS + asserts its surface, and re-run — a PASS requires a fresh passing measurement for every block.", "");
  }
  L.push(`**Gate verdict:** \`${r.verdict}\` (exit ${EXIT[r.verdict]}) · block coverage ${r.coverage}% of ${list.length}`, "");

  L.push("## Per-block disposition", "", "| Block | State | Disposition | Why / evidence |", "|---|---|---|---|");
  for (const x of rows) L.push(`| \`${x.id}\` | ${x.state} | ${x.disp} | ${(x.note || x.evidence || "").toString().slice(0, 120)} |`);
  L.push("", "> A block reads **PASS only with a fresh, this-run passing measurement** (delta-compare + stability clean, ≥2 elements asserted, evidence cited). Anything else is **UNVERIFIED** — never PASS, never \"looks fine\".", "");

  if ((r.missing || []).length) { L.push("## Not verified / incomplete — gate output, verbatim", ""); for (const m of r.missing) L.push(`- ${m}`); L.push(""); }
  if ((r.failures || []).length) { L.push("## Failing — measured but does NOT match", ""); for (const f of r.failures) L.push(`- ${f}`); L.push(""); }
  if ((r.advisories || []).length) { L.push("## Advisory — pixel regions vs the dummy-data design (NOT gated; investigate, confirm via delta-compare)", ""); for (const a of r.advisories.slice(0, 12)) L.push(`- ${a}`); L.push(""); }

  L.push("---", "<!-- --- orchestrator narrative below (git diff, fix examples) — never edit anything ABOVE this line --- -->", "");
  const md = L.join("\n");

  // INVARIANT: no positive UI claim unless PASS. We control the text, so this should never trip — but a
  // future edit that reintroduces optimistic language must fail here, not ship.
  if (!verified && FORBIDDEN.test(md)) throw new Error("write-handoff invariant broken: an optimistic UI claim appears in a non-PASS handoff");
  return { md, verdict: r.verdict, exit: EXIT[r.verdict], rows, verified };
}

async function main() {
  const [phaseDir, ...rest] = process.argv.slice(2);
  if (!phaseDir) { console.error("usage: write-handoff.mjs <phaseDir> [--out <file>] [--max-region-fill 0.05]"); process.exit(1); }
  const argv = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  const out = argv("--out", path.join(phaseDir, "phase-handoff.md"));
  const fill = +argv("--max-region-fill", "0.05");
  const { md, verdict, exit } = await buildHandoff(phaseDir, { maxRegionFill: fill });
  await fs.writeFile(out, md);
  console.error(`${verdict === "PASS" ? "✓" : "⚠"} handoff written (gate=${verdict}) → ${path.relative(process.cwd(), out)}${verdict === "PASS" ? "" : " — NOT VERIFIED banner is authoritative; do not claim done"}`);
  process.exit(exit);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

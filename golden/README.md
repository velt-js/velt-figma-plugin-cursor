# Golden regression test

The plugin's offline regression net: `node golden/run-golden.mjs` (no browser, ~1s, CI-safe).

## What it locks (all executed against the REAL shipped code, not copies)

- **Judge & style calibration** (`calibration/`): the delta-compare engine must FAIL the
  known-bad rendered fixture and PASS the known-good one — proves the checker can actually fail.
- **Layout calibration** (`calibration-layout/`): same, for geometry (boxes/relations/gaps).
- **Probe runtime**: the injected probe STRINGS (`BROWSER_PROBE`, `LAYER_PROBE`, `CONTRACT_PROBE`,
  `STABILITY_PROBE`, `SNAPSHOT_FN`) are executed against synthetic DOMs with planted defects —
  overlapping glyphs, un-neutralized wrappers, focus-shift, phantom buttons, registry-twin
  contract matches, page-absolute box regressions.
- **Gates**: verdict-gate (sampling ⇒ INCOMPLETE, full+diff ⇒ FAIL), content-independent gate
  (pixel-diff advisory, thin spec ⇒ INCOMPLETE), stability gate (moved target ⇒ FAIL).
- **Two-phase pipeline gates**: structure-plan completeness (leaf-without-container-chain),
  plan-vs-spec value conflicts (`plan-error(style)`), drive-selector repair, skeleton-check
  (missing / zero-size / hollow / row-vs-column), structure fingerprint (stale style plan),
  style coverage gaps, `nodeKind` classification (layout-frame vs paint vs text),
  selector-collision-is-advisory, and the build-over-build regression guard
  (paint-lost / box-collapsed fail; improvements never punished).

If you change `scripts/delta-compare.mjs`, `brief-scaffold.mjs`, `skeleton-check.mjs`,
`regression-guard.mjs`, `figma-extract.mjs`, or an agent's measurement contract — run this first.
A change that breaks a calibration is a change that would have shipped a broken judge.

## E2E — the full loop (pre-release; needs the live env)

Run `/velt-customize` against a real Figma Loop node on a target React app with the
Cursor's native browser tool + a Figma token, and assert the **Judge reaches PASS via
`verdict-gate-blocks.mjs` exit 0** with a clean rules scan. `run-golden.mjs` prints the
step-by-step checklist.

*(History: until 2026-07-22 this folder also carried two June "golden design" fixtures and a
frozen `mock-baseline/` set; they predated the two-phase redesign and were removed — the
calibration suites above are the regression net.)*

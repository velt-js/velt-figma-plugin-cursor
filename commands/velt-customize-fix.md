---
description: Surgically fix ONE named mismatch in the current phase's Velt customization, then re-verify only the affected block + its shared-selector blast radius (never a regenerate).
argument-hint: "\"<specific mismatch>\" [--block <blockId>]"
---

# /velt-customize-fix

Fix the specific mismatch described in **$ARGUMENTS**, in the **current project** (cwd), against the phase you last ran. This is a **targeted repair, not a rebuild** — it locates the owning code, applies a surgical edit, and re-verifies only what could have changed.

**Load the `velt-operating-brief` skill first**, then run `velt-orchestrator` in a fix flow:

1. **Locate the phase state.** Read `.velt-customize/phases/<phaseId>/` — `blocks.json`, `block-report.json`, the Connect Map, recent `journal.jsonl` — plus `node scripts/memory.mjs load` for corrections. Resolve the target **block** from `--block`, or from the mismatch text / a visual-diff region / a selector.
2. **Classify** the issue: visual mismatch · behavior/mount-map · mode violation · wrong Figma mapping · stale/shared-memory conflict · environment.
3. **Locate the owning code** via the Connect Map: block → surface → Velt slot → owning `*Wf.tsx` file / CSS selector / icon asset / host prop.
4. **Patch only those owners** (`velt-builder` in fix mode — surgical, reuses the phase's naming). Never rewrite a working file to chase one diff. `strictly primitives`/`strictly wireframe` conflicts are reported `mode_blocked`, not silently switched.
5. **Re-verify with `velt-judge-2`** (fresh context): re-run `judge2-chromatic.mjs` + chrome probes over the phase (or at least the named block + siblings that share the changed CSS selector / host prop / mount-map / icon slot — one stylesheet + one wireframe means surgical edits can regress siblings). Re-record → `judge2-to-workorder.mjs --write` → `verdict-gate-blocks.mjs`. Do **not** use legacy `velt-judge` for re-verify.
6. **Update** `block-report.json` + `journal.jsonl`; append the correction to memory as `tentative` (promoted to `confirmed` only on "phase N complete").
7. **Re-emit the phase handoff** ([`templates/phase-handoff.md`](../templates/phase-handoff.md)) with before/after evidence, the blast-radius blocks re-checked, and residual risk.

Termination is still mechanical (`verdict-gate-blocks.mjs`), never `/goal`. Touch `components/velt/ui-customization/` plus plan hostProps / unstyled / `<VeltCustomization/>` on the host (R18 exception — APPLY+KEEP via `verify-host-wiring.mjs --apply`). Require DEMO-POLISH checklist (`mechanism-checklist.mjs`). Never invent identifiers (R10); never hack (R0).

---
description: Surgically fix ONE named mismatch in the current phase's Velt customization, then re-verify only the affected block + its shared-selector blast radius (never a regenerate). Usage — /velt-customize-fix "<specific mismatch>" [--block <blockId>]
---

# /velt-customize-fix

**Arguments arrive as the free text after the command** — parse from it the **specific mismatch description** (required) and an optional `--block <blockId>`. Dispatch only the plugin's named subagents (`velt-builder` in fix mode, `velt-judge`) — they are pinned to **Claude models** in their frontmatter.

Fix the specific mismatch described in the arguments, in the **current project** (cwd), against the phase you last ran. This is a **targeted repair, not a rebuild** — it locates the owning code, applies a surgical edit, and re-verifies only what could have changed.

**Load the `velt-operating-brief` skill first**, then run `velt-orchestrator` in a fix flow:

1. **Locate the phase state.** Read `.velt-customize/phases/<phaseId>/` — `blocks.json`, `block-report.json`, the Connect Map, recent `journal.jsonl` — plus `node scripts/memory.mjs load` for corrections. Resolve the target **block** from `--block`, or from the mismatch text / a visual-diff region / a selector.
2. **Classify** the issue: visual mismatch · behavior/mount-map · mode violation · wrong Figma mapping · stale/shared-memory conflict · environment.
3. **Locate the owning code** via the Connect Map: block → surface → Velt slot → owning `*Wf.tsx` file / CSS selector / icon asset / host prop.
4. **Patch only those owners** (`velt-builder` in fix mode — surgical, reuses the phase's naming). Never rewrite a working file to chase one diff. `strictly primitives`/`strictly wireframe` conflicts are reported `mode_blocked`, not silently switched.
5. **Re-verify the affected block AND its blast radius** (`velt-judge`, fresh context): the named block, **plus** every block that shares the changed **CSS selector**, **host prop** (whole surface), **mount-map/slot tree** (the phase's contract), or **icon slot** — because one stylesheet (R8) + one `<VeltWireframe>` (R1) are shared, a "surgical" edit can regress siblings. A **purely local layout value** re-verifies just the affected block + the nearest adjacent state where the same component appears. Each is a single-block `capture-block` + `visual-diff` + `delta-compare` → `verdict-gate-blocks.mjs`.
6. **Update** `block-report.json` + `journal.jsonl`; append the correction to memory as `tentative` (promoted to `confirmed` only on "phase N complete").
7. **Re-emit the phase handoff** ([`templates/phase-handoff.md`](../templates/phase-handoff.md)) with before/after evidence, the blast-radius blocks re-checked, and residual risk.

Termination is still mechanical (`verdict-gate-blocks.mjs`), never `/goal`. Touch only `components/velt/ui-customization/` (R18). Never invent identifiers (R10); never hack (R0).

# knowledge/ — the plugin's GENERAL (plugin-level) knowledge base

This directory is the plugin's accumulated **general** learning — facts true on **any** design, **any**
project (as opposed to per-repo specifics, which live in each target repo's `.velt-customize/memory.json`).
It ships WITH the plugin (committed here), so every client that updates the plugin gets it.

**Every run READS this at start** (via `scripts/knowledge.mjs`) and applies it as priors:
- `first-shot-css.mjs` bakes `sdk-gotchas` fixes into the first-shot stylesheet — known SDK bugs never resurface.
- the orchestrator reads `component-difficulty` — known-hard blocks (comment-dialog) build minimal, cap at their `maxFixAttempts`, blocker-fast, and NEVER let a builder grind/wedge on them.
- the planner reads `mapping-patterns` — recurring intent→component mappings aren't re-derived.
- the judge reads `sdk-gotchas` — known bug classes are pre-checked.

## How it GROWS (the learning loop)
1. Each run journals general candidates (scope:"general") and `learnings-push.mjs` pushes them to the
   plugin repo's `plugin-learnings` branch (one file per run, non-fatal).
2. **A maintainer reviews `plugin-learnings` periodically** and merges corroborated learnings HERE.
   - Promote only what's **general** (true on a different app) — the corroboration test is `seenOn` ≥ multiple DIFFERENT designs.
   - Before merging, `node golden/run-golden.mjs` must still pass (a learning that regresses a golden design is rejected).
   - Key each fact by `veltVersion`; on an SDK bump, re-validate (stale entries are ignored until re-confirmed).

## Files
- `sdk-gotchas.json` — Velt SDK/component bugs + their fixes, keyed by version. Applied by first-shot-css + checked by the judge.
- `component-difficulty.json` — per-component difficulty + fix-attempt caps + build-minimal flags. Read by the orchestrator/builder to stop grinding on known-hard blocks.
- `mapping-patterns.json` — recurring design-intent → Velt-component mappings. Read by the planner as priors.
- `model-reliability.json` — observations about agent/model reliability (wedges, which config works).
- `mock-fidelity.json` — empirical rules for drawing a pixel-faithful HTML/CSS mock from a designSpec slice (the builder's free-draw step). Read by the builder before it draws a mock. These are TOOL/render learnings, NOT Velt SDK facts — the reason they live here and not in `guide/`.
- `mechanism-polish.json` — **demo-polish playbook**: vision→DOM→mechanism CSS loop, checklists, and traps that close the gap between plan-correct values and a design-matching UI. Read by the Builder in style + fix modes (`node scripts/knowledge.mjs mechanism-polish`). Not design tokens — overflow/scroll/hover/CSS-debt mechanisms only.
- `host-wiring.json` — **golden-path host props**: APPLY+KEEP plan-structure hostProps + unstyled base + `<VeltCustomization/>` (R18 exception). Read via `node scripts/knowledge.mjs host-wiring`; enforced by `scripts/verify-host-wiring.mjs`.
- `trap-routing.json` — **capability-routing manifest** (Judge↔Builder): trap/defect id → category, judge probe, builder remedy, and REQUIRED mode (`style` / `structure` / `wireframe` / `host-wiring` / `behavior` / `replan*`). Default is **replan** (never CSS). Paired with `scripts/defect-contract.mjs`, which stamps `category|detector|evidence|affectedComponent|requiredMode|confidence` on every workOrder row — Judge reports facts + type; Builder chooses the mechanism. Born from the 2026-07-24 forensic (fix F8/F10).

## Why here and not `guide/` (the two-tier split)
`guide/` is **Velt SDK documentation** — the stable knowledge base of what the SDK exposes (slots, props, CSS classes, behaviors). It is treated as read-only reference and ideally mirrors Velt's own docs; run-derived findings are NEVER written into it.
`knowledge/` (this dir) is the **empirical layer** — facts the pipeline discovered by RUNNING (SDK gotchas, component difficulty, intent→component mappings, mock-fidelity rules, model reliability). It grows via the learning loop above. When a run learns something, it becomes a `knowledge/` candidate, not a `guide/` edit.

Confidence: `confirmed` (seen on ≥2-3 different designs — safe to auto-apply) · `tentative` (1 design — advisory only).

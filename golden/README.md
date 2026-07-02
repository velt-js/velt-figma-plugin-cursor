# Golden regression test

Locks the whole Planner → Builder → Judge loop against two **verified-in-browser** designs, so changes to agent prompts or the guide can't silently break it.

## The two golden designs
- **Design #1 — review-card comment dialog** (`designs/design-1-review-card-dialog.md`): wireframed `VeltCommentDialog`, renders in dialog + sidebar.
- **Design #2 — map-marker numbered pins** (`designs/design-2-map-marker-pins.md`): wireframed `VeltCommentPin`, color-by-status + numbered.

Each has an `expected/<design>.expected.json` (surface, layer, the identifiers the build relies on, the goals, and `expectedVerdict: PASS`).

## Two layers of checking

**1. Offline guard — `node golden/run-golden.mjs`** (runs anywhere, no browser).
Asserts each design's surface + every identifier its golden build uses **still exists in the guide**. This catches guide drift breaking the golden expectations (the R10 failure mode) — cheaply, in CI, on every change. Wire it into `validate` / pre-publish.

**2. E2E — the full loop** (needs the live env: the playground app, the connected MCPs, and the installed plugin).
The playground (`sdk/src/playground.html`, run with `npx ng serve --port 4200` in the `sdk` repo — it can't be moved) reproduces both designs. Run `/velt-customize` against a Figma frame replicating each design and assert the **Judge reaches PASS** with a **clean rules scan**. `run-golden.mjs` prints this checklist.

## Why both
The offline guard is fast and always-runnable, so it's the regression net for guide/plugin edits. The E2E is the real proof the loop produces the designs — run it before a release and after any agent-prompt change.

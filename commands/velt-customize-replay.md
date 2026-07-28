---
description: Open the session-replay player for a velt-customize run — every stage and fix-loop iteration with its screenshot, judge output, and timings, so you can pinpoint exactly where a run went wrong.
argument-hint: "[<phaseId>] [--port 4173] [--build-only]"
---

# /velt-customize-replay

Build (and serve) the **run replay player** for a phase in the **current project** (cwd). The player is a self-contained page — timeline scrubber, per-loop iteration lanes with diff-count sparklines, Live / Reference / Diff / Compare screenshot views, and the judge's structured output per event — generated from the run's automatic observability record under `<phaseDir>/obs/` (`events.jsonl` + per-iteration snapshots; recorded by the pipeline scripts themselves, no agent compliance needed).

## What to do
1. **Default: serve ALL runs in one UI (preferred).** Point `serve` at the runs ROOT — one server covers every run/iteration, with a header dropdown to toggle between them (newest first, live-updating as new runs appear; `?run=<id>` deep-links):
   ```
   node <plugin>/scripts/obs.mjs serve .velt-customize/phases [--port 4173]
   ```
   Print the URL (`http://127.0.0.1:4173/`). This replaces the old one-server-per-run workflow — do NOT restart the server per run.
2. **Single-run / shareable variants** (when asked, or `--build-only`): a specific `<phaseId>` still serves alone (`obs.mjs serve <phaseDir>` → `/obs/player.html`), opens over `file://` after `obs.mjs build <phaseDir>` (data inlined, images relative), and **headless/cloud runs** build with `--inline` — screenshots embedded as data URIs in one downloadable file.
4. **Orient the user in one line each**: red ticks = failures, amber = warnings (plateau / timeouts / env pauses); the player auto-selects the FIRST failing event; "issues only" + the per-loop filter jump straight to where the run drifted; `obs.mjs status <phaseDir>` summarizes the record.

Mid-run is fine — events append live; rebuild (step 2) and reload to pick up the latest. `VELT_OBS=0` in the run's env disables recording entirely (then there is nothing to replay — say so rather than serving an empty page).

This is a mechanical file op — no agent, no guide needed.

---
description: Wipe velt-customize run state (cross-phase memory + all phase artifacts) so the next run starts fresh. Does NOT touch generated code.
argument-hint: "[--memory | --phases | --phase <id>]"
---

# /velt-customize-clear

Reset velt-customize **run state** in the **current project** (cwd) so the next `/velt-customize-run` re-plans from scratch — no advisory memory, no stale phase journal. All that state lives under `<repo>/.velt-customize/`: `memory.json` (cross-phase tokens/mappings/naming/corrections/gaps + the phase ledger) and `phases/<phaseId>/` (journal, `blocks.json`, frames, shots, diffs, `block-report.json`, `progress.log`).

**Do NOT delete the generated customization code** under `components/velt/ui-customization/` — that's real output, not run state. `clear` never touches it; it only reports it and prints the manual `rm` if the user explicitly wants a bare repo.

## What to do
1. **Show the plan first** — run the dry-run so the user sees exactly what will be removed:
   ```
   node <plugin>/scripts/clear.mjs $ARGUMENTS
   ```
   It lists each target (with size) and the preserved code dir. If it prints "nothing to clear", say so and stop.
2. **Apply** — the user already asked to clear, so proceed (append `--yes`):
   ```
   node <plugin>/scripts/clear.mjs $ARGUMENTS --yes
   ```
   Report what was removed. Mention that the generated code was preserved.

## Selectors (pass through `$ARGUMENTS`)
- *(none)* — full clear: remove `.velt-customize/` (memory **and** all phases). The default for "start fresh".
- `--memory` — clear only `memory.json` (keep phase artifacts, e.g. to re-plan but keep shots/journals).
- `--phases` — clear only `phases/` (keep learned memory).
- `--phase <phaseId>` — clear one phase dir (find ids under `.velt-customize/phases/`, or `node <plugin>/scripts/memory.mjs show`).

This is a mechanical file op — no agent, no guide needed. If the user also wants to drop the generated code for a truly bare start, confirm that separately (it may be their work) before running `rm -rf components/velt/ui-customization`.


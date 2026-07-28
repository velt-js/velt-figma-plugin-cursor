---
description: View or prune this project's cross-phase velt-customize memory (learned tokens, component mappings, naming, corrections, gaps).
argument-hint: "[show | prune] [--dir .]"
---

# /velt-customize-memory

Inspect or clean the **per-project** cross-phase memory at `<cwd>/.velt-customize/memory.json` — the advisory store the Planner reads at the start of each phase (tokens, component mappings, naming conventions, learned corrections, verified gaps, and the phase ledger). Memory is **advisory, never authoritative** — the Planner always re-verifies against the fresh design.

- **`show`** (default): `node scripts/memory.mjs show --dir .` — print every entry with its confidence, source phase, and a **⚠STALE** flag on any whose watched fingerprint drifted (guide / manifest / installed Velt package version). Stale entries must be re-verified before reuse; they are not loaded by default.
- **`prune`**: review the listed entries and remove stale, superseded, or wrong ones. Deleting a wrong correction here is the fix for drift; SDK-truth facts belong back in `guide/` (the "write it back" convention), not only in memory. (Edit `memory.json` directly, or mark entries `confidence:"deprecated"` — `load` skips those.)

Memory is written **only** when the user says "phase N complete" (promotes verified learnings to `confirmed`) and by `/velt-customize-fix` (appends a `tentative` correction). It is gitignored. This command never touches app code.

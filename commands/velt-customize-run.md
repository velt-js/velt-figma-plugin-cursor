---
description: Turn a Figma design into clean Velt UI customization (comments + notifications) on this app, via Plan → approach gate → Build → Judge, one Loop (phase) at a time.
argument-hint: "<figma-loop-node-url> [--mode <approach>] [--budget strict|balanced|thorough] [--cloud]"
---

# /velt-customize-run

Run the velt-customize flow on the Figma **Loop** at **$ARGUMENTS**, **in the current project** (cwd — there is no separate target-repo argument).

You are the entry point. The run is **phase by phase, block by block**. A **phase = one `Loop` node** (the user passes one at a time; see the Loop template in [`velt-operating-brief`](../skills/velt-operating-brief/SKILL.md) + `guide/`). Its frames are enumerated into `blocks.json` (the completeness oracle) — `Flows` frames become full-surface acceptance blocks, `State` frames become component blocks — and the loop perfects one block before the next, terminating **mechanically** on `verdict-gate-blocks.mjs`'s exit code, never on `/goal`. The `velt-orchestrator` owns the loop in **owned-loop mode**; `/loop` is optional cadence only. The flow is:

### Watch it live — YOU, the entry point, MAKE THE HEARTBEAT EXIST, THEN print the watch command NOW
Subagent output doesn't stream into this view, so the run writes a **heartbeat log** instead. The catch: a `tail` is useless until the file exists on disk, and the orchestrator doesn't reach its first on-disk write until *after* preflight — so for the whole preflight window (and forever, if preflight HALTs) there's nothing to tail. **Close that window first:** run `node <plugin>/scripts/phase-init.mjs "$ARGUMENTS"` **before you dispatch the orchestrator**. It derives the stable `phaseId`, creates `.velt-customize/phases/<phaseId>/progress.log` with a first line, and prints the absolute `phaseDir` on its last stdout line — **pass that `phaseDir` to the orchestrator** so preflight items + any HALT stream there from second zero. Then print this to the user and tell them to run it in a **second terminal**:
```
node <plugin>/scripts/progress.mjs --watch        # zsh-safe (tail -F); auto-resolves the newest phase
```
Steady new lines = working; a multi-minute gap = genuinely stuck (safe to interrupt). Reliable liveness regardless of heartbeat compliance: `node <plugin>/scripts/progress.mjs --activity`. **Avoid the raw glob `tail -f .velt-customize/phases/*/progress.log`** — under zsh (default `nomatch`) it errors `no matches found` the instant the file isn't there yet, which is exactly the startup window.

### 1. Setup (once) — invoke `velt-orchestrator` in **setup mode**, in the FOREGROUND
**Do NOT run setup as a background subagent.** Setup is interactive — it can HALT-and-ask on a preflight failure and it *always* stops at the Approach Gate for the user's per-surface choice; a background agent can neither ask those questions nor stream its output (including the `▶ Watch live` line), so backgrounding setup reproduces the silent-black-box failure this design exists to kill. (Only the later **owned-loop** may optionally be backgrounded, and only because the heartbeat file already exists by then.) There is also no lockfile, so "setup is already running" is only your own memory of dispatching — never assume a prior background agent is still alive; check `.velt-customize/phases/*/progress.log` (or `--activity`) instead.

Pass it: the pre-created **`phaseDir`** (from `phase-init.mjs` above — so its first heartbeat lands in the file the user is already tailing), the Figma Loop node/URL (from `$ARGUMENTS`; if absent, ask — an allowed blocking question), the target = **cwd**, the feature scope (default: comments + notifications), and the **approach** (see the gate below). In setup mode it: runs **preflight** (HALT on any hard ✗); **enforces the Approach Gate** (below); **loads cross-phase memory** (`node scripts/memory.mjs load` — advisory tokens/mappings/naming/corrections, re-verified against fresh extraction, stale entries flagged); pins the manifest; runs the **planner** (recognize surfaces, pick layers within the chosen approach, synthesize goals + the Connect Map); enumerates the Loop (`enumerate-blocks.mjs` → `Loop → State/Flows` blocks — **rejecting a URL with no `node-id`** and **warning if it yields more than ~8 blocks**); presents the **per-surface coverage matrix**; and **initializes the phase journal**. It returns the work-list + "ready to loop" (or `HALTED`/`BLOCKED`).

### Approach Gate (MANDATORY — never skipped)
The approach is a required input every run: **`strictly wireframe` | `strictly primitives` | `wireframes + primitives` | `freeform`**. It is supplied via `--mode` or stated in the instruction. **If none is given, HALT and ask the user which approach to use, presenting your own per-surface recommendation with the reasoning from `guide/02-decision-tree.md`.** Never auto-pick, never infer silently, never proceed without an explicit answer. Record the chosen mode in the journal + `memory.json`. (`strictly primitives` marks a piece `mode_blocked` rather than silently inserting a wireframe.)

### `--cloud` (fully autonomous, headless — Cursor cloud agent / CI / any no-TTY box)
Pass `--cloud` to run **unattended**: no foreground, no questions, no desktop assumptions. It is a strict, **fail-fast** variant of the same flow — the block loop, the mechanical `verdict-gate-blocks.mjs` terminator, bounds, stuck-detection, and the reports are all **unchanged**; `--cloud` only removes the human touchpoints and the local-desktop dependencies:
- **`--mode` is REQUIRED.** The Approach Gate is the one interactive stop, and a headless box has nobody to ask — so `--cloud` **without `--mode` exits immediately** (`HALTED: --cloud requires --mode`), it never waits.
- **Design intake is REST** (this is now true for every run — there is no Figma MCP). In `--cloud` the token comes from `FIGMA_TOKEN` in the env (no keychain); `figma-extract.mjs rest …` + `enumerate-blocks.mjs rest …` hit `api.figma.com`. No token ⇒ fail-fast.
- **Verification is headless.** Capture runs `capture-block.mjs` against a headless Chromium (`playwright-core`); the Judge seeds/drives/probes that **same** browser over CDP (`capture-block.mjs --connect <wsEndpoint>`). A desktop `Cursor's native browser tool` is not assumed.
- **Auth is pre-provisioned, not paused.** The target app must already boot into an authed, Velt-rendering state from env/secrets — there is **no** manual-login pause in `--cloud`; if Velt doesn't render, preflight fails fast with the reason.
- **Every HALT is a clean non-zero exit + a written handoff** (to `progress.log` and the phase handoff), never an interactive wait. Setup MAY run in the background (the heartbeat file already exists from `phase-init.mjs`), so the whole run can be one non-interactive invocation (e.g. `claude -p "/velt-customize-run <url> --mode <approach> --cloud"`).

### 2. Run the block-by-block loop — `velt-orchestrator` in **owned-loop mode** (it owns the loop)
**After the approach is set and the coverage matrix is shown**, invoke `velt-orchestrator` in **owned-loop mode**. The full flow is defined ONCE, in the orchestrator agent (Sequence 5) — this command only sets it running. The contract:

- **Loop state is script-owned** (`scripts/block-iter.mjs`): iterations, wall-clock, plateau, auto-written `STUCK`, and the phase soft-cap are enforced by exit codes, never by agent memory. Pass `--budget strict|balanced|thorough` (default balanced) to set the caps.
- **One `velt-builder` invocation per block** (inner patch loop with cheap self-probes); **`velt-judge`** (fresh context) verifies at the first structural build and at each PASS-candidate, persisting every artifact and assembling the entry via `scripts/report-block.mjs` — never hand-writing `block-report.json`.
- After each Judge verify: **`scripts/verdict-gate-blocks.mjs`** → `PASS`(0) / `FAIL`(2) / `INCOMPLETE`(3) / `STOPPED`(4), with an **artifact audit** (missing/stale/tampered evidence ⇒ `INCOMPLETE`). The run ends only on exit **0** or **4**. **Termination is the gate's exit code over script-assembled artifacts — never an agent's "looks matched" claim, never `/goal`.**

### 3. Handoff + phase completion
When the loop stops (gate 0 or 4), the orchestrator writes the **phase handoff** ([`templates/phase-handoff.md`](../templates/phase-handoff.md)): the `git diff` of `components/velt/ui-customization/`, the per-block disposition table (PASS / STUCK / BLOCKED / GAP / REMAINING), what it's uncertain about, what it could NOT verify, exact fix-instruction examples, and a recommendation (say **"phase N complete"** vs instruct a fix). On **"phase N complete"** it snapshots and freezes verified learnings into memory (`node scripts/memory.mjs promote`). To correct a specific mismatch, use `/velt-customize-fix` (surgical edit + re-verify the affected block **and its shared-selector blast radius**).

### (Optional) `/loop` for cadence
You MAY wrap the loop with `/loop` invoking `velt-orchestrator` in **step mode** (one block-iteration per turn) for transcript visibility. Cosmetic only — the fidelity gate is always `verdict-gate-blocks.mjs`.

**Before doing anything, load the `velt-operating-brief` skill** (the flow + guardrails + verified facts) and treat `guide/` as the single source of truth. Carry no customization knowledge of your own; never hack (R0); never invent identifiers (R10).


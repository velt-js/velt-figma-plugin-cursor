# velt-customize — Figma → Velt UI customization (native Cursor plugin)

Turns a **Figma design** into **clean, rule-compliant Velt UI customization** (comments + notifications) on a client's existing React app, via a **Planner → Builder → Judge** loop that verifies each surface against the design in a real browser (Cursor's **native browser tool**), or honestly reports an **SDK gap**. It always reads the latest **customization guide** (`guide/`) and never hacks (R0).

This is the native **Cursor** port of the Claude Code plugin (`velt-figma-plugin`): same `guide/` knowledge, same deterministic `scripts/` (extraction, enumerate, visual-diff, verdict gate), with Cursor-flavored commands/agents/rules and the verification path driven by Cursor's built-in browser tool instead of a Chrome MCP.

## Model policy — Claude models, always

Every agent pins a **Claude model** in its frontmatter, and `rules/velt-customize-claude-models.mdc` (always-on) forbids re-routing velt-customize work to non-Claude models:

| Agent | Model |
|---|---|
| `velt-orchestrator` | `claude-fable-5-thinking` |
| `velt-planner` | `claude-fable-5-thinking` (readonly) |
| `velt-builder` | `claude-fable-5-thinking` |
| `velt-judge` | `claude-fable-5-thinking` (readonly) |

If `claude-fable-5-thinking` isn't in your Cursor model picker yet, the rule's fallback applies: newest available Claude thinking model (Fable preferred, then Opus) — never a non-Claude model.

`scripts/validate.mjs` hard-fails if any agent is missing a `model` pin or pins a non-Claude slug.

## Quick setup (plain language)

What you need before starting: **your React app with Velt already working** (comments show up when you run it), **a Figma design** of how you want Velt to look, and **Cursor**.

**1. Install the plugin** — clone this repo anywhere, then from inside it:
```bash
npm run all
```
This checks the plugin is healthy and copies its skills, rules, commands, and agents into `~/.cursor/` (where Cursor actually reads them). **Fully restart Cursor** afterwards. If you later move this repo or pull updates, run `npm run all` again.

**2. Give it your Figma token** — the plugin reads your design straight from Figma's API, so it needs a personal access token. Create one at figma.com → Settings → Security → Personal access tokens, then store it once (you'll paste it when prompted; it goes in your OS keychain, never in a file):
```bash
node scripts/figma-extract.mjs token set
```

**3. Install the one screenshot dependency:**
```bash
npm i -g playwright-core
```

**4. Start a run** — open **your app's repo** in Cursor (not this plugin repo) and type:
```
/velt-customize-run <figma-loop-node-url> --mode "wireframes + primitives" --budget balanced
```
- The URL must point at one **Loop** node in your Figma file (right-click the Loop → Copy link), not the whole file. Keep a Loop to 8 frames or fewer — bigger designs are split into several Loops, run one at a time.
- `--mode` is how it's allowed to build: `strictly wireframe`, `strictly primitives`, `wireframes + primitives`, or `freeform`. Leave it out and the plugin will ask you, with a recommendation.
- `--budget` controls how long it may spend per block: `strict`, `balanced`, or `thorough`.

**5. Watch it work** — in a terminal:
```bash
node /path/to/velt-figma-plugin-cursor/scripts/progress.mjs --watch
```
New lines appearing = it's working. First it checks everything is ready (and tells you exactly what to fix if not), shows you the list of design frames it found, plans, then builds and verifies one frame at a time. At the end you get a handoff report: what matched, what got stuck, and anything the Velt SDK genuinely can't do yet.

**6. Finish or fix** — happy? Say **"phase N complete"** (it saves what it learned for the next Loop). See a mismatch? Run `/velt-customize-fix "<describe what's wrong>"`. Start over? `/velt-customize-clear`.

---

## Install (local)

```bash
npm run all        # check-guide + validate + deploy skills/rules to ~/.cursor/
```

Cursor loads **skills, rules, commands, and agents from `~/.cursor/`** (`skills/`, `rules/`, `commands/`, `agents/`), not from the plugin directory — `npm run deploy` copies all four there (skills/commands/agents get an absolute plugin-root pointer so `guide/`/`scripts/` references resolve; re-run deploy if you move the plugin repo). Restart / reload Cursor afterwards.

Run a customization from the target app's directory with:

```
/velt-customize-run <figma-loop-node-url> [--mode <approach>] [--cloud]
```

Other commands: `/velt-customize-fix "<mismatch>"`, `/velt-customize-clear`, `/velt-customize-memory`.

## Prerequisites (the run preflights all of these and HALTs with a fix if any is missing)

- **A Figma token** (`FIGMA_TOKEN` env var or the OS keychain) — design intake is **REST-only** (`api.figma.com`); there is no Figma desktop/MCP dependency.
- **Cursor's native browser tool** — drives the live app for verification (in Cursor Cloud the cloud browser; locally the built-in browser tab).
- **A target React app** with `@veltdev/react` installed, authed, and rendering Velt's default UI.
- **Node** ≥ 18. The block scripts (`enumerate-blocks` / `visual-diff` / `verdict-gate-blocks`) are zero-dependency; the device-res capture (`capture-block.mjs`) needs **`playwright-core`** + a Chromium (`npm i -g playwright-core`).

## Figma token (REQUIRED — secure, keychain-based, never committed)

Create a personal access token (`figd_…`) at *figma.com → Settings → Security → Personal access tokens*. Resolution order — **the repo `.env` is never read**:

1. the `FIGMA_TOKEN` environment variable, else
2. your **OS keychain** (macOS Keychain / Linux `secret-tool`), service `velt-customize` / account `figma-token`.

Store it once via the plugin's helper (reads from **stdin**, never argv/history):

```bash
node scripts/figma-extract.mjs token set      # paste the token when prompted
node scripts/figma-extract.mjs token status   # verify (prints a masked value)
node scripts/figma-extract.mjs token remove   # delete it
```

In `--cloud`/CI, provide the token via the `FIGMA_TOKEN` env var (the keychain isn't used headlessly).

## The flow

1. You provide: the **Figma Loop node** + run in the **target repo** (Velt is assumed already installed/authed/rendering).
2. **Plan** (read-only): recognize which Velt component each design element is, pick the cheapest viable layer per surface, synthesize goals + the Connect Map.
3. **Approach gate:** the plugin presents a **per-surface coverage matrix** and **waits for your approach choice** (`--mode` skips the wait) before building anything.
4. **Build → Judge loop** (sequential, block by block — R16): the Builder implements one block; an independent, fresh-context Judge verifies it against the design in the browser (evidence required). Retry → escalate layer → SDK gap, with stuck-detection. Termination is **mechanical** — `scripts/verdict-gate-blocks.mjs`'s exit code, never an agent's say-so.
5. **Report:** coverage (estimated vs actual), the SDK-gap report, screenshots, and the code under `components/velt/ui-customization/`.

## Layout

```
.cursor-plugin/plugin.json   Cursor manifest (skills / rules / agents / commands paths)
.plugin/plugin.json          Open Plugins manifest (same shape)
guide/                       the knowledge base — single source of truth (shared verbatim with the Claude plugin)
scripts/                     deterministic tooling (extract, enumerate, capture, visual-diff, delta-compare, verdict gate, memory, progress) — shared verbatim
skills/  agents/  commands/  rules/   thin Cursor orchestration over the guide (no embedded knowledge)
scripts/deploy-skills.mjs    copies skills → ~/.cursor/skills/ and rules → ~/.cursor/rules/ (required for local installs)
scripts/validate.mjs         gate: manifests + guide self-check + Claude-model pins on every agent
templates/                   VeltCustomization.tsx, styles.css, report templates
golden/                      offline calibration checks (node golden/run-golden.mjs)
```

## Gates

```bash
node scripts/check-guide.mjs   # guide integrity (required files, self-sufficiency, links)
node scripts/validate.mjs      # manifests + guide self-check + Claude-model policy
node golden/run-golden.mjs     # offline golden checks
```

## What changed vs the Claude Code plugin

- **Manifest:** `.cursor-plugin/plugin.json` (+ `.plugin/plugin.json`) instead of `.claude-plugin/plugin.json`.
- **Commands:** filename-based (`/velt-customize-run` not `/velt-customize:run`); arguments are parsed from the trailing text (no `$ARGUMENTS`).
- **Agents:** Cursor frontmatter — Claude model slugs, no `effort`, `readonly: true` on planner + judge.
- **Verification driver:** Cursor's **native browser tool** (CDP `Runtime.evaluate` for the probes) replaces the `claude-in-chrome` MCP; there is **no `.mcp.json`**. The mechanical gate (`visual-diff` / `delta-compare` / `verdict-gate-blocks`) is unchanged.
- **Rules:** `rules/*.mdc` — always-on Claude-model policy + core guardrails.
- **`guide/`, `scripts/`, `skills/` knowledge, `templates/`, `manifest/`, `golden/`:** shared verbatim.

## Scope (v1)

Comments + notifications · React · Cursor host (editor + Cloud/Background Agents). CSS / Wireframes / Primitives (+ mix); Headless flagged heavy. Out of scope: SDK install/auth, other features/frameworks, changing Velt's runtime behavior.

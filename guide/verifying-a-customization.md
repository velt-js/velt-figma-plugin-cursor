# Verifying a customization — the definition of "done"

A customization is **done** when four things are true, in this order: it **matches the design**, Velt's **behavior is still intact**, the code is **rule‑compliant**, and its family's **real paths work** (R30). This page is the step‑ordered flow for confirming all four on **one surface** — the executable companion to R15 (verify after each surface) and R16 (build by family, verify per block).

> **Golden rule of verification: MEASURE THE WHOLE SURFACE, don't eyeball or sample — and name every difference.** Fidelity is a whole-surface measurement problem. Two failures came from sampling: "looks ~90% close," then later "5 sampled properties pass" while the whole surface was glaringly wrong. So you check **three** things per state and ALL must be clean: (1) **style** — rendered computed styles vs the `designSpec`'s exact numbers, per element, per property (non-structural lengths **±2px**, colour **CIEDE2000 ΔE < 2**, keywords exact, font-family by family); (2) **layout** — each element's surface-relative **box** (x/y/w/h), sibling **gaps**, and **relations** (name left-of time, message below header, actions top-right), plus **missing/extra elements**; (3) a **visual side-by-side** where **any nameable difference is a FAIL**. The checklist is **auto-derived from every mapped element** (no hand-picking — that's how a broken surface slipped through). There is **no aggregate score** and **"looks close" is a FAIL**. (Tolerances exist only because Velt's engine differs sub-pixel from a design tool — not to permit visible differences. The single mechanical exception is R29: sparse sub-pixel residue confined to a glyph whose asset identity is verified — classified by `visual-diff.mjs --accept-glyph-residuals`, recorded as accepted-with-note, never hand-waved.)
>
> **The whole pipeline is ONE command.** `scripts/measure-block.mjs <phaseDir> <blockId> --url <appUrl>` runs reset → drive (from the block's probe brief) → capture → visual-diff → BROWSER/LAYER/CONTRACT/STABILITY probes → `report-block.mjs` assembly, against a persistent browser. The **builder self-probes with the same command**, so its PASS-candidate is already a measured PASS; the verifier re-runs it fresh for the audit. Nobody transcribes numbers — every value is script-measured and persisted.
>
> **The verifier never decides when the RUN stops.** It surfaces its full evidence (gross-mismatch result + style + layout delta tables + named visual differences + verdict) and writes each block's disposition to `block-report.json`; the **mechanical `scripts/verdict-gate-blocks.mjs` exit code** over `blocks.json` (the Figma-derived completeness oracle — every frame/state is a block) terminates — never `/goal`, never an eyeball. The build/runtime can never declare "matched."

Run this flow **per surface**, finish it, then move to the next surface. Don't batch (R16).

---

## What you need first (preconditions)

You can't verify what isn't rendering. Before anything else:

1. **Velt is initialized.** The app boots, the user is identified, documents are set, and the **default** version of this surface renders. Gate logic on `useVeltInitState()` if needed. (See [`debugging.md`](./debugging.md) §"First, always".)
2. **The surface has data.** Create a comment / open a thread / trigger a notification through the app's own UI so the surface has something to show. If you genuinely can't seed data, verify the **empty / loading** state only and record that limitation in the report.
3. **You have the design reference** for this surface (the Figma frame / screenshot) and know which **states** it specifies.

If the app won't build or run, the visual/behavior checks can't be performed — the surface is **BLOCKED**: it is neither a pass nor a fail, the design match is simply *unverified*. You can still run the static rules scan (step 4) on the produced code. Don't fake a pass. (What to deliver and how to report a blocked surface is the tool's concern, not this flow's.)

---

## The flow

### Step 1 — Drive every state the design specifies

For each visual goal, render the surface in each **state** the design covers and capture it. The states that matter per surface are in the [matrix below](#per-surface-state--behavior-matrix). Common ones:

- **default**, **hover**, **selected/focused**
- **empty**, **loading / skeleton**, **filtered‑to‑zero**
- **unread**, **resolved** (and `OPEN` / `IN_PROGRESS` / `RESOLVED` if the design themes by status)
- **long content** (truncation), **private** (if shown)

Capture each state as evidence. A visual goal with states `["default","resolved"]` is only checkable once you've driven both.

### Step 2 — Whole-surface measured check + visual gate (match the design)

For each state, do all four — this is the gate:

1. **Coverage is GENERATED, not authored (R26) — the completeness oracle is `blocks.json`.** Every Figma frame/state is one **block** (`scripts/enumerate-blocks.mjs`); for the current block you measure **every mapped element** — every distinct styled appearance (the teal mention, the placeholder, each filter row), every `mustSupply` slot, every mount-map part — you do not hand-pick a subset. Resolve each element's live selector by inspection (the manifest `cssClasses` for measured leaves; inspect to the leaf for the rest). Add **relations + gaps** from the manifest `layout`. Assemble the probe object `{ surfaceSelector, tol, elements, relations, gaps }`. You write a disposition for the block into `block-report.json`; **`scripts/verdict-gate-blocks.mjs` decides done** — a run missing a block, an undriven state, or a missing artifact is **INCOMPLETE, not PASS**, so the loop can't end on it.
2. **Gross-mismatch pre-check first:** compare total content height / element count / surface extents vs the designSpec. Grossly off ⇒ FAIL immediately (don't let per-element props "pass" on a broken surface).
3. **Inject `BROWSER_PROBE`** (from `scripts/delta-compare.mjs`) via the browser tool — it reads each **live** node's `getComputedStyle` + surface-relative `getBoundingClientRect` (never the 0-size `*-wireframe` template) and returns a delta table + verdict covering **style** (ΔE<2, ±1px, keywords exact) AND **layout** (box ±2-3px, gaps, relations, missing/extra elements).
4. **Visual side-by-side — a GATE:** capture the full-surface screenshot beside the Figma frame and **name every visible difference** (density/spacing, name placement, filter as a box vs icon, hover actions revealed, unwanted banner). **Any nameable difference ⇒ FAIL** — then find the property/relation you didn't measure and add it. A clean table with an obviously-wrong screenshot is still a FAIL.

**Hard gates:** any console error / unbuilt page / mapped element with `width===0` ⇒ `BLOCKED`/`FAIL`. Every `mustSupply` slot must be **present and carry the design's content** — an icon slot must contain the design's exported SVG (compare identity), not a Velt default or hand-drawn glyph (R17 FAIL). A popup must be styled on its `content` slot, never its container/trigger (R23). Horizontal padding must not compound across nested wrappers (R22). No feature/prop whose UI the design doesn't show (R24). **Colours still must trace to a `--velt-*` token / documented class** (an accidentally-matching hard-coded colour breaks in dark mode — fail it even if ΔE passes).

The delta table's failing rows + the named visual differences ARE the feedback. Mark the goal **met** only when, for every state, the gross check is clean, the style + layout tables are empty, and the visual side-by-side has no nameable difference; otherwise **not met**, listing each diff.

### Step 3 — Behavior check (Velt still works) — including interaction STABILITY

Customizing presentation must **never** break Velt's behavior — you never disabled it, so it must still work (R0, R7). Two halves, both required:

**3a — the action functions, end‑to‑end.** Perform the surface's real actions (in the [matrix](#per-surface-state--behavior-matrix)) and confirm each still functions **through to its outcome**: place a pin, open a dialog, **type a reply and click Send and confirm it posts**, change status, filter, sidebar sync; open a notifications panel, switch tab, mark read, click through. Perform the action by a **real on‑screen click at the visible element's box** (a JS `.click()` often won't fire Velt's handler, and there's a 0‑size registry twin that swallows class‑selector clicks). If an action is dead, something was hidden with CSS instead of a prop (R7), interactivity was put in wireframe markup (R4), or a slot was dropped — fix it; it is not a "design gap." **One passing path is not proof** — drive the *exact reported* interaction, not a convenient neighbour (a Cancel that "worked once on a nearby card" false‑passed exactly this way).

**3b — the target doesn't MOVE mid‑interaction (R27).** A static per‑state capture proves the surface looks right while it sits still; it does not prove it holds still *during a click* — true of **any** interactive surface, not just composers. The failure: a visibility/layout rule keyed on a **transient** state (`:focus`/`:hover`/`:active`, or a Velt twin like `velt-composer-input-focused`) flips at the instant of the click — the element loses focus, a hidden piece re‑appears, the control shifts out from under the cursor, the click misses. Run **`STABILITY_PROBE`** (`scripts/delta-compare.mjs`) on **every interactive affordance the surface renders** (the same set the phantom‑interactive scan enumerates): record its box, drop the transient state the click would drop (blur the focused element), reflow, re‑measure. **Any shift > 1px ⇒ FAIL** — re‑anchor the rule on a stable, persistent state (a verified open/selected condition, e.g. `velt-composer-open`). This is a distinct gate from the static states; passing the static capture does not exempt it.

### Step 3c — Family real-path smoke suite (R30) — after the family's blocks pass

Fixture-green is not done: a run passed every seeded-fixture block while real interaction paths were broken (full-width fixture text masked an alignment bug; the popover dialog context was never exercised and its CSS leaked; a `min-height` pinned to a 2-line fixture dead-banded 1-line real text — 7 user-found defects). So once a **family**'s blocks are clean, run its scripted real-path suite — `scripts/measure-block.mjs smoke <phaseDir> <familyId> --url <appUrl>` from the Planner-authored spec (`briefs/<familyId>.smoke.json`):

- a **short** message AND a **max-length** message (never only the canonical fixture text);
- the surface in **every dialog context it appears in** (sidebar card / popover open-dialog / hover preview — shared classes leak across contexts);
- **every affordance clicked once** (reply, resolve, edit, options), asserting the outcome and no dead band;
- one **viewport resize**; **zero console errors** throughout.

The result (`results/smoke/<familyId>.json`) is a gate artifact: missing ⇒ the phase is INCOMPLETE; failing ⇒ FAIL with the step names as feedback.

### Step 4 — Rules‑compliance scan (static, on the produced code)

Walk the **Quick gate** in [`rules.md`](./rules.md) against what you wrote. The checks that catch the most:

- **R0** — no hacks: no `setTimeout` / `MutationObserver` on Velt internals, no scraped internal markup, no timing/DOM shims.
- **R1 / R2** — exactly one `<VeltWireframe>`; the live feature component is mounted.
- **R4 / R5** — no `onClick` / `useState` / hooks inside wireframe markup; UI‑library components wrap *around* primitives, not *inside* wireframes.
- **R6 / R7 / R8 / R9** — selector CSS only with shadow off or `injectCustomCss`; no `display:none` to remove features; one stylesheet; dark values scoped to `:root[data-velt-theme="dark"]`.
- **R10** — every identifier (slot, prop, variable, class, hook, API) verified against [`reference/`](./reference). If it isn't there, it doesn't exist.
- **R11 / R16** — files under `components/velt/ui-customization/`; only this one surface touched this step.
- **Verified gotchas** — `ThreadCard` nested in `Body → Threads`; container slots declare their full child tree; correct shadow root‑vs‑nested handling; pin index/number filled via `velt-data`; `VeltCommentDialog`, never the deprecated `VeltCommentThread`. (All in [`reference/wireframe-components.md`](./reference/wireframe-components.md).)

A rule violation is a **fail**, even if the surface looks right — a patchy fix that "looks right" today breaks silently tomorrow (R0).

### Step 5 — Verdict

| Verdict | When | Then |
|---|---|---|
| **PASS** | Every visual + behavior goal **met**, rules scan clean. | Surface done. Move to the next (R16). |
| **PARTIAL** | All *unmet* goals are genuine SDK gaps (no clean supported path), and everything achievable is met + clean. | Accept the best clean partial. Record each gap per [`sdk-gaps-and-blockers.md`](./sdk-gaps-and-blockers.md). Move on. |
| **FAIL** | ≥1 goal unmet or a rule violated, and it's **fixable**. | Return to the build with specific feedback; re‑run this flow. |
| **BLOCKED** | App won't build/run, or the surface can't be reached → design match unverified. | Static rules scan only; the match is unconfirmed (the tool decides what to deliver/report). |

> A goal is only allowed to be **PARTIAL** (not FAIL) once you've confirmed there is no clean supported path for it — run the [blocked / gap flow](./sdk-gaps-and-blockers.md) before downgrading a FAIL to a gap. Never convert a fixable miss into a "gap" to escape the loop.

---

## Per‑surface state & behavior matrix

The concrete "what to drive" for each v1 surface. Drive the **states** for the visual check (step 1–2); perform the **behaviors** for step 3. Verify only the states the design actually specifies, but never skip the behavior column.

### Comments

| Surface | States to drive | Behaviors to confirm |
|---|---|---|
| **Comment pin** (`VeltCommentPin`) | default, by‑status (`OPEN`/`IN_PROGRESS`/`RESOLVED`), unread, selected; index/number shown for normal comments (none in page‑mode) | click → opens dialog; recolors on status change; index via `velt-data` renders |
| **Comment bubble** (`VeltCommentBubble`) | default, with count, unread, on‑pin‑hover (if enabled) | hover/click behavior; count updates as comments are added |
| **Comment dialog** (`VeltCommentDialog`) | default, empty thread, **collapsed/empty‑composer** (single comment, reply box closed — measure trailing whitespace = 0 extra px, R27), resolved, long content; `variant="dialog"` and `variant="sidebar"` if both used | reply **posts end‑to‑end**, Send/Cancel **don't shift mid‑click** (`STABILITY_PROBE`, R27), change status (resolve/unresolve), reactions, composer submit; opens from pin |
| **Comments sidebar V1** (`VeltCommentsSidebar`) | default list, empty, loading, filtered‑to‑zero | search, filter panel (apply/reset), select a thread → syncs to its pin/dialog |
| **Comments sidebar V2** (`VeltCommentsSidebarV2`) | list, group headers expanded/collapsed, empty‑placeholder, filtered‑to‑zero | search, filters/miniFilters, grouping, select row → sync |
| **Sidebar button** (`VeltSidebarButton`) | default, with unread count | click → opens/closes sidebar; count updates |
| **Comment tool** (`VeltCommentTool`) | default, active | activates comment‑placement mode |
| **Inline / text / multi‑thread** | section list, empty, composer position, filter/sort states | add comment, reply, filter, sort |

### Notifications

| Surface | States to drive | Behaviors to confirm |
|---|---|---|
| **Notifications panel** (`VeltNotificationsPanel`) | each enabled tab (`forYou`/`documents`/`all`/`people`), empty per tab, unread, settings view | switch tab, mark read, click‑through to source, open settings |
| **Notifications tool / bell** (`VeltNotificationsTool`) | default, with unread count | click → opens panel (`panelOpenMode`); count updates |
| **Notifications history** (`VeltNotificationsHistoryPanel`) | embedded list, empty | scroll/read history |

> **Also run the cross‑cutting checks** for any surface with custom markup: dark mode on/off, RTL, mobile width, keyboard navigation + visible focus, and that scroll actually works (R14). Full checklist: [`cross-cutting.md`](./cross-cutting.md) §Testing. Those are part of "matches the design," not an afterthought.

---

## After an SDK upgrade

Re‑run the **visual + rules** checks. Variable‑based theming (`--velt-*`) is upgrade‑safe; **class/selector overrides and wireframe slot names** are the things most likely to drift — they're the first to re‑verify ([`cross-cutting.md`](./cross-cutting.md)).

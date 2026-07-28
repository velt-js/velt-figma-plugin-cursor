# Rules (must follow)

These are **non‑negotiable**. Each is a rule + the failure it prevents. An AI tool should treat them as hard constraints; a human should re‑check them before shipping.

---

## R0 — No hacky fixes. Ever. (the prime directive)

**Never implement a hacky, patchy, or hidden workaround to force something a layer doesn't support.** If a design goal isn't achievable cleanly with wireframes or primitives (within the supported APIs, slots, props, variables, classes, and hooks in this guide), **do not fake it** — no brittle DOM scraping, no `setTimeout`/`MutationObserver` to mutate Velt's internals, no fragile DOM surgery, no copy‑pasted internal markup, no "it works for now" shims.

- Implementation must be **clean, correct, and idiomatic** — the same quality you'd ship to production. **No compromise on code quality** for the sake of "getting it to look right."
- If the cleanest path is a different layer, **switch layers** (escalate per the [decision tree](./02-decision-tree.md)) rather than hacking the current one.
- The "inspect → find class → `!important` override" workflow is **not** a hack — it's the supported way to restyle (R9b). A hack is something that depends on Velt's *unsupported internals* or *timing* and will break on the next render or SDK update.
- **If a goal is genuinely unachievable cleanly (a real blocker), stop and leave a clear code comment** stating: what was wanted, why it can't be done cleanly with the available APIs, and what was done instead (or that it's intentionally left out). Surface the blocker — never bury it under a fragile fix.

```tsx
// BLOCKER: design wants X on the comment dialog, but no slot/prop/variable supports it
// (see reference/). Implementing this cleanly isn't possible today.
// Left as default rather than hacking Velt's internals. Revisit if the SDK adds support.
```

A patchy fix that "looks right" today is worse than an honest gap — it breaks silently, misleads the next person, and violates every other rule here. When in doubt, choose the clean partial result + a comment over a complete hacky one.

**When you think a goal is impossible, don't guess — run the flow.** [`sdk-gaps-and-blockers.md`](./sdk-gaps-and-blockers.md) walks you through ruling out the fixable causes (shadow DOM, specificity, wrong layer, off‑by‑default feature, custom data) and, only if none apply, recording it as a real SDK gap (the code comment above + a structured gap entry). That is the supported way to honor R0.

---

## Structural

**R1 — Use exactly one `<VeltWireframe>` in the whole app.**
This is a strong operational rule, not a runtime‑enforced singleton. Each `<VeltWireframe>` registers its children into **one global template map**, merged with **first‑with‑content‑wins** semantics — so multiple registries are technically possible but become **order‑dependent and conflict‑prone** (whichever registers a given slot first wins; later ones are silently ignored). Keep a single registry in `VeltCustomization.tsx`, rendered once near the root, and you avoid the whole class of "why did my wireframe not apply?" bugs.

**R2 — Mount the live feature component, not just the wireframe.**
A `Velt…Wireframe` only *registers* a template. The UI appears only when the real component (`VeltComments`, `VeltCommentsSidebar`, `VeltCommentDialog`, …) is also mounted. Wireframe but no mounted feature ⇒ nothing renders.

**R3 — Choose the cheapest layer per piece; mixing on one surface is allowed.**
Reach in order **CSS → Wireframes → Primitives → Headless**, per feature *and* per piece. You **may** combine layers on the same surface (e.g. a `VeltCommentDialog` primitive + a wireframe for one leaf piece) — that's fine and sometimes necessary (leaf primitives have no sub‑components, so their wireframe is the only way to restructure them). The rule is *don't pick a more expensive layer than the design needs*, not "one approach per surface." See [`approaches/combining-approaches.md`](./approaches/combining-approaches.md).

---

## Interactivity

**R4 — Never put interactive React inside wireframe markup.**
No `onClick`, `useState`, hooks, or stateful UI‑library components inside a wireframe slot — they're **cloned to inert DOM and silently do nothing**. Interactivity must come from `Velt…Wireframe.X` slot components; your markup is the visual shell only. If you need custom interactivity, use [primitives](./approaches/primitives.md) or go [headless](./approaches/headless.md). (Proof: [`edge-cases-and-limitations.md`](./edge-cases-and-limitations.md).)

**R5 — Wrap UI‑library components *around* primitives, not *inside* wireframes.**
`<MuiCard><VeltCommentDialog/></MuiCard>` ✅. A live MUI button inside a wireframe slot ❌ (behavior stripped). See the UI‑library table in [`02-decision-tree.md`](./02-decision-tree.md).

---

## Styling

**R6 — Selector CSS needs shadow DOM off *or* `injectCustomCss`.**
Variable‑only theming (overriding `--velt-*`) works through the shadow DOM and needs nothing. But **class/element selectors and wireframe styles can't reach inside** it — so either set `shadowDom={false}` on those components, **or** keep shadow DOM on and inject your styles into the shadow root via `client.injectCustomCss({ type, value })`. Doing neither looks like "my CSS does nothing." Don't do both for the same surface.

**R7 — Don't `display:none` to remove features.**
Toggle features with **props** on the primitive (`reactions={false}`, `status={false}`, …) or omit the slot in a wireframe. Hiding with CSS leaves dead behavior and breaks on layout changes.

**R8 — Put all Velt CSS in one stylesheet.**
Don't scatter `--velt-*` overrides across components. One `styles.css` (or `velt.css`) keeps theming coherent and dark‑mode correct.

**R9 — Dark values go under `:root[data-velt-theme="dark"]`.**
Don't hard‑code colors that ignore mode — it breaks dark mode.

**R9b — Override Velt's class‑based CSS with `!important`.**
Velt injects styles at runtime with high specificity. Class/element overrides (not `--velt-*` variables) **must** use `!important` to take effect — this is expected, not a hack. Workflow: inspect the element → find its `velt-*` class → override with `!important`. See [`approaches/css.md`](./approaches/css.md) §5 and [`reference/css-classes.md`](./reference/css-classes.md).

---

## Identifiers

**R10 — Never invent — verify instead.**
CSS variables, CSS classes, wireframe slots, `{…}` variables, component props, hook names, **data fields, prop behaviors, and component intent** must come from the reference pages:
- CSS vars → [`reference/css-variables.md`](./reference/css-variables.md)
- CSS classes → [`reference/css-classes.md`](./reference/css-classes.md)
- Wireframe components & slots (+ slot props) → [`reference/wireframe-components.md`](./reference/wireframe-components.md)
- `{…}` variables → [`reference/wireframe-tokens.md`](./reference/wireframe-tokens.md) (syntax) + [`reference/wireframe-variables.md`](./reference/wireframe-variables.md) (catalog)
- Component / layout props → [`reference/component-config.md`](./reference/component-config.md) · prop **behavior & interactions** → [`reference/behaviors.md`](./reference/behaviors.md)
- Hooks → [`reference/hooks.md`](./reference/hooks.md) · **data fields / events / custom‑data storage** → [`reference/data-models.md`](./reference/data-models.md)
- What a component is **for** (right/wrong tool) → [`reference/component-definitions.md`](./reference/component-definitions.md)

If a name isn't there, it doesn't exist (a wrong `{…}` resolves to `undefined`; a wrong prop/hook is a no‑op or error). To confirm a class on a specific rendered element, inspect it in DevTools (`shadowDom={false}`).

**The guide is the first source of truth — but its *silence* is not a verdict.** If the guide doesn't cover something or you're uncertain, **don't guess, don't hedge, and don't declare it impossible** — *verify against ground truth* in this order: the Velt Docs MCP / official Velt docs → the live SDK's actual behavior/types → an empirical test in the running app. Then state the verified fact with certainty (and ideally feed it back into the guide). Inventing a name and treating "not in the guide" as "not possible" are the two opposite failures this rule prevents.

---

## Architecture & code quality

**R11 — Keep Velt code under `components/velt/`, customization under `components/velt/ui-customization/` — ONE component per wireframe, one file per component.**
App UI stays separate from Velt UI. **Every top-level `Velt…Wireframe` registration — including each `variant` of the same wireframe — is its own exported React component in its own file** (`VeltCommentSidebarWf.tsx`, `VeltCommentDialogSidebarWf.tsx`, `VeltCommentDialogPageModeComposerWf.tsx`, …). `VeltCustomization.tsx` contains **only** the single `<VeltWireframe>` root composing those components — never inline wireframe markup. Shared static shells (a composer layout reused by two dialog variants) get their own non-wireframe component file. Cramming multiple wireframes into one file hides which registration broke (defeats R15/R16's build-one-verify-one loop) and makes surfaces impossible to diff/verify independently. See [`03-getting-started.md`](./03-getting-started.md).

**R12 — Cheapest viable layer per feature (CSS → Wireframes → Primitives → Headless).**
Run the [decision tree](./02-decision-tree.md) per feature. **Wireframes are the default for structural customization** (Velt does the data/looping for you — less work than primitives). Use primitives only when you need full control / your own UI library / your own interactivity / a leaf override; headless only as a last resort. Don't go primitives for layout a wireframe slot already exposes, or headless for what a wireframe can do — over‑building is a maintenance liability.

**R13 — Headless objects must match `@veltdev/types`.**
When you hand‑build a `Comment`/`CommentAnnotation`, fill every field the action requires. Missing fields are the most common headless failure.

**R14 — `min-height: 0` on scrollable flex parents.**
A flex column that should scroll needs `min-height: 0` (and `flex: 1 1 auto`) or it collapses/overflows. Common in wireframe sidebars/panels.

**R15 — Verify after each surface.**
Don't customize five surfaces half‑way. Finish one, confirm it renders and behaves (compare against Velt's default by temporarily removing your customization), then move on. Use the step‑ordered flow in [`verifying-a-customization.md`](./verifying-a-customization.md) — drive the surface's states, confirm Velt's behavior is intact, run the static rules scan, then reach a verdict.

**R16 — Build one component FAMILY at a time; verify per block. Never the whole design at once.**
The unit of **build** is the **component family** — the set of design blocks sharing one wireframe subtree + stylesheet region (a composer's default/focused/typing states; a thread card's default/hover/selected/reply variants). Register that family's wireframe **once**, covering all its states, get it rendering, then verify **block by block** (each state/frame is still its own verified block — verification granularity never changes). Do **not** write wireframes/primitives across many *unrelated* surfaces in one pass and debug them together — when something doesn't render you won't know which piece broke, and wireframe gotchas (wrong nesting, container slots dropping children, shadow‑DOM) compound. And do **not** regress to one *block* at a time within a family: its states share one markup + stylesheet, so building them separately re-derives the same structure N times (measured: one family pass covered 6 blocks in the time a block-by-block run spent per ~1.5 blocks). Families with a shared component build sequentially; **flow (acceptance) blocks come last** — they compose already-verified states. Build family → verify its blocks → next family. (This pairs with R15.)

**R17 — Icons/assets come from the design, never hand‑drawn.**
If the design has an icon, glyph, or illustration, **use the design's own exported asset** (the SVG from Figma). Do **not** approximate it with hand‑written CSS shapes, Unicode glyphs, or a different icon from the app — a CSS‑drawn arrow that "looks close" is not a match and is a defect. Extract the asset during recognition and reference it; only fall back to an existing app icon when the design genuinely reuses that exact one.

**R18 — Touch only the Velt customization; never change default project behavior.**
Confine cosmetic/structure work to `components/velt/ui-customization/` and its assets. **Do not** fix the host app's own (non‑Velt) UI even if it diverges from the design, and **do not** alter unrelated project config/behavior. Exploratory host edits outside the plan are applied temporarily, verified, then reverted, and reported. **Standing exception (the golden path — APPLY + KEEP):** mounting `<VeltCustomization/>` once, wiring `client.setUnstyledMode(true, { keepFunctionalStyles: true })`, and setting every host prop the Connect Map / `plan-structure.json` lists (R21 — e.g. `collapsedComments`+`collapsedRepliesPreview`, placeholders, `pageMode`/`embedMode`, `shadowDom:false`) **are the integration itself**. Bake them into the host, verify with `scripts/verify-host-wiring.mjs`, and report them — **do not** temporary-revert them and **do not** mark structure they produce (Show N replies, placeholders) as BLOCKED "manual host change."

**R19 — Supply every `mustSupply` slot; never leave a Velt default.**
For every slot the manifest ([`reference/manifest.md`](./reference/manifest.md)) marks `mustSupply` that the design touches, supply the design's own content — the exported SVG icon (R17), the exact label text, the explicit menu items. **Leaving a `mustSupply` slot to render Velt's default is a defect, not "close enough"** — it is the exact class of miss (filter icon, options-menu items, reply/resolve icons, empty placeholder) the Judge hard‑fails. An icon slot must contain the design's SVG, verified by identity.

**R20 — Measure the WHOLE surface, don't eyeball or sample; "looks close" is a FAIL.**
A surface is verified by **whole-surface measurement**, not by sampling a few selectors (sampling is how a broken surface passed twice). Per state, ALL three must be clean: **style** (rendered computed style vs the `designSpec`'s exact numbers — colour CIEDE2000 ΔE < 2, lengths ±1px, keywords exact), **layout** (each element's surface-relative box, sibling gaps, relations like name-left-of-time / message-below-header / actions-top-right, plus missing/extra elements), and a **visual side-by-side gate** (any nameable difference is a FAIL). The checklist is **auto-derived from every mapped element** (no hand-picking). **There is no aggregate score** to average a miss away. Numbers come from the `designSpec` (read deterministically), never approximated from a screenshot. **The verifier never declares the RUN done** — its measurements are persisted as artifacts, `scripts/report-block.mjs` assembles them into `block-report.json`, and the mechanical `scripts/verdict-gate-blocks.mjs` exit code over `blocks.json` terminates (never `/goal`); the build/runtime can never self-declare "matched."

**R21 — Props‑first: structure a prop produces is never built in CSS.**
Set every host prop/feature‑flag the Connect Map lists as `producesStructure` (e.g. `collapsedComments`+`collapsedRepliesPreview` → the `MoreReply` control, `defaultMinimalFilter`, `sortBy/Order`, placeholders, `shadowDom:false`) **before** writing any CSS — but only those the Connect Map actually lists, which by R24 are only the ones a design cue justifies. Reaching for CSS to fake structure a prop already produces is a defect — climb the feasibility ladder (default → prop/config → wireframe → primitive → headless) in order.

**R22 — Layer reconciliation: one rect in Figma = N layers in the DOM. Paint once on the box-matched owner; neutralize co-box wrappers.**
A Figma node is one rectangle; the DOM renders it as a nested stack (host > div > div > your element), any layer of which may paint box-properties. The **box is the disambiguator**: the layer whose box matches the design node IS the visual node (the *owner*). Reconcile **per property** (`LAYER_PROBE` in `scripts/delta-compare.mjs` computes the plan from the live DOM):
- **Compounding** — two layers paint the *same* property (owner + a wrapper both have padding → the M1 bug: `velt-sidebar-container` + `the-host-list-wrapper (a HOST-app wrapper — varies per project, discovered live by LAYER_PROBE)` + your `.vc-*` each adding padding). Keep the load-bearing one, **`neutralize[]`** the duplicates (`padding:0`/… `!important`).
- **Cooperating** — a wrapper *solely* paints a property the design wants, or a layer has `border-radius`+`overflow:hidden` (a rounded clip). **Keep it** (`cooperating[]`); the design value is routed to it via **`apply[]`**. Do **not** flatten it onto the owner — that breaks the clip / the fill.
- **Never** touch functional CSS (`flex`/`overflow`/`position`/`display`), which carries Velt's layout/behavior (R7).

The manifest's `paddingResets` is just a known-wrapper starting hint. Derive inner spacing from the **designSpec gaps**, never stacked padding.

**R23 — Style the box-matched owner / the precise slot role; never a wrapper.**
Every manifest slot declares a `role` (`container` = structural wrapper, `trigger` = the control that opens a popup, `content` = the popup surface, `item` = a leaf). Style the **`content`** slot for a menu/popup, **never** its `container`/`trigger` — styling the dropdown *container* (whose box wraps the trigger, not the popup) is what rendered the filter as a 210px box. `LAYER_PROBE`'s **`ownerMismatch`** (the styled element's box ≠ the design node's box) catches this deterministically. Likewise scope every override to its exact target: mention CSS goes on the message's `mentionScope` (`.velt-thread-card--message .velt-mention`) only — a bare `.velt-mention` or `.velt-mention--name` over-matches and tints the author name.

**R24 — No feature/prop whose UI the design doesn't show.**
A host prop is set **only** when a recognized design element/feature justifies it (the manifest `hostProps` are a catalog with a `designCue`, no pre-set value; the Planner records the evidence in the Connect Map). Setting a feature flag with no design basis (the demo-leaked `paginatedContactList`/`visibilityOptions` — the latter adds an unwanted VisibilityBanner) is a defect. The manifest generator hard-fails any feature prop carrying a hardcoded value, and the Judge's visual gate catches the unwanted UI it produces.

**R25 — Mount-map integrity: behavior rides on structure, and visual fidelity never excuses a broken mount map.**
A customization can be pixel-perfect and behaviorally dead. Because Velt routes behavior through its own slot components, "does it still work" is a **structural** invariant: for every behavioral part in the manifest's `contract.parts`, the customized tree must still contain that **Velt primitive**, **inside its required ancestor** (the context the runtime binds through — `ThreadCard` in `Body→Threads`), **exactly once** where it's a `singleton`, with **no phantom interactive** (a custom `<button>`/`<div onClick>` the SDK doesn't own — inert per R4). The Judge runs `CONTRACT_PROBE` on the **post-reconciliation** DOM (layer reconciliation can hoist a part out of its context) and treats any violation (`MISSING`/`CONTAINMENT`/`CARDINALITY`/`PHANTOM_INTERACTIVE`) as a **boolean hard FAIL — never an aggregate-scored item**. ΔE 0 with a broken mount map does not pass; the verdict gate cannot terminate on it. *(A clean mount map proves the map is well-formed, not that mounting succeeds at runtime — the residual the slot architecture leaves near-empty; a confirmed "perfect map, still dead" case is the signal to add a per-primitive smoke-mount.)*

---

**R26 — Termination is mechanical: a sample is INCOMPLETE, never a pass.**
The Judge does not author its coverage and does not declare the run done. The completeness oracle is **generated** from the design: `blocks.json` (`enumerate-blocks.mjs` → every Figma frame/state is a block, `Flows` + `State`), and per block the Judge measures **every** mapped element (every distinct styled appearance + every `mustSupply` + every mount-map part). Each block's report entry is **assembled by `report-block.mjs` from the persisted probe/diff artifacts on disk** (the Judge produces the artifacts; it never hand-writes report JSON), and **`verdict-gate-blocks.mjs`** — whose artifact audit rejects hand-written entries, missing/stale evidence files, and report-vs-artifact mismatches — decides: a run missing a block, skipping a required state, or omitting an artifact is **`INCOMPLETE` — NOT `PASS`, so the loop cannot terminate.** `PASS`(0) requires every block built + driven + clean; `STOPPED`(4) is a legitimate bounds/soft-cap stop (STUCK/BLOCKED/GAP/REMAINING, each with evidence). This is the structural fix for the sampling failure (a Judge measuring 5 of 93 styled appearances and self-terminating): coverage is checked, not trusted. "Looks matched" cannot end the loop — only the gate's exit code can.

**R27 — Anchor layout/visibility on a STABLE state, never a transient one — and verify interactive targets don't move mid-interaction.**
A static per-state capture proves the surface looks right *while it sits still*. It does **not** prove the surface holds still *during a click* — a distinct fidelity failure, on **any** interactive surface. The bug class: a visibility/layout rule keyed on a **transient** state (`:focus` / `:hover` / `:active`, or a Velt twin like `velt-composer-input-focused`) flips at the exact instant of the interaction — the element loses focus/hover on pointer-down, a piece hidden under that state reappears, everything below shifts, and the click lands on empty air (the "button shifts and never fires" symptom). Two obligations:
- **Author against the stable anchor.** When you hide/show or re-lay-out a piece by interaction state, key it on a state that **holds through the whole interaction**, not one that drops the instant the pointer leaves the element. Pick the stable twin: e.g. style a composer by `velt-composer-open` (`composerInOpenState`) rather than `velt-composer-input-focused` (`isInputFocused`); gate on a "selected/open" condition (`commentDialogSelected`) rather than `:focus`/`:hover`. Same visual result, no flicker, no shift. (Enabled/disabled may key off the control's own `:disabled` — that tracks the control's state, not pointer position.) Verify any stateful class against [`reference/css-classes.md`](./reference/css-classes.md) (R10).
- **Verify the target is stable across the transition.** Driving the static states isn't enough — the Judge runs `STABILITY_PROBE` (`scripts/delta-compare.mjs`) on **every interactive affordance the surface renders**: record its box, drop the transient state the click would drop (blur the focused element + `focusout`), reflow, re-measure. **Any shift > 1px ⇒ the target moves under the cursor ⇒ FAIL.** And the real action is performed **end-to-end** (do the interaction, real-click the on-screen control, assert the outcome); a nearby path passing once is not proof (this false-passed exactly this way — drive the *reported* interaction, not a convenient neighbour).

**R28 — `velt-if` / `velt-class` attribute directives work ONLY on Velt wireframe elements — NEVER on plain HTML elements.**
Spreading or writing `velt-if="…"` / `velt-class="…"` onto a native `<div>`/`<span>` inside a wireframe **silently never fires** (verified live) — the cloner resolves directives only on Velt elements (`Velt…Wireframe.X` slots, `<VeltIf>`, `<VeltData>`). The element renders unconditionally / the class never toggles, and nothing errors. Do it the supported way:
- **Show/hide custom HTML** → wrap it in **`<VeltIf condition="{…}">`** (it *is* a Velt element).
- **Print a live value** → **`<VeltData field="…" />`**.
- **Toggle a class by state** → put `velt-class` on a **Velt wireframe element**, or key your CSS off **Velt's own state classes / attributes** on the live DOM (e.g. `velt-composer-open`, `:has(button.velt-composer--submit-button:not([disabled]))`) — see [`reference/css-classes.md`](./reference/css-classes.md).
Helper spreads like `{...veltIf("…")}` on HTML elements are the same defect in disguise — a reviewer must treat any `velt-if`/`velt-class` attribute on a non-Velt element as dead code.

**R29 — Sub-pixel glyph residue with a verified-identical asset is ACCEPTED-with-note, never retried.**
Figma and Chrome rasterize differently: Chrome snaps SVG placement to whole CSS pixels, so a glyph whose exported SVG is **byte/shape-identical** to the design's asset can still leave a sparse <1-device-px diff residue that **no CSS change can remove** (measured: two blocks spent ~35 min and one *regression* chasing exactly this). The rule cuts both ways:
- **Accept it, mechanically.** A diff region qualifies as an accepted residual ONLY when ALL hold: its fill is sparse (< ~0.10 — anti-aliasing residue, never a solid block), it is **confined to an icon/glyph box** from the designSpec, AND the rendered asset's **identity is verified** (exact exported-SVG file/shape match — R17's check). `visual-diff.mjs --accept-glyph-residuals` classifies these into `acceptedResiduals` (kept in the artifact for audit); they stop counting toward FAIL. The verifier passes that flag **only after** the icon-identity check passed for the block.
- **Never stretch it.** A solid-fill region, a region outside a glyph box, a wrong glyph (identity check failed), or any delta-table row is a REAL diff — this rule accepts rasterizer noise, never build defects. Widening tolerances anywhere else to escape a FAIL is a defect (R0).

**R30 — Every component family passes a REAL-PATH smoke suite; fixture-green is not done.**
Seeded fixtures verify appearance, not reality: a run went fully green while **real interaction paths were broken** — the fixture typed full-width text (masking a flex-end alignment bug), never opened the POPOVER dialog context (its CSS leaked, twice), and a `min-height` pinned to a 2-line fixture dead-banded 1-line real text; seven user-found defects and ~80 min of post-loop fixes followed. So per **family** (after its blocks pass), a scripted real-path suite must run and pass:
- type a **short** message AND a **max-length** message (not just the canonical fixture text);
- exercise the surface in **every dialog context it appears in** (sidebar card, popover/open dialog, hover preview — shared classes leak across contexts);
- click **every affordance once** (reply, resolve, edit, options) asserting no layout shift, no dead band, and the action's outcome;
- one **viewport resize** sanity pass; **zero console errors** throughout.
The suite is machine-executed (`measure-block.mjs smoke`) from a Planner-authored spec, its result is a gate artifact (`results/smoke/<family>.json`), and the verdict gate treats a missing suite as INCOMPLETE and a failing one as FAIL. Never pin a layout value (like `min-height`) to a multi-line fixture measurement — derive it from the design's single-line state and let content grow it.

---

## Quick gate before shipping

- [ ] **No hacky/patchy fixes** — clean code only; unresolvable blockers are commented, not faked (R0).
- [ ] One `<VeltWireframe>`; live features mounted (R1, R2).
- [ ] No interactive React inside wireframes (R4).
- [ ] `shadowDom={false}` where styled; no `display:none` feature‑hiding (R6, R7).
- [ ] One stylesheet; dark values scoped (R8, R9).
- [ ] Every identifier/behavior/data fact verified against [`reference/`](./reference); unknowns verified against ground truth, never guessed (R10).
- [ ] Folder structure matches the reference — **one component per wireframe registration, one file per component**; `VeltCustomization.tsx` is only the `<VeltWireframe>` root (R11).
- [ ] Each surface uses the cheapest viable layer (R12).
- [ ] Icons/assets use the design's exported SVGs, not hand‑drawn shapes (R17).
- [ ] Only the Velt customization changed; required host changes (mount + Connect-Map props) applied + reported (R18).
- [ ] Every `mustSupply` slot the design touches is supplied with the design's content — no Velt defaults left (R19).
- [ ] Verified by **whole-surface measurement** (style + layout + visual gate) vs the `designSpec`, auto-derived from every mapped element, no aggregate; "looks close"/sampling rejected; termination is the mechanical `verdict-gate-blocks.mjs` exit code, never `/goal` (R20).
- [ ] Host props that produce structure set **before** CSS; no CSS faking prop-produced structure (R21).
- [ ] One gutter — Velt-default wrapper padding zeroed (`paddingResets`); inner spacing from designSpec gaps, not stacked padding (R22).
- [ ] Popups/menus styled on their `content` slot, never the container/trigger; mention CSS scoped to the message only (R23).
- [ ] No feature/prop whose UI the design doesn't show; every host prop justified by a design cue (R24).
- [ ] Mount-map intact — every behavioral `contract.part` mounts as its Velt primitive, contained, singleton-correct, no phantom interactive; a violation is a hard FAIL regardless of pixels (R25).
- [ ] Termination is mechanical — `block-report.json` covers **every** block in the **generated** `blocks.json` (no sampling) + the visual artifact per state; `verdict-gate-blocks.mjs` returns PASS/STOPPED (INCOMPLETE ≠ done) (R26).
- [ ] Interaction-state visibility/layout keyed on a **stable** anchor (a persistent open/selected condition), never `:focus`/`:hover`/`:active`; `STABILITY_PROBE` shows each interactive target moves 0px through the transition; the real action verified end-to-end (R27).
- [ ] No `velt-if`/`velt-class` attribute on a plain HTML element (dead code — they fire only on Velt elements); custom HTML gated with `<VeltIf>`, classes toggled on Velt elements or via Velt's own state classes (R28).
- [ ] Built family-by-family (shared wireframe subtree in one pass), verified block-by-block, flows last (R16).
- [ ] Sub-pixel glyph residue accepted ONLY via the mechanical classifier with asset identity verified; no tolerance-stretching anywhere else (R29).
- [ ] Every family's real-path smoke suite ran and passed — short/long text, every dialog context, every affordance, resize, zero console errors (R30).

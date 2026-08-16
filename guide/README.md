# Velt UI Customization Guide

> Everything you need to make Velt's collaboration UI (comments, sidebar, notifications, reactions, presence, …) match **your** design — from changing a color to building a 100% custom UI.

This guide is written so that **someone who has never heard of Velt** can read it top‑to‑bottom and confidently customize Velt in their app, and so that an **AI tool can follow it step‑by‑step** to turn a design (e.g. a Figma file) into a working Velt implementation.

It covers **UI customization only**. It does *not* cover auth, permissions, data providers, or self‑hosting — except the one setup flag (`shadowDom`) that customization depends on.

---

## The one idea to remember

**Velt owns the behavior, data, and real‑time sync. You own the presentation.**

Every customization approach in this guide is just a different amount of "you own the presentation" — from *recolor it* to *rebuild it from scratch*.

---

## The four layers (in 10 seconds)

Ordered by how you should reach for them — **CSS → Wireframes → Primitives → Headless**:

| Layer | What you do | Design control | Effort |
|---|---|---|---|
| **CSS** | Change colors/spacing/fonts via CSS variables (+ class overrides with `!important`) | Theme only | Lowest |
| **Wireframes** | Keep Velt's behavior/data‑wiring but supply your own HTML layout for each slot | High (layout/structure) | Low |
| **Primitives** | Compose Velt's building‑block components yourself (you do the looping, conditionals, prop‑passing) — full control + works with any UI library | Highest (short of headless) | Medium–High |
| **Headless** | Velt gives you data + actions via hooks; you build 100% of the UI | Total | Highest |

**Default preference: wireframes.** Use CSS for pure theming, **wireframes** for custom structure (the usual choice), **primitives** when you need full control / your own UI component library / your own interactivity (or to customize a *leaf* piece), and **headless** only as a last resort.

You can **mix them — even on the same surface** (e.g. drop in a `VeltCommentDialog` primitive *and* wireframe parts of it; or wireframe the dialog, primitive sidebar, CSS on both). See [`approaches/combining-approaches.md`](./approaches/combining-approaches.md).

---

## How to use this guide

Read in this order. Don't skip the first three — they prevent 90% of mistakes.

1. **[`01-overview.md`](./01-overview.md)** — the mental model + how the layers relate. *(5 min)*
2. **[`02-decision-tree.md`](./02-decision-tree.md)** — **start here for any new design.** Pick the right layer(s) for what you're building. *(the spine of this guide)*
3. **[`03-getting-started.md`](./03-getting-started.md)** — prerequisites, the `shadowDom` rule, and the folder structure to put your code in.
4. **[`build-methodology.md`](./build-methodology.md)** — **HOW to build:** the **extract → map → build → measure** pipeline. Extract the exact numbers + icon SVGs deterministically (**[`extraction.md`](./extraction.md)**), map each element to a real slot/prop/icon (Velt Code Connect, **[`reference/manifest.md`](./reference/manifest.md)** — props-first, supply every slot), build in small patches applying the exact numbers, then **measure** (delta table, not eyeballing). Pair with **[`build-gotchas.md`](./build-gotchas.md)** (the traps + the fix).
5. **The approach you picked** — open the matching file in [`approaches/`](./approaches).
6. **The feature you're customizing** — comments are covered throughout the approach guides; to resolve a specific comment **surface** (dialog, sidebar V1/V2, sidebar button, pin, bubble, comment tool) to its primitive · root wireframe · key props · flags · variables, use the **Surface lookup** map in [`reference/component-catalog.md`](./reference/component-catalog.md). For any other feature (notifications, reactions, recorder, mentions, presence/cursors, activity log, …) open its deep guide in [`features/`](./features) (index: [`other-features.md`](./other-features.md)).
7. **Does the design need a component that isn't showing?** Check [`reference/feature-flags.md`](./reference/feature-flags.md) — many features (reply avatars, priority, minimap, @here, …) are **off by default** and just need a prop.
8. **[`reference/`](./reference)** — the dictionary: look up exact CSS variables, classes, wireframe slots/tokens, props, **behaviors** ([`reference/behaviors.md`](./reference/behaviors.md)), **data fields/events** ([`reference/data-models.md`](./reference/data-models.md)), and hooks while you build. You *look things up* here — you don't read it cover to cover.
9. **[`rules.md`](./rules.md)** — the non‑negotiables. Read once; re‑check before you ship.
10. **[`verifying-a-customization.md`](./verifying-a-customization.md)** — after each surface, confirm it matches the design, behavior is intact, and the rules pass. The definition of "done".

When stuck: **[`debugging.md`](./debugging.md)** (symptom → fix), **[`sdk-gaps-and-blockers.md`](./sdk-gaps-and-blockers.md)** (fixable problem vs. real SDK gap — and how to record a gap honestly), **[`patterns-and-tips.md`](./patterns-and-tips.md)** (proven recipes), **[`context.md`](./context.md)** (attach/read your own data on comments), **[`cross-cutting.md`](./cross-cutting.md)** (a11y/i18n/RTL/responsive/testing), and **[`edge-cases-and-limitations.md`](./edge-cases-and-limitations.md)**.

---

## File map

```
guide/
├── README.md                       ← you are here
├── 01-overview.md                  Mental model + the 4 layers + shadow DOM
├── 02-decision-tree.md             HOW TO CHOOSE a layer (or mix) — the spine
├── 03-getting-started.md           Prerequisites, shadowDom, folder structure
├── build-methodology.md            HOW TO BUILD — the extract → map → build → measure pipeline
├── extraction.md                   Deterministic Figma extraction → the designSpec (exact numbers + icon SVGs)
├── build-gotchas.md                The wireframe/clone/styling traps + their fixes
├── approaches/
│   ├── css.md                      Theme with variables; class overrides with !important
│   ├── wireframes.md               Your layout, Velt's behavior (deepest section)
│   ├── primitives.md               Compose building blocks (+ any UI library)
│   ├── headless.md                 Hooks only — build everything yourself
│   └── combining-approaches.md     Mix-and-match per feature (and per piece)
├── reference/
│   ├── css-variables.md            All --velt-* variables (+ font-family)
│   ├── css-classes.md              Structural + STATEFUL classes (unread, resolved…)
│   ├── wireframe-tokens.md         velt-if / velt-class / velt-data syntax
│   ├── wireframe-variables.md      The complete {variable} catalog
│   ├── wireframe-components.md     82 wireframe components + ALL 770 slot elements + slot props
│   ├── primitives.md               All primitive components (grouped)
│   ├── primitives-capabilities.md  R1 children / R2 context / R3 data — limits + zero-wireframe reachability
│   ├── props.md                    ALL props for EVERY component (VeltComments + 38 others)
│   ├── apis.md                     All feature element API methods (getCommentElement()…)
│   ├── events.md                   All subscribable events per feature (.on('…'))
│   ├── component-config.md         Layout/mode props (filter layout, embed, …) + custom data
│   ├── feature-flags.md            Hidden-by-default features → the prop/method to enable
│   ├── component-catalog.md        Components ↔ primitives ↔ wireframe slots (map)
│   ├── component-definitions.md    DESIGN INTENT → component (recognition catalog): what each is, FOR/wrong-tool, anchored-vs-static
│   ├── behaviors.md                BEHAVIOR layer: prop defaults, how props combine, dialog state machine, variant scoping, positioning ownership
│   ├── data-models.md              DATA layer: entity fields, which hook/event exposes each, custom-data storage, documented absences
│   ├── hooks.md                    Headless hooks (read / mutate / control)
│   ├── _entry-contract.md          The 5-layer standard every reference entry must meet
│   └── manifest.md                 The Velt Code Connect manifest — typed slots · mustSupply · host-props-that-produce-structure
├── features/                       Deep per-feature guides (non-comments)
│   ├── notifications.md
│   ├── reactions.md
│   ├── recorder-and-transcription.md
│   ├── mentions-and-autocomplete.md
│   ├── presence-and-cursors.md
│   ├── activity-log.md
│   ├── comment-surfaces.md         Text / Inline / Multi-thread comments
│   └── annotations-tags-arrows-areas.md
├── rules.md                        STRICT rules (must follow)
├── verifying-a-customization.md    Definition of "done" — visual + behavior + rules, per surface
├── sdk-gaps-and-blockers.md        Fixable problem vs. real SDK gap; how to record a gap honestly (R0)
├── patterns-and-tips.md            Recipes + proven patterns + tips
├── debugging.md                    Blocked? Symptom → cause → fix
├── edge-cases-and-limitations.md   Gotchas + what each layer can't do
├── context.md                      Attach your own data to comments + read it in the UI
├── cross-cutting.md                a11y · i18n · RTL · responsive · testing
└── other-features.md               Index → the per-feature guides in features/
```

---

## For the AI plugin (how to consume this deterministically)

0. **Recognize first — map design → component.** Before the decision tree, identify *which Velt component* each design element is, whether it's available, and what to enable, using the recognition catalog [`reference/component-definitions.md`](./reference/component-definitions.md) (design intent / visual+positional cue → component, with disambiguation for look-alikes and off-by-default flags). When two components match, confirm with the user; when nothing matches, it's host UI (ignore) or an SDK gap ([`sdk-gaps-and-blockers.md`](./sdk-gaps-and-blockers.md)) — don't force a mapping.
1. **Then run the decision tree** ([`02-decision-tree.md`](./02-decision-tree.md)) against each recognized surface. It outputs a layer (or a per‑feature mix) plus a reason.
2. **Honor [`rules.md`](./rules.md) as hard constraints.** They are non‑negotiable (e.g. one `<VeltWireframe>` per app; `shadowDom={false}` when styling; no interactive React inside a wireframe). Above all, **R0 — no hacky/patchy fixes**: if a goal isn't achievable cleanly within the supported APIs, switch layers or leave a clear code comment about the blocker; never fake it with brittle DOM/timing hacks. Clean, correct code only.
3. **Only use real identifiers — never invent one.** The [`reference/`](./reference) pages are **generated from source**: every modern `--velt-*` (+ legacy) variable ([`css-variables`](./reference/css-variables.md)), stateful classes with their conditions, per component ([`css-classes`](./reference/css-classes.md)), all wireframes + slot trees ([`wireframe-components`](./reference/wireframe-components.md)), all primitives ([`primitives`](./reference/primitives.md)), the full `{variable}` catalog ([`wireframe-variables`](./reference/wireframe-variables.md)), every `<VeltComments>` **prop** ([`props`](./reference/props.md)) + layout/mode props ([`component-config`](./reference/component-config.md)), off‑by‑default **feature flags** ([`feature-flags`](./reference/feature-flags.md)), hooks ([`hooks`](./reference/hooks.md)), and the design‑intent **recognition catalog** ([`component-definitions`](./reference/component-definitions.md)). **If a name isn't in these, it doesn't exist** — never invent one; to confirm where a class lands on a rendered element, inspect it with `shadowDom={false}` ([`debugging.md`](./debugging.md)). This rule is stated canonically once — the [source‑of‑truth invariant](./reference/_entry-contract.md) — for every reference page.
4. **Each approach file is self‑contained and step‑ordered** — follow it without cross‑guessing.
5. **Match the folder structure in [`03-getting-started.md`](./03-getting-started.md)** so output stays consistent across designs.
6. **Verify each surface before moving on** ([`verifying-a-customization.md`](./verifying-a-customization.md)): drive its states, confirm Velt's behavior is intact, run the static rules scan, then emit a verdict (PASS / PARTIAL / FAIL / BLOCKED). One surface at a time (R16).
7. **When a goal seems impossible, run the blocked/gap flow** ([`sdk-gaps-and-blockers.md`](./sdk-gaps-and-blockers.md)) before downgrading it: rule out the fixable causes (shadow/specificity/wrong‑layer/off‑by‑default/custom‑data), and only then record it as a real SDK gap (code comment + structured gap entry). Never hack to escape the loop (R0).

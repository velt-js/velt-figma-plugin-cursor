# Behaviors · <component group>

> **TEMPLATE — not a guide page.** Every file in `reference/behaviors/` MUST follow this section order and headings. This is the **Behavior + Composition** layer of the [entry contract](../_entry-contract.md) for one component group — it owns *what each prop does at runtime, its default, and how props combine*, the layer above [`props.md`](../props.md). Keep section names verbatim; drop a section only if it genuinely has no entries, and then state that ("No multi-prop interactions for this group."). Delete this blockquote in real pages.

<Intro: name the components this file covers and the one structural axis that matters most for them (e.g. anchored vs static, single-thread vs multi-thread). Link the anchored/static classification in [`../component-definitions.md`](../component-definitions.md).>

---

## Per-prop behavior (exhaustive)

<One row per non-obvious prop on every component in this group. Cover EVERY prop that has a non-trivial runtime effect; trivial pass-throughs may be grouped. State the default with certainty (never "likely").>

| Prop | Default | Behavior | Interacts with |
|---|---|---|---|
| `propName` | `default` | what it does at runtime | other props/modes it combines or conflicts with (or "—") |

*(Per-component subsections — `## VeltXxx` then a `### Default behaviors (no prop needed)` block — are allowed and encouraged when the group has several components; keep the table-or-rows + defaults shape within each.)*

## Default behaviors (no prop needed)

<What the reader gets with zero props set — the out-of-the-box behavior, listed plainly. This is a documented presence/absence, not a hedge.>

## Prop-interaction matrix

<Every combination where two+ props/modes affect each other, each as its own `### <propA> × <propB>` subsection with the exact resulting behavior. If none: "No multi-prop interactions for this group.">

## Positioning & composition

<Anchored (Velt-positioned) vs statically-placed; scoping rules (global vs scoped/variant); what overrides what. If not applicable (e.g. a pure-data group): "N/A — these surfaces are statically placed in your own layout.">

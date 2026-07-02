# Reference · <Type>

> **TEMPLATE — not a guide page.** Every catalog page in `reference/` MUST open with the standard **source-of-truth banner** below and document every entry to the [entry contract](./_entry-contract.md) (the five layers — Surface · Behavior · Data · Intent · Composition — to the extent each applies). Reference pages document *different identifier types* (props, events, hooks, APIs, CSS, data models, …) so their **bodies differ in shape** — that is expected. What is uniform across all of them: the banner, the per-entry rigor, the "document absences too" rule, and grouping by feature/component. Delete this blockquote in real pages.

## Standard banner (paste at the top of every reference page, adapted)

> **Source of truth — exhaustive for what it covers.** Generated from the Velt SDK (`@veltdev/react` / core). **If a name isn't on this page, it doesn't exist** — don't use it (a missing identifier resolves to `undefined` / renders nothing). Never invent or guess a name; use only identifiers that appear verbatim here or that you verified against ground truth and wrote back to this bar. *(State this page's own scope note: e.g. "exhaustive for comments + notifications + core theming; other features summarized.")*

---

## Body conventions (all reference pages)

1. **Group by feature/component**, not alphabetically — the reader arrives with a surface in mind.
2. **Every entry carries its applicable contract layers.** A prop entry: name + type + one-line gloss (Surface), with default/behavior linked to [`behaviors.md`](./behaviors.md). An event/hook entry: name + payload/return (Surface + Data), cross-linked to its [`data-models.md`](./data-models.md) entity. A method entry: signature + what it does. A CSS entry: the identifier + what it controls (+ theme-safe / stateful / structural classification).
3. **State facts with certainty when verified; never hedge** ("likely/maybe/try" are banned). If a fact is unknown, say so as a documented absence.
4. **Document absences, not just presence** — if a capability/field does NOT exist, say so and name the consequence.
5. **No external paths** — never reference SDK source files, absolute paths, or repo-internal locations (the guide is self-sufficient; `check-guide.mjs` rejects leaks).
6. **Scope honestly** — if the page is exhaustive only for the in-scope features (comments + notifications + core), say exactly that in the banner; don't imply coverage you don't have.

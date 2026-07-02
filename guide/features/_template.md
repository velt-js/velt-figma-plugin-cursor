# Feature · <Name>

> **TEMPLATE — not a guide page.** Every file in `features/` MUST follow this exact section order and headings. Replace the placeholders; keep the section names verbatim. **A section that doesn't apply is NOT deleted** — it stays with an explicit one-line "None — <why>" / "Not <x>able — <alternative>" so a reader can reach a confident "not supported" verdict from the page alone (this is how gaps stay visible). Delete this blockquote in real pages.

<Intro: 1–3 sentences. What the feature is, and the headline customization fact (e.g. "Fully wireframed", "config-prop only, no wireframe", "data/actions live on the comment element").>

## Components

| | Primitive | Wireframe |
|---|---|---|
| <sub-part> | `VeltXxx` *(or — if none)* | `VeltXxxWireframe` *(or — if none, say why: "leaf", "no wireframe")* |

<Optional one-line notes about notable absences, e.g. "There is no `VeltXxxPin` React primitive — customize via the wireframe / CSS only.">

## Config props

<Cheapest customization first. A table of the feature's own config props, OR the explicit line: "None — this feature has no config props; customize via CSS / wireframe / hooks below.">

| Prop | Type | Default | Effect |
|---|---|---|---|
| `xxx` | `boolean` | `false` | … |

## CSS — stateful classes

<The key stateful/structural classes a customizer overrides (always with `!important`, R9b), OR: "None beyond the global `--velt-*` variables — see [`../reference/css-variables.md`](../reference/css-variables.md).">

## Wireframes — slot trees + tokens

<The slot tree(s) + the `{tokens}` / `componentConfig.*` variables available, OR: "Not wireframeable — customize via CSS / primitive props only.">

## Headless hooks

<Read + mutate hooks for this feature, OR: "None — data/actions live on `<element>` (see [`../reference/hooks.md`](../reference/hooks.md) / [`../reference/apis.md`](../reference/apis.md)).">

## Limitations

<Absences stated plainly — what you cannot do, and the consequence, so the reader can stop here with a confident verdict. If genuinely none: "None notable — full slot + data coverage. The interactivity rule (R4) still applies inside slots.">

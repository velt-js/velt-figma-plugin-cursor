# Velt customization — coverage proposal

> Written **before** any build (the §10 approach gate). Confirm the recommended per-surface plan, or override specific surfaces, before the loop starts.

**Run:** `{runId}` · **Guide version:** `{guideVersion.sha}` ({guideVersion.isoTime})
**Figma:** `{figmaNode}` · **Target repo:** `{targetRepo}`

## Per-surface coverage matrix

Each cell = estimated coverage of *that surface's* goals under that approach (conservative pre-build estimate). ✅ = the cheapest approach meeting that surface's must-have goals (R12).

| Surface | CSS | Wireframes | Primitives | Headless | ✅ Recommended | Effort | Key gaps |
|---|---|---|---|---|---|---|---|
| {surface} | {n}% | {n}% | {n}% | {n}% | **{layer}** | {low/med/high} | {what it can't reproduce} |

**Overall (recommended set):** ~{overallEstimatePct}% · **Ceiling:** {ceilingPct}% (capped by surfaces with goals no layer can meet → SDK gaps).

## Recommendation

{recommendationSummary — the recommended column is the per-piece Mix; where stepping up a layer buys meaningful coverage and at what effort.}

## Design inconsistencies detected

Places where the design frames CONTRADICT each other, with the resolution the plan chose. Feedback for the designer — the run proceeds on the stated resolution (best-guess, logged; never a blocking question).

| Inconsistency | Frames involved | Resolution chosen | Why |
|---|---|---|---|
| {e.g. cards carry a 1px #e4e1dd border in flow frames but none in single-state frames} | {frame names} | {border kept} | {flow frames show the assembled surface — treated as authoritative} |

## Your choice

Confirm the recommended plan, or override per surface (e.g. "Primitives for the dialog"). Chosen layers set each work-list item's `layer`. Nothing is built until you decide.

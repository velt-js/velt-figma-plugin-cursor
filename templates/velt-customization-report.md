# Velt customization — run report

**Run:** `{runId}` · **Guide version:** `{guideVersion.sha}` · **Manifest version:** `{manifestVersion.hash}`
**Figma:** `{figmaNode}` · **Target repo:** `{targetRepo}` · **Extraction:** {rest | mcp-fallback} · **Chosen plan:** {per-surface layers}

## Coverage — estimated vs actual

| Surface | Layer | Status | Goals met / total | Estimated % | Actual % | Screenshots |
|---|---|---|---|---|---|---|
| {surface} | {layer} | matched/partial/blocked | {m}/{t} | {est}% | {actual}% | {links} |

**Overall actual coverage:** ~{n}% · **Tokens:** {n} ({per-phase breakdown})

## Connect Map (design → Velt slot/prop/icon)

| Element | Slot (reactPath) | Supplied (`fillWith`) | Host props set |
|---|---|---|---|
| {element} | {reactPath} | {SVG / text / markup} | {prop=value, …} |

## Measured fidelity (final delta tables)

Per surface × state, the Judge's delta table (empty = matched; tolerances ΔE<2 / ±1px). Any residual row is a remaining diff, not a pass.

| Surface · state | Element | Property | Spec | Rendered | Pass |
|---|---|---|---|---|---|
| {surface}·{state} | {element} | {prop} | {spec} | {rendered} | ✓/✗ |

## Blocked / partial (needs attention)

- {surface} — {blocked: why / partial: which goals are SDK gaps → see sdk-gap-report.md}

## Ignored / out of scope

- {figmaNode} — {non-Velt host UI | no Velt surface}

## Code changes

Under `components/velt/ui-customization/` (one stylesheet, one `<VeltWireframe>`):
- {file} — {surface}

## Learnings (from the run journal)

- {one-line root-cause per partial/blocked, for next time}

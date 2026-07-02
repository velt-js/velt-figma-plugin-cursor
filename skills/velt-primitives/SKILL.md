---
name: velt-primitives
description: Compose Velt's building-block components yourself — full control, your own UI library / interactivity, render anywhere, or deep leaf customization. Use when wireframes can't express it.
---

Primitive customization.

- Procedure: `guide/approaches/primitives.md` (step-ordered, incl. fetch→loop→render). Identifiers: `guide/reference/props.md`, `guide/reference/component-config.md`, `guide/reference/hooks.md`, and the Surface lookup in `guide/reference/component-catalog.md`. Verify every name (R10).
- Key facts: use `VeltCommentDialog`, never the deprecated `VeltCommentThread`; `defaultCondition={false}` when *you* control show/hide; wrap UI-library components *around* primitives, not inside wireframes (R5); customize a leaf piece via that leaf's wireframe (mix).

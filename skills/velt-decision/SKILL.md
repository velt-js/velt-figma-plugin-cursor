---
name: velt-decision
description: Pick the customization layer(s) for a Velt surface — CSS / wireframe / primitive / headless / mix. Use when deciding how to build a given surface.
---

Decide the layer for a surface.

- Read `guide/02-decision-tree.md` and walk Q1–Q4, then the sub-decisions S1–S6 (feature-flag, custom-data, UI-library, mix, escape-hatch/`defaultCondition`, shadow-DOM). Background model: `guide/01-overview.md`.
- Output: the chosen layer (or per-piece mix) + the reason + the sub-decisions resolved.
- Golden rule: the **cheapest viable layer per piece** (CSS → Wireframes → Primitives → Headless). Don't over-build.

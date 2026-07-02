---
name: velt-gap
description: Decide whether a blocked goal is fixable or a real SDK gap, and record the gap honestly. Use whenever a design goal seems impossible — before ever reaching for a workaround (R0).
---

Blocked? Fixable vs real SDK gap.

- Follow `guide/sdk-gaps-and-blockers.md`. Rule out the fixable causes first: shadow DOM / specificity / wrong class, wrong layer (escalate per `guide/02-decision-tree.md`), off-by-default feature (`guide/reference/feature-flags.md`), custom data (`guide/reference/component-config.md`), or behavior-not-presentation (out of scope).
- Only if no clean path exists in any layer: record the gap entry (surface · requirement · why · attempted layer · clean alternative shipped · suggested SDK addition · guide ref) + an R0 code comment in place. Ship the best clean partial. **Never hack** (R0).

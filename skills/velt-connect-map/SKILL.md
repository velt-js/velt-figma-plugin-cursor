---
name: velt-connect-map
description: Map each design element to the real Velt component/slot/prop/icon (Velt Code Connect) — the decided instructions the Builder executes. Use after recognition + extraction, before building. Enforces props-first + supply-every-slot.
---

Velt Code Connect — design element → slot/prop/icon map.

- For every element, emit one entry from [`guide/reference/manifest.md`](../../guide/reference/manifest.md) + the `designSpec`: `{ veltComponent, rootWireframe, slot (reactPath), slotType, fillWith (exported SVG | exact text | child markup), hostProps[], variant, cssClasses[], cssDecls }`.
- **Props-first:** list every host prop that *produces* the needed structure (manifest `hostProps.producesStructure` — `collapsedComments`+`collapsedRepliesPreview` → `MoreReply`, `defaultMinimalFilter`, `sortBy/Order`, placeholders, `visibilityOptions`, `shadowDom:false`) BEFORE any CSS. Structure from a prop is never done in CSS.
- **Supply every slot:** for every `mustSupply` slot the design touches, set `fillWith`. A slot left to Velt's default is a mapping error (the Judge hard-fails it).
- The map is the **decided** instruction set — the Builder executes it verbatim and makes no design decisions. Verify every slot/prop against the manifest (R10).

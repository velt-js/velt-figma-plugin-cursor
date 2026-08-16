---
name: velt-primitives
description: Compose Velt's building-block components yourself — full control, your own UI library / interactivity, render anywhere, or deep leaf customization. Use when wireframes can't express it.
---

Primitive customization.

- **Identifier truth is `manifest/velt-primitives.json`**, generated from the SDK's own artifacts by `scripts/sync-primitives.mjs`. `guide/reference/primitives.md` is a prose snapshot that has **drifted** (it says 491 React components; the SDK registry has 443, of which 441 accept children). **On disagreement the manifest wins.** Never invent a name (R10).
- Procedure: `guide/approaches/primitives.md` (step-ordered, incl. fetch→loop→render) and its "Children, context and data (R1/R2/R3)" deep-dive. Capability + limit reference: `guide/reference/primitives-capabilities.md`. Other identifiers: `guide/reference/props.md`, `guide/reference/component-config.md`, `guide/reference/hooks.md`, `guide/reference/component-catalog.md`.
- **Check reachability BEFORE planning:** `node scripts/check-primitive-reachability.mjs --surface <s> --mode "<mode>"`. 392 of 770 wireframe slots have **no primitive counterpart**, so `strictly primitives` is impossible for recorder, V1 comment surfaces, reactions, cursor, presence and live-state-sync. Those are `mode_blocked` — never silently swap in a wireframe.
- **Gate every primitives build:** `node scripts/lint-primitives.mjs <appDir>` (P1–P8). Separate from `lint-customization.mjs`, which owns the wireframe rules.
- Key facts: use `VeltCommentDialog`, never the deprecated `VeltCommentThread`; `defaultCondition={false}` when *you* control show/hide; wrap UI-library components *around* primitives, not inside wireframes (R5).
- **R1/R2/R3 facts that break a build if missed:** `VeltCommentDialog` / `VeltCommentDialogThread` are **not containers** (markup inside them does not render; the composer *is* a container) · a compound-trigger leaf without its `-trigger` ancestor is a **dead control** · children on a repeater render **once** · plain-text children don't render · hand-placed primitives now **inherit `shadowDom`**, which silently kills class-based CSS · `data-velt-*` state attributes are **not built**.
- **Availability:** R1/R2/R3 land in an unmerged SDK PR. Verify the target app's installed `@veltdev/*` version before emitting children/context/data code — otherwise it compiles and silently does nothing.

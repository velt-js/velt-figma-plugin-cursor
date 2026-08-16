# Reference · Primitive capabilities (children · context · data)

> **Source of truth — exhaustive for what it covers.** Generated from the Velt SDK's own capability audits. **If a capability isn't on this page, it doesn't exist** — don't rely on it (an unsupported capability fails silently: markup doesn't render, an inherited value doesn't resolve, a control renders and does nothing). Never invent or guess a name; use only identifiers that appear verbatim here, in [`primitives.md`](./primitives.md), or that you verified against ground truth and wrote back to this bar. *Scope: exhaustive for the three primitive capabilities — R1 customer children, R2 context inheritance, R3 state reads — across the 13 V2 primitive families. Wireframe slots are a separate surface ([`wireframe-components.md`](./wireframe-components.md)) and are not covered here.*

> **⚠️ Availability.** These three capabilities ship in an SDK change that is **not merged and not published** as of this page. Verify the target app's installed `@veltdev/*` version before relying on any of it — against an older SDK the code compiles and silently does nothing. The machine-readable form of this page (`manifest/velt-primitives.json`) carries the availability flag the tooling reads.

---

## The three capabilities

| | Capability | What it gives you | Coverage |
|---|---|---|---|
| **R1** | **Children** | Markup you write inside a primitive tag replaces its default content and is **moved, not cloned** — so your handlers and framework components stay live. This is the thing wireframes cannot do. | **441 tags** accept children; 1 documented exception |
| **R2** | **Context inheritance** | Attributes on a parent primitive (`annotation-id`, `comment-id`, …) flow to nested Velt descendants. A child's own attribute always wins. | Published by all primitives; **consumed** by the 91 that resolve an entity |
| **R3** | **State reads** | Read a surface's live derived state as an Observable / React hook, and drive your own conditionals from it. **Read-only** — mutations go through the existing action APIs. | **6 published getters**; 1 published React hook |

---

## R1 — Children

**Precedence for the same spot:** `children → template input → registered wireframe → Velt's default`. The more specific wins, so a wireframe can be migrated off one spot at a time.

### Rules

| Rule | Consequence if broken |
|---|---|
| **Children must be elements** | Plain text does not render. Wrap it: `<span>text</span>`. |
| **One stable root element** | Children are *moved*, not cloned. A top-level child whose identity changes each render breaks; wrap variable content inside one stable element. |
| **Repeating containers render children once** | A list renders one row instead of N. Own the loop in your own code; R2 feeds each row its context. |
| **A compound-trigger leaf needs its `-trigger` ancestor** | Composing a chip from `-trigger-icon` + `-trigger-name` alone produces a control that renders pixel-perfect and **does nothing** — the click handler lives on the `-trigger`. |

### Documented absences

- **The comment dialog root and the thread host are not containers.** Markup placed inside them does not render; they orchestrate their child primitives through a host element, shadow DOM and three render modes. **The dialog composer *is* a container.** In a primitives build, compose the dialog's parts directly inside your own element rather than wrapping them in the dialog root.
- **The dropdown content panel is not a children target** — its view is created and destroyed on each open/close, so a customer-owned node there would be torn down. Individual content **items** do accept children.
- **Children only apply to a tag you write.** To restyle something inside a subtree Velt renders for you, a wireframe remains the tool.

---

## R2 — Context inheritance

### Inheritable attributes

| Feature | Flows down |
|---|---|
| Comment dialog | `annotation-id`, `comment-id`, `comment-index`, `attachment-id`, `recording-id`, plus your own kebab-case attributes |
| Notifications — list item | `notification-index` |
| Notifications — All tab | `date` |
| Notifications — People tab | `email`, `user-id` |
| Notifications — Documents tab | `document-id` |

**Never inherited** (so a parent's identity can't leak onto a child): `class`, `style`, `id`, `role`, `tabindex`, `title`, `slot`, `hidden`, and anything matching `aria-*`, `data-*`, `ng-*`.

### Rules

- **Own attribute beats inherited** — explicit input > own attribute > nearest ancestor.
- **Resolution walks the DOM**, crossing custom-element boundaries that framework context cannot.
- **Re-resolved on placement** when a moved child lands, so nesting resolves without a wrong-context flash.

### Documented absence

**Publishing is universal; consumption is not.** Every primitive publishes context, but deep consumption is verified for the comment dialog and notifications. Elsewhere an inherited value may be silently ignored — anchor it, but do not assume it resolves.

---

## R3 — State reads

### The published getters — exhaustive

| Surface | Getter | Element | Argument |
|---|---|---|---|
| Comment dialog | `getCommentDialogConfig` | comment element | `{ annotationId }` |
| Notifications panel | `getNotificationsPanelConfig` | notification element | none |
| Comment sidebar | `getCommentSidebarConfig` | comment element | none |
| Inline comments section | `getInlineCommentsSectionConfig` | comment element | none |
| Multi-thread dialog | `getMultiThreadDialogConfig` | comment element | none |
| Activity log | `getActivityLogConfig` | activity log element | none |

**`useCommentDialogConfig` is the only published React hook.** Every other surface goes through the element method plus `useEffect` / `subscribe` / `unsubscribe`.

### Return shape

Four buckets — `data` (the entity and its collection), `appState` (current user, admin flag), `featureState` (capability flags, option lists), `uiState` (dark mode, expansion, selection, variant).

### Documented absences

- **No getter exists for the other seven families.** Do not infer a name from the pattern above — an unpublished getter is `undefined` at runtime.
- **The returned object is experimental and unstable.** It carries internal references and transient flags and is refactored across releases. Read the fields you need into your own variables; never treat the shape as stable, spread it into props, or persist it.
- **Read-only.** State changes go through the existing action APIs.
- **`data-velt-*` state attributes do not exist.** They are designed but not built — a stylesheet keyed to one silently never matches. To style on state, key off a documented stateful class ([`css-classes.md`](./css-classes.md)) or drive it from an R3 read.

---

## Zero-wireframe reachability — the limit that decides the approach

A primitive accepting children does not mean a primitive **exists** wherever a wireframe slot can reach. Measured against the SDK's slot registries: **392 of 770 wireframe slot positions have no primitive counterpart.**

| Feature area | Slots with no primitive | Consequence |
|---|---:|---|
| Recorder | 175 | no primitive layer at all |
| V1 comment surfaces | 168 | never got a V2 primitive layer |
| Reactions | 14 | no primitive layer |
| Cursor | 10 | no primitive layer |
| Presence | 10 | no primitive layer |
| Live state sync | 9 | no primitive layer |
| Core | 6 | no primitive layer |

**So a primitives-only build is achievable for the 13 V2 families and impossible for those areas** — a wireframe stays mandatory there. Decide this before planning, not during the build.

---

## Composition hazards

Behaviours that produce a **correct-looking, wrong-behaving** result — none of which a visual comparison can catch.

| Hazard | Symptom | Rule |
|---|---|---|
| **Dead compound trigger** | A status/priority chip renders perfectly and does nothing. | Place the `-trigger`; its leaves alone carry no handler. |
| **Parent-owned condition** | A hand-placed primitive renders when the built-in surface would have hidden it. | 78 primitives carry a visibility condition they cannot evaluate standalone. Re-express it in your own code or accept the divergence. |
| **Inherited `shadowDom`** | Class-based CSS silently stops applying while CSS variables still work — reads as "some CSS is randomly ignored". | Hand-placed primitives **inherit** flags they previously defaulted. Resolve the effective value before choosing a CSS strategy. |
| **Virtualization divergence** | A hand-composed list renders every row where the built-in shows a window of them. | Expected, not a defect. Own virtualization if the design needs it. |
| **Unverified mutating actions** | Unknown. | Delete thread, mark-all-read/resolved, make private, assign, unsubscribe, accept/reject suggestion, edit, attachments and recordings were not exercised hand-composed upstream. Build them; report them as unverified. |

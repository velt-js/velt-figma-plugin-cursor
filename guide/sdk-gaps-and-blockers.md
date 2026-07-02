# When you're blocked — fixable problem or real SDK gap?

R0 is the prime directive: **never hack.** But "don't hack" only helps if you can tell the difference between a problem you should *fix* and a design goal the SDK genuinely **can't** express cleanly. This page is that decision flow — how to rule out the fixable causes first, and, when a goal really has no clean supported path, how to record it honestly instead of faking it.

> **The choice, every time:** a **clean partial** (ship what's supported + a clear comment + a gap entry) beats a **complete hack** (looks right today, breaks on the next render or SDK update, and misleads the next person). When in doubt, choose the honest gap. (R0.)

This complements [`debugging.md`](./debugging.md) — that page fixes problems; this page decides whether a problem is even fixable, and what to do when it isn't.

---

## The flow — run it in order, stop at the first "yes"

Before you ever conclude "the SDK can't do this," eliminate the fixable causes. Most "blockers" are one of these.

### 1. Is it a styling problem that has a supported fix?

- **CSS does nothing?** Shadow DOM is on → set `shadowDom={false}` or `client.injectCustomCss(...)` (R6). Specificity? → add `!important` (R9b). Wrong class? → inspect and use the real `velt-*` class. → **Fixable. Not a gap.**
- **Default styling bleeds through a wireframe?** Expected — inspect → override the `velt-*` class with `!important` (R9b). → **Fixable.**

(Full symptom list: [`debugging.md`](./debugging.md).)

### 2. Is it the wrong layer?

Re‑run the [decision tree](./02-decision-tree.md) for this piece. The most common escalations:

- Need your **own interactive component / UI library** inside the surface, or a wireframe slot's `onClick`/state is being stripped (R4)? → **Primitives**, not wireframes.
- Need to **force show/hide** a piece on *your* logic? → a **primitive** with `defaultCondition={false}` (wireframes have no equivalent).
- Need to restructure a **leaf** piece deeper than its slot allows? → use **that leaf's wireframe** (mix).

If a richer (or different) layer expresses the design cleanly, **switch layers** and record the escalation. → **Not a gap** — this is the decision tree working as intended.

### 3. Is the piece just hidden by default?

If the design shows something Velt doesn't render by default (reply avatars, priority, minimap, `@here`, device badge, comment index/pin number, sidebar‑button‑on‑dialog, …), it's almost certainly an **off‑by‑default feature** — enable it with its prop/method ([`reference/feature-flags.md`](./reference/feature-flags.md)). Enabling a documented feature is **not a hack**. → **Not a gap.**

### 4. Is it custom data, not custom UI?

If the design shows custom **statuses / priorities / categories / reactions** or app‑specific values, that's a data config (`customStatus` / `customPriority` / `customCategory` / `customReactions`, or [context](./context.md)), not a structural limit ([`reference/component-config.md`](./reference/component-config.md)). → **Not a gap.**

### 5. Is the design asking Velt to change *behavior or data*, not presentation?

Velt owns behavior, data, and real‑time sync; you own presentation. If the design implies a different *behavior* (a new action, a different data model, a workflow Velt doesn't run), that's **out of scope** — not a styling gap. Don't fake the behavior. Note it as out‑of‑scope (or a feature request), distinct from an SDK *customization* gap.

### 6. Still no clean path? → it's a real SDK gap. Stop.

If none of 1–5 apply — no supported style fix, no layer that expresses it, not a flag, not custom data, genuinely presentation — then the goal has **no clean supported path today.** Do **not** reach for a DOM/timing hack to force it (R0). Record it (below), ship the best clean partial, and move on.

---

## Recording a real gap

Two artifacts, always both.

### 1. A code comment, in place

Leave the blocker visible exactly where the work would have gone — never bury it (R0):

```tsx
// BLOCKER: design wants <X> on this surface, but no slot/prop/variable/hook supports it
// (verified against reference/). Can't be done cleanly today.
// Shipped <closest clean alternative> instead of hacking Velt's internals. Revisit if the SDK adds support.
```

### 2. A gap entry (for the report handed back to Velt)

Capture the same structured fields every time, so the gaps aggregate into one actionable list:

| Field | What goes here |
|---|---|
| **Surface** | The Velt surface (e.g. `VeltCommentDialog`). |
| **Requirement** | What the design needed, concretely. |
| **Why no clean path** | The specific limitation hit, with the rule/reference that confirms it (e.g. "no wireframe slot hosts live inputs; live React in a wireframe is stripped — R4"). |
| **Attempted layer(s)** | What you tried before concluding it's a gap (css / wireframe / primitive / headless). |
| **Closest clean alternative** | What you actually shipped instead (so the surface isn't broken). |
| **Suggested SDK addition** | The smallest capability that *would* make it possible cleanly (e.g. "a dialog side‑panel slot that accepts host‑rendered content"). |
| **Guide ref** | The page that documents the limit ([`edge-cases-and-limitations.md`](./edge-cases-and-limitations.md), the relevant reference page). |

> This is the single most valuable output of a hard customization: an honest, specific map of where the SDK's customization surface ends. It's worth more than a fragile hack that hides the same gap.

---

## What is *not* a gap (quick reference)

Don't record these as SDK gaps — they have supported answers above:

- "My CSS won't apply." → shadow DOM / specificity / wrong class (§1).
- "My `onClick` in the wireframe does nothing." → expected (R4); use a slot or escalate to a primitive (§2).
- "This feature isn't showing." → off‑by‑default flag (§3).
- "I need custom statuses/reactions." → custom data config (§4).
- "I can't reorder/remove parts with CSS." → that's why wireframes exist — escalate (§2).
- "A leaf primitive won't restructure." → use that leaf's wireframe (§2).

A real gap is specifically: **a presentation goal with no clean supported path across any layer** — confirmed by walking §1–§5 first.

---

## See also

- [`rules.md`](./rules.md) — R0 (the prime directive) and the full rule set.
- [`debugging.md`](./debugging.md) — fix the fixable: symptom → cause → fix.
- [`02-decision-tree.md`](./02-decision-tree.md) — re‑pick the layer when you've outgrown the current one.
- [`edge-cases-and-limitations.md`](./edge-cases-and-limitations.md) — what each layer cannot do (the source of most real gaps).
- [`verifying-a-customization.md`](./verifying-a-customization.md) — the verdict flow that routes an unmet goal here.

# Debugging — when you're blocked

A fast, ordered playbook for the things that actually go wrong. Find your symptom, apply the fix. (Many of these are also in [`edge-cases-and-limitations.md`](./edge-cases-and-limitations.md); this page is the action‑first version.)

---

## First, always

1. **Turn on debug logs.** Set `forceDebugMode` in `sessionStorage` (`sessionStorage.setItem('forceDebugMode','true')`) and reload — Velt logs verbosely.
2. **Confirm Velt is initialized.** Gate on `useVeltInitState()`. If it's never `true`, fix setup (API key, `identify`, `setDocuments`) before debugging UI — you can't style what isn't rendering.
3. **Compare against default.** Temporarily remove your customization. If the default works and yours doesn't, it's your customization; if the default is also broken, it's setup/data.
4. **Inspect the element.** With `shadowDom={false}`, open DevTools on the element — read its real `velt-*` classes/attributes and where it sits in the DOM.

---

## Symptom → cause → fix

### "My CSS does nothing"
- **Shadow DOM is on.** Variables cross it, but class/selector CSS doesn't → either set `shadowDom={false}`, or keep it on and push your CSS into the shadow root with `client.injectCustomCss({ type:'styles', value:'…' })` (R6).
- **Specificity.** Velt injects high‑specificity styles → add `!important` (R9b). Inspect → target the `velt-*` class → `!important`.
- **Wrong class.** You guessed a class name → inspect and use the actual `velt-*` class ([`reference/css-classes.md`](./reference/css-classes.md)).

### "My wireframe renders nothing"
- **Feature component not mounted.** A `Velt…Wireframe` only registers a template — you must also mount the live feature (`VeltComments` / `VeltCommentsSidebar` / `VeltCommentDialog`). (R2)
- **Two `<VeltWireframe>` roots.** Merge is first‑with‑content‑wins → your template may be ignored. Use one (R1).
- **Wrong slot name.** Verify against [`reference/wireframe-components.md`](./reference/wireframe-components.md).
- **List/repeater slot.** Custom layout around a list slot is ignored — customize the **item** wireframe instead ([`approaches/wireframes.md`](./approaches/wireframes.md) §7b).

### "My wireframe markup shows up inline on the page (not inside the Velt component), and the component still uses defaults"
- **No `<VeltWireframe>` registry root wrapping your slot templates.** Verified in‑browser: a slot element placed directly in the page (without the `<VeltWireframe>` root) renders its children **inline where it sits** and the live component falls back to its **default** UI — because the template was never registered. Wrap all slot templates in exactly one `<VeltWireframe>` root (in plain HTML: one `<velt-wireframe>`). (R1)

### "My wireframe's empty state (or one piece) works, but the header/search/list vanished"
- **You declared a container/root slot and omitted its structural children.** Verified in‑browser: declaring `velt-comments-sidebar-v2-wireframe` with *only* a custom empty‑placeholder rendered the empty state but **dropped the search/filter/list**. Container slots replace their layout — re‑declare every structural child you want (`panel → header(search,filter) → list → empty‑placeholder`). Leaf slots fall back to default; containers do not ([`approaches/wireframes.md`](./approaches/wireframes.md) §4).

### "My wireframe applies in the wrong places (or not where I want)"
- **Scoping.** Nested child wireframe = scoped to that parent's render; root‑level child = global. Move it accordingly ([`approaches/wireframes.md`](./approaches/wireframes.md) §3b).
- **First‑with‑content‑wins.** If the same component is registered both nested and at root, the first one with content wins — don't register it both ways.

### "A button/onClick/hook inside my wireframe does nothing"
- **Expected** — wireframe markup is cloned; React interactivity is stripped (R4). Use the Velt **slot** for built‑in actions, or `VeltButtonWireframe` + `useVeltEventCallback('veltButtonClick')` for custom actions ([`patterns-and-tips.md`](./patterns-and-tips.md)). For real interactive components, use [primitives](./approaches/primitives.md).

### "Send/Cancel (or any button) 'shifts down' and the click misses / never fires"
- **A layout/visibility rule is keyed on a TRANSIENT state that drops at click time** (R27). The classic: the "Reply" link is hidden via `:focus`/`.velt-composer-input-focused`; the input loses focus the instant the pointer moves to the button → the link re‑appears → everything below shoves down → the button moves out from under the cursor. The button works fine; it just **isn't where you clicked**. **Fix:** re‑anchor the rule on a **stable** state that holds through the whole interaction — `.velt-comment-dialog--selected` (card open) or `.velt-composer-open` (composing) — never focus/hover/active. **Prove it:** measure the button's box, blur the input (what the click does), re‑measure → 0px shift (`STABILITY_PROBE` in `delta-compare.mjs`), then type a reply and real‑click Send and confirm it posts. *(One nearby card "working once" is not proof — reproduce the exact reported interaction. This false‑passed once.)*

### "Mystery empty space below a card (or any flex column)"
- **A flex `gap` reserves space for a child that's 0px tall but still present** (R27) — an empty/collapsed reply composer or more‑reply host. `gap` can't tell "invisible" from "absent", so the gap below the content stays. **Fix:** set `gap:0` and put the spacing as `margin-top` on the child that should be spaced — a margin only takes effect when its element actually has height, so the space appears only when the child is shown. **Measure** body‑bottom→card‑bottom in the collapsed state = 0 extra px (don't eyeball; the culprit is invisible).

### "`velt-data` shows blank / `velt-if` never matches"
- **Directive on a plain HTML element (R28).** A `velt-if`/`velt-class` attribute on a native `<div>`/`<span>` — including helper spreads like `{...veltIf("…")}` — **silently never fires**: directives resolve only on Velt wireframe elements. Wrap the HTML in `<VeltIf condition="{…}">` instead; for class toggling, put `velt-class` on a Velt element or key CSS off Velt's own state classes.
- **Wrong/undefined variable.** Names are case‑sensitive and finite — check [`reference/wireframe-variables.md`](./reference/wireframe-variables.md). A wrong name → `undefined`.
- **Wrong context.** Some variables exist only in certain slots (`{comment}`/`{commentIndex}` only inside a thread card; `{notification}` only in the notifications panel; `{focusedAnnotation}` only in the sidebar).
- **Nested access not supported.** Only the roots in the nested‑access list allow `{root.nested}`; others resolve to root only.
- **Flat‑config feature.** Try the explicit `{componentConfig.<name>}` form (cursor/presence/huddle/recording/reactions/area/arrow/tag/autocomplete).

### "My sidebar/list won't scroll, or overflows / won't take the available height"
- **Broken flex/height chain — including Velt's internal elements.** Every element from your wrapper down to the scroll container needs `min-height:0` (plus `flex:1` / `height:100%`) — *including Velt's own internal containers* (e.g. `app-comment-sidebar-panel`) that sit between your layout and the list. **Inspect** to find the hidden link and force it (often with `!important`). One missing link kills the scroll. (R14; full recipe in [`patterns-and-tips.md`](./patterns-and-tips.md).) Re‑test that scrolling actually works — it's easy to get 90% right and still have a dead scroll.

### "Default styling is still there even though I wireframed it"
- **Expected** — a wireframe replaces a slot's *content*, not all the surrounding default styling (borders, padding, backgrounds, fixed widths, popover chrome). **Inspect → find the `velt-*` class → override with `!important`** (R9b). Treat this as part of every wireframe pass.

### "My dialog/pin/primitive renders in the wrong place (top‑left, escaping its box)"
- **Absolute positioning needs a positioned ancestor.** Some Velt pieces use `position: absolute`. Give the parent you mount them in `position: relative` so they anchor correctly. (Recipe in [`patterns-and-tips.md`](./patterns-and-tips.md).)

### "Dark mode colors are wrong"
- **Hard‑coded colors.** Move dark values under `:root[data-velt-theme="dark"]` using `--velt-dark-mode-*` (R9).

### "A primitive layout won't compose / a child won't restructure"
- **Leaf component.** Leaf primitives have no sub‑components → restructure via that leaf's **wireframe** instead ([`approaches/primitives.md`](./approaches/primitives.md)).
- **You forgot the composition.** Primitives don't auto‑loop — fetch the data, `.map()`, pass `annotationId`/`comment` yourself.

### "Headless mutation does nothing / errors"
- **Object shape.** Hand‑built `Comment`/`CommentAnnotation` is missing required fields → fill every field the action needs (R13); read the type in `@veltdev/types`.
- **Wrong hook usage.** Most hooks return an object: `const { addComment } = useAddComment()`. Read‑hook returns are often wrappers (e.g. `…Count` → `{ count }`) — read the field ([`reference/hooks.md`](./reference/hooks.md)).

### "SSR / hydration error (Next.js)"
- Mark customization + hook components `'use client'`; gate on `useVeltInitState()`; don't expect Velt UI during SSR.

---

## When you're still stuck

- **Re‑check the reference pages:** [`reference/wireframe-components.md`](./reference/wireframe-components.md) (slots/props), [`reference/wireframe-variables.md`](./reference/wireframe-variables.md) (tokens), [`reference/css-classes.md`](./reference/css-classes.md) (stateful classes), [`reference/component-config.md`](./reference/component-config.md) (props).
- **Inspect the running UI** in DevTools (`shadowDom={false}`) to see the real elements, classes, and structure Velt rendered.
- **Isolate** — reproduce the one surface in a minimal setup with default everything, then add your customization back piece by piece.
- **Still nothing fixes it?** Decide whether it's even fixable: [`sdk-gaps-and-blockers.md`](./sdk-gaps-and-blockers.md) rules out the fixable causes and, if none apply, shows how to record a real SDK gap honestly rather than hacking around it (R0).

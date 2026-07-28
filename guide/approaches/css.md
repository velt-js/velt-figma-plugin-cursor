# Approach · CSS

**What it is:** change Velt's look — colors, spacing, fonts, radius, shadows — without touching its structure or behavior. The lowest‑effort, most upgrade‑safe layer.

**Use it when:** your design is Velt's default UI in different colors/spacing/typography. (Decision tree Q1.)

**Don't use it when:** you need to reorder/add/remove parts or change layout — that's [wireframes](./wireframes.md). And don't use `display:none` to hide features — toggle them with a prop on the [primitive](./primitives.md) instead.

---

## The model

Velt exposes a large set of **CSS custom properties** (variables), all prefixed `--velt-…`. You override them in your own stylesheet. Velt reads them at render time, so your values flow through its whole UI — including (for variables) inside the shadow DOM.

There are two families:

- **Modern tokens** — `--velt-light-mode-*`, `--velt-dark-mode-*`, `--velt-spacing-*`, `--velt-border-radius-*`, `--velt-font-size-*`, plus z‑index tokens. Use these.
- **Legacy tokens** — `--legacy-velt-*` (older components still read some of these). Only touch them if a specific older surface needs it.

Full list: [`reference/css-variables.md`](../reference/css-variables.md).

## Steps

### Step 1 — Make sure your selector CSS can reach Velt

CSS **variables** cross the shadow boundary (so **Step 2 variable theming works no matter what**), but **class/element selectors** do not reach inside a shadow DOM. If you'll use any selector‑based CSS (Step 5) or styled wireframes, pick **one** of these two supported approaches:

**Option A — turn shadow DOM off** (simplest; your normal stylesheet then reaches the elements):
```tsx
<VeltComments shadowDom={false} />
<VeltCommentsSidebar shadowDom={false} />
```

**Option B — keep shadow DOM on, and inject your CSS into the shadow root** with the client's `injectCustomCss` API. Use this when you want to keep Velt's style isolation (so Velt's CSS can't leak into your app and vice‑versa) but still style inside it:
```tsx
const { client } = useVeltClient();
client.injectCustomCss({ type: "styles", value: `
  .velt-comment-dialog-composer { border-radius: 10px !important; }
` });
// or load an external stylesheet into the shadow root:
client.injectCustomCss({ type: "link", value: "https://yourcdn.com/velt-overrides.css" });
```
`injectCustomCss` pushes your CSS **into Velt's shadow root**, so selectors match there. `type: "styles"` = a raw CSS string; `type: "link"` = a stylesheet URL.

Pick A *or* B per project — don't do both for the same surface. (See [`03-getting-started.md`](../03-getting-started.md) §2.)

#### The BASE: unstyled, always (`client.setUnstyledMode`)

**Run policy (fixed): every customization run works STRICTLY on the unstyled base — there is no styled-vs-unstyled decision step.** Recent SDKs can strip **all of Velt's cosmetic styling at once** while keeping a derived *functional-only* layer (layout, positioning, show/hide behavior) — an **unstyled base** to build your own look on, instead of overriding the default look rule-by-rule. The structure build wires this as a standard host change. **Verified against the SDK types** (`setUnstyledMode` on the client, v6+):

```tsx
// client API — call once when the client is ready:
const { client } = useVeltClient();
useEffect(() => {
  if (client) client.setUnstyledMode(true, { keepFunctionalStyles: true });
}, [client]);
// keepFunctionalStyles defaults to true; pass false for TOTAL removal (rarely what you want).
// Fully reversible: setUnstyledMode(false) restores the styled default.
```

- **Scope: client-level.** One base per app/run — it cannot vary per surface. It applies to **every Velt component family alike**: wireframes and primitives are BOTH styled by default, and this API is the only unstyled switch for either.
- **Why the unstyled base:** you write greenfield CSS from the design's exact values instead of fighting defaults with `!important` (fewer specificity battles; the override churn of Step 5 mostly disappears, and design values can never compound with un-audited default cosmetics).
- **The obligation it creates:** there is no default-cosmetics safety net. Every state the design doesn't draw (hover, loading, empty, menus, focus) and every default sub-element inside a drawn surface renders functionally but RAW until styled. The undrawn-states + undrawn-sub-elements lists (S9's mandatory output) are styling WORK, not optional polish.
- **Keep `keepFunctionalStyles: true`** — it preserves Velt's layout/positioning/visibility mechanics so wireframes + your CSS only own the cosmetics. `false` removes even those (true headless rendering; rarely what you want). Note the functional layer still carries some layout offsets — the dom-snapshot `defaultSpacing` audit covers them.
- **Related but different:** `config: { globalStyles: false }` ([`reference/feature-flags.md`](../reference/feature-flags.md)) only skips loading Velt's global stylesheet at init — it does not strip component-level cosmetics and keeps no functional layer distinction. `setUnstyledMode` is the right tool.
- You still handle shadow-DOM reachability (Step 1) for your own selectors, and variable theming (Step 2) still applies.
- **Verify at run start:** capture the app's baseline WITH unstyled mode applied (the "default UI" to compare against is the unstyled base, never Velt's styled default).

#### Shadow DOM & wireframes (root vs nested)

**Verified in‑browser.** When you customize with **wireframes**, whether you still need `shadowDom={false}` depends on *which* wireframe you registered:

- **You registered the component's ROOT wireframe** (e.g. `VeltCommentDialogWireframe` / `velt-comment-dialog-wireframe`): Velt **auto‑removes that component's own shadow DOM**, so it renders in **light DOM** and your normal class CSS reaches it — **no `shadowDom={false}` needed** for that component.
- **You registered only a NESTED / leaf wireframe** (e.g. just the `ThreadCard`, with no root dialog wireframe): shadow DOM is **NOT** auto‑removed. Your layout markup applies, but **class CSS won't reach inside** — so the look may change without your styles landing. For this case you **must** set `shadowDom={false}` (or the per‑surface flag / `injectCustomCss`) explicitly.
- **Either way, inline `style=""`** on your wireframe markup always works (it survives the clone and lives in whatever DOM the slot renders into).
- **Nesting caveat:** a root‑wireframed component that renders *inside another* shadow‑DOM component (e.g. the dialog shown inside the sidebar with the sidebar's default shadow on) still sits in **that outer** component's shadow root — turn the outer component's shadow off too if you need class CSS there.

> Rule of thumb: **root wireframe → class CSS works (shadow auto‑off); leaf‑only wireframe → set `shadowDom={false}` yourself; inline styles always work.**

### Step 2 — Override variables at `:root`

Put all Velt CSS in one stylesheet. Override the tokens you care about:

```css
/* velt.css — loaded once */
:root {
  /* Brand accent used across comment UI (buttons, active states, links) */
  --velt-light-mode-accent: #FF6B35;
  --velt-light-mode-accent-hover: #E55A29;

  /* Surfaces & text */
  --velt-light-mode-background-0: #FFFFFF;   /* primary surface */
  --velt-light-mode-text-0: #0A0A0A;         /* primary text */

  /* Shape & rhythm */
  --velt-border-radius-md: 10px;
  --velt-spacing-md: 14px;
  --velt-font-size-sm: 13px;          /* overriding the 14px default */
}
```

These names are real and exhaustive — see [`reference/css-variables.md`](../reference/css-variables.md). **Never invent a token name.**

### Step 3 — Support dark mode

Velt switches modes via the `data-velt-theme="dark"` attribute on the document root. Override the dark tokens under that selector:

```css
:root[data-velt-theme="dark"] {
  --velt-dark-mode-accent: #FF8A5C;
  --velt-dark-mode-background-0: #0F0F0F;
  --velt-dark-mode-text-0: #FFFFFF;
}
```

You supply the dark values; Velt sets the `data-velt-theme="dark"` attribute when dark mode is on. **To toggle dark mode**, use any of:
- the **`darkMode` prop** on a component: `<VeltComments darkMode={isDark} />` (also `dialogDarkMode`, `pinDarkMode`, … for finer control);
- the **client API**: `const { client } = useVeltClient(); client.setDarkMode(true)` (app‑wide);
- **follow the OS preference** — wire your own `prefers-color-scheme` media query to `setDarkMode`.

So: **you decide *when* dark mode is on (prop / `setDarkMode` / OS), and you supply the dark token *values* under `[data-velt-theme="dark"]`.**

### Step 4 — Change the default font

Velt reads one global font token, `--velt-default-font-family` (default `sans-serif`). Override it at `:root` and every Velt surface picks it up — no per‑component work:

```css
:root {
  --velt-default-font-family: "Inter", "Helvetica Neue", Arial, sans-serif;
}
```

(There are no global line‑height or font‑weight tokens — those are per‑component. The `--velt-font-size-*` scale can be overridden the same way.)

### Step 5 — Override specific elements by class (always with `!important`)

For anything variables don't cover, target Velt's classes directly. **Velt injects its own styles at runtime with high specificity, so your overrides must use `!important` to win.** Treat this as the rule for class‑based Velt CSS, not a hack.

**The workflow (do this for any element you want to restyle):**

1. Run the app with `shadowDom={false}` and **inspect the element** in DevTools.
2. Read the classes on it — Velt applies dual names: a short legacy class (e.g. `selected`) and a BEM `velt-*` class (e.g. `velt-comment-dialog--selected`). **Prefer the `velt-*` class.**
3. Write a rule for that class, ending each declaration with `!important`:

```css
/* identified by inspecting the composer's send button */
.velt-composer--submit-button {
  background: #3d5afe !important;
  border-radius: 6px !important;
  color: #fff !important;
}
```

> See [`reference/css-classes.md`](../reference/css-classes.md) for the catalog of structural and **stateful** classes (unread, resolved, selected, has‑reactions, hover, filter‑applied, …) you can target. Class names are an implementation detail and can shift between versions — prefer `--velt-*` variables where one exists; use `!important` class overrides for the rest, and re‑check them on upgrade.

## What it can and can't do

| ✅ CSS can | ❌ CSS cannot |
|---|---|
| Recolor everything (light + dark) | Reorder or restructure the UI |
| Change spacing, radius, fonts, shadows | Add/remove UI parts (use a prop or wireframe) |
| Theme to match a brand | Insert your own markup between Velt's pieces |
| Adjust z‑index layering | Change behavior |

If you're writing `display:none` to remove parts, or wishing you could move a button, you've hit CSS's ceiling — escalate to [wireframes](./wireframes.md) (restructure) or [primitives](./primitives.md) (toggle features / compose).

## Checklist

- [ ] `shadowDom={false}` on customized components.
- [ ] All Velt CSS in **one** stylesheet.
- [ ] Only `--velt-*` / `--legacy-velt-*` names that exist in [`reference/css-variables.md`](../reference/css-variables.md).
- [ ] Dark values under `:root[data-velt-theme="dark"]`.
- [ ] No `display:none` hacks to remove features (toggle with a prop instead).

# Deterministic extraction — read the numbers, don't eyeball them

The fidelity-critical inputs (spacing, padding, sizing, radius, typography, colours, **and the design's own icon SVGs**) are a **data-extraction problem, not a judgment one**. Never approximate them from a screenshot. Produce a `designSpec` first (via `scripts/figma-extract.mjs`), then the Builder applies those EXACT numbers and the Judge asserts against them.

## Producing the `designSpec`

- **REST path (the only path — fully deterministic).** With a Figma token resolved (see token handling below), `node scripts/figma-extract.mjs rest <fileKey> <nodeId> --out <dir> --svg` fetches the node JSON from `api.figma.com` and emits `designSpec.json` + exported icon SVGs under `assets/`. The recognition images come from `enumerate-blocks.mjs rest …` (per-frame PNGs via the Figma image API). **There is no Figma MCP path** — the plugin does not read the design from the Figma desktop app; a token is required.

Each `designSpec` node carries `cssDecls` — CSS‑ready, exact declarations — a `box` (`x/y/w/h`), and a **`frameId`** (the top‑level block‑frame it belongs to). The Builder applies the `cssDecls` to the real classes from [`reference/manifest.md`](./reference/manifest.md); the Judge diffs rendered computed styles **and** layout boxes against them. **Boxes are emitted `frame-relative`** (`boxSpace: "frame-relative"`) — `figma-extract` subtracts **each frame's own origin** from its subtree, so `box.x/y` are relative to that frame's top‑left and directly comparable to both the probe's `getBoundingClientRect − surface-root` measurement and the per‑block frame PNG.
- **Why per‑frame (not one root origin):** a multi‑state design is one **section** of many frames laid out across the canvas (e.g. node `1:3398` = 16 sidebar frames), and each frame is exported as its own PNG at `0,0`. Subtracting a single section origin left every node ~1500px off, so `visual-diff --mask-text-from` mislocated every mask and the visual gate went blind (passing wrong icons / structure / spacing as "matched"). Per‑frame normalization fixes that. The spec also lists `frames: [{id,name,type}]`.
- **Per‑block consumption:** when you extract a section once and diff one block, pass the block's frame id so only that block's (already frame‑relative) nodes are used: `visual-diff … --mask-text-from <designSpec.json> --mask-frame <block.figmaNodeId>`. Omit `--mask-frame` only when the spec is a single‑frame extraction.

## The mapping rules (auto‑layout → CSS, from FigmaToCode)

- `layoutMode` `HORIZONTAL`/`VERTICAL` → `display:flex` + `flex-direction:row|column`.
- `primaryAxisAlignItems` → `justify-content` (`MIN`→flex-start, `CENTER`→center, `MAX`→flex-end, `SPACE_BETWEEN`→space-between).
- `counterAxisAlignItems` → `align-items` (`MIN`/`CENTER`/`MAX`/`BASELINE`).
- `itemSpacing` → `gap` — **suppressed when `SPACE_BETWEEN`** (the browser distributes the space; an explicit gap would be wrong).
- `paddingT/R/B/L` → `padding`, collapsed to the concise form (`14px 16px`).
- **Sizing is axis‑dependent — the rule most converters get wrong (and we did):** for a child of an auto‑layout parent, `FILL` on the parent's **primary** axis → `flex:1 1 0`; `FILL` on the **counter** axis → `align-self:stretch`; `HUG` → emit nothing (content‑driven); `FIXED` → literal `px`. Getting this wrong is what squeezed the dialog.
- `cornerRadius` → `border-radius`; `strokes`+`strokeWeight` → `border`; first solid `fills` → `background` (or `color` on a `TEXT` node); `style` → `font-family/size/weight/line-height/letter-spacing`.

## Icons — export the design's real SVGs (R17) + assign them to slots

`figma-extract` flags **likely‑icon** nodes (vectors, or small ≤64px vector‑only subtrees), exports each as an SVG (id‑suffixed filename so generic names like "Icon"/"Vector" don't collide), and **assigns each to a slot** using the manifest's `iconHint`, in **confidence layers** (stop at the first that matches; never guess):

1. **`nearText` (reliable):** the icon's adjacent label — a menu row is `[icon, "Edit"]`, the reply affordance is `[icon, "Reply"]`. Auto‑assign (de‑duped: one SVG → one slot). Output: `designSpec.iconAssignments[reactPath] = { file, by, glyph }`.
2. **name / component‑signal (S3):** an icon‑only control is frequently a **named Figma icon component** (an `iconButton`/`Icon` instance) or a node named for its glyph (`filterIcon`, `more`, `checkCircle`). The resolver matches the slot's `glyph` (+ synonyms — `filter-lines`→filter/funnel, `kebab`→more/ellipsis/dots, `check-circle`→check/resolve/tick, …) against the icon's own name + ancestry, preferring a single name hit or a single named component. **This is the layer that fixes the M2a filter + kebab misses** (named components with no adjacent label).
3. **`ancestryKeyword` (weak):** only accepted when it resolves to **exactly one** free icon; a broad keyword (e.g. "comment") matches many → left unassigned, never guessed.
4. **`unassignedIcons` → render‑and‑recognize:** anything still unmatched is reported here with `{ slot, hint:{glyph}, renderRecognize:true, candidates:[{file,name,isComponent,box}] }` — a **shortlist of the free exported SVGs** (name‑hits first, else the icon components). The Builder/Planner **rasterizes each candidate SVG and identifies the glyph by vision** (open the `assets/*.svg` in the browser / view it), then wires the one matching the `glyph` into the slot. Explicit recognition — never a Velt default, never hand‑drawn, never a blind guess.

**Distinct slots need distinct glyphs — never reuse one icon for another slot.** In particular **resolve ≠ unresolve**: the `ResolveButton` is a **check‑circle**; the **`UnresolveButton`** is a **counter‑clockwise reopen/undo arrow** (synonyms: reopen / undo / restore / rotate‑ccw / refresh) and it appears **only in the resolved‑state frame** as an icon‑only control. Resolve it via render‑and‑recognize like any icon‑only control (layers 2–4); do **NOT** fill `UnresolveButton` with the resolve check — that conflation is a recurring miss. Same rule for any visually‑similar pair (filter vs sort, edit vs copy): a `mustSupply` slot gets the glyph for *that* slot, never the nearest already‑resolved one.

**Wire the assigned + recognized SVGs into the `mustSupply` icon slots** as a small `icons/` file of React SVG components. Never leave a Velt default icon and never hand‑draw one.

## Token handling (secure — see the plan's §G)

The REST path needs a Figma personal‑access token; it is **required** (no token → preflight HALTs — there is no MCP fallback). Resolution: `FIGMA_TOKEN` env var first, then the OS secure store — **never the target repo's `.env`**.
- `node scripts/figma-extract.mjs token status` → presence, masked.
- `node scripts/figma-extract.mjs token set` → reads the token from **STDIN** (never argv/history) into the OS keychain. The most secure path is the user storing it themselves (`security add-generic-password -U -s velt-customize -a figma-token -w`).
- `node scripts/figma-extract.mjs token remove` → deletes it.
The token is sent only to `api.figma.com` over HTTPS, never logged in full, never written to a tracked file. A read‑only / file‑content‑scoped PAT is recommended.

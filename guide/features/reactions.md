# Feature · Reactions

Emoji reactions — the add‑reaction tool, the emoji picker panel, reaction pins (with a hover tooltip listing who reacted), and an inline reactions section. **Wireframed** + custom emoji sets.

## Components

| | Primitive | Wireframe |
|---|---|---|
| Add‑reaction tool | `VeltReactionTool` | `VeltReactionToolWireframe` (leaf — picker opens as a separate panel) |
| Emoji picker | — | `VeltReactionsPanelWireframe` |
| Reaction pin | *(no standalone React primitive)* | `VeltReactionPinWireframe` |
| Pin hover tooltip | — | `VeltReactionPinTooltipWireframe` |
| Inline reactions section | `VeltInlineReactionsSection` | `VeltInlineReactionsSectionWireframe` |

> There is **no `VeltReactionPin` React primitive** — customize pins only via `VeltReactionPinWireframe` / CSS. Reaction data/actions live on the **comment element**, so there's no `useReactionUtils` (see hooks).

## Config props

No general config props beyond the custom emoji set. Replace the default reactions with your own via the `customReactions` prop (`ReactionMap` = `{ [reactionId]: { url?, svg?, emoji? } }`):

```tsx
<VeltInlineReactionsSection customReactions={{ "love": { emoji: "❤️" }, "ship": { svg: "<svg…>" } }} />
// or globally:  client.getReactionElement().setCustomReactions(map)   // also commentElement.setCustomReactions
```
(Malformed `customReactions` JSON silently no‑ops.)

## Default reaction ids (valid without any `customReactions` config)

When no `customReactions` is configured, the live reaction set is Velt's built‑in emoji map. Its keys are **stable, hardcodable reaction ids** — valid anywhere a `reactionId` is accepted (`ReactionPin reactionId=`, `Reactions excludeReactionIds=`, `ReactionMap` keys):

**`THUMBS_UP`, `THUMBS_DOWN`, `HEART_FACE`, `TEARS_OF_JOY`, `EYES`, `FIRE`, `RAISED_HANDS`**

*Verified:* the official Velt sample (`sample-apps/apps/react/self-hosting/forms/page-mode-demo`) hardcodes `reactionId="THUMBS_UP"` with zero reaction config, and the same keys are confirmed as the built‑in emoji set in [`presence-reactions.md`](../reference/behaviors/presence-reactions.md) (`emojiSelected`). **You do NOT need to enumerate the live reaction set** (the picker resists programmatic opening and the ids are not in the DOM as `[data-reaction-id]`) — if the app configures no `customReactions`, use these ids directly; this is not an R10 violation, the ids above are verified SDK constants.

## Pattern — pin ONE specific reaction (the "persistent thumbs‑up" design)

A design that draws a permanent thumbs‑up affordance on every comment (even ones with zero reactions) plus a generic add‑reaction tool is built with **`ReactionPin` bound to a specific id, and that id excluded from the reactions row**:

```tsx
<VeltCommentDialogWireframe.ThreadCard.ReactionPin reactionId="THUMBS_UP" />
<VeltCommentDialogWireframe.ThreadCard.Reactions excludeReactionIds={['THUMBS_UP']} />
```

- `ReactionPin` **without** `reactionId` is a *display* of reactions already on the comment — it renders 0×0 on a comment with none (live‑verified), so it can never be the design's persistent affordance.
- `ReactionPin` **with** `reactionId` pins that one reaction as a standing affordance.
- `excludeReactionIds` on the `Reactions` row prevents the pinned reaction rendering twice (once as the pin, once in the row). Do not additionally declare the composite reactions‑row + `ReactionTool` side by side — the row already contains its own add tool (double add‑affordance).

## CSS — stateful classes

(Override with `!important`, R9b.)


- **`velt-reaction-pin--no-reactions`** — pin has **0 reactions** (the key class for "show the tool when empty vs the panel when populated").
- `active` on the pin — current user has reacted (`isReactionSelectedByCurrentUser`).
- `action-btn.active` on the tool — picker open.
- `velt-reactions-panel--default` / `.dark` — panel default / dark mode.
- Timeline variant: `s-emoji-block_timeline`, `s-emoji-block__item.active`.

## Wireframes — slot trees + tokens

```
VeltReactionsPanelWireframe → .Items → .Item → .Emoji          (per-item: {emoji.value} {emoji.name} {emoji.key}, {isSelected})
VeltReactionPinWireframe    → .Emoji  .Count
VeltReactionPinTooltipWireframe → .Users → .User → .Avatar / .Name   (per-user: {reaction.from.name/.email/.photoUrl})
VeltInlineReactionsSectionWireframe → .ToolContainer  .Panel  .List
```

Reactions are **flat‑config** — read tokens as `{componentConfig.<x>}`: pin `{componentConfig.isReactionSelectedByCurrentUser}` 🔑, `{componentConfig.tooltipVisible}` 🔑, `{componentConfig.annotation.reactions.length}`, `{componentConfig.type}` (`'comment'|'inline'|'timeline'|'standalone'`); inline section `{componentConfig.skeletonLoading}` 🔑, `{componentConfig.annotations.length}`. `type="standalone"` renders even at 0 reactions; `type="timeline"` is the compact variant.

## Headless hooks

Reactions are actions on the comment element — use:
- `useAddReaction()` → `{ addReaction }`, `useToggleReaction()` → `{ toggleReaction }`, `useDeleteReaction()` → `{ deleteReaction }`.

(No `useReactionUtils`; for custom emoji config call `setCustomReactions` on the reaction/comment element.)

## Limitations

No standalone reaction‑pin primitive (wireframe/CSS only). Two distinct emoji fields — picker items use `emoji.value`/`.key`; pins render `annotation.icon`. `shadowDom` defaults differ (inline section `true`, pin/tool `false`).

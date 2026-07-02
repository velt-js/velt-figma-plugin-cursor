# Beyond comments — all other features

The same four‑layer model (CSS · Wireframes · Primitives · Headless) and the same rules apply to **every** Velt feature, not just comments. Each feature now has a **deep guide** in [`features/`](./features) — open the one you need.

> Run the [decision tree](./02-decision-tree.md) on the feature (same four questions), then jump to its page below. The rules (R0 no‑hacks, one `<VeltWireframe>`, the interactivity rule, `shadowDom`/`injectCustomCss`) hold everywhere.

## Deep per‑feature guides

| Feature | Customization depth | Guide |
|---|---|---|
| **Notifications** | Full wireframe + rich config props (panel mode, settings layout, tabs) + hooks | [`features/notifications.md`](./features/notifications.md) |
| **Reactions** | Wireframed (tool/panel/pin/tooltip/inline) + custom emoji sets + hooks | [`features/reactions.md`](./features/reactions.md) |
| **Recorder & Transcription** | Deepest wireframe tree (control panel/player/tools/dialogs/subtitles/transcript) + hooks | [`features/recorder-and-transcription.md`](./features/recorder-and-transcription.md) |
| **@Mentions & Autocomplete** | Custom mention data (contacts/groups/custom) + option/chip wireframes | [`features/mentions-and-autocomplete.md`](./features/mentions-and-autocomplete.md) |
| **Presence & Live Cursors** | Per‑item wireframes (avatar list / cursor pointer) + hooks; flat‑config | [`features/presence-and-cursors.md`](./features/presence-and-cursors.md) |
| **Activity Log** | Full wireframe + data hooks | [`features/activity-log.md`](./features/activity-log.md) |
| **Text / Inline / Multi‑thread comments** | Comment variants — wireframed, reuse comment hooks | [`features/comment-surfaces.md`](./features/comment-surfaces.md) |
| **Tags / Arrows / Areas** | **Thin** — CSS + props (+ Tag hooks); no wireframe slots | [`features/annotations-tags-arrows-areas.md`](./features/annotations-tags-arrows-areas.md) |

## Two things to remember for non‑comment features

1. **Flat‑config variables.** Cursor, Presence, Huddle, Recording, Transcription, Reactions, Autocomplete, View, Area, Arrow, Tag read wireframe tokens as **`{componentConfig.<name>}`** (not the short aliases used by comments). See [`reference/wireframe-tokens.md`](./reference/wireframe-tokens.md).
2. **Some features are config/hooks‑only.** Tags/Arrows/Areas have no wireframe slots; Transcription/Subtitles are surfaced through the recorder player's slots; Reactions actions live on the comment element. Each feature page calls out its exact limits.

Cross‑cutting concerns (a11y, i18n, RTL, responsive, testing) apply to all of these — see [`cross-cutting.md`](./cross-cutting.md).

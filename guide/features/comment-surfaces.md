# Feature · Other comment surfaces (Text, Inline, Multi‑thread)

Three comment *variants* beyond the standard dialog/sidebar. They reuse the comment data model and hooks (so the comment hooks in [`../reference/hooks.md`](../reference/hooks.md) apply), and each is **wireframed**.

> **Looking for the standard comment surfaces?** The **dialog, sidebar (V1/V2), sidebar button, pin, bubble, and comment tool** aren't on this page — they're the running examples throughout the approach guides ([`../approaches/wireframes.md`](../approaches/wireframes.md), [`css.md`](../approaches/css.md), [`primitives.md`](../approaches/primitives.md)), and each has a one‑stop entry (primitive · root wireframe · key props · flags · variables · refs) in the **Surface lookup** map in [`reference/component-catalog.md`](../reference/component-catalog.md). Start there for any standard comment surface; this page is only the three variants below.

## Components

### Text Comment (selection‑anchored)
A toolbar that appears on text selection to comment on / rewrite the selected text.
- **Primitives:** `VeltTextComment`, `VeltTextCommentTool`, `VeltTextCommentToolbar` (sub‑accessors `.CommentAnnotation` / `.Copywriter` / `.Generic` / `.Divider`).
- **Wireframes:** `VeltTextCommentToolWireframe`; `VeltTextCommentToolbar` wireframe → `.CommentAnnotation`, `.Copywriter` (shown when AI rewriter enabled), `.Generic`, `.Divider`.

### Inline Comments Section (Substack‑style)
A comment thread anchored to a target element, with its own composer, list, filter, and sort. **Very rich** — renders comment‑dialog primitives internally (so nested comment‑dialog wireframes/variables resolve here too).
- **Primitive / Wireframe:** `VeltInlineCommentsSection` / `VeltInlineCommentsSectionWireframe`.

### Multi‑Thread Comment Dialog
Multiple threads in one dialog/panel (e.g. all comments on a region), with a minimal filter + bulk actions. Also renders comment‑dialog primitives internally.
- **Primitive / Wireframe:** `VeltMultiThreadCommentDialog` / `VeltMultiThreadCommentDialogWireframe`.

## Config props

### Text Comment
No dedicated config props beyond enabling text comments — drive behaviour via the comment config and the tokens below (`enableTextComments`, `rewriterEnabled`, …).

### Inline Comments Section
`VeltInlineCommentsSection` has many props: `targetElementId`, `composerPosition` (`'top'|'bottom'`), `sortBy` (`'createdAt'|'lastUpdated'`), `sortOrder` (`'asc'|'desc'`), `multiThread`, `dialogVariant`/`composerVariant`, `fullExpanded`, `readOnly`, all the `*Placeholder` props, `context`/`contextOptions`, `messageTruncation(Lines)`, `darkMode`/`shadowDom`/`variant`.

### Multi‑Thread Comment Dialog
`VeltMultiThreadCommentDialog` props: `annotationId`, `multiThreadAnnotationId`, `commentPinSelected`, `commentPinType`, `dialogVariant`, `inboxMode`, `readOnly`, `context`.

## CSS — stateful classes

None dedicated to these variants — they reuse the comment‑dialog classes. Theme via `--velt-*` and override structural classes with `!important` (R9b). See [`../reference/css-classes.md`](../reference/css-classes.md).

## Wireframes — slot trees + tokens

### Text Comment
`VeltTextCommentToolbar` wireframe → `.CommentAnnotation`, `.Copywriter` (AI rewriter), `.Generic`, `.Divider`.
**Key tokens** (use full paths where they collide): `{showAdder}`, `{commentToolEnabled}`, `{isUserAllowed}`, `{enableTextComments}`, `{rewriterEnabled}`, `{selectedWordsCount}`, `{selectedCharactersCount}`, `{position.top}`/`{position.left}`, `{uiState.disabled}`.

### Inline Comments Section
`VeltInlineCommentsSectionWireframe`:
```
.Skeleton · .Panel · .List · .ComposerContainer · .CommentCount
.FilterDropdown → .Trigger(.Name/.Arrow) / .Content(.ApplyButton, .List→.Item→.Label/.Checkbox)
.SortingDropdown → .Trigger(.Icon/.Name) / .Content→.Item(.Icon/.Name/.Tick)
```
**Key tokens:** `{skeletonLoading}`, `{annotations}`, `{filterState.filterDropdownOpen}`, `{sortState.sortingDropdownOpen}`, `{isResolvedCommentsOnDomFilterSelected}`; per‑item `{filter.isSelected}`, `{sortOption}`, `{isActive}`, `{isAscending}`.

### Multi‑Thread Comment Dialog
`VeltMultiThreadCommentDialogWireframe`:
```
.CommentCount · .ComposerContainer · .List · .CloseButton · .NewThreadButton
.ResetFilterButton · .EmptyPlaceholder
.MinimalFilterDropdown → .Trigger / .Content(.FilterAll/.FilterUnread/.FilterRead/.FilterResolved/.SelectedIcon/.SortDate/.SortUnread)
.MinimalActionsDropdown → .Trigger / .Content(.MarkAllRead/.MarkAllResolved)
```
**Key tokens:** `{filteredAnnotations}`, `{nonDraftCommentsCount}`, `{minimalFilter}` (`'all'|'read'|'unread'|'resolved'`), `{noCommentsFound}`, `{noCommentsFoundForAppliedFilters}`, `{hideMultiThreadAnnotationComposer}`; per minimal‑filter item `{isSelected}`.

## Headless hooks

None section‑specific — all three reuse the shared comment hooks (see [`../reference/hooks.md`](../reference/hooks.md)). Text Comment additionally drives via the comment element (`useCommentUtils`) and the AI rewriter (`useAIRewriterUtils`).

## Limitations

Text Comment has a thinner slot set (the four toolbar buttons) and no dedicated hooks. Otherwise all three follow the same rules as the comment dialog — the interactivity rule (R4), scoping (nest vs root), and `shadowDom`/CSS guidance all apply. The visible "panel" is the container; fill the slots inside it.

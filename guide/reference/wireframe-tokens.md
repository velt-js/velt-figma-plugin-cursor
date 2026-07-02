# Reference · Wireframe tokens & variables

> **Source of truth — exhaustive for what it covers.** Generated from the Velt SDK (`@veltdev/react` / core). **If a name isn't on this page, it doesn't exist** — don't use it (a missing identifier resolves to `undefined` / renders nothing). Never invent or guess a name; use only identifiers that appear verbatim here or that you verified against ground truth and wrote back to this bar. *Scope: this page is exhaustive for the directive **syntax** — the `velt-if` / `velt-class` / `velt-class-<name>` / `velt-data` directives and the `{…}` token grammar (operators, nested access, the three usage forms). The **slot catalog** (which `*-wireframe` slots each component exposes) is delegated to [`wireframe-components.md`](./wireframe-components.md); the **variable catalog** (every `{name}` per component) is delegated to [`wireframe-variables.md`](./wireframe-variables.md).*

How to read live state inside a wireframe. Used by [`approaches/wireframes.md`](../approaches/wireframes.md).

This page is the **syntax** (operators, nested access, the three usage forms). For the **complete variable catalog** (every `{name}`, grouped by feature, with the 🔑 state flags) see [`wireframe-variables.md`](./wireframe-variables.md).

> A token not in [`wireframe-variables.md`](./wireframe-variables.md) resolves to `undefined` — only use names listed there ([source-of-truth invariant](./_entry-contract.md)).

---

## Token syntax

A token is `{…}`. The resolver matches `/\{(.*?)\}/g` and supports nested paths:

```text
{user.name}                               property access
{annotation.comments.length}              array length
{annotation.comments.0.text}              array index (dot)
{annotation.comments[0].from.userId}      array index (bracket)
{unreadCommentsMap[annotation.annotationId]}   dynamic key (inner resolved first)
{annotation.context.foo}                  annotation.context shorthand
```

## The three usage forms

| You want to… | Use | Example |
|---|---|---|
| Print a value as text | `<velt-data field="…">` (React: `<VeltData field="…" />`) | `<VeltData field="user.name" />` |
| Show/hide on a boolean | `velt-if="{…}"` (React: `<VeltIf condition="{…}">`) | `<VeltIf condition="{enableResolve}">` |
| Toggle CSS classes | `velt-class="'cls': {…}, …"` or `velt-class-<name>="{…}"` | `velt-class="'is-dark': {darkMode}"` · `velt-class-active="{showReplies}"` |

> Booleans are most useful in `velt-if`/`velt-class`; strings/numbers/dates in `velt-data`; compound objects via deep paths (e.g. `field="annotation.from.name"`).

## Operators allowed in `velt-if`

| Category | Supported |
|---|---|
| Logical | `&&`, `\|\|`, `!` |
| Equality | `==`, `!=`, `===`, `!==` |
| Comparison | `<`, `>`, `<=`, `>=` |
| Grouping | `(`, `)` |
| Literals | strings `'…'`, numbers, `true`, `false`, `null`, `undefined` |

Examples: `condition="{enableResolve} && {canResolveAnnotation}"`, `condition="{commentIndex} === 0"`, `condition="!{noCommentsFound}"`. Anything outside this whitelist is stripped before evaluation (safe by design).

---

## Mapped vs. flat‑config features (which name form to use)

Two access conventions exist, as a rule of thumb:

- **Mapped — use short aliases** like `{annotation.from.name}`: Comment Dialog, Comments Sidebar, Comment Bubble, Inline Comments Section, Multi‑Thread Comment Dialog, Text Comment, Notifications Panel, Notifications Tool, Activity Log.
- **Flat‑config — use the explicit** `{componentConfig.<name>}` form: Cursor, Presence, Huddle, Recording, Transcription, View Analytics, Area, Arrow, Tag, Reactions, Selection, Rewriter, Comments Tool, Sidebar Button, Autocomplete.

If a short alias resolves to `undefined` in a flat‑config feature, fall back to `{componentConfig.<name>}`. Mapped features accept the explicit form too; it's just not required.

## Variables that support nested access

Only these root names allow `{root.nested.field}`; any other variable resolves to its root only. (Per‑component variable lists with examples: [`wireframe-variables.md`](./wireframe-variables.md).)

```
user, annotation, annotations, allAnnotations, userContact, comment, commentAnnotation,
commentAnnotations, recorderInitConfig, ghostComment, editComment, assignTo, customChipData,
currentDialogView, context, focusedAnnotation, notification, selectedMinimalFilterDropdownOption,
unreadNotificationsForYou, notificationsForYouInSession, notificationsInSession,
notificationsByUserMap, notificationsByDocumentId, notificationsByDate, settingsConfig,
settingsSelectedOption, settingsAccordionExpanded, tabConfig, tabPage, TABS, allActivities,
filteredActivities, groupedActivities, virtualScrollItems, availableFilters, expandedGroups,
activity, activityRecord, dateGroup, filter, filterOption, position, allowedElementIds,
filteredAnnotations, multiThreadCommentAnnotation, composerCommentAnnotation, statuses,
filterState, sortState, selectedAnnotationsMap, selectedAnnotationsLocationMap, contextOptions
```

If a deep path returns `undefined`, first check the root is on this list.

---

## Frequently used variables (Comment Dialog / Sidebar)

A small starter set — see the per‑feature page for the full list and types:

| Variable | Meaning | Typical use |
|---|---|---|
| `{user}` / `{user.name}` | Current user | `velt-data` |
| `{annotation}` | The thread's annotation (deep paths OK) | `velt-data` (e.g. `annotation.from.name`) |
| `{comment}` / `{commentIndex}` | Current comment in a thread card / its 0‑based index | `velt-if="{commentIndex} === 0"` |
| `{darkMode}` | Dark mode active | `velt-class` |
| `{noCommentsFound}` | Sidebar empty state | `velt-if` |
| `{enableResolve}`, `{canResolveAnnotation}` | Resolve availability | `velt-if` |
| `{resolved}` / `{status}` | Thread resolved / status | `velt-if` / `velt-class` |
| `{composerInOpenState}` | Composer expanded | `velt-class` |
| `{focusedAnnotation}` | Sidebar's focused thread | `velt-data` |
| `{notification}` | Current notification (notifications panel) | `velt-data` |

---

## Debugging a token that shows nothing

If a token renders `undefined`/blank, check, in order:

1. **Spelling** — exact name from [`wireframe-variables.md`](./wireframe-variables.md) (case‑sensitive).
2. **Nested access** — is the root in the nested‑access list above? If not, you can only read its root.
3. **Context** — are you inside a slot that actually receives that variable? (e.g. `{comment}`/`{commentIndex}` exist only inside thread‑card descendants; `{notification}` only in the notifications panel.)
4. **Mapped vs flat** — for flat‑config features try `{componentConfig.<name>}`.

> The full variable list (and which roots allow nested access) is in [`wireframe-variables.md`](./wireframe-variables.md).

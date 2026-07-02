---
name: velt-notifications
description: Notifications specifics — panel, tool/bell, history panel (tabs, settings, open mode). Use when customizing notifications.
---

Notifications.

- Procedure + identifiers: `guide/features/notifications.md` (root wireframes, props, tokens, hooks, CSS classes — self-contained). Cross-check props/flags in `guide/reference/props.md`, `guide/reference/feature-flags.md`, and the Surface lookup in `guide/reference/component-catalog.md`. Verify every name (R10).
- Key props: `tabConfig` (forYou/documents/all/people), `panelOpenMode` (popover/sidebar), `settings`, `settingsLayout`. Several are off by default — check `feature-flags.md`. Then pick the layer (`velt-decision`) and build.

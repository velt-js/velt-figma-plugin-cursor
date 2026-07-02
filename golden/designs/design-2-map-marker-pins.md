# Golden Design #2 — map-marker numbered pins

A verified-in-browser design (from the playground). The plugin must reproduce it and the Judge must reach **PASS** with a clean rules scan.

## Design intent
Comment pins styled as numbered map markers:
- Rounded-square badges, **colored by status** (Open / In-progress / Resolved).
- Each badge shows the comment's **number** (placement order).

## Expected plan
- **Surface:** `VeltCommentPin` (recognized from `guide/reference/component-definitions.md`).
- **Layer:** wireframe (replace the whole pin) + inline styles (the pin renders in a shadow root, so inline styles, not class CSS).
- **Color by status:** multi-branch `velt-if` on `{annotation.status.id}` (`'OPEN'` / `'IN_PROGRESS'` / `'RESOLVED'`).
- **Number:** the index slot is an empty container → print it with `<velt-data field="annotation.annotationIndex">`. (Page-mode comments have no index — guard with `velt-if`.)

## Expected behavior (must stay intact)
Create comment → numbered pin appears → change status → badge recolors → number reflects placement order.

## Pass criteria
Judge verdict **PASS** (badge shape/color-by-status/number met, with evidence) and a clean static rules scan (inline styles only on the shadowed pin, multi-branch `velt-if` with real status ids, number via `velt-data`, identifiers all verified).

# Golden Design #1 — review-card comment dialog

A verified-in-browser design (from the playground). The plugin must reproduce it and the Judge must reach **PASS** with a clean rules scan.

## Design intent
A comment dialog styled as a "review card":
- An indigo **header** with a "REVIEW" label and a **status pill** (top-left), label uppercase.
- A **thread card** with an indigo left-accent bar: avatar / name / time / message / reactions.
- A **composer** at the bottom.
- The same card renders in **both** the floating dialog and the sidebar rows.

## Expected plan
- **Surface:** `VeltCommentDialog` (recognized from `guide/reference/component-definitions.md`).
- **Layer:** wireframe (structure changes, Velt keeps behavior) + inline styles for the indigo theming (shadow-safe).
- **Why wireframe:** custom header/thread-card/composer layout, no custom interactivity needed inside → decision-tree Q2.
- **Variants:** `variant="dialog"` and `variant="sidebar"` so the same card renders in both contexts.

## Expected behavior (must stay intact)
Place pin → open dialog → reply → change status (pill + any accent recolor) → resolve → sidebar row reflects the same card.

## Pass criteria
Judge verdict **PASS** (all visual + behavior goals met, with evidence) and a clean static rules scan (one `<VeltWireframe>`, ThreadCard nested in Body→Threads, no interactive React in wireframe markup, identifiers all verified).

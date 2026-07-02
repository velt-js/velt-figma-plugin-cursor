---
name: velt-css
description: Theme Velt via CSS variables and class overrides. Use when the design differs only in colors/spacing/fonts/radius, or to style on top of any other layer.
---

CSS customization.

- Procedure: `guide/approaches/css.md` (step-ordered). Identifiers: `guide/reference/css-variables.md` (the `--velt-*` set) and `guide/reference/css-classes.md` (stateful classes + their conditions). Verify every name — never invent (R10).
- Variables (`--velt-*`) cross the shadow boundary — no flag. Class/selector overrides need `shadowDom={false}` (or `injectCustomCss`) + `!important` (R6/R9b). Dark values under `:root[data-velt-theme="dark"]` (R9). One stylesheet (R8). Never `display:none` a feature (R7).

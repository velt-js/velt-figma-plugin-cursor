# Approach · <Name>

> **TEMPLATE — not a guide page.** Every file in `approaches/` MUST follow this exact section order and headings. Replace the angle-bracket placeholders; keep the section names verbatim. A section that doesn't apply still appears, with an explicit one-line "N/A — <why>" instead of being deleted. Delete this blockquote in real pages.

**What it is:** <1–2 sentences — what this layer changes and what it leaves untouched.>

**Use it when:** <the design situation this is the right layer for.> (Decision tree Q<#>.)

**Don't use it when:** <the situation where a *different* layer is correct — and name that better layer with a link.>

> <one-line key caveat or cost callout — the single most important thing to remember. Optional but recommended.>

---

## The model

<How this approach works conceptually: what Velt gives you, what you supply, where the boundary is. The mental model the reader needs before the steps.>

## Steps

<Numbered, do-this-then-that. Each step is its own `### Step N — <imperative>` with a minimal verified code example. Order matters; the reader should be able to follow top-to-bottom.>

### Step 1 — <imperative>

```tsx
// minimal, verified example
```

### Step 2 — <imperative>

…

> **`## Steps` may be omitted for a non-procedural approach** (e.g. "Combining approaches", which is about *how to mix*, not a do-this-then-that sequence). Such a file carries its guidance under `## The model` instead — that is the one sanctioned exception.

## What it can and can't do

| Can | Can't |
|---|---|
| <capability> | <hard limit — and the layer to climb to instead> |

## Notes & deep-dives

> **Optional, trailing.** Reference material that isn't a sequential step (scoping rules, variants, advanced tokens, worked examples, honest cost notes). Use `### <topic>` subsections. Anything that isn't part of the header block, `## The model`, `## Steps`, `## What it can and can't do`, or `## Checklist` lives here — NEVER as a new top-level `##`. Omit the section entirely if the approach has no deep-dives.

### <topic>

…

## Checklist

- [ ] <the concrete things that must be true for this approach to be done correctly>

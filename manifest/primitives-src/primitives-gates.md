# Primitive gates — what enforces the R1 / R2 / R3 guarantees

Three gates keep the primitives customization surface honest, plus one measurement that is recorded
rather than enforced. This documents what each proves, **when it actually runs**, and where it can
still lie to you.

Deliberately, **no npm script aliases were added for these** — the hooks invoke the scripts directly,
so `package.json` is unchanged. Run them by path.

---

## 1. `scripts/audit-children-slot.js` — R1

Every registered public Velt tag either accepts customer children or is classified as a non-primitive
mount point. Fails if a primitive silently swallows children.

```bash
node scripts/audit-children-slot.js
```

**Runs automatically:** `.husky/pre-push`, and the `children-slot` job in `.github/workflows/invariants.yml`.

Current: 467 primitives supported, 51 non-primitive mount points, 0 failures.

---

## 2. `scripts/audit-primitive-capabilities.js` — the R1/R2/R3 matrix

One row per primitive, four columns, resolved against the canonical registry
(`scripts/lib/primitive-registry.js`, **443** primitives).

| Column | Required for | Meaning |
|---|---|---|
| C1 R1 children | all | template has a `*veltDynamicTemplate` anchor, `<ng-content>`, or a compound trigger |
| C2 R2 publish | all, no exceptions | the base chain publishes `__veltContext` |
| C3 R2 consume | only where it applies | scored **only** for primitives that resolve an entity from an id/index/selector — 91 of 443. A presentational leaf has nothing to inherit; counting it would pad the denominator and hide real gaps |
| C4 R3 data | per family | the family's core service exposes `get*Config$` **and** an element facade exposes it |

```bash
node scripts/audit-primitive-capabilities.js              # the matrix
node scripts/audit-primitive-capabilities.js --markdown   # regenerate docs/primitives-coverage-matrix.md
node scripts/audit-primitive-capabilities.js --emit-tags  # regenerate docs/primitive-tags.json (for sdk-react)
node scripts/audit-primitive-capabilities.js --json
```

**Runs automatically:** `.husky/pre-push`, and the `primitive-capabilities` job in `invariants.yml`.

Misses must be listed in `scripts/primitive-capability-exceptions.json` with a reason. **An exception
whose component starts passing is itself a failure**, so the list can only shrink. One entry today:
`velt-comment-dialog-internal`, the dialog root orchestrator.

---

## 3. Slot ↔ primitive parity — a measured finding, NOT a gate

This is a different question from #2, and the one that decides whether "build it with primitives
alone" is possible. #2 proves every primitive *accepts* children; this asks whether a primitive
*exists* wherever a wireframe slot can reach. Where it doesn't, a wireframe stays mandatory.

It was built as a gate and then **deliberately removed** (2026-08-04): the number is not currently
moving, so a ratchet on it earned little for the surface it added. The measurement is recorded here
instead.

**Measured 2026-08-04:** 770 wireframe slot keys across the `components-map*` registries, 443
primitives, **392 slots with no primitive counterpart**:

| Registry | Unmatched slots |
|---|---:|
| `components-map.recorder.ts` | 175 |
| `components-map.comment.ts` (V1 surfaces) | 168 |
| `components-map.reaction.ts` | 14 |
| `components-map.cursor.ts` | 10 |
| `components-map.presence.ts` | 10 |
| `components-map.live-state-sync.ts` | 9 |
| `components-map.ts` | 6 |

These are features that never got a V2 primitive layer at all. **So zero-wireframe is not achievable
today for those 392 positions**, and the capability matrix in #2 does not claim otherwise — the two
measurements answer different questions. Reading the matrix as "primitives can do everything" is the
mistake this section exists to prevent.

To re-measure, match each `'<tag>-wireframe'` key in the `components-map*` files against the primitive
selectors from `scripts/lib/primitive-registry.js` with the `-internal` suffix stripped — that is the
naming contract the V2 tree follows. If this number starts growing, it is worth restoring as a gate.

## 4. `sdk-react/scripts/audit-react-primitive-parity.mjs` — React children forwarding

An SDK primitive that accepts children is useless from React if its wrapper drops `children`. This
asserts every primitive tag has a wrapper that forwards `{children}`, and that no primitive lacks a
wrapper entirely.

```bash
cd path/to/sdk-react
node scripts/audit-react-primitive-parity.mjs
node scripts/audit-react-primitive-parity.mjs --list
```

Current: 437 of 441 pass; 4 baselined in `scripts/react-parity-baseline.json` (3 `snippyly-*` legacy
aliases the React SDK never wrapped by design, and `velt-comment-sidebar-v2`, a false positive — the
SDK registers the *plural* `velt-comments-sidebar-v2` while the Angular selector is singular).

> ### ⚠️ This one is NOT wired to anything
>
> `sdk-react` has no husky hooks, and its four workflows (`develop`/`staging`/`main`/`trigger-e2e`)
> only `npm install` then `npm run publish:*` — there is no test or validate step. **Nothing runs this
> gate automatically.** It has to be run by hand before a React release.
>
> It caught one real bug when written (`VeltNotificationsPanel` rendered its element without
> forwarding children). It will not catch the next one on its own.

> ### ⚠️ Its input can go stale silently
>
> The gate reads `sdk-react/scripts/primitive-tags.json`, which is **hand-copied** from the SDK's
> `docs/primitive-tags.json`. It refuses to run at all if that file is missing — but if the SDK adds a
> primitive and nobody re-copies, React parity reports clean while a new tag goes unchecked.
>
> After changing the primitive set:
> ```bash
> # in the SDK
> node scripts/audit-primitive-capabilities.js --emit-tags
> cp docs/primitive-tags.json ../sdk-react/scripts/primitive-tags.json
> ```

---

## Running the test suite

The compliance manifest (`src/app/testing/v2-test-framework/component-compliance-manifest.generated.ts`)
is **gitignored**, so it does not exist on a fresh clone — and two spec files import it, including
`component-compliance-suite`, which carries most of the ~5,900 V2-framework tests. Generate it first:

```bash
npm run generate:compliance-manifest   # pre-existing script
npm run test:ci
```

Skip it and the whole run aborts before a single test executes (verified 2026-08-04):

```
✘ [ERROR] TS2307: Cannot find module
  'src/app/testing/v2-test-framework/component-compliance-manifest.generated'
  or its corresponding type declarations. [plugin angular-compiler]
```

It is a loud failure, not a silent skip — but the message points at a file you have never seen, so
it reads like a broken checkout rather than a missing pre-step.

CI already does this — `.github/workflows/test.yml` has an explicit "Generate compliance manifest"
step before the tests. Only local runs need the manual step.

**It also embeds template source**, so it goes stale whenever you edit a `.html`. Regenerate after
template edits or you will chase violations that no longer exist (this cost real time during the
2026-08-04 work). `npm run test:ci` does not regenerate it, and neither does
`npx ng test --include=…`.

---

## Implementation consistency

Each feature has ONE shared implementation, with a single documented exception:

| Feature | Shared implementation | Holdout |
|---|---|---|
| R1 children | `children-slot.ts` + `define-velt-element.ts` + `dynamic-template.directive.ts` — attaches at the *registration* layer, so it reached all 443 primitives without editing any of them | none |
| R2 context | `velt-context-host.ts` (`VeltContextHost`) — 5 bases | `comment-dialog-primitive-themed.base.ts`: genuinely a different mechanism (a `CommentContextRegistry`, a 5-branch `ngOnInit`, a 50×10ms poll, per-annotation config re-pointing). Folding it in would mean bloating the shared host with registry logic no other base has |
| R3 data | `config-observable.ts` (`ConfigObservableBridge`) — 12 of 13 core services | `comment-dialog-core.service.ts`: already SHIPPED at HEAD, so it was left untouched by deliberate choice rather than merged |

If you extend any of the three, use the shared implementation — the holdouts are exceptions with
reasons, not precedent.

## Known blind spots

| Gap | Why it matters |
|---|---|
| The React gate runs only by hand | See above — the guarantee is only as good as someone remembering |
| `primitive-tags.json` is a hand-copied snapshot | Can go stale without failing |
| The manifest is not a build input | Staleness after template edits is silent, not an error |
| `validate:all` is only `validate:registrations` | It aggregates none of the other 13 `validate:*` scripts — the name oversells it. Pre-existing |
| `check-element-dts-parity` is name-level only | It sees a missing method, not a wrong type — which is why `Observable<any>` ships against a source `Observable<ComponentConfig \| null>` |
| Running an SDK build can discard hand-maintained published `.d.ts` | `npm run build:sdk:staging` reverted the `velt-sdk*/app/models/element/*.d.ts` additions during the 2026-08-04 work. The parity gate caught it; re-run it after any build |

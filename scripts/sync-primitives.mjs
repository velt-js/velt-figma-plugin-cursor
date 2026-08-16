#!/usr/bin/env node
// sync-primitives.mjs — build manifest/velt-primitives.json from the SDK's own generated artifacts.
//
// WHY THIS EXISTS
// The SDK now publishes machine-readable primitive truth (a tag registry, a capability matrix, a
// parent-owned-condition baseline, and a slot<->primitive parity measurement). Before this, the
// plugin's only primitive knowledge was a hand-maintained prose snapshot in guide/reference/
// primitives.md that had already drifted (it claims 491 React components; the SDK says 443).
// A generator that reads the SDK's artifacts cannot drift the same way — and when it does, it says so.
//
// PRIMITIVES-ONLY. This writes exactly one file, manifest/velt-primitives.json, which nothing in the
// wireframe path reads. It does not touch manifest/velt-codeconnect.json.
//
// INPUTS (SDK repo, branch mayank/primitives-r3-data / PR snippyly/sdk#4506):
//   docs/primitive-tags.json                          - tags that accept customer children (R1)
//   docs/primitives-coverage-matrix.md                - per-family R1/R2/R3 counts
//   docs/primitives-gates.md                          - the slot<->primitive parity measurement
//   scripts/primitive-capability-exceptions.json      - primitives that do NOT support a capability
//   scripts/primitive-parent-conditions.baseline.json - conditions a parent owns that the primitive can't evaluate
//
// USAGE
//   node scripts/sync-primitives.mjs                  # from the vendored snapshot in manifest/primitives-src/
//   node scripts/sync-primitives.mjs --sdk /path/to/sdk   # re-vendor from a live SDK checkout, then build
//   node scripts/sync-primitives.mjs --check          # exit 1 if the committed manifest is stale
//
// The vendored snapshot exists so a build is reproducible without an SDK checkout. It is a SNAPSHOT:
// --check compares the manifest to the snapshot, NOT to the SDK. Re-vendor with --sdk to catch SDK drift.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "manifest", "primitives-src");
const OUT = path.join(ROOT, "manifest", "velt-primitives.json");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const VENDORED = [
  ["docs/primitive-tags.json", "primitive-tags.json"],
  ["scripts/primitive-capability-exceptions.json", "primitive-capability-exceptions.json"],
  ["scripts/primitive-parent-conditions.baseline.json", "primitive-parent-conditions.baseline.json"],
  ["docs/primitives-coverage-matrix.md", "primitives-coverage-matrix.md"],
  ["docs/primitives-gates.md", "primitives-gates.md"],
  // react-exports.json is extracted from the CONSUMING app's @veltdev/react, not the SDK repo.
];

// The SDK branch this snapshot came from. Bump when re-vendoring from a different branch/tag.
const PROVENANCE = {
  repo: "snippyly/sdk",
  pr: 4506,
  branch: "mayank/primitives-r3-data",
  baseRef: "staging",
  note: "R1 children + R2 context + R3 data. NOT merged, NOT published to npm at snapshot time.",
};

// ---------------------------------------------------------------------------
// React component name <- custom element tag. The SDK's naming contract: kebab tag, drop the
// leading vendor prefix, PascalCase the rest, prefix with Velt. `snippyly-*` legacy aliases have no
// React wrapper by design (baselined in the SDK's React parity gate), so they get reactName: null.
// ---------------------------------------------------------------------------
// Naive kebab -> Pascal is NOT reliable: the SDK exports `VeltCommentSidebarV2Header` for
// `velt-comment-sidebar-header-v2` — the V2 token moves position. Deriving the name produced
// `VeltCommentSidebarHeaderV2`, which does not exist, and a builder concluded (wrongly) that the
// whole SidebarV2 family had no React wrappers. So: derive a candidate, then RESOLVE it against the
// real export list, falling back to a token-multiset match before giving up.
function makeReactNameResolver(exportList) {
  const exports = new Set(exportList);
  const byTokens = new Map();
  const tokensOf = (pascal) => (pascal.replace(/^Velt/, "").match(/[A-Z][a-z0-9]*|V\d+/g) || []).map((t) => t.toLowerCase()).sort().join("|");
  for (const e of exportList) {
    const k = tokensOf(e);
    if (!byTokens.has(k)) byTokens.set(k, e);
  }
  return (tag) => {
    if (tag.startsWith("snippyly-")) return { reactName: null, reactNameSource: "legacy-alias (no React wrapper by design)" };
    const naive = "Velt" + tag.replace(/^velt-/, "").split("-").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("");
    if (exports.has(naive)) return { reactName: naive, reactNameSource: "exact" };
    const alt = byTokens.get(tokensOf(naive));
    if (alt) return { reactName: alt, reactNameSource: "token-match (derived name was wrong)" };
    return { reactName: null, reactNameSource: "NOT EXPORTED by the installed @veltdev/react" };
  };
}

// Family assignment, longest prefix wins. Family names match the SDK coverage matrix so the two can
// be cross-checked; a mismatch is reported, never silently reconciled.
const FAMILY_PREFIXES = [
  ["velt-comment-dialog", "CommentDialogPrimitive"],
  ["velt-notifications-panel", "NotificationsPanel"],
  ["velt-notifications-bottom-sheet", "NotificationsPanel"],
  ["velt-notifications-tool", "NotificationsTool"],
  ["velt-comment-sidebar", "SidebarV2"],
  ["velt-comments-sidebar", "SidebarV2"],
  ["velt-activity-log", "ActivityLog"],
  ["velt-inline-comments", "InlineSection"],
  ["velt-multi-thread", "MultiThread"],
  ["velt-autocomplete", "Autocomplete"],
  ["velt-comment-pin", "CommentPin"],
  ["velt-text-comment", "TextComment"],
  ["velt-comment-bubble", "CommentBubble"],
  ["velt-sidebar-button", "SidebarButton"],
  ["velt-comments-tool", "CommentsTool"],
  ["snippyly-comment-bubble", "CommentBubble"],
  ["snippyly-comment-pin", "CommentPin"],
  ["snippyly-sidebar-button", "SidebarButton"],
];
const familyFor = (tag) => {
  let best = null;
  for (const [p, f] of FAMILY_PREFIXES) if (tag === p || tag.startsWith(p + "-")) { if (!best || p.length > best[0].length) best = [p, f]; }
  return best ? best[1] : "Unknown";
};

// ---------------------------------------------------------------------------
// R3 config getters. ONLY the six the PR body names as delivered are recorded as verified.
//
// The SDK coverage matrix scores C4 (R3 data) 443/443 across all thirteen families, but names only
// six public getters. Rather than infer a getter name for the other seven families, they are recorded
// as unverified with getter: null. A generator must not invent an API name — that is exactly the
// class of hallucination the guide's "if it isn't listed, it doesn't exist" bar exists to prevent.
// ---------------------------------------------------------------------------
const R3_GETTERS = {
  CommentDialogPrimitive:  { getter: "getCommentDialogConfig",         element: "getCommentElement",      args: ["annotationId"], reactHook: "useCommentDialogConfig", status: "verified" },
  NotificationsPanel:      { getter: "getNotificationsPanelConfig",    element: "getNotificationElement", args: [],               reactHook: null,                     status: "verified" },
  SidebarV2:               { getter: "getCommentSidebarConfig",        element: "getCommentElement",      args: [],               reactHook: null,                     status: "verified" },
  InlineSection:           { getter: "getInlineCommentsSectionConfig", element: "getCommentElement",      args: [],               reactHook: null,                     status: "verified" },
  MultiThread:             { getter: "getMultiThreadDialogConfig",     element: "getCommentElement",      args: [],               reactHook: null,                     status: "verified" },
  // NOTE the accessor: getActivityElement, NOT getActivityLogElement. Verified against a running
  // local SDK build (v1.0.0, branch mayank/primitives-r3-data) — the family-name-derived guess was
  // wrong and would have produced code that silently threw on undefined.
  ActivityLog:             { getter: "getActivityLogConfig",           element: "getActivityElement",     args: [],               reactHook: null,                     status: "verified" },
};

// ---------------------------------------------------------------------------
// Compound triggers. Composing a dropdown from its -trigger-icon / -trigger-name leaves WITHOUT the
// -trigger ancestor yields a control that renders perfectly and does nothing: the click handler lives
// on -trigger. This is PR #4506 open issues #3 and #4, and the PR states the class is NOT instrumented
// upstream ("actions the wrapper owns"). Derived from the tag list, consumed by lint rule P1.
// ---------------------------------------------------------------------------
function deriveTriggerOwners(tags) {
  const triggers = tags.filter((t) => t.endsWith("-trigger"));
  const out = {};
  for (const t of triggers) {
    const descendants = tags.filter((x) => x !== t && x.startsWith(t + "-"));
    if (descendants.length) out[t] = descendants;
  }
  return out;
}

async function readJSON(p) { return JSON.parse(await fs.readFile(p, "utf8")); }

// Parse the coverage matrix markdown table -> per-family capability counts.
function parseCoverageMatrix(md) {
  const families = {};
  for (const line of md.split("\n")) {
    const m = line.match(/^\|\s*([A-Za-z0-9]+)\s*\|\s*(\d+)\s*\|\s*(\d+)\/(\d+)\s*\|\s*(\d+)\/(\d+)\s*\|\s*([\d]+\/[\d]+|n\/a)\s*\|\s*(\d+)\/(\d+)\s*\|/);
    if (!m) continue;
    families[m[1]] = {
      primitives: Number(m[2]),
      r1Children: { pass: Number(m[3]), of: Number(m[4]) },
      r2Publish: { pass: Number(m[5]), of: Number(m[6]) },
      r2Consume: m[7] === "n/a" ? null : { pass: Number(m[7].split("/")[0]), of: Number(m[7].split("/")[1]) },
      r3Data: { pass: Number(m[8]), of: Number(m[9]) },
    };
  }
  return families;
}

// Parse the parity measurement out of primitives-gates.md section 3.
function parseParity(md) {
  const totals = md.match(/\*\*Measured ([\d-]+):\*\*\s*(\d+)\s*wireframe slot keys[^,]*,\s*(\d+)\s*\n?primitives,\s*\*\*(\d+)\s*slots with no primitive counterpart\*\*/);
  const rows = {};
  for (const line of md.split("\n")) {
    // Trailing prose after the tick-quoted name is allowed: `components-map.comment.ts` (V1 surfaces).
    const m = line.match(/^\|\s*`(components-map[^`]*)`[^|]*\|\s*(\d+)\s*\|/);
    if (m) rows[m[1]] = Number(m[2]);
  }
  return {
    measuredOn: totals ? totals[1] : null,
    wireframeSlotKeys: totals ? Number(totals[2]) : null,
    primitives: totals ? Number(totals[3]) : null,
    slotsWithNoPrimitive: totals ? Number(totals[4]) : null,
    byRegistry: rows,
    enforcedAsGate: false,
    note: "Recorded measurement, NOT a gate upstream. It is the ONLY answer to 'is a zero-wireframe build possible for this surface'. The capability matrix does not answer that question.",
  };
}

// ---------------------------------------------------------------------------
// Surface reachability. Maps the plugin's surface vocabulary onto the parity finding, so the planner
// can refuse `strictly primitives` for a surface that has no primitive layer at all instead of
// discovering it mid-loop. Families present in the coverage matrix are reachable by construction;
// everything in the unmatched registries is not.
// ---------------------------------------------------------------------------
const SURFACE_REACHABILITY = {
  dialog:            { reachable: true,  family: "CommentDialogPrimitive" },
  "inline-section":  { reachable: true,  family: "InlineSection" },
  sidebar:           { reachable: true,  family: "SidebarV2" },
  notifications:     { reachable: true,  family: "NotificationsPanel" },
  "notifications-tool": { reachable: true, family: "NotificationsTool" },
  "activity-log":    { reachable: true,  family: "ActivityLog" },
  "multi-thread":    { reachable: true,  family: "MultiThread" },
  autocomplete:      { reachable: true,  family: "Autocomplete" },
  pin:               { reachable: true,  family: "CommentPin" },
  bubble:            { reachable: true,  family: "CommentBubble" },
  "text-comment":    { reachable: true,  family: "TextComment" },
  "sidebar-button":  { reachable: true,  family: "SidebarButton" },
  "comments-tool":   { reachable: true,  family: "CommentsTool" },

  recorder:          { reachable: false, registry: "components-map.recorder", unmatchedSlots: 175, reason: "no V2 primitive layer exists for the recorder at all" },
  "comment-v1":      { reachable: false, registry: "components-map.comment",  unmatchedSlots: 168, reason: "V1 comment surfaces never got a V2 primitive layer" },
  reactions:         { reachable: false, registry: "components-map.reaction", unmatchedSlots: 14,  reason: "no V2 primitive layer for reaction surfaces" },
  cursor:            { reachable: false, registry: "components-map.cursor",   unmatchedSlots: 10,  reason: "no V2 primitive layer for cursors" },
  presence:          { reachable: false, registry: "components-map.presence", unmatchedSlots: 10,  reason: "no V2 primitive layer for presence" },
  "live-state-sync": { reachable: false, registry: "components-map.live-state-sync", unmatchedSlots: 9, reason: "no V2 primitive layer for live state sync" },
};

async function vendorFromSdk(sdkPath) {
  for (const [rel, name] of VENDORED) {
    const from = path.join(sdkPath, rel);
    const body = await fs.readFile(from, "utf8").catch(() => null);
    if (body == null) { console.error(`✗ SDK input missing: ${rel} (looked in ${sdkPath})`); process.exit(1); }
    await fs.writeFile(path.join(SRC, name), body);
    console.log(`  re-vendored ${name}`);
  }
}

async function build() {
  const tagsDoc = await readJSON(path.join(SRC, "primitive-tags.json"));
  const exceptionsDoc = await readJSON(path.join(SRC, "primitive-capability-exceptions.json"));
  const parentDoc = await readJSON(path.join(SRC, "primitive-parent-conditions.baseline.json"));
  // Registration truth, captured against a RUNNING SDK. The SDK's tag registry over-reports: it
  // lists container-shaped names that are never passed to defineCustomElement. Emitting one yields
  // an HTMLUnknownElement — renders nothing, throws nothing, invisible to a compiler and to a pixel
  // diff. Found the hard way when a planner chose velt-comment-dialog-body as an R2 anchor.
  const runtimeDoc = await readJSON(path.join(SRC, "runtime-unregistered.json"), { unregistered: {} }).catch(() => ({ unregistered: {} }));
  const reactDoc = await readJSON(path.join(SRC, "react-exports.json"), { exports: [] }).catch(() => ({ exports: [] }));
  const resolveReactName = makeReactNameResolver(reactDoc.exports || []);
  const matrixMd = await fs.readFile(path.join(SRC, "primitives-coverage-matrix.md"), "utf8");
  const gatesMd = await fs.readFile(path.join(SRC, "primitives-gates.md"), "utf8");

  const tags = tagsDoc.tags.slice().sort();
  const families = parseCoverageMatrix(matrixMd);
  const parity = parseParity(gatesMd);

  // A partial parse here would UNDER-report how much of the design primitives cannot reach, which is
  // the one number that decides whether `strictly primitives` is honest. Fail loudly instead.
  const paritySum = Object.values(parity.byRegistry).reduce((a, b) => a + b, 0);
  if (parity.slotsWithNoPrimitive == null || !Object.keys(parity.byRegistry).length) {
    throw new Error("could not parse the slot<->primitive parity measurement from primitives-gates.md");
  }
  if (paritySum !== parity.slotsWithNoPrimitive) {
    throw new Error(`parity per-registry rows sum to ${paritySum} but the stated total is ${parity.slotsWithNoPrimitive} — the table parse is incomplete, refusing to emit an under-count`);
  }
  if (!Object.keys(families).length) throw new Error("could not parse the capability coverage matrix");
  const triggerOwners = deriveTriggerOwners(tags);

  // Parent-owned conditions, keyed by the PUBLIC tag (baseline keys carry the -internal suffix).
  const stripInternal = (t) => t.replace(/-internal$/, "");
  const parentConditions = {};
  const addCond = (key, status, reason) => {
    const [cond, internalTag] = key.split("|");
    const tag = stripInternal(internalTag);
    (parentConditions[tag] ||= []).push(reason ? { condition: cond, status, reason } : { condition: cond, status });
  };
  for (const p of parentDoc.pairs || []) addCond(p, "pending");
  for (const [k, reason] of Object.entries(parentDoc.blocked || {})) addCond(k, "blocked", reason);

  const exceptionsByTag = {};
  for (const e of exceptionsDoc.exceptions || []) (exceptionsByTag[e.component] ||= []).push({ capability: e.capability, reason: e.reason });

  const primitives = {};
  for (const tag of tags) {
    const family = familyFor(tag);
    const conds = parentConditions[tag] || [];
    const rn = resolveReactName(tag);
    primitives[tag] = {
      reactName: rn.reactName,
      ...(rn.reactNameSource !== "exact" ? { reactNameSource: rn.reactNameSource } : {}),
      family,
      acceptsChildren: true,                       // every tag in primitive-tags.json accepts children by construction
      r2Publish: true,                             // C2 is 443/443, no exceptions
      registered: !(tag in (runtimeDoc.unregistered || {})),   // false = in the registry but NOT a real custom element
      ...(runtimeDoc.unregistered?.[tag] ? { notRegisteredReason: runtimeDoc.unregistered[tag] } : {}),
      r3Surface: R3_GETTERS[family] ? R3_GETTERS[family].getter : null,
      triggerOwnerOf: triggerOwners[tag] || null,  // set on -trigger tags that own descendants
      requiresTriggerAncestor: null,               // filled below
      parentOwnedConditions: conds.length ? conds : null,
      capabilityExceptions: exceptionsByTag[tag] || null,
    };
  }
  // Reverse-index the compound-trigger relation onto the descendant leaves (lint P1 reads this).
  for (const [trigger, descendants] of Object.entries(triggerOwners)) {
    for (const d of descendants) if (primitives[d]) primitives[d].requiresTriggerAncestor = trigger;
  }

  // Cross-check derived family assignment against the SDK's published totals. Report drift; do not fudge.
  const derivedCounts = {};
  for (const p of Object.values(primitives)) derivedCounts[p.family] = (derivedCounts[p.family] || 0) + 1;
  const familyDrift = [];
  for (const [fam, row] of Object.entries(families)) {
    const derived = derivedCounts[fam] || 0;
    // The published total counts all 443 primitives; the tag list is the 441 that accept children.
    if (Math.abs(derived - row.primitives) > 2) familyDrift.push({ family: fam, sdkMatrix: row.primitives, derivedFromTags: derived });
  }
  const unknownFamily = Object.entries(primitives).filter(([, p]) => p.family === "Unknown").map(([t]) => t);

  const manifest = {
    _doc: [
      "Velt PRIMITIVE capability manifest — generated by scripts/sync-primitives.mjs from the SDK's own",
      "generated artifacts (see provenance). Read by the primitives planner/builder, the reachability",
      "gate, and scripts/lint-primitives.mjs. Nothing in the WIREFRAME path reads this file.",
      "Do not hand-edit: re-run the generator.",
    ],
    provenance: PROVENANCE,
    generatedBy: "scripts/sync-primitives.mjs",
    availability: {
      published: false,
      note: "PR #4506 targets staging and is unmerged. Treat R1/R2/R3 as FORTHCOMING: a build must verify the target app's installed @veltdev version before emitting children/context/data code. See scripts/check-primitive-reachability.mjs --velt-version.",
      minVeltVersion: null,
    },
    counts: {
      tagsAcceptingChildren: tags.length,
      notRegisteredAtRuntime: Object.keys(runtimeDoc.unregistered || {}).length,
      primitivesInSdkRegistry: 443,
      r1ChildrenPass: "442/443",
      r2PublishPass: "443/443",
      r2ConsumePass: "91/91 (scored only where a primitive resolves an entity from an id/index/selector)",
      nonPrimitiveMountPoints: 51,
    },
    families,
    r3: {
      getters: Object.fromEntries(Object.entries(R3_GETTERS).map(([f, g]) => [f, {
        ...g,
        // The hook may exist in SDK source and NOT in the installed package: the R3 React hook and
        // the ComponentConfig types ship only after the @veltdev/types publish lands. Emitting an
        // import for it produces a build error, so record availability rather than assume it.
        reactHookAvailable: g.reactHook ? (reactDoc.exports || []).includes(g.reactHook) : false,
      }])),
      note: "The SDK coverage matrix scores R3 443/443 across all 13 families but names only these 6 public getters. Families without a named getter are recorded as null — NOT inferred. Never emit a getter name that is not listed here.",
      familiesWithoutNamedGetter: Object.keys(families).filter((f) => !R3_GETTERS[f]),
    },
    parity,
    surfaceReachability: SURFACE_REACHABILITY,
    primitives,
    integrity: { familyDrift, unknownFamily },
  };

  // Hazards that a code generator will hit, each traceable to a PR #4506 finding.
  manifest.compositionHazards = [
    {
      id: "dead-compound-trigger",
      severity: "error",
      source: "PR #4506 open issues #3, #4",
      symptom: "A status/priority chip composed from -trigger-icon + -trigger-name renders correctly and does nothing.",
      cause: "The click handler lives on the -trigger ancestor. Composing from its leaves skips it.",
      rule: "Any primitive with requiresTriggerAncestor set MUST have that ancestor present in the composed tree.",
      lintRule: "P1",
      instrumentedUpstream: false,
    },
    {
      id: "parent-owned-condition",
      severity: "warn",
      source: "PR #4506 §3 — 89 pending pairs, 9 blocked, 103 never-foldable",
      symptom: "A hand-placed primitive renders when the built-in surface would have hidden it, or vice versa.",
      cause: "The built-in template evaluates a visibility condition the primitive itself cannot.",
      rule: "A primitive with parentOwnedConditions placed standalone needs the condition re-expressed in customer code.",
      lintRule: "P6",
      instrumentedUpstream: true,
    },
    {
      id: "dialog-root-rejects-children",
      severity: "error",
      source: "PR #4506 capability exceptions + tag registry",
      symptom: "Markup placed inside <VeltCommentDialog> does not render.",
      cause: "velt-comment-dialog (and velt-comment-dialog-thread) are not in the children-accepting tag registry; the dialog root orchestrates via #host + shadow DOM across three render modes. velt-comment-dialog-composer IS in the registry.",
      rule: "Do not use VeltCommentDialog as a container in a primitives build. Compose its parts directly.",
      lintRule: "P2",
      instrumentedUpstream: true,
    },
    {
      id: "shadowdom-inheritance",
      severity: "warn",
      source: "PR #4506 §7 risks",
      symptom: "Class-based CSS silently stops applying to a hand-placed primitive while --velt-* variables still work, so it reads as 'some CSS is randomly ignored'.",
      cause: "Hand-placed primitives now INHERIT flags they previously defaulted, including shadowDom.",
      rule: "Resolve the effective shadowDom value on the composed tree BEFORE choosing a CSS strategy.",
      lintRule: null,
      instrumentedUpstream: false,
    },
    {
      id: "repeater-children-render-once",
      severity: "error",
      source: "primitives-children (R1)",
      symptom: "A list renders one row instead of N.",
      cause: "Children on a repeating container render once, not per item.",
      rule: "Own the loop in customer code; R2 feeds each row its context.",
      lintRule: "P5",
      instrumentedUpstream: true,
    },
    {
      id: "bare-text-children",
      severity: "error",
      source: "primitives-children (R1)",
      symptom: "Text placed directly inside a primitive does not render.",
      cause: "Plain-text children are not supported; children must be elements.",
      rule: "Wrap text in an element: <span>text</span>.",
      lintRule: "P3",
      instrumentedUpstream: true,
    },
    {
      id: "unstable-react-root-child",
      severity: "error",
      source: "primitives-children (R1)",
      symptom: "Children vanish or duplicate across re-renders.",
      cause: "Children are MOVED, not cloned; swapping the top-level child element each render breaks the move.",
      rule: "Pass one stable root element; wrap variable content inside it.",
      lintRule: "P4",
      instrumentedUpstream: false,
    },
    {
      id: "virtualization-divergence",
      severity: "info",
      source: "PR #4506 open issue #5",
      symptom: "A hand-composed sidebar renders all rows where the built-in virtualises (72 vs 15).",
      cause: "The built-in list virtualises; a hand-rolled loop does not.",
      rule: "Expect a row-count divergence vs the default surface. Judge must not score this as a structural failure.",
      lintRule: null,
      instrumentedUpstream: false,
    },
    {
      id: "mutating-actions-unverified",
      severity: "warn",
      source: "PR #4506 §4 — functional testing still unrun",
      symptom: "Unknown. Delete thread, mark-all-read/resolved, make private, assign, unsubscribe, accept/reject suggestion, edit, attachments and recordings were never exercised hand-composed.",
      cause: "Not tested upstream at snapshot time.",
      rule: "Do not claim behavioural verification for these actions in a primitives build; report them as unverified.",
      lintRule: null,
      instrumentedUpstream: false,
    },
  ];

  return manifest;
}

const stable = (o) => JSON.stringify(o, null, 2) + "\n";

async function main() {
  await fs.mkdir(SRC, { recursive: true });
  const sdk = val("--sdk");
  if (sdk) { console.log(`re-vendoring from ${sdk}`); await vendorFromSdk(sdk); }

  const manifest = await build();
  const next = stable(manifest);

  if (flag("--check")) {
    const cur = await fs.readFile(OUT, "utf8").catch(() => null);
    if (cur === null) { console.error("✗ manifest/velt-primitives.json missing — run: node scripts/sync-primitives.mjs"); process.exit(1); }
    if (cur !== next) { console.error("✗ manifest/velt-primitives.json is STALE vs manifest/primitives-src/ — run: node scripts/sync-primitives.mjs"); process.exit(1); }
    console.log("✓ velt-primitives.json is in sync with the vendored SDK snapshot");
    return;
  }

  await fs.writeFile(OUT, next);
  const { integrity, counts, parity } = manifest;
  console.log(`✓ wrote manifest/velt-primitives.json`);
  console.log(`  ${counts.tagsAcceptingChildren} tags accepting children · ${Object.keys(manifest.families).length} families · R3 getters: ${Object.keys(R3_GETTERS).length}`);
  console.log(`  parity: ${parity.slotsWithNoPrimitive}/${parity.wireframeSlotKeys} wireframe slots have NO primitive counterpart (measured ${parity.measuredOn})`);
  console.log(`  compound triggers: ${Object.values(manifest.primitives).filter((p) => p.requiresTriggerAncestor).length} leaves require a -trigger ancestor`);
  console.log(`  parent-owned conditions: ${Object.values(manifest.primitives).filter((p) => p.parentOwnedConditions).length} primitives affected`);
  if (integrity.familyDrift.length) { console.warn(`⚠ family count drift vs the SDK matrix:`); for (const d of integrity.familyDrift) console.warn(`    ${d.family}: SDK matrix ${d.sdkMatrix}, derived from tags ${d.derivedFromTags}`); }
  if (integrity.unknownFamily.length) console.warn(`⚠ ${integrity.unknownFamily.length} tag(s) with no family prefix rule: ${integrity.unknownFamily.slice(0, 5).join(", ")}${integrity.unknownFamily.length > 5 ? " …" : ""}`);
}

main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

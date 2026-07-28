#!/usr/bin/env node
// defect-contract.mjs — Judge→Builder typed defect contract.
//
// Judge reports FACTS + defect type. Builder chooses the fixing mechanism.
// Uncertain root cause → replan. Never default unknown findings to CSS/style.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CATEGORIES = ["style", "layout", "structure", "wireframe", "behavior", "host-wiring", "uncertain"];
const MODES = ["style", "structure", "wireframe", "host-wiring", "behavior", "replan"];

/** Heuristic rules — first match wins. Match against issueKey slug / source / KIND. */
const RULES = [
  // Host / plan / contract
  { match: [/host-wiring/i], category: "host-wiring", detector: "DOM", requiredMode: "host-wiring", confidence: "high", component: "host" },
  { match: [/plan-error\(structure\)/i], category: "structure", detector: "DOM", requiredMode: "replan", confidence: "high", component: "plan-structure" },
  { match: [/plan-error\(style\)/i], category: "style", detector: "probe", requiredMode: "replan", confidence: "high", component: "plan-style" },
  { match: [/\.MISSING\b/, /CONTAINMENT/, /CARDINALITY/, /PHANTOM_INTERACTIVE/, /mount-map/i, /^contract\./],
    category: "structure", detector: "mount-map", requiredMode: "structure", confidence: "high", component: "velt-slot" },

  // Wireframe / slot / glyph presence that CSS must not fake
  { match: [/chevron|more-reply|show-replies|show-n-replies|mustSupply|slot-missing|wireframe/i],
    category: "wireframe", detector: "vision", requiredMode: "wireframe", confidence: "medium", component: "MoreReply" },
  { match: [/reply-inside-card|card-stack-structure|thread-grouping|detached/i],
    category: "structure", detector: "DOM", requiredMode: "structure", confidence: "high", component: "ThreadCard" },

  // Behavior / interaction
  { match: [/resolve-on-hover|hover-actions|kebab-on-hover|smoke\..*hover/i],
    category: "behavior", detector: "interaction", requiredMode: "behavior", confidence: "high", component: "Options/Resolve" },
  { match: [/focus-state|selected-state-paint|click-state|interaction-/i],
    category: "behavior", detector: "interaction", requiredMode: "behavior", confidence: "medium", component: "interactive-control" },
  { match: [/\.KIND.*hover|^hover$/i], category: "behavior", detector: "interaction", requiredMode: "behavior", confidence: "medium", component: "interactive-control" },

  // Layout / spacing (CSS-appropriate)
  { match: [/list-gap|comment-gap|list-gap-too-tight|card-internal-spacing|section-spacing|layout-spacing|content-alignment|overflow-clip/i],
    category: "layout", detector: "probe", requiredMode: "style", confidence: "high", component: "list/card" },
  { match: [/single-card-height|composer-height|sidebar-shape/i],
    category: "layout", detector: "probe", requiredMode: "style", confidence: "medium", component: "card/composer" },

  // Style / paint
  { match: [/renders-serif|font-|typography/i],
    category: "style", detector: "probe", requiredMode: "style", confidence: "high", component: "typography" },
  { match: [/card-border|composer-pill|composer-missing-shadow|box-shadow|border-token|card-ring|hover-background|subtle-paint/i],
    category: "style", detector: "probe", requiredMode: "style", confidence: "medium", component: "paint" },
  { match: [/placeholder|selected-reply-placeholder|composer-placeholder/i],
    category: "style", detector: "probe", requiredMode: "style", confidence: "medium", component: "Composer" },
  { match: [/mechanism\./i],
    category: "style", detector: "probe", requiredMode: "style", confidence: "medium", component: "mechanism" },
];

const SPACING_SLUGS = new Set([
  "list-gap", "comment-gap", "list-gap-too-tight", "card-internal-spacing",
  "section-spacing", "layout-spacing", "content-alignment",
]);

function slugOf(row) {
  return String(row.issueKey || "").split(".").pop() || "";
}

function haystack(row) {
  return [
    String(row.issueKey || ""),
    slugOf(row),
    String(row.attribution || ""),
    String(row.property || ""),
    String(row.contractKind || ""),
    String(row.KIND || ""),
    String(row.source || ""),
    String(row.rendered || ""),
  ].join(" | ");
}

function detectorFromSource(source, fallback) {
  if (source === "vision") return "vision";
  if (source === "composed-audit") return "probe";
  if (source === "contract-probe" || source === "mount-map") return "mount-map";
  if (source === "smoke" || source === "interaction") return "interaction";
  if (source === "host-wiring" || source === "delta-compare") return "DOM";
  return fallback || "probe";
}

function affectedFromSlug(slug, hint) {
  if (hint) return hint;
  if (/header|serif|font/i.test(slug)) return "SidebarHeader";
  if (/composer|placeholder|pill/i.test(slug)) return "Composer";
  if (/more-reply|chevron|show-replies/i.test(slug)) return "MoreReply";
  if (/resolve|options|kebab|hover/i.test(slug)) return "ThreadCard.Actions";
  if (/reply|togglereply/i.test(slug)) return "ToggleReply";
  if (/card|list-gap|spacing|border/i.test(slug)) return "ThreadCard";
  if (/host/i.test(slug)) return "host";
  return "unknown";
}

/**
 * Classify a defect row into the Judge→Builder contract fields.
 * Unknown / unmatched → category=uncertain, requiredMode=replan (never style).
 */
export function classifyDefect(row = {}) {
  const hay = haystack(row);
  const slug = slugOf(row);
  // KIND=hover short-circuit
  if (String(row.KIND || "").toLowerCase() === "hover" || /resolve-on-hover|hover-actions/i.test(slug)) {
    return {
      category: "behavior",
      detector: detectorFromSource(row.source, "interaction"),
      evidence: row.evidence ?? null,
      affectedComponent: affectedFromSlug(slug, "ThreadCard.Actions"),
      requiredMode: "behavior",
      confidence: "high",
      rootCause: row.rootCause || "interaction reveal missing — drive hover/selected and fix event/state or reveal host",
    };
  }
  for (const rule of RULES) {
    if (rule.match.some((re) => re.test(hay) || re.test(slug))) {
      return {
        category: rule.category,
        detector: detectorFromSource(row.source, rule.detector),
        evidence: row.evidence ?? null,
        affectedComponent: affectedFromSlug(slug, rule.component),
        requiredMode: rule.requiredMode,
        confidence: rule.confidence,
        rootCause: row.rootCause || null,
      };
    }
  }
  // Uncertain — NEVER CSS default
  return {
    category: "uncertain",
    detector: detectorFromSource(row.source, "vision"),
    evidence: row.evidence ?? null,
    affectedComponent: affectedFromSlug(slug, null),
    requiredMode: "replan",
    confidence: "low",
    rootCause: row.rootCause || "uncertain root cause — replan; never guess with CSS",
  };
}

/** Merge related spacing symptoms into one root-cause row. */
export function mergeSymptomGroups(rows = []) {
  const spacing = [];
  const rest = [];
  for (const r of rows) {
    if (SPACING_SLUGS.has(slugOf(r))) spacing.push(r);
    else rest.push(r);
  }
  if (spacing.length <= 1) return rows;
  const primary = [...spacing].sort((a, b) => {
    const sw = (s) => (s === "vision" ? 0 : s === "composed-audit" ? 1 : 2);
    return sw(a.source) - sw(b.source);
  })[0];
  const merged = {
    ...primary,
    issueKey: primary.issueKey.replace(/\.[^.]+$/, ".vertical-rhythm"),
    canonicalId: "vertical-rhythm",
    rootCauseGroup: "vertical-rhythm",
    tier: spacing.some((s) => s.tier === "P0") ? "P0" : primary.tier,
    rank: Math.min(...spacing.map((s) => s.rank ?? 99)),
    symptoms: spacing.map((s) => ({
      issueKey: s.issueKey,
      source: s.source,
      rendered: s.rendered,
      evidence: s.evidence,
    })),
    rendered: `vertical rhythm off — merged ${spacing.length} spacing symptoms (${spacing.map((s) => slugOf(s)).join(", ")})`,
    rootCause: "shared vertical-rhythm / gap tokens — fix list+card spacing as one layout root cause",
    category: "layout",
    detector: "probe",
    requiredMode: "style",
    confidence: "high",
    affectedComponent: "list/card",
    affectedBlocks: [...new Set(spacing.flatMap((s) => s.affectedBlocks || (s.block ? [s.block] : [])))],
  };
  return [merged, ...rest];
}

/**
 * Stamp contract fields on every row; align route{} with requiredMode.
 * Does not invent CSS remedies for structure/wireframe/behavior/replan.
 */
export function enrichWorkOrder(rows = [], { merge = true } = {}) {
  const base = merge ? mergeSymptomGroups(rows) : rows.slice();
  return base.map((r) => {
    const c = classifyDefect(r);
    const requiredMode = c.requiredMode;
    const remedy = remedyFor(requiredMode, c.category);
    return {
      ...r,
      category: c.category,
      detector: c.detector,
      evidence: r.evidence ?? c.evidence,
      affectedComponent: c.affectedComponent,
      requiredMode,
      confidence: c.confidence,
      rootCause: c.rootCause || r.rootCause || null,
      rootCauseGroup: r.rootCauseGroup || c.rootCauseGroup || null,
      symptoms: r.symptoms || undefined,
      route: {
        ...(typeof r.route === "object" && r.route ? r.route : {}),
        mode: requiredMode,
        category: c.category,
        remedy,
        // Builder chooses mechanism — Judge only types the defect
        builderChoosesMechanism: true,
      },
    };
  });
}

function remedyFor(mode, category) {
  switch (mode) {
    case "style":
      return category === "layout"
        ? "layout CSS (gap/box/spacing) — verify with re-measure, not CSS to hide structure"
        : "style/paint CSS via DEMO-POLISH — values from plan; mechanism only";
    case "structure":
      return "inspect DOM parent-child/order, then modify component structure — never CSS imitation";
    case "wireframe":
      return "inspect wireframe/template source; correct slots/components/nesting — never CSS to fake a missing slot";
    case "host-wiring":
      return "fix mounting/context/configuration (verify-host-wiring --apply)";
    case "behavior":
      return "run interaction flow (hover/selected/focus/click); fix event/state/reveal logic";
    case "replan":
    default:
      return "uncertain root cause — replan; never guess with CSS";
  }
}

export async function loadTrapRouting() {
  try {
    return JSON.parse(await fs.readFile(path.join(ROOT, "knowledge", "trap-routing.json"), "utf8"));
  } catch {
    return { defaultRoute: { mode: "replan" }, traps: [], modes: MODES };
  }
}

/** Compatibility wrapper used by emit — prefers trap matches, else classifyDefect. */
export function routeForContract(row, manifest) {
  const parts = [
    String(row.issueKey || ""),
    slugOf(row),
    String(row.attribution || ""),
    String(row.property || ""),
    String(row.contractKind || ""),
  ];
  const classified = classifyDefect(row);
  for (const trap of manifest?.traps || []) {
    for (const m of trap.match || []) {
      if (parts.some((h) => h === m || h.startsWith(m) || (m.length > 4 && h.includes(m)))) {
        let mode = trap.mode;
        // Never let a style trap override a structural/wireframe/behavior classification
        if (trap.mode === "style" && ["structure", "wireframe", "behavior", "host-wiring"].includes(classified.category)) {
          mode = classified.requiredMode;
        }
        if (classified.category === "uncertain" && mode === "style") mode = "replan";
        return {
          manifestId: trap.id,
          mode,
          category: trap.category || classified.category,
          remedy: trap.builderRemedy || remedyFor(mode, classified.category),
          builderChoosesMechanism: true,
        };
      }
    }
  }
  const d = manifest?.defaultRoute || { mode: "replan", remedy: remedyFor("replan", "uncertain") };
  return {
    manifestId: "(default)",
    mode: classified.requiredMode || (d.mode === "style" ? "replan" : d.mode),
    category: classified.category,
    remedy: d.remedy || remedyFor(classified.requiredMode, classified.category),
    builderChoosesMechanism: true,
  };
}

export { CATEGORIES, MODES };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sample = process.argv[2] ? JSON.parse(process.argv[2]) : { issueKey: "composed.flow.unknown" };
  console.log(JSON.stringify(classifyDefect(sample), null, 2));
}

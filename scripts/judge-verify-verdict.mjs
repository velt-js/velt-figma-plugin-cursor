#!/usr/bin/env node
// judge-verify-verdict.mjs — strict Judge verification verdict.
//
// Plain PASS is banned whenever any failCriteria flag is true.
// Soft degradations (missing CDP, unresolved selectors, unavailable hover) → PASS-DEGRADED.
// Hard integrity failures (orphans, blank crops, generic P0 ids, duplicates) → FAIL.

import { pathToFileURL } from "node:url";

const HARD_FAIL = new Set([
  "orphanedVision",
  "duplicateIssueKeys",
  "duplicateIdentities",
  "genericP0Ids",
  "blankCrops",
  "missingRouting",
  "perBlockIdentityNotPreserved",
  "runFailed",
  // Phase 3 (R-D): structure PASS requires the LIVE-DOM contract validator green —
  // wireframe-source-validate alone is insufficient (pixels can compensate reparenting).
  "structuralContractViolations",
  "structuralContractUnvalidated",
  // Phase 2 (RC5): state frames judged without their state driven+confirmed.
  "stateCoverageIncomplete",
  // Phase 4 (RC4): a pixel-diff region no finding explains, still unresolved on the ladder
  // (needs-glance / needs-sweep), or an accepted-residual missing crops+expiry.
  "unresolvedContradictions",
]);

const DEGRADED = new Set([
  "selectorLiveUnresolved",
  "selectorHintMissing",
  "evidenceWithoutConnect",
  "hoverCaptureUnavailable",
  "cdpUnavailable",
  "degradedSource",
  "nullRequiredSelectors",
]);

/**
 * @param {{ failCriteria?: Record<string, boolean|string>, notes?: string[] }} input
 * @returns {{ verdict: "PASS"|"PASS-DEGRADED"|"FAIL", reasons: string[], hard: string[], degraded: string[] }}
 */
export function judgeVerifyVerdict(input = {}) {
  const fc = input.failCriteria || {};
  const hard = [];
  const degraded = [];
  for (const [k, v] of Object.entries(fc)) {
    if (!v) continue;
    if (HARD_FAIL.has(k)) hard.push(k);
    else if (DEGRADED.has(k)) degraded.push(k);
    else degraded.push(k); // unknown true flags degrade, never silent PASS
  }
  if (hard.length) {
    return { verdict: "FAIL", reasons: hard, hard, degraded };
  }
  if (degraded.length) {
    return { verdict: "PASS-DEGRADED", reasons: degraded, hard, degraded };
  }
  return { verdict: "PASS", reasons: [], hard: [], degraded: [] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = process.argv[2];
  const input = raw ? JSON.parse(raw) : { failCriteria: {} };
  console.log(JSON.stringify(judgeVerifyVerdict(input), null, 2));
}

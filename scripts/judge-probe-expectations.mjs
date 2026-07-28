#!/usr/bin/env node
// judge-probe-expectations.mjs — design-sourced expected values for composed-audit probes.
//
// Every probe expectation MUST cite plan-style.json / plan-fills.json / designSpec.json.
// Live-DOM-derived expectations are rejected (expectedSource=live-dom).

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function loadJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

function parsePx(v) {
  if (typeof v === "number") return v;
  const m = String(v || "").match(/(-?\d+(?:\.\d+)?)\s*px/i);
  return m ? parseFloat(m[1]) : null;
}

function findRule(planStyle, selector, { state } = {}) {
  const rules = planStyle?.rules || planStyle?.styleRules || [];
  return rules.find((r) => {
    if (String(r.selector || "") !== selector) return false;
    if (state && r.state && r.state !== state) return false;
    return true;
  }) || rules.find((r) => String(r.selector || "") === selector) || null;
}

function hostProp(planFills, name) {
  const rows = planFills?.hostProps || planFills?.props || [];
  const flat = Array.isArray(rows) ? rows : [];
  // Nested shapes used by real phases: families[], planJson.components[], components[]
  const nested = [];
  const bags = [
    ...(planFills?.families || []),
    ...(planFills?.components || []),
    ...(planFills?.planJson?.components || []),
  ];
  for (const bag of bags) {
    for (const hp of bag.hostProps || []) nested.push(hp);
  }
  // Deep fallback — any {prop,value} object matching name
  if (![...flat, ...nested].some((h) => h.prop === name || h.name === name)) {
    const stack = [planFills];
    while (stack.length) {
      const o = stack.pop();
      if (!o || typeof o !== "object") continue;
      if ((o.prop === name || o.name === name) && o.value != null) return o;
      if (Array.isArray(o)) stack.push(...o);
      else stack.push(...Object.values(o));
    }
  }
  return [...flat, ...nested].find((h) => h.prop === name || h.name === name) || null;
}

/** Reject probes with no design provenance or live-DOM expectedSource. */
export function validateProbe(probe) {
  if (!probe) return { ok: false, reason: "missing probe" };
  if (!probe.expectedSource || probe.expectedSource === "live-dom") {
    return { ok: false, reason: `expectedSource must be a design artifact (got ${probe.expectedSource || "null"})` };
  }
  if (!probe.designPath) {
    return { ok: false, reason: "designPath required" };
  }
  if (probe.expected === undefined || probe.expected === null || probe.expected === "") {
    return { ok: false, reason: "expected value required" };
  }
  return { ok: true };
}

/**
 * Load design-sourced probe expectations from phase artifacts.
 * @returns {{ probes: object[], fonts: string[], rejectLiveDom: true }}
 */
export async function loadProbeExpectations(phaseDir) {
  const planStyle = await loadJson(path.join(phaseDir, "plan-style.json"));
  const planFills = await loadJson(path.join(phaseDir, "plan-fills.json"));
  const designSpec = await loadJson(path.join(phaseDir, "designSpec.json"));
  const probes = [];

  // list-gap — plan-style .vc-list gap (design: 16px)
  const listRule = findRule(planStyle, ".vc-list");
  const listGap = parsePx(listRule?.decls?.gap);
  if (listGap != null) {
    probes.push({
      id: "list-gap",
      aliases: ["comment-gap"],
      expected: listGap,
      unit: "px",
      tolerance: 2,
      expectedSource: "plan-style.json",
      designPath: `rules[selector=.vc-list].decls.gap`,
      specNodeId: listRule?.specNodeId || null,
    });
  }

  // major internal spacing — .vc-body gap + padding
  const bodyRule = findRule(planStyle, ".vc-body");
  const bodyGap = parsePx(bodyRule?.decls?.gap);
  const bodyPad = parsePx(String(bodyRule?.decls?.padding || "").split(/\s+/)[0]);
  if (bodyGap != null) {
    probes.push({
      id: "card-internal-spacing",
      expected: bodyGap,
      unit: "px",
      tolerance: 2,
      expectedSource: "plan-style.json",
      designPath: `rules[selector=.vc-body].decls.gap`,
      specNodeId: bodyRule?.specNodeId || null,
      also: bodyPad != null ? { padding: bodyPad, designPath: "rules[selector=.vc-body].decls.padding" } : null,
    });
  }

  // single-card height — ONLY from design artifacts (plan-fills box.h or designSpec frameRegion)
  const dialogRule = findRule(planStyle, ".vc-dialogcontainer") || bodyRule;
  let designCardH = null;
  let designCardPath = null;
  // Preference: .vc-card (single annotation card) > .vc-body > .vc-dialogcontainer
  const heightRank = { ".vc-card": 3, ".vc-body": 2, ".vc-dialogcontainer": 1 };
  let bestRank = 0;
  function walk(o, trail = "") {
    if (!o || typeof o !== "object") return;
    const vc = o.vcClass || o.selector;
    if (vc && heightRank[vc] && o.box?.h != null && heightRank[vc] >= bestRank) {
      designCardH = Number(o.box.h);
      designCardPath = `${trail}vcClass=${vc}.box.h`;
      bestRank = heightRank[vc];
    }
    if (Array.isArray(o)) o.forEach((v, i) => walk(v, `${trail}[${i}].`));
    else {
      for (const [k, v] of Object.entries(o)) walk(v, `${trail}${k}.`);
    }
  }
  walk(planFills);
  const selectedFixture = designSpec?.probeBriefs?.["state-comment-thread-components-single-comment-dialog"]
    || designSpec?.blocks?.["state-comment-thread-components-single-comment-dialog"]
    || designSpec?.fixtures?.["state-comment-thread-components-single-comment-dialog"];
  const frameH = selectedFixture?.frameRegion?.h
    ?? designSpec?.probeExpectations?.["single-card-height"]?.expected
    ?? null;
  let cardHeight = null;
  let heightSource = null;
  let heightPath = null;
  if (designCardH != null && Number.isFinite(designCardH)) {
    cardHeight = designCardH;
    heightSource = "plan-fills.json";
    heightPath = designCardPath || "plan-fills…vcClass=.vc-body.box.h";
  } else if (typeof frameH === "number" && Number.isFinite(frameH)) {
    // designSpec stores device px; if value looks like a CSS card (~80–200) keep as-is, else scale
    cardHeight = frameH > 400 ? Math.round(frameH / 2) : Math.round(frameH);
    heightSource = "designSpec.json";
    heightPath = selectedFixture?.frameRegion
      ? "designSpec.blocks[single-comment-dialog].frameRegion.h"
      : "designSpec.probeExpectations[single-card-height].expected";
  }
  if (cardHeight != null) {
    probes.push({
      id: "single-card-height",
      expected: cardHeight,
      unit: "px",
      tolerance: Math.max(16, Math.round(cardHeight * 0.25)),
      expectedSource: heightSource,
      designPath: heightPath,
      specNodeId: bodyRule?.specNodeId || dialogRule?.specNodeId || null,
    });
  }

  // selected reply-composer placeholder — plan-fills hostProps.replyPlaceholder
  const replyPh = hostProp(planFills, "replyPlaceholder");
  if (replyPh?.value) {
    probes.push({
      id: "selected-reply-placeholder",
      expected: String(replyPh.value),
      expectedSource: "plan-fills.json",
      designPath: `hostProps[prop=replyPlaceholder].value`,
      match: "reply\\s*to",
    });
  }

  // fonts
  const fonts = new Set();
  if (planStyle?.tokens?.["font-family"]) {
    const first = String(planStyle.tokens["font-family"]).split(",")[0].replace(/["']/g, "").trim();
    if (first) fonts.add(first);
  }
  for (const r of planStyle?.rules || []) {
    const ff = r.decls?.["font-family"] || r.decls?.fontFamily;
    if (!ff) continue;
    const first = String(ff).split(",")[0].replace(/["']/g, "").trim();
    if (first && !/^(serif|sans-serif|monospace|system-ui)/i.test(first)) fonts.add(first);
  }

  // Validate all
  for (const p of probes) {
    const v = validateProbe(p);
    if (!v.ok) throw new Error(`probe expectation invalid (${p.id}): ${v.reason}`);
  }

  return { probes, fonts: [...fonts], rejectLiveDom: true, validateProbe };
}

export function expectationById(bundle, id) {
  return (bundle?.probes || []).find((p) => p.id === id || (p.aliases || []).includes(id)) || null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const phase = process.argv[2];
  if (!phase) {
    console.error("usage: judge-probe-expectations.mjs <phaseDir>");
    process.exit(1);
  }
  loadProbeExpectations(phase).then((ex) => {
    console.log(JSON.stringify(ex, null, 2));
  }).catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

#!/usr/bin/env node
// structural-contract-validate.mjs — Phase 3 of the design-compiled oracle.
//
// A demo can be pixel-perfect and structurally WRONG (Reply reparented outside the card
// with pixels compensated; timestamp reordered before the name). wireframe-source-validate
// checks the SOURCE; this validator checks the LIVE DOM against structural-contract.json:
//   - containment:            child must sit inside its required ancestor
//   - sibling-order:          landmarks appear in the declared order along an axis
//   - cardinality:            selector count within [min,max]
//   - interaction-ownership:  the element that receives the pointer at a control's center
//                             must belong to the declared owner (hit-testing, not source)
//   - substitution ledger:    every declared substitution is re-justified EVERY run
//                             (reverify.expect present|absent) — a substitution must not
//                             outlive its excuse silently.
//
// OBSERVE (in-page, returns facts) is split from EVALUATE (pure, exported) so the golden
// mutation drills can feed synthetic observations (M10/M11) without a browser.
//
// Results: pass | fail | blocked(reason) only. Exit 2 on any fail; violations are merged
// (--write) into appearance/<block>.json as `contract.<id>` rows → emit routes them
// mode=structure via trap-routing (never the CSS loop).
//
// Usage: node scripts/structural-contract-validate.mjs <phaseDir> [--connect <ws>] [--url <url>] [--write]

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

async function loadJson(p) { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; } }

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    "playwright-core",
    path.join(process.env.HOME || "", ".claude/skills/gstack/node_modules/playwright-core/index.js"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const mod = c.startsWith("/") || c.startsWith(".") ? require(c) : await import(c);
      const pw = mod.default || mod;
      if (pw.chromium) return pw.chromium;
    } catch { /* next */ }
  }
  throw new Error("playwright-core not found — set $PLAYWRIGHT_CORE or npm i -D playwright-core");
}

export function validateContractDoc(doc) {
  const problems = [];
  const KINDS = new Set(["containment", "sibling-order", "cardinality", "interaction-ownership"]);
  for (const [i, c] of (doc?.contracts || []).entries()) {
    if (!c.id) problems.push(`contracts[${i}]: id required`);
    if (!KINDS.has(c.kind)) problems.push(`contracts[${i}] ${c.id}: kind must be one of ${[...KINDS].join("|")}`);
    if (c.kind === "containment" && (!c.child || !c.ancestor)) problems.push(`${c.id}: containment needs child+ancestor`);
    if (c.kind === "sibling-order" && (!c.parent || !Array.isArray(c.order) || c.order.length < 2)) problems.push(`${c.id}: sibling-order needs parent+order[≥2]`);
    if (c.kind === "cardinality" && (!c.selector || (c.min == null && c.max == null))) problems.push(`${c.id}: cardinality needs selector+min/max`);
    if (c.kind === "interaction-ownership" && (!c.selector || !c.owner)) problems.push(`${c.id}: interaction-ownership needs selector+owner`);
  }
  for (const [i, s] of (doc?.substitutions || []).entries()) {
    if (!s.id || !s.what) problems.push(`substitutions[${i}]: id+what required`);
    if (!s.sdkGap) problems.push(`substitutions[${i}] ${s.id}: sdkGap justification required`);
    if (!s.reverify?.selector || !["present", "absent"].includes(s.reverify?.expect)) {
      problems.push(`substitutions[${i}] ${s.id}: reverify{selector, expect:present|absent} required — a substitution must be re-justified every run`);
    }
  }
  if (!(doc?.contracts || []).length) problems.push("contracts[] empty");
  return problems;
}

/** Pure evaluation over observed facts — the mutation drills' entry point. */
export function evaluateStructuralContract(contractDoc, observed) {
  const results = [];
  for (const c of contractDoc.contracts || []) {
    const o = observed.contracts?.[c.id];
    const res = { id: `contract.${c.id}`, kind: c.kind, note: c.note || "" };
    if (!o) { results.push({ ...res, status: "blocked", reason: "no observation for this contract row" }); continue; }
    if (o.blocked) { results.push({ ...res, status: "blocked", reason: o.blocked }); continue; }
    if (c.kind === "containment") {
      results.push({ ...res, status: o.contained ? "pass" : "fail", observed: o, expected: `${c.child} inside ${c.ancestor}` });
    } else if (c.kind === "sibling-order") {
      const want = c.order.join(" → ");
      const got = (o.order || []).join(" → ");
      results.push({ ...res, status: got === want ? "pass" : "fail", observed: got, expected: want });
    } else if (c.kind === "cardinality") {
      const n = o.count ?? -1;
      const ok = (c.min == null || n >= c.min) && (c.max == null || n <= c.max);
      results.push({ ...res, status: ok ? "pass" : "fail", observed: n, expected: `[${c.min ?? "-"}..${c.max ?? "-"}]` });
    } else if (c.kind === "interaction-ownership") {
      results.push({ ...res, status: o.ownerHit ? "pass" : "fail", observed: o.hit || "(nothing)", expected: `pointer at ${c.selector} center lands inside ${c.owner}` });
    }
  }
  for (const s of contractDoc.substitutions || []) {
    const o = observed.substitutions?.[s.id];
    const res = { id: `substitution.${s.id}`, kind: "substitution", what: s.what, sdkGap: s.sdkGap };
    if (!o) { results.push({ ...res, status: "blocked", reason: "no observation" }); continue; }
    const justified = s.reverify.expect === "absent" ? !o.reverifyMatched : o.reverifyMatched;
    results.push({
      ...res,
      status: justified ? "pass" : "fail",
      observed: `reverify '${s.reverify.selector}' ${o.reverifyMatched ? "present" : "absent"}`,
      expected: `${s.reverify.expect} (else the substitution outlived its excuse — remove it and use the SDK slot)`,
    });
  }
  return results;
}

// In-page observer — collects facts only, no judgement.
// Exported for mutation-drill.mjs (Phase 6) — the drill runs the SAME observer, not a copy.
export const OBSERVE = `(function(DOC){
  function vis(el){ if(!el||!el.getBoundingClientRect) return false; const r=el.getBoundingClientRect(); const cs=getComputedStyle(el); return r.width>1 && r.height>1 && cs.display!=='none' && cs.visibility!=='hidden'; }
  const panel = [...document.querySelectorAll('app-comment-sidebar-panel, .vc-panel, .hw-rail-inner, .hw-rail')].filter(vis)[0] || document.body;
  function q(sel){ const out=[]; for (const s of String(sel).split(',').map(x=>x.trim()).filter(Boolean)){ try { for (const el of panel.querySelectorAll(s)) if (vis(el)) out.push(el); } catch(e){} if(out.length) break; }
    if (!out.length) for (const s of String(sel).split(',').map(x=>x.trim()).filter(Boolean)){ try { for (const el of document.querySelectorAll(s)) if (vis(el)) out.push(el); } catch(e){} if(out.length) break; }
    return out; }
  function one(sel){ return q(sel)[0] || null; }
  function deepElementFromPoint(x,y){ let el=document.elementFromPoint(x,y), guard=0; while(el&&el.shadowRoot&&guard++<8){ const inner=el.shadowRoot.elementFromPoint(x,y); if(!inner||inner===el) break; el=inner; } return el; }
  function matchesAny(el, sel){ for (const s of String(sel).split(',').map(x=>x.trim()).filter(Boolean)){ try { if (el.closest(s)) return true; } catch(e){} } return false; }
  const out = { contracts: {}, substitutions: {} };
  for (const c of (DOC.contracts||[])) {
    try {
      if (c.kind==='containment'){
        const child = one(c.child);
        if (!child){ out.contracts[c.id]={ blocked: 'child unresolved: '+c.child }; continue; }
        out.contracts[c.id] = { contained: matchesAny(child, c.ancestor), childTag: child.tagName.toLowerCase() };
      } else if (c.kind==='sibling-order'){
        const parent = one(c.parent);
        if (!parent){ out.contracts[c.id]={ blocked: 'parent unresolved: '+c.parent }; continue; }
        const found = [];
        for (const sel of c.order){
          const el = q(sel).find(e=>parent.contains(e));
          if (el){ const r=el.getBoundingClientRect(); found.push({ sel, pos: (c.axis==='y'? r.top : r.left) }); }
        }
        if (found.length < c.order.length){ out.contracts[c.id]={ blocked: 'landmark(s) unresolved: '+c.order.filter(s=>!found.some(f=>f.sel===s)).join(', ') }; continue; }
        out.contracts[c.id] = { order: found.sort((a,b)=>a.pos-b.pos).map(f=>f.sel) };
      } else if (c.kind==='cardinality'){
        out.contracts[c.id] = { count: q(c.selector).length };
      } else if (c.kind==='interaction-ownership'){
        const el = one(c.selector);
        if (!el){ out.contracts[c.id]={ blocked: 'selector unresolved: '+c.selector }; continue; }
        const r = el.getBoundingClientRect();
        const hit = deepElementFromPoint(r.left + r.width/2, r.top + r.height/2);
        out.contracts[c.id] = {
          ownerHit: !!(hit && matchesAny(hit, c.owner)),
          hit: hit ? (hit.tagName.toLowerCase() + (hit.className && hit.className.toString ? '.'+hit.className.toString().split(/\\s+/)[0] : '')) : null,
        };
      }
    } catch(e){ out.contracts[c.id] = { blocked: 'observer error: '+e.message }; }
  }
  for (const s of (DOC.substitutions||[])) {
    try { out.substitutions[s.id] = { reverifyMatched: q(s.reverify.selector).length > 0 }; }
    catch(e){ out.substitutions[s.id] = null; }
  }
  return out;
})`;

async function main() {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const phaseDir = args.find((a, i) => !a.startsWith("--") && (i === 0 || !["--connect", "--url"].includes(args[i - 1])));
  if (!phaseDir) { console.error("usage: structural-contract-validate.mjs <phaseDir> [--connect <ws>] [--url <url>] [--write]"); process.exit(1); }
  const doc = await loadJson(path.join(phaseDir, "structural-contract.json"));
  if (!doc) { console.error("✗ no structural-contract.json in phase dir"); process.exit(1); }
  const schemaProblems = validateContractDoc(doc);
  if (schemaProblems.length) {
    console.error("✗ structural-contract.json invalid:\n  " + schemaProblems.join("\n  "));
    process.exit(2);
  }

  const ws = flag("--connect") || "http://localhost:9222";
  const chromium = await loadPlaywright();
  const browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => /localhost|127\.0\.0\.1/.test(p.url())) || context.pages()[0];
  if (!page) { console.error("✗ no page in connected browser"); process.exit(1); }
  const url = flag("--url");
  if (url && !page.url().includes(new URL(url).host)) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(400);

  const observed = await page.evaluate(`(${OBSERVE})(${JSON.stringify(doc)})`);
  const results = evaluateStructuralContract(doc, observed);
  const summary = {
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail").length,
    blocked: results.filter((r) => r.status === "blocked").length,
  };
  const outDoc = { at: new Date().toISOString(), url: page.url(), family: doc.family || null, summary, results };
  await fs.writeFile(path.join(phaseDir, "structural-contract-results.json"), JSON.stringify(outDoc, null, 2) + "\n");
  console.log(`structural-contract: ${summary.pass} pass · ${summary.fail} fail · ${summary.blocked} blocked → structural-contract-results.json`);
  for (const r of results.filter((x) => x.status !== "pass")) {
    console.log(`  ${r.status === "fail" ? "✗" : "⛔"} ${r.id}: ${r.status === "fail" ? `expected ${r.expected}, observed ${JSON.stringify(r.observed)}` : r.reason}`);
  }

  if (args.includes("--write")) {
    const fails = results.filter((r) => r.status === "fail");
    const apPath = path.join(phaseDir, "appearance", "flow.json");
    const prev = (await loadJson(apPath)) || { blockId: "flow" };
    const kept = (prev.unresolved || []).filter((u) => u && u.source !== "structural-contract");
    prev.unresolved = [...kept, ...fails.map((r) => ({
      id: r.id,
      issue: `${r.kind}: expected ${r.expected}, observed ${JSON.stringify(r.observed)}${r.note ? ` — ${r.note}` : ""}`,
      summary: `structural contract violated: ${r.id}`,
      kind: "pixel",
      evidence: { expected: r.expected, observed: r.observed, kind: r.kind },
      source: "structural-contract",
    }))];
    if (prev.unresolved.length) prev.disposition = "open";
    await fs.mkdir(path.dirname(apPath), { recursive: true });
    await fs.writeFile(apPath, JSON.stringify(prev, null, 2) + "\n");
    console.log(`✓ merged ${fails.length} violation(s) into appearance/flow.json (source=structural-contract → mode=structure)`);
  }
  process.exit(summary.fail ? 2 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

#!/usr/bin/env node
// delta-compare.mjs — the measurement engine for the Judge. Compares a designSpec's exact
// cssDecls against rendered computed styles, per element, per property, and returns a delta
// table + a STRICT verdict (pass only if every property of every present element passes).
// No aggregate score (Design2Code) — a model can't hide a failure behind an average.
//
// The SAME functions power two consumers, so the logic is written once:
//   * the Judge injects `BROWSER_PROBE` via the host browser tool (Chrome MCP javascript_tool / Cursor CDP Runtime.evaluate) to read live
//     getComputedStyle/getBoundingClientRect and produce the delta table in-page;
//   * golden/ calibration imports compareDecls/verdictOf to prove the engine FAILs a known-bad
//     render and PASSes a known-good one (vs the golden fixtures).
//
// Tolerances: non-structural lengths ±2px, colour ΔE(CIEDE2000) < 2, keywords exact, font-family by
// family name. (±1px on every length invited plateau spirals on sub-pixel rendering noise — both run
// autopsies; structural geometry keeps its own compareBox/compareGap tolerances below.)

// ---- colour ----
export function parseColor(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) { const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; }
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  return null;
}
function rgbToLab({ r, g, b }) {
  let [R, G, B] = [r, g, b].map((v) => { v /= 255; return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92; });
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 1.0;
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  [x, y, z] = [x, y, z].map((v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116));
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
export function ciede2000(c1, c2) {
  const [L1, a1, b1] = rgbToLab(c1), [L2, a2, b2] = rgbToLab(c2);
  const avgL = (L1 + L2) / 2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), avgC = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(avgC ** 7 / (avgC ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2), avgCp = (C1p + C2p) / 2;
  const h = (x, y) => { let d = Math.atan2(y, x) * 180 / Math.PI; return d < 0 ? d + 360 : d; };
  const h1p = h(a1p, b1), h2p = h(a2p, b2);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = h2p - h1p; if (Math.abs(dhp) > 180) dhp -= Math.sign(dhp) * 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI / 180) / 2);
  let avghp = (h1p + h2p) / 2; if (Math.abs(h1p - h2p) > 180) avghp += 180;
  const T = 1 - 0.17 * Math.cos((avghp - 30) * Math.PI / 180) + 0.24 * Math.cos((2 * avghp) * Math.PI / 180)
    + 0.32 * Math.cos((3 * avghp + 6) * Math.PI / 180) - 0.2 * Math.cos((4 * avghp - 63) * Math.PI / 180);
  const SL = 1 + (0.015 * (avgL - 50) ** 2) / Math.sqrt(20 + (avgL - 50) ** 2);
  const SC = 1 + 0.045 * avgCp, SH = 1 + 0.015 * avgCp * T;
  const dTheta = 30 * Math.exp(-(((avghp - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(avgCp ** 7 / (avgCp ** 7 + 25 ** 7));
  const RT = -RC * Math.sin(2 * dTheta * Math.PI / 180);
  return Math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH));
}

// ---- per-property comparison ----
const COLOR_PROPS = new Set(["color", "background", "background-color", "border-color", "fill", "stroke", "outline-color"]);
const LEN_PROPS = new Set(["gap", "padding", "margin", "border-radius", "font-size", "line-height", "letter-spacing", "width", "height", "row-gap", "column-gap"]);
const nums = (s) => (String(s).match(/-?\d+(\.\d+)?/g) || []).map(Number);

export function compareProp(prop, expected, rendered, tol = {}) {
  const px = tol.px ?? 2, dE = tol.dE ?? 2;   // ±2px default on non-structural lengths (pass tol.px:1 to tighten)
  if (COLOR_PROPS.has(prop)) {
    const a = parseColor(expected), b = parseColor(rendered);
    if (!a || !b) return { pass: a === b, why: "unparseable colour" };
    if ((a.a === 0) !== (b.a === 0)) return { pass: false, why: "alpha/transparency differs" };
    const d = ciede2000(a, b);
    return { pass: d < dE, delta: `ΔE ${d.toFixed(2)}` };
  }
  if (prop === "border") {
    const ew = nums(expected)[0] ?? 0, rw = nums(rendered)[0] ?? 0;
    const ec = parseColor((expected.match(/#[0-9a-f]+|rgba?\([^)]+\)/i) || [])[0]);
    const rc = parseColor((rendered.match(/#[0-9a-f]+|rgba?\([^)]+\)/i) || [])[0]);
    const wOk = Math.abs(ew - rw) <= px;
    const cOk = ec && rc ? ciede2000(ec, rc) < dE : true;
    return { pass: wOk && cOk, why: wOk ? (cOk ? "" : "border colour") : "border width" };
  }
  if (prop === "font-family") {
    const fam = String(expected).replace(/["']/g, "").split(",")[0].trim().toLowerCase();
    return { pass: String(rendered).toLowerCase().includes(fam), why: "family not in computed stack" };
  }
  if (prop === "box-shadow" || prop === "text-shadow") {
    // Canonical shadow compare (F5): computed style reorders colour-first and pads units
    // ("rgb(228, 225, 221) 0px 0px 0px 1px" vs spec "0 0 0 1px #e4e1dd") — a string compare
    // fails IDENTICAL values. Compare colour by ΔE and lengths within ±px, per shadow.
    const split = (s) => String(s).split(/,(?![^(]*\))/).map((x) => x.trim()).filter((x) => x && x !== "none");
    const es = split(expected), rs = split(rendered);
    if (es.length !== rs.length) return { pass: false, why: `shadow count ${es.length}≠${rs.length}` };
    for (let i = 0; i < es.length; i++) {
      const colorTok = (s) => (s.match(/#[0-9a-f]{3,8}|rgba?\([^)]+\)|transparent/i) || [""])[0];
      const et = colorTok(es[i]), rt = colorTok(rs[i]);
      const ec = parseColor(et), rc = parseColor(rt);
      if (!!ec !== !!rc) return { pass: false, why: `shadow ${i} colour presence differs` };
      if (ec && rc) {
        if ((ec.a === 0) !== (rc.a === 0)) return { pass: false, why: `shadow ${i} alpha differs` };
        if (ciede2000(ec, rc) >= dE) return { pass: false, why: `shadow ${i} colour ΔE ${ciede2000(ec, rc).toFixed(2)}` };
      }
      const en = nums(es[i].replace(et, "")), rn = nums(rs[i].replace(rt, ""));
      while (en.length < 4) en.push(0);
      while (rn.length < 4) rn.push(0);
      for (let j = 0; j < 4; j++) {
        if (Math.abs((en[j] || 0) - (rn[j] || 0)) > px) return { pass: false, why: `shadow ${i} length[${j}] Δ${((en[j] || 0) - (rn[j] || 0)).toFixed(1)}px` };
      }
      if (/\binset\b/.test(es[i]) !== /\binset\b/.test(rs[i])) return { pass: false, why: `shadow ${i} inset differs` };
    }
    return { pass: true };
  }
  if (LEN_PROPS.has(prop)) {
    const e = nums(expected), r = nums(rendered);
    if (e.length !== r.length) {
      // padding "14px 16px" vs computed 4-value — compare the set leniently
      const ok = e.every((v) => r.some((x) => Math.abs(x - v) <= px));
      return { pass: ok, expected, rendered, why: ok ? "" : "length mismatch" };
    }
    const ok = e.every((v, i) => Math.abs(v - r[i]) <= px);
    return { pass: ok, why: ok ? "" : `Δ ${e.map((v, i) => (v - r[i]).toFixed(0)).join(",")}px` };
  }
  // font-weight: 500 vs "500"; flex/keywords: normalize whitespace + trailing units.
  // F5: canonicalize embedded colour tokens to rgba() first — "#e4e1dd" and
  // "rgb(228, 225, 221)" are the same value and must never fail a string compare.
  const canonColors = (s) => String(s).replace(/#[0-9a-f]{3,8}\b|rgba?\([^)]+\)/gi, (tok) => {
    const c = parseColor(tok);
    return c ? `rgba(${c.r},${c.g},${c.b},${+c.a.toFixed(3)})` : tok;
  });
  const norm = (s) => canonColors(s).trim().toLowerCase().replace(/\s+/g, " ").replace(/0px|0%/g, "0");
  if (prop === "flex" || prop === "align-self") {
    return { pass: norm(rendered).startsWith(norm(expected).split(" ").slice(0, 2).join(" ")), expected, rendered };
  }
  return { pass: norm(expected) === norm(rendered), expected, rendered };
}

export function compareDecls(expected, rendered, tol) {
  const rows = [];
  for (const prop of Object.keys(expected || {})) {
    const r = compareProp(prop, expected[prop], rendered[prop] ?? "", tol);
    rows.push({ property: prop, spec: expected[prop], rendered: rendered[prop] ?? "(missing)", pass: r.pass, note: r.delta || r.why || "" });
  }
  return rows;
}

/** Visible text compare for static chrome (placeholders/labels). Whitespace-normalized substring OK for dynamic Reply-to-{name}. */
export function compareText(expected, rendered) {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const e = norm(expected), r = norm(rendered);
  if (!e) return { pass: true, note: "" };
  if (!r) return { pass: false, why: "visible text empty — placeholder/label not painted" };
  // Allow "{name}" templates: "Reply to " prefix match
  if (e.includes("{") && e.includes("}")) {
    const prefix = norm(e.replace(/\{[^}]+\}/g, "").trim());
    return { pass: !prefix || r.toLowerCase().includes(prefix.toLowerCase()), why: "templated text prefix missing" };
  }
  return { pass: r.includes(e) || e.includes(r), why: "visible text mismatch" };
}

// ---- layout / geometry (surface-relative boxes) ----
// Catches what per-element styles miss: over-indentation, wrong gaps, wrong row, missing elements.
export function compareBox(expected, rendered, tol = {}) {
  const pos = tol.pos ?? 3, size = tol.size ?? 2, rows = [];
  for (const k of ["x", "y", "w", "h"]) {
    if (expected[k] == null) continue;
    const t = (k === "w" || k === "h") ? size : pos;
    const rv = rendered ? rendered[k] : null;
    const d = rv == null ? NaN : Math.round(rv - expected[k]);
    rows.push({ property: "box." + k, spec: expected[k] + "px", rendered: (rv == null ? "(none)" : Math.round(rv)) + "px", pass: !isNaN(d) && Math.abs(d) <= t, note: isNaN(d) ? "no box" : "Δ " + d + "px" });
  }
  return rows;
}
export function compareRelation(a, b, type) {
  const REL = {
    "left-of": (p, q) => p.x + p.w <= q.x + 4,
    "right-of": (p, q) => p.x + 4 >= q.x + q.w,
    "above": (p, q) => p.y + p.h <= q.y + 4,
    "below": (p, q) => p.y + 4 >= q.y + q.h,
    "top-right-of": (p, q) => (p.x + p.w / 2) >= (q.x + q.w / 2) && (p.y + p.h / 2) <= (q.y + q.h / 2),
  };
  const fn = REL[type];
  return { pass: !!(fn && a && b && fn(a, b)), note: fn ? "relation broken" : "unknown relation" };
}
export function compareGap(a, b, axis, expected, tol = {}) {
  const t = tol.gap ?? 3;
  if (!a || !b) return { pass: false, rendered: "(no box)", note: "missing element" };
  const g = axis === "x" ? (b.x - (a.x + a.w)) : (b.y - (a.y + a.h));
  return { pass: Math.abs(g - expected) <= t, rendered: Math.round(g) + "px", note: "Δ " + Math.round(g - expected) + "px" };
}

// verdict over a set of elements: each {name, present, table[], box?, expectedBox?}.
// opts: { relations:[{a,b,type}], gaps:[{a,b,axis,expected}], tol }. FAIL on any absent/mismatch.
// NO aggregate — style + layout deltas are all surfaced; one diff = FAIL.
export function verdictOf(elements, opts = {}) {
  const diffs = [], byName = {};
  for (const el of elements) byName[el.name] = el;
  for (const el of elements) {
    if (el.present === false) { diffs.push({ element: el.name, property: "(present)", spec: "rendered + supplied content", rendered: "MISSING", note: "mustSupply slot absent / element not found" }); continue; }
    for (const row of el.table || []) if (!row.pass) diffs.push({ element: el.name, ...row });
    if (el.expectedText) {
      const tr = compareText(el.expectedText, el.renderedText ?? "");
      if (!tr.pass) diffs.push({ element: el.name, property: "text", spec: el.expectedText, rendered: el.renderedText || "(empty)", pass: false, note: tr.why || "visible text mismatch" });
    }
    // box===null is a DELIBERATE "geometry not attributable" signal (collision / unresolved surface),
    // already reported once as its own finding — don't re-emit four "no box" rows per element.
    if (el.expectedBox && el.box !== null) for (const row of compareBox(el.expectedBox, el.box, opts.tol)) if (!row.pass) diffs.push({ element: el.name, ...row });
  }
  const boxOfName = (n) => { const e = byName[n]; return e && e.box ? e.box : null; }; // null box (collision/unresolved) ⇒ not comparable
  for (const r of opts.relations || []) {
    const a = boxOfName(r.a), b = boxOfName(r.b);
    if (!a || !b) continue; // a referenced node's geometry is unattributable — skip, don't call it "broken"
    const res = compareRelation(a, b, r.type);
    if (!res.pass) diffs.push({ element: r.a + " " + r.type + " " + r.b, property: "relation", spec: r.type, rendered: "broken", note: res.note });
  }
  for (const g of opts.gaps || []) {
    const a = boxOfName(g.a), b = boxOfName(g.b);
    if (!a || !b) continue;
    const res = compareGap(a, b, g.axis || "y", g.expected, opts.tol);
    if (!res.pass) diffs.push({ element: g.a + "↔" + g.b, property: "gap." + (g.axis || "y"), spec: g.expected + "px", rendered: res.rendered, note: res.note });
  }
  // COVERAGE — what this spec actually asserted (element names + gap checks), pass OR fail. This is the
  // content-INDEPENDENT proof that the check was substantive: the gate rejects a block whose delta spec
  // covered too little (the RUN-3 failure — delta passed only because the spec never checked the gap /
  // reactions, while whole-surface pixel-diff drowned in real-vs-dummy DATA noise). A spec can't certify
  // a surface by checking nothing.
  return {
    verdict: diffs.length === 0 ? "PASS" : "FAIL",
    diffs,
    checked: elements.map((e) => e.name),
    gaps: (opts.gaps || []).map((g) => ({ a: g.a, b: g.b, axis: g.axis || "y", expected: g.expected })),
  };
}

// ---- layer reconciliation (Figma node = ONE rect; DOM = N nested layers) ----
// A Figma node is a VISUAL spec; the DOM renders it as a stack (host > div > div > your element),
// any of which may paint box-properties and COMPOUND (the M1 bug). The box is the disambiguator:
// the element whose box == the Figma node IS the visual node (the "owner"); co-box ANCESTORS that
// still paint background/border/radius/padding/margin must be NEUTRALIZED — and ONLY those props,
// never functional CSS (flex/overflow/position/display), or you break Velt's layout/behavior (R7).
// This generalizes R22 (padding compounding across wrappers) AND R23 (wrong layer styled → the
// owner's box won't match the design node). Pure logic here; LAYER_PROBE does the live DOM walk.
export const PAINT_PROPS = ["padding", "background", "border", "border-radius", "margin"];
export function isDefaultPaint(prop, v) {
  if (v == null) return true;
  v = String(v).trim();
  if (prop === "background" || prop === "background-color") { const c = parseColor(v); return !c || c.a === 0; }
  if (prop === "border") return /\bnone\b/.test(v) || (nums(v)[0] || 0) === 0;
  const n = nums(v); // padding / margin / border-radius default == every numeric component is 0
  return n.length === 0 || n.every((x) => x === 0);
}
export function paintConflicts(styles) {
  const out = [];
  for (const p of PAINT_PROPS) if (styles && p in styles && !isDefaultPaint(p, styles[p])) out.push(p);
  return out;
}
// PER-PROPERTY layer ownership — the smart, non-hacky reconciliation.
// o = { owner:{box,styles}, expectedBox, designPaint:{prop:value}, layers:[{classes,styles,clip,box}], tol }
// For each box-painting property: compounding (≥2 painters) → keep the load-bearing one + neutralize
// duplicates; COOPERATING (a wrapper is the SOLE painter of a property the design wants) → KEEP it,
// don't move it (handles the overflow-clip-outer / bg-inner case); a radius on a clip layer is never
// stripped; chrome the design doesn't want → neutralize. Emits an apply-plan (prop → layer → value).
export function reconcilePlan(o = {}) {
  const size = (o.tol && o.tol.size) || 2;
  const design = o.designPaint || {};
  const owner = o.owner || {};
  const ownerStyles = owner.styles || {};
  const ownerBox = owner.box || o.ownerBox;
  const layers = o.layers || [];
  const plan = { ownerMismatch: false, ownerBoxDelta: null, neutralize: [], apply: [], cooperating: [], conflicts: [] };
  const paints = (s, p) => !!(s && p in s && !isDefaultPaint(p, s[p]));
  const cls = (L) => ((L && L.classes) || "").split(/\s+/)[0] || "(no class)";
  function neutralize(L, P) {
    let e = plan.neutralize.find((n) => n.classes === (L.classes || ""));
    if (!e) { e = { classes: L.classes || "", props: [] }; plan.neutralize.push(e); }
    if (e.props.indexOf(P) < 0) e.props.push(P);
    const r = cls(L) + " also paints " + P + " (compounding/unwanted → zero it)";
    if (plan.conflicts.indexOf(r) < 0) plan.conflicts.push(r);
  }
  if (o.expectedBox && ownerBox) {
    const dw = Math.round(ownerBox.w - o.expectedBox.w), dh = Math.round(ownerBox.h - o.expectedBox.h);
    if (Math.abs(dw) > size || Math.abs(dh) > size) { plan.ownerMismatch = true; plan.ownerBoxDelta = { dw, dh }; }
  }
  for (let pi = 0; pi < PAINT_PROPS.length; pi++) {
    const P = PAINT_PROPS[pi];
    const designWants = Object.prototype.hasOwnProperty.call(design, P);
    const ownerPaints = paints(ownerStyles, P);
    const painters = layers.filter((L) => paints(L.styles, P));
    let keeper = null; // null ⇒ the owner is the keeper / apply target
    if (P === "border-radius") { for (const L of painters) if (L.clip) { keeper = L; break; } }
    for (const L of painters) {
      if (L === keeper) continue;
      if (P === "border-radius" && L.clip) { if (!keeper) keeper = L; continue; } // never strip a clipping radius
      if (ownerPaints || keeper || !designWants) neutralize(L, P);                 // compounding, or chrome the design lacks
      else { keeper = L; plan.cooperating.push(cls(L) + " is the sole painter of " + P + " — kept (cooperating layer, not flattened)"); }
    }
    if (designWants) plan.apply.push({ target: keeper ? cls(keeper) : "owner", prop: P, value: design[P] });
  }
  plan.ok = !plan.ownerMismatch && plan.neutralize.length === 0;
  return plan;
}

// ---- browser probe (built from the SAME functions; injected via the host browser tool) ----
const READ_PROP = `function readProp(cs, prop){
  const map={background:'backgroundColor','border-radius':'borderRadius','font-family':'fontFamily','font-size':'fontSize','font-weight':'fontWeight','line-height':'lineHeight','letter-spacing':'letterSpacing','flex-direction':'flexDirection','justify-content':'justifyContent','align-items':'alignItems','align-self':'alignSelf'};
  if(prop==='border'){return cs.borderTopWidth+' solid '+cs.borderTopColor;}
  const k=map[prop]||prop; return cs[k] || cs.getPropertyValue(prop);
}`;
// SPEC = { surfaceSelector, tol, elements:[{name,selector,expected,box}], relations:[], gaps:[] }
// (an array is accepted as a shorthand for {elements}). Boxes are surface-root-relative.
export const BROWSER_PROBE = `(function(SPEC){
  ${parseColor.toString()}
  ${rgbToLab.toString()}
  ${ciede2000.toString()}
  ${compareProp.toString()}
  ${compareDecls.toString()}
  ${compareText.toString()}
  ${compareBox.toString()}
  ${compareRelation.toString()}
  ${compareGap.toString()}
  ${verdictOf.toString()}
  ${READ_PROP}
  var nums=${nums.toString()};
  var COLOR_PROPS=${JSON.stringify([...COLOR_PROPS])}; var LEN_PROPS=${JSON.stringify([...LEN_PROPS])};
  COLOR_PROPS=new Set(COLOR_PROPS); LEN_PROPS=new Set(LEN_PROPS);
  if(Array.isArray(SPEC)) SPEC={elements:SPEC};
  function pick(sel){var ns=document.querySelectorAll(sel);for(var j=0;j<ns.length;j++){if(ns[j].getBoundingClientRect().width>0)return ns[j];}return null;}
  // SURFACE RESOLUTION (v4 judge bug): a stale surfaceSelector (registry-twin wireframe tag) made
  // pick() return null and boxes silently fell back to PAGE-ABSOLUTE coords — hundreds of garbage
  // box.x rows. Try the fallback surface (liveSelector), and if NOTHING resolves, report ONE
  // explicit surface-unresolved diff and SKIP box comparisons instead of emitting noise.
  var surf=SPEC.surfaceSelector?pick(SPEC.surfaceSelector):null;
  if(!surf&&SPEC.fallbackSurface)surf=pick(SPEC.fallbackSurface);
  var surfaceUnresolved=!surf&&!!(SPEC.surfaceSelector||SPEC.fallbackSurface);
  if(!surf)surf=document.body;
  var sr=surf?surf.getBoundingClientRect():{left:0,top:0};
  // Resolve each element WITHIN the surface (v4 judge bug): document-wide pick() bound a card's
  // header to the FIRST card on the page, not the card being measured — so boxes rebased against
  // the wrong origin. Search inside surf first; fall back to document only if absent there.
  function visMatches(root,sel){var out=[];try{var ns=(root||document).querySelectorAll(sel);}catch(e){return out;}for(var j=0;j<ns.length;j++){if(ns[j].getBoundingClientRect().width>0)out.push(ns[j]);}return out;}
  var els=[];
  var list=SPEC.elements||[];
  // SELECTOR-COLLISION handling (v4 judge precision): the style plan can collapse several DISTINCT
  // spec nodes onto ONE class (e.g. 4 header sub-frames -> .vc-card__header). Measuring each spec
  // box against the SAME live node yields a flood of garbage geometry rows. Group rows by selector;
  // if the live DOM has as many visible matches as rows, ZIP positionally (spec order = DOM order);
  // if it has FEWER, that's a real collision -> compare STYLE on the first match, SKIP geometry for
  // the rest, and emit ONE actionable collision finding for the planner.
  var groups={},order=[];
  for(var i=0;i<list.length;i++){var sel=list[i].selector||('#__row'+i);if(!groups[sel]){groups[sel]=[];order.push(sel);}groups[sel].push(i);}
  // PAINT/TEXT test: a row carries a distinct VISIBLE role only if it expects a paint or text prop.
  // Figma auto-layout wrapper frames (only layout props: display/flex/gap/justify/align/padding)
  // legitimately FLATTEN to one live element — that is expected, NOT a plan defect.
  var PAINT_ROLE={'background':1,'background-color':1,'color':1,'border':1,'border-color':1,'border-width':1,'box-shadow':1,'fill':1,'stroke':1,'content':1,'font-size':1,'font-family':1,'font-weight':1,'line-height':1,'width':1,'height':1};
  function isPainter(row){var e=row.expected||{};for(var k in e){if(PAINT_ROLE[k])return true;}return false;}
  var collided=[];
  for(var g=0;g<order.length;g++){var sel=order[g];var idxs=groups[sel];
    if(idxs.length<2)continue;
    // count DISTINCT painters among the colliding rows. A real role-collision needs >=2 painters
    // (two visible elements collapsed onto one class). 0-1 painters ⇒ benign wrapper flatten.
    var painters=0;for(var m=0;m<idxs.length;m++){if(isPainter(list[idxs[m]]))painters++;}
    // also treat pure duplicate names (same node measured twice, e.g. avatar/avatar) as benign.
    var uniqNames={};for(var m=0;m<idxs.length;m++)uniqNames[list[idxs[m]].name]=1;
    var distinct=Object.keys(uniqNames).length;
    if(painters>=2&&distinct>=2){
      collided.push({selector:sel,specNodes:idxs.length,painters:painters,names:idxs.map(function(x){return list[x].name;})});
    }
  }
  // geometry is unattributable for ANY selector shared by >1 row (real collision OR benign flatten);
  // suppress boxes for all of them, but only REAL painter-collisions become reported findings.
  var collidedSel={};for(var g=0;g<order.length;g++){if(groups[order[g]].length>1)collidedSel[order[g]]=true;}
  // F4 PAINT-BINDING (v5 judge precision): a wireframe HOST element is often a transparent
  // wrapper (bg transparent / radius 0 / pad 0) around the styled child that actually paints
  // the card. Probing paint props on the host emits ~20 false container rows per run. When a
  // row EXPECTS paint and the bound node paints nothing, walk down to the first descendant
  // that paints (non-transparent bg / visible border / shadow / radius) and shares the host's
  // box — and compare against THAT node.
  var PAINT_EXPECT={'background':1,'background-color':1,'border':1,'border-color':1,'border-width':1,'border-radius':1,'box-shadow':1};
  function expectsPaint(exp){for(var k in (exp||{})){if(PAINT_EXPECT[k])return true;}return false;}
  function paintsAny(c){var bg=parseColor(c.backgroundColor);return (bg&&bg.a>0)||((parseFloat(c.borderTopWidth)||0)>0&&c.borderTopStyle!=='none')||(!!c.boxShadow&&c.boxShadow!=='none')||((parseFloat(c.borderTopLeftRadius)||0)>0);}
  function descendToPainter(host){
    var hb=host.getBoundingClientRect();var cand=host.querySelectorAll('*');
    for(var ci=0;ci<cand.length&&ci<40;ci++){var d=cand[ci];var db=d.getBoundingClientRect();
      if(db.width<hb.width*0.6||db.height<4)continue;
      if(db.left<hb.left-4||db.top<hb.top-4||db.right>hb.right+4||db.bottom>hb.bottom+4)continue;
      if(paintsAny(getComputedStyle(d)))return d;
    }
    return null;
  }
  for(var i=0;i<list.length;i++){var s=list[i];
    var scope=(surf&&surf!==document.body)?surf:document;
    var el=visMatches(scope,s.selector)[0]||visMatches(document,s.selector)[0]||null;
    if(!el){els.push({name:s.name,present:false,expectedBox:s.box});continue;}
    var boundDescendant=null;
    if(expectsPaint(s.expected)&&!paintsAny(getComputedStyle(el))){
      var painted=descendToPainter(el);
      if(painted){boundDescendant=((painted.className&&painted.className.toString)?painted.className.toString().split(/\\s+/)[0]:'')||(painted.tagName||'').toLowerCase();el=painted;}
    }
    var cs=getComputedStyle(el),rendered={};
    for(var p in (s.expected||{})){rendered[p]=readProp(cs,p);}
    var r=el.getBoundingClientRect();
    var box={x:Math.round(r.left-sr.left),y:Math.round(r.top-sr.top),w:Math.round(r.width),h:Math.round(r.height)};
    if(surfaceUnresolved)box=null;   // page-absolute boxes are garbage — never compare them
    if(collidedSel[s.selector])box=null;   // shared class -> geometry not attributable
    // rendered PAINT snapshot (for the build-over-build regression guard): read the live paint of
    // this element regardless of whether the spec asserted it, so the guard can detect "was painted
    // last build, transparent now" even when the current spec doesn't check that prop.
    var paintSnap={};var PK=['background-color','border-top-width','box-shadow','fill','color','outline-style'];
    for(var pk=0;pk<PK.length;pk++){try{paintSnap[PK[pk]]=readProp(cs,PK[pk]);}catch(e){}}
    // Visible text for static chrome (placeholder/labels) — prefer textContent; contenteditable uses same.
    var renderedText='';
    if(s.expectedText){
      try{
        renderedText=(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim();
        if(!renderedText){
          var ph=el.getAttribute&& (el.getAttribute('placeholder')||el.getAttribute('data-placeholder')||'');
          if(ph) renderedText=String(ph).trim();
        }
      }catch(e){renderedText='';}
    }
    els.push({name:s.name,present:true,table:compareDecls(s.expected||{},rendered),box:box,expectedBox:s.box,expectedText:s.expectedText||null,renderedText:renderedText,rendered:paintSnap,boundTo:boundDescendant,liveBox:{x:Math.round(r.left-sr.left),y:Math.round(r.top-sr.top),w:Math.round(r.width),h:Math.round(r.height)}});
  }
  if(surfaceUnresolved){
    els.unshift({name:'(surface)',present:false,note:'surface selector unresolved: '+(SPEC.surfaceSelector||'')+(SPEC.fallbackSurface?' / '+SPEC.fallbackSurface:'')+' — box comparisons skipped; fix the brief surfaceSelector'});
  }
  var v=verdictOf(els,{relations:SPEC.relations,gaps:SPEC.gaps,tol:SPEC.tol});
  // gross-mismatch pre-check (deterministic, whole-surface): total content extent + present count
  // vs expected. Catches "every sampled prop passes but the surface is 2x too tall / cards missing".
  var expBottom=0,renBottom=0,present=0,expCount=list.length;
  for(var k=0;k<els.length;k++){var e=els[k];
    if(e.expectedBox&&e.expectedBox.y!=null&&e.expectedBox.h!=null)expBottom=Math.max(expBottom,e.expectedBox.y+e.expectedBox.h);
    if(e.present!==false){present++;if(e.box)renBottom=Math.max(renBottom,e.box.y+e.box.h);}
  }
  var heightTol=Math.max(20,expBottom*0.15);
  var gross={expCount:expCount,present:present,expBottom:expBottom,renBottom:renBottom,heightTol:Math.round(heightTol)};
  gross.ok=(present===expCount)&&(!expBottom||Math.abs(renBottom-expBottom)<=heightTol);
  if(!gross.ok){
    if(present!==expCount)v.diffs.unshift({element:'(gross)',property:'element-count',spec:expCount,rendered:present,note:'whole-surface element count off — '+(expCount-present)+' missing'});
    if(expBottom&&Math.abs(renBottom-expBottom)>heightTol)v.diffs.unshift({element:'(gross)',property:'content-height',spec:expBottom+'px',rendered:renBottom+'px',note:'whole-surface content height off by '+Math.round(renBottom-expBottom)+'px (>'+Math.round(heightTol)+'px) — spacing/density wrong'});
    v.verdict='FAIL';
  }
  v.gross=gross;
  // SELECTOR COLLISION IS NOT A DEFECT. A design→live mapping legitimately collapses many Figma
  // auto-layout wrapper frames onto ONE live element (the live DOM is flatter than the design
  // tree). Treating it as a defect + emitting a "split the class" fix-order is what drove the
  // structural-split regression (card chrome moved onto a 0-height wrapper, black-box glyphs).
  // We record collisions as ADVISORY metadata only — geometry for a shared selector was already
  // nulled above (unattributable), and style props still compared on the shared element. Never a
  // diff row, never a FAIL. A genuine "two DISTINCT painted things on one class" is caught by the
  // unexpected-paint / overlap probes on real painted elements, not here.
  if(collided.length)v.collisionsAdvisory=collided;
  // compact per-element fingerprint for the regression guard (paint + live box + presence)
  v.elements=els.filter(function(e){return e.name&&e.name!=='(surface)';}).map(function(e){return {name:e.name,present:e.present!==false,box:e.liveBox||null,rendered:e.rendered||{}};});
  return v;
})`;

// LAYER_PROBE — the live DOM walk for layer reconciliation. SPEC = { surfaceSelector, ownerSelector,
// expectedBox, tol }. Returns the reconciliation plan: the owner's box, the co-box ancestor layers,
// which of them paint a conflicting box-property (to neutralize), and whether the owner's box even
// matches the design node (ownerMismatch ⇒ wrong layer styled). Reads ONLY box-painting props.
const READ_PAINT = `function readPaint(cs){return {
  padding: cs.paddingTop+' '+cs.paddingRight+' '+cs.paddingBottom+' '+cs.paddingLeft,
  margin: cs.marginTop+' '+cs.marginRight+' '+cs.marginBottom+' '+cs.marginLeft,
  background: cs.backgroundColor,
  border: cs.borderTopWidth+' '+cs.borderTopStyle+' '+cs.borderTopColor,
  'border-radius': cs.borderTopLeftRadius
};}`;
// SPEC = { surfaceSelector, ownerSelector, expectedBox, designPaint:{prop:value}, tol }
export const LAYER_PROBE = `(function(SPEC){
  ${parseColor.toString()}
  var nums=${nums.toString()};
  ${isDefaultPaint.toString()}
  ${reconcilePlan.toString()}
  ${READ_PAINT}
  var PAINT_PROPS=${JSON.stringify(PAINT_PROPS)};
  function pick(sel){var ns=document.querySelectorAll(sel);for(var j=0;j<ns.length;j++){if(ns[j].getBoundingClientRect().width>0)return ns[j];}return null;}
  function isClip(cs){var ov=(cs.overflow||'')+(cs.overflowX||'')+(cs.overflowY||'');return /hidden|clip|scroll|auto/.test(ov)&&(nums(cs.borderTopLeftRadius)[0]||0)>0;}
  var owner=pick(SPEC.ownerSelector);
  if(!owner)return {found:false,ownerSelector:SPEC.ownerSelector};
  var surf=SPEC.surfaceSelector?pick(SPEC.surfaceSelector):document.body;
  var sr=surf?surf.getBoundingClientRect():{left:0,top:0};
  function relBox(el){var r=el.getBoundingClientRect();return {x:Math.round(r.left-sr.left),y:Math.round(r.top-sr.top),w:Math.round(r.width),h:Math.round(r.height)};}
  var ownerBox=relBox(owner);
  var ownerStyles=readPaint(getComputedStyle(owner));
  // collect the co-box ANCESTOR stack (the wrappers that render the SAME visual rect)
  var layers=[],node=owner.parentElement,guard=0;
  while(node&&guard++<12){
    var b=relBox(node);
    if(Math.abs(b.w-ownerBox.w)<=4&&Math.abs(b.h-ownerBox.h)<=4){
      var cs=getComputedStyle(node);
      layers.push({classes:(node.className&&node.className.toString)?node.className.toString():'',styles:readPaint(cs),clip:isClip(cs),box:b});
    } else break; // box diverged → a legitimately different ancestor; stop, don't touch it
    if(node===surf)break;
    node=node.parentElement;
  }
  var plan=reconcilePlan({owner:{box:ownerBox,styles:ownerStyles},expectedBox:SPEC.expectedBox,designPaint:SPEC.designPaint,layers:layers,tol:SPEC.tol});
  plan.found=true; plan.ownerBox=ownerBox; plan.layerCount=layers.length;
  return plan;
})`;

// ---- mount-map contract oracle (the FUNCTIONAL gate — closes reward-misspecification) ----
// A surface can be pixel-perfect and behaviorally DEAD (wrong/absent primitive, a feature hidden
// with CSS, a part hoisted out of its required context, a phantom custom button the SDK doesn't
// own). Because Velt's slot model forces behavior through Velt's own components, "does it still
// work" reduces to a STRUCTURAL question: does the live (post-reconciliation) tree still contain a
// well-formed MOUNT MAP — every required behavioral part present, of the right kind, correctly
// contained, in the right quantity, with no interactive affordance the SDK doesn't own. No harness:
// we verify the PRECONDITIONS of mounting statically. This is a BOOLEAN VETO folded into the Judge,
// never an aggregate-scored addend — ΔE 0 with a broken mount map is a hard FAIL.
// expected = [{ part, selector, requiredAncestor?, singleton? }] ; observed = { parts:{part:{present,count,ancestorOk}}, phantoms:[{what,where}] }
export function mountMapDiff(expected, observed = {}) {
  const violations = [];
  const parts = observed.parts || {};
  for (const e of expected || []) {
    const o = parts[e.part] || { present: false, count: 0, ancestorOk: true };
    if (!o.present) { violations.push({ part: e.part, kind: "MISSING", note: `required Velt part '${e.part}' (${e.selector}) absent — behavior won't mount` }); continue; }
    if (e.requiredAncestor && o.ancestorOk === false) violations.push({ part: e.part, kind: "CONTAINMENT", note: `'${e.part}' not inside required ancestor '${e.requiredAncestor}' — runtime context won't reach it` });
    if (e.singleton && o.count > 1) violations.push({ part: e.part, kind: "CARDINALITY", note: `singleton '${e.part}' rendered ${o.count}× — runtime binds one; the rest are dead twins` });
  }
  for (const p of observed.phantoms || []) violations.push({ part: p.where || "(surface)", kind: "PHANTOM_INTERACTIVE", note: `interactive affordance '${p.what}' is not owned by a Velt element — inert/disconnected (R4); the user clicks a thing the SDK doesn't wire` });
  return { ok: violations.length === 0, violations };
}

// CONTRACT_PROBE — reads the actual mount map off the LIVE post-reconciliation DOM and diffs it.
// SPEC = { surfaceSelector, entries:[{part,selector,requiredAncestor?,singleton?}] } (the agent
// resolves each part's live selector by inspection, the same way it resolves styling selectors).
export const CONTRACT_PROBE = `(function(SPEC){
  ${mountMapDiff.toString()}
  function vis(el){return !!(el&&el.getBoundingClientRect&&el.getBoundingClientRect().width>0);}
  function pickAll(sel){var r=[];try{var ns=document.querySelectorAll(sel);}catch(e){return r;}for(var i=0;i<ns.length;i++)if(vis(ns[i]))r.push(ns[i]);return r;}
  var entries=SPEC.entries||[];var parts={};
  // count LIVE mounts only — a match inside <velt-wireframe> is the registry twin, not a mount
  function countAll(sel){try{var ns=document.querySelectorAll(sel);}catch(e){return 0;}var n=0;for(var i=0;i<ns.length;i++){if(!ns[i].closest('velt-wireframe'))n++;}return n;}
  for(var i=0;i<entries.length;i++){var e=entries[i];var els=pickAll(e.selector);
    var mounted=countAll(e.selector);
    var ancestorOk=true;
    if(e.requiredAncestor&&els.length){try{ancestorOk=!!els[0].closest(e.requiredAncestor);}catch(_){ancestorOk=true;}}
    // "mounted but 0-size everywhere" is a HIDDEN part (undrawn state / collapsed), not an absent
    // one — report it as present+hidden so MISSING means what it says: never mounted at all.
    parts[e.part]={present:mounted>0,count:els.length,mounted:mounted,hidden:mounted>0&&els.length===0,ancestorOk:ancestorOk};
  }
  // phantom-interactive scan: an interactive node inside the surface that no Velt element owns
  var phantoms=[];
  if(SPEC.surfaceSelector){var surf=document.querySelector(SPEC.surfaceSelector);
    if(surf){var cand=surf.querySelectorAll('button,[role="button"],[role="menuitem"],[role="checkbox"],[tabindex]');
      for(var j=0;j<cand.length;j++){var c=cand[j];if(!vis(c))continue;
        var owned=false,n=c;
        while(n&&n!==surf.parentNode){var tn=(n.tagName||'').toLowerCase();var cl=(n.className&&n.className.toString)?n.className.toString():'';
          if(tn.indexOf('velt-')===0||tn.indexOf('snippyly-')===0||/(^|\\s)(velt-|s-)/.test(cl)){owned=true;break;}n=n.parentElement;}
        if(!owned)phantoms.push({what:(c.tagName||'el').toLowerCase(),where:(c.className&&c.className.toString)?c.className.toString().split(/\\s+/)[0]:''});
      }
    }
  }
  return mountMapDiff(entries,{parts:parts,phantoms:phantoms});
})`;

// STABILITY_PROBE — the mechanical, GENERAL "does the click target move at the moment of the click"
// check (any interactive surface, not just comments). The interaction bug class: a layout/visibility
// rule keyed on a TRANSIENT state (`:focus`/`:hover`/`:active` or a Velt twin like
// `velt-composer-input-focused`) flips at the exact instant the user reaches for a control — the
// element loses focus on mousedown, a piece hidden under that state reappears, and the target shifts
// out from under the cursor, so the click lands on empty air. A static per-state capture never sees
// it; you must measure the target's box ACROSS the transition. SPEC = { surfaceSelector,
// targets:[{name,selector}], tol? } — the Judge enumerates the surface's interactive affordances and
// resolves each target's live (width>0) selector by inspection. The probe records each target's box,
// drops every transient state it can reproduce mechanically (blur the focused element + dispatch
// focusout), forces a reflow, re-measures, and reports the per-target shift. Any |dx|/|dy| > tol ⇒ the
// target moves mid-interaction ⇒ FAIL. (Hover can't be forced programmatically; focus is the
// reproducible transient and the one that bites. End-to-end "the action actually fired" is the Judge's
// drive+assert, not this probe. A surface with no interactive targets ⇒ targets:[] ⇒ trivially ok.)
export const STABILITY_PROBE = `(function(SPEC){
  function vis(el){return !!(el&&el.getBoundingClientRect&&el.getBoundingClientRect().width>0);}
  function pick(sel){try{var ns=document.querySelectorAll(sel);}catch(e){return null;}for(var i=0;i<ns.length;i++)if(vis(ns[i]))return ns[i];return null;}
  function boxOf(el){var r=el.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};}
  var tol=SPEC.tol==null?1:SPEC.tol;
  var targets=(SPEC.targets||[]).map(function(t){var el=pick(t.selector);return {name:t.name,selector:t.selector,el:el,before:el?boxOf(el):null};});
  // Reproduce the moment-of-click transition: blur whatever holds focus inside the surface, fire
  // focusout, and end any active/hover-press state — exactly what mousedown-on-another-element does.
  var surf=SPEC.surfaceSelector?document.querySelector(SPEC.surfaceSelector):document;
  try{var a=document.activeElement;if(a&&(!SPEC.surfaceSelector||(surf&&surf.contains(a)))){a.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));if(a.blur)a.blur();}}catch(_){}
  try{(surf||document).querySelectorAll('[contenteditable],input,textarea').forEach(function(n){if(vis(n)){n.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));if(n.blur)n.blur();}});}catch(_){}
  void document.body.offsetHeight; // force synchronous reflow so the transient-keyed rule re-applies
  var results=targets.map(function(t){
    // an undrawn target (menu item in a closed dropdown, hover-only affordance) is SKIPPED, not a
    // failure — presence is the delta/contract probes' job; this probe only answers "does it move".
    if(!t.el||!t.before)return {name:t.name,present:false,shift:null,ok:true,skipped:true,note:'target not drawn in this state — skipped (presence is delta/contract, not stability)'};
    var after=boxOf(t.el);var dx=after.x-t.before.x,dy=after.y-t.before.y;
    var ok=Math.abs(dx)<=tol&&Math.abs(dy)<=tol;
    return {name:t.name,present:true,before:t.before,after:after,shift:{dx:dx,dy:dy},ok:ok};
  });
  return {ok:results.every(function(r){return r.ok;}),targets:results};
})`;

// CLI smoke: node delta-compare.mjs <spec.json> <rendered.json>
//   spec.json     = array of {name,expected,box?} OR {elements,relations,gaps,tol,surfaceSelector}
//   rendered.json = array of {present, rendered, box?} aligned to spec.elements
// Used by golden/ to prove the engine FAILs known-bad styles AND known-bad geometry.
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fs = await import("node:fs/promises");
  const [eF, rF] = process.argv.slice(2);
  if (eF && rF) {
    const spec = JSON.parse(await fs.readFile(eF, "utf8")), ren = JSON.parse(await fs.readFile(rF, "utf8"));
    const elements = Array.isArray(spec) ? spec : spec.elements;
    const els = elements.map((e, i) => ({
      name: e.name,
      present: ren[i] && ren[i].present !== false,
      table: compareDecls(e.expected || {}, (ren[i] && ren[i].rendered) || {}),
      box: ren[i] && ren[i].box,
      expectedBox: e.box,
    }));
    const opts = Array.isArray(spec) ? {} : { relations: spec.relations, gaps: spec.gaps, tol: spec.tol };
    console.log(JSON.stringify(verdictOf(els, opts), null, 2));
  } else console.log("usage: delta-compare.mjs <spec.json> <rendered.json>");
}

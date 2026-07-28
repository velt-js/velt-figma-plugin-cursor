#!/usr/bin/env node
// defect-contract.mjs — offline guards: Judge reports typed defects; routing must NOT
// default every finding to CSS/style. Wired from golden/run-golden.mjs.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(cond, msg, problems) {
  if (!cond) problems.push(msg);
}

export async function calibrateDefectContract() {
  const problems = [];
  let mod;
  try {
    mod = await import(
      pathToFileURL(path.join(ROOT, "scripts/defect-contract.mjs")).href + `?t=${Date.now()}`
    );
  } catch (e) {
    problems.push(`defect-contract.mjs missing/unloadable: ${e.message}`);
    for (const p of problems) console.error("  ✗ defect-contract: " + p);
    return false;
  }

  const { classifyDefect, enrichWorkOrder, mergeSymptomGroups } = mod;
  assert(typeof classifyDefect === "function", "must export classifyDefect", problems);
  assert(typeof enrichWorkOrder === "function", "must export enrichWorkOrder", problems);
  assert(typeof mergeSymptomGroups === "function", "must export mergeSymptomGroups", problems);

  // Unknown / unmatched finding must NOT become style
  if (typeof classifyDefect === "function") {
    const unk = classifyDefect({
      issueKey: "composed.flow.mysterious-chrome",
      source: "vision",
      attribution: "builder-error",
      rendered: "something looks off but root cause unknown",
    });
    assert(unk?.requiredMode === "replan" || unk?.category === "uncertain",
      `uncertain defect must replan/uncertain (got category=${unk?.category} mode=${unk?.requiredMode})`, problems);
    assert(unk?.requiredMode !== "style",
      "uncertain defect must never default requiredMode=style", problems);

    // Presence / mount → structure or wireframe, not style
    const missing = classifyDefect({
      issueKey: "contract.flow.ResolveButton.MISSING",
      source: "contract-probe",
      contractKind: "MISSING",
      attribution: "builder-error",
    });
    assert(["structure", "wireframe"].includes(missing?.category),
      `MISSING mount must be structure/wireframe (got ${missing?.category})`, problems);
    assert(missing?.requiredMode !== "style",
      "MISSING mount must not route to style/CSS", problems);

    // Hover interaction → behavior
    const hover = classifyDefect({
      issueKey: "composed.flow.resolve-on-hover-missing",
      source: "composed-audit",
      KIND: "hover",
      attribution: "builder-error",
    });
    assert(hover?.category === "behavior",
      `hover defect must be behavior (got ${hover?.category})`, problems);
    assert(hover?.detector === "interaction" || hover?.detector === "probe",
      `hover detector must be interaction|probe (got ${hover?.detector})`, problems);
    assert(hover?.requiredMode === "behavior",
      `hover requiredMode must be behavior (got ${hover?.requiredMode})`, problems);

    // Chevron glyph → wireframe (slot/icon), not CSS imitation
    const chev = classifyDefect({
      issueKey: "composed.flow.show-replies-chevron-missing",
      source: "vision",
      attribution: "builder-error",
    });
    assert(chev?.category === "wireframe" || chev?.requiredMode === "wireframe",
      `chevron miss must be wireframe-routed (got ${chev?.category}/${chev?.requiredMode})`, problems);

    // Numeric gap → layout (CSS ok)
    const gap = classifyDefect({
      issueKey: "composed.flow.list-gap",
      source: "composed-audit",
      attribution: "builder-error",
    });
    assert(["layout", "style"].includes(gap?.category),
      `list-gap must be layout|style (got ${gap?.category})`, problems);
    assert(gap?.requiredMode === "style",
      `list-gap requiredMode must be style (got ${gap?.requiredMode})`, problems);

    // Required fields on every classification
    for (const row of [unk, missing, hover, chev, gap]) {
      if (!row) continue;
      for (const k of ["category", "detector", "requiredMode", "confidence", "affectedComponent"]) {
        assert(row[k] != null && row[k] !== "", `classifyDefect must set ${k}`, problems);
      }
      assert(row.evidence !== undefined, "classifyDefect must set evidence (may be null)", problems);
    }
  }

  // Merge related spacing symptoms into one root cause
  if (typeof mergeSymptomGroups === "function") {
    const merged = mergeSymptomGroups([
      { issueKey: "composed.flow.list-gap", tier: "P0", source: "composed-audit" },
      { issueKey: "composed.flow.comment-gap", tier: "P0", source: "composed-audit" },
      { issueKey: "composed.flow.list-gap-too-tight", tier: "P0", source: "vision" },
      { issueKey: "composed.flow.card-internal-spacing", tier: "P0", source: "composed-audit" },
      { issueKey: "composed.flow.renders-serif", tier: "P0", source: "composed-audit" },
    ]);
    const spacing = (merged || []).filter((r) => r.rootCauseGroup === "vertical-rhythm" || /vertical-rhythm|spacing-rhythm/.test(r.issueKey || ""));
    assert(spacing.length === 1,
      `spacing symptoms must merge to 1 root cause (got ${spacing.length})`, problems);
    assert((merged || []).some((r) => String(r.issueKey).includes("renders-serif")),
      "unrelated renders-serif must not be swallowed by spacing merge", problems);
  }

  // enrichWorkOrder stamps contract fields + never style-defaults unknowns
  if (typeof enrichWorkOrder === "function") {
    const rows = enrichWorkOrder([
      { issueKey: "composed.flow.card-stack-structure", source: "composed-audit", attribution: "builder-error" },
      { issueKey: "composed.flow.unknown-xyz", source: "vision", attribution: "builder-error" },
    ]);
    assert(rows.every((r) => r.category && r.requiredMode && r.detector),
      "enrichWorkOrder must stamp category/detector/requiredMode", problems);
    const unk = rows.find((r) => /unknown-xyz/.test(r.issueKey));
    assert(unk?.requiredMode !== "style",
      "enrichWorkOrder must not style-default unknown findings", problems);
    const stack = rows.find((r) => /card-stack/.test(r.issueKey));
    assert(stack?.requiredMode === "structure" || stack?.category === "structure",
      `card-stack-structure must be structure (got ${stack?.category}/${stack?.requiredMode})`, problems);
  }

  // trap-routing.json: defaultRoute must not be bare style
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "knowledge/trap-routing.json"), "utf8"));
    assert(manifest.defaultRoute?.mode !== "style",
      `trap-routing defaultRoute.mode must not be style (got ${manifest.defaultRoute?.mode})`, problems);
    assert((manifest.modes || []).includes("behavior") && (manifest.modes || []).includes("wireframe"),
      "trap-routing modes must include behavior + wireframe", problems);
  } catch (e) {
    problems.push(`trap-routing.json unreadable: ${e.message}`);
  }

  // Detection coverage modules exist
  for (const rel of [
    "scripts/wireframe-source-validate.mjs",
    "scripts/interaction-state-probe.mjs",
  ]) {
    try { await fs.access(path.join(ROOT, rel)); }
    catch { problems.push(`missing detection coverage module: ${rel}`); }
  }

  if (problems.length) {
    for (const p of problems) console.error("  ✗ defect-contract: " + p);
    return false;
  }
  console.log("✓ Defect-contract — typed findings, non-CSS default routing, symptom merge, detection modules");
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  calibrateDefectContract().then((ok) => process.exit(ok ? 0 : 1));
}

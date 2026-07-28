#!/usr/bin/env node
// judge-validation.mjs — offline guards for Judge probe provenance, evidence
// landmarks, degraded verdicts, CDP resilience markers, and cold-start detection.
//
// Wired from golden/run-golden.mjs. These tests are written to FAIL until the
// corresponding scripts land (TDD).

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodePNG } from "../scripts/visual-diff.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "golden", "judge-validation-fixture");

export async function ensureFixture() {
  await fs.mkdir(FIXTURE, { recursive: true });
  await fs.mkdir(path.join(FIXTURE, "frames"), { recursive: true });
  await fs.mkdir(path.join(FIXTURE, "appearance"), { recursive: true });
  await fs.mkdir(path.join(FIXTURE, "composed-audit"), { recursive: true });

  const planStyle = {
    tokens: { "font-family": "'Poppins'" },
    rules: [
      {
        selector: ".vc-list",
        decls: { display: "flex", "flex-direction": "column", gap: "16px" },
        specNodeId: "369:29437",
        purpose: "style",
      },
      {
        selector: ".vc-body",
        decls: { gap: "4px", padding: "12px", width: "322px", "border-radius": "8px" },
        specNodeId: "369:29568",
        purpose: "style",
      },
      {
        selector: ".vc-dialogcontainer",
        decls: { gap: "16px", padding: "12px", width: "322px", "border-radius": "8px" },
        specNodeId: "369:29438",
        purpose: "style",
      },
      {
        selector: ".vc-composer",
        decls: { padding: "8px 10px", "border-radius": "8px", border: "1px solid #1a1917" },
        state: "selected",
        specNodeId: "369:29637",
        purpose: "style",
      },
    ],
  };
  const planFills = {
    hostProps: [
      { prop: "commentPlaceholder", value: "Comment or tag others with @" },
      { prop: "replyPlaceholder", value: "Reply to Wilson..." },
    ],
    // Design Structure Map box for ThreadCard body (single-comment card height)
    nodes: [
      { vcClass: ".vc-body", box: { x: 0, y: 0, w: 322, h: 112 }, specNodeId: "369:29568" },
    ],
  };
  const designSpec = {
    probeExpectations: {
      "single-card-height": { expected: 112, unit: "px" },
    },
    blocks: {
      "state-comment-thread-components-single-comment-dialog": {
        frameRegion: { x: 0, y: 0, w: 322, h: 112 },
      },
    },
  };
  await fs.writeFile(path.join(FIXTURE, "plan-style.json"), JSON.stringify(planStyle, null, 2));
  await fs.writeFile(path.join(FIXTURE, "plan-fills.json"), JSON.stringify(planFills, null, 2));
  await fs.writeFile(path.join(FIXTURE, "designSpec.json"), JSON.stringify(designSpec, null, 2));
  await fs.writeFile(path.join(FIXTURE, "blocks.json"), JSON.stringify({
    blocks: [
      { id: "flow", family: "sidebar" },
      { id: "state-comment-thread-components-selected-state", family: "thread" },
    ],
  }, null, 2));

  // Non-blank 64×64 PNG (checkerboard) for crop/blank tests
  const w = 64, h = 64;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const on = ((x >> 3) ^ (y >> 3)) & 1;
      data[o] = on ? 40 : 220;
      data[o + 1] = on ? 40 : 220;
      data[o + 2] = on ? 40 : 220;
      data[o + 3] = 255;
    }
  }
  const png = encodePNG(w, h, data);
  await fs.writeFile(path.join(FIXTURE, "composed-audit", "live-panel.png"), png);
  await fs.writeFile(path.join(FIXTURE, "frames", "flow.png"), png);
}

function assert(cond, msg, problems) {
  if (!cond) problems.push(msg);
}

export async function calibrateJudgeValidation() {
  const problems = [];
  await ensureFixture();

  // --- 1) Design-sourced probe expectations ---
  let loadExpectations;
  try {
    ({ loadProbeExpectations: loadExpectations } = await import(
      pathToFileURL(path.join(ROOT, "scripts/judge-probe-expectations.mjs")).href + `?t=${Date.now()}`
    ));
  } catch (e) {
    problems.push(`judge-probe-expectations.mjs missing/unloadable: ${e.message}`);
    loadExpectations = null;
  }

  if (loadExpectations) {
    const ex = await loadExpectations(FIXTURE);
    const listGap = (ex.probes || []).find((p) => p.id === "list-gap" || p.id === "comment-gap");
    assert(!!listGap, "expected list-gap/comment-gap probe expectation from plan-style", problems);
    if (listGap) {
      assert(Number(listGap.expected) === 16, `list-gap expected must be 16 (got ${listGap.expected})`, problems);
      assert(listGap.expectedSource === "plan-style.json", `list-gap expectedSource must be plan-style.json (got ${listGap.expectedSource})`, problems);
      assert(/vc-list|gap/i.test(String(listGap.designPath || "")), `list-gap designPath must cite .vc-list gap (got ${listGap.designPath})`, problems);
    }
    const required = ["list-gap", "card-internal-spacing", "single-card-height", "selected-reply-placeholder"];
    for (const id of required) {
      const hit = (ex.probes || []).find((p) => p.id === id || (id === "list-gap" && p.id === "comment-gap"));
      assert(!!hit, `missing design-sourced probe expectation: ${id}`, problems);
      if (hit) {
        assert(!!hit.expectedSource && hit.expectedSource !== "live-dom",
          `${id} must have design expectedSource (got ${hit.expectedSource})`, problems);
        assert(!!hit.designPath, `${id} must carry designPath`, problems);
      }
    }
    // Reject live-DOM provenance
    const reject = ex.validateProbe?.({ id: "bogus", expected: 8, expectedSource: "live-dom", designPath: null });
    assert(reject && reject.ok === false, "validateProbe must reject expectedSource=live-dom", problems);
  }

  // --- 2) Landmark-anchored evidence helpers ---
  let evidenceMod;
  try {
    evidenceMod = await import(
      pathToFileURL(path.join(ROOT, "scripts/judge-evidence.mjs")).href + `?t=${Date.now()}`
    );
  } catch (e) {
    problems.push(`judge-evidence.mjs unloadable: ${e.message}`);
  }
  if (evidenceMod) {
    assert(typeof evidenceMod.landmarkQueryForIssue === "function",
      "judge-evidence must export landmarkQueryForIssue(issueId)", problems);
    if (typeof evidenceMod.landmarkQueryForIssue === "function") {
      const chev = evidenceMod.landmarkQueryForIssue("show-replies-chevron-missing");
      assert(/more-reply|show/i.test(String(chev || "")),
        `chevron landmark query must target Show-replies row (got ${chev})`, problems);
      const hover = evidenceMod.landmarkQueryForIssue("resolve-on-hover-missing");
      assert(/resolve|options|hover/i.test(String(hover || "")),
        `hover landmark query must target resolve/options (got ${hover})`, problems);
      const a = evidenceMod.landmarkQueryForIssue("show-replies-chevron-missing");
      const b = evidenceMod.landmarkQueryForIssue("composer-missing-shadow");
      assert(a && b && a !== b, "different semantic issues must not share the same landmark query", problems);
    }
    assert(typeof evidenceMod.validateSubjectInCrop === "function",
      "judge-evidence must export validateSubjectInCrop", problems);
    assert(typeof evidenceMod.requiresHoverCapture === "function",
      "judge-evidence must export requiresHoverCapture", problems);
    if (typeof evidenceMod.requiresHoverCapture === "function") {
      assert(evidenceMod.requiresHoverCapture("resolve-on-hover-missing") === true,
        "resolve-on-hover-missing requires hover capture", problems);
    }
  }

  // --- 3) Strict degraded-run verdict ---
  let verdictOf;
  try {
    ({ judgeVerifyVerdict: verdictOf } = await import(
      pathToFileURL(path.join(ROOT, "scripts/judge-verify-verdict.mjs")).href + `?t=${Date.now()}`
    ));
  } catch (e) {
    problems.push(`judge-verify-verdict.mjs missing/unloadable: ${e.message}`);
    verdictOf = null;
  }
  if (verdictOf) {
    const clean = verdictOf({ failCriteria: { orphanedVision: false, blankCrops: false } });
    assert(clean.verdict === "PASS", `clean run must PASS (got ${clean.verdict})`, problems);

    const degraded = verdictOf({
      failCriteria: {
        orphanedVision: false,
        blankCrops: false,
        selectorLiveUnresolved: true,
        evidenceWithoutConnect: true,
      },
    });
    assert(degraded.verdict === "PASS-DEGRADED",
      `selectorLiveUnresolved/evidenceWithoutConnect must be PASS-DEGRADED (got ${degraded.verdict})`, problems);
    assert(/selectorLiveUnresolved|evidenceWithoutConnect|CDP|hover/i.test(String(degraded.reasons || [])),
      "PASS-DEGRADED must surface degradation reasons", problems);

    const hardFail = verdictOf({ failCriteria: { orphanedVision: true, blankCrops: false } });
    assert(hardFail.verdict === "FAIL", `orphanedVision must FAIL (got ${hardFail.verdict})`, problems);

    const plainPassBanned = verdictOf({
      failCriteria: { selectorLiveUnresolved: true },
    });
    assert(plainPassBanned.verdict !== "PASS",
      "any true failCriteria must not yield plain PASS", problems);
  }

  // --- 4) CDP resilience markers ---
  if (evidenceMod) {
    assert(typeof evidenceMod.markEvidenceSource === "function",
      "judge-evidence must export markEvidenceSource({connected, retries})", problems);
    if (typeof evidenceMod.markEvidenceSource === "function") {
      const offline = evidenceMod.markEvidenceSource({ connected: false, retries: 2 });
      assert(offline === "degraded-source",
        `offline evidence must be degraded-source (got ${offline})`, problems);
      const online = evidenceMod.markEvidenceSource({ connected: true, retries: 0 });
      assert(online === "live-cdp", `live evidence must be live-cdp (got ${online})`, problems);
    }
    if (typeof evidenceMod.hoverEvidenceStatus === "function") {
      const blocked = evidenceMod.hoverEvidenceStatus({ connected: false, issueId: "resolve-on-hover-missing" });
      assert(blocked?.ok === false, "hover evidence without CDP must fail", problems);
    } else {
      problems.push("judge-evidence must export hoverEvidenceStatus");
    }
  }

  // --- 5) Cold-start detection ---
  let coldStart;
  try {
    ({ runColdStartDetection: coldStart } = await import(
      pathToFileURL(path.join(ROOT, "scripts/judge-cold-start.mjs")).href + `?t=${Date.now()}`
    ));
  } catch (e) {
    problems.push(`judge-cold-start.mjs missing/unloadable: ${e.message}`);
    coldStart = null;
  }
  if (coldStart) {
    const result = await coldStart({
      fixtureDir: FIXTURE,
      novelId: "cold-start-magenta-stripe",
      novelIssue: "injected magenta diagnostic stripe visible on panel chrome — novel cold-start defect",
    });
    assert(result?.startedEmpty === true, "cold-start must begin with empty vision record", problems);
    assert(result?.detected === true, "cold-start must detect the novel defect", problems);
    assert(result?.emittedOnce === true, "cold-start novel defect must emit exactly once", problems);
    assert(result?.evidenced === true, "cold-start novel defect must have crop evidence", problems);
    assert(result?.routed === true, "cold-start novel defect must have a route", problems);
    assert(!result?.replayedPriorMisses, "cold-start must not replay prior semantic misses", problems);
  }

  if (problems.length) {
    for (const p of problems) console.error("  ✗ judge-validation: " + p);
    return false;
  }
  console.log("✓ Judge-validation — design-sourced probes, landmark evidence, PASS-DEGRADED, CDP markers, cold-start");
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  calibrateJudgeValidation().then((ok) => process.exit(ok ? 0 : 1));
}

#!/usr/bin/env node
// obs.mjs — the SESSION-REPLAY observability layer for a velt-customize run.
//
// The debugging story before this: a run's only durable traces were progress.log (prose lines),
// loop-state.json / block-report.json (current state, no history), and results/<blockId>/shot.png —
// which every measurement OVERWRITES, so by the time a phase ended there was no way to see *which
// stage of which iteration* a defect entered the flow ("the planner corrupted border→background at
// iteration 1 and everything downstream chased it"). Pinpointing that took hours of manual folder
// spelunking per run.
//
// This module gives every run a replayable record, automatically:
//   * EVENTS   — pipeline scripts append one structured JSON line per meaningful step to
//                <phaseDir>/obs/events.jsonl (stage start/end, block start, every measurement,
//                every fix-loop iteration verdict, dispositions, pauses, gate verdicts, heartbeat
//                lines). Recording is FAIL-SAFE: it can never throw, never changes an exit code,
//                and VELT_OBS=0 disables it entirely.
//   * SNAPSHOTS — the per-iteration screenshots + probe artifacts are COPIED into
//                <phaseDir>/obs/snapshots/<blockId>/<seq>/ before the next measurement overwrites
//                them, so the replay has one frame per iteration, not just the last one.
//   * PLAYER   — `obs.mjs build` renders <phaseDir>/obs/player.html: a self-contained,
//                zero-dependency session-replay UI (timeline scrubber, per-block iteration lanes,
//                live/reference/diff screenshot viewer, judge output per event). Works over file://
//                (data is inlined, images are relative paths) or via `obs.mjs serve`.
//
// Usage:
//   node scripts/obs.mjs event <phaseDir> --type <t> [--stage s] [--block id] [--iter n]
//        [--ok true|false] [--summary "…"] [--data '<json>'] [--data-file f] [--snapshot]
//   node scripts/obs.mjs snapshot <phaseDir> <blockId> [--iter n]     # copy results/<blockId>/* now
//   node scripts/obs.mjs build <phaseDir> [--out <file>]              # (re)generate the player
//   node scripts/obs.mjs serve <phaseDir> [--port 4173]               # build + serve over http
//   node scripts/obs.mjs status <phaseDir>                            # event/snapshot counts
//
// Event line shape (one JSON object per line, append-only, UTC ISO timestamps):
//   { t, type, stage?, blockId?, iter?, ok?, summary, data?, shots?, artifacts?, src }
//   shots/artifacts paths are RELATIVE TO phaseDir (the player lives at obs/player.html and
//   prefixes "../"). `type` vocabulary (open — the player renders unknown types generically):
//   run.start · stage.start · stage.end · stage.timeout · block.start · measure · measure.fail ·
//   smoke · iter.record · disposition · pause · resume · phase.softcap · verdict · handoff · log

import {
  appendFileSync, mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, statSync,
} from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(SCRIPTS, "..", "templates", "obs-player.html");

const enabled = () => process.env.VELT_OBS !== "0";
const obsDir = (phaseDir) => path.join(phaseDir, "obs");
const eventsPath = (phaseDir) => path.join(obsDir(phaseDir), "events.jsonl");
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------
// obsEvent — append one structured event. SYNC + FAIL-SAFE by contract: pipeline scripts call this
// inline on their hot paths (including right before process.exit), so it must never throw, never
// block, and never alter behavior. Returns the event written, or null when disabled/failed.
export function obsEvent(phaseDir, evt) {
  if (!enabled() || !phaseDir) return null;
  try {
    const e = { t: nowIso(), ...evt };
    // SHOT ARCHIVING (phase-filmstrip fix): live/diff shot paths often point at files the pipeline
    // OVERWRITES on every capture (dom-snapshot/<id>.png) — every gallery card then shows the
    // LATEST pixels and the stage-by-stage visual history is destroyed. Archive a per-event copy
    // under obs/shots/ and point the event at the copy, so each card keeps ITS OWN frame.
    // (ref frames are write-once and paths already under obs/ are already archived — left as-is.)
    if (e.shots) {
      const stamp = e.t.replace(/[-:TZ.]/g, "").slice(4, 15);   // MMDDhhmmssm — unique enough per block
      for (const k of ["live", "diff"]) {
        const rel = e.shots[k];
        if (!rel || String(rel).startsWith("obs/")) continue;
        const src = path.join(phaseDir, rel);
        if (!existsSync(src)) continue;
        const dst = path.join(obsDir(phaseDir), "shots", `${stamp}-${path.basename(rel)}`);
        mkdirSync(path.dirname(dst), { recursive: true });
        copyFileSync(src, dst);
        e.shots = { ...e.shots, [k]: ["obs", "shots", path.basename(dst)].join("/") };
      }
    }
    if (typeof e.summary === "string" && e.summary.length > 2000) e.summary = e.summary.slice(0, 2000) + "…";
    // keep lines bounded: a runaway data payload must not turn the event log into a memory hazard
    let line = JSON.stringify(e);
    if (line.length > 64 * 1024) { e.data = { truncated: true, note: "payload exceeded 64KB and was dropped" }; line = JSON.stringify(e); }
    mkdirSync(obsDir(phaseDir), { recursive: true });
    appendFileSync(eventsPath(phaseDir), line + "\n");   // O_APPEND: atomic for lines of this size
    return e;
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// obsActiveStage — the pipeline phase running NOW per stage-timer's ledger (stage-state.json):
// the started-but-not-ended stage, else the most recently ended one. Lets capture events label
// themselves by PHASE ("after build-style") instead of wall-clock time, so the replay gallery
// reads as a phase filmstrip. FAIL-SAFE: null when no ledger.
export function obsActiveStage(phaseDir) {
  try {
    const stages = JSON.parse(readFileSync(path.join(phaseDir, "stage-state.json"), "utf8")).stages || {};
    let running = null, lastEnded = null, lastEndT = 0;
    for (const [name, s] of Object.entries(stages)) {
      if (s.startedAt && !s.endedAt) running = name;
      if (s.endedAt && Date.parse(s.endedAt) > lastEndT) { lastEndT = Date.parse(s.endedAt); lastEnded = name; }
    }
    return running || lastEnded;
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// obsSnapshotBlock — preserve the CURRENT measurement artifacts of a block before the next
// iteration overwrites them. Copies results/<blockId>/{shot,diff}.png + every probe JSON into
// obs/snapshots/<blockId>/<seq>/, resolves the (stable, write-once) reference frame from
// blocks.json, and returns { dir, shots:{live,ref,diff}, artifacts:{…} } with phaseDir-relative
// paths — ready to attach to an event. FAIL-SAFE: returns null instead of throwing.
const SNAPSHOT_FILES = ["shot.png", "diff.png", "visual.json", "delta.json", "stability.json",
  "contract.json", "reconciliation.json", "fixture.json", "console.json", "triage.json"];

export function obsSnapshotBlock(phaseDir, blockId, { iter = null } = {}) {
  if (!enabled() || !phaseDir || !blockId) return null;
  try {
    const resDir = path.join(phaseDir, "results", blockId);
    if (!existsSync(resDir)) return null;
    const blockSnapRoot = path.join(obsDir(phaseDir), "snapshots", blockId);
    mkdirSync(blockSnapRoot, { recursive: true });
    const seq = readdirSync(blockSnapRoot).filter((n) => /^\d/.test(n)).length + 1;
    const label = String(seq).padStart(3, "0") + (iter != null ? `-iter${iter}` : "");
    const snapDir = path.join(blockSnapRoot, label);
    mkdirSync(snapDir, { recursive: true });

    const rel = (p) => path.relative(phaseDir, p).split(path.sep).join("/");
    const shots = {}, artifacts = {};
    for (const f of SNAPSHOT_FILES) {
      const src = path.join(resDir, f);
      if (!existsSync(src)) continue;
      const dst = path.join(snapDir, f);
      copyFileSync(src, dst);
      if (f === "shot.png") shots.live = rel(dst);
      else if (f === "diff.png") shots.diff = rel(dst);
      else artifacts[f.replace(/\.json$/, "")] = rel(dst);
    }
    // the reference frame is write-once under frames/ — reference it, don't copy it
    try {
      const blocks = JSON.parse(readFileSync(path.join(phaseDir, "blocks.json"), "utf8"));
      const b = (blocks.blocks || []).find((x) => x.id === blockId);
      if (b && b.framePng && existsSync(path.join(phaseDir, b.framePng))) shots.ref = b.framePng.split(path.sep).join("/");
    } catch { /* no blocks.json yet — snapshot still valid */ }
    if (!Object.keys(shots).length && !Object.keys(artifacts).length) return null;
    return { dir: rel(snapDir), shots, artifacts };
  } catch { return null; }
}

// obsIterHint — best-effort "which iteration is this measurement for": measurement runs BEFORE
// block-iter record, so the upcoming attempt is attempts.length + 1. Null when unknowable.
export function obsIterHint(phaseDir, blockId) {
  try {
    const s = JSON.parse(readFileSync(path.join(phaseDir, "loop-state.json"), "utf8"));
    const b = s.blocks && s.blocks[blockId];
    return b ? b.attempts.length + 1 : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// buildPlayer — assemble every on-disk trace into one self-contained player.html. Data is inlined
// as JSON (fetch() doesn't work over file://); screenshots stay as relative <img> paths (which do).
// { inline: true } additionally embeds every referenced image as a data: URI so the ONE file can be
// shared/viewed anywhere (mailed, uploaded, rendered from a headless/cloud run with no fs access) —
// bigger output, zero external references.
// assembleRun — read every on-disk trace into the RUN data object (shared by the build-time
// inlining AND the live /run.json endpoint the served player polls).
export function assembleRun(phaseDir) {
  const readJson = (p) => { try { return JSON.parse(readFileSync(path.join(phaseDir, p), "utf8")); } catch { return null; } };
  const events = [];
  try {
    for (const line of readFileSync(eventsPath(phaseDir), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* skip a torn/corrupt line */ }
    }
  } catch { /* no events yet — the player renders an empty-state hint */ }

  let progressLog = null;
  try {
    const lines = readFileSync(path.join(phaseDir, "progress.log"), "utf8").split("\n");
    progressLog = lines.slice(-4000).join("\n");
  } catch { /* optional */ }

  return {
    generatedAt: nowIso(),
    phaseId: path.basename(path.resolve(phaseDir)),
    events,
    blocks: readJson("blocks.json"),
    loopState: readJson("loop-state.json"),
    stageState: readJson("stage-state.json"),
    blockReport: readJson("block-report.json"),
    progressLog,
  };
}

export function buildPlayer(phaseDir, { out = null, inline = false } = {}) {
  const run = assembleRun(phaseDir);
  const events = run.events;

  if (inline) {
    // embed every image an event (or block reference frame) points at, keyed by its
    // phaseDir-relative path — the player's rel() checks this map before falling back to ../<path>
    const assets = {};
    const addAsset = (p) => {
      if (!p) return;
      const key = String(p).replace(/^\.?\//, "");
      if (assets[key]) return;
      try {
        const buf = readFileSync(path.join(phaseDir, key));
        if (buf.length > 8 * 1024 * 1024) return;   // an 8MB+ image would bloat the file past usefulness
        assets[key] = "data:image/png;base64," + buf.toString("base64");
      } catch { /* missing on disk — the player shows its placeholder */ }
    };
    for (const e of events) if (e.shots) for (const p of Object.values(e.shots)) addAsset(p);
    for (const b of (run.blocks && run.blocks.blocks) || []) addAsset(b.framePng);
    run.assets = assets;
  }

  const template = readFileSync(TEMPLATE, "utf8");
  // </script-safe embedding: the only sequence that could terminate the inline script early
  const payload = JSON.stringify(run).replace(/<\//g, "<\\/");
  const html = template.replace("/*__VELT_OBS_RUN_DATA__*/null", payload);
  if (html === template) throw new Error("obs-player template is missing the /*__VELT_OBS_RUN_DATA__*/null placeholder");
  const outPath = out || path.join(obsDir(phaseDir), "player.html");
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  return { outPath, events: events.length, blocks: (run.blocks?.blocks || []).length };
}

// buildPlayerSafe — the hook-side variant (write-handoff regenerates the player at run end):
// same fail-safe contract as obsEvent.
export function buildPlayerSafe(phaseDir) {
  if (!enabled()) return null;
  try { return buildPlayer(phaseDir); } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// serve — a tiny static server. TWO modes, auto-detected from the directory you point it at:
//   * RUN dir      → the original single-run player (unchanged; /run.json live polling).
//   * RUNS ROOT    → ONE server over ALL runs (e.g. `node scripts/obs.mjs serve runs`): the player
//                    gets a run SWITCHER (toggle between iterations without restarting anything),
//                    /runs.json lists every run with verdict/events/stage summaries, new runs
//                    appear in the dropdown live, and each run's files serve under /r/<runId>/….
//                    This replaces the old start-a-server-per-run workflow.
const MIME = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".json": "application/json",
  ".jsonl": "application/x-ndjson", ".svg": "image/svg+xml", ".log": "text/plain; charset=utf-8",
  ".js": "text/javascript", ".css": "text/css", ".md": "text/plain; charset=utf-8" };

// a directory is a RUN when it carries any of the run-trace files the pipeline writes
export function isRunDir(d) {
  return ["obs", "blocks.json", "stage-state.json", "progress.log", "designSpec.json"]
    .some((f) => existsSync(path.join(d, f)));
}
export function listRuns(root) {
  try {
    return readdirSync(root).filter((name) => {
      const d = path.join(root, name);
      try { return statSync(d).isDirectory() && isRunDir(d); } catch { return false; }
    }).sort();
  } catch { return []; }
}
// cheap per-run summary for the switcher: id, when, verdict, counts, stage progress
export function runSummary(root, id) {
  const d = path.join(root, id);
  let events = 0, lastEventAt = null, verdict = null, screenshots = 0;
  try {
    for (const line of readFileSync(path.join(d, "obs", "events.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      events++;
      try {
        const e = JSON.parse(line);
        lastEventAt = e.t || lastEventAt;
        if (e.shots && e.shots.live) screenshots++;
        if ((e.type === "verdict" || e.type === "handoff") && e.data?.verdict) verdict = e.data.verdict;
      } catch { /* torn line */ }
    }
  } catch { /* no events */ }
  let blocks = 0, stages = [];
  try { blocks = (JSON.parse(readFileSync(path.join(d, "blocks.json"), "utf8")).blocks || []).length; } catch { /* none */ }
  try {
    const st = JSON.parse(readFileSync(path.join(d, "stage-state.json"), "utf8")).stages || {};
    stages = Object.entries(st).map(([name, s]) => ({ name, done: !!s.endedAt, cap: !!s.stoppedByTimer }));
  } catch { /* none */ }
  let mtime = 0;
  try { mtime = statSync(d).mtimeMs; } catch { /* gone */ }
  return { id, events, screenshots, lastEventAt, verdict, blocks, stages, mtime };
}

function serveMulti(root, port) {
  const server = createServer((req, res) => {
    try {
      const u = new URL(req.url, "http://x");
      const urlPath = decodeURIComponent(u.pathname);
      if (urlPath === "/" || urlPath === "/index.html") {
        // template read per-request → editing the template or adding runs never needs a restart
        const html = readFileSync(TEMPLATE, "utf8")
          .replace("/*__VELT_OBS_RUN_DATA__*/null", JSON.stringify({ multi: true, root: path.basename(root) }));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html);
        return;
      }
      if (urlPath === "/runs.json") {
        const runs = listRuns(root).map((id) => runSummary(root, id)).sort((a, b) => b.mtime - a.mtime);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ root: path.basename(root), generatedAt: nowIso(), runs }));
        return;
      }
      if (urlPath === "/run.json") {
        const id = u.searchParams.get("run") || "";
        const d = path.resolve(root, id);
        if (!id || !d.startsWith(path.resolve(root) + path.sep) || !existsSync(d) || !isRunDir(d)) {
          res.writeHead(404); res.end("unknown run"); return;
        }
        const run = assembleRun(d);
        run.runId = id;
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(run));
        return;
      }
      if (urlPath.startsWith("/r/")) {
        const fp = path.normalize(path.join(root, urlPath.slice(3)));
        if (!fp.startsWith(path.resolve(root) + path.sep)) { res.writeHead(403); res.end("forbidden"); return; }
        if (!existsSync(fp) || statSync(fp).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream", "cache-control": "no-store" });
        res.end(readFileSync(fp));
        return;
      }
      res.writeHead(404); res.end("not found");
    } catch { res.writeHead(500); res.end("error"); }
  });
  server.listen(port, "127.0.0.1", () => {
    const p = server.address().port;
    const runs = listRuns(root);
    console.log(`▶ observability (ALL runs): http://127.0.0.1:${p}/   (Ctrl-C to stop)`);
    console.log(`  root: ${root} — ${runs.length} run(s): ${runs.slice(0, 6).join(", ")}${runs.length > 6 ? ", …" : ""}`);
    console.log(`  toggle runs in the header dropdown; new runs appear live; each run polls its own /run.json`);
  });
}

function serve(phaseDir, port) {
  const root = path.resolve(phaseDir);
  // RUNS ROOT (not itself a run, but contains runs — or is empty and named like a root) → multi-run
  if (!isRunDir(root) || listRuns(root).length) {
    serveMulti(root, port);
    return;
  }
  const server = createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
      // LIVE data endpoint: the player polls this and re-renders — no rebuild/reload needed
      if (urlPath === "/run.json") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(assembleRun(root)));
        return;
      }
      // the player itself is rebuilt on every request, so a plain reload is also always fresh
      if (urlPath === "/" || urlPath === "/obs/player.html") buildPlayerSafe(root);
      const fp = path.normalize(path.join(root, urlPath === "/" ? "/obs/player.html" : urlPath));
      if (!fp.startsWith(root + path.sep) && fp !== root) { res.writeHead(403); res.end("forbidden"); return; }
      if (!existsSync(fp) || statSync(fp).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(readFileSync(fp));
    } catch { res.writeHead(500); res.end("error"); }
  });
  server.listen(port, "127.0.0.1", () => {
    const p = server.address().port;
    console.log(`▶ replay player (single run): http://127.0.0.1:${p}/obs/player.html   (Ctrl-C to stop)`);
    console.log(`  LIVE: the page polls /run.json and re-renders as new events/screenshots arrive — no reload needed`);
    console.log(`  tip: serve the runs ROOT instead (node scripts/obs.mjs serve runs) to toggle between ALL runs in one UI`);
  });
}

// ---------------------------------------------------------------------------------------------
async function main() {
  let [cmd, phaseDir, ...rest] = process.argv.slice(2);
  // `serve` with no dir (or a flag first) defaults to the runs ROOT — one server, all runs
  if (cmd === "serve" && (!phaseDir || phaseDir.startsWith("--"))) {
    if (phaseDir) rest.unshift(phaseDir);
    phaseDir = "runs";
  }
  const flag = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  if (!cmd || !phaseDir) {
    console.error("usage: obs.mjs event|snapshot|build|status <phaseDir> [flags]\n       obs.mjs serve [runsRoot|phaseDir] [--port n]   (default root: runs/ — ONE server, ALL runs, toggle in the UI)");
    process.exit(1);
  }

  if (cmd === "event") {
    const type = flag("--type");
    if (!type) { console.error("✗ --type <t> is required"); process.exit(1); }
    let data;
    const dataFile = flag("--data-file");
    try {
      if (dataFile) data = JSON.parse(readFileSync(dataFile, "utf8"));
      else if (flag("--data")) data = JSON.parse(flag("--data"));
    } catch (e) { console.error(`✗ --data/--data-file is not valid JSON: ${e.message}`); process.exit(1); }
    const blockId = flag("--block");
    const iterRaw = flag("--iter");
    let snap = null;
    if (rest.includes("--snapshot") && blockId) snap = obsSnapshotBlock(phaseDir, blockId, { iter: iterRaw != null ? +iterRaw : null });
    const e = obsEvent(phaseDir, {
      type, src: flag("--src", "cli"),
      ...(flag("--stage") ? { stage: flag("--stage") } : {}),
      ...(blockId ? { blockId } : {}),
      ...(iterRaw != null ? { iter: +iterRaw } : {}),
      ...(flag("--ok") != null ? { ok: flag("--ok") === "true" } : {}),
      ...(flag("--summary") ? { summary: flag("--summary") } : {}),
      ...(data !== undefined ? { data } : {}),
      ...(snap ? { shots: snap.shots, artifacts: snap.artifacts } : {}),
    });
    console.log(e ? `✓ obs event '${type}' recorded${snap ? ` (+snapshot ${snap.dir})` : ""}` : "obs disabled/failed (VELT_OBS=0?) — nothing recorded");
    return;
  }

  if (cmd === "snapshot") {
    const blockId = rest[0];
    if (!blockId) { console.error("usage: obs.mjs snapshot <phaseDir> <blockId> [--iter n]"); process.exit(1); }
    const snap = obsSnapshotBlock(phaseDir, blockId, { iter: flag("--iter") != null ? +flag("--iter") : null });
    if (!snap) { console.error(`✗ nothing to snapshot for '${blockId}' (results/${blockId}/ empty or missing)`); process.exit(2); }
    console.log(`✓ snapshot → ${snap.dir} (${Object.keys(snap.shots).length} image(s), ${Object.keys(snap.artifacts).length} artifact(s))`);
    return;
  }

  if (cmd === "build") {
    const inline = rest.includes("--inline");
    const r = buildPlayer(phaseDir, { out: flag("--out", null), inline });
    console.log(`✓ player built → ${path.relative(process.cwd(), r.outPath)} (${r.events} event(s), ${r.blocks} block(s)${inline ? ", images inlined — the file is fully self-contained/shareable" : ""})`);
    if (!inline) console.log(`  open it directly (file://) or serve it: node scripts/obs.mjs serve ${phaseDir}\n  (pass --inline to embed the screenshots and get ONE shareable file — e.g. to view a cloud run's replay locally)`);
    return;
  }

  if (cmd === "serve") {
    const root = path.resolve(phaseDir);
    const multi = !isRunDir(root) || listRuns(root).length;
    if (!multi) {
      try { const r = buildPlayer(phaseDir); console.log(`✓ player rebuilt (${r.events} event(s))`); }
      catch (e) { console.error(`⚠ player build failed (${e.message}) — serving whatever exists`); }
    }
    serve(phaseDir, +flag("--port", "4173"));
    return;
  }

  if (cmd === "status") {
    let n = 0, types = {};
    try {
      for (const line of readFileSync(eventsPath(phaseDir), "utf8").split("\n")) {
        if (!line.trim()) continue;
        n++;
        try { const t = JSON.parse(line).type; types[t] = (types[t] || 0) + 1; } catch { /* torn line */ }
      }
    } catch { /* none */ }
    let snaps = 0;
    try {
      for (const b of readdirSync(path.join(obsDir(phaseDir), "snapshots"))) {
        try { snaps += readdirSync(path.join(obsDir(phaseDir), "snapshots", b)).length; } catch { /* file, not dir */ }
      }
    } catch { /* none */ }
    console.log(`${n} event(s), ${snaps} snapshot(s)${n ? " — " + Object.entries(types).map(([k, v]) => `${k}:${v}`).join(" ") : ""}`);
    console.log(existsSync(path.join(obsDir(phaseDir), "player.html")) ? `player: ${path.join(phaseDir, "obs", "player.html")}` : "player: not built yet (obs.mjs build)");
    return;
  }

  console.error(`✗ unknown command '${cmd}'`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

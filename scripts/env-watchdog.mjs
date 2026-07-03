#!/usr/bin/env node
// env-watchdog.mjs — the ENVIRONMENT DEFENSE layer. The two analyzed runs lost ~1.5h each to
// environment failures the loop never noticed until a judge visit died on them: dev servers that
// exited silently, wedged tabs, a 38-min dead-agent gap, session pauses — all silently charged
// against build budgets. This long-lived process:
//   1. probes the pinned appUrl every INTERVAL seconds (HTTP + optional velt-render deep probe);
//   2. on failure: opens an env STALL (`block-iter.mjs pause`) so budgets freeze, appends the
//      reason to progress.log, and — if --restart-cmd is given — restarts the dev server,
//      waits for it to answer, re-verifies identity (verify-app.mjs), then RESUMES the budget;
//   3. watches progress.log staleness: if NOTHING wrote a heartbeat line for --dead-after
//      minutes while no stall is open, it logs a DEAD-AGENT warning line (the orchestrator's
//      cue to kill + respawn the wedged subagent — the watchdog can't do that itself).
//
// It never edits app code and never decides verdicts — it only defends the clock and the env.
//
// Usage:
//   node scripts/env-watchdog.mjs <phaseDir> <appUrl>
//        [--interval 30] [--dead-after 6] [--expect "<substring>"]
//        [--restart-cmd "npm run dev"] [--restart-cwd <dir>] [--max-restarts 3]
// Run it in the background at the end of preflight; kill it at phase stop.

import { promises as fs } from "node:fs";
import { spawn, execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const sh = (cmd, args) => new Promise((res) => execFile(cmd, args, { cwd: process.cwd() }, (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
const nowIso = () => new Date().toISOString();

async function heartbeat(phaseDir, msg) {
  const t = nowIso().slice(11, 19) + "Z";
  await fs.appendFile(path.join(phaseDir, "progress.log"), `[${t}] [watchdog] ${msg}\n`).catch(() => {});
  console.log(`[watchdog] ${msg}`);
}
async function probe(url, timeoutMs = 8000) {
  try { const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) }); return r.ok || r.status < 500; }
  catch { return false; }
}
// DEBOUNCED probe: a single failed fetch is routinely a dev-server recompile blip, and a false
// DOWN costs a stall + restart cycle (a cloud run was killed on exactly this class of false
// positive). Only report DOWN after two consecutive failures a few seconds apart.
async function probeDebounced(url) {
  if (await probe(url)) return true;
  await new Promise((r) => setTimeout(r, 5000));
  return probe(url);
}
async function progressAgeMin(phaseDir) {
  try { const st = await fs.stat(path.join(phaseDir, "progress.log")); return (Date.now() - st.mtimeMs) / 60000; }
  catch { return null; }
}
async function stallOpen(phaseDir) {
  try { const s = JSON.parse(await fs.readFile(path.join(phaseDir, "loop-state.json"), "utf8")); return (s.stalls || []).some((x) => !x.to); }
  catch { return false; }
}

async function main() {
  const [phaseDir, appUrl, ...rest] = process.argv.slice(2);
  if (!phaseDir || !appUrl) { console.error('usage: env-watchdog.mjs <phaseDir> <appUrl> [--interval 30] [--dead-after 6] [--expect "<s>"] [--restart-cmd "npm run dev"] [--restart-cwd <dir>] [--max-restarts 3]'); process.exit(1); }
  const argv = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  const interval = +argv("--interval", "30") * 1000;
  const deadAfter = +argv("--dead-after", "6");
  const expect = argv("--expect", null);
  const restartCmd = argv("--restart-cmd", null);
  const restartCwd = path.resolve(argv("--restart-cwd", "."));
  const maxRestarts = +argv("--max-restarts", "3");
  let restarts = 0, deadWarned = false, deadPending = false;

  await heartbeat(phaseDir, `watchdog up — probing ${appUrl} every ${interval / 1000}s (dead-agent threshold ${deadAfter} min; DOWN and DEAD-AGENT both require two consecutive confirmations)`);

  // one probe loop; never throws out
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ok = await probeDebounced(appUrl);
    if (!ok) {
      await heartbeat(phaseDir, `appUrl DOWN (${appUrl}) — opening env stall; budgets frozen`);
      await sh("node", [path.join(SCRIPTS, "block-iter.mjs"), "pause", phaseDir, "--reason", `watchdog: ${appUrl} unreachable at ${nowIso()}`]);
      if (restartCmd && restarts < maxRestarts) {
        restarts++;
        await heartbeat(phaseDir, `restarting dev server (attempt ${restarts}/${maxRestarts}): ${restartCmd}`);
        const [cmd, ...args] = restartCmd.split(/\s+/);
        const child = spawn(cmd, args, { cwd: restartCwd, detached: true, stdio: "ignore" });
        child.unref();
        // wait up to 120s for the URL to answer again
        const deadline = Date.now() + 120000;
        let back = false;
        while (Date.now() < deadline) { if (await probe(appUrl)) { back = true; break; } await new Promise((r) => setTimeout(r, 3000)); }
        if (back) {
          // identity re-check before resuming — a restart can come back as the WRONG app (B3)
          const v = await sh("node", [path.join(SCRIPTS, "verify-app.mjs"), appUrl, ...(expect ? ["--expect", expect] : []), "--quiet"]);
          if (v.code === 0) {
            await sh("node", [path.join(SCRIPTS, "block-iter.mjs"), "resume", phaseDir]);
            await heartbeat(phaseDir, `dev server back + identity verified — stall closed, budgets running`);
          } else {
            await heartbeat(phaseDir, `dev server answers but identity check FAILED (exit ${v.code}) — stall stays OPEN; fix appUrl/pin manually`);
          }
        } else {
          await heartbeat(phaseDir, `dev server did not come back within 120s — stall stays OPEN; manual fix needed`);
        }
      } else if (!restartCmd) {
        await heartbeat(phaseDir, `no --restart-cmd configured — stall stays OPEN until the env is fixed + 'block-iter.mjs resume' runs`);
      } else {
        await heartbeat(phaseDir, `max restarts (${maxRestarts}) reached — stall stays OPEN; manual intervention needed`);
      }
    } else if (await stallOpen(phaseDir)) {
      // app is healthy but a stall is open (e.g. opened manually or by a prior loop) — verify + close it
      const v = await sh("node", [path.join(SCRIPTS, "verify-app.mjs"), appUrl, ...(expect ? ["--expect", expect] : []), "--quiet"]);
      if (v.code === 0) { await sh("node", [path.join(SCRIPTS, "block-iter.mjs"), "resume", phaseDir]); await heartbeat(phaseDir, "env healthy again — closed the open stall"); }
    }

    // dead-agent detection: heartbeat silence while the env is fine = a wedged/dead subagent.
    // TWO-TICK confirmation: the staleness must hold across two consecutive loop ticks before the
    // warning fires — a single stale reading (agent mid-long-tool-call, fs mtime lag) is not death;
    // a false DEAD-AGENT gets a healthy subagent killed and its work re-done.
    const age = await progressAgeMin(phaseDir);
    if (ok && age != null && age > deadAfter && !(await stallOpen(phaseDir))) {
      if (!deadPending) {
        deadPending = true;   // first stale tick — observe one more interval before declaring
      } else if (!deadWarned) {
        deadWarned = true;
        await heartbeat(phaseDir, `DEAD-AGENT WARNING (confirmed over 2 ticks): no heartbeat for ${age.toFixed(0)} min while the env is healthy — the in-flight subagent is likely wedged; orchestrator should kill + respawn it from the journal (prior runs lost 38 and 13 min here)`);
      }
    } else { deadPending = false; deadWarned = false; }

    await new Promise((r) => setTimeout(r, interval));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

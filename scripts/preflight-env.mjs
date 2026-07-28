#!/usr/bin/env node
// preflight-env.mjs — MACHINE-HYGIENE scan, run as part of preflight before anything expensive.
// Both analyzed runs lost ~30–40 min to an /etc/hosts line pinning `cdn.velt.dev → 127.0.0.1`
// (velt.js then ERR_CONNECTION_REFUSED in every fresh browser profile) — discovered mid-judge,
// twice, on two machines. This scan surfaces that class of machine problem in seconds, up front:
//   * /etc/hosts entries hijacking *.velt.dev / velt CDN hosts;
//   * listening dev-server ports (so the orchestrator pins appUrl against the real list,
//     never an assumed :3000 — ports auto-bump and other projects squat);
//   * clock/timezone sanity print (all plugin timestamps are UTC; a mixed-TZ read corrupted a
//     prior run's phase math — B1).
//
// Usage: node scripts/preflight-env.mjs [--json]
// Exit codes: 0 = clean · 2 = hazards found (each printed with its fix) · 1 = error.

import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const VELT_HOST_RE = /(^|\s)(?!#)[^#]*\b([a-z0-9.-]*velt\.dev)\b/i;

async function scanHosts() {
  const hazards = [];
  let txt = "";
  try { txt = await fs.readFile("/etc/hosts", "utf8"); } catch { return { hazards, note: "/etc/hosts unreadable — skipped" }; }
  for (const [i, line] of txt.split("\n").entries()) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (/velt\.dev/i.test(t)) {
      hazards.push({
        kind: "hosts-velt-pin", line: i + 1, text: t,
        why: "an /etc/hosts entry overrides a velt.dev host — the SDK loads from cdn.velt.dev, and a local pin (usually a stale dev workaround) makes every fresh browser profile fail with ERR_CONNECTION_REFUSED",
        fix: `comment out line ${i + 1} of /etc/hosts ('sudo sed -i.bak "${i + 1}s/^/# /" /etc/hosts') or remove the stale pin, then flush DNS`,
      });
    }
  }
  return { hazards };
}

function listeningPorts() {
  // dev-server-ish listeners on localhost; used to PIN appUrl against reality, never a guess.
  try {
    const out = execFileSync("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
    const rows = out.split("\n").slice(1).filter(Boolean).map((l) => {
      const c = l.split(/\s+/);
      const m = (c[8] || "").match(/:(\d+)$/);
      return m ? { command: c[0], pid: c[1], port: +m[1] } : null;
    }).filter(Boolean);
    const seen = new Set(); const uniq = [];
    for (const r of rows) { const k = r.port + r.command; if (!seen.has(k)) { seen.add(k); uniq.push(r); } }
    return uniq.filter((r) => r.port >= 3000 && r.port <= 9999).sort((a, b) => a.port - b.port);
  } catch { return []; }
}

async function main() {
  const json = process.argv.includes("--json");
  const { hazards, note } = await scanHosts();
  const ports = listeningPorts();
  const clock = { utcNow: new Date().toISOString(), localTz: Intl.DateTimeFormat().resolvedOptions().timeZone, note: "all plugin timestamps are UTC (…Z); never mix local-TZ readings into time math (B1)" };
  const result = { ok: hazards.length === 0, hazards, listeningDevPorts: ports, clock, ...(note ? { note } : {}) };
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`clock: UTC ${clock.utcNow} (local TZ ${clock.localTz} — plugin logs are UTC)`);
    console.log(ports.length ? `listening dev ports: ${ports.map((p) => `${p.port}(${p.command})`).join(" ")} — pin appUrl from the dev server's own output + verify-app.mjs, NEVER an assumed :3000` : "listening dev ports: none found in 3000–9999");
    if (!hazards.length) console.log("✓ /etc/hosts clean — no velt.dev overrides");
    for (const h of hazards) { console.log(`✗ ${h.kind} (line ${h.line}): ${h.text}`); console.log(`    why: ${h.why}`); console.log(`    fix: ${h.fix}`); }
  }
  process.exit(hazards.length ? 2 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

#!/usr/bin/env node
// browser-endpoint.mjs — resolve a REAL browser's CDP WebSocket endpoint for measurement.
//
// WHY THIS EXISTS (the #1 root cause of shipped-broken + false-"done"): the measurement scripts
// (measure-block / capture-block / verify-app) must run in the user's REAL, logged-in browser — NOT a
// throwaway headless Chromium that has no auth/session and cannot fire the real events that open a
// React-state-gated Velt sidebar. Historically `--connect <ws>` was a literal PLACEHOLDER string in
// agent prose with NO producer anywhere, so at runtime measurement silently fell back to a blank
// headless browser (measure-block acquireBrowser) and then false-passed on an empty, never-opened
// surface. This script IS that missing producer, and it pairs with `--require-connect` (added to the
// measurement scripts) which now REFUSES to run headless when a real browser is expected.
//
// Resolution order (first hit wins):
//   1. $VELT_CDP_WS — an explicit ws://… (or http://… CDP base) the user/orchestrator pinned.
//   2. http://127.0.0.1:<port>/json/version → webSocketDebuggerUrl — a Chrome/Chromium started with
//      `--remote-debugging-port=<port>` (default 9222). This is the user's real, authenticated browser.
//
// On success prints the ws endpoint to stdout (exit 0). On failure exits 3 with actionable
// instructions — NEVER returns a headless fallback, because a silent headless browser is exactly the
// failure mode this closes.
//
// Usage:
//   node scripts/browser-endpoint.mjs [--port 9222] [--quiet]
//   VELT_CDP_WS=ws://127.0.0.1:9222/devtools/browser/<id> node scripts/browser-endpoint.mjs
//
// Programmatic: `import { resolveEndpoint } from "./browser-endpoint.mjs"` → returns the ws or null.

import { pathToFileURL } from "node:url";

async function fromHttp(base) {
  const url = String(base).replace(/\/+$/, "") + "/json/version";
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const j = await r.json();
    return j.webSocketDebuggerUrl || null;
  } catch { return null; }
}

// Resolve a real CDP ws endpoint, or null if none is reachable. Never launches or returns headless.
export async function resolveEndpoint({ port = 9222 } = {}) {
  const env = process.env.VELT_CDP_WS;
  if (env) {
    if (/^wss?:\/\//i.test(env)) return env;                 // already a ws endpoint
    if (/^https?:\/\//i.test(env)) { const ws = await fromHttp(env); if (ws) return ws; }
    else return env;                                          // trust a bare value the caller set
  }
  return (await fromHttp(`http://127.0.0.1:${port}`)) || (await fromHttp(`http://localhost:${port}`));
}

export function instructions(port = 9222) {
  return [
    "✗ No real browser CDP endpoint found — measurement needs your REAL, logged-in Chrome.",
    "  A headless throwaway browser cannot open the Velt comments sidebar (it's opened by a real",
    "  interaction / React state), so it would measure an empty surface and falsely report 'done'.",
    "  Provide a real browser ONE of these ways, then re-run:",
    `    • Quit Chrome fully, then start it with remote debugging:`,
    `        macOS:  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=${port}`,
    `        (log in to your app in that window so the measurement shares your session)`,
    `    • OR export an explicit endpoint:  export VELT_CDP_WS=ws://127.0.0.1:${port}/devtools/browser/<id>`,
    "  (Unattended --auto/cloud runs launch their own server browser instead of using this.)",
  ].join("\n");
}

async function main() {
  const a = process.argv.slice(2);
  const port = Number((a[a.indexOf("--port") + 1]) || 9222) || 9222;
  const quiet = a.includes("--quiet");
  const ws = await resolveEndpoint({ port });
  if (ws) { process.stdout.write(ws + "\n"); process.exit(0); }
  if (!quiet) console.error(instructions(port));
  process.exit(3);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();

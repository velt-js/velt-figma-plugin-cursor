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

// --launch: run a DEDICATED measurement browser (playwright server) and print its ws. For apps
// whose auth is self-contained (demo user-select sign-in) this is preferable to attaching to the
// user's personal Chrome: zero tab pollution, immune to personal-browser state (a live run hit a
// wedge where playwright could no longer attach to a long-lived Chrome session even though raw CDP
// answered), and killable without touching the user's browser. Runs until killed — start it as a
// background task and pin the printed ws. NOT for apps needing the user's real logged-in session.
async function launchServer({ headed = false, port = 9223 } = {}) {
  const candidates = [process.env.PLAYWRIGHT_CORE, "playwright-core",
    (process.env.HOME || "") + "/.claude/skills/gstack/node_modules/playwright-core/index.js"].filter(Boolean);
  let chromium = null;
  for (const c of candidates) { try { const m = await import(c); chromium = (m.default || m).chromium; break; } catch { /* next */ } }
  if (!chromium) { console.error("✗ playwright-core not found — `npm i -D playwright-core` or set $PLAYWRIGHT_CORE"); process.exit(3); }
  // CDP-port launch (NOT launchServer): over CDP every connection shares the browser's DEFAULT
  // context, so the one-tab-per-run reuse works across separate script invocations — a
  // launchServer browser gives each connection its own ephemeral context and the tab/auth die
  // with every call (measured). This mirrors a user Chrome with --remote-debugging-port, but
  // dedicated and disposable.
  const browser = await chromium.launch({ headless: !headed, args: [`--remote-debugging-port=${port}`] });
  const ws = await fromHttp(`http://127.0.0.1:${port}`);
  if (!ws) { console.error(`✗ launched browser did not expose CDP on :${port}`); await browser.close(); process.exit(3); }
  process.stdout.write(ws + "\n");
  console.error(`▶ dedicated measurement browser running (${headed ? "headed" : "headless"}, CDP :${port}). Pin the ws above as browserWs; kill this process at run end.`);
  await new Promise(() => {});   // hold until killed
}

async function main() {
  const a = process.argv.slice(2);
  const port = Number((a[a.indexOf("--port") + 1]) || 9222) || 9222;
  const quiet = a.includes("--quiet");
  if (a.includes("--launch")) return launchServer({ headed: a.includes("--headed") });
  const ws = await resolveEndpoint({ port });
  if (ws) { process.stdout.write(ws + "\n"); process.exit(0); }
  if (!quiet) console.error(instructions(port));
  process.exit(3);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

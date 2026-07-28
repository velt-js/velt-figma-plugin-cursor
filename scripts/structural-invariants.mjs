#!/usr/bin/env node
// structural-invariants.mjs — Builder handoff gate for thread/composer enclosure.
//
// Checks (content-independent, general):
//   1. Thread cards present when the family is a comment thread surface
//   2. Reply affordances live inside a card ancestor
//   3. Composer surface contains avatar + (placeholder|input) + send control
//   4. No duplicate visible borders on nested composer wrappers (heuristic)
//
// Usage:
//   node scripts/structural-invariants.mjs <phaseDir> --url <appUrl> --connect <ws> [--family <id>]
//   node scripts/structural-invariants.mjs --check-json <file>   # offline fixture
// Exit 0 = ok, 2 = invariant broken (BLOCKED_FOR_REPLAN / structure fix required)

import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const INVARIANT_PROBE = `(function(){
  function vis(el){if(!el||!el.getBoundingClientRect)return false;var r=el.getBoundingClientRect();return r.width>2&&r.height>2;}
  function q(sel){try{return [...document.querySelectorAll(sel)].filter(vis);}catch(e){return [];}}
  var cards=q('.vc-card, velt-comment-dialog-thread-card-internal, velt-comment-dialog-thread-card-wireframe');
  var replies=q('.vc-reply, velt-comment-dialog-thread-card-reply-internal, velt-comment-dialog-thread-card-reply-wireframe');
  var composers=q('.vc-composer, .vc-reply-composer, velt-comments-sidebar-page-mode-composer-internal, velt-comment-dialog-composer-internal');
  // The invariant is "the Reply affordance is ENCLOSED by the card, not floating outside it". The
  // enclosing card is not always a per-COMMENT thread card: when a design draws ONE Reply per THREAD
  // (harvey — verified in three frames: 2-comment threads show a single Reply row at the bottom of the
  // bordered card), the correct declaration is the thread-level Body ToggleReply and its card ancestor
  // is the dialog container that carries the card chrome. Keying only on thread-card tags reported
  // reply-outside-card for every correctly-enclosed thread.
  var CARD_ANCESTORS='.vc-card, velt-comment-dialog-thread-card-internal, velt-comment-dialog-thread-card-wireframe'
    + ', div.velt-comment-dialog--sidebar-mode, velt-comment-dialog-internal, .vc-list-item';
  var problems=[];
  for(var i=0;i<replies.length;i++){
    var r=replies[i];
    if(!r.closest(CARD_ANCESTORS)){
      problems.push({kind:'reply-outside-card', detail:'Reply affordance not inside a thread card or its dialog card container'});
    }
  }
  for(var c=0;c<composers.length;c++){
    var host=composers[c];
    var hasAvatar=!!host.querySelector('.vc-avatar, snippyly-user-avatar, .velt-user-avatar, [class*=avatar]');
    var hasInput=!!host.querySelector('[contenteditable], input, textarea, .velt-composer-input, .vc-composer-input, .placeholder, [data-placeholder]');
    var hasSend=!!host.querySelector('.vc-send, .vc-reply-composer-send, [class*=send], button');
    if(!(hasAvatar&&hasInput&&hasSend)){
      problems.push({kind:'composer-incomplete', detail:'composer missing avatar/placeholder|input/send', hasAvatar:hasAvatar, hasInput:hasInput, hasSend:hasSend});
    }
  }
  // Nested bordered wrappers: composer host + child both show non-zero border
  for(var c=0;c<composers.length;c++){
    var host=composers[c];
    var kids=[...host.querySelectorAll('div')].filter(vis).slice(0,8);
    var hostCs=getComputedStyle(host);
    var hostBorder=parseFloat(hostCs.borderTopWidth)||0;
    for(var k=0;k<kids.length;k++){
      var kCs=getComputedStyle(kids[k]);
      var kb=parseFloat(kCs.borderTopWidth)||0;
      if(hostBorder>=1&&kb>=1&&kids[k].getBoundingClientRect().height>24){
        problems.push({kind:'double-composer-border', detail:'composer host and child both paint a border'});
        break;
      }
    }
  }
  return {ok:!problems.length, cards:cards.length, replies:replies.length, composers:composers.length, problems};
})()`;

export function evaluateInvariantResult(result, { expectCards = false } = {}) {
  const problems = [...(result?.problems || [])];
  if (expectCards && (result?.cards || 0) < 1) {
    problems.push({ kind: "missing-thread-card", detail: "expected ≥1 thread card on this surface" });
  }
  return { ok: !problems.length, problems, cards: result?.cards || 0, replies: result?.replies || 0, composers: result?.composers || 0 };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--check-json") {
    const data = JSON.parse(await fs.readFile(args[1], "utf8"));
    const r = evaluateInvariantResult(data, { expectCards: !!data.expectCards });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 2);
  }
  const phaseDir = args[0];
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const url = flag("--url");
  const ws = flag("--connect");
  if (!phaseDir || !url || !ws) {
    console.error("usage: structural-invariants.mjs <phaseDir> --url <url> --connect <ws> [--family id]");
    process.exit(1);
  }
  // Resolve Chromium through the SHARED loader (measure-block.loadChromium): it also honours
  // $PLAYWRIGHT_CORE and the gstack-vendored build, so this gate runs wherever measure-block does.
  // A bare require("playwright-core") failed on every machine without a local install even though the
  // rest of the live pipeline worked — an un-runnable gate is indistinguishable from a skipped one.
  let chromium;
  try { ({ chromium } = await import(path.join(path.dirname(fileURLToPath(import.meta.url)), "measure-block.mjs")).then((m) => ({ chromium: m.loadChromium() }))); chromium = await chromium; }
  catch { try { chromium = require("playwright-core").chromium; } catch { console.error("✗ playwright-core required"); process.exit(1); } }
  const browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages().find((p) => p.url().includes(new URL(url).host)) || context.pages()[0] || await context.newPage();
  if (!page.url().startsWith(url.slice(0, 24))) await page.goto(url, { waitUntil: "domcontentloaded" });
  const raw = await page.evaluate(INVARIANT_PROBE);
  const blocks = JSON.parse(await fs.readFile(path.join(phaseDir, "blocks.json"), "utf8").catch(() => '{"blocks":[]}'));
  const famId = flag("--family");
  const expectCards = (blocks.blocks || []).some((b) => (!famId || b.familyId === famId) && /thread|comment-dialog|dialog/i.test(String(b.familyId || "") + String(b.component || "") + String(b.id || "")));
  const result = evaluateInvariantResult(raw, { expectCards });
  const out = path.join(phaseDir, "structural-invariants.json");
  await fs.writeFile(out, JSON.stringify({ ...result, raw, at: new Date().toISOString() }, null, 2));
  console.log(result.ok ? `✓ structural invariants ok (cards=${result.cards}, replies=${result.replies}, composers=${result.composers})` : `✗ structural invariants FAILED: ${result.problems.map((p) => p.kind).join(", ")}`);
  if (!result.ok) console.log("BLOCKED_FOR_REPLAN — fix structure before style/judge handoff");
  process.exit(result.ok ? 0 : 2);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// wireframe-source-validate.mjs — validate customization wireframe SOURCE (not live DOM)
// for required Velt components, slots, nesting, and duplicate roots.
//
// Usage:
//   node scripts/wireframe-source-validate.mjs [dir] [--phase <phaseDir>] [--write]
// Exit 2 when required structure is missing.

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function walk(dir, acc = []) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc);
    else if (/\.(tsx|jsx|ts|js)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

function countRe(src, re) {
  return (src.match(re) || []).length;
}

/**
 * @returns {{ ok: boolean, fails: object[], passes: object[] }}
 */
export function validateWireframeSource(files) {
  const fails = [];
  const passes = [];
  const joined = files.map((f) => f.src).join("\n");
  const wfRoots = countRe(joined, /<VeltWireframe[\s>]/g);
  if (wfRoots === 0) {
    fails.push({ id: "wireframe-root-missing", detail: "no <VeltWireframe> root in customization sources" });
  } else if (wfRoots > 1) {
    fails.push({ id: "wireframe-root-duplicate", detail: `${wfRoots} <VeltWireframe> roots — must be exactly one` });
  } else {
    passes.push({ id: "wireframe-root", detail: "single VeltWireframe root" });
  }

  // Required comment-dialog subtree (when dialog wireframe is declared)
  const declaresDialog = /VeltCommentDialogWireframe|comment-dialog-wireframe/i.test(joined);
  if (declaresDialog) {
    const need = [
      { id: "wf-body", re: /Body[\s.>/}]|body-wireframe/i, label: "Body" },
      { id: "wf-threads", re: /Threads[\s.>/}]|threads-wireframe/i, label: "Threads" },
      { id: "wf-thread-card", re: /ThreadCard[\s.>/}]|thread-card-wireframe/i, label: "ThreadCard" },
      { id: "wf-composer", re: /Composer[\s.>/}]|composer-wireframe/i, label: "Composer" },
    ];
    for (const n of need) {
      if (!n.re.test(joined)) fails.push({ id: n.id, detail: `dialog wireframe missing required ${n.label} slot/component` });
      else passes.push({ id: n.id, detail: `${n.label} present` });
    }
    // MoreReply + ToggleReply commonly required for reply UX
    if (!/MoreReply[\s.>/}]|more-reply-wireframe/i.test(joined)) {
      fails.push({ id: "wf-more-reply", detail: "MoreReply slot not declared — Show-N / chevron cannot mount from CSS" });
    } else passes.push({ id: "wf-more-reply", detail: "MoreReply declared" });
    if (!/ToggleReply[\s.>/}]|toggle-reply-wireframe/i.test(joined)) {
      fails.push({ id: "wf-toggle-reply", detail: "ToggleReply slot not declared" });
    } else passes.push({ id: "wf-toggle-reply", detail: "ToggleReply declared" });

    // Nesting: ThreadCard should appear in a Body/Threads context (heuristic on source order)
    const bodyIdx = joined.search(/Body[\s.>/}]|body-wireframe/i);
    const cardIdx = joined.search(/ThreadCard[\s.>/}]|thread-card-wireframe/i);
    if (bodyIdx >= 0 && cardIdx >= 0 && cardIdx < bodyIdx) {
      fails.push({ id: "wf-nesting-threadcard", detail: "ThreadCard appears before Body in source — likely wrong nesting" });
    } else if (cardIdx >= 0) {
      passes.push({ id: "wf-nesting-threadcard", detail: "ThreadCard nesting order plausible" });
    }
  } else {
    passes.push({ id: "wf-dialog-na", detail: "no comment-dialog wireframe declared — dialog subtree checks skipped" });
  }

  // Sidebar
  if (/VeltCommentsSidebarWireframe|comments-sidebar-wireframe/i.test(joined)) {
    if (!/Panel[\s.>/}]|panel-wireframe/i.test(joined)) {
      fails.push({ id: "wf-sidebar-panel", detail: "sidebar wireframe missing Panel" });
    } else passes.push({ id: "wf-sidebar-panel", detail: "sidebar Panel present" });
  }

  return { ok: fails.length === 0, fails, passes, fileCount: files.length };
}

export async function runWireframeSourceValidate(dir, { phaseDir = null, write = false } = {}) {
  const paths = await walk(dir);
  const files = [];
  for (const p of paths) {
    const src = await fs.readFile(p, "utf8");
    // Only files that look like wireframe customization
    if (/VeltWireframe|Wireframe|velt-comment|velt-comments/i.test(src)) {
      files.push({ path: p, src });
    }
  }
  const result = validateWireframeSource(files);
  const doc = {
    at: new Date().toISOString(),
    dir,
    ...result,
    detector: "wireframe-source",
    category: "wireframe",
  };
  if (write && phaseDir) {
    await fs.mkdir(phaseDir, { recursive: true });
    await fs.writeFile(path.join(phaseDir, "wireframe-source-validate.json"), JSON.stringify(doc, null, 2) + "\n");
  }
  return doc;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const dir = args.find((a) => !a.startsWith("--") && a !== flag("--phase")) || "components/velt/ui-customization";
  const phaseDir = flag("--phase");
  const write = args.includes("--write");
  runWireframeSourceValidate(dir, { phaseDir, write }).then((doc) => {
    console.log(JSON.stringify({ ok: doc.ok, fails: doc.fails, passes: doc.passes?.length }, null, 2));
    process.exit(doc.ok ? 0 : 2);
  }).catch((e) => { console.error("✗ " + e.message); process.exit(1); });
}

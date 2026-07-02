#!/usr/bin/env node
// visual-diff.mjs — the block CHROME diff for velt-customize. Compares a reference Figma frame PNG
// to a device-res live screenshot PNG and returns: diffPct, changedPixels, and the bounding-box
// REGIONS that differ (so the Builder gets "WHAT + WHERE differs", not just a number).
//
// WHY chrome-only (measured — see BLOCK-BY-BLOCK-REDESIGN-PLAN.md §0b): the frame-width match makes
// borders/icons/avatars/layout align at ~0%, but TEXT has a ~4% POSITIONAL floor (Figma vs Chrome
// glyph placement) that thresholds can't remove. So we MASK every text box (the caller supplies them
// from the designSpec / live DOM) and diff chrome only. Text/colour/size exactness is owned by
// delta-compare (getComputedStyle — font-render-immune), never by pixels.
//
// Zero npm deps: a minimal PNG codec on node's zlib, and pixelmatch's YIQ colour delta inlined.
//
// Usage:
//   node scripts/visual-diff.mjs <refPng> <livePng> [--mask x,y,w,h ...] [--masks-json <file>]
//        [--out diff.png] [--threshold 0.1] [--cell 24]
//   --mask / --masks-json boxes are in DEVICE px (CSS px * scale). The diff canvas is the max of
//   both images, top-left aligned (per-element alignment is the caller's job — pass cropped blocks).

import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import path from "node:path";

// ----------------------------- minimal PNG codec (zlib) -----------------------------
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return ~c >>> 0; }

function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }

// Decode 8-bit non-interlaced PNG (colour type 0/2/4/6) → {width,height,data:RGBA}.
export function decodePNG(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error("not a PNG");
  let off = 8, width = 0, height = 0, colorType = 0, bitDepth = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString("ascii", off + 4, off + 8); const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bitDepth ${bitDepth} (need 8)`);
  if (interlace) throw new Error("interlaced PNG unsupported");
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels, stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1; else if (ft === 4) v += paeth(a, b, c);
      row[i] = v & 0xff;
    }
    prev = row;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, s = x * bpp;
      if (colorType === 6) { out[o] = row[s]; out[o + 1] = row[s + 1]; out[o + 2] = row[s + 2]; out[o + 3] = row[s + 3]; }
      else if (colorType === 2) { out[o] = row[s]; out[o + 1] = row[s + 1]; out[o + 2] = row[s + 2]; out[o + 3] = 255; }
      else if (colorType === 0) { out[o] = out[o + 1] = out[o + 2] = row[s]; out[o + 3] = 255; }
      else { out[o] = out[o + 1] = out[o + 2] = row[s]; out[o + 3] = row[s + 1]; } // grayscale+alpha
    }
  }
  return { width, height, data: out };
}

export function encodePNG(width, height, rgba) {
  const stride = width * 4, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const c = Buffer.alloc(12 + data.length);
    c.writeUInt32BE(data.length, 0); c.write(type, 4, "ascii"); data.copy(c, 8);
    c.writeUInt32BE(crc32(c.subarray(4, 8 + data.length)), 8 + data.length); return c;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ----------------------------- diff (pixelmatch YIQ delta, inlined) -----------------------------
const rgb2y = (r, g, b) => r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
const rgb2i = (r, g, b) => r * 0.59597799 - g * 0.27417610 - b * 0.32180189;
const rgb2q = (r, g, b) => r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
function blend(d, i) { const a = d[i + 3] / 255; return [255 + (d[i] - 255) * a, 255 + (d[i + 1] - 255) * a, 255 + (d[i + 2] - 255) * a]; }
function colorDelta(a, b, i) {
  const [r1, g1, b1] = blend(a, i), [r2, g2, b2] = blend(b, i);
  const y = rgb2y(r1, g1, b1) - rgb2y(r2, g2, b2), q = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2), v = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2);
  return 0.5053 * y * y + 0.299 * q * q + 0.1957 * v * v;
}

function pad(img, w, h) {
  if (img.width === w && img.height === h) return img.data;
  const out = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < img.height; y++) img.data.copy(out, y * w * 4, y * img.width * 4, (y * img.width + img.width) * 4);
  return out;
}
function maskBoxes(buf, w, h, boxes) {
  for (const [x, y, rw, rh] of boxes)
    for (let yy = Math.max(0, y); yy < Math.min(h, y + rh); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(w, x + rw); xx++) { const i = (yy * w + xx) * 4; buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 255; }
}
function clusterRegions(mask, w, h, cell) {
  const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell), hot = new Uint8Array(cols * rows), cnt = new Int32Array(cols * rows);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { const k = Math.floor(y / cell) * cols + Math.floor(x / cell); hot[k] = 1; cnt[k]++; }
  const seen = new Uint8Array(cols * rows), boxes = [], idx = (c, r) => r * cols + c;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (!hot[idx(c, r)] || seen[idx(c, r)]) continue;
    let minc = c, maxc = c, minr = r, maxr = r, changed = 0; const st = [[c, r]]; seen[idx(c, r)] = 1;
    while (st.length) { const [cc, rr] = st.pop(); changed += cnt[idx(cc, rr)]; minc = Math.min(minc, cc); maxc = Math.max(maxc, cc); minr = Math.min(minr, rr); maxr = Math.max(maxr, rr);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nc = cc + dc, nr = rr + dr; if (nc >= 0 && nc < cols && nr >= 0 && nr < rows && hot[idx(nc, nr)] && !seen[idx(nc, nr)]) { seen[idx(nc, nr)] = 1; st.push([nc, nr]); } } }
    const bw = (maxc - minc + 1) * cell, bh = (maxr - minr + 1) * cell;
    // fill = changed / bbox area. A MISSING/WRONG element is a solid block (high fill); a 1px
    // positional drift of a border is a sprawling thin outline (low fill) — delta-compare owns that.
    boxes.push({ x: minc * cell, y: minr * cell, w: bw, h: bh, changed, fill: +(changed / (bw * bh)).toFixed(3) });
  }
  return boxes.sort((a, b) => b.changed - a.changed);
}

// Crop an image to a device-px box (for scoping the full-sidebar frame to one block's element region).
export function cropImage(img, x, y, w, h) {
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  w = Math.min(img.width - x, Math.round(w)); h = Math.min(img.height - y, Math.round(h));
  const out = Buffer.alloc(w * h * 4);
  for (let yy = 0; yy < h; yy++) img.data.copy(out, yy * w * 4, ((y + yy) * img.width + x) * 4, ((y + yy) * img.width + x + w) * 4);
  return { width: w, height: h, data: out };
}

// Content-mask boxes from a designSpec: every node that is user/data-driven CONTENT — text, and the
// user AVATAR (the circle, not just its initial glyph) — → its box, scaled to device px and dilated by
// `pad`. Text masks cover the Figma-vs-Chrome glyph drift; the avatar mask covers the content/position
// difference of the avatar element (a different user's initial/colour, §0d fix #c). Chrome icons
// (`iconButton`/`Icon`/`Vector`) are NOT content — they are NOT masked, so the diff still verifies them.
// Exact + deterministic — no hand-estimated coordinates. (Plan §0c item 1 + §0d fix #c.)
const IS_AVATAR = (n) => /^(avatar|profile picture)$/i.test((n.name || "").trim());
// `frameId` (the block's figmaNodeId): with a multi-frame/section designSpec (boxSpace:"frame-relative",
// each node tagged with `frameId`), pass the block's frame id so ONLY that block's nodes are used and
// their boxes are already relative to the block's frame PNG. Omit for a single-frame designSpec.
export function textMasksFromSpec(spec, { scale = 2, pad = 3, frameId = null } = {}) {
  const nodes = (spec.nodes || spec).filter((n) => !frameId || n.frameId === frameId);
  return nodes.filter((n) => (n.text || IS_AVATAR(n)) && n.box && n.box.w).map((n) => [
    Math.round(n.box.x * scale - pad), Math.round(n.box.y * scale - pad),
    Math.round(n.box.w * scale + pad * 2), Math.round(n.box.h * scale + pad * 2),
  ]);
}

// Core: returns {canvas, changedPixels, diffPct, regions, diffPNG}. scale = device/css for cssBox reporting.
export function visualDiff(refImg, liveImg, { masks = [], threshold = 0.1, cell = 24, scale = 2, minChanged = 0, minFill = 0 } = {}) {
  const w = Math.max(refImg.width, liveImg.width), h = Math.max(refImg.height, liveImg.height);
  const a = pad(refImg, w, h), b = pad(liveImg, w, h);
  maskBoxes(a, w, h, masks); maskBoxes(b, w, h, masks);
  const maxDelta = 35215 * threshold * threshold;
  const diff = Buffer.alloc(w * h * 4, 0); const mask = new Uint8Array(w * h); let changed = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x); const i = p * 4;
    if (colorDelta(a, b, i) > maxDelta) { diff[i] = 255; diff[i + 1] = 0; diff[i + 2] = 0; diff[i + 3] = 255; mask[p] = 1; changed++; }
    else { const g = (a[i] * 0.1 + 242); diff[i] = diff[i + 1] = diff[i + 2] = g; diff[i + 3] = 255; } // faint ghost of the ref
  }
  const all = clusterRegions(mask, w, h, cell).map((r) => ({ ...r, cssBox: `${Math.round(r.x / scale)},${Math.round(r.y / scale)} ${Math.round(r.w / scale)}x${Math.round(r.h / scale)}` }));
  // significant = solid-ish blocks (real missing/extra/wrong element); thin drift outlines are filtered.
  const regions = all.filter((r) => r.changed >= minChanged && r.fill >= minFill);
  return { canvas: `${w}x${h}`, changedPixels: changed, diffPct: +(100 * changed / (w * h)).toFixed(3), regions, regionsTotal: all.length, _diff: diff, _w: w, _h: h };
}

async function main() {
  const [refP, liveP, ...rest] = process.argv.slice(2);
  if (!refP || !liveP) { console.error("usage: visual-diff.mjs <refPng> <livePng> [--mask x,y,w,h ...] [--masks-json f] [--out diff.png] [--threshold 0.1] [--scale 2]"); process.exit(1); }
  const masks = []; let outP = null, jsonOutP = null, threshold = 0.1, cell = 24, scale = 2, minChanged = 0, minFill = 0, textSpecPath = null, maskPad = 3, cropRef = null, cropLive = null, maskFrame = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--mask") masks.push(rest[++i].split(",").map(Number));
    else if (rest[i] === "--masks-json") masks.push(...JSON.parse(await fs.readFile(rest[++i], "utf8")));
    else if (rest[i] === "--mask-text-from") textSpecPath = rest[++i];
    else if (rest[i] === "--mask-frame") maskFrame = rest[++i];   // block's figmaNodeId — select only this frame's nodes from a multi-frame (section) designSpec
    else if (rest[i] === "--mask-pad") maskPad = +rest[++i];
    else if (rest[i] === "--crop-ref") cropRef = rest[++i].split(",").map(Number);   // x,y,w,h device px — scope the frame to the block's element region
    else if (rest[i] === "--crop-live") cropLive = rest[++i].split(",").map(Number); // x,y,w,h device px — scope the live capture (use when the live element sits at a different y than the frame)
    else if (rest[i] === "--out") outP = rest[++i];
    else if (rest[i] === "--json-out") jsonOutP = rest[++i];   // persist the result JSON — report-block.mjs assembles from THIS file, never from a transcript
    else if (rest[i] === "--threshold") threshold = +rest[++i];
    else if (rest[i] === "--cell") cell = +rest[++i];
    else if (rest[i] === "--scale") scale = +rest[++i];
    else if (rest[i] === "--min-region") minChanged = +rest[++i];
    else if (rest[i] === "--min-fill") minFill = +rest[++i];
  }
  if (textSpecPath) masks.push(...textMasksFromSpec(JSON.parse(await fs.readFile(textSpecPath, "utf8")), { scale, pad: maskPad, frameId: maskFrame }));
  let refImg = decodePNG(await fs.readFile(refP)); let liveImg = decodePNG(await fs.readFile(liveP));
  if (cropRef) { refImg = cropImage(refImg, ...cropRef); for (const m of masks) { m[0] -= cropRef[0]; m[1] -= cropRef[1]; } }  // re-base masks into the cropped frame
  if (cropLive) liveImg = cropImage(liveImg, ...cropLive);
  const r = visualDiff(refImg, liveImg, { masks, threshold, cell, scale, minChanged, minFill });
  if (outP) await fs.writeFile(outP, encodePNG(r._w, r._h, r._diff));
  const { _diff, _w, _h, ...pub } = r;
  const result = { ref: path.basename(refP), live: path.basename(liveP), masks: masks.length, ...pub, diffMask: outP || null, generatedAt: new Date().toISOString() };
  if (jsonOutP) await fs.writeFile(jsonOutP, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

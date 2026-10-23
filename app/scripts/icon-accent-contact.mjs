//! FILENAME: app/scripts/icon-accent-contact.mjs
// PURPOSE: The standing check behind the icon rule "the ACCENT (or DANGER) element keeps at least
//          1.2 units of background between itself and every SOFT or STRONG shape". jsdom has no
//          geometry, so this rule cannot live in ribbonIcons.test.tsx; it is measured here in real
//          Chromium, from the SOURCE drawings, against a shrink-only allowlist.
// CONTEXT: 2026-09-24 green-vs-grey review. The rule was adopted while 45-odd shipped icons still
//          break it; they are listed in icon-accent-contact.allowlist.json with the contact they
//          have today, and an entry may only go DOWN. A new icon, or a redraw that adds contact,
//          fails `npm run check:icon-contact`.
//
// Usage (from app/):
//   node scripts/icon-accent-contact.mjs              report, then check against the allowlist
//   node scripts/icon-accent-contact.mjs --write      rewrite the allowlist (refuses any growth)
//   node scripts/icon-accent-contact.mjs --bodies f.json   measure [{name, body}] instead of the TSX
//
// Importing this file measures nothing: the browser only starts when node was asked to RUN it.
// `planAllowlist` -- the comparison, and what --write stores -- is exported so
// src/api/__tests__/iconAccentContactAllowlist.test.ts can pin it without a browser.
//
// Method: each icon that paints ACCENT or DANGER is drawn at 240px (10 px per grid unit) twice, as
// an SVG image on a canvas (an icon with neither is recorded as contact 0, undrawn):
//   pass A: ACCENT + DANGER black, SOFT + STRONG white   -> the accent pixels that stay VISIBLE
//   pass G: SOFT + STRONG black, ACCENT + DANGER white   -> the ground pixels that stay visible
// "Contact" = accent boundary pixels with a ground pixel closer than 1.2 units (12 px), divided
// by 10, i.e. the length of accent outline (in grid units) that sits on or beside grey.
//
// The Visuals family (VISUALS_FAMILY_GAPS below; ICONS.md 2.5, 2026-10-22) is measured at its own,
// stricter gap -- 2.4 units, and 1.6 for the 30px All Visuals hero -- and is never allowlisted: a
// family key whose contact exceeds the edge-pixel TOLERANCE (1.0 unit of outline) fails the check,
// in the report and in --write alike; a smaller nonzero contact passes and is printed only under
// --report.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const APP = process.env.CALCULA_APP ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(APP, "package.json"));
const ALLOWLIST = process.env.ICON_CONTACT_ALLOWLIST ?? path.join(APP, "scripts", "icon-accent-contact.allowlist.json");
const GAP_UNITS = 1.2;
const TOLERANCE = 1.0; // units of outline: edge-pixel noise between Chromium builds (software raster is repeatable run to run)

/**
 * The Visuals family (docs/design/ICONS.md 2.5, 2026-10-22) keeps a STRICTER clearance than the
 * rest of the set: its ACCENT keeps THE gap, 2.4 units (two device pixels at 20px), from every SOFT or
 * STRONG shape, and the 30px All Visuals hero its own 2 px, 1.6 units. A family key is measured at its
 * gap and is never allowlisted: contact above the edge-pixel TOLERANCE fails the check outright.
 * ribbonIcons.test.tsx pins this list to its "Visuals gallery" menu family plus Grouped.
 */
export const VISUALS_FAMILY_GAPS = Object.freeze({
  ...Object.fromEntries(
    [
      "ChartBarStacked", "Stacked", "ChartBar", "ChartColumn", "ChartBarStacked100", "Stacked100",
      "ChartLine", "ChartArea", "ChartAreaStacked", "ChartAreaStacked100", "ChartComboStacked", "ChartCombo",
      "ChartWaterfall", "ChartFunnel", "ChartScatter", "ChartPie", "ChartDonut", "ChartTreemap", "ChartGauge",
      "ChartCard", "ChartMultiRowCard", "ChartKpi", "Matrix", "Table", "Slicer", "Timeline",
      "ChartRadar", "ChartBubble", "ChartHistogram", "ChartStock", "ChartBoxPlot", "ChartSunburst", "ChartPareto",
      "Grouped",
    ].map((key) => [key, 2.4]),
  ),
  AllVisuals: 1.6,
});
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

async function bodiesFromSource() {
  const esbuild = require("esbuild");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "icon-contact-"));
  const out = path.join(tmp, "icons.cjs");
  await esbuild.build({
    stdin: {
      contents: `import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RibbonIcon } from ${JSON.stringify(path.join(APP, "src/api/ribbonIcons").replace(/\\/g, "/"))};
globalThis.__iconBodies = Object.entries(RibbonIcon).map(([name, C]) => ({ name,
  body: renderToStaticMarkup(React.createElement(C, { size: 24 })).replace(/^<svg[^>]*>/, "").replace(/<\\/svg>$/, "").replace(/<title>.*?<\\/title>/, "") }));`,
      resolveDir: APP, loader: "tsx",
    },
    bundle: true, platform: "node", format: "cjs", outfile: out, define: { "process.env.NODE_ENV": "\"production\"" }, jsx: "automatic", logLevel: "error",
    nodePaths: [path.join(APP, "node_modules")],
  });
  createRequire(out)(out);
  fs.rmSync(tmp, { recursive: true, force: true });
  return globalThis.__iconBodies;
}

/**
 * Compare one measurement with the allowlist, and say what `--write` stores.
 *
 * `allow` is the file's `icons` map ({ name: units }); `result` is the measurement
 * ([{ name, contact }], contact 0 = none). Returns:
 *   measured  every icon in contact now, { name: units }
 *   added     "name units" for an icon in contact that the list does not name
 *   over      "name was -> now" for an entry that grew by more than `tolerance`
 *   shrink    "name was -> now" for an entry that went down by more than 1
 *   next      the `icons` map --write stores, sorted by name
 */
export function planAllowlist(allow, result, { tolerance = TOLERANCE, acceptGrowth = false } = {}) {
  const measured = Object.fromEntries(result.filter((r) => r.contact > 0).map((r) => [r.name, r.contact]));
  const over = [], shrink = [], added = [];
  for (const r of result) {
    const was = allow[r.name];
    if (r.contact > 0 && was === undefined) added.push(`${r.name} ${r.contact}`);
    else if (was !== undefined && r.contact > was + tolerance) over.push(`${r.name} ${was} -> ${r.contact}`);
    else if (was !== undefined && r.contact < was - 1) shrink.push(`${r.name} ${was} -> ${r.contact}`);
  }
  // What --write stores. An entry already on the list keeps min(pin, measured): a measurement up to
  // `tolerance` above its pin passes the check as edge-pixel noise, and storing it would RAISE the
  // pin -- each write spending the noise margin, the next write raising it again, a shrink-only
  // list ratcheting up one tolerance at a time (on 2026-10-04 one write would have raised
  // Gridlines, Loop, Pivot, Undo and Redo by 0.2-0.8). Only growth the user explicitly accepted
  // (--accept-growth: an `over` or `added` icon) is stored as measured. An icon no longer in
  // contact leaves the list.
  const grew = new Set([...over, ...added].map((line) => line.split(" ")[0]));
  const next = {};
  for (const [name, contact] of Object.entries(measured).sort((a, b) => a[0].localeCompare(b[0]))) {
    const was = allow[name];
    next[name] = was === undefined || (acceptGrowth && grew.has(name)) ? contact : Math.min(was, contact);
  }
  return { measured, over, shrink, added, next };
}

async function main() {
  const icons = opt("--bodies") ? JSON.parse(fs.readFileSync(opt("--bodies"), "utf8")) : await bodiesFromSource();

  const { chromium } = require("playwright");
  const browser = await chromium.launch({ args: ["--disable-gpu", "--force-color-profile=srgb"] });
  const page = await browser.newPage();
  const measured = await page.evaluate(async ({ icons, GAP_UNITS, FAMILY }) => {
    const S = 240, U = S / 24;
    // The disc of pixel offsets closer than a gap, per gap: 1.2 for the set, the family's own for its keys.
    const discs = new Map();
    const offsetsFor = (units) => {
      if (!discs.has(units)) {
        const R = units * U, list = [];
        for (let dy = -Math.ceil(R); dy <= Math.ceil(R); dy++) for (let dx = -Math.ceil(R); dx <= Math.ceil(R); dx++) if (dx * dx + dy * dy < R * R) list.push([dx, dy]);
        discs.set(units, list);
      }
      return discs.get(units);
    };
    const paint = (body, map) => body
      .replaceAll("var(--icon-fill-soft)", map.soft).replaceAll("currentColor", map.strong)
      .replaceAll("var(--icon-accent)", map.accent).replaceAll("var(--icon-danger)", map.danger);
    const raster = async (body) => {
      const img = new Image();
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 24 24" fill="none">${body}</svg>`);
      await img.decode();
      const c = new OffscreenCanvas(S, S), g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, S, S); g.drawImage(img, 0, 0, S, S);
      const d = g.getImageData(0, 0, S, S).data, m = new Uint8Array(S * S);
      for (let i = 0; i < S * S; i++) m[i] = d[i * 4] < 128 ? 1 : 0;
      return m;
    };
    const out = [];
    for (const { name, body } of icons) {
      const gap = FAMILY[name] ?? GAP_UNITS;
      if (!/var\(--icon-(accent|danger)\)/.test(body)) { out.push({ name, gap, contact: 0, accent: false }); continue; }
      const offsets = offsetsFor(gap);
      const A = await raster(paint(body, { soft: "#fff", strong: "#fff", accent: "#000", danger: "#000" }));
      const G = await raster(paint(body, { soft: "#000", strong: "#000", accent: "#fff", danger: "#fff" }));
      let n = 0, minD2 = Infinity;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const i = y * S + x;
        if (!A[i]) continue;
        const edge = x === 0 || y === 0 || x === S - 1 || y === S - 1 || !A[i - 1] || !A[i + 1] || !A[i - S] || !A[i + S];
        if (!edge) continue;
        let hit = false;
        for (const [dx, dy] of offsets) {
          const X = x + dx, Y = y + dy;
          if (X < 0 || Y < 0 || X >= S || Y >= S) continue;
          if (G[Y * S + X]) { hit = true; const d2 = dx * dx + dy * dy; if (d2 < minD2) minD2 = d2; }
        }
        if (hit) n++;
      }
      out.push({ name, gap, accent: true, contact: Math.round(n / U * 10) / 10, minGap: minD2 === Infinity ? null : Math.round(Math.sqrt(minD2) / U * 100) / 100 });
    }
    return out;
  }, { icons, GAP_UNITS, FAMILY: VISUALS_FAMILY_GAPS });
  await browser.close();

  // The Visuals family is held to its own gap and never allowlisted; the rest goes through the list.
  const family = measured.filter((r) => Object.hasOwn(VISUALS_FAMILY_GAPS, r.name));
  const familyFailures = family.filter((r) => r.contact > TOLERANCE);
  const result = measured.filter((r) => !Object.hasOwn(VISUALS_FAMILY_GAPS, r.name));
  const allow = fs.existsSync(ALLOWLIST) ? JSON.parse(fs.readFileSync(ALLOWLIST, "utf8")).icons ?? {} : {};
  const { measured: inContact, over, shrink, added, next } = planAllowlist(allow, result, { acceptGrowth: flag("--accept-growth") });
  console.log(`[icon-contact] ${measured.length} icons, ${measured.filter((r) => r.accent).length} with ACCENT/DANGER; outside the Visuals family ${Object.keys(inContact).length} in contact with SOFT/STRONG (total ${Object.values(inContact).reduce((a, b) => a + b, 0).toFixed(1)} units of outline)`);
  console.log(`[icon-contact] Visuals family: ${family.length} icons held to THE gap (2.4; the hero 1.6), ${familyFailures.length} within it`);
  if (flag("--report")) {
    for (const [n, v] of Object.entries(inContact).sort((a, b) => b[1] - a[1])) console.log(`  ${n.padEnd(16)} ${v}`);
    for (const r of family.filter((f) => f.contact > 0)) console.log(`  ${r.name.padEnd(16)} ${r.contact} (family, at ${r.gap})`);
  }
  if (familyFailures.length) {
    console.log("[FAIL] the Visuals family's green (or red) comes within THE gap of grey or ink:");
    for (const r of familyFailures) console.log(`  ${r.name} ${r.contact} units of outline within ${r.gap} (closest ${r.minGap})`);
    console.log("  Keep the family's 2.4 (the 30px hero's 1.6) of background round the accent (docs/design/ICONS.md 2.5). Family keys are never allowlisted.");
    process.exit(1);
  }
  if (flag("--write")) {
    if ((over.length || added.length) && !flag("--accept-growth")) {
      console.log("[FAIL] refusing to write: the allowlist may only shrink.\n  grew: " + [...over, ...added].join(", "));
      process.exit(1);
    }
    fs.writeFileSync(ALLOWLIST, JSON.stringify({
      rule: "ACCENT/DANGER keeps >= 1.2 units of background from SOFT/STRONG. Units = length of accent outline within 1.2 of grey. Entries may only shrink; see docs/design/ICONS.md.",
      icons: next,
    }, null, 1) + "\n");
    console.log(`[OK] wrote ${ALLOWLIST} (${Object.keys(next).length} entries)`);
    process.exit(0);
  }
  if (shrink.length) console.log("[info] improved, lower the allowlist with --write: " + shrink.join(", "));
  if (over.length || added.length) {
    console.log("[FAIL] green (or red) now touches grey where it did not:");
    for (const x of [...added.map((a) => "new  " + a), ...over.map((o) => "grew " + o)]) console.log("  " + x);
    console.log("  Keep 1.2 units of background between ACCENT/DANGER and SOFT/STRONG (docs/design/ICONS.md 2.2).");
    process.exit(1);
  }
  console.log("[OK] no icon gained contact between its accent and the greys");
}

// Only when node RUNS this file (npm run check:icon-contact): an import -- the test -- measures
// nothing and launches no browser.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

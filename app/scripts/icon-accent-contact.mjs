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
// Method: each icon is drawn at 240px (10 px per grid unit) twice, as an SVG image on a canvas:
//   pass A: ACCENT + DANGER black, SOFT + STRONG white   -> the accent pixels that stay VISIBLE
//   pass G: SOFT + STRONG black, ACCENT + DANGER white   -> the ground pixels that stay visible
// "Contact" = accent boundary pixels with a ground pixel closer than 1.2 units (12 px), divided
// by 10, i.e. the length of accent outline (in grid units) that sits on or beside grey.
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

const icons = opt("--bodies") ? JSON.parse(fs.readFileSync(opt("--bodies"), "utf8")) : await bodiesFromSource();

const { chromium } = require("playwright");
const browser = await chromium.launch({ args: ["--disable-gpu", "--force-color-profile=srgb"] });
const page = await browser.newPage();
const result = await page.evaluate(async ({ icons, GAP_UNITS }) => {
  const S = 240, U = S / 24, R = GAP_UNITS * U;
  const offsets = [];
  for (let dy = -Math.ceil(R); dy <= Math.ceil(R); dy++) for (let dx = -Math.ceil(R); dx <= Math.ceil(R); dx++) if (dx * dx + dy * dy < R * R) offsets.push([dx, dy]);
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
    if (!/var\(--icon-(accent|danger)\)/.test(body)) { out.push({ name, contact: 0, accent: false }); continue; }
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
    out.push({ name, accent: true, contact: Math.round(n / U * 10) / 10, minGap: minD2 === Infinity ? null : Math.round(Math.sqrt(minD2) / U * 100) / 100 });
  }
  return out;
}, { icons, GAP_UNITS });
await browser.close();

const measured = Object.fromEntries(result.filter((r) => r.contact > 0).map((r) => [r.name, r.contact]));
const allow = fs.existsSync(ALLOWLIST) ? JSON.parse(fs.readFileSync(ALLOWLIST, "utf8")).icons ?? {} : {};
const over = [], shrink = [], added = [];
for (const r of result) {
  const was = allow[r.name];
  if (r.contact > 0 && was === undefined) added.push(`${r.name} ${r.contact}`);
  else if (was !== undefined && r.contact > was + TOLERANCE) over.push(`${r.name} ${was} -> ${r.contact}`);
  else if (was !== undefined && r.contact < was - 1) shrink.push(`${r.name} ${was} -> ${r.contact}`);
}
console.log(`[icon-contact] ${result.length} icons, ${result.filter((r) => r.accent).length} with ACCENT/DANGER, ${Object.keys(measured).length} in contact with SOFT/STRONG (total ${Object.values(measured).reduce((a, b) => a + b, 0).toFixed(1)} units of outline)`);
if (flag("--report")) for (const [n, v] of Object.entries(measured).sort((a, b) => b[1] - a[1])) console.log(`  ${n.padEnd(16)} ${v}`);
if (flag("--write")) {
  if ((over.length || added.length) && !flag("--accept-growth")) {
    console.log("[FAIL] refusing to write: the allowlist may only shrink.\n  grew: " + [...over, ...added].join(", "));
    process.exit(1);
  }
  fs.writeFileSync(ALLOWLIST, JSON.stringify({
    rule: "ACCENT/DANGER keeps >= 1.2 units of background from SOFT/STRONG. Units = length of accent outline within 1.2 of grey. Entries may only shrink; see docs/design/ICONS.md.",
    icons: Object.fromEntries(Object.entries(measured).sort((a, b) => a[0].localeCompare(b[0]))),
  }, null, 1) + "\n");
  console.log(`[OK] wrote ${ALLOWLIST} (${Object.keys(measured).length} entries)`);
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

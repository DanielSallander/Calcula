// Renders icon drafts next to the reference, in Light and Dark, at the real sizes.
import { createRequire } from "node:module";
const { chromium } = createRequire("C:/Dropbox/Projekt/Calcula/app/package.json")("playwright");
import fs from "node:fs";
import path from "node:path";

const [, , draftsFile, outPng, refPng] = process.argv;
const drafts = JSON.parse(fs.readFileSync(draftsFile, "utf8")); // [{name, body, light?, dark?}] -- light/dark = extra CSS vars for that row, e.g. "--icon-accent:#065f46"
const refData = refPng ? `data:image/${refPng.toLowerCase().endsWith(".svg") ? "svg+xml" : "png"};base64,${fs.readFileSync(refPng).toString("base64")}` : null;
const SIZES = [20, 24, 30, 120];
const svg = (body, s) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" style="display:block">${body}</svg>`;
const skin = (name, vars, key) => `
  <section class="skin" style="${vars}">
    <h2>${name}</h2>
    ${drafts.map((d) => `<div class="row" style="${d[key] || ""}"><span class="label">${d.name}</span>${SIZES.map((s) => `<div class="cell">${svg(d.body, s)}<small>${s}px</small></div>`).join("")}
      <div class="btn">${svg(d.body, 20)}<span>${process.env.LABEL || "Format Painter"}</span></div></div>`).join("")}
  </section>`;
const LIGHT = `--icon-fill-soft: color-mix(in srgb, currentColor ${process.env.SOFT_L || 50}%, transparent); --icon-accent: ${process.env.ACCENT_L || "#047857"}; --icon-danger: #c42b1c; color:#111827; background:#f3f4f6;`;
const DARK = `--icon-fill-soft: color-mix(in srgb, currentColor ${process.env.SOFT_D || 45}%, transparent); --icon-accent: ${process.env.ACCENT_D || "#34d399"}; --icon-danger: #f87171; color:#e0e0e0; background:#2b2b2e;`;
const html = `<!doctype html><html><head><style>
  body{margin:0;font-family:"Segoe UI",sans-serif;background:#fff;display:flex;gap:16px;padding:16px;align-items:flex-start}
  .skin{padding:12px 16px;border-radius:12px} h2{font-size:13px;margin:0 0 8px}
  .row{display:flex;align-items:flex-end;gap:18px;margin:10px 0} .label{width:70px;font-size:12px}
  .cell{display:flex;flex-direction:column;align-items:center;gap:4px} small{font-size:10px;opacity:.6}
  .btn{display:flex;align-items:center;gap:6px;height:28px;padding:0 8px;border-radius:8px;font-size:12px}
  .ref{display:flex;flex-direction:column;gap:8px;align-items:center;font-size:12px}
</style></head><body>
  ${refData ? `<div class="ref"><b>Reference</b><img src="${refData}" width="160" height="160"><img src="${refData}" width="30" height="30"><img src="${refData}" width="20" height="20"></div>` : ""}
  ${skin("Light (cluster)", LIGHT, "light")}${skin("Dark (cluster)", DARK, "dark")}
</body></html>`;
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 1500, height: 400 } });
await page.setContent(html);
const h = await page.evaluate(() => document.body.scrollHeight);
await page.setViewportSize({ width: 1500, height: h + 20 });
await page.screenshot({ path: outPng, fullPage: true });
// A 2x copy for close inspection of the small sizes.
const page2 = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1500, height: h + 20 } });
await page2.setContent(html);
await page2.screenshot({ path: outPng.replace(/\.png$/, "@2x.png"), fullPage: true });
await browser.close();
console.log("wrote", outPng);

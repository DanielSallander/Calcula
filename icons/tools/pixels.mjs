// Renders each draft at 20px (dpr 1 and 1.5) on the Light and Dark cluster, then shows the
// captured pixels magnified 10x with nearest-neighbour scaling.
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire("C:/Dropbox/Projekt/Calcula/app/package.json")("playwright");
const [, , draftsFile, outPng] = process.argv;
const drafts = JSON.parse(fs.readFileSync(draftsFile, "utf8")); // [{name, body, light?, dark?}] -- light/dark = extra CSS vars, e.g. "--icon-accent:#065f46"
const SKINS = {
  Light: `--icon-fill-soft: color-mix(in srgb, currentColor ${process.env.SOFT_L || 50}%, transparent); --icon-accent: ${process.env.ACCENT_L || "#047857"}; color:#111827; background:#f3f4f6;`,
  Dark: `--icon-fill-soft: color-mix(in srgb, currentColor ${process.env.SOFT_D || 45}%, transparent); --icon-accent: ${process.env.ACCENT_D || "#34d399"}; color:#e0e0e0; background:#2b2b2e;`,
};
const browser = await chromium.launch();
const shots = [];
for (const dpr of [1, 1.5]) {
  const page = await browser.newPage({ deviceScaleFactor: dpr, viewport: { width: 400, height: 200 } });
  for (const [skin, vars] of Object.entries(SKINS)) {
    for (const d of drafts) {
      await page.setContent(`<body style="margin:0"><div id="c" style="${vars}${d[skin.toLowerCase()] ? d[skin.toLowerCase()] + ";" : ""}width:24px;height:24px;display:flex;align-items:center;justify-content:center"><svg width="20" height="20" viewBox="0 0 24 24" fill="none">${d.body}</svg></div></body>`);
      const buf = await page.locator("#c").screenshot();
      shots.push({ dpr, skin, name: d.name, data: buf.toString("base64") });
    }
  }
  await page.close();
}
const rows = [...new Set(shots.map((s) => `${s.skin} @${s.dpr}x`))];
const html = `<body style="margin:0;padding:12px;font:12px 'Segoe UI';background:#fff">
<div style="display:grid;grid-template-columns:110px repeat(${drafts.length},250px);gap:10px;align-items:center">
<div></div>${drafts.map((d) => `<b>${d.name}</b>`).join("")}
${rows.map((r) => `<div>${r}</div>${drafts.map((d) => { const s = shots.find((x) => `${x.skin} @${x.dpr}x` === r && x.name === d.name); return `<img src="data:image/png;base64,${s.data}" style="image-rendering:pixelated;width:240px;height:240px">`; }).join("")}`).join("")}
</div></body>`;
const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 110 + drafts.length * 260 + 40, height: 400 } });
await page.setContent(html);
await page.screenshot({ path: outPng, fullPage: true });
await browser.close();
console.log("wrote", outPng);

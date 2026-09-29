//! FILENAME: app/extensions/CanvasSheet/__tests__/objectClipboardWiring.test.ts
// PURPOSE: The object clipboard (W25) only works if every door is WIRED in
//          the extensions' activate(): the canvas's Ctrl+C / Ctrl+V / Ctrl+D,
//          Charts' and Controls' provider halves (without them a chart or a
//          shape is "not copied" and named in a toast), the chart menu's rows
//          and the canvas right-click's selection. The behaviour of each piece
//          is proved in its own test; these source checks pin that activate()
//          uses it (the chartsCanvasWiring precedent).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ext = (rel: string): string => readFileSync(resolve(__dirname, "../..", rel), "utf8").split("\r\n").join("\n");

describe("the object clipboard's doors are wired", () => {
  it("the canvas installs its Ctrl+C / Ctrl+V / Ctrl+D door", () => {
    expect(ext("CanvasSheet/index.ts")).toContain("cleanupFns.push(...installCanvasObjectClipboard(extension.manifest.id));");
  });

  it("Charts gives its provider THE chart copy (snapshot + paste)", () => {
    const src = ext("Charts/index.ts");
    expect(src).toContain("        copyChart: snapshotChart,\n        pasteCharts: pasteChartSnapshots,\n");
  });

  it("a right-click on a chart selects through the seam BEFORE Charts' own select, and the menu shows the rows", () => {
    expect(ext("Charts/index.ts")).toMatch(
      /selectChartForCanvasMenu\(targetId\);\n\s*if \(!isChartSelected\(targetId\)\) selectChart\(targetId\);/,
    );
    expect(ext("Charts/components/ChartContextMenu.tsx")).toContain("rows.push(...chartObjectClipboardRows());");
  });

  it("Controls gives its provider its clipboard halves", () => {
    const src = ext("Controls/index.ts");
    expect(src).toContain("      copyControls: snapshotControls,\n      pasteControls: pasteControlSnapshots,\n");
  });

  // Wave C review of W25 (layoutRefsAnchors.test.ts, controlPinnedCopy.test.ts
  // prove the behaviour): without these two installs a pasted copy of a
  // deleted, locked shape comes back LOCKED, and a pinned copy is written
  // unpinned.
  const code = (rel: string): string =>
    ext(rel)
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");

  it("the canvas tells the families which ids its layout still names", () => {
    expect(code("CanvasSheet/index.ts"), "the canvas's layout-ref source is not installed").toContain(
      "cleanupFns.push(installCanvasLayoutRefs());",
    );
  });

  it("Controls measures a pinned copy with the reposition pass's own cell-origin walk", () => {
    const src = code("Controls/index.ts");
    expect(src, "a pinned copy has no cell-origin walk to measure its offsets with").toContain(
      "setControlCopyCellOrigin(cellOriginPixels);",
    );
    expect(src).toContain("cleanupFns.push(() => setControlCopyCellOrigin(null));");
  });
});

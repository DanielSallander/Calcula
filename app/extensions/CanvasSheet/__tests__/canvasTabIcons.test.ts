//! FILENAME: app/extensions/CanvasSheet/__tests__/canvasTabIcons.test.ts
// PURPOSE: A source scan of the Canvas tab's components (the icons-integrate
//          lane asked for it: its MENU_FAMILIES test cannot see which key a
//          control uses). Since 2026-10-08 the tab draws the pictures the icon
//          lanes made for it, and none of the five it BORROWED survives:
//            - Shape drew Layout (an arrangement), Button drew Controls (form
//              controls), Fit to Window and Size & Position both drew Resize,
//              Actual Size drew Search (Find's picture), Snap to Grid drew the
//              chart's Gridlines, Design Mode drew Pencil (Edit Chart's), and
//              the Insert group drew a bare Plus.
//          The rendered tests prove each control draws its key; this one
//          proves no component even NAMES a borrowed one, so a new control
//          cannot quietly bring one back.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve(__dirname, "../components");
const sources = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => ({ file: f, text: fs.readFileSync(path.join(DIR, f), "utf8") }));
const all = sources.map((s) => s.text).join("\n");

describe("the Canvas tab's pictures", () => {
  it("scans the tab's component files (a moved folder would make this vacuous)", () => {
    expect(sources.map((s) => s.file)).toEqual(
      expect.arrayContaining([
        "CanvasTabSections.tsx",
        "CanvasPagesSection.tsx",
        "CanvasVisualsSection.tsx",
        "CanvasElementsSection.tsx",
        "CanvasArrangeSection.tsx",
        "CanvasPageSection.tsx",
        "CanvasViewSection.tsx",
      ]),
    );
  });

  it.each(["Layout", "Controls", "Resize", "Search", "Gridlines", "Pencil", "Plus"])(
    "no component draws the borrowed RibbonIcon.%s",
    (key) => {
      for (const s of sources) {
        expect(s.text, s.file).not.toMatch(new RegExp(`RibbonIcon\\.${key}\\b`));
      }
    },
  );

  it.each([
    "NewPage", "AllVisuals", "Shapes", "ButtonControl", "FloatingGrid", "SizePosition", "FitToPage",
    "FitToWidth", "ActualSize", "SnapToGrid", "ShowGrid", "LockObjects", "DesignMode", "Wallpaper",
    "PageNavigator", "NavigateBack", "ClearSlicers", "Report", "EditInteractions",
  ])("the tab draws the new RibbonIcon.%s", (key) => {
    expect(all).toMatch(new RegExp(`RibbonIcon\\.${key}\\b`));
  });
});

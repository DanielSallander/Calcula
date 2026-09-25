//! FILENAME: app/src/core/components/Spreadsheet/__tests__/activeSheetViewHydration.test.ts
// PURPOSE: A sheet's gridlines, headings, zoom and split/freeze follow the
//          ACTIVE sheet whichever route moved it -- not only a tab click.
// CONTEXT: The hydration used to live in the `sheet:normalSwitch` listener,
//          which only the tab strip fires. Leaving a CANVAS (which is created
//          with headings and gridlines off) by a script's api.setActiveSheet, a
//          bookmark, an internal hyperlink or a backend-driven switch left the
//          worksheet headingless and gridless, at the canvas's zoom.
//          SOURCE-TEXT assertions: mounting Spreadsheet needs the whole Core
//          provider tree; the rule under test is WHERE the calls live.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "../Spreadsheet.tsx"), "utf8");
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("per-sheet view state hydrates on ANY active-sheet change", () => {
  it("an effect keyed on the active sheet's index AND name runs all three hydrations", () => {
    const at = CODE.indexOf("const viewHydratedOnceRef");
    expect(at, "the active-sheet hydration effect is gone").toBeGreaterThan(-1);
    const effect = CODE.slice(at, CODE.indexOf("}, [", at) + 200);
    expect(effect).toContain('invoke<boolean>("get_show_gridlines")');
    expect(effect).toContain("hydrateSheetView()");
    expect(effect).toContain("hydrateSheetDisplayFlags()");
    expect(effect).toMatch(/\[activeSheetIndexForView, activeSheetNameForView,/);
  });

  it("the tab-strip switch listener no longer carries its own copy", () => {
    const at = CODE.indexOf("const handleSheetSwitch = (event: Event)");
    const body = CODE.slice(at, CODE.indexOf("const handleSheetReorder", at));
    expect(body).not.toContain("hydrateSheetView()");
    expect(body).not.toContain("hydrateSheetDisplayFlags()");
    expect(body).not.toContain("get_show_gridlines");
  });
});

describe("a canvas's scroll stays on its page", () => {
  it("an effect pulls the scroll back inside the page extent", () => {
    const at = CODE.indexOf("const hasCanvasPage");
    expect(at).toBeGreaterThan(-1);
    const effect = CODE.slice(at, at + 700);
    expect(effect).toMatch(/Math\.min\(canvasScrollX, canvasMaxScrollX\)/);
    expect(effect).toMatch(/Math\.min\(canvasScrollY, canvasMaxScrollY\)/);
    expect(effect).toContain("dispatch(scrollToPosition(x, y))");
  });
});

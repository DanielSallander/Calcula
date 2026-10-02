//! FILENAME: app/src/core/components/Spreadsheet/__tests__/gridHoverClear.test.ts
// PURPOSE: The GRID's side of Core's floating-object hover (BUG-0258 design
//          phase 5; core/lib/objectHover.ts, core/lib/floatingGrip.ts):
//            - the grid area binds `onMouseLeave` to the hook's
//              `handleMouseLeave` (through useSpreadsheetSelection and
//              useSpreadsheet), so leaving the grid clears the hover and a grip
//              shown only on hover disappears;
//            - a scroll and a sheet switch clear it (effects keyed on them);
//            - the upkeep (`installObjectHoverUpkeep`, installed by an effect):
//              a hover change repaints only when a hover-grip region is
//              involved, a gesture change repaints, and a published list that
//              no longer holds the hovered object clears the hover;
//            - a right-click on a VISIBLE grip that no family claimed is the
//              grip's menu (`floatingObject:gripClick`, button 2, anchored in
//              client px) -- never the cell menu -- and anywhere else nothing.
// CONTEXT: Mounting Spreadsheet needs the whole Core provider tree, so WHERE the
//          calls live is read from the source (the activeSheetViewHydration
//          precedent), and WHAT they do is driven for real.

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FLOATING_GRIP_CLICK_EVENT,
  dispatchGripContextMenu,
  floatingGripOf,
  installObjectHoverUpkeep,
  type FloatingGripClickDetail,
} from "../../../lib/floatingGrip";
import {
  getHoveredFloatingRegionId,
  resetObjectHoverForTests,
  setFloatingGestureActive,
  setHoveredFloatingRegion,
} from "../../../lib/objectHover";
import { onRegionChange, setGridRegions, type GridRegion } from "../../../../api/gridOverlays";

const HERE = dirname(fileURLToPath(import.meta.url));
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const SPREADSHEET = strip(readFileSync(resolve(HERE, "../Spreadsheet.tsx"), "utf8"));
const WRAPPER = strip(readFileSync(resolve(HERE, "../useSpreadsheetSelection.ts"), "utf8"));
const FACADE = strip(readFileSync(resolve(HERE, "../useSpreadsheet.ts"), "utf8"));

function region(id: string, data: Record<string, unknown> = {}): GridRegion {
  return { id, type: "hover-clear-test", startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x: 100, y: 100, width: 200, height: 100 }, data };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetObjectHoverForTests();
  setGridRegions([]);
  vi.restoreAllMocks();
});

describe("WHERE: the grid area and its effects (Spreadsheet.tsx)", () => {
  it("the grid area binds onMouseLeave to the hook's handleMouseLeave", () => {
    const at = SPREADSHEET.indexOf("<S.GridArea");
    expect(at, "no grid area").toBeGreaterThan(-1);
    const tag = SPREADSHEET.slice(at, SPREADSHEET.indexOf(">", SPREADSHEET.indexOf("onContextMenu", at)));
    expect(tag, "the grid area binds no mouseleave: a hover grip stays after the pointer leaves the grid").toMatch(
      /onMouseLeave=\{handleMouseLeave\}/,
    );
    expect(SPREADSHEET).toMatch(/const \{[^}]*\bhandleMouseLeave,[^}]*\} = handlers;/);
  });

  it("the hook's handleMouseLeave reaches it: useSpreadsheetSelection's mouseHandlers, then useSpreadsheet's handlers", () => {
    expect(WRAPPER).toMatch(/handleMouseLeave,\s*isOverFloatingOverlay,\s*\} = useMouseSelection\(/);
    const handlers = WRAPPER.slice(WRAPPER.indexOf("mouseHandlers: {"));
    expect(handlers.slice(0, 300)).toMatch(/\bhandleMouseLeave,/);
    expect(FACADE).toMatch(/handleMouseLeave: selectionLogic\.mouseHandlers\.handleMouseLeave/);
  });

  it("a scroll and a sheet switch clear the hover (effects keyed on them), and the upkeep is installed", () => {
    expect(SPREADSHEET).toMatch(/useEffect\(\(\) => \{\s*clearFloatingHover\(\);\s*\}, \[canvasScrollX, canvasScrollY\]\);/);
    expect(SPREADSHEET).toMatch(/const activeSheetIndexForHover = gridState\.sheetContext\.activeSheetIndex;/);
    expect(SPREADSHEET).toMatch(/useEffect\(\(\) => \{\s*clearFloatingHover\(\);\s*\}, \[activeSheetIndexForHover\]\);/);
    expect(SPREADSHEET).toMatch(/useEffect\(\(\) => installObjectHoverUpkeep\(\), \[\]\);/);
  });

  it("the grid's contextmenu asks the grip AFTER a family's own menu (defaultPrevented) and BEFORE the cell menu", () => {
    const at = SPREADSHEET.indexOf("const handleContextMenu = useCallback(");
    expect(at, "no grid contextmenu handler").toBeGreaterThan(-1);
    const body = SPREADSHEET.slice(at, SPREADSHEET.indexOf("const resizeTimeoutRef", at));
    const prevented = body.indexOf("event.nativeEvent.defaultPrevented");
    const grip = body.indexOf("dispatchGripContextMenu(");
    const firstMenu = body.indexOf("emitAppEvent(AppEvents.CONTEXT_MENU_REQUEST");
    expect(prevented).toBeGreaterThan(-1);
    expect(grip, "the grid's right-click never asks the grip").toBeGreaterThan(prevented);
    expect(grip, "a cell menu can open before the grip is asked").toBeLessThan(firstMenu);
    expect(body.slice(grip, grip + 400)).toMatch(/\)\s*\{\s*return;\s*\}/);
  });
});

describe("WHAT: the upkeep", () => {
  it("a hover change repaints only when a grip:'hover' region is involved; a gesture change always does", () => {
    setGridRegions([region("s1", { grip: "hover" }), region("c1")]);
    const redraws = vi.fn();
    cleanups.push(installObjectHoverUpkeep(), onRegionChange(redraws));
    setHoveredFloatingRegion("c1");
    expect(redraws, "hovering an object with no hover grip repainted").not.toHaveBeenCalled();
    setHoveredFloatingRegion("s1");
    expect(redraws).toHaveBeenCalledTimes(1);
    setHoveredFloatingRegion(null);
    expect(redraws).toHaveBeenCalledTimes(2);
    setFloatingGestureActive(true);
    setFloatingGestureActive(false);
    expect(redraws).toHaveBeenCalledTimes(4);
  });

  it("a published list without the hovered object clears the hover; one that still holds it does not", () => {
    setGridRegions([region("s1", { grip: "hover" }), region("c1")]);
    cleanups.push(installObjectHoverUpkeep());
    setHoveredFloatingRegion("c1");
    setGridRegions([region("s1", { grip: "hover" }), region("c1")]);
    expect(getHoveredFloatingRegionId()).toBe("c1");
    setGridRegions([region("s1", { grip: "hover" })]);
    expect(getHoveredFloatingRegionId(), "a deleted object stayed hovered").toBeNull();
  });

  it("the uninstall stops all three", () => {
    setGridRegions([region("s1", { grip: "hover" })]);
    const redraws = vi.fn();
    const off = installObjectHoverUpkeep();
    cleanups.push(onRegionChange(redraws));
    off();
    setHoveredFloatingRegion("s1");
    setFloatingGestureActive(true);
    setFloatingGestureActive(false);
    expect(redraws).not.toHaveBeenCalled();
    setGridRegions([]);
    expect(getHoveredFloatingRegionId()).toBe("s1");
  });
});

describe("WHAT: the right-click on a grip", () => {
  const GUTTERS = { rowHeaderWidth: 22, colHeaderHeight: 20 };
  const SCROLL = { scrollX: 0, scrollY: 0 };

  it("on a VISIBLE grip: ONE gripClick with button 2, anchored at the grip in client px; true", () => {
    const s = region("s1", { grip: "hover" });
    setGridRegions([s]);
    setHoveredFloatingRegion("s1");
    const g = floatingGripOf(s, GUTTERS, SCROLL, 1, null)!;
    const got: FloatingGripClickDetail[] = [];
    const on = (e: Event) => got.push((e as CustomEvent<FloatingGripClickDetail>).detail);
    window.addEventListener(FLOATING_GRIP_CLICK_EVENT, on);
    cleanups.push(() => window.removeEventListener(FLOATING_GRIP_CLICK_EVENT, on));
    const c = { x: g.hit.x + 12, y: g.hit.y + 12 };
    expect(dispatchGripContextMenu(c.x, c.y, GUTTERS, SCROLL, 1, { left: 5, top: 70 })).toBe(true);
    expect(got).toEqual([
      {
        regionId: "s1",
        regionType: "hover-clear-test",
        data: { grip: "hover" },
        anchor: { x: 5 + g.hit.x, y: 70 + g.hit.y, width: 24, height: 24 },
        button: 2,
      },
    ]);
  });

  it("where no grip shows (hidden, or off it): nothing dispatched; false -- the cell menu's turn", () => {
    const s = region("s1", { grip: "hover" });
    setGridRegions([s]);
    const g = floatingGripOf(s, GUTTERS, SCROLL, 1, null)!;
    const on = vi.fn();
    window.addEventListener(FLOATING_GRIP_CLICK_EVENT, on);
    cleanups.push(() => window.removeEventListener(FLOATING_GRIP_CLICK_EVENT, on));
    expect(dispatchGripContextMenu(g.hit.x + 12, g.hit.y + 12, GUTTERS, SCROLL, 1, { left: 0, top: 0 }), "hidden grip").toBe(false);
    setHoveredFloatingRegion("s1");
    expect(dispatchGripContextMenu(600, 500, GUTTERS, SCROLL, 1, { left: 0, top: 0 }), "off the grip").toBe(false);
    expect(on).not.toHaveBeenCalled();
  });
});

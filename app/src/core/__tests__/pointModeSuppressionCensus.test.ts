//! FILENAME: app/src/core/__tests__/pointModeSuppressionCensus.test.ts
// PURPOSE: A SOURCE census of every site that must honour cross-sheet point
//          mode and a live external edit session (fr-edit-design.md 1.7/1.9).
// CONTEXT: The behaviour of each helper is unit-tested next to it. What no unit
//          test can see is a CALL SITE going back to the full region list, or a
//          door going back to Core's editing flag alone -- and each of those
//          regressions is silent: an object of the edit's sheet paints over
//          Sheet1 again and swallows the click meant to pick a reference, or the
//          next keystroke after a pick clears a Sheet1 cell. So each site is
//          pinned here, comments stripped (a comment quoting the old call must
//          not satisfy the scan).

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const APP = path.resolve(__dirname, "../../..");

/** Source with comments removed, so prose cannot satisfy or break a scan. */
function code(rel: string): string {
  const src = fs.readFileSync(path.join(APP, rel), "utf8").replace(/\r\n/g, "\n");
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The body of the first function/const that starts with `head`, up to `span` chars. */
function sliceFrom(src: string, head: string, span = 1500): string {
  const at = src.indexOf(head);
  expect(at, `"${head}" not found`).toBeGreaterThanOrEqual(0);
  return src.slice(at, at + span);
}

describe("paint and hit sites read the LIVE regions (1.9)", () => {
  it("the grid PAINTS the live regions (GridCanvas's render call)", () => {
    const src = code("src/core/components/Grid/GridCanvas.tsx");
    expect(src).not.toContain("getGridRegions");
    expect(src).toMatch(/freezeConfig,\s*getLiveGridRegions\(\),\s*getOverlayRenderers\(\),/);
  });

  it("api/gridOverlays: hitTestOverlays and the topFloatingRegionAt default", () => {
    const src = code("src/api/gridOverlays.ts");
    const hit = sliceFrom(src, "export function hitTestOverlays(", 900);
    expect(hit).toContain("getLiveGridRegions()");
    expect(hit).not.toMatch(/\bgridRegions\.filter/);
    expect(src).toMatch(/regions: readonly GridRegion\[\] = getLiveGridRegions\(\),\n\): GridRegion \| null \{/);
  });

  it("Core's floating press and body hover (overlayMoveHandlers)", () => {
    const src = code("src/core/hooks/useMouseSelection/layout/overlayMoveHandlers.ts");
    expect(src).not.toContain("getGridRegions");
    expect(sliceFrom(src, "export function findFloatingRegionAt(", 400)).toContain(
      "floatingHitOrder(getLiveGridRegions())",
    );
    expect(sliceFrom(src, "const checkOverlayBody = (", 400)).toContain(
      "floatingHitOrder(getLiveGridRegions())",
    );
  });

  it("Core's resize-handle press and hover are gated at the CALL site, and the cell-cursor walk is live", () => {
    const src = code("src/core/hooks/useMouseSelection/useMouseSelection.ts");
    expect(src).toMatch(/!isPointModeOnForeignSheet\(\) &&\s*overlayResizeHandlers\.handleOverlayResizeMouseDown\(/);
    expect(src).toMatch(/!isPointModeOnForeignSheet\(\) &&\s*overlayResizeHandlers\.checkOverlayResizeHandle\(/);
    expect(src).not.toContain("getGridRegions");
    expect(src).toContain("for (const region of getLiveGridRegions())");
  });

  it("Charts: the chart lookup and the hover walk", () => {
    const src = code("extensions/Charts/rendering/chartRenderer.ts");
    expect(src).not.toContain("getGridRegions");
    expect(sliceFrom(src, "export function findChartAtCanvasPos(", 300)).toContain(
      "floatingHitOrder(getLiveGridRegions())",
    );
    expect(src).toMatch(/const live = getLiveGridRegions\(\);\s*const stacked = hasStackingOrder\(live\);/);
  });

  it("Controls: the right-click hit walk", () => {
    const src = code("extensions/Controls/lib/controlHitTest.ts");
    expect(src).not.toContain("getGridRegions");
    expect(src).toContain("floatingHitOrder(getLiveGridRegions())");
  });

  it("the shared object wheel", () => {
    const src = code("extensions/_shared/lib/objectWheelScroll.ts");
    expect(src).not.toContain("getGridRegions");
    expect(src).toContain("topFloatingRegionAt(getLiveGridRegions(), canvasX, canvasY, hit.geo)");
  });

  it("DOM-hosted overlays hide on the signal: embedded forms and html shapes", () => {
    const forms = code("extensions/ScriptableObjects/lib/embeddedFormLayer.ts");
    expect(forms).toMatch(/onPointModeViewChanged\(\(foreign\) => \{[\s\S]{0,200}hideHost\(placementId, host\)/);
    const shapes = code("extensions/Controls/Shape/shapeRenderer.ts");
    expect(shapes).toMatch(/onPointModeViewChanged\(\(foreign\) => \{\s*if \(foreign\) releaseUnpaintedShapeOverlays\(new Set\(\)\);/);
  });
});

describe("Core's doors read the external-edit liveness signal (1.7)", () => {
  it("the pointer door keeps the keyboard on the editor during a pick", () => {
    const src = code("src/core/components/Spreadsheet/Spreadsheet.tsx");
    expect(src).toContain("isEditing: editBlocksGridFocus,");
    expect(src).not.toContain("isEditing: getGlobalIsEditing");
    const entry = code("src/core/components/Spreadsheet/gridPointerEntry.ts");
    expect(entry).toMatch(/export function editBlocksGridFocus\(\): boolean \{\s*return getGlobalIsEditing\(\) \|\| isExternalEditLive\(\);/);
  });

  it("the grid keyboard stands down for a live session", () => {
    const src = code("src/core/hooks/useGridKeyboard.ts");
    expect(src).toContain("const isCurrentlyEditing = isEditing || getGlobalIsEditing() || isExternalEditLive();");
  });

  it("the double-click door refuses a second, Core edit beside a live session", () => {
    const src = code("src/core/components/Spreadsheet/useSpreadsheetSelection.ts");
    const body = sliceFrom(src, "const handleDoubleClickEvent = useCallback(", 200);
    expect(body).toMatch(/async \(event: React\.MouseEvent<HTMLDivElement>\) => \{\s*if \(isExternalEditLive\(\)\) return;/);
  });

  it("the cell click interceptor door stands down for a live session (the pick / commit runs instead)", () => {
    const src = code("src/core/components/Spreadsheet/useSpreadsheetSelection.ts");
    const body = sliceFrom(src, "const handleMouseDown = useCallback(", 3500);
    expect(body).toMatch(/if \(clickedCell && !isEditing && !isExternalEditLive\(\)\) \{\s*const intercepted = await checkCellClickInterceptors\(/);
  });

  it("undo and redo through the COMMAND (ribbon, Quick Access Toolbar, menu, CLI) stand down for a live session", () => {
    const src = code("src/core/components/Spreadsheet/useSpreadsheetSelection.ts");
    const undo = sliceFrom(src, "const handleUndo = useCallback(", 200);
    expect(undo).toMatch(/async \(\): Promise<UndoResult \| undefined> => \{\s*if \(isExternalEditLive\(\)\) return undefined;/);
    const redo = sliceFrom(src, "const handleRedo = useCallback(", 200);
    expect(redo).toMatch(/async \(\): Promise<UndoResult \| undefined> => \{\s*if \(isExternalEditLive\(\)\) return undefined;/);
  });

  it("a handled cell press is announced AFTER commit-before-select (onGridCellPressed)", () => {
    const src = code("src/core/hooks/useMouseSelection/selection/cellSelectionHandlers.ts");
    const commit = src.indexOf("await onCommitBeforeSelect();");
    const announce = src.indexOf("notifyGridCellPressed({");
    expect(commit).toBeGreaterThan(0);
    expect(announce).toBeGreaterThan(commit);
    expect(announce).toBeGreaterThan(src.indexOf("onSelectCell(row, col);"));
  });

  it("commit-before-select ends a live session before Core's own branch", () => {
    const src = code("src/core/components/Spreadsheet/useSpreadsheetEditing.ts");
    const body = sliceFrom(src, "const handleCommitBeforeSelect = useCallback(", 300);
    expect(body).toMatch(/if \(isExternalEditLive\(\)\) \{\s*await endExternalFormulaSession\("commit", null\);\s*return;\s*\}/);
    expect(body.indexOf("isExternalEditLive()")).toBeLessThan(body.indexOf("commitEdit()"));
  });

  it("the container's key handler routes a live session's keys before the editor-opening and type-to-edit branches", () => {
    const src = code("src/core/components/Spreadsheet/useSpreadsheetEditing.ts");
    const body = sliceFrom(src, "const handleContainerKeyDown = useCallback(", 6000);
    const session = body.indexOf("const externalSession = getExternalEditSession();");
    expect(session).toBeGreaterThan(0);
    expect(session).toBeGreaterThan(body.indexOf('tag === "INPUT"'));
    expect(session).toBeLessThan(body.indexOf("if (isEditorOpening())"));
  });
});

describe("the tab strip asks the external session (1.12)", () => {
  it("decides clicks through resolveTabClick and preventDefaults a point-mode mousedown", () => {
    const src = code("src/shell/SheetTabs/SheetTabs.tsx");
    expect(src).toContain("const action = resolveTabClick({");
    const mousedown = sliceFrom(src, "const handleTabMouseDown = useCallback(", 700);
    expect(mousedown).toContain("isCrossSheetPointMode()");
    expect(src).toContain("await switchSheetForPointMode(index, dispatch)");
  });
});

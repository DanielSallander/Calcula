//! FILENAME: app/extensions/FloatingRange/editor/__tests__/frEditorScroll.test.ts
// PURPOSE: The floating range's DOM cell editor under overflow scroll (M7):
//          - it FOLLOWS its cell through a scroll, is HIDDEN once the cell has
//            left the range's cell viewport (not only the grid's area), and is
//            CLIPPED while the cell is part-way out, so it never paints over the
//            sticky headers or outside the frame;
//          - Enter after an edit moves over the CONTENT extent and scrolls the
//            new cell into view;
//          - a commit the backend REFUSES (a cell past the window, until the
//            write gate follows the extent) is reported, not dropped silently.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FloatingRangeInfo } from "@api/floatingRanges";

const updateFloatingRangeCell = vi.fn(async (): Promise<number[]> => []);
vi.mock("@api/floatingRanges", () => ({
  FLOATING_RANGE_MAX_ROWS: 1000,
  FLOATING_RANGE_MAX_COLS: 256,
  listFloatingRanges: vi.fn(async () => []),
  updateFloatingRange: vi.fn(async () => ({})),
  updateFloatingRangeCell: (...args: unknown[]) => updateFloatingRangeCell(...(args as [])),
  getFloatingRangeCells: vi.fn(async () => []),
}));

vi.mock("@api/lib", () => ({
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true })),
}));

const showToast = vi.fn();
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showToast: (...args: unknown[]) => showToast(...args),
}));

import type { OverlayRenderContext } from "@api/gridOverlays";
import {
  openFrEditor,
  commitFrEditor,
  cancelFrEditor,
  destroyFrEditor,
  layoutFrEditorForFrame,
  frEditorVisibleInsets,
} from "../frEditor";
import { upsertFromInfo, resetFloatingRangeStore, getFloatingRangeById } from "../../lib/floatingRangeStore";
import { getLocalSelection, setLocalSelection, clearLocalSelection } from "../../lib/frSelection";
import { getFrScroll, setFrScroll } from "../../lib/frScroll";
import { recordFrUsedExtent, resetFrExtents } from "../../lib/frExtent";
import { getFrView } from "../../lib/frView";
import { FR_TITLE_H, FR_COL_HDR_H, FR_ROW_HDR_W, FR_DEFAULT_ROW_H } from "../../lib/frDimensions";

const FR_ID = "fr-edit";
const INFO = {
  id: FR_ID,
  backingSheetId: "backing",
  hostSheetId: "host",
  x: 0,
  y: 0,
  rotation: 0,
  pinToGrid: false,
  rowCount: 4,
  colCount: 3,
  colWidths: {},
  rowHeights: {},
  showTitle: true,
  showColumnHeaders: true,
  showRowHeaders: true,
  name: "Float1",
  backingSheetIndex: 1,
  hostSheetIndex: 0,
} as FloatingRangeInfo;

/** The frame is drawn at canvas (100, 50); the grid's own headers are 0. */
const FRAME = { x: 100, y: 50 };
const CELLS_TOP = FRAME.y + FR_TITLE_H + FR_COL_HDR_H;

function overlayCtx(): OverlayRenderContext {
  return {
    config: { rowHeaderWidth: 0, colHeaderHeight: 0 },
    viewport: { scrollX: 0, scrollY: 0 },
    canvasWidth: 2000,
    canvasHeight: 2000,
  } as unknown as OverlayRenderContext;
}

function textarea(): HTMLTextAreaElement {
  return document.querySelector("textarea[data-fr-editor]") as HTMLTextAreaElement;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

let layer: HTMLElement;

beforeEach(() => {
  updateFloatingRangeCell.mockReset();
  updateFloatingRangeCell.mockResolvedValue([]);
  showToast.mockClear();
  resetFloatingRangeStore();
  resetFrExtents();
  clearLocalSelection();
  layer = document.createElement("div");
  layer.setAttribute("data-grid-canvas-layer", "");
  document.body.appendChild(layer);
  upsertFromInfo(INFO);
  recordFrUsedExtent(FR_ID, 10, 3); // content reaches row 9; the window shows 4
});

afterEach(() => {
  cancelFrEditor();
  destroyFrEditor();
  layer.remove();
  resetFloatingRangeStore();
  resetFrExtents();
  clearLocalSelection();
  vi.restoreAllMocks();
});

describe("frEditorVisibleInsets", () => {
  const viewport = { x: 0, y: 0, width: 100, height: 100 };
  const grid = { x: 0, y: 0, width: 1000, height: 1000 };

  it("is all zeros for a cell fully inside", () => {
    expect(frEditorVisibleInsets({ x: 10, y: 10, width: 20, height: 20 }, viewport, grid)).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });

  it("clips the part of a cell above the viewport", () => {
    expect(frEditorVisibleInsets({ x: 10, y: -5, width: 20, height: 20 }, viewport, grid)).toMatchObject({
      top: 5,
      bottom: 0,
    });
  });

  it("is null for a cell entirely outside the viewport, even when on the grid", () => {
    expect(frEditorVisibleInsets({ x: 10, y: 120, width: 20, height: 20 }, viewport, grid)).toBeNull();
  });
});

describe("the editor follows its cell through a scroll", () => {
  it("moves with the scroll, and hides once the cell has left the cell viewport", () => {
    const entry = getFloatingRangeById(FR_ID)!;
    setLocalSelection({ frId: FR_ID, anchorRow: 5, anchorCol: 0, endRow: 5, endCol: 0 });
    setFrScroll(FR_ID, 0, 2 * FR_DEFAULT_ROW_H); // rows 2..5 show; row 5 is the last
    openFrEditor(FR_ID, 5, 0, "x");

    layoutFrEditorForFrame(entry, FRAME.x, FRAME.y, overlayCtx(), getFrView(entry));
    const ta = textarea();
    expect(ta.style.display).toBe("block");
    expect(ta.style.top).toBe(`${CELLS_TOP + 3 * FR_DEFAULT_ROW_H}px`);
    expect(ta.style.left).toBe(`${FRAME.x + FR_ROW_HDR_W}px`);

    // Scrolled back to the top: row 5 is below the 4-row viewport, though it
    // is still well inside the grid's own area -- the editor must hide.
    setFrScroll(FR_ID, 0, 0);
    layoutFrEditorForFrame(entry, FRAME.x, FRAME.y, overlayCtx(), getFrView(entry));
    expect(ta.style.display).toBe("none");
  });

  it("is clipped, not hidden, while the cell is part-way under the sticky header", () => {
    const entry = getFloatingRangeById(FR_ID)!;
    openFrEditor(FR_ID, 2, 0, "x");
    setFrScroll(FR_ID, 0, 2 * FR_DEFAULT_ROW_H + 5); // 5px of row 2 scrolled under
    layoutFrEditorForFrame(entry, FRAME.x, FRAME.y, overlayCtx(), getFrView(entry));
    const ta = textarea();
    expect(ta.style.display).toBe("block");
    expect(ta.style.top).toBe(`${CELLS_TOP - 5}px`);
    // The top 5px (under the sticky letter strip) are inset away.
    expect(ta.style.clipPath).toBe("inset(5px 0px 0px 0px)");

    // Fully back in view: no clip left behind.
    setFrScroll(FR_ID, 0, 2 * FR_DEFAULT_ROW_H);
    layoutFrEditorForFrame(entry, FRAME.x, FRAME.y, overlayCtx(), getFrView(entry));
    expect(ta.style.clipPath).toBe("");
  });
});

describe("commit", () => {
  it("Enter moves over the CONTENT extent and scrolls the new cell into view", async () => {
    setLocalSelection({ frId: FR_ID, anchorRow: 3, anchorCol: 0, endRow: 3, endCol: 0 });
    openFrEditor(FR_ID, 3, 0, "42");
    await commitFrEditor("down");
    await flush();
    expect(updateFloatingRangeCell).toHaveBeenCalledWith(FR_ID, 3, 0, "42");
    expect(getLocalSelection()).toMatchObject({ anchorRow: 4 });
    expect(getFrScroll(FR_ID).top).toBe(FR_DEFAULT_ROW_H);
  });

  it("a refused write is REPORTED, not dropped in silence", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    updateFloatingRangeCell.mockRejectedValueOnce(
      new Error("Cell (6,0) is outside the floating range's 4x3 window"),
    );
    setLocalSelection({ frId: FR_ID, anchorRow: 6, anchorCol: 0, endRow: 6, endCol: 0 });
    openFrEditor(FR_ID, 6, 0, "typed");
    await commitFrEditor(null);
    await flush();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(String(showToast.mock.calls[0][0])).toContain("outside the floating range");
    expect(showToast.mock.calls[0][1]).toEqual({ type: "error" });
  });
});

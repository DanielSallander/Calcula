//! FILENAME: app/extensions/DataValidation/handlers/__tests__/dropdownHandler.test.ts
// PURPOSE: The click interceptor must claim ONLY the dropdown chevron.
// CONTEXT: Regression cover for the defect where any click anywhere on a
//          list-validated cell opened the list AND suppressed selection, which
//          made those cells unselectable and broke drag-selection across them.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockShowOverlay = vi.fn();
const mockHideOverlay = vi.fn();
const mockHasInCellDropdown = vi.fn();
const mockDispatchGridAction = vi.fn();

vi.mock("@api", () => ({
  showOverlay: (...args: unknown[]) => mockShowOverlay(...args),
  hideOverlay: (...args: unknown[]) => mockHideOverlay(...args),
  hasInCellDropdown: (...args: unknown[]) => mockHasInCellDropdown(...args),
  dispatchGridAction: (...args: unknown[]) => mockDispatchGridAction(...args),
  // Imported by validationStore (never called in these tests).
  getAllDataValidations: vi.fn(),
  getInvalidCells: vi.fn(),
  addGridRegions: vi.fn(),
  removeGridRegionsByType: vi.fn(),
  requestOverlayRedraw: vi.fn(),
  emitAppEvent: vi.fn(),
}));

const mockGetGridStateSnapshot = vi.fn();
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => mockGetGridStateSnapshot(),
  setSelection: (
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number
  ) => ({ type: "SET_SELECTION", payload: { startRow, startCol, endRow, endCol } }),
}));

const mockGetGridCanvas = vi.fn();
vi.mock("@api/rendering", () => ({
  getGridCanvas: () => mockGetGridCanvas(),
}));

import {
  handleDropdownChevronClick,
  toggleDropdownFromKeyboard,
} from "../dropdownHandler";
import { getOpenDropdownCell, setOpenDropdownCell } from "../../lib/validationStore";

// ---------------------------------------------------------------------------
// Fixture: default 100x20 cells, 50px row header, 24px column header, no scroll.
// Cell (2, 3) therefore spans x 350..450, y 64..84 and its chevron is x 431..449.
// ---------------------------------------------------------------------------

const ROW = 2;
const COL = 3;

function gridState(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      defaultCellWidth: 100,
      defaultCellHeight: 20,
      rowHeaderWidth: 50,
      colHeaderHeight: 24,
    },
    viewport: { scrollX: 0, scrollY: 0 },
    dimensions: { columnWidths: new Map(), rowHeights: new Map() },
    zoom: 1,
    ...overrides,
  };
}

function fakeCanvas(left = 0, top = 0): HTMLCanvasElement {
  return {
    getBoundingClientRect: () => ({ left, top, width: 800, height: 600 }),
  } as unknown as HTMLCanvasElement;
}

function click(clientX: number, clientY: number) {
  return handleDropdownChevronClick(ROW, COL, { clientX, clientY });
}

beforeEach(() => {
  vi.clearAllMocks();
  setOpenDropdownCell(null);
  mockGetGridStateSnapshot.mockReturnValue(gridState());
  mockGetGridCanvas.mockReturnValue(fakeCanvas());
  mockHasInCellDropdown.mockResolvedValue(true);
});

describe("handleDropdownChevronClick", () => {
  it("opens the list when the chevron button is clicked", async () => {
    const handled = await click(440, 70);

    expect(handled).toBe(true);
    expect(mockShowOverlay).toHaveBeenCalledTimes(1);
    expect(mockShowOverlay.mock.calls[0][0]).toBe("validation-list-dropdown");
    expect(getOpenDropdownCell()).toEqual({ row: ROW, col: COL });
  });

  it("anchors the list to the cell rectangle, not the pointer", async () => {
    await click(445, 82);

    const options = mockShowOverlay.mock.calls[0][1] as {
      anchorRect: { x: number; y: number; width: number; height: number };
    };
    expect(options.anchorRect).toEqual({ x: 350, y: 64, width: 100, height: 20 });
  });

  it("also selects the cell, like Excel does", async () => {
    await click(440, 70);

    expect(mockDispatchGridAction).toHaveBeenCalledWith({
      type: "SET_SELECTION",
      payload: { startRow: ROW, startCol: COL, endRow: ROW, endCol: COL },
    });
  });

  it("does NOT claim a click on the cell body - selection stays normal", async () => {
    for (const x of [351, 380, 400, 425, 430]) {
      expect(await click(x, 70)).toBe(false);
    }
    expect(mockShowOverlay).not.toHaveBeenCalled();
    expect(getOpenDropdownCell()).toBeNull();
  });

  it("does not even ask the backend for a cell-body click", async () => {
    await click(380, 70);
    expect(mockHasInCellDropdown).not.toHaveBeenCalled();
  });

  it("leaves a drag across a validated region entirely to the grid", async () => {
    // A drag is a mousedown in the body of one cell; every cell of the sweep
    // must decline the click so Core can extend the selection.
    const results: boolean[] = [];
    for (let col = 1; col <= 5; col++) {
      const cellLeft = 50 + col * 100;
      results.push(
        await handleDropdownChevronClick(ROW, col, {
          clientX: cellLeft + 20,
          clientY: 70,
        })
      );
    }
    expect(results).toEqual([false, false, false, false, false]);
  });

  it("closes the list when the chevron of the open cell is clicked again", async () => {
    setOpenDropdownCell({ row: ROW, col: COL });

    const handled = await click(440, 70);

    expect(handled).toBe(true);
    expect(mockHideOverlay).toHaveBeenCalledWith("validation-list-dropdown");
    expect(getOpenDropdownCell()).toBeNull();
    // Toggling closed is decided synchronously so it cannot race the list's own
    // outside-click close and re-open what was just closed.
    expect(mockHasInCellDropdown).not.toHaveBeenCalled();
    expect(mockShowOverlay).not.toHaveBeenCalled();
  });

  it("declines cells that have no in-cell dropdown", async () => {
    mockHasInCellDropdown.mockResolvedValue(false);
    expect(await click(440, 70)).toBe(false);
    expect(mockShowOverlay).not.toHaveBeenCalled();
  });

  it("declines when the backend lookup fails", async () => {
    mockHasInCellDropdown.mockRejectedValue(new Error("backend down"));
    expect(await click(440, 70)).toBe(false);
  });

  it("fails closed when the grid geometry cannot be resolved", async () => {
    mockGetGridCanvas.mockReturnValue(null);
    expect(await click(440, 70)).toBe(false);

    mockGetGridCanvas.mockReturnValue(fakeCanvas());
    mockGetGridStateSnapshot.mockReturnValue(null);
    expect(await click(440, 70)).toBe(false);
  });

  it("accounts for zoom and the canvas offset", async () => {
    mockGetGridStateSnapshot.mockReturnValue(gridState({ zoom: 2 }));
    mockGetGridCanvas.mockReturnValue(fakeCanvas(30, 10));

    // Chevron in canvas space is x 431..449, y 65..83 -> client x = 30 + 2*x.
    expect(await click(30 + 880, 10 + 140)).toBe(true); // (440, 70) logical
    expect(await click(30 + 760, 10 + 140)).toBe(false); // (380, 70) logical
  });

  it("accounts for scroll", async () => {
    mockGetGridStateSnapshot.mockReturnValue(
      gridState({ viewport: { scrollX: 100, scrollY: 20 } })
    );
    // Cell (2,3) shifts left/up by the scroll: x 250..350, y 44..64.
    expect(await click(340, 50)).toBe(true);
    expect(await click(440, 70)).toBe(false);
  });

  it("honours custom column widths", async () => {
    const columnWidths = new Map<number, number>([[3, 40]]);
    mockGetGridStateSnapshot.mockReturnValue(
      gridState({ dimensions: { columnWidths, rowHeights: new Map() } })
    );
    // Cell (2,3) now spans x 350..390; chevron x 371..389.
    expect(await click(380, 70)).toBe(true);
    expect(await click(360, 70)).toBe(false);
  });
});

describe("toggleDropdownFromKeyboard", () => {
  it("opens the list for the active cell", async () => {
    expect(await toggleDropdownFromKeyboard(ROW, COL)).toBe(true);
    expect(mockShowOverlay).toHaveBeenCalledTimes(1);
    expect(getOpenDropdownCell()).toEqual({ row: ROW, col: COL });
  });

  it("closes it again on the second press", async () => {
    setOpenDropdownCell({ row: ROW, col: COL });
    expect(await toggleDropdownFromKeyboard(ROW, COL)).toBe(true);
    expect(mockHideOverlay).toHaveBeenCalledWith("validation-list-dropdown");
    expect(getOpenDropdownCell()).toBeNull();
  });

  it("does nothing on a cell without a list", async () => {
    mockHasInCellDropdown.mockResolvedValue(false);
    expect(await toggleDropdownFromKeyboard(ROW, COL)).toBe(false);
    expect(mockShowOverlay).not.toHaveBeenCalled();
  });

  it("still opens when the pointer geometry is unavailable", async () => {
    mockGetGridCanvas.mockReturnValue(null);
    expect(await toggleDropdownFromKeyboard(ROW, COL)).toBe(true);
    expect(mockShowOverlay).toHaveBeenCalledTimes(1);
  });
});

//! FILENAME: app/extensions/DataValidation/rendering/__tests__/dropdownChevronRenderer.test.ts
// PURPOSE: The painted chevron and the claimed hit area must be the same rectangle.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@api", () => ({
  overlayGetColumnX: () => 350,
  overlayGetRowY: () => 64,
  overlayGetColumnWidth: () => 100,
  overlayGetRowHeight: () => 20,
}));

const mockGetGridStateSnapshot = vi.fn();
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => mockGetGridStateSnapshot(),
}));

vi.mock("@api/rendering", () => ({
  getGridCanvas: () => null,
}));

import {
  renderDropdownChevrons,
  hitTestDropdownChevron,
  getDropdownChevronCursor,
} from "../dropdownChevronRenderer";
import { getChevronRect } from "../../lib/chevronGeometry";

const REGION = {
  id: "validation-dropdown-2-3",
  type: "validation-dropdown",
  startRow: 2,
  startCol: 3,
  endRow: 2,
  endCol: 3,
};

// Same fixture as the click tests: cell (2,3) at x 350..450, y 64..84.
const GRID_STATE = {
  config: {
    defaultCellWidth: 100,
    defaultCellHeight: 20,
    rowHeaderWidth: 50,
    colHeaderHeight: 24,
  },
  viewport: { scrollX: 0, scrollY: 0 },
  dimensions: { columnWidths: new Map(), rowHeights: new Map() },
  zoom: 1,
};

function hitCtx(canvasX: number, canvasY: number, overrides: Record<string, unknown> = {}) {
  return {
    region: REGION,
    canvasX,
    canvasY,
    row: 2,
    col: 3,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetGridStateSnapshot.mockReturnValue(GRID_STATE);
});

describe("renderDropdownChevrons", () => {
  it("paints exactly the shared chevron rectangle", () => {
    const rects: number[][] = [];
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fillRect: (...args: number[]) => rects.push(args),
      strokeRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    renderDropdownChevrons({
      ctx,
      region: REGION,
      config: GRID_STATE.config,
      viewport: GRID_STATE.viewport,
      dimensions: GRID_STATE.dimensions,
      canvasWidth: 800,
      canvasHeight: 600,
    } as never);

    const expected = getChevronRect({ x: 350, y: 64, width: 100, height: 20 });
    expect(rects).toEqual([[expected.x, expected.y, expected.width, expected.height]]);
  });

  it("paints nothing for a foreign region type", () => {
    const ctx = { save: vi.fn(), fillRect: vi.fn() } as unknown as CanvasRenderingContext2D;
    renderDropdownChevrons({
      ctx,
      region: { ...REGION, type: "pivot" },
      config: GRID_STATE.config,
      viewport: GRID_STATE.viewport,
      dimensions: GRID_STATE.dimensions,
      canvasWidth: 800,
      canvasHeight: 600,
    } as never);
    expect(ctx.save).not.toHaveBeenCalled();
  });
});

describe("hitTestDropdownChevron", () => {
  it("claims the chevron button only", () => {
    expect(hitTestDropdownChevron(hitCtx(440, 70))).toBe(true);
    expect(hitTestDropdownChevron(hitCtx(380, 70))).toBe(false);
  });

  it("ignores other region types and other cells", () => {
    expect(
      hitTestDropdownChevron(hitCtx(440, 70, { region: { ...REGION, type: "pivot" } }))
    ).toBe(false);
    expect(hitTestDropdownChevron(hitCtx(440, 70, { row: 5 }))).toBe(false);
  });

  it("fails closed without grid state", () => {
    mockGetGridStateSnapshot.mockReturnValue(null);
    expect(hitTestDropdownChevron(hitCtx(440, 70))).toBe(false);
  });
});

describe("getDropdownChevronCursor", () => {
  it("is a pointer on the button and inherited elsewhere", () => {
    expect(getDropdownChevronCursor(hitCtx(440, 70))).toBe("pointer");
    expect(getDropdownChevronCursor(hitCtx(380, 70))).toBeNull();
  });
});

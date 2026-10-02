//! FILENAME: app/extensions/Checkbox/__tests__/checkboxCursorOcclusion.test.ts
// PURPOSE: The checkbox cell's arrow pointer is written on the grid <canvas>
//          (an inline cursor, which overrides Core's on the container) ONLY
//          where no floating object lies on the cell. Over an object the
//          pointer is the object's zone answer (Core; BUG-0258 "one answer"):
//          a chart lying on a checkbox cell must show 'move' over its frame,
//          not the cell's arrow.
// CONTEXT: The listener (index.ts setupCheckboxCursor) is driven with a real
//          document mousemove on a real <canvas>; the grid lookups it makes
//          lazily are stubbed, and `topFloatingRegionAtClient` is the seam it
//          asks (@api/gridOverlays).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  top: vi.fn((): unknown => null),
  getCell: vi.fn(async () => ({ styleIndex: 7 })),
}));

vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  topFloatingRegionAtClient: h.top,
}));

vi.mock("../../../src/api/grid", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGridStateSnapshot: () => ({ config: {}, viewport: {}, dimensions: {} }),
  getCellFromPixel: () => ({ row: 2, col: 3 }),
}));

vi.mock("../../../src/api/lib", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCell: h.getCell,
}));

import { setupCheckboxCursor } from "../index";
import { checkboxStyleIndices } from "../interceptors";

const CHECKBOX_STYLE = 7;
let canvas: HTMLCanvasElement;
let off: (() => void) | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

async function moveOnCanvas(): Promise<void> {
  canvas.dispatchEvent(new MouseEvent("mousemove", { clientX: 200, clientY: 90, bubbles: true }));
  await settle();
}

beforeEach(() => {
  h.top.mockReset();
  h.top.mockReturnValue(null);
  h.getCell.mockClear();
  checkboxStyleIndices.add(CHECKBOX_STYLE);
  canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  off = setupCheckboxCursor();
});

afterEach(() => {
  off?.();
  off = null;
  checkboxStyleIndices.delete(CHECKBOX_STYLE);
  document.body.innerHTML = "";
});

describe("the checkbox cell's pointer never shows through a floating object", () => {
  it("control: over a bare checkbox cell the canvas shows the arrow", async () => {
    await moveOnCanvas();
    expect(h.getCell).toHaveBeenCalled();
    expect(canvas.style.cursor).toBe("default");
  });

  it("over a floating object lying on the checkbox cell the canvas carries NO inline cursor (Core's zone answer shows)", async () => {
    h.top.mockReturnValue({ id: "chart-1", type: "chart", floating: { x: 0, y: 0, width: 400, height: 300 } });
    await moveOnCanvas();
    expect(canvas.style.cursor, "the cell's arrow overrides the object's pointer").toBe("");
    expect(h.top).toHaveBeenCalledWith(200, 90);
  });

  it("moving from the bare cell onto an object lying over it clears the arrow it had written", async () => {
    await moveOnCanvas();
    expect(canvas.style.cursor).toBe("default");
    h.top.mockReturnValue({ id: "slicer-1", type: "slicer", floating: { x: 0, y: 0, width: 400, height: 300 } });
    await moveOnCanvas();
    expect(canvas.style.cursor).toBe("");
  });
});

//! FILENAME: app/src/core/hooks/useMouseSelection/__tests__/floatingHoverOrder.test.tsx
// PURPOSE: The hover pointer over a FLOATING OBJECT is asked in the order the
//          PRESS takes it (BUG-0258: one answer per point), through the REAL
//          hook's handleMouseMove and handleDoubleClick:
//            - a live handle, and an object's body, come BEFORE the fill
//              handle and the active cell's selection border -- the objects
//              and their handles are painted over both (core.ts), and the
//              mouse-down wrapper hands such a press to the object first
//              (useSpreadsheetSelection.ts; pinned end to end in
//              components/Spreadsheet/__tests__/floatingPressBeforeCells.test.tsx);
//            - while a CONTENT gesture holds the pointer (the timeline's range
//              drag, which selects its timeline and so makes its handles live
//              halfway through), no handle takes the hover from it: the button
//              is held, no resize can start;
//            - a double-click on the outer half of a live handle never opens
//              the editor of the cell underneath (the press there resized).
// CONTEXT: Before, the hover checked the fill handle, the formula reference
//          borders and the selection border BEFORE the object: over a
//          timeline tile or a locked object lying on the active cell's border
//          the pointer said 'move' (a cell drag) while the press started a
//          range drag or only selected; over a handle painted on the fill
//          handle it said 'crosshair' while the press (after the fix) resizes.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useMouseSelection } from "../useMouseSelection";
import type { UseMouseSelectionProps, UseMouseSelectionReturn } from "../types";
import {
  DEFAULT_GRID_CONFIG,
  createEmptyDimensionOverrides,
  type Selection,
  type Viewport,
} from "../../../types";
import {
  registerGridOverlay,
  unregisterGridOverlay,
  setGridRegions,
  holdContentGestureCursor,
  clearContentGestureCursor,
  type GridRegion,
} from "../../../../api/gridOverlays";
import {
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
} from "../../../../api/objectSelection";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const CONFIG = { ...DEFAULT_GRID_CONFIG };
const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };
const TYPE = "hover-order-test";
const RHW = CONFIG.rowHeaderWidth;
const CHH = CONFIG.colHeaderHeight;
const CW = CONFIG.defaultCellWidth;
const CH = CONFIG.defaultCellHeight;

/** Sheet px (130, 100) 200 x 150: canvas [RHW+130 .. RHW+330] x [CHH+100 .. CHH+250]. */
const BOX = { x: 130, y: 100, width: 200, height: 150 };
const L = RHW + BOX.x;
const T = CHH + BOX.y;
const R = L + BOX.width;
const B = T + BOX.height;

function region(data: Record<string, unknown> = {}): GridRegion {
  return {
    id: "obj-1",
    type: TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { ...BOX },
    data,
  };
}

function cellSel(row: number, col: number): Selection {
  return { startRow: row, startCol: col, endRow: row, endCol: col, type: "cells" };
}

/** The cell under a canvas point (default dimensions, no scroll). */
function cellAt(x: number, y: number): { row: number; col: number } {
  return { row: Math.floor((y - CHH) / CH), col: Math.floor((x - RHW) / CW) };
}

type ApiSink = { current: UseMouseSelectionReturn | null };
let root: Root | null = null;
let selected = true;
let offProvider: (() => void) | null = null;

async function mountHook(selection: Selection | null): Promise<ApiSink> {
  const sink: ApiSink = { current: null };
  function Harness(): React.ReactElement {
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const api = useMouseSelection({
      containerRef,
      scrollRef: { current: null },
      config: CONFIG,
      viewport: VIEWPORT,
      selection,
      dimensions: createEmptyDimensionOverrides(),
    } as UseMouseSelectionProps);
    React.useEffect(() => {
      sink.current = api;
    });
    return <div ref={containerRef} />;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness />);
  });
  return sink;
}

async function hover(sink: ApiSink, point: { x: number; y: number }): Promise<string> {
  await act(async () => {
    sink.current!.handleMouseMove({
      clientX: point.x,
      clientY: point.y,
      altKey: false,
    } as unknown as React.MouseEvent<HTMLElement>);
  });
  return sink.current!.cursorStyle;
}

beforeEach(() => {
  root = null;
  selected = true;
  offProvider = registerObjectSelectionProvider({
    types: [TYPE],
    isSelected: () => selected,
    select: () => {},
    deselectAll: () => {},
  });
  setGridRegions([region()]);
});

afterEach(async () => {
  if (root) {
    const toUnmount = root;
    await act(async () => {
      toUnmount.unmount();
    });
    root = null;
  }
  offProvider?.();
  offProvider = null;
  resetObjectSelectionProviders();
  unregisterGridOverlay(TYPE);
  clearContentGestureCursor();
  setGridRegions([]);
  document.body.innerHTML = "";
});

describe("a floating object answers the hover before the fill handle and the selection border", () => {
  it("a live handle painted over the FILL HANDLE shows the handle's pointer, not the fill crosshair", async () => {
    // The left-edge handle's OUTER half, over the fill handle of the cell to its left.
    const point = { x: L - 3, y: T + BOX.height / 2 + 3 };
    const cell = cellAt(point.x - 1, point.y + 1);
    const sink = await mountHook(cellSel(cell.row, cell.col));
    expect(point.x).toBeLessThan(L);
    selected = false;
    expect(await hover(sink, point), "control: with no live handle the fill handle shows its crosshair").toBe("crosshair");
    selected = true;
    expect(await hover(sink, point)).toBe("ew-resize");
  });

  it("an object's BODY over the fill handle shows the object's pointer", async () => {
    selected = false;
    const cell = cellAt(L + 60, T + 60);
    const fill = { x: RHW + (cell.col + 1) * CW - 4, y: CHH + (cell.row + 1) * CH - 4 };
    const sink = await mountHook(cellSel(cell.row, cell.col));
    expect(await hover(sink, fill)).toBe("move");
    registerGridOverlay({ type: TYPE, render: () => {}, zoneAt: () => ({ kind: "content", cursor: "pointer" }) });
    expect(await hover(sink, fill), "the fill handle under the object answered").toBe("pointer");
  });

  it("an object lying on the active cell's SELECTION BORDER shows its own zone's pointer -- content 'pointer', an immovable frame 'default' -- never the cell drag's 'move'", async () => {
    selected = false;
    // A selected cell inside the body, clear of its fill handle: its top border.
    const cell = cellAt(L + 40, T + 50);
    const border = { x: RHW + cell.col * CW + CW / 2, y: CHH + cell.row * CH + 1 };
    expect(border.x).toBeGreaterThan(L);
    expect(border.y).toBeGreaterThan(T);
    const sink = await mountHook(cellSel(cell.row, cell.col));

    registerGridOverlay({ type: TYPE, render: () => {}, zoneAt: () => ({ kind: "content", cursor: "pointer" }) });
    expect(await hover(sink, border), "a content zone lying on the selection border").toBe("pointer");

    unregisterGridOverlay(TYPE);
    setGridRegions([region({ movable: false })]);
    expect(await hover(sink, border), "an immovable frame lying on the selection border").toBe("default");

    // Control: with no object there, the border is the cell drag's.
    setGridRegions([]);
    expect(await hover(sink, border)).toBe("move");
  });
});

describe("a held content gesture keeps the pointer over its object's live handles", () => {
  it("over the right-edge handle of the gesture's own (selected) object the pointer is the gesture's, then the handle's again once released", async () => {
    const sink = await mountHook(null);
    const eMid = { x: R, y: T + BOX.height / 2 };
    expect(await hover(sink, eMid), "control: the live handle").toBe("ew-resize");
    const release = holdContentGestureCursor("obj-1", "grabbing");
    expect(await hover(sink, eMid), "a live handle took the pointer from the held gesture").toBe("grabbing");
    release();
    expect(await hover(sink, eMid)).toBe("ew-resize");
  });
});

describe("a double-click on a live handle's outer half", () => {
  it("never opens the editor of the cell under it; on an unselected object it is that cell's", async () => {
    const sink = await mountHook(null);
    const outer = { x: R + 4, y: T + BOX.height / 2 };
    const dbl = () =>
      sink.current!.handleDoubleClick({ clientX: outer.x, clientY: outer.y } as unknown as React.MouseEvent<HTMLElement>);
    expect(dbl(), "the handle's double-click opened the cell editor underneath").toBeNull();
    selected = false;
    expect(dbl()).toEqual(cellAt(outer.x, outer.y));
  });
});

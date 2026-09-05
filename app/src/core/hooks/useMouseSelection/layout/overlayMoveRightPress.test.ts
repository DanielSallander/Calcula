//! FILENAME: app/src/core/hooks/useMouseSelection/layout/overlayMoveRightPress.test.ts
// PURPOSE: A SECONDARY press on a floating overlay dispatches nothing and drags
//          nothing — while still consuming the press, so the cell cursor does
//          not jump to the cell under the object.
// CONTEXT: `handleOverlayMoveMouseDown` is the ONLY place in the codebase where
//          a native mousedown becomes `floatingObject:selected`, and Controls'
//          listener turns that event into `button:clicked` for a run-mode
//          button — so with no `event.button` filter anywhere upstream, a
//          RIGHT-CLICK RAN THE USER'S MACRO. The filter belongs at this
//          dispatch rather than in Controls' listener because six listeners
//          share the event and any one added later inherits its meaning.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type React from "react";
import { createOverlayMoveHandlers, type OverlayMoveState } from "./overlayMoveHandlers";
import { setGridRegions } from "../../../../api/gridOverlays";
import { DEFAULT_GRID_CONFIG, type Viewport } from "../../../types";

const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };

/** A floating region whose body covers a comfortable patch of canvas. */
const BUTTON_REGION = {
  id: "control-1",
  type: "control",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  data: { controlType: "button" },
  floating: { x: 100, y: 100, width: 120, height: 40 },
};

/** Dead centre of that region, in the canvas pixels checkOverlayBody expects. */
const CENTRE = {
  x: (DEFAULT_GRID_CONFIG.rowHeaderWidth ?? 50) + 160,
  y: (DEFAULT_GRID_CONFIG.colHeaderHeight ?? 24) + 120,
};

function pressEvent(button: number): React.MouseEvent<HTMLElement> {
  return {
    button,
    ctrlKey: false,
    target: document.createElement("canvas"),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent<HTMLElement>;
}

describe("a right press on a floating overlay", () => {
  let selected: CustomEvent[];
  let listener: (e: Event) => void;
  let setIsOverlayMoving: ReturnType<typeof vi.fn>;
  let overlayMoveStateRef: { current: OverlayMoveState | null };

  const makeHandlers = () =>
    createOverlayMoveHandlers({
      config: DEFAULT_GRID_CONFIG,
      viewport: VIEWPORT,
      containerRef: { current: null },
      setIsOverlayMoving,
      setCursorStyle: vi.fn(),
      overlayMoveStateRef: overlayMoveStateRef as React.MutableRefObject<OverlayMoveState | null>,
    });

  beforeEach(() => {
    setGridRegions([{ ...BUTTON_REGION }]);
    selected = [];
    listener = (e: Event) => selected.push(e as CustomEvent);
    window.addEventListener("floatingObject:selected", listener);
    setIsOverlayMoving = vi.fn();
    overlayMoveStateRef = { current: null };
  });

  afterEach(() => {
    window.removeEventListener("floatingObject:selected", listener);
    setGridRegions([]);
  });

  it("dispatches no floatingObject:selected — the event Controls turns into button:clicked", () => {
    makeHandlers().handleOverlayMoveMouseDown(CENTRE.x, CENTRE.y, pressEvent(2));
    expect(selected).toHaveLength(0);
  });

  it("starts no move drag", () => {
    makeHandlers().handleOverlayMoveMouseDown(CENTRE.x, CENTRE.y, pressEvent(2));
    expect(setIsOverlayMoving).not.toHaveBeenCalled();
    expect(overlayMoveStateRef.current).toBeNull();
  });

  it("still CONSUMES the press, so the cell cursor does not jump under the object", () => {
    expect(makeHandlers().handleOverlayMoveMouseDown(CENTRE.x, CENTRE.y, pressEvent(2))).toBe(true);
  });

  it("leaves the browser's own default alone (the object menu is a contextmenu event)", () => {
    const event = pressEvent(2);
    makeHandlers().handleOverlayMoveMouseDown(CENTRE.x, CENTRE.y, event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: a LEFT press on the same pixel still selects the object", () => {
    const handlers = makeHandlers();
    expect(handlers.handleOverlayMoveMouseDown(CENTRE.x, CENTRE.y, pressEvent(0))).toBe(true);
    expect(selected).toHaveLength(1);
    expect(selected[0].detail.regionId).toBe("control-1");
  });

  it("a press on a pixel outside every region is not the overlay path's at all", () => {
    expect(makeHandlers().handleOverlayMoveMouseDown(5000, 5000, pressEvent(2))).toBe(false);
    expect(selected).toHaveLength(0);
  });
});

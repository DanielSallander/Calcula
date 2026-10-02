//! FILENAME: app/src/core/hooks/useMouseSelection/layout/overlayMoveRightPress.test.ts
// PURPOSE: A SECONDARY press on a floating overlay dispatches nothing and drags
//          nothing — while still consuming the press, so the cell cursor does
//          not jump to the cell under the object.
// CONTEXT: `handleOverlayMoveMouseDown` is where a native mousedown on an
//          object's body becomes `floatingObject:selected` and, on CONTENT,
//          `floatingObject:bodyDragStart`. A run-mode button RUNS from the
//          second: Controls starts its press at bodyDragStart and runs it at a
//          PRIMARY release inside it (BUG-0258 phase 4c). It used to run from
//          `selected` -- and with no `event.button` filter anywhere upstream,
//          a RIGHT-CLICK RAN THE USER'S MACRO. The filter belongs at this
//          dispatch rather than in a family's listener because many listeners
//          share these events and any one added later inherits their meaning:
//          a secondary press dispatches NEITHER.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type React from "react";
import { createOverlayMoveHandlers, type OverlayMoveState } from "./overlayMoveHandlers";
import { registerGridOverlay, setGridRegions, unregisterGridOverlay } from "../../../../api/gridOverlays";
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
  let setIsOverlayMoving: ReturnType<typeof vi.fn<(value: boolean) => void>>;
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

  it("dispatches no floatingObject:selected (the event a run-mode button used to run from, and every family's press)", () => {
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

describe("a right press on a RUN-MODE button (content: the press its run starts from)", () => {
  let events: Array<{ type: string; detail: Record<string, unknown> }>;
  const record = (e: Event) => events.push({ type: e.type, detail: (e as CustomEvent).detail });
  const NAMES = ["floatingObject:selected", "floatingObject:bodyDragStart"];

  const makeHandlers = () =>
    createOverlayMoveHandlers({
      config: DEFAULT_GRID_CONFIG,
      viewport: VIEWPORT,
      containerRef: { current: null },
      setIsOverlayMoving: vi.fn(),
      setCursorStyle: vi.fn(),
      overlayMoveStateRef: { current: null } as React.MutableRefObject<OverlayMoveState | null>,
    });

  beforeEach(() => {
    // The run-mode button's zone answer (Controls/lib/controlZoneAt.ts): CONTENT, part 'button'.
    registerGridOverlay({ type: "control", render: () => {}, zoneAt: () => ({ kind: "content", cursor: "pointer", part: "button" }) });
    setGridRegions([{ ...BUTTON_REGION, data: { controlType: "button", movable: false } }]);
    events = [];
    for (const n of NAMES) window.addEventListener(n, record);
  });

  afterEach(() => {
    for (const n of NAMES) window.removeEventListener(n, record);
    unregisterGridOverlay("control");
    setGridRegions([]);
  });

  it("dispatches no floatingObject:bodyDragStart either -- the event a run-mode button's press starts from", () => {
    expect(makeHandlers().handleOverlayMoveMouseDown(CENTRE.x, CENTRE.y, pressEvent(2))).toBe(true);
    expect(events, "a right press reached a family's press listener").toEqual([]);
  });

  it("POSITIVE CONTROL: a LEFT press on it dispatches selected AND bodyDragStart (part 'button')", () => {
    makeHandlers().handleOverlayMoveMouseDown(CENTRE.x, CENTRE.y, pressEvent(0));
    expect(events.map((e) => e.type)).toEqual(NAMES);
    expect(events[1].detail).toMatchObject({ regionId: "control-1", part: "button" });
  });
});

//! FILENAME: app/src/core/hooks/useMouseSelection/layout/__tests__/overlayContentClaim.test.ts
// PURPOSE: The two Core facts the timeline's BUG-0258 fix stands on, pinned
//          through the REAL press handlers so a later reorder cannot silently
//          take them away:
//            1. A press on an overlay's CONTENT zone (`zoneAt` answering
//               content) is handed over (`floatingObject:bodyDragStart`) even
//               when the object is LOCKED, and even on a SUBSCRIBED
//               (consume-mode) page: the lock and the subscription refuse
//               only a FRAME move (`resolveFloatingZone` canMove). Owner
//               decision 2026-09-29: dragging a timeline's range or clicking a
//               slicer is reading the report, so it works there; only moving
//               and resizing obey the lock.
//            2. A region that publishes `resizable: false` has no live corner,
//               and (BUG-0258 design phase 3) neither has an UNSELECTED one:
//               the timeline once published the flag while unselected so its
//               corners stopped taking presses meant for its months; Core now
//               gates every handle on the selection itself.
// CONTEXT: The overlayLock harness (a mocked grid-state snapshot for the
//          active sheet, a registered layout surface). No family code: the
//          overlay here is a stand-in whose zone makes the left half content.
//          (Before M5 T6 this pinned the per-press body-drag claim; the zone
//          answer is now the only route, and the pins are the same.)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type React from "react";

const snapshot = { sheetContext: { activeSheetIndex: 1 } };
vi.mock("../../../../state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../state/GridContext")>()),
  getGridStateSnapshot: () => snapshot,
}));

import { createOverlayMoveHandlers, type OverlayMoveState } from "../overlayMoveHandlers";
import { createOverlayResizeHandlers } from "../overlayResizeHandlers";
import {
  registerGridOverlay,
  setGridRegions,
  unregisterGridOverlay,
  type GridRegion,
} from "../../../../../api/gridOverlays";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "../../../../lib/layoutSurface";
import { DEFAULT_GRID_CONFIG, type Viewport } from "../../../../types";
import { selectForHandles } from "./helpers/selectForHandles";

const ACTIVE = 1;
const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };
const RHW = DEFAULT_GRID_CONFIG.rowHeaderWidth ?? 50;
const CHH = DEFAULT_GRID_CONFIG.colHeaderHeight ?? 24;
const TYPE = "content-claim-test";

/** 200 x 100 at sheet (60, 60): canvas x RHW+60 .. RHW+260. */
function region(data: Record<string, unknown> = {}): GridRegion {
  return {
    id: "obj-1",
    type: TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    data,
    floating: { x: 60, y: 60, width: 200, height: 100 },
  };
}

/** The zone: the LEFT half of the body is content, the right half frame. */
const CONTENT = { x: RHW + 60 + 40, y: CHH + 60 + 50 };
const FRAME = { x: RHW + 60 + 160, y: CHH + 60 + 50 };

let locked = false;
function surface(editable: boolean): LayoutSurface {
  return {
    snapToGrid: false,
    gridSize: 25,
    showGrid: false,
    page: { width: 1280, height: 720 },
    editable,
    isLocked: () => locked,
  };
}

function leftPress(): React.MouseEvent<HTMLElement> {
  return {
    button: 0,
    ctrlKey: false,
    shiftKey: false,
    target: document.createElement("canvas"),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent<HTMLElement>;
}

let events: string[];
const record = (e: Event) => events.push(e.type);
const EVENTS = [
  "floatingObject:selected",
  "floatingObject:bodyDragStart",
  "floatingObject:movePreview",
  "floatingObject:moveComplete",
];
let unregisterSurface: (() => void) | null = null;

beforeEach(() => {
  locked = false;
  events = [];
  for (const t of EVENTS) window.addEventListener(t, record);
  registerGridOverlay({
    type: TYPE,
    render: () => {},
    zoneAt: (ctx) =>
      ctx.canvasX < (ctx.floatingCanvasBounds?.x ?? 0) + 100 ? { kind: "content", cursor: "pointer" } : null,
  });
});

afterEach(() => {
  for (const t of EVENTS) window.removeEventListener(t, record);
  unregisterGridOverlay(TYPE);
  unregisterSurface?.();
  unregisterSurface = null;
  setGridRegions([]);
});

function useSurface(s: LayoutSurface): void {
  unregisterSurface = registerLayoutSurfaceProvider({ get: (i) => (i === ACTIVE ? s : null) });
}

/** Press at `at`, drag 40px, release: the events Core dispatched. */
function pressAndDrag(at: { x: number; y: number }): string[] {
  const ref: { current: OverlayMoveState | null } = { current: null };
  const h = createOverlayMoveHandlers({
    config: DEFAULT_GRID_CONFIG,
    viewport: VIEWPORT,
    containerRef: { current: null },
    setIsOverlayMoving: vi.fn(),
    setCursorStyle: vi.fn(),
    overlayMoveStateRef: ref as React.MutableRefObject<OverlayMoveState | null>,
  });
  h.handleOverlayMoveMouseDown(at.x, at.y, leftPress());
  h.handleOverlayMoveMouseMove(at.x + 40, at.y);
  h.handleOverlayMoveMouseUp();
  return events;
}

describe("a CONTENT press is handed over whatever the lock or the subscription says", () => {
  it("control: an unlocked object -- content is handed over, the frame moves", () => {
    setGridRegions([region()]);
    useSurface(surface(true));
    expect(pressAndDrag(CONTENT)).toEqual(["floatingObject:selected", "floatingObject:bodyDragStart"]);
    events = [];
    expect(pressAndDrag(FRAME)).toEqual([
      "floatingObject:selected",
      "floatingObject:movePreview",
      "floatingObject:moveComplete",
    ]);
  });

  it("a LOCKED object: its content still works; its frame does not move", () => {
    setGridRegions([region()]);
    locked = true;
    useSurface(surface(true));
    expect(pressAndDrag(CONTENT)).toEqual(["floatingObject:selected", "floatingObject:bodyDragStart"]);
    events = [];
    expect(pressAndDrag(FRAME)).toEqual(["floatingObject:selected"]);
  });

  it("a SUBSCRIBED page (consume mode): its content still works; nothing moves", () => {
    setGridRegions([region()]);
    useSurface(surface(false));
    expect(pressAndDrag(CONTENT)).toEqual(["floatingObject:selected", "floatingObject:bodyDragStart"]);
    events = [];
    expect(pressAndDrag(FRAME)).toEqual(["floatingObject:selected"]);
  });

  it("an object published movable: false: its content still works", () => {
    setGridRegions([region({ movable: false })]);
    useSurface(surface(true));
    expect(pressAndDrag(CONTENT)).toEqual(["floatingObject:selected", "floatingObject:bodyDragStart"]);
  });
});

describe("a region publishing resizable: false has no live corner", () => {
  function resizeHandlers() {
    return createOverlayResizeHandlers({
      config: DEFAULT_GRID_CONFIG,
      viewport: VIEWPORT,
      dimensions: undefined,
      freezeConfig: null,
      splitBarSize: 0,
      splitViewport: null,
      containerRef: { current: null },
      setIsOverlayResizing: vi.fn(),
      setCursorStyle: vi.fn(),
      overlayResizeStateRef: { current: null },
    } as unknown as Parameters<typeof createOverlayResizeHandlers>[0]);
  }
  /** 5px inside the bottom-left corner: over the object's first "month". */
  const NEAR_CORNER = { x: RHW + 60 + 5, y: CHH + 60 + 100 - 5 };
  let unselect: (() => void) | null = null;
  afterEach(() => {
    unselect?.();
    unselect = null;
  });

  it("control: a SELECTED object with no flag -- the corner handle takes the press (reaching INSIDE the object)", () => {
    unselect = selectForHandles([TYPE]);
    setGridRegions([region()]);
    expect(resizeHandlers().checkOverlayResizeHandle(NEAR_CORNER.x, NEAR_CORNER.y)).not.toBeNull();
  });

  it("resizable: false -- the press falls through to the body, even selected", () => {
    unselect = selectForHandles([TYPE]);
    setGridRegions([region({ resizable: false })]);
    expect(resizeHandlers().checkOverlayResizeHandle(NEAR_CORNER.x, NEAR_CORNER.y)).toBeNull();
  });

  it("an UNSELECTED object has no live corner at all (BUG-0258 phase 3: the timeline no longer publishes the flag)", () => {
    unselect = selectForHandles([TYPE], () => false);
    setGridRegions([region()]);
    expect(resizeHandlers().checkOverlayResizeHandle(NEAR_CORNER.x, NEAR_CORNER.y)).toBeNull();
  });
});

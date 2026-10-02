//! FILENAME: app/src/core/hooks/useMouseSelection/layout/__tests__/overlayZones.test.ts
// PURPOSE: ONE zone answer per press (BUG-0258 phase 2, M5 T2), pinned through
//          Core's REAL press handler:
//            - the zone (`OverlayRegistration.zoneAt`) is resolved ONCE per
//              press and BEFORE the press selects anything -- before
//              `noteObjectPress` and before `floatingObject:selected`. This is
//              where Core's press ORDER is fixed; the floating grid's tests
//              mirror it (extensions may not import src/core).
//            - CONTENT goes to [selected, bodyDragStart] -- even on a locked,
//              movable:false or subscribed object -- with the object-selection
//              modifiers zeroed on `selected` and the RAW ones on
//              `bodyDragStart` (the modifiers belong to the zone).
//            - FRAME moves only when the object can move; otherwise the press
//              only selects: no move is armed, no 'move' pointer is set.
//            - a `zoneAt` that throws is frame (logged), and a registration
//              with no `zoneAt` is all frame -- the only route since M5 T6
//              deleted the per-press body-drag claim.
// CONTEXT: The overlayContentClaim harness: a mocked grid-state snapshot for
//          the active sheet, a registered layout surface. The families are
//          stand-ins; no family code.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type React from "react";

const snapshot: { surface: "grid" | "canvas"; sheetContext: { activeSheetIndex: number } } = {
  surface: "grid",
  sheetContext: { activeSheetIndex: 1 },
};
vi.mock("../../../../state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../state/GridContext")>()),
  getGridStateSnapshot: () => snapshot,
}));

import { createOverlayMoveHandlers, type OverlayMoveState } from "../overlayMoveHandlers";
import {
  registerGridOverlay,
  setGridRegions,
  unregisterGridOverlay,
  type GridRegion,
  holdContentGestureCursor,
  contentGestureCursorFor,
  clearContentGestureCursor,
  type OverlayZone,
  type OverlayHitTestContext,
} from "../../../../../api/gridOverlays";
import {
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
} from "../../../../../api/objectSelection";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "../../../../lib/layoutSurface";
import { DEFAULT_GRID_CONFIG, type Viewport } from "../../../../types";

const ACTIVE = 1;
const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };
const RHW = DEFAULT_GRID_CONFIG.rowHeaderWidth ?? 50;
const CHH = DEFAULT_GRID_CONFIG.colHeaderHeight ?? 24;
const TYPE = "zone-test";

/** 200 x 100 at sheet (60, 60). */
function region(data: Record<string, unknown> = {}, id = "obj-1"): GridRegion {
  return {
    id,
    type: TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    data,
    floating: { x: 60, y: 60, width: 200, height: 100 },
  };
}

/** The zone: the LEFT half of the body is a content strip, the right half frame. */
const CONTENT = { x: RHW + 60 + 40, y: CHH + 60 + 50 };
const FRAME = { x: RHW + 60 + 160, y: CHH + 60 + 50 };

const leftHalf = (ctx: OverlayHitTestContext): OverlayZone | null =>
  ctx.canvasX < (ctx.floatingCanvasBounds?.x ?? 0) + 100
    ? { kind: "content", cursor: "pointer", part: "strip" }
    : null;

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

function press(mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}): React.MouseEvent<HTMLElement> {
  return {
    button: 0,
    ctrlKey: mods.ctrlKey === true,
    shiftKey: mods.shiftKey === true,
    target: document.createElement("canvas"),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent<HTMLElement>;
}

let events: string[];
let details: Array<{ type: string; detail: Record<string, unknown> }>;
const record = (e: Event) => {
  events.push(e.type);
  details.push({ type: e.type, detail: (e as CustomEvent).detail });
};
const EVENTS = [
  "floatingObject:selected",
  "floatingObject:bodyDragStart",
  "floatingObject:movePreview",
  "floatingObject:moveComplete",
];
let unregisterSurface: (() => void) | null = null;

beforeEach(() => {
  locked = false;
  snapshot.surface = "grid";
  events = [];
  details = [];
  for (const t of EVENTS) window.addEventListener(t, record);
});

afterEach(() => {
  for (const t of EVENTS) window.removeEventListener(t, record);
  unregisterGridOverlay(TYPE);
  unregisterSurface?.();
  unregisterSurface = null;
  resetObjectSelectionProviders();
  setGridRegions([]);
  vi.restoreAllMocks();
});

function useSurface(s: LayoutSurface): void {
  unregisterSurface = registerLayoutSurfaceProvider({ get: (i) => (i === ACTIVE ? s : null) });
}

function handlers() {
  const ref: { current: OverlayMoveState | null } = { current: null };
  const setIsOverlayMoving = vi.fn();
  const setCursorStyle = vi.fn();
  const h = createOverlayMoveHandlers({
    config: DEFAULT_GRID_CONFIG,
    viewport: VIEWPORT,
    containerRef: { current: null },
    setIsOverlayMoving,
    setCursorStyle,
    overlayMoveStateRef: ref as React.MutableRefObject<OverlayMoveState | null>,
  });
  return { h, setIsOverlayMoving, setCursorStyle, ref };
}

/** Press at `at`, drag 40px, release: what Core dispatched and set. */
function pressAndDrag(at: { x: number; y: number }, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) {
  const t = handlers();
  expect(t.h.handleOverlayMoveMouseDown(at.x, at.y, press(mods))).toBe(true);
  t.h.handleOverlayMoveMouseMove(at.x + 40, at.y);
  t.h.handleOverlayMoveMouseUp();
  return { events: [...events], ...t };
}

const SELECTED_THEN_CONTENT = ["floatingObject:selected", "floatingObject:bodyDragStart"];
const SELECTED_THEN_MOVE = [
  "floatingObject:selected",
  "floatingObject:movePreview",
  "floatingObject:moveComplete",
];

describe("CONTENT is handed over; FRAME moves only when the object can move", () => {
  it("control: an unlocked object -- content is handed over, the frame moves", () => {
    registerGridOverlay({ type: TYPE, render: () => {}, zoneAt: leftHalf });
    setGridRegions([region()]);
    useSurface(surface(true));

    expect(pressAndDrag(CONTENT).events).toEqual(SELECTED_THEN_CONTENT);
    events = [];
    const frame = pressAndDrag(FRAME);
    expect(frame.events).toEqual(SELECTED_THEN_MOVE);
    expect(frame.setIsOverlayMoving).toHaveBeenCalledWith(true);
    expect(frame.setCursorStyle).toHaveBeenCalledWith("move");
  });

  const refusing: Array<[string, () => void]> = [
    ["LOCKED", () => {
      locked = true;
      setGridRegions([region()]);
      useSurface(surface(true));
    }],
    ["on a SUBSCRIBED page (consume mode)", () => {
      setGridRegions([region()]);
      useSurface(surface(false));
    }],
    ["published movable: false", () => {
      setGridRegions([region({ movable: false })]);
      useSurface(surface(true));
    }],
  ];

  for (const [label, arrange] of refusing) {
    it(`an object ${label}: its content still works; its frame press only selects`, () => {
      registerGridOverlay({ type: TYPE, render: () => {}, zoneAt: leftHalf });
      arrange();

      expect(pressAndDrag(CONTENT).events).toEqual(SELECTED_THEN_CONTENT);
      events = [];
      const frame = pressAndDrag(FRAME);
      expect(frame.events).toEqual(["floatingObject:selected"]);
      // No move is ARMED at all: no isOverlayMoving, no 'move' pointer.
      expect(frame.setIsOverlayMoving).not.toHaveBeenCalled();
      expect(frame.setCursorStyle).not.toHaveBeenCalledWith("move");
      expect(frame.ref.current).toBeNull();
    });
  }

  it("a frame zone with its OWN cursor still moves like any frame", () => {
    registerGridOverlay({
      type: TYPE,
      render: () => {},
      zoneAt: () => ({ kind: "frame", cursor: "pointer", part: "item" }),
    });
    setGridRegions([region()]);
    useSurface(surface(true));
    expect(pressAndDrag(CONTENT).events).toEqual(SELECTED_THEN_MOVE);
  });

  it("a zoneAt that THROWS is frame (and logged), so the object still moves", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerGridOverlay({
      type: TYPE,
      render: () => {},
      zoneAt: () => {
        throw new Error("broken family");
      },
    });
    setGridRegions([region()]);
    useSurface(surface(true));
    expect(pressAndDrag(CONTENT).events).toEqual(SELECTED_THEN_MOVE);
    expect(error).toHaveBeenCalled();
  });

  it("a zoneAt answering null everywhere is a whole-frame object", () => {
    registerGridOverlay({ type: TYPE, render: () => {}, zoneAt: () => null });
    setGridRegions([region()]);
    useSurface(surface(true));
    expect(pressAndDrag(CONTENT).events).toEqual(SELECTED_THEN_MOVE);
  });
});

describe("the modifiers belong to the zone", () => {
  it("CONTENT: `selected` carries no object-selection modifiers; `bodyDragStart` carries the raw ones", () => {
    registerGridOverlay({ type: TYPE, render: () => {}, zoneAt: leftHalf });
    setGridRegions([region()]);
    useSurface(surface(true));

    pressAndDrag(CONTENT, { ctrlKey: true, shiftKey: true });
    const selected = details.find((d) => d.type === "floatingObject:selected")!.detail;
    const start = details.find((d) => d.type === "floatingObject:bodyDragStart")!.detail;
    expect(selected).toMatchObject({
      regionId: "obj-1",
      regionType: TYPE,
      zone: "content",
      part: "strip",
      canvasX: CONTENT.x,
      canvasY: CONTENT.y,
      ctrlKey: false,
      shiftKey: false,
    });
    expect(start).toMatchObject({
      regionId: "obj-1",
      regionType: TYPE,
      part: "strip",
      canvasX: CONTENT.x,
      canvasY: CONTENT.y,
      ctrlKey: true,
      shiftKey: true,
    });
  });

  it("FRAME: `selected` carries the raw modifiers and the zone", () => {
    registerGridOverlay({ type: TYPE, render: () => {}, zoneAt: leftHalf });
    setGridRegions([region()]);
    useSurface(surface(true));

    pressAndDrag(FRAME, { ctrlKey: true, shiftKey: false });
    const selected = details.find((d) => d.type === "floatingObject:selected")!.detail;
    expect(selected).toMatchObject({ zone: "frame", part: null, ctrlKey: true, shiftKey: false });
  });
});

describe("ORDER: the zone is resolved once, BEFORE the press selects anything", () => {
  it("zoneAt runs before noteObjectPress and before `selected`, and answers from the PRE-press state", () => {
    snapshot.surface = "canvas";
    useSurface(surface(true));
    const log: string[] = [];

    // The family's zone depends on its own selection -- exactly what a family
    // must never do. If Core resolved the zone after selecting, the press
    // would see the POST-press answer (frame) and move the object.
    let selectedByFamily = false;
    registerGridOverlay({
      type: TYPE,
      render: () => {},
      zoneAt: () => {
        log.push("zoneAt");
        return selectedByFamily ? null : { kind: "content", cursor: "crosshair", part: "brush" };
      },
    });
    // Another family holds a selection: a plain canvas press deselects it
    // from inside noteObjectPress -- the observable moment of that call.
    registerObjectSelectionProvider({
      types: ["other-family"],
      isSelected: () => true,
      select: () => {},
      deselectAll: () => {
        log.push("noteObjectPress");
      },
    });
    const onSelected = () => {
      log.push("selected");
      selectedByFamily = true;
    };
    window.addEventListener("floatingObject:selected", onSelected);
    try {
      setGridRegions([region()]);
      const t = handlers();
      expect(t.h.handleOverlayMoveMouseDown(CONTENT.x, CONTENT.y, press())).toBe(true);
      expect(log).toEqual(["zoneAt", "noteObjectPress", "selected"]);
      expect(events).toEqual(SELECTED_THEN_CONTENT);
      expect(t.ref.current).toBeNull();
    } finally {
      window.removeEventListener("floatingObject:selected", onSelected);
    }
  });
});

describe("WORKSHEET PRESS PARITY: a plain press deselects every OTHER family before `selected` (BUG-0270 review)", () => {
  // On a worksheet Core used to call the seam's press hook not at all, so a
  // chart clicked before a slicer stayed selected beside it and Delete
  // removed the chart clicked EARLIER. A worksheet now gets the plain rule
  // (`noteWorksheetObjectPress`): a plain press -- or any press on CONTENT,
  // whose modifiers are the content's -- deselects the other families; a
  // Ctrl/Shift FRAME press keeps them (a deliberate multi-selection).
  function families(log: string[]): void {
    registerObjectSelectionProvider({
      types: ["other-family"],
      isSelected: () => true,
      select: () => {},
      deselectAll: () => {
        log.push("other deselected");
      },
    });
    registerObjectSelectionProvider({
      types: [TYPE],
      isSelected: () => false,
      select: () => {},
      deselectAll: () => {
        log.push("own deselected");
      },
    });
  }

  function pressLogged(at: { x: number; y: number }, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}): string[] {
    registerGridOverlay({ type: TYPE, render: () => {}, zoneAt: leftHalf });
    setGridRegions([region()]);
    useSurface(surface(true));
    const log: string[] = [];
    families(log);
    const onSelected = () => log.push("selected");
    window.addEventListener("floatingObject:selected", onSelected);
    try {
      const t = handlers();
      expect(t.h.handleOverlayMoveMouseDown(at.x, at.y, press(mods))).toBe(true);
      t.h.handleOverlayMoveMouseUp();
    } finally {
      window.removeEventListener("floatingObject:selected", onSelected);
    }
    return log;
  }

  it("a plain FRAME press on a worksheet deselects the other family, before the press is announced; never the pressed one's", () => {
    expect(snapshot.surface).toBe("grid");
    expect(pressLogged(FRAME), "a chart clicked before this object stayed selected beside it").toEqual([
      "other deselected",
      "selected",
    ]);
  });

  for (const mods of [{ ctrlKey: true }, { shiftKey: true }]) {
    it(`a ${JSON.stringify(mods)} FRAME press keeps the other family's object (a deliberate multi-selection)`, () => {
      expect(pressLogged(FRAME, mods)).toEqual(["selected"]);
    });
  }

  it("a Ctrl press on CONTENT is a plain press (the modifiers are the content's): the other family is deselected", () => {
    expect(pressLogged(CONTENT, { ctrlKey: true })).toEqual(["other deselected", "selected"]);
  });
});

describe("no content gesture's pointer outlives the next object press", () => {
  it("a held gesture pointer whose release never came is dropped by the next press (the backstop)", () => {
    registerGridOverlay({ type: TYPE, render: () => {}, zoneAt: leftHalf });
    setGridRegions([region()]);
    useSurface(surface(true));
    try {
      holdContentGestureCursor("obj-1", "ew-resize");
      expect(contentGestureCursorFor("obj-1")).toBe("ew-resize");
      const t = handlers();
      t.h.handleOverlayMoveMouseDown(FRAME.x, FRAME.y, press());
      expect(contentGestureCursorFor("obj-1")).toBeNull();
      t.h.handleOverlayMoveMouseUp();
    } finally {
      clearContentGestureCursor();
    }
  });
});

describe("a registration WITHOUT zoneAt is all frame (M5 T6: there is no legacy route)", () => {
  it("a press selects it with the RAW modifiers and the zone, then moves it", () => {
    registerGridOverlay({ type: TYPE, render: () => {} });
    setGridRegions([region()]);
    useSurface(surface(true));
    const t = pressAndDrag(CONTENT, { ctrlKey: true });
    expect(t.events).toEqual(SELECTED_THEN_MOVE);
    expect(t.setCursorStyle).toHaveBeenCalledWith("move");
    const selected = details.find((d) => d.type === "floatingObject:selected")!.detail;
    expect(selected).toMatchObject({ zone: "frame", part: null, ctrlKey: true, shiftKey: false });
  });

  it("LOCKED or movable: false, the press only selects -- no move is armed, no 'move' pointer", () => {
    registerGridOverlay({ type: TYPE, render: () => {} });
    locked = true;
    setGridRegions([region()]);
    useSurface(surface(true));
    const lockedPress = pressAndDrag(CONTENT);
    expect(lockedPress.events).toEqual(["floatingObject:selected"]);
    expect(lockedPress.setIsOverlayMoving).not.toHaveBeenCalled();
    expect(lockedPress.setCursorStyle).not.toHaveBeenCalledWith("move");

    locked = false;
    events = [];
    setGridRegions([region({ movable: false })]);
    const immovable = pressAndDrag(CONTENT);
    expect(immovable.events).toEqual(["floatingObject:selected"]);
    expect(immovable.setIsOverlayMoving).not.toHaveBeenCalled();
    expect(immovable.ref.current).toBeNull();
  });

  it("a press never consults anything but zoneAt: a leftover per-point callback on the registration is not called", () => {
    // A family that brings back a second answer beside the zone -- the drift
    // BUG-0258 was -- cannot be typed any more (the fields are gone from
    // OverlayRegistration); at runtime Core must not call one either.
    const leftover = vi.fn(() => true);
    registerGridOverlay({ type: TYPE, render: () => {}, ...{ claimsBodyDrag: leftover, getCursor: leftover } });
    setGridRegions([region()]);
    useSurface(surface(true));
    expect(pressAndDrag(CONTENT).events).toEqual(SELECTED_THEN_MOVE);
    const hit = handlers().h.checkOverlayBody(FRAME.x, FRAME.y);
    expect(hit?.cursor).toBe("move");
    expect(leftover).not.toHaveBeenCalled();
  });
});

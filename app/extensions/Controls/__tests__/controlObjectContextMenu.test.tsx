//! FILENAME: app/extensions/Controls/__tests__/controlObjectContextMenu.test.tsx
// PURPOSE: A right-click on an on-grid control must OPEN that control's menu,
//          and a right-click on an empty cell must still reach the grid's own.
// CONTEXT: Controls registered fifteen context-menu items with
//          `gridExtensions`, the registry only `GridContextMenuHost` renders —
//          and that host opens solely on `AppEvents.CONTEXT_MENU_REQUEST`, which
//          Core deliberately does NOT emit for a right-click that lands on a
//          floating object ("Cell options on an object right-click are always
//          wrong", Spreadsheet.tsx). Every one of those items was unreachable:
//          the user right-clicked a button, a shape or a picture and got
//          nothing at all.
//
//          The four things worth pinning are the four ways this breaks again:
//
//          1. the listener must be on the CAPTURE phase and must
//             `preventDefault()`, because that is what Core's own
//             `defaultPrevented` check reads before it opens the cell menu;
//          2. an empty cell must NOT be claimed — preventing default there
//             would kill the grid's cell menu instead, trading one dead menu
//             for another;
//          3. the offer must match the object: a button has no Flip and no
//             Edit Script. The model omits what does not apply rather than
//             greying it out, so "not offered" is a missing item, not a
//             disabled one;
//          4. the listener must come off on deactivate, or a reloaded extension
//             leaves a second one behind and two menus open on one click.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const showOverlay = vi.fn();
const registerOverlay = vi.fn();
const unregisterOverlay = vi.fn();

/** The regions the real floatingStore publishes; what `getGridRegions` returns. */
let publishedRegions: unknown[] = [];

vi.mock("@api", () => ({
  // Computed key: the lint rule wants camelCase property names, and this one
  // has to keep the exported spelling `AppEvents` to stand in for it.
  ["AppEvents"]: { GRID_REFRESH: "grid:refresh" },
  registerOverlay: (...args: unknown[]) => registerOverlay(...args),
  unregisterOverlay: (...args: unknown[]) => unregisterOverlay(...args),
  showOverlay: (...args: unknown[]) => showOverlay(...args),
  gridExtensions: {
    registerContextMenuItems: vi.fn(),
    unregisterContextMenuItem: vi.fn(),
  },
  getShapeBitmap: () => null,
  hasShapeBitmapRenderer: () => false,
}));

vi.mock("@api/events", () => ({
  emitAppEvent: vi.fn(),
  onAppEvent: vi.fn(() => () => {}),
}));

vi.mock("@api/gridOverlays", () => ({
  getGridRegions: () => publishedRegions,
  replaceGridRegionsByType: (_type: string, regions: unknown[]) => {
    publishedRegions = regions;
  },
  removeGridRegionsByType: () => {
    publishedRegions = [];
  },
  requestOverlayRedraw: vi.fn(),
}));

// A 50 px row-header gutter and a 24 px column-header gutter, no scroll, zoom 1:
// a control at sheet pixel (100, 50) therefore paints at canvas (150, 74).
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({
    config: { rowHeaderWidth: 50, colHeaderHeight: 24 },
    viewport: { scrollX: 0, scrollY: 0 },
    zoom: 1,
  }),
  rowHeaderGutter: (config: { rowHeaderWidth?: number }) => config.rowHeaderWidth ?? 50,
  colHeaderGutter: (config: { colHeaderHeight?: number }) => config.colHeaderHeight ?? 24,
}));

import { installControlObjectMenu, CONTROL_CONTEXT_MENU_ID } from "../lib/controlObjectMenu";
import { buildControlObjectMenu } from "../lib/controlContextMenu";
import { ControlContextMenu } from "../components/ControlContextMenu";
import {
  addFloatingControl,
  resetFloatingStore,
  syncFloatingControlRegions,
} from "../lib/floatingStore";
import {
  deselectFloatingControl,
  isFloatingControlSelected,
} from "../Button/floatingSelection";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const BUTTON_ID = "control-0-1-1";
const SHAPE_ID = "control-0-3-3";

/** Canvas point inside the button's painted rect (150..230, 74..98). */
const ON_BUTTON = { clientX: 160, clientY: 80 };
/** Canvas point on bare grid, well clear of every control. */
const ON_EMPTY_CELL = { clientX: 600, clientY: 400 };

let layer: HTMLDivElement;
let uninstall: (() => void) | null = null;

function placeControls(): void {
  addFloatingControl({
    id: BUTTON_ID,
    sheetIndex: 0,
    row: 1,
    col: 1,
    x: 100,
    y: 50,
    width: 80,
    height: 24,
    controlType: "button",
  });
  addFloatingControl({
    id: SHAPE_ID,
    sheetIndex: 0,
    row: 3,
    col: 3,
    x: 300,
    y: 200,
    width: 120,
    height: 60,
    controlType: "shape",
  });
  syncFloatingControlRegions();
}

/** Right-click at a client point, from a target inside the grid canvas layer. */
function rightClickOnGrid(at: { clientX: number; clientY: number }): MouseEvent {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    ...at,
  });
  layer.dispatchEvent(event);
  return event;
}

function itemIds(): string[] {
  const data = showOverlay.mock.calls[0]?.[1]?.data as
    | { items?: Array<{ id: string }> }
    | undefined;
  return (data?.items ?? []).map((i) => i.id);
}

beforeEach(() => {
  showOverlay.mockReset();
  registerOverlay.mockReset();
  unregisterOverlay.mockReset();
  publishedRegions = [];

  resetFloatingStore();
  deselectFloatingControl();

  layer = document.createElement("div");
  layer.setAttribute("data-grid-canvas-layer", "");
  document.body.appendChild(layer);

  placeControls();
  uninstall = installControlObjectMenu();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  layer.remove();
});

// ---------------------------------------------------------------------------
// The listener
// ---------------------------------------------------------------------------

describe("right-clicking an on-grid control opens the control's own menu", () => {
  it("opens the overlay for the control under the pointer and claims the event", () => {
    const event = rightClickOnGrid(ON_BUTTON);

    expect(showOverlay).toHaveBeenCalledTimes(1);
    expect(showOverlay.mock.calls[0][0]).toBe(CONTROL_CONTEXT_MENU_ID);
    expect(showOverlay.mock.calls[0][1].data.controlId).toBe(BUTTON_ID);

    // The claim Core reads: without it the grid's own handler runs on.
    expect(event.defaultPrevented).toBe(true);

    expect(itemIds()).toEqual(
      expect.arrayContaining([
        "controls.duplicate",
        "controls.copy",
        "controls.order",
        "controls.delete",
      ]),
    );
  });

  it("selects the control it opened for, because Delete acts on the selection", () => {
    rightClickOnGrid(ON_BUTTON);
    expect(isFloatingControlSelected(BUTTON_ID)).toBe(true);
  });

  it("resolves the control under the pointer, not merely the first one", () => {
    // The shape sits at sheet (300, 200) -> canvas (350, 224).
    rightClickOnGrid({ clientX: 360, clientY: 240 });
    expect(showOverlay.mock.calls[0][1].data.controlId).toBe(SHAPE_ID);
  });
});

describe("a right-click that is not on a control is left alone", () => {
  it("does not open the control menu on an empty cell, and does not claim the event", () => {
    const event = rightClickOnGrid(ON_EMPTY_CELL);

    expect(showOverlay).not.toHaveBeenCalled();
    // The NEGATIVE control that matters: Core opens its cell menu only while the
    // event is unclaimed, so preventing default here would kill the grid's menu.
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores a right-click outside the grid canvas layer at the same coordinates", () => {
    // A dialog or the properties pane: its client coordinates can map straight
    // into a control's rect, which would pop an object menu for a click that
    // never touched the grid.
    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);
    elsewhere.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...ON_BUTTON }),
    );
    expect(showOverlay).not.toHaveBeenCalled();
    elsewhere.remove();
  });

  it("leaves Shift+right-click to the browser's own menu", () => {
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      shiftKey: true,
      ...ON_BUTTON,
    });
    layer.dispatchEvent(event);
    expect(showOverlay).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("the listener comes off on deactivate", () => {
  it("is installed on the CAPTURE phase, and removed with the same flag", () => {
    // Capture is what lets the object menu claim the event before anything
    // nested in the grid acts on it — the Charts / Slicer / FloatingRange
    // pattern. It is asserted structurally because the pairing is the trap:
    // `removeEventListener` without the flag does not remove a capture
    // listener, and the leak only shows up as two menus on one click.
    uninstall?.();
    uninstall = null;

    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const off = installControlObjectMenu();
    off();

    const addCall = added.mock.calls.find((c) => c[0] === "contextmenu");
    const removeCall = removed.mock.calls.find((c) => c[0] === "contextmenu");
    expect(addCall?.[2]).toBe(true);
    expect(removeCall?.[2]).toBe(true);

    added.mockRestore();
    removed.mockRestore();
  });

  it("stops answering right-clicks and unregisters its overlay", () => {
    uninstall?.();
    uninstall = null;

    const event = rightClickOnGrid(ON_BUTTON);

    expect(showOverlay).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(unregisterOverlay).toHaveBeenCalledWith(CONTROL_CONTEXT_MENU_ID);
  });
});

// ---------------------------------------------------------------------------
// The offer
// ---------------------------------------------------------------------------

describe("the menu offers only what applies to the control", () => {
  it("does not offer a button Flip, Edit Script or Apply Template", () => {
    const ids = buildControlObjectMenu(BUTTON_ID).map((i) => i.id);
    expect(ids).not.toContain("controls.flipH");
    expect(ids).not.toContain("controls.flipV");
    expect(ids).not.toContain("controls.editScript");
    expect(ids).not.toContain("controls.applyTemplate");
  });

  it("offers all four to a shape", () => {
    const ids = buildControlObjectMenu(SHAPE_ID).map((i) => i.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "controls.flipH",
        "controls.flipV",
        "controls.editScript",
        "controls.applyTemplate",
      ]),
    );
  });

  it("offers no Paste while the control clipboard is empty", () => {
    expect(buildControlObjectMenu(BUTTON_ID).map((i) => i.id)).not.toContain(
      "controls.paste",
    );
  });

  it("offers no Group until a second control is selected", () => {
    expect(buildControlObjectMenu(BUTTON_ID).map((i) => i.id)).not.toContain(
      "controls.group",
    );
  });

  it("never leaves a separator under the last item", () => {
    const items = buildControlObjectMenu(SHAPE_ID);
    expect(items[items.length - 1].separatorAfter).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

describe("the menu paints exactly the items it was handed", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  function paint(controlId: string): void {
    act(() => {
      root.render(
        React.createElement(ControlContextMenu, {
          onClose: () => {},
          data: {
            controlId,
            screenX: 160,
            screenY: 80,
            items: buildControlObjectMenu(controlId),
          },
        }),
      );
    });
  }

  it("paints Delete for a button and no Flip Horizontal row", () => {
    paint(BUTTON_ID);
    expect(host.querySelector("[data-control-menu-item='controls.delete']")).not.toBeNull();
    expect(host.querySelector("[data-control-menu-item='controls.flipH']")).toBeNull();
  });

  it("paints Flip Horizontal for a shape", () => {
    paint(SHAPE_ID);
    expect(host.querySelector("[data-control-menu-item='controls.flipH']")).not.toBeNull();
  });
});

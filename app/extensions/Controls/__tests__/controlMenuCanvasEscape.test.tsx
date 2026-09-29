//! FILENAME: app/extensions/Controls/__tests__/controlMenuCanvasEscape.test.tsx
// PURPOSE: On a CANVAS, Escape with a floating control's right-click menu open
//          closes THE MENU -- the canvas's Escape binding does not take the key
//          to deselect the control behind it (BUG-0196, control part).
// CONTEXT: The canvas binding (CanvasSheet lib/objectCycling.ts) runs in the
//          dispatcher's window-CAPTURE listener and stops the key on a match;
//          the menu listens on `document` (capture), later on the same path,
//          so it never heard it: Escape deselected the control and left its
//          menu open. The binding asks the family first (`objectOwnsKey`), and
//          Controls now answers "mine" for Escape while its menu is open (the
//          Floating Range's worked example, FloatingRange/lib/frObjectSelection.ts).
//          Driven through the real dispatcher, the real canvas binding, the
//          real Controls selection provider and the real menu component.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ surface: "canvas" }),
}));

vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAppEvent: vi.fn(),
}));

import { initKeybindings } from "@api/keybindings";
import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import { resetObjectSelectionProviders } from "@api/objectSelection";
import { installCanvasObjectKeyboard } from "../../CanvasSheet/lib/objectCycling";
import { ControlContextMenu } from "../components/ControlContextMenu";
import { registerControlObjectSelection } from "../lib/controlObjectSelection";
import { isControlMenuOpen } from "../lib/controlMenuState";
import { addFloatingControl, getAllFloatingControls, removeFloatingControl } from "../lib/floatingStore";
import {
  deselectFloatingControl,
  isFloatingControlSelected,
  selectFloatingControl,
} from "../Button/floatingSelection";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// The shell's order: the dispatcher's window-capture listener first.
initKeybindings();

const CONTROL_ID = "control-0-2-2";
const REGION: GridRegion = {
  id: CONTROL_ID,
  type: "floating-control",
  startRow: 2,
  startCol: 2,
  endRow: 2,
  endCol: 2,
  floating: { x: 40, y: 40, width: 120, height: 60 },
  data: { sheetIndex: 0, row: 2, col: 2, controlType: "shape" },
};

let host: HTMLDivElement;
let root: Root;
let gridContainer: HTMLDivElement;
let onClose: ReturnType<typeof vi.fn>;
const cleanups: (() => void)[] = [];

async function openMenu(): Promise<void> {
  await act(async () => {
    root.render(
      <ControlContextMenu
        onClose={onClose as unknown as () => void}
        data={{
          controlId: CONTROL_ID,
          screenX: 10,
          screenY: 10,
          items: [{ id: "controls.delete", label: "Delete", run: () => {} }],
        }}
      />,
    );
  });
}

function escape(): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  gridContainer.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  resetObjectSelectionProviders();
  for (const c of getAllFloatingControls()) removeFloatingControl(c.id);
  deselectFloatingControl();
  addFloatingControl({
    id: CONTROL_ID,
    sheetIndex: 0,
    row: 2,
    col: 2,
    x: 40,
    y: 40,
    width: 120,
    height: 60,
    controlType: "shape",
  });
  setGridRegions([REGION]);
  cleanups.push(registerControlObjectSelection());
  cleanups.push(...installCanvasObjectKeyboard("calcula.canvas-sheet"));
  onClose = vi.fn();
  gridContainer = document.createElement("div");
  gridContainer.setAttribute("data-focus-container", "spreadsheet");
  gridContainer.tabIndex = 0;
  document.body.appendChild(gridContainer);
  gridContainer.focus();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // The right-click selected the control (controlObjectMenu.ts selectForMenu).
  selectFloatingControl(CONTROL_ID);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  gridContainer.remove();
  while (cleanups.length > 0) cleanups.pop()!();
  setGridRegions([]);
  deselectFloatingControl();
  for (const c of getAllFloatingControls()) removeFloatingControl(c.id);
});

describe("Escape on a canvas with a control's menu open", () => {
  it("closes the menu and keeps the control selected -- the canvas binding does not take the key", async () => {
    await openMenu();
    expect(isControlMenuOpen()).toBe(true);
    await act(async () => {
      escape();
    });
    expect(onClose, "the menu never heard Escape: the canvas binding stopped it first").toHaveBeenCalledTimes(1);
    expect(isFloatingControlSelected(CONTROL_ID), "Escape deselected the control behind the open menu").toBe(true);
  });

  it("the menu consumes the Escape it closes on (nothing behind it hears it)", async () => {
    await openMenu();
    let bubbled = false;
    const onBubble = (): void => {
      bubbled = true;
    };
    gridContainer.addEventListener("keydown", onBubble);
    try {
      await act(async () => {
        escape();
      });
    } finally {
      gridContainer.removeEventListener("keydown", onBubble);
    }
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(bubbled, "the grid container still heard the menu's Escape").toBe(false);
  });

  it("control: with no menu open, Escape on the canvas deselects the control (the binding applies)", () => {
    expect(isControlMenuOpen()).toBe(false);
    const e = escape();
    expect(isFloatingControlSelected(CONTROL_ID)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
  });

  it("control: once the menu has closed, the next Escape is the canvas's again", async () => {
    await openMenu();
    await act(async () => root.render(<></>));
    expect(isControlMenuOpen()).toBe(false);
    escape();
    expect(isFloatingControlSelected(CONTROL_ID)).toBe(false);
  });
});

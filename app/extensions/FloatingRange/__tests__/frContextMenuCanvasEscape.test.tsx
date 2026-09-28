//! FILENAME: app/extensions/FloatingRange/__tests__/frContextMenuCanvasEscape.test.tsx
// PURPOSE: On a CANVAS, Escape with a floating grid's right-click menu open
//          closes THE MENU first -- the canvas's Escape binding does not take
//          the key to clear the object selection behind it.
// CONTEXT: Fix round 4, F5 (suspected in round 3, reproduced here). The canvas
//          binding (CanvasSheet lib/objectCycling.ts, "Escape clears the
//          selection set") is a keybinding: it runs in the dispatcher's
//          window-CAPTURE listener, which is installed at bootstrap and so runs
//          before everything else, and on a match it stops propagation. The
//          menu's Escape listener sits on `document` (capture) -- LATER on the
//          same path -- so it never heard the key: Escape deselected the range
//          and left its menu open, showing actions for an object that was no
//          longer selected. The binding already asks the object's family
//          whether it owns Escape (`objectOwnsKey`, @api/objectSelection); the
//          range answered only for its inner CELL selection. It now answers
//          for its open menu too.
//          Driven through the real dispatcher, the real canvas binding, the
//          real FR selection provider and the real menu component.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FloatingRangeInfo } from "@api/floatingRanges";

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ surface: "canvas" }),
}));

import { initKeybindings } from "@api/keybindings";
import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import { resetObjectSelectionProviders } from "@api/objectSelection";
import { installCanvasObjectKeyboard } from "../../CanvasSheet/lib/objectCycling";
import { FloatingRangeContextMenu, isFrContextMenuOpen } from "../components/FloatingRangeContextMenu";
import { registerFloatingRangeObjectSelection } from "../lib/frObjectSelection";
import { FLOATING_RANGE_REGION_TYPE, resetFloatingRangeStore, upsertFromInfo } from "../lib/floatingRangeStore";
import {
  clearLocalSelection,
  getLocalSelection,
  isFloatingRangeSelected,
  resetFrSelection,
  selectFloatingRange,
  setLocalSelection,
} from "../lib/frSelection";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// The shell's order: the dispatcher's window-capture listener first.
initKeybindings();

const FR_ID = "fr-canvas-menu";
const INFO = {
  id: FR_ID,
  backingSheetId: "backing",
  hostSheetId: "host",
  x: 100,
  y: 100,
  rotation: 0,
  pinToGrid: false,
  rowCount: 4,
  colCount: 3,
  colWidths: {},
  rowHeights: {},
  showTitle: true,
  showColumnHeaders: true,
  showRowHeaders: true,
  name: "Float1",
  backingSheetIndex: 3,
  hostSheetIndex: 0,
} as FloatingRangeInfo;
const REGION: GridRegion = {
  id: `fr-${FR_ID}`,
  type: FLOATING_RANGE_REGION_TYPE,
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 100, y: 100, width: 300, height: 200 },
  data: { frId: FR_ID },
};

let host: HTMLDivElement;
let root: Root;
let gridContainer: HTMLDivElement;
let onClose: ReturnType<typeof vi.fn>;
const cleanups: (() => void)[] = [];

async function openMenu(): Promise<void> {
  await act(async () => {
    root.render(
      <FloatingRangeContextMenu
        onClose={onClose as unknown as () => void}
        data={{
          frId: FR_ID,
          screenX: 10,
          screenY: 10,
          items: [{ id: "properties", label: "Properties...", enabled: true, run: () => {} }],
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
  resetFloatingRangeStore();
  resetFrSelection();
  upsertFromInfo(INFO);
  setGridRegions([REGION]);
  cleanups.push(registerFloatingRangeObjectSelection());
  cleanups.push(...installCanvasObjectKeyboard("calcula.canvas-sheet"));
  onClose = vi.fn();
  // The right-press leaves the keyboard on the grid's container.
  gridContainer = document.createElement("div");
  gridContainer.setAttribute("data-focus-container", "spreadsheet");
  gridContainer.tabIndex = 0;
  document.body.appendChild(gridContainer);
  gridContainer.focus();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // A right-click on the range's frame selects the OBJECT (no inner cell).
  selectFloatingRange(FR_ID);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  gridContainer.remove();
  while (cleanups.length > 0) cleanups.pop()!();
  setGridRegions([]);
  clearLocalSelection();
  resetFrSelection();
  resetFloatingRangeStore();
});

describe("Escape on a canvas with the floating range's menu open", () => {
  it("closes the menu and keeps the range selected -- the canvas binding does not take the key", async () => {
    await openMenu();
    expect(isFrContextMenuOpen()).toBe(true);
    await act(async () => {
      escape();
    });
    expect(onClose, "the menu never heard Escape: the canvas binding stopped it first").toHaveBeenCalledTimes(1);
    expect(isFloatingRangeSelected(FR_ID), "Escape cleared the selection behind the open menu").toBe(true);
  });

  it("with an inner cell selected too, the menu still closes and the cell selection stays", async () => {
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
    await openMenu();
    await act(async () => {
      escape();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(getLocalSelection()).not.toBeNull();
    expect(isFloatingRangeSelected(FR_ID)).toBe(true);
  });

  it("control: with the menu closed, Escape on the canvas clears the selection (the binding applies)", async () => {
    expect(isFrContextMenuOpen()).toBe(false);
    const e = escape();
    expect(isFloatingRangeSelected(FR_ID)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
  });

  it("control: once the menu has closed, the next Escape is the canvas's again", async () => {
    await openMenu();
    await act(async () => root.render(<></>));
    expect(isFrContextMenuOpen()).toBe(false);
    escape();
    expect(isFloatingRangeSelected(FR_ID)).toBe(false);
  });
});

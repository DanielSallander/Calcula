//! FILENAME: app/extensions/FloatingRange/__tests__/frContextMenuEscape.test.tsx
// PURPOSE: Escape pressed while the floating range's right-click menu is open
//          closes THE MENU and nothing else.
// CONTEXT: Round-2 ledger item (2026-09-27). With an edit live and the grid's
//          container holding the keyboard -- a right-press on the range during
//          a formula-bar edit leaves it there -- the menu's Escape listener
//          closed the menu but let the key go on to the container, whose
//          fallback door for a live session CANCELLED THE WHOLE EDIT. And with
//          no edit, the range's own window-capture keyboard dropped its cell
//          selection on the same key.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FloatingRangeInfo } from "@api/floatingRanges";
import { FloatingRangeContextMenu, isFrContextMenuOpen } from "../components/FloatingRangeContextMenu";
import { upsertFromInfo, resetFloatingRangeStore } from "../lib/floatingRangeStore";
import { getLocalSelection, setLocalSelection, clearLocalSelection } from "../lib/frSelection";
import { handleFrKeyDown } from "../index";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const FR_ID = "fr-menu";
const INFO = {
  id: FR_ID,
  backingSheetId: "backing",
  hostSheetId: "host",
  x: 0,
  y: 0,
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

let host: HTMLDivElement;
let root: Root;
let gridContainer: HTMLDivElement;
let containerKeys: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;

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

beforeEach(() => {
  resetFloatingRangeStore();
  upsertFromInfo(INFO);
  onClose = vi.fn();
  // The grid's keyboard container, focused, with its own key handler (the
  // fallback door that cancels a live session on Escape).
  gridContainer = document.createElement("div");
  gridContainer.setAttribute("data-focus-container", "spreadsheet");
  gridContainer.tabIndex = 0;
  containerKeys = vi.fn();
  gridContainer.addEventListener("keydown", containerKeys as unknown as EventListener);
  document.body.appendChild(gridContainer);
  gridContainer.focus();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  gridContainer.remove();
  clearLocalSelection();
  resetFloatingRangeStore();
});

describe("Escape with the floating range's menu open", () => {
  it("closes the menu, and the focused grid container never hears the key", async () => {
    await openMenu();
    expect(isFrContextMenuOpen()).toBe(true);
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => {
      gridContainer.dispatchEvent(e);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(containerKeys, "the container's door heard Escape: a live edit would be cancelled").not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("with no edit, the range's own keyboard keeps its cell selection (the menu owns Escape)", async () => {
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
    await openMenu();
    handleFrKeyDown(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(getLocalSelection()).not.toBeNull();
  });

  it("control: with the menu closed, Escape reaches the container, and the range's keyboard drops its cell selection", async () => {
    expect(isFrContextMenuOpen()).toBe(false);
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    gridContainer.dispatchEvent(e);
    expect(containerKeys).toHaveBeenCalledTimes(1);
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
    handleFrKeyDown(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(getLocalSelection()).toBeNull();
  });

  it("closing the menu frees Escape again", async () => {
    await openMenu();
    await act(async () => root.render(<></>));
    expect(isFrContextMenuOpen()).toBe(false);
  });
});

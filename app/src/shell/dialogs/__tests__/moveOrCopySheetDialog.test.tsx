//! FILENAME: app/src/shell/dialogs/__tests__/moveOrCopySheetDialog.test.tsx
// PURPOSE: Excel's Move or Copy dialog (Home > Format > Move or Copy Sheet...,
//          and the tab menu's "Move or Copy..."): a "Before sheet" list ending
//          in "(move to end)", a "Create a copy" box, OK / Cancel. The dialog
//          only ANSWERS -- { beforeIndex, copy } -- and the sheet tab strip
//          does the moving (sheetPlacement.ts has the arithmetic).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  MoveOrCopySheetDialog,
  type MoveOrCopySheetData,
} from "../MoveOrCopySheetDialog";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;
const onResult = vi.fn();
const onClose = vi.fn();

function render(overrides: Partial<MoveOrCopySheetData> = {}): void {
  const data: MoveOrCopySheetData = {
    sourceIndex: 1,
    sourceName: "Data",
    sheets: [
      { index: 0, name: "Sheet1" },
      { index: 1, name: "Data" },
      { index: 3, name: "Totals" },
    ],
    canCopy: true,
    onResult,
    ...overrides,
  };
  act(() => {
    root.render(
      <MoveOrCopySheetDialog
        isOpen
        onClose={onClose}
        data={data as unknown as Record<string, unknown>}
      />,
    );
  });
}

function byTestId(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no [data-testid="${id}"]`);
  return el;
}

function click(el: HTMLElement): void {
  act(() => {
    el.click();
  });
}

function key(el: HTMLElement, k: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

function selected(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"][aria-selected="true"]')).map(
    (el) => el.textContent ?? "",
  );
}

beforeEach(() => {
  onResult.mockReset();
  onClose.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Move or Copy", () => {
  it("lists the sheets in tab order, then (move to end), with the source sheet selected", () => {
    render();
    const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map((o) => o.textContent);
    expect(options).toEqual(["Sheet1", "Data", "Totals", "(move to end)"]);
    expect(selected()).toEqual(["Data"]);
    expect(byTestId("move-or-copy-sheet-dialog").textContent).toContain("Before sheet:");
    expect(byTestId("move-or-copy-sheet-dialog").getAttribute("role")).toBe("dialog");
  });

  it("OK answers the chosen sheet's TRUE index and the copy box", () => {
    render();
    click(byTestId("move-or-copy-before-3"));
    click(byTestId("move-or-copy-create-copy"));
    click(byTestId("move-or-copy-ok"));
    expect(onResult).toHaveBeenCalledWith({ beforeIndex: 3, copy: true });
    expect(onClose).toHaveBeenCalled();
  });

  it("(move to end) answers beforeIndex null", () => {
    render();
    click(byTestId("move-or-copy-before-end"));
    click(byTestId("move-or-copy-ok"));
    expect(onResult).toHaveBeenCalledWith({ beforeIndex: null, copy: false });
  });

  it("Cancel and Escape answer nothing", () => {
    render();
    click(byTestId("move-or-copy-cancel"));
    expect(onResult).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    render();
    key(byTestId("move-or-copy-before-list"), "Escape");
    expect(onResult).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("the arrow keys walk the list and Enter is OK", () => {
    render();
    const list = byTestId("move-or-copy-before-list");
    key(list, "ArrowDown");
    expect(selected()).toEqual(["Totals"]);
    key(list, "ArrowDown");
    expect(selected()).toEqual(["(move to end)"]);
    key(list, "ArrowDown"); // stays on the last row
    expect(selected()).toEqual(["(move to end)"]);
    key(list, "ArrowUp");
    key(list, "Home");
    expect(selected()).toEqual(["Sheet1"]);
    key(list, "Enter");
    expect(onResult).toHaveBeenCalledWith({ beforeIndex: 0, copy: false });
  });

  it("a double-click chooses and confirms", () => {
    render();
    act(() => {
      byTestId("move-or-copy-before-0").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onResult).toHaveBeenCalledWith({ beforeIndex: 0, copy: false });
  });

  it("a sheet that cannot be copied (a canvas) offers move only", () => {
    render({ canCopy: false });
    const box = byTestId("move-or-copy-create-copy") as HTMLInputElement;
    expect(box.disabled).toBe(true);
    click(box);
    click(byTestId("move-or-copy-ok"));
    expect(onResult).toHaveBeenCalledWith({ beforeIndex: 1, copy: false });
  });

  it("names the sheet it moves (Excel says 'Move selected sheets')", () => {
    render();
    expect(byTestId("move-or-copy-source").textContent).toBe("Move selected sheet: Data");
  });

  it("Enter on the focused Cancel button stays Cancel", () => {
    render();
    key(byTestId("move-or-copy-cancel"), "Enter");
    expect(onResult).not.toHaveBeenCalled();
  });
});

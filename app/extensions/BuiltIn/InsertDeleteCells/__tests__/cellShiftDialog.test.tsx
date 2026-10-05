//! FILENAME: app/extensions/BuiltIn/InsertDeleteCells/__tests__/cellShiftDialog.test.tsx
// PURPOSE: Excel's Insert and Delete dialogs: the four choices in Excel's words
//          and order, the preselection the opener asks for, OK hands back the
//          choice AFTER closing, Cancel / Escape hand back nothing.

import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CellShiftDialog } from "../components/CellShiftDialog";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function render(data: Record<string, unknown>) {
  const onClose = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<CellShiftDialog isOpen onClose={onClose} data={data} />);
  });
  return { onClose };
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

const radios = () =>
  Array.from(document.querySelectorAll<HTMLInputElement>("input[type=radio]")).map((r) => ({
    value: r.value,
    label: r.parentElement?.textContent ?? "",
    checked: r.checked,
  }));

describe("CellShiftDialog", () => {
  it("Insert offers Excel's four choices in Excel's order, the opener's choice selected", () => {
    render({ mode: "insert", initial: "down", onChoose: () => {} });
    expect(document.querySelector("[data-testid=insert-cells-dialog]")).not.toBeNull();
    expect(document.getElementById("cell-shift-dialog-title")?.textContent).toBe("Insert");
    expect(radios()).toEqual([
      { value: "right", label: "Shift cells right", checked: false },
      { value: "down", label: "Shift cells down", checked: true },
      { value: "entireRow", label: "Entire row", checked: false },
      { value: "entireColumn", label: "Entire column", checked: false },
    ]);
  });

  it("Delete offers left / up / entire row / entire column", () => {
    render({ mode: "delete", initial: "left", onChoose: () => {} });
    expect(document.getElementById("cell-shift-dialog-title")?.textContent).toBe("Delete");
    expect(radios().map((r) => r.label)).toEqual(["Shift cells left", "Shift cells up", "Entire row", "Entire column"]);
    expect(radios()[0].checked).toBe(true);
  });

  it("OK closes first, then hands back the chosen option", () => {
    const order: string[] = [];
    const onChoose = vi.fn((choice: string) => order.push(`choose:${choice}`));
    const { onClose } = render({ mode: "insert", initial: "right", onChoose });
    onClose.mockImplementation(() => order.push("close"));
    act(() => {
      (document.querySelector("[data-testid=cell-shift-option-entireRow]") as HTMLInputElement).click();
    });
    act(() => {
      (document.querySelector("[data-testid=cell-shift-ok]") as HTMLButtonElement).click();
    });
    expect(order).toEqual(["close", "choose:entireRow"]);
  });

  it("Cancel and Escape close without a choice; Enter is OK", () => {
    const onChoose = vi.fn();
    const { onClose } = render({ mode: "delete", initial: "up", onChoose });
    act(() => {
      (document.querySelector("[data-testid=cell-shift-cancel]") as HTMLButtonElement).click();
    });
    const dialog = document.querySelector("[data-testid=delete-cells-dialog]") as HTMLElement;
    act(() => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onChoose).not.toHaveBeenCalled();
    act(() => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onChoose).toHaveBeenCalledWith("up");
  });

  it("renders nothing without a mode or a callback", () => {
    render({ mode: "sideways" });
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });
});

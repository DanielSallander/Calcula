//! FILENAME: app/extensions/BuiltIn/StandardMenus/__tests__/formatMenuSelectionOwner.test.tsx
// PURPOSE: Format > Cell Styles refuses -- one toast, nothing written -- while
//          a selection owner holds the selection, and styles Core's selection
//          when nothing does.
// CONTEXT: BUG-0185. The gallery applied the picked style to Core's selection,
//          a cell HIDDEN under a floating grid while that grid's cell is
//          selected. (The menu's Format Cells item runs the FORMAT_CELLS
//          command, refused by the command itself.) TEST owner.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  applyFormatting: vi.fn(),
  menu: null as null | { items: { id: string; customContent?: (close: () => void) => React.ReactElement }[] },
  onApplyStyle: null as null | ((formatting: Record<string, unknown>) => Promise<void>),
}));

vi.mock("@api/ui", () => ({
  registerMenu: (menu: typeof h.menu) => {
    h.menu = menu;
  },
}));
vi.mock("@api/lib", () => ({ applyFormatting: (...a: unknown[]) => h.applyFormatting(...a) }));
vi.mock("@api", () => ({
  cellEvents: { emit: vi.fn() },
  useGridState: () => ({ selection: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 } }),
  IconFormatCells: null,
  IconCellStyles: null,
}));
vi.mock("../../../_shared/components/CellStylesGallery", () => ({
  CellStylesGallery: (props: { onApplyStyle: typeof h.onApplyStyle }) => {
    h.onApplyStyle = props.onApplyStyle;
    return null;
  },
}));

import { registerFormatMenu } from "../FormatMenu";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

let container: HTMLDivElement;
let root: Root;
const toasts: ToastPayload[] = [];
let release: (() => void) | null = null;

async function openCellStyles(): Promise<void> {
  registerFormatMenu();
  const item = h.menu!.items.find((i) => i.id === "format:cellStyles")!;
  await act(async () => {
    root.render(item.customContent!(() => {}));
  });
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.applyFormatting.mockReset();
  h.applyFormatting.mockResolvedValue({ cells: [] });
  h.onApplyStyle = null;
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  release?.();
  release = null;
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("Format > Cell Styles", () => {
  it("while a selection owner holds the selection: writes nothing, one toast", async () => {
    release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => true });
    await openCellStyles();
    await act(async () => {
      await h.onApplyStyle!({ bold: true });
    });
    expect(h.applyFormatting, "a cell style landed on Core's hidden selection").not.toHaveBeenCalled();
    expect(toasts.length).toBe(1);
  });

  it("positive control: nothing owns the selection -> the style is applied to it", async () => {
    await openCellStyles();
    await act(async () => {
      await h.onApplyStyle!({ bold: true });
    });
    expect(h.applyFormatting).toHaveBeenCalledWith([0, 1], [0, 1], { bold: true }, { target: undefined });
    expect(toasts).toEqual([]);
  });

  // P3 S9 (owner finding G3): a floating grid that admits "format" gets the
  // style on ITS cells, through its target.
  const REF = { kind: "floatingRange" as const, id: "fr-4" };
  const floatingGrid = (actsOn?: readonly ("format" | "read")[]): (() => void) =>
    registerSelectionOwner({
      id: "floatingRange",
      label: "a floating grid's cells",
      ownsSelection: () => true,
      cellTarget: () => ({
        ref: REF,
        selection: { startRow: 2, startCol: 3, endRow: 4, endCol: 3, activeRow: 2, activeCol: 3, type: "cells" },
        bounds: { rows: 10, cols: 6 },
        label: "Float1",
        wholeObject: false,
      }),
      ...(actsOn ? { actsOn } : {}),
    });

  it("a floating grid that admits the act: the style lands on ITS cells with { target }, never Core's", async () => {
    release = floatingGrid(["format"]);
    await openCellStyles();
    await act(async () => {
      await h.onApplyStyle!({ bold: true });
    });
    expect(h.applyFormatting.mock.calls).toEqual([[[2, 3, 4], [3], { bold: true }, { target: REF }]]);
    expect(toasts).toEqual([]);
  });

  it("inert until S8: a floating grid that admits nothing refuses, once", async () => {
    release = floatingGrid(undefined);
    await openCellStyles();
    await act(async () => {
      await h.onApplyStyle!({ bold: true });
    });
    expect(h.applyFormatting).not.toHaveBeenCalled();
    expect(toasts.length).toBe(1);
  });
});

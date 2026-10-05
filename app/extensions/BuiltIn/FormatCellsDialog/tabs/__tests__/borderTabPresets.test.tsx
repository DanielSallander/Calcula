//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/tabs/__tests__/borderTabPresets.test.tsx
// PURPOSE: The Border tab's presets and edge buttons on a RANGE, as Excel's:
//            - Outline is the range's OUTSIDE border. It used to set all four
//              sides of every cell, which on a range is All Borders (survey D5);
//            - Inside draws the lines between the rows and columns, and is
//              offered only when there is an inside (Excel greys it for one
//              cell);
//            - None clears every border of the range, inside lines included.
//          The tab edits the store; what OK then writes is the plan, so each
//          case below ends by asking the plan.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../components/ColorPicker", () => ({ ColorPicker: () => null }));

import { BorderTab } from "../BorderTab";
import { useFormatCellsStore, snapshotOf } from "../../hooks/useFormatCellsState";
import { planFormatCellsWrites } from "../../lib/formatCellsWrites";

const RANGE = { startRow: 0, startCol: 0, endRow: 2, endCol: 2 };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  useFormatCellsStore.getState().reset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(shape: { multiRow: boolean; multiCol: boolean }): Promise<void> {
  useFormatCellsStore.getState().setRangeShape(shape);
  useFormatCellsStore.getState().markBaseline();
  await act(async () => {
    root.render(React.createElement(BorderTab));
  });
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = container.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no element ${id}`);
  return el;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function planNow() {
  const s = useFormatCellsStore.getState();
  return planFormatCellsWrites(s.baseline, snapshotOf(s), RANGE, s.borderClearAll).calls;
}

describe("Border tab on a range", () => {
  it("Outline is an OUTSIDE border, not All Borders", async () => {
    await render({ multiRow: true, multiCol: true });
    await click(byTestId("fc-border-preset-outline"));
    expect(planNow()).toEqual([{ kind: "preset", preset: "outside", style: "solid", color: "#000000", width: 1 }]);
  });

  it("Inside draws the lines between rows and columns", async () => {
    await render({ multiRow: true, multiCol: true });
    await click(byTestId("fc-border-preset-inside"));
    expect(planNow()).toEqual([
      { kind: "preset", preset: "insideHorizontal", style: "solid", color: "#000000", width: 1 },
      { kind: "preset", preset: "insideVertical", style: "solid", color: "#000000", width: 1 },
    ]);
  });

  it("None clears the whole range", async () => {
    await render({ multiRow: true, multiCol: true });
    await click(byTestId("fc-border-preset-outline"));
    await click(byTestId("fc-border-preset-none"));
    expect(useFormatCellsStore.getState().borderClearAll).toBe(true);
    expect(planNow()).toEqual([{ kind: "preset", preset: "none", style: "solid", color: "#000000", width: 0 }]);
  });

  it("the inside-line buttons exist for a range, and toggle with the chosen line", async () => {
    await render({ multiRow: true, multiCol: false });
    await click(byTestId("fc-border-insideHorizontal"));
    expect(useFormatCellsStore.getState().borderInsideHorizontal.style).toBe("thin");
    expect(byTestId<HTMLButtonElement>("fc-border-insideVertical").disabled).toBe(true);
  });
});

describe("Border tab on one cell", () => {
  it("Inside and the inside-line buttons are disabled (there is no inside)", async () => {
    await render({ multiRow: false, multiCol: false });
    expect(byTestId<HTMLButtonElement>("fc-border-preset-inside").disabled).toBe(true);
    expect(byTestId<HTMLButtonElement>("fc-border-insideHorizontal").disabled).toBe(true);
    expect(byTestId<HTMLButtonElement>("fc-border-insideVertical").disabled).toBe(true);
  });

  it("Top toggles that edge", async () => {
    await render({ multiRow: false, multiCol: false });
    await click(byTestId("fc-border-top"));
    expect(useFormatCellsStore.getState().borderTop.style).toBe("thin");
    await click(byTestId("fc-border-top"));
    expect(useFormatCellsStore.getState().borderTop.style).toBe("none");
  });
});

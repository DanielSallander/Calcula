//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/mergeSplitButton.test.tsx
// PURPOSE: Excel's Merge & Center split button on the Home tab: its two halves,
//          its menu (Excel's four rows, in Excel's order), the pressed state
//          that follows ANY merge in the selection, the disabled states and
//          their reasons, and the commands each part runs.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module double below stands in for RibbonIcon, whose real name is
 * PascalCase. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@api", async () => {
  const icons = await import("@api/ribbonIcons");
  return { RibbonIcon: icons.RibbonIcon };
});

/** The grid state the button reads; tests change it and re-render. */
const grid = vi.hoisted(() => ({
  state: {
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 2, type: "cells" } as Record<string, unknown> | null,
    editing: null as unknown,
  },
}));
vi.mock("@api/grid", () => ({ useGridState: () => grid.state }));

const lib = vi.hoisted(() => ({
  readSelectionMergeState: vi.fn(),
  isSheetProtected: vi.fn(),
}));
vi.mock("@api/lib", () => lib);

import { SurfaceLayoutProvider, bandLayout, TOOLTIP_DELAY_MS } from "@api/layout";
import { setGridRegions } from "@api/gridOverlays";
import { initKeybindings } from "@api/keybindings";
import { CoreCommands } from "@api/commands";
import { ITEMS_BY_ID } from "../homeTabConfig";
import { MergeSplitButton, MERGE_UNAVAILABLE, selectionTouchesTable } from "../components/MergeSplitButton";
import { MERGE_MENU_COMMAND_IDS } from "../components/useHomeTabState";

let container: HTMLDivElement;
let root: Root;
const onRun = vi.fn();
const onCommand = vi.fn();

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initKeybindings();
});

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onRun.mockReset();
  onCommand.mockReset();
  lib.readSelectionMergeState.mockReset().mockResolvedValue({ touchesMerge: false });
  lib.isSheetProtected.mockReset().mockResolvedValue(false);
  grid.state = {
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 2, type: "cells" },
    editing: null,
  };
  setGridRegions([]);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  document.body.innerHTML = "";
  setGridRegions([]);
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <SurfaceLayoutProvider value={bandLayout(1200)}>
        <MergeSplitButton item={ITEMS_BY_ID.get("mergeCells")!} onRun={onRun} onCommand={onCommand} />
      </SurfaceLayoutProvider>,
    );
  });
}

function byTestId(id: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`[data-testid='${id}']`);
  if (!el) throw new Error(`no ${id}`);
  return el;
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function key(el: Element, k: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

function rows(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[role='menu'] button"));
}

describe("the control", () => {
  it("is Excel's split button: two named halves, no native title, Merge & Center on its face", async () => {
    await render();
    const main = byTestId("fmt-mergeCells");
    const chevron = byTestId("fmt-mergeCells-options");
    expect(main.getAttribute("aria-label")).toBe("Merge & Center");
    expect(chevron.getAttribute("aria-label")).toBe("Merge options");
    expect(chevron.getAttribute("aria-haspopup")).toBe("menu");
    expect(main.hasAttribute("title")).toBe(false);
    expect(chevron.hasAttribute("title")).toBe(false);
    expect(main.querySelector("svg")).not.toBeNull();
  });

  it("the icon half runs Merge & Center (the item), not the menu", async () => {
    await render();
    click(byTestId("fmt-mergeCells"));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onCommand).not.toHaveBeenCalled();
    expect(document.querySelector("[role='menu']")).toBeNull();
  });

  it("the menu is Excel's four rows, in Excel's order, each with its icon", async () => {
    await render();
    click(byTestId("fmt-mergeCells-options"));
    expect(rows().map((r) => r.querySelector("[data-menu-label]")?.textContent)).toEqual([
      "Merge & Center",
      "Merge Across",
      "Merge Cells",
      "Unmerge Cells",
    ]);
    expect(rows().map((r) => r.getAttribute("data-testid"))).toEqual([
      "fmt-merge-center",
      "fmt-merge-across",
      "fmt-merge-cells",
      "fmt-merge-unmerge",
    ]);
    for (const r of rows()) expect(r.querySelector("svg")).not.toBeNull();
    expect(byTestId("fmt-merge-center").getAttribute("role")).toBe("menuitemcheckbox");
    // Ctrl+M (Merge Cells) is discoverable on its row.
    expect(byTestId("fmt-merge-cells").querySelector("kbd")?.textContent).toBe("Ctrl+M");
  });

  it("each row runs its own command", async () => {
    await render();
    for (const [testId, command] of [
      ["fmt-merge-center", "mergeCenter"],
      ["fmt-merge-across", "mergeAcross"],
      ["fmt-merge-cells", "mergeCells"],
      ["fmt-merge-unmerge", "unmergeCells"],
    ] as const) {
      click(byTestId("fmt-mergeCells-options"));
      click(byTestId(testId));
      expect(onCommand).toHaveBeenLastCalledWith(command);
      expect(document.querySelector("[role='menu']")).toBeNull();
    }
    expect(MERGE_MENU_COMMAND_IDS).toEqual({
      mergeCenter: CoreCommands.MERGE_CENTER,
      mergeAcross: CoreCommands.MERGE_ACROSS,
      mergeCells: CoreCommands.MERGE_CELLS,
      unmergeCells: CoreCommands.UNMERGE_CELLS,
    });
  });

  it("the keyboard: ArrowDown on the icon half opens the menu, Enter runs a row", async () => {
    await render();
    key(byTestId("fmt-mergeCells"), "ArrowDown");
    expect(document.activeElement).toBe(byTestId("fmt-merge-center"));
    key(byTestId("fmt-merge-center"), "ArrowDown");
    key(byTestId("fmt-merge-across"), "ArrowDown");
    key(byTestId("fmt-merge-cells"), "ArrowDown");
    key(byTestId("fmt-merge-unmerge"), "Enter");
    expect(onCommand).toHaveBeenCalledWith("unmergeCells");
    expect(document.activeElement).toBe(byTestId("fmt-mergeCells"));
  });
});

describe("pressed: any merge in the selection", () => {
  it("follows the merge state, and re-reads after the document changes", async () => {
    await render();
    expect(byTestId("fmt-mergeCells").getAttribute("aria-pressed")).toBe("false");
    expect(byTestId("fmt-mergeCells").hasAttribute("data-active")).toBe(false);

    lib.readSelectionMergeState.mockResolvedValue({ touchesMerge: true });
    vi.useFakeTimers();
    act(() => {
      window.dispatchEvent(new CustomEvent("grid:refresh"));
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    vi.useRealTimers();
    await act(async () => {});
    expect(byTestId("fmt-mergeCells").getAttribute("aria-pressed")).toBe("true");
    expect(byTestId("fmt-mergeCells").getAttribute("data-active")).toBe("true");

    click(byTestId("fmt-mergeCells-options"));
    expect(byTestId("fmt-merge-center").getAttribute("aria-checked")).toBe("true");
  });

  it("re-reads after an undo or redo, which announces only MUTATION_REFRESH", async () => {
    // Ctrl+Z of a merge over empty cells records no cell change, so the undo
    // re-selects nothing and dispatches no grid:refresh: the ONE thing it
    // announces is MUTATION_REFRESH ("app:mutation-refresh"). Without listening
    // to it the button stayed PRESSED over a merge the undo had just removed.
    lib.readSelectionMergeState.mockResolvedValue({ touchesMerge: true });
    await render();
    expect(byTestId("fmt-mergeCells").getAttribute("aria-pressed")).toBe("true");

    lib.readSelectionMergeState.mockResolvedValue({ touchesMerge: false });
    vi.useFakeTimers();
    act(() => {
      window.dispatchEvent(new CustomEvent("app:mutation-refresh", { detail: { domains: ["styles"], source: "undo" } }));
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    vi.useRealTimers();
    await act(async () => {});
    expect(byTestId("fmt-mergeCells").getAttribute("aria-pressed")).toBe("false");
  });

  it("asks about the CURRENT selection", async () => {
    await render();
    expect(lib.readSelectionMergeState).toHaveBeenLastCalledWith(grid.state.selection);
  });

  it("a failed read draws it at rest rather than throwing", async () => {
    lib.readSelectionMergeState.mockRejectedValue(new Error("ipc down"));
    await render();
    expect(byTestId("fmt-mergeCells").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("disabled, with the reason as its tooltip", () => {
  async function tooltipText(): Promise<string | null | undefined> {
    vi.useFakeTimers();
    act(() => {
      byTestId("fmt-mergeCells").dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 50);
    });
    vi.useRealTimers();
    return document.querySelector("[role='tooltip']")?.textContent;
  }

  it("on a protected sheet", async () => {
    lib.isSheetProtected.mockResolvedValue(true);
    await render();
    expect(byTestId("fmt-mergeCells").getAttribute("aria-disabled")).toBe("true");
    expect(byTestId("fmt-mergeCells-options").getAttribute("aria-disabled")).toBe("true");
    expect(await tooltipText()).toContain(MERGE_UNAVAILABLE.protectedSheet);
  });

  it("re-reads protection when Protect Sheet announces it", async () => {
    await render();
    expect(byTestId("fmt-mergeCells").hasAttribute("aria-disabled")).toBe(false);
    lib.isSheetProtected.mockResolvedValue(true);
    vi.useFakeTimers();
    act(() => {
      window.dispatchEvent(new CustomEvent("protection:refresh"));
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    vi.useRealTimers();
    await act(async () => {});
    expect(byTestId("fmt-mergeCells").getAttribute("aria-disabled")).toBe("true");
  });

  it("while a cell is being edited", async () => {
    grid.state = { ...grid.state, editing: { row: 0, col: 0, value: "x" } };
    await render();
    expect(byTestId("fmt-mergeCells").getAttribute("aria-disabled")).toBe("true");
    expect(await tooltipText()).toContain(MERGE_UNAVAILABLE.editing);
  });

  it("when the selection touches a table, even half of one", async () => {
    setGridRegions([{ id: "table-1", type: "table", startRow: 0, startCol: 2, endRow: 5, endCol: 4 }]);
    await render();
    expect(byTestId("fmt-mergeCells").getAttribute("aria-disabled")).toBe("true");
    expect(await tooltipText()).toContain(MERGE_UNAVAILABLE.table);
  });

  it("enabled otherwise (positive control)", async () => {
    setGridRegions([{ id: "table-1", type: "table", startRow: 10, startCol: 0, endRow: 15, endCol: 4 }]);
    await render();
    expect(byTestId("fmt-mergeCells").hasAttribute("aria-disabled")).toBe(false);
    expect(byTestId("fmt-mergeCells-options").hasAttribute("aria-disabled")).toBe(false);
  });

  it("selectionTouchesTable checks every Ctrl+click block", () => {
    const table = { id: "t", type: "table", startRow: 10, startCol: 0, endRow: 12, endCol: 2 };
    const sel = {
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 1,
      type: "cells" as const,
      additionalRanges: [{ startRow: 11, startCol: 1, endRow: 11, endCol: 1 }],
    };
    expect(selectionTouchesTable(sel, [table])).toBe(true);
    expect(selectionTouchesTable({ ...sel, additionalRanges: undefined }, [table])).toBe(false);
    expect(selectionTouchesTable(null, [table])).toBe(false);
  });
});

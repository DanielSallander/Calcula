//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/editing/sortFilterMenuButton.test.tsx
// PURPOSE: Excel's Sort & Filter hero menu (CONTRACT 3.17): Sort A to Z, Sort
//          Z to A, Custom Sort..., a separator, Filter (checked while the
//          sheet has an AutoFilter), Clear and Reapply (enabled only while data
//          is actually FILTERED -- live Excel measured both disabled for a
//          filter that hides nothing; editing-ext's probe, adopted by the Data
//          menu too). The state comes from the REAL @api/autoFilterService, so
//          the test drives the same publish the AutoFilter extension calls.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module double below stands in for RibbonIcon, whose real name is
 * PascalCase. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";

vi.mock("@api", async () => {
  const icons = await import("@api/ribbonIcons");
  return { RibbonIcon: icons.RibbonIcon };
});

const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn() }));
vi.mock("@api/dialogs", () => dialogs);

/** The selection and the cells the labels are read from (A1, empty, by default). */
const grid = vi.hoisted(() => ({
  state: {
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" } as Record<string, unknown> | null,
  },
}));
vi.mock("@api/grid", () => ({ useGridState: () => grid.state }));
const lib = vi.hoisted(() => ({
  getCell: vi.fn(async (..._a: unknown[]) => null as unknown),
  getViewportCells: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  getStyle: vi.fn(async (index: number) => ({ numberFormat: index === 2 ? "Date (YYYY-MM-DD)" : "General" })),
}));
vi.mock("@api/lib", () => lib);

import { findHardcodedColours, HERO_ICON_SIZE, ICON_SIZE_SM } from "@api/layout";
import { initKeybindings } from "@api/keybindings";
import { CommandRegistry, ExtensionCommands } from "@api/commands";
import { publishAutoFilterStatus, resetAutoFilterController } from "@api/autoFilterService";
import { SortFilterMenuButton } from "../../components/editing/SortFilterMenuButton";
import {
  EDITING_ITEMS,
  SURFACES,
  byTestId,
  click,
  host,
  isRowDisabled,
  menuOutline,
  menuRows,
  mountRoot,
  openMenu,
  propsFor,
  renderOn,
  rowIconSize,
  rowPicture,
  rowShortcut,
  settle,
  unmountRoot,
} from "./editingHarness";

const item = EDITING_ITEMS.sortFilter;
let execute: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initKeybindings();
});

beforeEach(() => {
  mountRoot();
  execute = vi.spyOn(CommandRegistry, "execute").mockResolvedValue(undefined);
  dialogs.alertAsync.mockReset();
  resetAutoFilterController();
  grid.state.selection = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" };
  lib.getCell.mockReset().mockResolvedValue(null);
  lib.getViewportCells.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  unmountRoot();
  execute.mockRestore();
  resetAutoFilterController();
});

for (const surface of SURFACES) {
  describe(`Sort & Filter in the ${surface.name}`, () => {
    const render = () => renderOn(surface, <SortFilterMenuButton {...propsFor(item, surface.band)} />);

    it(
      surface.band
        ? "is Excel's large button: the 30px picture over 'Sort & / Filter v'"
        : "is a standard 28px button with its 20px picture and its label",
      async () => {
        await render();
        const trigger = byTestId("fmt-sortFilter");
        expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
        expect(trigger.hasAttribute("title")).toBe(false);
        // The whole label, spaces kept, in both forms.
        expect(trigger.textContent).toBe("Sort & Filter");
        const icon = trigger.querySelector("svg");
        expect(icon?.getAttribute("width")).toBe(String(surface.band ? HERO_ICON_SIZE : ICON_SIZE_SM));
        // Two label lines in the band (Excel's "Sort & / Filter v"); none outside it.
        expect(trigger.querySelectorAll("[data-hero-line]").length).toBe(surface.band ? 2 : 0);
        expect(findHardcodedColours(host())).toEqual([]);
      },
    );

    it("the menu is Excel's, in Excel's order, each row pictured", async () => {
      await render();
      click(byTestId("fmt-sortFilter"));
      expect(menuOutline()).toEqual(["Sort A to Z", "Sort Z to A", "Custom Sort...", "---", "Filter", "Clear", "Reapply"]);
      expect(menuRows().map((r) => r.getAttribute("data-testid"))).toEqual([
        "fmt-sortFilter-ascending",
        "fmt-sortFilter-descending",
        "fmt-sortFilter-custom",
        "fmt-sortFilter-filter",
        "fmt-sortFilter-clear",
        "fmt-sortFilter-reapply",
      ]);
      expect(menuRows().map(rowPicture)).toEqual(["icon", "icon", "icon", "icon", "icon", "icon"]);
      for (const row of menuRows()) expect(rowIconSize(row)).toBe("20");
      expect(byTestId("fmt-sortFilter-filter").getAttribute("role")).toBe("menuitemcheckbox");
      expect(findHardcodedColours(openMenu()!)).toEqual([]);
    });

    it("each row runs exactly its command, with no args", async () => {
      publishAutoFilterStatus({ hasFilter: true, isDataFiltered: true });
      await render();
      const expected: Array<[string, string]> = [
        ["fmt-sortFilter-ascending", ExtensionCommands.SORT_ASCENDING],
        ["fmt-sortFilter-descending", ExtensionCommands.SORT_DESCENDING],
        ["fmt-sortFilter-custom", ExtensionCommands.SORT_CUSTOM],
        ["fmt-sortFilter-filter", ExtensionCommands.FILTER_TOGGLE],
        ["fmt-sortFilter-clear", ExtensionCommands.FILTER_CLEAR],
        ["fmt-sortFilter-reapply", ExtensionCommands.FILTER_REAPPLY],
      ];
      for (const [testId, command] of expected) {
        execute.mockClear();
        click(byTestId("fmt-sortFilter"));
        click(byTestId(testId));
        expect(execute.mock.calls, testId).toStrictEqual([[command]]);
        expect(openMenu(), testId).toBeNull();
      }
    });
  });
}

describe("the filter rows follow the sheet's filter", () => {
  const render = () => renderOn(SURFACES[0], <SortFilterMenuButton {...propsFor(item, true)} />);

  function state(): { filter: boolean; clear: boolean; reapply: boolean } {
    return {
      filter: byTestId("fmt-sortFilter-filter").getAttribute("aria-checked") === "true",
      clear: !isRowDisabled(byTestId("fmt-sortFilter-clear")),
      reapply: !isRowDisabled(byTestId("fmt-sortFilter-reapply")),
    };
  }

  it("no filter: Filter unchecked, Clear and Reapply greyed", async () => {
    await render();
    click(byTestId("fmt-sortFilter"));
    expect(state()).toEqual({ filter: false, clear: false, reapply: false });
  });

  it("a filter that hides nothing: Filter checked, Clear and Reapply STILL greyed (Excel)", async () => {
    publishAutoFilterStatus({ hasFilter: true, isDataFiltered: false });
    await render();
    click(byTestId("fmt-sortFilter"));
    expect(state()).toEqual({ filter: true, clear: false, reapply: false });
  });

  it("filtered data: Filter checked, Clear and Reapply live", async () => {
    publishAutoFilterStatus({ hasFilter: true, isDataFiltered: true });
    await render();
    click(byTestId("fmt-sortFilter"));
    expect(state()).toEqual({ filter: true, clear: true, reapply: true });
  });

  it("an open menu follows a change the provider publishes (onChange), both ways", async () => {
    await render();
    click(byTestId("fmt-sortFilter"));
    expect(state()).toEqual({ filter: false, clear: false, reapply: false });
    act(() => publishAutoFilterStatus({ hasFilter: true, isDataFiltered: true }));
    expect(state()).toEqual({ filter: true, clear: true, reapply: true });
    act(() => publishAutoFilterStatus({ hasFilter: false, isDataFiltered: false }));
    expect(state()).toEqual({ filter: false, clear: false, reapply: false });
  });

  it("a status published while the menu was CLOSED is what it shows on open", async () => {
    await render();
    click(byTestId("fmt-sortFilter"));
    click(byTestId("fmt-sortFilter"));
    expect(openMenu()).toBeNull();
    act(() => publishAutoFilterStatus({ hasFilter: true, isDataFiltered: false }));
    click(byTestId("fmt-sortFilter"));
    expect(state()).toEqual({ filter: true, clear: false, reapply: false });
  });

  it("the sort rows are never greyed by the filter state", async () => {
    await render();
    click(byTestId("fmt-sortFilter"));
    for (const id of ["fmt-sortFilter-ascending", "fmt-sortFilter-descending", "fmt-sortFilter-custom", "fmt-sortFilter-filter"]) {
      expect(isRowDisabled(byTestId(id)), id).toBe(false);
    }
  });
});

describe("refusals and shortcuts", () => {
  const render = () => renderOn(SURFACES[0], <SortFilterMenuButton {...propsFor(item, true)} />);

  it("a refusal reaches the user", async () => {
    execute.mockRejectedValueOnce(new Error("This command cannot be used on multiple selections."));
    await render();
    click(byTestId("fmt-sortFilter"));
    click(byTestId("fmt-sortFilter-ascending"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("This command cannot be used on multiple selections.");
  });

  it("a sort that runs alerts nothing (positive control)", async () => {
    await render();
    click(byTestId("fmt-sortFilter"));
    click(byTestId("fmt-sortFilter-descending"));
    await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(dialogs.alertAsync).not.toHaveBeenCalled();
  });

  it("Filter shows its live binding (Ctrl+Shift+L); the other rows none", async () => {
    await render();
    click(byTestId("fmt-sortFilter"));
    expect(menuRows().map(rowShortcut)).toEqual([null, null, null, "Ctrl+Shift+L", null, null]);
  });
});

// ============================================================================
// The sort rows' words follow the key's values (Excel, measured live)
// ============================================================================

describe("the sort rows are relabelled by what the sort key holds", () => {
  const render = () => renderOn(SURFACES[0], <SortFilterMenuButton {...propsFor(item, true)} />);
  /** A cell as get_cell / get_viewport_cells report it: style 1 = General, 2 = a date. */
  const cell = (row: number, col: number, display: string, numeric: boolean, styleIndex = 1) => ({
    row,
    col,
    display,
    formula: null,
    styleIndex,
    ...(numeric ? { overflow: "numeric" } : {}),
  });
  async function labels(): Promise<string[]> {
    await render();
    click(byTestId("fmt-sortFilter"));
    await settle();
    return menuOutline().slice(0, 2);
  }

  it("one NUMBER cell: Smallest to Largest -- the same rows, test ids and commands", async () => {
    lib.getCell.mockResolvedValue(cell(0, 0, "42", true));
    expect(await labels()).toEqual(["Sort Smallest to Largest", "Sort Largest to Smallest"]);
    expect(lib.getCell).toHaveBeenCalledWith(0, 0);
    click(byTestId("fmt-sortFilter-ascending"));
    expect(execute.mock.calls).toEqual([[ExtensionCommands.SORT_ASCENDING]]);
  });

  it("one DATE cell: Oldest to Newest", async () => {
    lib.getCell.mockResolvedValue(cell(0, 0, "2026-10-04", true, 2));
    expect(await labels()).toEqual(["Sort Oldest to Newest", "Sort Newest to Oldest"]);
  });

  it("one TEXT or EMPTY cell: A to Z", async () => {
    lib.getCell.mockResolvedValue(cell(0, 0, "text", false));
    expect(await labels()).toEqual(["Sort A to Z", "Sort Z to A"]);
    unmountRoot();
    mountRoot();
    lib.getCell.mockResolvedValue(null);
    expect(await labels()).toEqual(["Sort A to Z", "Sort Z to A"]);
  });

  it("a RANGE reads the active cell's column over it: a text header over numbers is Smallest to Largest", async () => {
    // F1:F4 = "Header", 20, 30, 40 with the header (F1) active -- measured.
    grid.state.selection = { startRow: 3, startCol: 5, endRow: 0, endCol: 5, type: "cells" };
    lib.getViewportCells.mockResolvedValue([
      cell(0, 5, "Header", false),
      cell(1, 5, "20", true),
      cell(2, 5, "30", true),
      cell(3, 5, "40", true),
    ]);
    expect(await labels()).toEqual(["Sort Smallest to Largest", "Sort Largest to Smallest"]);
    expect(lib.getViewportCells).toHaveBeenCalledWith(0, 5, 3, 5);
    expect(lib.getCell).not.toHaveBeenCalled();
  });

  it("a whole column reads a bounded slice of it, never a million rows", async () => {
    grid.state.selection = { startRow: 0, startCol: 3, endRow: 1048575, endCol: 3, type: "columns" };
    lib.getViewportCells.mockResolvedValue([cell(0, 3, "1", true)]);
    expect(await labels()).toEqual(["Sort Smallest to Largest", "Sort Largest to Smallest"]);
    const [r0, , r1] = lib.getViewportCells.mock.calls[0] as number[];
    expect(r1 - r0 + 1).toBeLessThanOrEqual(10000);
  });

  it("a read that fails, or is still in flight, says A to Z (the generic words; the commands are the same)", async () => {
    lib.getCell.mockRejectedValue(new Error("ipc down"));
    expect(await labels()).toEqual(["Sort A to Z", "Sort Z to A"]);
    unmountRoot();
    mountRoot();
    lib.getCell.mockReturnValue(new Promise(() => {}));
    expect(await labels()).toEqual(["Sort A to Z", "Sort Z to A"]);
  });
});

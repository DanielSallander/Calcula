//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/editing/fillMenuButton.test.tsx
// PURPOSE: Excel's Fill menu button (CONTRACT 3.15): Down, Right, Up, Left,
//          Series..., Flash Fill -- the rows, their pictures, the command each
//          runs, and WHEN each direction is greyed, which is Excel's measured
//          rule (live Excel 16 build 20430, 2026-10-04, GetEnabledMso over a
//          fresh workbook; scratchpad home-editing-probe/probe1.out):
//
//            A1            Down n  Right n  Up Y  Left Y
//            A1:A3         Down Y  Right n
//            A1:C1         Down n  Right Y
//            row 1:1       Down n  Right Y  Left Y
//            A1048576      Up n    (A1048575:A1048576: Up Y)
//            XFD5          Left n
//            B2, B:B       all Y
//
//          i.e. a direction is greyed exactly when the selection is ONE row
//          (column) on the sheet's edge it would copy from -- which is also
//          exactly when Core's fill has nothing to copy and does nothing.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module double below stands in for RibbonIcon, whose real name is
 * PascalCase. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

vi.mock("@api", async () => {
  const icons = await import("@api/ribbonIcons");
  return { RibbonIcon: icons.RibbonIcon };
});

const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn() }));
vi.mock("@api/dialogs", () => dialogs);

/** The grid the menu reads; each test sets the selection it needs. */
const grid = vi.hoisted(() => ({
  state: {
    selection: { startRow: 1, startCol: 1, endRow: 1, endCol: 1, type: "cells" } as Record<string, unknown> | null,
    surface: "grid",
    config: { totalRows: 1048576, totalCols: 16384 },
  },
}));
vi.mock("@api/grid", () => ({ useGridState: () => grid.state }));

/** Who holds the selection: null = Core's grid (the default); else a floating grid's cells. */
const owner = vi.hoisted(() => ({
  target: null as null | { kind: "object"; selection: Record<string, unknown>; bounds: { rows: number; cols: number } } | { refusal: string },
}));
vi.mock("@api/cellTarget", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  cellTargetFor: () => owner.target ?? { kind: "grid", selection: grid.state.selection },
}));

import { findHardcodedColours, ICON_SIZE_SM } from "@api/layout";
import { initKeybindings } from "@api/keybindings";
import { CommandRegistry, CoreCommands, ExtensionCommands } from "@api/commands";
import { FillMenuButton } from "../../components/editing/FillMenuButton";
import {
  EDITING_ITEMS,
  SURFACES,
  byTestId,
  click,
  host,
  isRowDisabled,
  key,
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

const item = EDITING_ITEMS.fill;
const LAST_ROW = 1048575;
const LAST_COL = 16383;
let execute: ReturnType<typeof vi.spyOn>;

function select(startRow: number, startCol: number, endRow = startRow, endCol = startCol): void {
  grid.state = { ...grid.state, selection: { startRow, startCol, endRow, endCol, type: "cells" } };
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initKeybindings();
});

beforeEach(() => {
  mountRoot();
  execute = vi.spyOn(CommandRegistry, "execute").mockResolvedValue(undefined);
  dialogs.alertAsync.mockReset();
  grid.state = {
    selection: { startRow: 1, startCol: 1, endRow: 1, endCol: 1, type: "cells" },
    surface: "grid",
    config: { totalRows: 1048576, totalCols: 16384 },
  };
});

afterEach(() => {
  unmountRoot();
  execute.mockRestore();
});

for (const surface of SURFACES) {
  describe(`Fill in the ${surface.name}`, () => {
    const render = () => renderOn(surface, <FillMenuButton {...propsFor(item, surface.band)} />);

    it("is one icon button with a chevron that opens a menu (Excel's narrow Fill)", async () => {
      await render();
      const trigger = byTestId("fmt-fill");
      expect(trigger.getAttribute("aria-label")).toBe("Fill");
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(trigger.hasAttribute("title")).toBe(false);
      expect(trigger.querySelector("svg")?.getAttribute("width")).toBe(String(ICON_SIZE_SM));
      expect(trigger.textContent).toBe("");
      // Not a split: the whole button opens the menu.
      expect(trigger.closest(".split")).toBeNull();
      click(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(openMenu()).not.toBeNull();
      expect(execute).not.toHaveBeenCalled();
      expect(findHardcodedColours(host())).toEqual([]);
      expect(findHardcodedColours(openMenu()!)).toEqual([]);
    });

    it("the menu is Excel's six rows, Down / Right / Up / Left pictured, Series... reserving the column", async () => {
      await render();
      click(byTestId("fmt-fill"));
      expect(menuOutline()).toEqual(["Down", "Right", "Up", "Left", "Series...", "Flash Fill"]);
      expect(menuRows().map((r) => r.getAttribute("data-testid"))).toEqual([
        "fmt-fill-down",
        "fmt-fill-right",
        "fmt-fill-up",
        "fmt-fill-left",
        "fmt-fill-series",
        "fmt-fill-flashFill",
      ]);
      expect(menuRows().map(rowPicture)).toEqual(["icon", "icon", "icon", "icon", "blank", "icon"]);
      for (const row of menuRows().filter((r) => rowPicture(r) === "icon")) {
        expect(rowIconSize(row)).toBe("20");
      }
    });

    it("each row runs exactly its command, with no args", async () => {
      await render();
      const expected: Array<[string, string]> = [
        ["fmt-fill-down", CoreCommands.FILL_DOWN],
        ["fmt-fill-right", CoreCommands.FILL_RIGHT],
        ["fmt-fill-up", CoreCommands.FILL_UP],
        ["fmt-fill-left", CoreCommands.FILL_LEFT],
        ["fmt-fill-series", ExtensionCommands.FILL_SERIES],
        ["fmt-fill-flashFill", ExtensionCommands.FLASH_FILL],
      ];
      for (const [testId, command] of expected) {
        execute.mockClear();
        click(byTestId("fmt-fill"));
        click(byTestId(testId));
        expect(execute.mock.calls, testId).toStrictEqual([[command]]);
        expect(openMenu(), testId).toBeNull();
      }
    });
  });
}

describe("which directions are greyed: Excel's measured rule", () => {
  const render = () => renderOn(SURFACES[0], <FillMenuButton {...propsFor(item, true)} />);

  /** [Down, Right, Up, Left] disabled, for the current selection. */
  async function greyed(): Promise<boolean[]> {
    await render();
    click(byTestId("fmt-fill"));
    const rows = menuRows();
    const out = rows.slice(0, 4).map(isRowDisabled);
    // Series... and Flash Fill are never greyed by the selection.
    expect(isRowDisabled(rows[4])).toBe(false);
    expect(isRowDisabled(rows[5])).toBe(false);
    click(byTestId("fmt-fill"));
    return out;
  }

  it("A1: Down and Right (nothing above, nothing to the left)", async () => {
    select(0, 0);
    expect(await greyed()).toEqual([true, true, false, false]);
  });

  it("B2: nothing (positive control)", async () => {
    select(1, 1);
    expect(await greyed()).toEqual([false, false, false, false]);
  });

  it("A1:A3 (several rows): Down copies the top row, so only Right", async () => {
    select(0, 0, 2, 0);
    expect(await greyed()).toEqual([false, true, false, false]);
  });

  it("A1:C1 (several columns): Right copies the left column, so only Down", async () => {
    select(0, 0, 0, 2);
    expect(await greyed()).toEqual([true, false, false, false]);
  });

  it("a selection drawn upward (A3 to A1) is the same rectangle", async () => {
    select(2, 0, 0, 0);
    expect(await greyed()).toEqual([false, true, false, false]);
  });

  it("the last row: Up; two rows ending there: nothing", async () => {
    select(LAST_ROW, 3);
    expect(await greyed()).toEqual([false, false, true, false]);
    select(LAST_ROW - 1, 3, LAST_ROW, 3);
    expect(await greyed()).toEqual([false, false, false, false]);
  });

  it("the last column: Left", async () => {
    select(4, LAST_COL);
    expect(await greyed()).toEqual([false, false, false, true]);
  });

  it("the sheet's own size decides the edge, not Excel's", async () => {
    grid.state = { ...grid.state, config: { totalRows: 100, totalCols: 10 } };
    select(99, 9);
    expect(await greyed()).toEqual([false, false, true, true]);
  });

  it("no cell selection (a canvas sheet): all four, since there is nothing to fill", async () => {
    grid.state = { ...grid.state, selection: null, surface: "canvas" };
    expect(await greyed()).toEqual([true, true, true, true]);
  });

  it("the keyboard skips greyed rows: ArrowDown at A1 lands on Up", async () => {
    select(0, 0);
    await render();
    key(byTestId("fmt-fill"), "ArrowDown");
    expect(document.activeElement).toBe(byTestId("fmt-fill-up"));
  });

  it("a floating grid's cells: the greying reads ITS selection, not Core's hidden A1 (FG9)", async () => {
    // Core's selection stays A1 (Down grey there); the grid holds B1:B2 of
    // its own 5 x 4 window -- Down has a source.
    select(0, 0);
    owner.target = {
      kind: "object",
      selection: { startRow: 0, startCol: 1, endRow: 1, endCol: 1, type: "cells" },
      bounds: { rows: 5, cols: 4 },
    };
    try {
      expect(await greyed()).toEqual([false, false, false, false]);
      // Its OWN last row (row 5 of 5), not the sheet's: Up is grey there.
      owner.target = { kind: "object", selection: { startRow: 4, startCol: 1, endRow: 4, endCol: 1, type: "cells" }, bounds: { rows: 5, cols: 4 } };
      expect((await greyed())[2]).toBe(true);
      // An owner that refuses the fill: rows stay enabled so the command says why.
      owner.target = { refusal: "Fill is not available here." };
      expect(await greyed()).toEqual([false, false, false, false]);
    } finally {
      owner.target = null;
    }
  });

  it("the menu follows the selection while it is open", async () => {
    select(0, 0);
    await render();
    click(byTestId("fmt-fill"));
    expect(isRowDisabled(byTestId("fmt-fill-down"))).toBe(true);
    select(5, 5);
    await render();
    expect(isRowDisabled(byTestId("fmt-fill-down"))).toBe(false);
  });
});

describe("refusals and shortcuts", () => {
  const render = () => renderOn(SURFACES[0], <FillMenuButton {...propsFor(item, true)} />);

  it("a refusal reaches the user", async () => {
    execute.mockRejectedValueOnce(new Error("The cell or chart you're trying to change is on a protected sheet."));
    await render();
    click(byTestId("fmt-fill"));
    click(byTestId("fmt-fill-down"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("The cell or chart you're trying to change is on a protected sheet.");
  });

  it("a fill that runs alerts nothing (positive control)", async () => {
    await render();
    click(byTestId("fmt-fill"));
    click(byTestId("fmt-fill-series"));
    await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(dialogs.alertAsync).not.toHaveBeenCalled();
  });

  it("Down, Right and Flash Fill show their live bindings", async () => {
    await render();
    click(byTestId("fmt-fill"));
    expect(menuRows().map(rowShortcut)).toEqual(["Ctrl+D", "Ctrl+R", null, null, null, "Ctrl+E"]);
  });
});

//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/cells/insertDeleteSplitButtons.test.tsx
// PURPOSE: Excel's Insert and Delete split buttons (CONTRACT 3.11 / 3.12): the
//          hero face in the ribbon band and the labelled face elsewhere, the
//          main half running Excel's main-half rule (core.grid.insert /
//          core.grid.delete), the menu's rows in Excel's order with their
//          pictures and separators, every row running exactly the contract's
//          command, and a refusal that reaches the user.
// CONTEXT: Home tab = Excel's Home tab, home-cells lane (2026-10-04). The two
//          buttons are one shape with different rows, so one parametrised file
//          pins both: a fix made to one and forgotten in the other fails here.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module double below stands in for RibbonIcon, whose real name is
 * PascalCase. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";

vi.mock("@api", async () => {
  const icons = await import("@api/ribbonIcons");
  return { RibbonIcon: icons.RibbonIcon };
});

const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(async (_message: string) => {}) }));
vi.mock("@api/dialogs", () => dialogs);

import { TOOLTIP_DELAY_MS, findHardcodedColours, HERO_ICON_SIZE, ICON_SIZE_SM } from "@api/layout";
import { initKeybindings } from "@api/keybindings";
import { CommandRegistry, CoreCommands } from "@api/commands";
import type { HomeItemProps } from "../../components/homeItemProps";
import { InsertSplitButton, INSERT_MENU_ROWS } from "../../components/cells/InsertSplitButton";
import { DeleteSplitButton, DELETE_MENU_ROWS } from "../../components/cells/DeleteSplitButton";
import {
  CELLS_ITEMS,
  SURFACES,
  byTestId,
  click,
  host,
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
} from "./cellsHarness";

interface Case {
  name: string;
  Component: (props: HomeItemProps) => React.ReactElement;
  item: (typeof CELLS_ITEMS)["insertCells" | "deleteCells"];
  label: string;
  tooltip: string;
  mainCommand: string;
  outline: string[];
  /** Row test id -> the exact execute() call. */
  calls: Array<[string, unknown[]]>;
  /** Row test id -> the live chip it shows (a regex), or null for none. */
  chips: Array<[string, RegExp | null]>;
}

const CASES: Case[] = [
  {
    name: "Insert",
    Component: InsertSplitButton,
    item: CELLS_ITEMS.insertCells,
    label: "Insert",
    tooltip: "Insert Cells",
    mainCommand: CoreCommands.INSERT,
    // Excel 365's own menu (scratchpad excel-icons/menu-Insert-1.png): a rule
    // under Insert Cells... and another over Insert Sheet.
    outline: ["Insert Cells...", "---", "Insert Sheet Rows", "Insert Sheet Columns", "---", "Insert Sheet"],
    calls: [
      // No args: the Insert dialog (Excel's "Insert Cells..."), or straight
      // to rows / columns for a whole-row / whole-column selection.
      ["fmt-insertCells-cells", [CoreCommands.INSERT_CELLS]],
      ["fmt-insertCells-rows", [CoreCommands.INSERT_ROW]],
      ["fmt-insertCells-columns", [CoreCommands.INSERT_COLUMN]],
      ["fmt-insertCells-sheet", [CoreCommands.SHEET_INSERT]],
    ],
    chips: [
      // Ctrl+Plus runs INSERT_CELLS (Excel's keyboard opens the dialog).
      ["fmt-insertCells-cells", /^Ctrl\+/],
      ["fmt-insertCells-rows", null],
      ["fmt-insertCells-columns", null],
      ["fmt-insertCells-sheet", /^Shift\+F11$/],
    ],
  },
  {
    name: "Delete",
    Component: DeleteSplitButton,
    item: CELLS_ITEMS.deleteCells,
    label: "Delete",
    tooltip: "Delete Cells",
    mainCommand: CoreCommands.DELETE,
    outline: ["Delete Cells...", "---", "Delete Sheet Rows", "Delete Sheet Columns", "---", "Delete Sheet"],
    calls: [
      ["fmt-deleteCells-cells", [CoreCommands.DELETE_CELLS]],
      ["fmt-deleteCells-rows", [CoreCommands.DELETE_ROW]],
      ["fmt-deleteCells-columns", [CoreCommands.DELETE_COLUMN]],
      ["fmt-deleteCells-sheet", [CoreCommands.SHEET_DELETE]],
    ],
    chips: [
      ["fmt-deleteCells-cells", /^Ctrl\+/],
      ["fmt-deleteCells-rows", null],
      ["fmt-deleteCells-columns", null],
      ["fmt-deleteCells-sheet", null],
    ],
  },
];

let execute: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initKeybindings();
});

beforeEach(() => {
  mountRoot();
  execute = vi.spyOn(CommandRegistry, "execute").mockResolvedValue(undefined);
  dialogs.alertAsync.mockClear();
});

afterEach(() => {
  unmountRoot();
  execute.mockRestore();
  vi.useRealTimers();
});

for (const c of CASES) {
  const mainId = `fmt-${c.item.id}`;
  const chevronId = `${mainId}-options`;

  describe(`${c.name}: the faces`, () => {
    it("band: Excel's LARGE split -- the 30px picture runs, the label + chevron below opens the menu", async () => {
      await renderOn(SURFACES[0], <c.Component {...propsFor(c.item, true)} />);
      const main = byTestId(mainId);
      const chevron = byTestId(chevronId);
      expect(main.getAttribute("aria-label")).toBe(c.label);
      expect(chevron.getAttribute("aria-label")).toBe(`${c.label} options`);
      expect(chevron.getAttribute("aria-haspopup")).toBe("menu");
      expect(main.hasAttribute("title")).toBe(false);
      expect(chevron.hasAttribute("title")).toBe(false);
      expect(main.querySelector("svg")?.getAttribute("width")).toBe(String(HERO_ICON_SIZE));
      expect(main.textContent).toBe("");
      // ONE line (Excel's "Insert v"): Insert, Delete and Format sit side by
      // side, and two-line heroes' pictures sit 6px higher than one-line ones.
      expect(chevron.textContent).toBe(c.label);
      expect(chevron.querySelectorAll("[data-hero-line]").length).toBe(1);
      expect(main.closest(".split")).not.toBeNull();
      expect(main.closest(".split")).toBe(chevron.closest(".split"));
      expect(findHardcodedColours(host())).toEqual([]);
    });

    it("panel: one 28px row, [icon label][v], the standard 20px icon", async () => {
      await renderOn(SURFACES[1], <c.Component {...propsFor(c.item, false)} />);
      const main = byTestId(mainId);
      expect(main.querySelector("svg")?.getAttribute("width")).toBe(String(ICON_SIZE_SM));
      expect(main.textContent).toBe(c.label);
      expect(byTestId(chevronId).textContent).toBe("");
      expect(document.querySelector("[data-hero-line]")).toBeNull();
    });
  });

  for (const surface of SURFACES) {
    describe(`${c.name} in the ${surface.name}`, () => {
      const render = () => renderOn(surface, <c.Component {...propsFor(c.item, surface.band)} />);

      it("the main half runs Excel's main-half rule, once, with no args, and opens no menu", async () => {
        await render();
        click(byTestId(mainId));
        expect(execute.mock.calls).toStrictEqual([[c.mainCommand]]);
        expect(openMenu()).toBeNull();
      });

      it("the menu is Excel's: rows, separators, pictures on every row at 20px", async () => {
        await render();
        click(byTestId(chevronId));
        expect(menuOutline()).toEqual(c.outline);
        expect(menuRows().map((r) => r.getAttribute("data-testid"))).toEqual(c.calls.map(([id]) => id));
        expect(menuRows().map(rowPicture)).toEqual(["icon", "icon", "icon", "icon"]);
        for (const row of menuRows()) {
          expect(rowIconSize(row)).toBe("20");
          expect(row.getAttribute("role")).toBe("menuitem");
          expect(row.disabled).toBe(false);
        }
        expect(findHardcodedColours(openMenu()!)).toEqual([]);
      });

      it("each row runs exactly its command, with no args, after the menu closes", async () => {
        await render();
        for (const [testId, call] of c.calls) {
          execute.mockClear();
          click(byTestId(chevronId));
          click(byTestId(testId));
          expect(execute.mock.calls, testId).toStrictEqual([call]);
          expect(openMenu(), testId).toBeNull();
        }
      });

      it("the keyboard: ArrowDown on the main half opens the menu on its first row; Enter runs a row", async () => {
        await render();
        const [firstId, firstCall] = c.calls[0];
        key(byTestId(mainId), "ArrowDown");
        expect(document.activeElement).toBe(byTestId(firstId));
        key(byTestId(firstId), "Enter");
        expect(execute.mock.calls).toStrictEqual([firstCall]);
        expect(document.activeElement).toBe(byTestId(mainId));
      });
    });
  }

  describe(`${c.name}: refusals and teaching`, () => {
    const render = () => renderOn(SURFACES[0], <c.Component {...propsFor(c.item, true)} />);

    it("a refusal thrown by the main half's command reaches the user, in its words", async () => {
      execute.mockRejectedValueOnce(new Error("You can't change part of a table."));
      await render();
      click(byTestId(mainId));
      await settle();
      expect(dialogs.alertAsync).toHaveBeenCalledTimes(1);
      expect(dialogs.alertAsync).toHaveBeenCalledWith("You can't change part of a table.");
    });

    it("a refusal from a menu row reaches the user too (a non-Error refusal as its text)", async () => {
      execute.mockRejectedValueOnce("The workbook's structure is protected.");
      await render();
      click(byTestId(chevronId));
      click(byTestId(c.calls[3][0]));
      await settle();
      expect(dialogs.alertAsync).toHaveBeenCalledWith("The workbook's structure is protected.");
    });

    it("a command that succeeds alerts nothing (positive control)", async () => {
      await render();
      click(byTestId(mainId));
      await settle();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(dialogs.alertAsync).not.toHaveBeenCalled();
    });

    it("rows show their LIVE bindings where a key runs exactly that row", async () => {
      await render();
      click(byTestId(chevronId));
      for (const [testId, chip] of c.chips) {
        const shown = rowShortcut(byTestId(testId));
        if (chip === null) expect(shown, testId).toBeNull();
        else expect(shown, testId).toMatch(chip);
      }
    });

    it(`the main half's tooltip is Excel's "${c.tooltip}", with no chip (no key runs the main-half rule)`, async () => {
      await render();
      vi.useFakeTimers();
      act(() => {
        byTestId(mainId).dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
      });
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 50);
      });
      const tip = document.querySelector("[role='tooltip']");
      expect(tip?.textContent).toContain(c.tooltip);
      // Ctrl+Plus / Ctrl+- run the DIALOG (INSERT_CELLS / DELETE_CELLS), not
      // this half: a chip here would promise the wrong thing.
      expect(tip?.querySelector("kbd")).toBeNull();
    });
  });
}

describe("the row tables", () => {
  it("INSERT_MENU_ROWS and DELETE_MENU_ROWS are CONTRACT 3.11 / 3.12's commands, in order", () => {
    expect(INSERT_MENU_ROWS.map((r) => r.commandId)).toEqual([
      CoreCommands.INSERT_CELLS,
      CoreCommands.INSERT_ROW,
      CoreCommands.INSERT_COLUMN,
      CoreCommands.SHEET_INSERT,
    ]);
    expect(DELETE_MENU_ROWS.map((r) => r.commandId)).toEqual([
      CoreCommands.DELETE_CELLS,
      CoreCommands.DELETE_ROW,
      CoreCommands.DELETE_COLUMN,
      CoreCommands.SHEET_DELETE,
    ]);
  });
});

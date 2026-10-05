//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/editing/findSelectMenuButton.test.tsx
// PURPOSE: Excel's Find & Select hero menu (CONTRACT 3.18): Find..., Replace...,
//          Go To..., Go To Special..., a separator, then the five quick rows
//          (Formulas, Notes, Conditional Formatting, Constants, Data
//          Validation) that select matching cells directly through
//          `goToSpecial.select { criteria }` -- with criteria strings the
//          GoToSpecial extension ACCEPTS (checked against its own validator,
//          not a copied list) -- and the canvas rule: on a canvas sheet the rows
//          that search the active sheet's cells are greyed.

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

const grid = vi.hoisted(() => ({
  state: {
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" } as Record<string, unknown> | null,
    surface: "grid" as "grid" | "canvas",
    config: { totalRows: 1048576, totalCols: 16384 },
  },
}));
vi.mock("@api/grid", () => ({ useGridState: () => grid.state }));

import { findHardcodedColours, HERO_ICON_SIZE, ICON_SIZE_SM } from "@api/layout";
import { initKeybindings } from "@api/keybindings";
import { CommandRegistry, CoreCommands, ExtensionCommands } from "@api/commands";
// The OWNER's validator: a quick row whose criteria the GoToSpecial extension
// would refuse ("does not know the criteria") must fail here, not at a click.
import { isGoToSpecialCriteria } from "../../../../GoToSpecial/lib/selectSpecialCells";
import {
  FindSelectMenuButton,
  FIND_SELECT_QUICK_ROWS,
  FIND_SELECT_ROWS_ON_CANVAS,
} from "../../components/editing/FindSelectMenuButton";
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

const item = EDITING_ITEMS.findSelect;
let execute: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initKeybindings();
});

beforeEach(() => {
  mountRoot();
  execute = vi.spyOn(CommandRegistry, "execute").mockResolvedValue(undefined);
  dialogs.alertAsync.mockReset();
  grid.state = {
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" },
    surface: "grid",
    config: { totalRows: 1048576, totalCols: 16384 },
  };
});

afterEach(() => {
  unmountRoot();
  execute.mockRestore();
});

const ROW_IDS = [
  "fmt-findSelect-find",
  "fmt-findSelect-replace",
  "fmt-findSelect-goTo",
  "fmt-findSelect-goToSpecial",
  "fmt-findSelect-formulas",
  "fmt-findSelect-notes",
  "fmt-findSelect-conditionalFormatting",
  "fmt-findSelect-constants",
  "fmt-findSelect-dataValidation",
];

for (const surface of SURFACES) {
  describe(`Find & Select in the ${surface.name}`, () => {
    const render = () => renderOn(surface, <FindSelectMenuButton {...propsFor(item, surface.band)} />);

    it(
      surface.band
        ? "is Excel's large button: the 30px magnifier over 'Find & / Select v'"
        : "is a standard 28px button with its 20px magnifier and its label",
      async () => {
        await render();
        const trigger = byTestId("fmt-findSelect");
        expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
        expect(trigger.hasAttribute("title")).toBe(false);
        expect(trigger.textContent).toBe("Find & Select");
        expect(trigger.querySelector("svg")?.getAttribute("width")).toBe(
          String(surface.band ? HERO_ICON_SIZE : ICON_SIZE_SM),
        );
        expect(trigger.querySelectorAll("[data-hero-line]").length).toBe(surface.band ? 2 : 0);
        expect(findHardcodedColours(host())).toEqual([]);
      },
    );

    it("the menu is Excel's, in Excel's order: four doors, a separator, five quick rows", async () => {
      await render();
      click(byTestId("fmt-findSelect"));
      expect(menuOutline()).toEqual([
        "Find...",
        "Replace...",
        "Go To...",
        "Go To Special...",
        "---",
        "Formulas",
        "Notes",
        "Conditional Formatting",
        "Constants",
        "Data Validation",
      ]);
      expect(menuRows().map((r) => r.getAttribute("data-testid"))).toEqual(ROW_IDS);
      // Find, Replace and Go To are pictured; Go To Special and the quick rows
      // reserve the column, as Excel's do.
      expect(menuRows().map(rowPicture)).toEqual([
        "icon",
        "icon",
        "icon",
        "blank",
        "blank",
        "blank",
        "blank",
        "blank",
        "blank",
      ]);
      for (const row of menuRows().slice(0, 3)) expect(rowIconSize(row)).toBe("20");
      for (const row of menuRows()) expect(isRowDisabled(row), row.getAttribute("data-testid")!).toBe(false);
      expect(findHardcodedColours(openMenu()!)).toEqual([]);
    });

    it("each row runs exactly its command; the quick rows select by criteria", async () => {
      await render();
      const expected: Array<[string, unknown[]]> = [
        ["fmt-findSelect-find", [CoreCommands.FIND]],
        ["fmt-findSelect-replace", [CoreCommands.REPLACE]],
        ["fmt-findSelect-goTo", [ExtensionCommands.GO_TO]],
        ["fmt-findSelect-goToSpecial", [ExtensionCommands.GO_TO_SPECIAL]],
        ["fmt-findSelect-formulas", [ExtensionCommands.GO_TO_SPECIAL_SELECT, { criteria: "formulas" }]],
        ["fmt-findSelect-notes", [ExtensionCommands.GO_TO_SPECIAL_SELECT, { criteria: "notes" }]],
        [
          "fmt-findSelect-conditionalFormatting",
          [ExtensionCommands.GO_TO_SPECIAL_SELECT, { criteria: "conditionalFormats" }],
        ],
        ["fmt-findSelect-constants", [ExtensionCommands.GO_TO_SPECIAL_SELECT, { criteria: "constants" }]],
        ["fmt-findSelect-dataValidation", [ExtensionCommands.GO_TO_SPECIAL_SELECT, { criteria: "dataValidation" }]],
      ];
      for (const [testId, call] of expected) {
        execute.mockClear();
        click(byTestId("fmt-findSelect"));
        click(byTestId(testId));
        expect(execute.mock.calls, testId).toStrictEqual([call]);
        expect(openMenu(), testId).toBeNull();
      }
    });
  });
}

describe("the quick rows' criteria", () => {
  it("every one is a criteria the GoToSpecial extension accepts", () => {
    expect(FIND_SELECT_QUICK_ROWS).toHaveLength(5);
    for (const row of FIND_SELECT_QUICK_ROWS) {
      expect(isGoToSpecialCriteria(row.criteria), row.criteria).toBe(true);
    }
  });

  it("the validator really refuses a near miss (the check has teeth)", () => {
    expect(isGoToSpecialCriteria("conditionalFormatting")).toBe(false);
    expect(isGoToSpecialCriteria("validation")).toBe(false);
  });
});

describe("on a canvas sheet", () => {
  const render = () => renderOn(SURFACES[0], <FindSelectMenuButton {...propsFor(item, true)} />);

  it("the rows that search the sheet's cells are greyed; Find, Replace and Go To are not", async () => {
    grid.state = { ...grid.state, surface: "canvas", selection: null };
    await render();
    click(byTestId("fmt-findSelect"));
    const live = menuRows()
      .filter((r) => !isRowDisabled(r))
      .map((r) => r.getAttribute("data-testid"));
    expect(live).toEqual(["fmt-findSelect-find", "fmt-findSelect-replace", "fmt-findSelect-goTo"]);
    expect([...FIND_SELECT_ROWS_ON_CANVAS].sort()).toEqual(["find", "goTo", "replace"]);
  });

  it("a greyed row runs nothing when clicked", async () => {
    grid.state = { ...grid.state, surface: "canvas", selection: null };
    await render();
    click(byTestId("fmt-findSelect"));
    click(byTestId("fmt-findSelect-constants"));
    expect(execute).not.toHaveBeenCalled();
  });

  it("leaving the canvas while the menu is open makes them live again", async () => {
    grid.state = { ...grid.state, surface: "canvas", selection: null };
    await render();
    click(byTestId("fmt-findSelect"));
    expect(isRowDisabled(byTestId("fmt-findSelect-goToSpecial"))).toBe(true);
    grid.state = { ...grid.state, surface: "grid", selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 } };
    await render();
    expect(isRowDisabled(byTestId("fmt-findSelect-goToSpecial"))).toBe(false);
  });
});

describe("refusals and shortcuts", () => {
  const render = () => renderOn(SURFACES[0], <FindSelectMenuButton {...propsFor(item, true)} />);

  it("a refusal reaches the user", async () => {
    execute.mockRejectedValueOnce(new Error("No cells were found."));
    await render();
    click(byTestId("fmt-findSelect"));
    click(byTestId("fmt-findSelect-formulas"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("No cells were found.");
  });

  it("a row that runs alerts nothing (positive control)", async () => {
    await render();
    click(byTestId("fmt-findSelect"));
    click(byTestId("fmt-findSelect-find"));
    await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(dialogs.alertAsync).not.toHaveBeenCalled();
  });

  it("Find, Replace and Go To show their live bindings; the others none", async () => {
    await render();
    click(byTestId("fmt-findSelect"));
    const chips = menuRows().map(rowShortcut);
    expect(chips.slice(0, 2)).toEqual(["Ctrl+F", "Ctrl+H"]);
    // Go To has two bindings (F5, Ctrl+G); the chip shows the first the
    // registry resolves.
    expect(["F5", "Ctrl+G"]).toContain(chips[2]);
    expect(chips.slice(3)).toEqual([null, null, null, null, null, null]);
  });
});

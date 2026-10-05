//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/cells/formatMenuButton.test.tsx
// PURPOSE: Excel's Format menu on the Home tab (CONTRACT 3.13): the hero
//          trigger, the four headed sections with Excel's rows, pictures and
//          rules, the Hide & Unhide and Tab Color flyouts, every row running
//          exactly the contract's command, and the state the menu READS WHEN IT
//          OPENS -- Protect / Unprotect Sheet's label, Lock Cell's tick (the
//          ACTIVE cell's lock) and greying (a protected sheet), Unhide Sheet's
//          greying (no hidden sheet, or the command refused) and the tab colour
//          the palette shows selected.
// CONTEXT: Home tab = Excel's Home tab, home-cells lane (2026-10-04). The
//          backend reads (@api/lib), the selection (@api/grid) and the theme
//          palette (@api/theme) are doubles; the commands' own rules are pinned
//          by their owners (shell-sheets, Protection, core-grid).

/* eslint-disable @typescript-eslint/naming-convention --
 * The module double below stands in for RibbonIcon, whose real name is
 * PascalCase. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

vi.mock("@api", async () => {
  const icons = await import("@api/ribbonIcons");
  return { RibbonIcon: icons.RibbonIcon };
});

const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(async (_message: string) => {}) }));
vi.mock("@api/dialogs", () => dialogs);

/** The workbook the menu reads, and how often it asked. */
const env = vi.hoisted(() => ({
  protectedSheet: false,
  /** Locked state per "row,col". Unlisted cells are locked (Excel's default). */
  unlocked: new Set<string>(),
  sheets: [
    { index: 0, name: "Sheet1", visibility: "visible", tabColor: "" },
    { index: 1, name: "Sheet2", visibility: "visible", tabColor: "" },
  ] as Array<{ index: number; name: string; visibility: string; tabColor?: string }>,
  activeIndex: 0,
  selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" } as Record<string, unknown> | null,
  protectionReads: 0,
  lockReads: [] as Array<[number, number]>,
  sheetReads: 0,
  /** Which reads fail (an IPC error). */
  fail: { protection: false, lock: false, sheets: false },
  /** Hold the reads until released (to see the menu before they land). */
  hold: null as null | Promise<void>,
}));

vi.mock("@api/lib", () => ({
  isSheetProtected: async () => {
    env.protectionReads += 1;
    if (env.hold) await env.hold;
    if (env.fail.protection) throw new Error("ipc down");
    return env.protectedSheet;
  },
  getCellProtection: async (row: number, col: number) => {
    env.lockReads.push([row, col]);
    if (env.hold) await env.hold;
    if (env.fail.lock) throw new Error("ipc down");
    return { locked: !env.unlocked.has(`${row},${col}`), formulaHidden: false };
  },
  getSheets: async () => {
    env.sheetReads += 1;
    if (env.hold) await env.hold;
    if (env.fail.sheets) throw new Error("ipc down");
    return { sheets: env.sheets, activeIndex: env.activeIndex };
  },
}));

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGridStateSnapshot: () => (env.selection ? { selection: env.selection } : null),
}));

const theme = vi.hoisted(() => ({
  palette: [
    { slot: "accent1", tint: 0, resolvedColor: "#4472c4", label: "Theme accent1" },
    { slot: "accent1", tint: 800, resolvedColor: "#d9e2f3", label: "Theme accent1, lighter 80%" },
  ],
}));
vi.mock("@api/theme", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getThemeColorPalette: async () => theme.palette,
}));

import { findHardcodedColours, HERO_ICON_SIZE, ICON_SIZE_SM } from "@api/layout";
import { initKeybindings } from "@api/keybindings";
import { CommandRegistry, CoreCommands, ExtensionCommands } from "@api/commands";
import { addCommandRefusal } from "@api/commandRefusals";
import { FormatMenuButton, FORMAT_MENU_LABELS } from "../../components/cells/FormatMenuButton";
import {
  CELLS_ITEMS,
  SURFACES,
  byTestId,
  click,
  host,
  isRowDisabled,
  isSubmenuRow,
  key,
  maybeTestId,
  menuOutline,
  menuRows,
  mountRoot,
  openMenu,
  openMenus,
  propsFor,
  renderOn,
  rowIconSize,
  rowPicture,
  rowShortcut,
  settle,
  settleTimers,
  unmountRoot,
  type Surface,
} from "./cellsHarness";

const item = CELLS_ITEMS.formatMenu;
const TRIGGER = "fmt-formatMenu";
let execute: ReturnType<typeof vi.spyOn>;
let dropRefusal: (() => void) | null = null;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initKeybindings();
});

beforeEach(() => {
  mountRoot();
  execute = vi.spyOn(CommandRegistry, "execute").mockResolvedValue(undefined);
  dialogs.alertAsync.mockClear();
  env.protectedSheet = false;
  env.unlocked = new Set();
  env.sheets = [
    { index: 0, name: "Sheet1", visibility: "visible", tabColor: "" },
    { index: 1, name: "Sheet2", visibility: "visible", tabColor: "" },
  ];
  env.activeIndex = 0;
  env.selection = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" };
  env.protectionReads = 0;
  env.lockReads = [];
  env.sheetReads = 0;
  env.fail = { protection: false, lock: false, sheets: false };
  env.hold = null;
});

afterEach(() => {
  dropRefusal?.();
  dropRefusal = null;
  unmountRoot();
  execute.mockRestore();
  vi.useRealTimers();
});

const render = (surface: Surface = SURFACES[0]) =>
  renderOn(surface, <FormatMenuButton {...propsFor(item, surface.band)} />);

/** Open the menu and let its reads land. */
async function openFormatMenu(): Promise<void> {
  click(byTestId(TRIGGER));
  await settle();
}

/** Open a submenu row (a pointer click opens it) and let it settle. */
async function openSub(testId: string): Promise<HTMLElement> {
  click(byTestId(testId));
  await settleTimers();
  const levels = openMenus();
  const row = byTestId(testId);
  const flyoutId = row.getAttribute("aria-controls");
  const flyout = flyoutId ? document.getElementById(flyoutId) : null;
  if (!flyout) throw new Error(`${testId} opened no flyout (${levels.length} menus open)`);
  return flyout;
}

// ============================================================================
// The trigger
// ============================================================================

describe("the trigger", () => {
  it("band: Excel's hero -- the 30px Format picture over 'Format v', a menu button", async () => {
    await render(SURFACES[0]);
    const trigger = byTestId(TRIGGER);
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.querySelector("svg")?.getAttribute("width")).toBe(String(HERO_ICON_SIZE));
    expect(trigger.textContent).toBe("Format");
    expect(trigger.hasAttribute("title")).toBe(false);
    expect(findHardcodedColours(host())).toEqual([]);
  });

  it("panel: a standard 28px button with the 20px picture", async () => {
    await render(SURFACES[1]);
    const trigger = byTestId(TRIGGER);
    expect(trigger.querySelector("svg")?.getAttribute("width")).toBe(String(ICON_SIZE_SM));
    expect(trigger.textContent).toBe("Format");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("a closed menu reads nothing (no backend round trip per render)", async () => {
    await render();
    await settle();
    expect(env.protectionReads + env.sheetReads + env.lockReads.length).toBe(0);
  });
});

// ============================================================================
// The menu
// ============================================================================

const OUTLINE = [
  "# Cell Size",
  "Row Height...",
  "AutoFit Row Height",
  "---",
  "Column Width...",
  "AutoFit Column Width",
  "Default Width...",
  "---",
  "# Visibility",
  "Hide & Unhide",
  "---",
  "# Organize Sheets",
  "Rename Sheet",
  "Move or Copy Sheet...",
  "Tab Color",
  "---",
  "# Protection",
  "Protect Sheet...",
  "Lock Cell",
  "---",
  "Format Cells...",
];

const TOP_ROW_IDS = [
  "fmt-formatMenu-rowHeight",
  "fmt-formatMenu-autoFitRowHeight",
  "fmt-formatMenu-columnWidth",
  "fmt-formatMenu-autoFitColumnWidth",
  "fmt-formatMenu-defaultWidth",
  "fmt-formatMenu-hideUnhide",
  "fmt-formatMenu-renameSheet",
  "fmt-formatMenu-moveOrCopySheet",
  "fmt-formatMenu-tabColor",
  "fmt-formatMenu-protectSheet",
  "fmt-formatMenu-lockCell",
  "fmt-formatMenu-formatCells",
];

/** Every command row (top level and Hide & Unhide's) -> the exact execute() call. */
const TOP_CALLS: Array<[string, unknown[]]> = [
  ["fmt-formatMenu-rowHeight", [CoreCommands.ROW_HEIGHT]],
  ["fmt-formatMenu-autoFitRowHeight", [CoreCommands.AUTOFIT_ROW_HEIGHT]],
  ["fmt-formatMenu-columnWidth", [CoreCommands.COLUMN_WIDTH]],
  ["fmt-formatMenu-autoFitColumnWidth", [CoreCommands.AUTOFIT_COLUMN_WIDTH]],
  ["fmt-formatMenu-defaultWidth", [CoreCommands.DEFAULT_WIDTH]],
  ["fmt-formatMenu-renameSheet", [CoreCommands.SHEET_RENAME]],
  ["fmt-formatMenu-moveOrCopySheet", [CoreCommands.SHEET_MOVE_OR_COPY]],
  ["fmt-formatMenu-protectSheet", [ExtensionCommands.PROTECT_SHEET_TOGGLE]],
  ["fmt-formatMenu-lockCell", [ExtensionCommands.LOCK_CELL_TOGGLE]],
  ["fmt-formatMenu-formatCells", [CoreCommands.FORMAT_CELLS]],
];

const HIDE_CALLS: Array<[string, unknown[]]> = [
  ["fmt-formatMenu-hideRows", [CoreCommands.HIDE_ROWS]],
  ["fmt-formatMenu-hideColumns", [CoreCommands.HIDE_COLUMNS]],
  ["fmt-formatMenu-hideSheet", [CoreCommands.SHEET_HIDE]],
  ["fmt-formatMenu-unhideRows", [CoreCommands.UNHIDE_ROWS]],
  ["fmt-formatMenu-unhideColumns", [CoreCommands.UNHIDE_COLUMNS]],
  ["fmt-formatMenu-unhideSheet", [CoreCommands.SHEET_UNHIDE]],
];

for (const surface of SURFACES) {
  describe(`the menu in the ${surface.name}`, () => {
    it("is Excel's: four headed sections, its rows and rules, pictures where Excel draws them", async () => {
      await render(surface);
      await openFormatMenu();
      expect(menuOutline()).toEqual(OUTLINE);
      expect(menuRows().map((r) => r.getAttribute("data-testid"))).toEqual(TOP_ROW_IDS);
      // Excel 365's own menu (scratchpad excel-icons/menu-Format-1.png):
      // pictures on Row Height, Column Width, Rename Sheet, Protect Sheet, Lock
      // Cell and Format Cells; every other row RESERVES the column.
      expect(menuRows().map(rowPicture)).toEqual([
        "icon", "blank", "icon", "blank", "blank",
        "blank",
        "icon", "blank", "blank",
        "icon", "icon", "icon",
      ]);
      for (const row of menuRows()) {
        if (rowPicture(row) === "icon") expect(rowIconSize(row), row.getAttribute("data-testid")!).toBe("20");
      }
      expect(menuRows().filter(isSubmenuRow).map((r) => r.getAttribute("data-testid"))).toEqual([
        "fmt-formatMenu-hideUnhide",
        "fmt-formatMenu-tabColor",
      ]);
      expect(findHardcodedColours(openMenu()!)).toEqual([]);
    });

    it("each command row runs exactly its command, with no args, after the menu closes", async () => {
      await render(surface);
      for (const [testId, call] of TOP_CALLS) {
        execute.mockClear();
        await openFormatMenu();
        click(byTestId(testId));
        expect(execute.mock.calls, testId).toStrictEqual([call]);
        expect(openMenu(), testId).toBeNull();
      }
    });

    it("Hide & Unhide > is Excel's six rows: three Hide, a rule, three Unhide; each runs its command", async () => {
      env.sheets[1].visibility = "hidden";
      await render(surface);
      for (const [testId, call] of HIDE_CALLS) {
        execute.mockClear();
        await openFormatMenu();
        const flyout = await openSub("fmt-formatMenu-hideUnhide");
        expect(menuOutline(flyout)).toEqual([
          "Hide Rows",
          "Hide Columns",
          "Hide Sheet",
          "---",
          "Unhide Rows",
          "Unhide Columns",
          "Unhide Sheet...",
        ]);
        expect(menuRows(flyout).map(rowPicture)).toEqual(["blank", "blank", "blank", "blank", "blank", "blank"]);
        click(byTestId(testId));
        expect(execute.mock.calls, testId).toStrictEqual([call]);
        // Choosing an item closes the WHOLE chain.
        expect(openMenus(), testId).toEqual([]);
      }
    });
  });
}

describe("the keyboard", () => {
  it("ArrowDown on the trigger opens the menu on Row Height...; Enter runs it and focus comes back", async () => {
    await render();
    key(byTestId(TRIGGER), "ArrowDown");
    await settle();
    expect(document.activeElement).toBe(byTestId("fmt-formatMenu-rowHeight"));
    key(byTestId("fmt-formatMenu-rowHeight"), "Enter");
    expect(execute.mock.calls).toStrictEqual([[CoreCommands.ROW_HEIGHT]]);
    expect(document.activeElement).toBe(byTestId(TRIGGER));
  });

  it("Format Cells... shows its LIVE binding (Ctrl+1); the sheet and size rows show none", async () => {
    await render();
    await openFormatMenu();
    expect(rowShortcut(byTestId("fmt-formatMenu-formatCells"))).toBe("Ctrl+1");
    expect(rowShortcut(byTestId("fmt-formatMenu-rowHeight"))).toBeNull();
    expect(rowShortcut(byTestId("fmt-formatMenu-renameSheet"))).toBeNull();
  });
});

// ============================================================================
// State read when the menu opens
// ============================================================================

describe("Protect Sheet... / Unprotect Sheet...", () => {
  it("says Protect Sheet... on an unprotected sheet", async () => {
    await render();
    await openFormatMenu();
    const row = byTestId("fmt-formatMenu-protectSheet");
    expect(row.querySelector("[data-menu-label]")?.textContent).toBe(FORMAT_MENU_LABELS.protectSheet);
    expect(FORMAT_MENU_LABELS.protectSheet).toBe("Protect Sheet...");
  });

  it("says Unprotect Sheet... on a protected sheet, and runs the same toggle", async () => {
    env.protectedSheet = true;
    await render();
    await openFormatMenu();
    const row = byTestId("fmt-formatMenu-protectSheet");
    expect(row.querySelector("[data-menu-label]")?.textContent).toBe("Unprotect Sheet...");
    click(row);
    expect(execute.mock.calls).toStrictEqual([[ExtensionCommands.PROTECT_SHEET_TOGGLE]]);
  });

  it("is read when the menu OPENS: a protection change between two openings shows on the second", async () => {
    await render();
    await openFormatMenu();
    expect(env.protectionReads).toBe(1);
    expect(byTestId("fmt-formatMenu-protectSheet").textContent).toContain("Protect Sheet...");
    key(openMenu()!, "Escape");
    env.protectedSheet = true;
    await openFormatMenu();
    expect(env.protectionReads).toBe(2);
    expect(byTestId("fmt-formatMenu-protectSheet").textContent).toContain("Unprotect Sheet...");
  });

  it("a failed read says Protect Sheet... and leaves the toggle to decide (it reads the sheet itself)", async () => {
    env.fail.protection = true;
    await render();
    await openFormatMenu();
    const row = byTestId("fmt-formatMenu-protectSheet");
    expect(row.textContent).toContain("Protect Sheet...");
    expect(isRowDisabled(row)).toBe(false);
  });
});

describe("Lock Cell", () => {
  it("is a menuitemcheckbox, ticked when the active cell is locked (Excel's default)", async () => {
    await render();
    await openFormatMenu();
    const row = byTestId("fmt-formatMenu-lockCell");
    expect(row.getAttribute("role")).toBe("menuitemcheckbox");
    expect(row.getAttribute("aria-checked")).toBe("true");
    expect(isRowDisabled(row)).toBe(false);
  });

  it("is unticked when the active cell is unlocked", async () => {
    env.unlocked.add("0,0");
    await render();
    await openFormatMenu();
    expect(byTestId("fmt-formatMenu-lockCell").getAttribute("aria-checked")).toBe("false");
  });

  it("reads the ACTIVE cell -- activeRow/activeCol when set, never the anchor", async () => {
    // Dragged from C5 up-left to A1, then the active cell moved (Enter) to B2.
    env.selection = { startRow: 4, startCol: 2, endRow: 0, endCol: 0, activeRow: 1, activeCol: 1, type: "cells" };
    env.unlocked.add("1,1");
    await render();
    await openFormatMenu();
    expect(env.lockReads).toEqual([[1, 1]]);
    expect(byTestId("fmt-formatMenu-lockCell").getAttribute("aria-checked")).toBe("false");
  });

  it("without the aliases the active cell is (endRow, endCol), the cell the grid draws as active", async () => {
    env.selection = { startRow: 4, startCol: 2, endRow: 0, endCol: 3, type: "cells" };
    await render();
    await openFormatMenu();
    expect(env.lockReads).toEqual([[0, 3]]);
  });

  it("is disabled on a protected sheet (Excel greys it; the backend would refuse)", async () => {
    env.protectedSheet = true;
    await render();
    await openFormatMenu();
    const row = byTestId("fmt-formatMenu-lockCell");
    expect(isRowDisabled(row)).toBe(true);
    click(row);
    expect(execute).not.toHaveBeenCalled();
  });

  it("is disabled until the protection read lands, and enabled after it (no click lands on a guess)", async () => {
    let release: () => void = () => {};
    env.hold = new Promise<void>((r) => {
      release = r;
    });
    await render();
    await openFormatMenu();
    expect(isRowDisabled(byTestId("fmt-formatMenu-lockCell"))).toBe(true);
    release();
    await settle();
    expect(isRowDisabled(byTestId("fmt-formatMenu-lockCell"))).toBe(false);
  });

  it("a failed lock read leaves it unticked but live (Lock Cell reads the cell itself)", async () => {
    env.fail.lock = true;
    await render();
    await openFormatMenu();
    const row = byTestId("fmt-formatMenu-lockCell");
    expect(row.getAttribute("aria-checked")).toBe("false");
    expect(isRowDisabled(row)).toBe(false);
  });

  it("with no selection at all it reads nothing and stays unticked", async () => {
    env.selection = null;
    await render();
    await openFormatMenu();
    expect(env.lockReads).toEqual([]);
    expect(byTestId("fmt-formatMenu-lockCell").getAttribute("aria-checked")).toBe("false");
  });
});

describe("Unhide Sheet...", () => {
  async function unhideRow(): Promise<HTMLButtonElement> {
    await render();
    await openFormatMenu();
    await openSub("fmt-formatMenu-hideUnhide");
    return byTestId("fmt-formatMenu-unhideSheet");
  }

  it("is enabled when a sheet is hidden", async () => {
    env.sheets[1].visibility = "hidden";
    expect(isRowDisabled(await unhideRow())).toBe(false);
  });

  it("is disabled when no sheet is hidden (Excel greys it; measured live)", async () => {
    expect(isRowDisabled(await unhideRow())).toBe(true);
  });

  it("a veryHidden sheet does not count: Unhide cannot show it", async () => {
    env.sheets[1].visibility = "veryHidden";
    expect(isRowDisabled(await unhideRow())).toBe(true);
  });

  it("is disabled when the command refuses right now, even with a hidden sheet", async () => {
    env.sheets[1].visibility = "hidden";
    dropRefusal = addCommandRefusal({
      commandIds: [CoreCommands.SHEET_UNHIDE],
      refuse: () => "Finish editing the formula first.",
    });
    expect(isRowDisabled(await unhideRow())).toBe(true);
  });

  it("a refusal of ANOTHER command leaves it enabled (positive control)", async () => {
    env.sheets[1].visibility = "hidden";
    dropRefusal = addCommandRefusal({ commandIds: [CoreCommands.SHEET_HIDE], refuse: () => "no" });
    expect(isRowDisabled(await unhideRow())).toBe(false);
  });

  it("a failed sheet read leaves the decision to the command's own refusal (enabled)", async () => {
    env.fail.sheets = true;
    expect(isRowDisabled(await unhideRow())).toBe(false);
  });

  it("the other five rows are always enabled (Excel)", async () => {
    await unhideRow();
    for (const [testId] of HIDE_CALLS.slice(0, 5)) {
      expect(isRowDisabled(byTestId(testId)), testId).toBe(false);
    }
  });
});

describe("Tab Color >", () => {
  const PALETTE = "fmt-formatMenu-tabColor-palette";

  it("opens the colour palette as its flyout (custom content: aria-haspopup dialog)", async () => {
    await render();
    await openFormatMenu();
    const row = byTestId("fmt-formatMenu-tabColor");
    expect(row.getAttribute("aria-haspopup")).toBe("dialog");
    await openSub("fmt-formatMenu-tabColor");
    expect(maybeTestId(PALETTE)).not.toBeNull();
  });

  it("'No Color' sits after Standard Colors, as Excel's does (measured live), and sends { color: null }", async () => {
    env.sheets[0].tabColor = "#ff0000";
    await render();
    await openFormatMenu();
    await openSub("fmt-formatMenu-tabColor");
    const none = byTestId(`${PALETTE}-automatic`);
    expect(none.textContent).toContain("No Color");
    const swatches = Array.from(document.querySelectorAll("[data-colour-swatch]"));
    const lastSwatch = swatches[swatches.length - 1];
    // DOCUMENT_POSITION_FOLLOWING: the row comes after every swatch.
    expect(lastSwatch.compareDocumentPosition(none) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    click(none);
    expect(execute.mock.calls).toStrictEqual([[CoreCommands.SHEET_TAB_COLOR, { color: null }]]);
    expect(openMenus()).toEqual([]);
  });

  it("a standard colour sends its hex", async () => {
    await render();
    await openFormatMenu();
    await openSub("fmt-formatMenu-tabColor");
    const red = Array.from(document.querySelectorAll<HTMLElement>("[data-colour-swatch]")).find(
      (s) => s.getAttribute("aria-label") === "Red",
    );
    expect(red).toBeDefined();
    click(red!);
    expect(execute.mock.calls).toStrictEqual([[CoreCommands.SHEET_TAB_COLOR, { color: "#ff0000" }]]);
    expect(openMenus()).toEqual([]);
  });

  it("a THEME colour is sent as its resolved hex (the command takes hex or null only)", async () => {
    await render();
    await openFormatMenu();
    await openSub("fmt-formatMenu-tabColor");
    const accent = Array.from(document.querySelectorAll<HTMLElement>("[data-colour-swatch]")).find(
      (s) => s.getAttribute("aria-label") === "Theme accent1, lighter 80%",
    );
    expect(accent).toBeDefined();
    click(accent!);
    expect(execute.mock.calls).toStrictEqual([[CoreCommands.SHEET_TAB_COLOR, { color: "#d9e2f3" }]]);
  });

  it("shows the ACTIVE sheet's tab colour as the selected swatch", async () => {
    env.sheets[1].tabColor = "#ff0000";
    env.activeIndex = 1;
    await render();
    await openFormatMenu();
    await openSub("fmt-formatMenu-tabColor");
    const pressed = Array.from(document.querySelectorAll<HTMLElement>("[data-colour-swatch][aria-pressed='true']"));
    expect(pressed.map((s) => s.getAttribute("aria-label"))).toEqual(["Red"]);
  });

  it("a refusal from the tab colour command reaches the user", async () => {
    execute.mockRejectedValueOnce(new Error("The workbook's structure is protected."));
    await render();
    await openFormatMenu();
    await openSub("fmt-formatMenu-tabColor");
    click(byTestId(`${PALETTE}-automatic`));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("The workbook's structure is protected.");
  });
});

describe("refusals", () => {
  it("a refusal thrown by a menu row's command reaches the user, in its words", async () => {
    execute.mockRejectedValueOnce(new Error("The cell or chart you're trying to change is on a protected sheet."));
    await render();
    await openFormatMenu();
    click(byTestId("fmt-formatMenu-columnWidth"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledTimes(1);
    expect(dialogs.alertAsync).toHaveBeenCalledWith(
      "The cell or chart you're trying to change is on a protected sheet.",
    );
  });

  it("a command that succeeds alerts nothing (positive control)", async () => {
    await render();
    await openFormatMenu();
    click(byTestId("fmt-formatMenu-rowHeight"));
    await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(dialogs.alertAsync).not.toHaveBeenCalled();
  });
});

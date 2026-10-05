//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/homeTabItemTooltip.test.ts
// PURPOSE: The tooltip props of the version-2 Home items (Excel's Home tab):
//          which ones name the command they run -- so the chip is the LIVE
//          binding -- and which deliberately name none.
// CONTEXT: A tooltip chip is resolved from `commandId` through whichever
//          keybinding runs that command. Two ways to get it wrong, both
//          checked here: an item that runs a command but names none shows the
//          catalog's literal "(Alt+=)" forever, even after a rebind; and an
//          item mapped to the WRONG command promises a key that does something
//          else. Insert is the live example of the second: Ctrl+Plus now opens
//          the Insert dialog (INSERT_CELLS), while the Insert picture runs
//          INSERT -- so mapping Insert to INSERT_CELLS would put Ctrl+Plus on a
//          button that Ctrl+Plus does not press. Excel's Insert tooltip shows
//          no shortcut, and neither does ours.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { CoreCommands, ExtensionCommands } from "@api/commands";
import { getAllKeybindings, initKeybindings } from "@api/keybindings";
import { ALL_ITEMS, ITEMS_BY_ID } from "../homeTabConfig";
import { ITEM_COMMAND_IDS, itemTooltip } from "../components/itemTooltip";

beforeAll(() => {
  // The app registers the built-in bindings at startup.
  vi.spyOn(console, "log").mockImplementation(() => {});
  initKeybindings();
});

const tip = (id: string) => itemTooltip(ITEMS_BY_ID.get(id)!);

/** The default combos that run `commandId`. */
const combosFor = (commandId: string) =>
  getAllKeybindings()
    .filter((b) => b.commandId === commandId)
    .map((b) => b.combo);

describe("the version-2 items' tooltips", () => {
  it("AutoSum names its command, so the chip is the live Alt+= rather than the catalog's text", () => {
    expect(tip("autoSum")).toEqual({ tooltip: "AutoSum", commandId: ExtensionCommands.AUTOSUM });
    expect(combosFor(ExtensionCommands.AUTOSUM)).toContain("Alt+=");
  });

  it("Insert and Delete name the command their PICTURE runs, which no key is bound to (Excel shows none)", () => {
    expect(tip("insertCells")).toEqual({ tooltip: "Insert Cells", commandId: CoreCommands.INSERT });
    expect(tip("deleteCells")).toEqual({ tooltip: "Delete Cells", commandId: CoreCommands.DELETE });
    expect(combosFor(CoreCommands.INSERT)).toEqual([]);
    expect(combosFor(CoreCommands.DELETE)).toEqual([]);
    // Ctrl+Plus is the DIALOG's key: it must not reach the picture's tooltip.
    expect(combosFor(CoreCommands.INSERT_CELLS)).toContain("Ctrl+Plus");
  });

  it("menus and splits that run no single command name none, and keep Excel's words", () => {
    const words: Record<string, string> = {
      borders: "Borders",
      orientation: "Orientation",
      accountingFormat: "Accounting Number Format",
      conditionalFormatting: "Conditional Formatting",
      formatAsTable: "Format as Table",
      formatMenu: "Format",
      fill: "Fill",
      clear: "Clear",
      sortFilter: "Sort & Filter",
      findSelect: "Find & Select",
    };
    for (const [id, text] of Object.entries(words)) {
      expect(ITEM_COMMAND_IDS[id], id).toBeUndefined();
      expect(tip(id), id).toEqual({ tooltip: text });
    }
  });

  it("every mapped id is a catalog item (a typo would silently drop a chip)", () => {
    const catalog = new Set(ALL_ITEMS.map((i) => i.id));
    for (const id of Object.keys(ITEM_COMMAND_IDS)) expect(catalog.has(id), id).toBe(true);
  });
});

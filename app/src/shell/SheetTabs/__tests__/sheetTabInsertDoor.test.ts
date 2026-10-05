//! FILENAME: app/src/shell/SheetTabs/__tests__/sheetTabInsertDoor.test.ts
// PURPOSE: The sheet tab menu's "Insert Sheet" -- and Protection's override of
//          it -- insert where Home > Insert > Insert Sheet and Shift+F11 do:
//          BEFORE the sheet (Excel's rule), through core.sheet.insert.
// CONTEXT: Review finding (2026-10-04): the tab-menu item dispatched
//          `sheet:requestAdd`, which reached the strip's add handler and
//          APPENDED the sheet at the end, while every other door ran
//          CoreCommands.SHEET_INSERT (add + move before the sheet). One name,
//          two places, depending on the door. Drives the real registrations;
//          the command registry's execute is recorded, not run.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const h = vi.hoisted(() => ({
  protected: false,
  dialogs: [] as Array<{ id: string; data: unknown }>,
}));

vi.mock("../../registries/sheetTabColorPicker", () => ({
  installSheetTabColorPicker: () => {},
  openSheetTabColorPicker: () => {},
}));
vi.mock("../../../../extensions/Protection/lib/protectionStore", () => ({
  isCurrentWorkbookProtected: () => h.protected,
}));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showDialog: (id: string, data: unknown) => h.dialogs.push({ id, data }),
}));

import { CommandRegistry, CoreCommands } from "@api/commands";
import { registerSheetExtensionsService } from "@api/extensions";
import { registerCoreSheetContextMenu, sheetExtensions, type SheetContext } from "../../registries/sheetExtensions";
import { registerSheetTabProtection } from "../../../../extensions/Protection/handlers/sheetTabGuard";

const executed: Array<{ id: string; args: unknown }> = [];
const requestAdds: unknown[] = [];
const onRequestAdd = (e: Event) => requestAdds.push((e as CustomEvent).detail);

/** The right-clicked tab: the THIRD sheet (true index 2), not the active one. */
const clicked: SheetContext = {
  sheet: { name: "Sheet3", index: 2 },
  index: 2,
  isActive: false,
  totalSheets: 4,
};

function insertItem() {
  const item = sheetExtensions.getContextMenuItems().find((i) => i.id === "core:insertSheet");
  expect(item, "the tab menu has an Insert Sheet item").toBeDefined();
  return item!;
}

beforeAll(() => {
  // Seat the @api facade on the Shell registry, as bootstrap does: Protection
  // registers through @api, the core items through the registry itself.
  registerSheetExtensionsService({
    registerContextMenuItem: (item) => sheetExtensions.registerContextMenuItem(item),
    unregisterContextMenuItem: (id) => sheetExtensions.unregisterContextMenuItem(id),
    getContextMenuItems: () => sheetExtensions.getContextMenuItems(),
    getContextMenuItemsForContext: (context) => sheetExtensions.getContextMenuItemsForContext(context),
  } as never);
  registerCoreSheetContextMenu();
  vi.spyOn(CommandRegistry, "execute").mockImplementation(async (id: string, args?: unknown) => {
    executed.push({ id, args });
    return undefined as never;
  });
  window.addEventListener("sheet:requestAdd", onRequestAdd);
});
afterAll(() => {
  window.removeEventListener("sheet:requestAdd", onRequestAdd);
  vi.restoreAllMocks();
});
beforeEach(() => {
  executed.length = 0;
  requestAdds.length = 0;
  h.protected = false;
  h.dialogs = [];
});

describe("the tab menu's Insert Sheet", () => {
  it("runs core.sheet.insert for the CLICKED sheet (insert before it), never the append-at-end event", async () => {
    await insertItem().onClick(clicked);
    expect(executed).toEqual([{ id: CoreCommands.SHEET_INSERT, args: { index: 2 } }]);
    expect(requestAdds).toEqual([]);
  });

  it("Insert Canvas keeps its own door (a canvas page is not core.sheet.insert)", async () => {
    const canvas = sheetExtensions.getContextMenuItems().find((i) => i.id === "core:insertCanvas");
    await canvas!.onClick(clicked);
    expect(executed).toEqual([]);
    expect(requestAdds).toEqual([{ kind: "canvas" }]);
  });
});

describe("Protection's Insert Sheet override", () => {
  it("runs the same command for the clicked sheet when the structure is unlocked", async () => {
    const restore = registerSheetTabProtection();
    try {
      await insertItem().onClick(clicked);
      expect(executed).toEqual([{ id: CoreCommands.SHEET_INSERT, args: { index: 2 } }]);
      expect(requestAdds).toEqual([]);
    } finally {
      restore();
    }
  });

  it("refuses with its warning, and inserts nothing, when the structure is protected", async () => {
    const restore = registerSheetTabProtection();
    try {
      h.protected = true;
      await insertItem().onClick(clicked);
      expect(executed).toEqual([]);
      expect(requestAdds).toEqual([]);
      expect(h.dialogs).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("puts the core item back on deactivation, still the command door", async () => {
    registerSheetTabProtection()();
    await insertItem().onClick(clicked);
    expect(executed).toEqual([{ id: CoreCommands.SHEET_INSERT, args: { index: 2 } }]);
  });
});

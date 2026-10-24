//! FILENAME: app/src/shell/SheetTabs/__tests__/keepSheetMenuItem.test.ts
// PURPOSE: The tab menu's Keep Sheet keeps the right-clicked TEMPORARY sheet
//          through the strip's controller BY ITS STABLE ID -- never by its
//          index -- and appears only on a temporary sheet, first in the list.
// CONTEXT: Review finding keep-claims-success-it-did-not-get: Keep Sheet passed
//          `context.index`, captured when the menu opened. A lower temporary
//          sheet's discard landing between the right-click and the click
//          shifted every index above it, so the keep landed on ANOTHER sheet,
//          the backend answered Ok (a keep of an ordinary sheet is a no-op) and
//          the strip said "Sheet kept" while the sheet the user meant stayed
//          temporary. The real registration (sheetExtensions.ts) is driven
//          against a fake strip controller, as sheetTabMenuColorAndHide.test.tsx
//          does for Tab Color; what the strip then does with the id is
//          sheetTabsTemporarySheets.test.tsx.

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

vi.mock("@api/dialogs", () => ({
  promptAsync: vi.fn(async () => null),
  alertAsync: vi.fn(async () => undefined),
  confirmAsync: vi.fn(async () => false),
}));
// The theme palette is a Tauri round-trip in the app (color.test.tsx).
vi.mock("../../../api/theme", () => ({ getThemeColorPalette: async () => [] }));

import { sheetExtensions, registerCoreSheetContextMenu, type SheetContext } from "../../registries/sheetExtensions";
import { registerSheetTabsController, type SheetTabsController } from "../sheetCommands";
import type { SheetInfo } from "../../../core/lib/tauri-api";

const SHEETS: SheetInfo[] = [
  { index: 0, name: "Sales", visibility: "visible", sheetId: "id-Sales" },
  { index: 1, name: "Drillthrough", visibility: "visible", sheetId: "id-Drill", ephemeral: true },
];

let release: (() => void) | null = null;

function seat() {
  const keepSheet = vi.fn(async (_sheetId: string | undefined) => undefined);
  const controller: SheetTabsController = {
    snapshot: () => ({ sheets: SHEETS, activeIndex: 1, locked: false }),
    insertSheetBefore: vi.fn(async () => undefined),
    appendSheet: vi.fn(async () => undefined),
    deleteSheet: vi.fn(async () => undefined),
    discardSheet: vi.fn(async () => true),
    keepSheet,
    renameSheet: vi.fn(async () => undefined),
    hideSheet: vi.fn(async () => undefined),
    openUnhideDialog: vi.fn(async () => undefined),
    setTabColor: vi.fn(async () => undefined),
    moveOrCopySheet: vi.fn(async () => undefined),
  };
  release?.();
  release = registerSheetTabsController(controller);
  return { keepSheet };
}

/** The context the strip builds for a right-click: the TRUE index, and the stable id. */
function contextFor(sheet: SheetInfo, index = sheet.index): SheetContext {
  return { sheet, index, sheetId: sheet.sheetId, isActive: index === 1, totalSheets: SHEETS.length };
}

const keepItem = (context: SheetContext) =>
  sheetExtensions.getContextMenuItemsForContext(context).find((i) => i.id === "core:keepSheet");

beforeAll(() => {
  registerCoreSheetContextMenu();
});

afterEach(() => {
  release?.();
  release = null;
});

describe("Keep Sheet (the tab menu)", () => {
  it("keeps the right-clicked temporary sheet BY ITS STABLE ID", async () => {
    const { keepSheet } = seat();
    const context = contextFor(SHEETS[1]);
    const item = keepItem(context);
    expect(item, "Keep Sheet is missing on a temporary sheet").toBeDefined();
    await item!.onClick(context);
    expect(keepSheet).toHaveBeenCalledTimes(1);
    expect(keepSheet).toHaveBeenCalledWith("id-Drill");
  });

  it("an index that went stale under the open menu does not matter: the id is what is sent", async () => {
    const { keepSheet } = seat();
    // The menu was opened for the drill sheet at index 1; a lower discard has
    // since moved it to 0. The context still carries the id it was opened for.
    const stale = contextFor(SHEETS[1], 1);
    await keepItem(stale)!.onClick({ ...stale, index: 7 });
    expect(keepSheet).toHaveBeenCalledWith("id-Drill");
    expect(keepSheet).not.toHaveBeenCalledWith(7);
    expect(keepSheet).not.toHaveBeenCalledWith(1);
  });

  it("appears only on a temporary sheet, and leads the list", () => {
    seat();
    expect(keepItem(contextFor(SHEETS[0]))).toBeUndefined();
    const items = sheetExtensions.getContextMenuItemsForContext(contextFor(SHEETS[1]));
    expect(items[0]?.id).toBe("core:keepSheet");
  });
});

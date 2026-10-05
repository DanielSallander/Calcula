//! FILENAME: app/extensions/Table/handlers/__tests__/formatAsTable.test.tsx
// PURPOSE: Home > Format as Table (Excel's Styles group): the command
//          `table.formatAsTable { styleId }` and the Format-menu item whose
//          custom content is the table-style gallery the ribbon hosts.
// CONTEXT: Nothing outside the Table extension could reach a table style: the
//          gallery, the catalogue and the write were all internal, and the only
//          gallery host was the contextual Table Design tab, which exists only
//          INSIDE a table -- so the one place Excel offers the gallery to make a
//          table did not exist. Excel's rule (and this command's):
//            - active cell inside a table -> that table takes the style, no
//              dialog;
//            - otherwise -> Create Table opens (range detected, "My table has
//              headers" on) and the new table is born in the chosen style.
//          The ribbon's Format as Table hero hosts menu "format" > item
//          "format:formatAsTable" through the kit's RegisteredMenuButton, so the
//          item's customContent IS the gallery; the gallery's picks go through
//          the command, so the menu bar, the ribbon, a macro and the keyboard
//          share one handler.
//
//          The gallery offers Excel's set, read from live Excel 16 on
//          2026-10-04 (UI Automation over the open gallery): Light 1-21,
//          Medium 1-28, Dark 1-11, no "None" tile (that one lives in Table
//          Design, where it removes a style), then New Table Style... / New
//          PivotTable Style..., both deferred by owner decision 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  showDialog: vi.fn(),
  emitted: [] as Array<[string, unknown]>,
  selection: { startRow: 2, startCol: 1, endRow: 2, endCol: 1 } as null | {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  },
  tables: [] as Array<{ id: string; startRow: number; startCol: number; endRow: number; endCol: number; styleName: string }>,
  applyTableStyleAsync: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showDialog: (...a: unknown[]) => h.showDialog(...a),
}));
vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/events")>()),
  emitAppEvent: (name: string, detail?: unknown) => {
    h.emitted.push([name, detail]);
  },
}));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => (h.selection ? { selection: h.selection } : null),
}));
vi.mock("../../lib/tableStore", () => ({
  getTableAtCell: (row: number, col: number) =>
    h.tables.find((t) => row >= t.startRow && row <= t.endRow && col >= t.startCol && col <= t.endCol) ?? null,
}));
vi.mock("../../lib/tableStyles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/tableStyles")>()),
  applyTableStyleAsync: (...a: unknown[]) => h.applyTableStyleAsync(...a),
}));

import { ExtensionCommands, CommandRegistry } from "@api";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";
import { SurfaceLayoutProvider, bandLayout, findHardcodedColours } from "@api/layout";
import { formatAsTable, registerFormatAsTable, FORMAT_AS_TABLE_MENU_ITEM_ID } from "../formatAsTable";
import { TABLE_DIALOG_ID } from "../../lib/dialogIds";

const TABLE_DEFINITIONS_UPDATED = "app:table-definitions-updated";

const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.showDialog.mockReset();
  h.emitted.length = 0;
  h.selection = { startRow: 2, startCol: 1, endRow: 2, endCol: 1 };
  h.tables = [{ id: "t1", startRow: 0, startCol: 0, endRow: 9, endCol: 3, styleName: "TableStyleMedium2" }];
  h.applyTableStyleAsync.mockReset();
  h.applyTableStyleAsync.mockImplementation(async (id: string) => ({ id, styleName: "x" }));
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "fat-test-owner", label: "the test object's cells", ownsSelection: () => owns });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  release();
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

describe("table.formatAsTable { styleId }", () => {
  it("inside a table: restyles THAT table, announces it, opens no dialog", async () => {
    await formatAsTable({ styleId: "table-light-9" });
    expect(h.applyTableStyleAsync).toHaveBeenCalledWith("t1", "table-light-9");
    expect(h.emitted.map(([n]) => n)).toContain(TABLE_DEFINITIONS_UPDATED);
    expect(h.showDialog).not.toHaveBeenCalled();
  });

  it("the table is found from the ACTIVE cell (the selection's end)", async () => {
    h.selection = { startRow: 40, startCol: 0, endRow: 3, endCol: 0 };
    await formatAsTable({ styleId: "table-dark-2" });
    expect(h.applyTableStyleAsync).toHaveBeenCalledWith("t1", "table-dark-2");
  });

  it("outside every table: Create Table opens with the style's NAME, and nothing is restyled", async () => {
    h.selection = { startRow: 20, startCol: 5, endRow: 20, endCol: 5 };
    await formatAsTable({ styleId: "table-medium-7" });
    expect(h.showDialog).toHaveBeenCalledWith(TABLE_DIALOG_ID, { styleName: "TableStyleMedium7" });
    expect(h.applyTableStyleAsync).not.toHaveBeenCalled();
  });

  it("a refused restyle says so and announces nothing", async () => {
    h.applyTableStyleAsync.mockResolvedValue(null);
    await formatAsTable({ styleId: "table-light-9" });
    expect(h.emitted.map(([n]) => n)).not.toContain(TABLE_DEFINITIONS_UPDATED);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe("error");
  });

  it("a restyle that THROWS is reported, never an unhandled rejection", async () => {
    h.applyTableStyleAsync.mockRejectedValue(new Error("backend gone"));
    await expect(formatAsTable({ styleId: "table-light-9" })).resolves.toBe(false);
    expect(toasts.map((t) => t.variant)).toEqual(["error"]);
  });

  it("an unknown style id does nothing and says so (a script typo must not create a table)", async () => {
    expect(await formatAsTable({ styleId: "table-light-99" })).toBe(false);
    expect(await formatAsTable({} as never)).toBe(false);
    expect(h.applyTableStyleAsync).not.toHaveBeenCalled();
    expect(h.showDialog).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(2);
  });

  it("an Excel name is accepted as well as a gallery id (scripts speak TableStyleMedium2)", async () => {
    await formatAsTable({ styleId: "TableStyleMedium2" });
    expect(h.applyTableStyleAsync).toHaveBeenCalledWith("t1", "table-medium-2");
  });

  it("refuses -- once -- while something else owns the selection", async () => {
    owns = true;
    expect(await formatAsTable({ styleId: "table-light-9" })).toBe(false);
    expect(h.applyTableStyleAsync).not.toHaveBeenCalled();
    expect(h.showDialog).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
  });
});

// ============================================================================
// Registration: the command and the Format-menu item
// ============================================================================

interface MenuItem {
  id: string;
  label: string;
  children?: unknown[];
  customContent?: (close: () => void) => React.ReactNode;
}

function register(): { items: Array<[string, MenuItem]>; commands: Map<string, (args?: unknown) => unknown>; cleanup: () => void; unregistered: string[][]; commandsGone: string[] } {
  const items: Array<[string, MenuItem]> = [];
  const commands = new Map<string, (args?: unknown) => unknown>();
  const unregistered: string[][] = [];
  const commandsGone: string[] = [];
  const cleanup = registerFormatAsTable({
    commands: {
      register: (id: string, handler: (args?: unknown) => unknown) => commands.set(id, handler),
      unregister: (id: string) => commandsGone.push(id),
    },
    ui: {
      menus: {
        registerItem: (menu: string, item: MenuItem) => items.push([menu, item]),
        unregisterItem: (menu: string, id: string) => unregistered.push([menu, id]),
      },
    },
  } as never);
  return { items, commands, cleanup, unregistered, commandsGone };
}

describe("registration", () => {
  it("registers ExtensionCommands.FORMAT_AS_TABLE and runs the handler with its args", async () => {
    const { commands } = register();
    expect([...commands.keys()]).toEqual([ExtensionCommands.FORMAT_AS_TABLE]);
    await commands.get(ExtensionCommands.FORMAT_AS_TABLE)!({ styleId: "table-light-9" });
    expect(h.applyTableStyleAsync).toHaveBeenCalledWith("t1", "table-light-9");
  });

  it("adds Format > Format as Table: gallery content, no children", () => {
    const { items } = register();
    expect(items.map(([menu, it]) => [menu, it.id, it.label])).toEqual([
      ["format", FORMAT_AS_TABLE_MENU_ITEM_ID, "Format as Table"],
    ]);
    expect(FORMAT_AS_TABLE_MENU_ITEM_ID).toBe("format:formatAsTable");
    expect(items[0][1].customContent).toBeTypeOf("function");
    expect(items[0][1].children).toBeUndefined();
  });

  it("the cleanup takes back the command and the item", () => {
    const { cleanup, unregistered, commandsGone } = register();
    cleanup();
    expect(commandsGone).toEqual([ExtensionCommands.FORMAT_AS_TABLE]);
    expect(unregistered).toEqual([["format", FORMAT_AS_TABLE_MENU_ITEM_ID]]);
  });
});

// ============================================================================
// The gallery the item hosts
// ============================================================================

describe("the Format as Table gallery", () => {
  function openGallery(onClose = vi.fn()): HTMLElement {
    const { items } = register();
    const content = items[0][1].customContent!(onClose);
    // Inside the ribbon BAND's surface context: a popover portalled out of the
    // band inherits it through React context, and the gallery must still draw
    // its grid, never the band's 61px strip.
    act(() => {
      root.render(<SurfaceLayoutProvider value={bandLayout(900)}>{content}</SurfaceLayoutProvider>);
    });
    return document.querySelector("[data-testid='format-as-table-gallery']") as HTMLElement;
  }

  it("is a grid (no band strip, no expand button) of Excel's 60 styles, grouped Light / Medium / Dark, no None", () => {
    const gallery = openGallery();
    expect(gallery).not.toBeNull();
    expect(gallery.querySelector("[data-testid='format-as-table-expand']")).toBeNull();
    const options = Array.from(gallery.querySelectorAll("[role='option']")).map((el) => el.getAttribute("aria-label"));
    expect(options).toHaveLength(60);
    expect(options[0]).toBe("Light 1");
    expect(options[20]).toBe("Light 21");
    expect(options[21]).toBe("Medium 1");
    expect(options[48]).toBe("Medium 28");
    expect(options[49]).toBe("Dark 1");
    expect(options[59]).toBe("Dark 11");
    expect(options).not.toContain("None");
    const headings = Array.from(gallery.querySelectorAll("[role='group']")).map((g) => g.textContent?.match(/^(Light|Medium|Dark)/)?.[1]);
    expect(headings).toEqual(["Light", "Medium", "Dark"]);
  });

  it("paints no chrome colour (the thumbnails are colour DATA)", () => {
    const gallery = openGallery();
    expect(findHardcodedColours(gallery)).toEqual([]);
  });

  it("a pick closes the card, THEN runs table.formatAsTable through the command registry", async () => {
    // Closing hands focus back to the trigger; doing it after the command
    // would pull focus off the Create Table dialog the command may open.
    const execute = vi.spyOn(CommandRegistry, "execute").mockResolvedValue(undefined);
    const onClose = vi.fn();
    const gallery = openGallery(onClose);
    act(() => (gallery.querySelector("[data-testid='format-as-table-table-dark-4']") as HTMLElement).click());
    await flush();
    expect(execute).toHaveBeenCalledWith(ExtensionCommands.FORMAT_AS_TABLE, { styleId: "table-dark-4" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);
  });

  it("a REJECTED command is caught (logged), never an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(CommandRegistry, "execute").mockRejectedValue(new Error("no handler"));
    const gallery = openGallery();
    act(() => (gallery.querySelector("[data-testid='format-as-table-table-light-1']") as HTMLElement).click());
    await flush();
    await new Promise((r) => setTimeout(r, 0));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(error).toHaveBeenCalled();
  });
});

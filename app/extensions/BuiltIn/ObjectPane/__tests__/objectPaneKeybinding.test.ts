//! FILENAME: app/extensions/BuiltIn/ObjectPane/__tests__/objectPaneKeybinding.test.ts
// PURPOSE: Ctrl+1 through the REAL keybinding dispatcher and the REAL extension
//          activation:
//            - an object with a pane is the primary selection and the grid has
//              the keyboard -> `objectPane.format` (the pane opens on Format);
//            - no object selected -> the cells' Format Cells keeps the key
//              (a guarded binding that says no is skipped, never swallowing);
//            - an object no family offers a pane for -> Format Cells;
//            - focus outside the grid -> the object binding stands down.
//          Also: the grip menu offers "Format..." for an object with a pane,
//          and `objectPane.show` opens on the default tab.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ surface: "canvas", sheetContext: { activeSheetIndex: 0 } }),
}));

import { CommandRegistry } from "@api/commands";
import { handleGlobalKeyDown, registerKeybinding, getAllKeybindings } from "@api/keybindings";
import { setGridRegions } from "@api/gridOverlays";
import {
  OBJECT_PANE_COMMAND_FORMAT,
  OBJECT_PANE_COMMAND_SHOW,
  OBJECT_PANE_FORMAT_LABEL,
  OBJECT_PANE_FORMAT_TAB,
  getObjectPaneState,
  registerObjectPaneProvider,
  resetObjectPane,
} from "@api/objectPane";
import { objectGripMenuItems, registerObjectGripMenuItem, resetObjectPosition } from "@api/objectPosition";
import { clearObjectSelection, resetObjectSelectionProviders, selectObject } from "@api/objectSelection";
import { registerSelectionOwner } from "@api/selectionOwner";
import type { ExtensionContext } from "@api/contract";
import ObjectPaneExtension, { OBJECT_PANE_FORMAT_BINDING_ID } from "../index";
import { resetPaneState } from "../lib/paneState";
import { resetTabMemory } from "../lib/tabMemory";
import { floatingRegion, installFakeTaskPanes, installSelectionFamily } from "./harness";

const CELLS_COMMAND = "core.format.cells";
const WITH_PANE = floatingRegion("obj-a", "with-pane");
const WITHOUT_PANE = floatingRegion("obj-b", "without-pane");

let ranCells = 0;
const cleanups: Array<() => void> = [];
let gridSurface: HTMLElement;

function ctrl1(): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "1", ctrlKey: true, bubbles: true, cancelable: true });
}

function context(): ExtensionContext {
  return {
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown) => CommandRegistry.register(id, fn as never),
      unregister: (id: string) => CommandRegistry.unregister(id),
      execute: (id: string, args?: unknown) => CommandRegistry.execute(id, args),
      has: (id: string) => CommandRegistry.has(id),
    },
  } as unknown as ExtensionContext;
}

beforeEach(async () => {
  document.body.innerHTML = "";
  ranCells = 0;
  resetObjectPane();
  resetObjectSelectionProviders();
  resetObjectPosition();
  resetPaneState();
  resetTabMemory(true);
  installFakeTaskPanes();
  for (const t of ["with-pane", "without-pane"]) cleanups.push(installSelectionFamily(t).cleanup);
  setGridRegions([WITH_PANE, WITHOUT_PANE]);
  cleanups.push(
    registerObjectPaneProvider({
      types: ["with-pane"],
      tabs: () => [{ id: "settings", label: "Settings", render: () => null }],
    }),
  );

  CommandRegistry.register(CELLS_COMMAND, () => {
    ranCells += 1;
  });
  cleanups.push(() => CommandRegistry.unregister(CELLS_COMMAND));
  // The built-in, registered FIRST, exactly as the shell does at startup.
  cleanups.push(
    registerKeybinding({
      id: "test.core.formatCells",
      combo: "Ctrl+1",
      commandId: CELLS_COMMAND,
      label: "Format Cells",
      category: "Formatting",
      source: "built-in",
    }),
  );

  await ObjectPaneExtension.activate(context());
  cleanups.push(() => void ObjectPaneExtension.deactivate?.());

  const grid = document.createElement("div");
  grid.setAttribute("data-focus-container", "spreadsheet");
  gridSurface = document.createElement("div");
  gridSurface.tabIndex = 0;
  grid.appendChild(gridSurface);
  document.body.appendChild(grid);
  gridSurface.focus();
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
  document.body.innerHTML = "";
});

describe("Ctrl+1", () => {
  it("the binding is registered under its id, as an extension binding", () => {
    const b = getAllKeybindings().find((k) => k.id === OBJECT_PANE_FORMAT_BINDING_ID);
    expect(b?.combo).toBe("Ctrl+1");
    expect(b?.commandId).toBe(OBJECT_PANE_COMMAND_FORMAT);
    expect(b?.source).toBe("extension");
  });

  it("with an object that has a pane selected, opens the object pane on Format", () => {
    selectObject(WITH_PANE);
    expect(handleGlobalKeyDown(ctrl1())).toBe(true);
    expect(ranCells).toBe(0);
    const s = getObjectPaneState();
    expect(s.open).toBe(true);
    expect(s.regionId).toBe(WITH_PANE.id);
    expect(s.tabId).toBe(OBJECT_PANE_FORMAT_TAB);
  });

  it("with no object selected, Format Cells keeps the key", () => {
    clearObjectSelection();
    expect(handleGlobalKeyDown(ctrl1())).toBe(true);
    expect(ranCells).toBe(1);
    expect(getObjectPaneState().open).toBe(false);
  });

  it("with an object no family offers a pane for, Format Cells keeps the key", () => {
    selectObject(WITHOUT_PANE);
    handleGlobalKeyDown(ctrl1());
    expect(ranCells).toBe(1);
    expect(getObjectPaneState().open).toBe(false);
  });

  it("with one of the object's own CELLS holding the selection (a floating grid's cell), Format Cells keeps the key", () => {
    // BUG-0185: Ctrl+1 on a floating grid's selected cell is the cells' door,
    // which the floating grid refuses once with its sentence -- never the
    // box's Format tab (that swallowed the key without a word).
    selectObject(WITH_PANE);
    cleanups.push(
      registerSelectionOwner({
        id: "test.cellOwner",
        label: "a test object's cells",
        ownsSelection: () => true,
        receivesTyping: () => true,
      }),
    );
    expect(handleGlobalKeyDown(ctrl1())).toBe(true);
    expect(ranCells).toBe(1);
    expect(getObjectPaneState().open).toBe(false);
  });

  it("an owner whose cells take NO typing (the object selected as a whole) leaves Ctrl+1 to the object", () => {
    selectObject(WITH_PANE);
    cleanups.push(
      registerSelectionOwner({ id: "test.objectOwner", label: "an object", ownsSelection: () => true, receivesTyping: () => false }),
    );
    handleGlobalKeyDown(ctrl1());
    expect(ranCells).toBe(0);
    expect(getObjectPaneState().tabId).toBe(OBJECT_PANE_FORMAT_TAB);
  });

  it("with the keyboard outside the grid, the object binding stands down", () => {
    selectObject(WITH_PANE);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    handleGlobalKeyDown(ctrl1());
    expect(getObjectPaneState().open).toBe(false);
  });
});

describe("one key, one owner", () => {
  // The chart used to bind Ctrl+1 itself (`ext.charts.formatSelection`). Two
  // guarded bindings on one key are two owners of one gesture; WP-C S9a
  // deleted the chart's, and the chart takes part through its pane provider's
  // `beforeShowFormat` instead. Read as SOURCE (the census style), so a
  // re-added binding fails here without activating the Charts extension.
  it("the chart's Ctrl+1 binding is gone (no extension binds Ctrl+1 but this one)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../../Charts/index.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    expect(code).not.toContain("ext.charts.formatSelection");
    expect(code).not.toMatch(/combo:\s*["']Ctrl\+1["']/);
    expect(getAllKeybindings().filter((b) => b.combo === "Ctrl+1" && b.source === "extension").map((b) => b.id)).toEqual([
      OBJECT_PANE_FORMAT_BINDING_ID,
    ]);
  });
});

describe("the other doors", () => {
  it("objectPane.show opens on the default (first build) tab", async () => {
    selectObject(WITH_PANE);
    await CommandRegistry.execute(OBJECT_PANE_COMMAND_SHOW);
    expect(getObjectPaneState().tabId).toBe("settings");
  });

  it("the grip menu offers Format... for an object with a pane, and it opens on Format", async () => {
    const items = objectGripMenuItems(WITH_PANE);
    const fmt = items.find((i) => i.id === OBJECT_PANE_COMMAND_FORMAT);
    expect(fmt?.label).toBe(OBJECT_PANE_FORMAT_LABEL);
    fmt!.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(getObjectPaneState().tabId).toBe(OBJECT_PANE_FORMAT_TAB);
    expect(objectGripMenuItems(WITHOUT_PANE).some((i) => i.id === OBJECT_PANE_COMMAND_FORMAT)).toBe(false);
  });

  it("Format... sits directly below Size and Position, above the canvas's Bring Forward / Send Backward / Lock", async () => {
    // The canvas registers its items (orders 10/20/30) BEFORE this extension
    // activates (manifest order). Re-activate after stand-ins at the canvas's
    // orders so the registration sequence matches the app's; a tie would put
    // "Format..." after Bring Forward.
    await ObjectPaneExtension.deactivate?.();
    for (const [id, order] of [
      ["test.canvas.bringForward", 10],
      ["test.canvas.sendBackward", 20],
      ["test.canvas.lock", 30],
    ] as const) {
      cleanups.push(registerObjectGripMenuItem({ id, label: id, order, run: () => undefined }));
    }
    await ObjectPaneExtension.activate(context());
    expect(objectGripMenuItems(WITH_PANE).map((i) => i.id)).toEqual([
      OBJECT_PANE_COMMAND_FORMAT,
      "test.canvas.bringForward",
      "test.canvas.sendBackward",
      "test.canvas.lock",
    ]);
  });
});

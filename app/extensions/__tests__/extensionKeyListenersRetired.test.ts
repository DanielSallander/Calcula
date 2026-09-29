//! FILENAME: app/extensions/__tests__/extensionKeyListenersRetired.test.ts
// PURPOSE: The keybinding registry is the ONE keyboard path for every built-in
//          shortcut an extension owns: the extension installs no key listener
//          of its own for it, so with NO registry binding its default key does
//          nothing at all.
// CONTEXT: D1 / D2 (wave B). BUG-0183 made each extension's own keydown
//          listener STAND ASIDE whenever the registry bound its command -- which
//          the app always does -- leaving a second, hard-coded path that could
//          only ever run in a host with no registry, and a census row in
//          core/lib/globalInputListeners.ts describing behaviour that no longer
//          happened. The dispatcher's layout tier (matchesEventOnLayout) now
//          covers the keys those listeners used to accept loosely (sv-SE Alt+;,
//          Ctrl+]), so the listeners are deleted with their census rows.
//          Same for the five panel/print shortcuts that named unregistered
//          commands (D2): their commands are registered now, and their
//          listeners are gone too. Cell Bookmarks keeps ONE listener, for
//          Ctrl+Shift+V off the grid (Save Current View): that key is Paste
//          Special's binding on the grid, so it cannot be a registry binding.
//          This file deliberately never calls initKeybindings: the registry is
//          EMPTY, so any effect here is an extension acting on its own.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const h = vi.hoisted(() => {
  const effects: string[] = [];
  const selectionSubs = new Set<(sel: unknown) => void>();
  return {
    effects,
    selectionSubs,
    effect: (name: string) => {
      effects.push(name);
    },
    selection: { startRow: 2, startCol: 1, endRow: 2, endCol: 1, type: "cells" },
  };
});

vi.mock("@api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api")>();
  return {
    ...real,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the real export name
    ExtensionRegistry: {
      ...real.ExtensionRegistry,
      onSelectionChange: (cb: (sel: unknown) => void) => {
        h.selectionSubs.add(cb);
        return () => h.selectionSubs.delete(cb);
      },
    },
    showDialog: () => h.effect("showDialog"),
    showOverlay: () => h.effect("showOverlay"),
    showToast: vi.fn(),
    getCommentIndicators: vi.fn(async () => []),
    getNoteIndicators: vi.fn(async () => []),
    getComment: vi.fn(async () => null),
    getNote: vi.fn(async () => null),
    addComment: vi.fn(async () => {
      h.effect("addComment");
      return { success: false };
    }),
    addNote: vi.fn(async () => {
      h.effect("addNote");
      return { success: false };
    }),
    dispatchGridAction: () => h.effect("dispatchGridAction"),
  };
});
vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  getHyperlink: vi.fn(async () => null),
  getHyperlinkIndicators: vi.fn(async () => []),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({
    selection: h.selection,
    dimensions: { hiddenRows: new Set<number>(), hiddenCols: new Set<number>() },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
    config: { totalRows: 100, totalCols: 26 },
    surface: "grid",
  }),
}));
vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  getGridBounds: vi.fn(async () => {
    h.effect("flashFill");
    return [0, 0];
  }),
}));
vi.mock("@api/lifecycleGuards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lifecycleGuards")>()),
  checkLifecycleGuards: vi.fn(async () => {
    h.effect("print");
    return true;
  }),
}));
vi.mock("../AutoFilter/lib/filterStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../AutoFilter/lib/filterStore")>()),
  toggleFilter: () => h.effect("toggleFilter"),
  refreshFilterState: vi.fn(async () => undefined),
}));
vi.mock("../Grouping/lib/groupingStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../Grouping/lib/groupingStore")>()),
  performGroupRows: () => h.effect("groupRows"),
  performUngroupRows: () => h.effect("ungroupRows"),
  resyncOutlineFromBackend: vi.fn(async () => undefined),
}));
vi.mock("../BuiltIn/CellBookmarks/lib/bookmarkStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../BuiltIn/CellBookmarks/lib/bookmarkStore")>()),
  addBookmark: () => h.effect("addBookmark"),
  removeBookmark: () => h.effect("removeBookmark"),
  hasBookmarkAt: () => false,
}));
vi.mock("../BuiltIn/CellBookmarks/lib/bookmarkNavigation", () => ({
  navigateToNextBookmark: () => {
    h.effect("nextBookmark");
    return { row: 0, col: 0 };
  },
  navigateToPrevBookmark: () => {
    h.effect("prevBookmark");
    return { row: 0, col: 0 };
  },
}));

import type { ExtensionModule } from "@api/contract";
import HyperlinksExtension from "../Hyperlinks";
import FlashFillExtension from "../FlashFill";
import AutoFilterExtension from "../AutoFilter";
import GroupingExtension from "../Grouping";
import ReviewExtension from "../Review";
import SelectVisibleCellsExtension from "../SelectVisibleCells";
import CellBookmarksExtension from "../BuiltIn/CellBookmarks";
import SearchExtension from "../Search";
import FileExplorerExtension from "../FileExplorer";
import ExtensionsManagerExtension from "../ExtensionsManager";
import PrintExtension from "../Print";
import ScriptNotebookExtension from "../ScriptNotebook";

/**
 * A context whose every door is inert, except the Activity Bar's toggle, which
 * records which view it toggled (the effect of the four panel shortcuts).
 */
function context(): never {
  const inert = (path: string): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => {
        if (prop === "then") return undefined;
        return inert(`${path}.${String(prop)}`);
      },
      apply: (_t, _this, args: unknown[]) => {
        if (path === ".ui.activityBar.toggle") h.effect(`toggle:${String(args[0])}`);
        if (path === ".invokeBackend") return Promise.resolve(null);
        return () => {};
      },
    });
  return inert("") as never;
}

/** [extension name, module] -- every extension that owns a built-in shortcut key. */
const EXTENSIONS: [string, ExtensionModule][] = [
  ["Hyperlinks", HyperlinksExtension],
  ["FlashFill", FlashFillExtension],
  ["AutoFilter", AutoFilterExtension],
  ["Grouping", GroupingExtension],
  ["Review", ReviewExtension],
  ["SelectVisibleCells", SelectVisibleCellsExtension],
  ["CellBookmarks", CellBookmarksExtension],
  ["Search", SearchExtension],
  ["FileExplorer", FileExplorerExtension],
  ["ExtensionsManager", ExtensionsManagerExtension],
  ["Print", PrintExtension],
  ["ScriptNotebook", ScriptNotebookExtension],
];

/** keydown listeners each extension put on window/document while activating. */
const keydownListeners = new Map<string, number>();

beforeAll(async () => {
  const onWindow = vi.spyOn(window, "addEventListener");
  const onDocument = vi.spyOn(document, "addEventListener");
  const keydowns = (): number =>
    [...onWindow.mock.calls, ...onDocument.mock.calls].filter((c) => c[0] === "keydown").length;
  for (const [name, ext] of EXTENSIONS) {
    const before = keydowns();
    await ext.activate(context());
    keydownListeners.set(name, keydowns() - before);
  }
  onWindow.mockRestore();
  onDocument.mockRestore();
  for (const cb of h.selectionSubs) cb(h.selection);
});

afterAll(async () => {
  for (const [, ext] of EXTENSIONS) await ext.deactivate?.();
});

beforeEach(() => {
  h.effects.length = 0;
  document.body.innerHTML = "";
  // The grid has the keyboard: where every one of these keys used to work.
  const grid = document.createElement("div");
  grid.setAttribute("data-focus-container", "spreadsheet");
  grid.tabIndex = 0;
  document.body.appendChild(grid);
  grid.focus();
});

async function press(init: KeyboardEventInit): Promise<void> {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("no extension keeps a keydown listener for a key the registry owns", () => {
  for (const [name] of EXTENSIONS) {
    const expected = name === "CellBookmarks" ? 1 : 0;
    it(`${name} installs ${expected} keydown listener(s) of its own`, () => {
      expect(
        keydownListeners.get(name),
        `${name} still listens for its own shortcut beside the registry`,
      ).toBe(expected);
    });
  }
});

describe("with NO registry binding, a built-in's default key does nothing (the registry is the one path)", () => {
  /** [label, keydown] -- each extension's former hard-coded key. */
  const KEYS: [string, KeyboardEventInit][] = [
    ["Ctrl+K (Hyperlinks)", { key: "k", ctrlKey: true }],
    ["Ctrl+E (Flash Fill)", { key: "e", ctrlKey: true }],
    ["Ctrl+Shift+L (AutoFilter)", { key: "L", ctrlKey: true, shiftKey: true }],
    ["Alt+Shift+ArrowRight (Group)", { key: "ArrowRight", altKey: true, shiftKey: true }],
    ["Alt+Shift+ArrowLeft (Ungroup)", { key: "ArrowLeft", altKey: true, shiftKey: true }],
    ["Ctrl+Alt+M (New Comment)", { key: "m", ctrlKey: true, altKey: true }],
    ["Shift+F2 (New Note)", { key: "F2", shiftKey: true }],
    ["Alt+; (Select Visible Cells)", { key: ";", altKey: true }],
    ["Ctrl+Shift+B (Toggle Bookmark)", { key: "B", ctrlKey: true, shiftKey: true }],
    ["Ctrl+] (Next Bookmark)", { key: "]", ctrlKey: true }],
    ["Ctrl+[ (Previous Bookmark)", { key: "[", ctrlKey: true }],
    ["Ctrl+Shift+H (Search)", { key: "H", ctrlKey: true, shiftKey: true }],
    ["Ctrl+Shift+E (File Explorer)", { key: "E", ctrlKey: true, shiftKey: true }],
    ["Ctrl+Shift+X (Extensions)", { key: "X", ctrlKey: true, shiftKey: true }],
    ["Ctrl+P (Print)", { key: "p", ctrlKey: true }],
    ["Ctrl+Shift+N (Notebook)", { key: "N", ctrlKey: true, shiftKey: true }],
  ];
  for (const [label, init] of KEYS) {
    it(`${label}: nothing runs`, async () => {
      await press(init);
      expect(h.effects, `${label} ran through an extension's own listener`).toEqual([]);
    });
  }

  it("positive control: Ctrl+Shift+V off the grid still opens Save Current View (Cell Bookmarks' one listener)", async () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    await press({ key: "V", ctrlKey: true, shiftKey: true });
    expect(h.effects).toEqual(["showOverlay"]);
  });
});

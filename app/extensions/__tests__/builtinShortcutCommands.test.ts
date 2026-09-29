//! FILENAME: app/extensions/__tests__/builtinShortcutCommands.test.ts
// PURPOSE: Every built-in shortcut an extension owns runs EXACTLY ONCE, through
//          a REGISTERED command, and a remap in Settings MOVES it (the new key
//          runs it, the old key no longer does).
// CONTEXT: BUG-0183 (K2). The registry's built-ins pointed at command ids no
//          extension registered -- hyperlinks.insert, flashFill.execute,
//          autofilter.toggle, bookmarks.toggle, grouping.group/ungroup,
//          review.newComment, selectVisibleCells.execute -- and "worked" only
//          because each extension's own listener ran beside the dispatcher.
//          Two of them did not even do that: the dispatcher stops a matched key
//          in the CAPTURE phase, so the BUBBLE-phase listeners of Cell
//          Bookmarks (Ctrl+Shift+B) and Select Visible Cells (Alt+;) never
//          heard it -- the shortcut did nothing. And a remap could never take a
//          key away, because the extension listener kept its hard-coded key.
//          Driven through the REAL dispatcher (initKeybindings) and the REAL
//          extensions' activation; only the final actions are doubled, so each
//          press can be counted.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const h = vi.hoisted(() => {
  const effects: { name: string; args: unknown[] }[] = [];
  const selectionSubs = new Set<(sel: unknown) => void>();
  return {
    effects,
    selectionSubs,
    effect: (name: string, ...args: unknown[]) => {
      effects.push({ name, args });
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
    showDialog: (...a: unknown[]) => h.effect("showDialog", ...a),
    showOverlay: (...a: unknown[]) => h.effect("showOverlay", ...a),
    showToast: vi.fn(),
    getCommentIndicators: vi.fn(async () => []),
    getNoteIndicators: vi.fn(async () => []),
    getComment: vi.fn(async () => null),
    getNote: vi.fn(async () => null),
    addComment: vi.fn(async (...a: unknown[]) => {
      h.effect("addComment", ...a);
      return { success: false };
    }),
    addNote: vi.fn(async (...a: unknown[]) => {
      h.effect("addNote", ...a);
      return { success: false };
    }),
    dispatchGridAction: (...a: unknown[]) => h.effect("dispatchGridAction", ...a),
  };
});
vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  getHyperlink: vi.fn(async () => null),
  getHyperlinkIndicators: vi.fn(async () => []),
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({
    selection: h.selection,
    dimensions: { hiddenRows: new Set<number>(), hiddenCols: new Set<number>() },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
    config: { totalRows: 100, totalCols: 26 },
  }),
}));
vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  getGridBounds: vi.fn(async () => {
    h.effect("flashFill");
    return [0, 0];
  }),
}));
vi.mock("../AutoFilter/lib/filterStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../AutoFilter/lib/filterStore")>()),
  toggleFilter: (...a: unknown[]) => h.effect("toggleFilter", ...a),
  refreshFilterState: vi.fn(async () => undefined),
}));
vi.mock("../Grouping/lib/groupingStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../Grouping/lib/groupingStore")>()),
  performGroupRows: (...a: unknown[]) => h.effect("groupRows", ...a),
  performUngroupRows: (...a: unknown[]) => h.effect("ungroupRows", ...a),
  performGroupColumns: (...a: unknown[]) => h.effect("groupColumns", ...a),
  performUngroupColumns: (...a: unknown[]) => h.effect("ungroupColumns", ...a),
  resyncOutlineFromBackend: vi.fn(async () => undefined),
}));
vi.mock("../BuiltIn/CellBookmarks/lib/bookmarkStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../BuiltIn/CellBookmarks/lib/bookmarkStore")>()),
  addBookmark: (...a: unknown[]) => h.effect("addBookmark", ...a),
  removeBookmark: (...a: unknown[]) => h.effect("removeBookmark", ...a),
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

import { CommandRegistry } from "@api/commands";
import {
  initKeybindings,
  getKeybinding,
  setUserKeybinding,
  resetAllKeybindings,
} from "@api/keybindings";
import HyperlinksExtension from "../Hyperlinks";
import FlashFillExtension from "../FlashFill";
import AutoFilterExtension from "../AutoFilter";
import GroupingExtension from "../Grouping";
import ReviewExtension from "../Review";
import SelectVisibleCellsExtension from "../SelectVisibleCells";
import CellBookmarksExtension from "../BuiltIn/CellBookmarks";

const EXTENSIONS = [
  HyperlinksExtension,
  FlashFillExtension,
  AutoFilterExtension,
  GroupingExtension,
  ReviewExtension,
  SelectVisibleCellsExtension,
  CellBookmarksExtension,
];

/** A context whose every door is inert, except commands, which are REAL. */
function context(): never {
  const inert = (): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert()),
      apply: () => () => {},
    });
  const base = inert() as Record<string, unknown>;
  return new Proxy(base, {
    get: (t, prop) => {
      if (prop === "commands") {
        return {
          register: (id: string, fn: (...a: unknown[]) => unknown, opts?: unknown) =>
            CommandRegistry.register(id, fn, opts as never),
          unregister: (id: string) => CommandRegistry.unregister(id),
          execute: (id: string, args?: unknown) => CommandRegistry.execute(id, args),
        };
      }
      if (prop === "invokeBackend") return vi.fn(async () => null);
      return (t as Record<string | symbol, unknown>)[prop as string];
    },
  }) as never;
}

/** [binding id, default keydown, a remap target keydown + combo, the action it must cause] */
const SHORTCUTS: [string, KeyboardEventInit, string, KeyboardEventInit, string][] = [
  ["ext.hyperlinks.insert", { key: "k", ctrlKey: true }, "Ctrl+Alt+Shift+1", { key: "1", ctrlKey: true, altKey: true, shiftKey: true }, "showDialog"],
  ["ext.flashFill", { key: "e", ctrlKey: true }, "Ctrl+Alt+Shift+2", { key: "2", ctrlKey: true, altKey: true, shiftKey: true }, "flashFill"],
  ["ext.autofilter.toggle", { key: "L", ctrlKey: true, shiftKey: true }, "Ctrl+Alt+Shift+3", { key: "3", ctrlKey: true, altKey: true, shiftKey: true }, "toggleFilter"],
  ["ext.bookmarks.toggle", { key: "B", ctrlKey: true, shiftKey: true }, "Ctrl+Alt+Shift+4", { key: "4", ctrlKey: true, altKey: true, shiftKey: true }, "addBookmark"],
  ["ext.bookmarks.next", { key: "]", ctrlKey: true }, "Ctrl+Alt+Shift+5", { key: "5", ctrlKey: true, altKey: true, shiftKey: true }, "nextBookmark"],
  ["ext.bookmarks.prev", { key: "[", ctrlKey: true }, "Ctrl+Alt+Shift+6", { key: "6", ctrlKey: true, altKey: true, shiftKey: true }, "prevBookmark"],
  ["ext.grouping.group", { key: "ArrowRight", altKey: true, shiftKey: true }, "Ctrl+Alt+Shift+8", { key: "8", ctrlKey: true, altKey: true, shiftKey: true }, "groupRows"],
  ["ext.grouping.ungroup", { key: "ArrowLeft", altKey: true, shiftKey: true }, "Ctrl+Alt+Shift+9", { key: "9", ctrlKey: true, altKey: true, shiftKey: true }, "ungroupRows"],
  ["ext.review.newComment", { key: "m", ctrlKey: true, altKey: true }, "Ctrl+Alt+Shift+F1", { key: "F1", ctrlKey: true, altKey: true, shiftKey: true }, "addComment"],
  ["ext.review.newNote", { key: "F2", shiftKey: true }, "Ctrl+Alt+Shift+F3", { key: "F3", ctrlKey: true, altKey: true, shiftKey: true }, "addNote"],
  ["ext.selectVisible", { key: ";", altKey: true }, "Ctrl+Alt+Shift+F4", { key: "F4", ctrlKey: true, altKey: true, shiftKey: true }, "dispatchGridAction"],
];

async function press(init: KeyboardEventInit): Promise<void> {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeAll(async () => {
  initKeybindings();
  for (const ext of EXTENSIONS) await ext.activate(context());
  for (const cb of h.selectionSubs) cb(h.selection);
});

afterAll(async () => {
  for (const ext of EXTENSIONS) await ext.deactivate?.();
});

beforeEach(() => {
  resetAllKeybindings();
  h.effects.length = 0;
  document.body.innerHTML = "";
  // A ribbon button has the keyboard: not a text field, not the grid -- the
  // place every one of these keys must still work from.
  const button = document.createElement("button");
  document.body.appendChild(button);
  button.focus();
});

describe("built-in extension shortcuts are REGISTERED commands", () => {
  for (const [id] of SHORTCUTS) {
    it(`${id}: the command its binding names is registered`, () => {
      const binding = getKeybinding(id);
      expect(binding, `${id} is not a registry binding`).toBeDefined();
      expect(
        CommandRegistry.has(binding!.commandId),
        `${id} points at '${binding!.commandId}', which nothing registers`,
      ).toBe(true);
    });
  }
});

describe("the default key runs it exactly once", () => {
  for (const [id, init, , , effect] of SHORTCUTS) {
    it(`${id}: one ${effect}`, async () => {
      await press(init);
      expect(h.effects.map((e) => e.name), `${id} did not run exactly once`).toEqual([effect]);
    });
  }
});

describe("Ctrl+Shift+V off the grid (Save Current View -- not a registry binding: Paste Special owns the key on the grid)", () => {
  it("still opens Save View exactly once, through Cell Bookmarks' own listener", async () => {
    await press({ key: "V", ctrlKey: true, shiftKey: true });
    expect(h.effects.map((e) => e.name)).toEqual(["showOverlay"]);
  });
});

describe("a remap in Settings MOVES the shortcut", () => {
  for (const [id, init, combo, remapped, effect] of SHORTCUTS) {
    it(`${id}: the old key does nothing, the new key (${combo}) runs it once`, async () => {
      setUserKeybinding(id, combo);
      await press(init);
      expect(h.effects.map((e) => e.name), `the old key still ran ${id} after a remap`).toEqual([]);
      await press(remapped);
      expect(h.effects.map((e) => e.name)).toEqual([effect]);
    });
  }
});

// A SYMBOL key's Shift and AltGr are decided by the keyboard LAYOUT, not by the
// user. On sv-SE ";" is Shift+comma, and "]" / "[" are AltGr+9 / AltGr+8
// (AltGr arrives as Ctrl+Alt on Windows), so Excel's Alt+; is typed as
// Alt+Shift+comma and Ctrl+] as Ctrl+AltGr+9. The extensions' own listeners
// accepted the character whatever the extra modifier; once they stood aside
// for the registry (above), the registry's exact-modifier match made all three
// dead keys on the owner's own layout (review of BUG-0183).
describe("symbol shortcuts on a layout where the symbol itself needs Shift or AltGr (sv-SE)", () => {
  const LAYOUT_CASES: [string, KeyboardEventInit, string][] = [
    ["Alt+; typed as Alt+Shift+comma", { key: ";", altKey: true, shiftKey: true }, "dispatchGridAction"],
    ["Ctrl+] typed as Ctrl+AltGr+9", { key: "]", ctrlKey: true, altKey: true }, "nextBookmark"],
    ["Ctrl+[ typed as Ctrl+AltGr+8", { key: "[", ctrlKey: true, altKey: true }, "prevBookmark"],
  ];
  for (const [label, init, effect] of LAYOUT_CASES) {
    it(`${label}: one ${effect}`, async () => {
      await press(init);
      expect(h.effects.map((e) => e.name), `${label} did not run exactly once`).toEqual([effect]);
    });
  }

  it("a letter's Shift still MEANS something: Ctrl+Shift+E is not Ctrl+E (Flash Fill)", async () => {
    await press({ key: "E", ctrlKey: true, shiftKey: true });
    expect(h.effects.map((e) => e.name)).toEqual([]);
  });

  it("an arrow's Shift still means something: Alt+ArrowRight is not Alt+Shift+ArrowRight (Group)", async () => {
    await press({ key: "ArrowRight", altKey: true });
    expect(h.effects.map((e) => e.name)).toEqual([]);
  });

  it("Alt is not AltGr: Alt+] (no Ctrl) is not Ctrl+] (next bookmark)", async () => {
    await press({ key: "]", altKey: true });
    expect(h.effects.map((e) => e.name)).toEqual([]);
  });
});

//! FILENAME: app/extensions/BuiltIn/__tests__/builtinCommandsLifecycle.test.ts
// PURPOSE: Every command a built-in (BuiltIn/) extension registers on activate
//          is gone after deactivate -- the whole folder, not only the one where
//          it was first noticed.
// CONTEXT: D3 (wa-keys fixup) found Cell Bookmarks never unregistering its
//          commands; the same audit found Find & Replace (core.edit.find /
//          replace), Format Cells (core.format.cells), Format Painter
//          (core.format.painter / painterLock) and Collection Preview doing the
//          same. A deactivated extension kept answering CommandRegistry.execute
//          -- the keybinding registry's Ctrl+F, Ctrl+1 and Ctrl+Shift+C still
//          ran it -- and a re-activate registered each id over the stale one.
//          The ids are read from what activate ACTUALLY registered, so a
//          command added later is covered without editing this file.

import { describe, it, expect, vi } from "vitest";

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));

import type { ExtensionModule } from "@api/contract";
import { CommandRegistry } from "@api/commands";
import CellBookmarks from "../CellBookmarks";
import FindReplaceDialog from "../FindReplaceDialog";
import FormatCellsDialog from "../FormatCellsDialog";
import FormatPainter from "../FormatPainter";
import CollectionPreview from "../CollectionPreview";
import PasteSpecial from "../PasteSpecial";
import StandardMenus from "../StandardMenus";

/** Every door inert, except `commands`, which are REAL and recorded. */
function recordingContext(registered: string[]): never {
  const inert = (): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert()),
      apply: () => () => {},
    });
  return new Proxy(inert() as Record<string, unknown>, {
    get: (t, prop) => {
      if (prop === "commands") {
        return {
          register: (id: string, fn: (...a: unknown[]) => unknown, opts?: unknown) => {
            registered.push(id);
            CommandRegistry.register(id, fn, opts as never);
          },
          unregister: (id: string) => CommandRegistry.unregister(id),
          execute: (id: string, args?: unknown) => CommandRegistry.execute(id, args),
          has: (id: string) => CommandRegistry.has(id),
        };
      }
      if (prop === "invokeBackend") return vi.fn(async () => null);
      return (t as Record<string | symbol, unknown>)[prop as string];
    },
  }) as never;
}

const EXTENSIONS: [string, ExtensionModule][] = [
  ["Cell Bookmarks", CellBookmarks],
  ["Find & Replace", FindReplaceDialog],
  ["Format Cells", FormatCellsDialog],
  ["Format Painter", FormatPainter],
  ["Collection Preview", CollectionPreview],
  ["Paste Special", PasteSpecial],
  ["Standard Menus", StandardMenus],
];

describe("a built-in extension's commands live exactly as long as the extension", () => {
  for (const [name, ext] of EXTENSIONS) {
    it(`${name}: deactivate unregisters every command activate registered`, async () => {
      const registered: string[] = [];
      await ext.activate(recordingContext(registered));
      try {
        expect(registered.length, `${name} registered no command -- the census has nothing to check`).toBeGreaterThan(0);
        expect(registered.filter((id) => !CommandRegistry.has(id))).toEqual([]);
      } finally {
        await ext.deactivate?.();
      }
      expect(
        registered.filter((id) => CommandRegistry.has(id)),
        `${name} left these registered after deactivate`,
      ).toEqual([]);
    });
  }
});

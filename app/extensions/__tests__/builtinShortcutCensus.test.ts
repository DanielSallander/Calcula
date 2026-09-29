//! FILENAME: app/extensions/__tests__/builtinShortcutCensus.test.ts
// PURPOSE: Every BUILT-IN keybinding names a command that something in the
//          tree actually REGISTERS -- read from the source, so a binding that
//          points at nothing cannot ship quietly again.
// CONTEXT: BUG-0183 (K2). Eight built-ins named command ids nothing registered
//          (hyperlinks.insert, flashFill.execute, autofilter.toggle,
//          bookmarks.toggle, grouping.group/ungroup, review.newComment,
//          selectVisibleCells.execute). The dispatcher matched the key, took
//          it, and executed nothing; the extensions' own listeners hid it for
//          some keys and not for others (Ctrl+Shift+B and Alt+; did nothing at
//          all), and none of them could be remapped. builtinShortcutCommands
//          proves the fixed eight end to end; this census covers EVERY
//          built-in, including the ones whose extensions another change owns.
//          Wave B (D2) registered the last five (the panel toggles and Print;
//          panelShortcutCommands proves them end to end), so no built-in is
//          exempt any more.
//
//          The scan is deliberately crude (a regex over the file text), the
//          same shape as the global-listener census: a registration hidden
//          behind an indirection this cannot see is one a reviewer cannot see
//          either. Recognised: `register("id", ...)`, `register(CONST, ...)`
//          with `const CONST = "id"` anywhere in the tree, `register(
//          CoreCommands.KEY, ...)`, and the CoreCommands the grid-command bridge
//          routes (api/commands.ts GRID_COMMAND_MAP).

import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { initKeybindings, getAllKeybindings } from "@api/keybindings";
import { CoreCommands } from "@api/commands";

/** app/ -- this file is app/extensions/__tests__/. */
const APP_ROOT = path.resolve(__dirname, "../..");

/**
 * Built-ins whose command is STILL unregistered. EMPTY since wave B (D2): the
 * last five -- search.openFindReplace, fileExplorer.toggle,
 * extensionsManager.toggle, print.preview, scriptNotebook.toggle -- worked
 * only through their extensions' own window listeners (so a remap in Settings
 * could not move them); their commands are registered now and the listeners
 * are gone. The list may only SHRINK: the last test fails if one of these
 * becomes registered, so a fix removes it here. Do not add to it -- register
 * the command instead.
 */
const KNOWN_UNREGISTERED: Readonly<Record<string, string>> = {};

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "dist") continue;
        walk(p);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
        out.push(p);
      }
    }
  };
  walk(path.join(APP_ROOT, "src"));
  walk(path.join(APP_ROOT, "extensions"));
  return out;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let registered: Set<string>;

beforeAll(() => {
  initKeybindings();
  const sources = sourceFiles().map((f) => fs.readFileSync(f, "utf8"));
  const all = sources.join("\n");
  registered = new Set<string>();

  // String constants anywhere in the tree: NAME -> "id".
  const constants = new Map<string, string>();
  for (const m of all.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*["'`]([^"'`]+)["'`]/g)) {
    constants.set(m[1], m[2]);
  }

  for (const binding of getAllKeybindings()) {
    if (binding.source !== "built-in") continue;
    const id = binding.commandId;
    const literal = new RegExp(`register\\(\\s*["'\`]${esc(id)}["'\`]`);
    const viaConstant = [...constants.entries()]
      .filter(([, value]) => value === id)
      .some(([name]) => new RegExp(`register\\(\\s*${esc(name)}\\b`).test(all));
    const coreKey = Object.entries(CoreCommands).find(([, value]) => value === id)?.[0];
    const viaCore = coreKey !== undefined && new RegExp(`register\\(\\s*CoreCommands\\.${coreKey}\\b`).test(all);
    if (literal.test(all) || viaConstant || viaCore) registered.add(id);
  }

  // The CoreCommands the grid-command bridge routes (Spreadsheet.tsx registers
  // their grid handlers).
  const commandsSource = fs.readFileSync(path.join(APP_ROOT, "src/api/commands.ts"), "utf8");
  const start = commandsSource.indexOf("const GRID_COMMAND_MAP");
  const body = commandsSource.slice(start, commandsSource.indexOf("};", start));
  for (const m of body.matchAll(/\[CoreCommands\.([A-Z_]+)\]/g)) {
    registered.add((CoreCommands as Record<string, string>)[m[1]]);
  }
});

describe("built-in keybindings name registered commands", () => {
  it("the scan reads something (it recognises the registrations it must)", () => {
    for (const id of ["core.file.save", "core.format.painter", "core.clipboard.copy", "bookmarks.next"]) {
      expect(registered.has(id), `the census cannot see ${id}'s registration`).toBe(true);
    }
  });

  it("every built-in binding's command is registered, except the listed ones", () => {
    const unregistered = getAllKeybindings()
      .filter((b) => b.source === "built-in" && !registered.has(b.commandId))
      .map((b) => `${b.id} -> ${b.commandId}`)
      .filter((row) => !Object.keys(KNOWN_UNREGISTERED).some((id) => row.endsWith(`-> ${id}`)));
    expect(unregistered, "a built-in shortcut points at a command nothing registers").toEqual([]);
  });

  it("the known-unregistered list only shrinks (a fixed one is removed from it)", () => {
    const nowRegistered = Object.keys(KNOWN_UNREGISTERED).filter((id) => registered.has(id));
    expect(nowRegistered, "registered now: remove from KNOWN_UNREGISTERED").toEqual([]);
  });
});

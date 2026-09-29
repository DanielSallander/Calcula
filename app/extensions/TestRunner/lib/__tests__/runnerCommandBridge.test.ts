//! FILENAME: app/extensions/TestRunner/lib/__tests__/runnerCommandBridge.test.ts
// PURPOSE: A suite's `ctx.executeCommand` reaches a command in EITHER registry,
//          and a command no registry holds fails the test LOUDLY.
// CONTEXT: Y9 (wave E; wave D lifecycle fix-up NEW defect 2). The test context
//          ran `CommandRegistry.execute` only. The Checkbox extension registers
//          `checkbox.toggle` with the EXTENSION registry, so the checkbox suite
//          "toggled" nothing -- and CommandRegistry.execute on an unknown id is
//          a silent no-op (a warning and `undefined`), so a dead command id in a
//          suite read exactly like a working one. Real @api registries; only
//          the runner's cell/grid helpers are doubled.
//          The census of dead ids was a hand-typed list, and it missed one:
//          "Excel Gap Features" ran `view.toggleDisplayZeros`, which only
//          Core's keyboard switch knows, so the fixed runner turned that test
//          into an ERROR (wave E review finding 1). The census now DERIVES both
//          sides from the sources: every id a suite executes must be one some
//          product source registers.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

vi.mock("@api", () => ({
  getCell: vi.fn(),
  getViewportCells: vi.fn().mockResolvedValue([]),
  updateCellsBatch: vi.fn(),
  CommandRegistry: { execute: vi.fn(), has: vi.fn().mockReturnValue(false) },
  CoreCommands: { UNDO: "core.edit.undo", REDO: "core.edit.redo" },
  dispatchGridAction: vi.fn(),
}));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: vi.fn().mockReturnValue({ selection: null }),
  setSelection: vi.fn(),
}));

import { registerSuite, clearSuites, runSuiteByName } from "../runner";
import type { TestContext } from "../types";
import { CommandRegistry } from "@api/commands";
import {
  registerExtensionRegistryService,
  type CommandDefinition,
  type ExtensionRegistryService,
} from "@api/extensions";

const extensionCommands = new Map<string, CommandDefinition>();
registerExtensionRegistryService({
  registerCommand: (c: CommandDefinition) => void extensionCommands.set(c.id, c),
  unregisterCommand: (c: CommandDefinition) => void extensionCommands.delete(c.id),
  getCommand: (id: string) => extensionCommands.get(id),
  getAllCommands: () => [...extensionCommands.values()],
} as unknown as ExtensionRegistryService);

// ----------------------------------------------------------------------------
// Command-id census. Which ids does ANY source register, and which ids do the
// suites execute? Derived from the sources, so a new suite or a new dead id is
// caught without anyone updating a list. A registration is:
//   - `commands.register(X, ...)` / `CommandRegistry.register(X, ...)`, X a
//     string literal, `CoreCommands.NAME`, or a constant declared with a
//     string literal;
//   - an `id: X` in a file that calls `registerCommand(` (the extension
//     registry takes a CommandDefinition object);
//   - a key of GRID_COMMAND_MAP (@api/commands' grid-command bridge).
// Tests, and the TestRunner itself, register nothing.
// ----------------------------------------------------------------------------

const APP = path.resolve(__dirname, "../../../..");

function readNormalized(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function productSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "TestRunner") continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        out.push(full);
      }
    }
  };
  walk(path.join(APP, "src"));
  walk(path.join(APP, "extensions"));
  return out;
}

/** CoreCommands NAME -> id, read from @api/commands. */
function coreCommandIds(): Map<string, string> {
  const src = readNormalized(path.join(APP, "src/api/commands.ts"));
  const block = src.slice(src.indexOf("export const CoreCommands = {"), src.indexOf("} as const;"));
  const map = new Map<string, string>();
  for (const m of block.matchAll(/(\w+):\s*"([^"]+)"/g)) map.set(m[1], m[2]);
  return map;
}

function registeredCommandIds(): Set<string> {
  const core = coreCommandIds();
  const ids = new Set<string>();
  const commandsSrc = readNormalized(path.join(APP, "src/api/commands.ts"));
  const bridge = commandsSrc.slice(commandsSrc.indexOf("const GRID_COMMAND_MAP"), commandsSrc.indexOf("};", commandsSrc.indexOf("const GRID_COMMAND_MAP")));
  for (const m of bridge.matchAll(/\[CoreCommands\.(\w+)\]/g)) ids.add(core.get(m[1])!);

  const files = productSources().map((f) => ({ f, src: readNormalized(f) }));
  const exportedConsts = new Map<string, string>();
  for (const { src } of files) {
    for (const m of src.matchAll(/export\s+const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*["']([^"']+)["']/g)) {
      exportedConsts.set(m[1], m[2]);
    }
  }
  const resolve = (token: string, src: string): string | undefined => {
    const lit = /^["'](.+)["']$/.exec(token);
    if (lit) return lit[1];
    const coreRef = /^CoreCommands\.(\w+)$/.exec(token);
    if (coreRef) return core.get(coreRef[1]);
    if (/^[A-Z][A-Z0-9_]*$/.test(token)) {
      const local = new RegExp(`(?:const|let)\\s+${token}\\s*(?::[^=]+)?=\\s*["']([^"']+)["']`).exec(src);
      return local ? local[1] : exportedConsts.get(token);
    }
    return undefined;
  };
  for (const { src } of files) {
    for (const m of src.matchAll(/\b(?:commands|CommandRegistry)\.register\(\s*("[^"]*"|'[^']*'|[A-Za-z_$][\w$.]*)/g)) {
      const id = resolve(m[1], src);
      if (id) ids.add(id);
    }
    if (/\bregisterCommand\(/.test(src)) {
      for (const m of src.matchAll(/\bid:\s*("[^"]*"|'[^']*'|[A-Z][A-Z0-9_]*)/g)) {
        const id = resolve(m[1], src);
        if (id) ids.add(id);
      }
    }
  }
  return ids;
}

/** Every `executeCommand(<arg>` in the suites, resolved to an id where it can be. */
function suiteCommandIds(): { ids: Array<{ file: string; id: string }>; unresolved: string[] } {
  const core = coreCommandIds();
  const dir = path.resolve(__dirname, "../suites");
  const ids: Array<{ file: string; id: string }> = [];
  const unresolved: string[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    // Comments may NAME executeCommand without calling it (flashFill.ts does).
    const src = readNormalized(path.join(dir, file))
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join("\n");
    for (const m of src.matchAll(/\bexecuteCommand\(\s*([^,)]*)/g)) {
      const token = m[1].trim();
      const lit = /^["'](.+)["']$/.exec(token);
      const coreRef = /^CoreCommands\.(\w+)$/.exec(token);
      const id = lit ? lit[1] : coreRef ? core.get(coreRef[1]) : undefined;
      if (id) ids.push({ file, id });
      else unresolved.push(`suites/${file}: executeCommand(${token}`);
    }
  }
  return { ids, unresolved };
}

/** Run one test body as a registered suite and return its result. */
async function runOne(body: (ctx: TestContext) => Promise<void>) {
  clearSuites();
  registerSuite({ name: "Bridge", tests: [{ name: "t", run: body }] });
  const result = await runSuiteByName("Bridge");
  return result!.results[0];
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  extensionCommands.clear();
});

afterEach(() => {
  CommandRegistry.unregister("test.bridge.local");
  vi.restoreAllMocks();
});

describe("TestRunner ctx.executeCommand", () => {
  it("runs an EXTENSION-registry command (checkbox.toggle lives there)", async () => {
    const toggled = vi.fn();
    extensionCommands.set("checkbox.toggle", { id: "checkbox.toggle", name: "Toggle", execute: toggled });
    const r = await runOne(async (ctx) => {
      await ctx.executeCommand("checkbox.toggle");
    });
    expect(toggled, "the suite's executeCommand never reached the extension registry").toHaveBeenCalledTimes(1);
    expect(r.status).toBe("pass");
  });

  it("still runs a CommandRegistry command, with its args unchanged (positive control)", async () => {
    const handler = vi.fn();
    CommandRegistry.register("test.bridge.local", handler);
    const r = await runOne(async (ctx) => {
      await ctx.executeCommand("test.bridge.local", { n: 1 });
    });
    expect(handler).toHaveBeenCalledWith({ n: 1 });
    expect(r.status).toBe("pass");
  });

  it("the checkbox suite makes its checkboxes itself -- `checkbox.insert` is registered nowhere", () => {
    const src = fs
      .readFileSync(path.resolve(__dirname, "../suites/checkbox.ts"), "utf8")
      .replace(/\r\n/g, "\n");
    expect(src, "the suite still runs the dead checkbox.insert id").not.toMatch(/executeCommand\("checkbox\.insert"\)/);
    expect(src, "the suite no longer sets the legacy checkbox style flag").toMatch(/applyFormatting\([^)]*\{ checkbox: true \}\)/);
    expect(src).toMatch(/executeCommand\("checkbox\.toggle"\)/);
  });

  it("the census below SEES every registration spelling in use, and sees the dead ids as dead", () => {
    const registered = registeredCommandIds();
    for (const id of [
      "checkbox.toggle", // ExtensionRegistry.registerCommand({ id: CONST })
      "core.format.painter", // context.commands.register(CoreCommands.FORMAT_PAINTER, ...)
      "core.clipboard.pasteValues", // PasteSpecial, same spelling
      "core.edit.undo", // CommandRegistry.register(CoreCommands.UNDO, ...) in Core
      "core.edit.clearAll", // the grid-command bridge (GRID_COMMAND_MAP)
      "core.clipboard.copy", // the grid-command bridge
    ]) {
      expect(registered.has(id), `the census cannot see the registration of ${id}`).toBe(true);
    }
    // Ids a suite once ran that NOTHING registers: Core's keyboard switch
    // handling `view.toggleDisplayZeros` is not a registration.
    for (const id of ["view.toggleDisplayZeros", "format.bold", "formatting.bold", "formatting.italic", "checkbox.insert"]) {
      expect(registered.has(id), `the census counts the dead id ${id} as registered`).toBe(false);
    }
  });

  it("no suite runs a command id that no registry holds (derived from the sources, not a hand-typed list)", () => {
    const registered = registeredCommandIds();
    const { ids, unresolved } = suiteCommandIds();
    expect(ids.length, "the census found no executeCommand call in any suite").toBeGreaterThan(10);
    expect(
      unresolved,
      "a suite's executeCommand argument is neither a string literal nor CoreCommands.X -- the census cannot check it",
    ).toEqual([]);
    const dead = ids.filter((u) => !registered.has(u.id)).map((u) => `suites/${u.file}: ${u.id}`);
    expect(dead, "a suite executes a command id NO registry holds: the runner fails it (and it used to pass vacuously)").toEqual([]);
  });

  it("a command NO registry holds fails the test loudly, naming the id", async () => {
    const r = await runOne(async (ctx) => {
      await ctx.executeCommand("checkbox.insert");
    });
    expect(r.status, "a dead command id passed silently").toBe("error");
    expect(r.error).toMatch(/checkbox\.insert/);
  });
});

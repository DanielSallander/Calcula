//! FILENAME: app/src/api/__tests__/gridCommandDrift.test.ts
// PURPOSE: The grid commands an extension can NAME (@api/extensions'
//          `GridCommand`, `GRID_COMMANDS`) are Core's, by derivation -- never a
//          copied union that drifts.
// CONTEXT: api/extensions.ts carried its own `GridCommand` union under a "MUST
//          match core/lib/gridCommands.ts exactly" banner, and it had drifted to
//          8 of Core's 18 commands. An extension could therefore not even name
//          the fill, merge or clear-formatting doors to guard them: a floating
//          grid's selected cell left those ribbon/menu doors acting on Core's
//          HIDDEN active cell (review round 2, 2026-09-27). Types are erased at
//          run time and the type-check gate does not compile tests, so the
//          derivation is pinned from the source text and from the one runtime
//          list both layers share.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { GRID_COMMANDS as API_GRID_COMMANDS } from "../extensions";
import { GRID_COMMANDS as CORE_GRID_COMMANDS } from "../../core/lib/gridCommands";

const API_EXTENSIONS = path.resolve(__dirname, "../extensions.ts");
const CORE_GRID = path.resolve(__dirname, "../../core/lib/gridCommands.ts");
const API_COMMANDS = path.resolve(__dirname, "../commands.ts");

describe("@api GridCommand is DERIVED from Core", () => {
  it("api/extensions.ts declares no union of its own and re-exports Core's type, guard type and list", () => {
    const source = readFileSync(API_EXTENSIONS, "utf8");
    expect(source, "a hand-written GridCommand union is back in @api").not.toMatch(/export\s+type\s+GridCommand\s*=/);
    expect(source, "a hand-written CommandGuard is back in @api").not.toMatch(/export\s+type\s+CommandGuard\s*=/);
    expect(source).toMatch(
      /export\s+type\s*\{\s*GridCommand\s*,\s*CommandGuard\s*\}\s*from\s*"\.\.\/core\/lib\/gridCommands"/,
    );
    expect(source).toMatch(/export\s*\{\s*GRID_COMMANDS\s*\}\s*from\s*"\.\.\/core\/lib\/gridCommands"/);
  });

  it("Core's type is derived from its runtime list (one list, not a list and a union)", () => {
    const source = readFileSync(CORE_GRID, "utf8");
    expect(source).toMatch(/export\s+type\s+GridCommand\s*=\s*\(typeof\s+GRID_COMMANDS\)\[number\];/);
  });

  it("the list @api hands out IS Core's list, with no duplicates", () => {
    expect(API_GRID_COMMANDS).toBe(CORE_GRID_COMMANDS);
    expect(new Set(API_GRID_COMMANDS).size).toBe(API_GRID_COMMANDS.length);
    // The doors the drift used to hide.
    for (const command of ["fillDown", "fillRight", "fillUp", "fillLeft", "mergeCells", "unmergeCells", "clearFormatting", "clearAll"]) {
      expect(API_GRID_COMMANDS, command).toContain(command);
    }
  });

  it("every command the CoreCommands bridge (api/commands.ts GRID_COMMAND_MAP) routes to is in the list, and vice versa", () => {
    const source = readFileSync(API_COMMANDS, "utf8");
    const start = source.indexOf("const GRID_COMMAND_MAP");
    expect(start, "GRID_COMMAND_MAP was not found -- this guard reads nothing").toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("};", start));
    const bridged = [...body.matchAll(/\]:\s*"([A-Za-z]+)"/g)].map((m) => m[1]);
    expect(bridged.length, "GRID_COMMAND_MAP parsed as empty").toBeGreaterThan(10);
    expect([...bridged].sort()).toEqual([...CORE_GRID_COMMANDS].sort());
  });
});

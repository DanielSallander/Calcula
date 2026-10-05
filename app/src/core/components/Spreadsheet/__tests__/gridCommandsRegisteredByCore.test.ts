//! FILENAME: app/src/core/components/Spreadsheet/__tests__/gridCommandsRegisteredByCore.test.ts
// PURPOSE: Every grid command has a handler that Core registers -- and
//          unregisters -- so no CoreCommands id bridged to the grid is a dead
//          door. Derived from the sources, not listed.
// CONTEXT: (Home tab = Excel's Home tab, 2026-10-04.) GRID_COMMANDS gained
//          `autoFitRowHeight`, `autoFitColumnWidth` and `removeHyperlinks`. A
//          name added to the list and the bridge but never REGISTERED is the
//          worst kind of dead door: `CommandRegistry.execute` answers it with
//          a console warning, the ribbon shows an enabled item that does
//          nothing, and gridCommandDrift.test.ts (list <-> bridge) stays green.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { GRID_COMMANDS } from "../../../lib/gridCommands";

const CORE = path.resolve(__dirname, "../../..");

/** Source text with whole-line comments removed (a comment may NAME a call). */
function code(file: string): string {
  return fs
    .readFileSync(path.join(CORE, file), "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const SOURCES = ["components/Spreadsheet/Spreadsheet.tsx", "components/Spreadsheet/useSpreadsheetSelection.ts"];

function names(pattern: RegExp): Set<string> {
  const out = new Set<string>();
  for (const file of SOURCES) {
    for (const m of code(file).matchAll(pattern)) out.add(m[1]);
  }
  return out;
}

const registered = names(/\bgridCommands\.register\(\s*"([A-Za-z]+)"/g);
const unregistered = names(/\bgridCommands\.unregister\(\s*"([A-Za-z]+)"/g);

describe("Core registers a handler for every grid command", () => {
  it("sees what it claims to see (self-check: the scan is not vacuous)", () => {
    expect(registered).toContain("clearAll");
    expect(registered).toContain("fillDown");
    expect(registered.size).toBeGreaterThan(15);
  });

  it.each([...GRID_COMMANDS])("%s is registered, and unregistered on unmount", (command) => {
    expect(registered, `no Core source registers the grid command "${command}"`).toContain(command);
    expect(unregistered, `"${command}" is never unregistered: a stale handler would outlive its grid`).toContain(command);
  });

  it("nothing registers a name that is not a grid command", () => {
    const known = new Set<string>(GRID_COMMANDS);
    expect([...registered].filter((n) => !known.has(n))).toEqual([]);
  });
});

//! FILENAME: app/src/core/components/Spreadsheet/__tests__/coreCommandDoorsRegistered.test.ts
// PURPOSE: Every command Core's grid keyboard sends is ANSWERED: either Core's
//          own handleCommand switch handles it, or some product source
//          registers the id it lands on. Derived from the sources, not listed.
// CONTEXT: Z9 (wave F; wave E core report NEW 1). F11 (Insert Chart) did
//          nothing: useGridKeyboard sends "insert.chart", and handleCommand
//          (useSpreadsheetSelection.ts) forwarded it to
//          `CommandRegistry.execute('charts.insertChart')` -- an id NO source
//          registered, and CommandRegistry.execute answers an unknown id with a
//          console warning and nothing else. The TestRunner census
//          (extensions/TestRunner/lib/__tests__/runnerCommandBridge.test.ts)
//          caught the same class for the suites' executeCommand ids; this is
//          the same derivation pointed at Core's keyboard door:
//            - SENT: every `onCommand('<id>')` literal in useGridKeyboard.ts,
//              plus the SHIFTED_DIGIT_COMMANDS map (Ctrl+Shift+1..6); an
//              onCommand argument the census cannot resolve fails it;
//            - HANDLED: the `case '<id>':` labels of handleCommand;
//            - FORWARDED: every `CommandRegistry.execute('<id>')` inside
//              handleCommand;
//            - REGISTERED: the TestRunner census's rule -- `commands.register` /
//              `CommandRegistry.register` with a literal, a `CoreCommands.X` or
//              a string constant; an `id:` in a file that calls
//              `registerCommand(` (the extension registry); a GRID_COMMAND_MAP
//              key.
//          A SENT id Core does not handle goes to handleCommand's default,
//          `executeCommandAnywhere` (either registry), so it must be
//          REGISTERED; so must every FORWARDED id.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const APP = path.resolve(__dirname, "../../../../..");

function readNormalized(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/** Source text with whole-line comments removed (a comment may NAME a call). */
function code(file: string): string {
  return readNormalized(file)
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
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
  const bridgeAt = commandsSrc.indexOf("const GRID_COMMAND_MAP");
  const bridge = commandsSrc.slice(bridgeAt, commandsSrc.indexOf("};", bridgeAt));
  for (const m of bridge.matchAll(/\[CoreCommands\.(\w+)\]/g)) ids.add(core.get(m[1])!);

  const files = productSources().map((f) => ({ f, src: code(f) }));
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

/** The ids Core's grid keyboard sends through onCommand. */
function sentByKeyboard(): { ids: Set<string>; unresolved: string[] } {
  const src = code(path.join(APP, "src/core/hooks/useGridKeyboard.ts"));
  const ids = new Set<string>();
  const unresolved: string[] = [];
  const digitsAt = src.indexOf("const SHIFTED_DIGIT_COMMANDS");
  const digits = src.slice(digitsAt, src.indexOf("]);", digitsAt));
  for (const m of digits.matchAll(/\["\d",\s*"([^"]+)"\]/g)) ids.add(m[1]);
  for (const m of src.matchAll(/\bonCommand\(\s*([^)]*)\)/g)) {
    const token = m[1].trim();
    const lit = /^["'](.+)["']$/.exec(token);
    if (lit) ids.add(lit[1]);
    else if (token !== "digitCommand" && token !== "command") unresolved.push(`onCommand(${token})`);
  }
  return { ids, unresolved };
}

/** handleCommand's own case labels, and the ids it forwards to CommandRegistry. */
function handleCommandDoors(): { handled: Set<string>; forwarded: string[] } {
  const src = code(path.join(APP, "src/core/components/Spreadsheet/useSpreadsheetSelection.ts"));
  const start = src.indexOf("const handleCommand = useCallback(");
  const end = src.indexOf("useGridKeyboard({", start);
  const body = src.slice(start, end);
  const handled = new Set([...body.matchAll(/\bcase\s+'([^']+)'\s*:/g)].map((m) => m[1]));
  const forwarded = [...body.matchAll(/\bCommandRegistry\.execute\(\s*'([^']+)'/g)].map((m) => m[1]);
  return { handled, forwarded };
}

const registered = registeredCommandIds();
const sent = sentByKeyboard();
const doors = handleCommandDoors();

describe("Core's keyboard command doors are all answered (derived census)", () => {
  it("sees what it claims to see (self-check: the scan is not vacuous)", () => {
    expect(registered.size, "the registration scan found too few ids to be working").toBeGreaterThan(100);
    expect(sent.ids, "the keyboard scan missed Ctrl+B").toContain("format.toggleBold");
    expect(sent.ids, "the keyboard scan missed Ctrl+Shift+4").toContain("format.numberCurrency");
    expect(sent.ids, "the keyboard scan missed bare Space").toContain("checkbox.toggle");
    expect(sent.ids, "the keyboard scan missed F11").toContain("insert.chart");
    expect(doors.handled, "the handleCommand scan missed its own cases").toContain("format.toggleBold");
    expect(doors.forwarded, "the handleCommand scan missed Ctrl+Alt+V's forward").toContain(
      "core.clipboard.pasteSpecial",
    );
    // Each registration style is seen: the extension registry's `id:` (Checkbox),
    // a CoreCommands.X (Paste Special) and a GRID_COMMAND_MAP key.
    expect(registered).toContain("checkbox.toggle");
    expect(registered).toContain("core.clipboard.pasteSpecial");
    expect(registered).toContain("core.edit.undo");
  });

  it("every onCommand argument resolves to an id", () => {
    expect(sent.unresolved, "the census cannot tell which command these send").toEqual([]);
  });

  it("every id handleCommand FORWARDS is registered by some source", () => {
    const dead = doors.forwarded.filter((id) => !registered.has(id));
    expect(dead, "handleCommand forwards these to CommandRegistry, which no source registers -- the key does nothing").toEqual(
      [],
    );
  });

  it("every id the keyboard sends that Core does not handle itself is registered by some source", () => {
    const dead = [...sent.ids].filter((id) => !doors.handled.has(id) && !registered.has(id));
    expect(dead, "these keys reach handleCommand's default, and no registry holds their id -- the key does nothing").toEqual(
      [],
    );
  });
});

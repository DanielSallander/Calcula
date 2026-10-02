//! FILENAME: app/src/api/__tests__/heldButtonCode.test.ts
// PURPOSE: The frontend's reading of a working copy's HELD button code
//          (BUG-0257) -- and that its key names are the backend's.
// CONTEXT: Checkout keeps an application's button code in `heldOnSelect` /
//          `heldMacroRef`, stamped `heldFrom`, and no click reads those keys.
//          The UI must SHOW that code (Properties pane, Code in This File, the
//          approval screen) and never mistake a held button for an unbound
//          one; what a CLICK on it says is the Rust button door's answer.

import { describe, it, expect } from "vitest";
import nodeFs from "node:fs";
import nodePath from "node:path";
import {
  HELD_CONTROL_PROPERTIES,
  HELD_FROM_PROPERTY,
  HELD_MACRO_REF_PROPERTY,
  HELD_ON_SELECT_PROPERTY,
  cellA1,
  parseHeldFrom,
  readHeldButtonCode,
} from "../heldButtonCode";

const stamp = JSON.stringify({ workspace: "c:/ws", application: "Sales", version: "1.2.0" });
const s = (value: string) => ({ valueType: "static", value });

describe("the held compartment, as the UI reads it", () => {
  it("reads held inline code and a held macro link with their application", () => {
    const held = readHeldButtonCode({
      text: s("Go"),
      [HELD_ON_SELECT_PROPERTY]: s("Report();"),
      [HELD_MACRO_REF_PROPERTY]: s("macro-report"),
      [HELD_FROM_PROPERTY]: s(stamp),
    });
    expect(held).toEqual({
      application: "Sales",
      version: "1.2.0",
      onSelect: "Report();",
      macroRef: "macro-report",
    });
  });

  it("is null for a button that holds nothing -- a stamp alone is not code", () => {
    expect(readHeldButtonCode({ text: s("Go"), onSelect: s("Mine();") })).toBeNull();
    expect(readHeldButtonCode({ [HELD_FROM_PROPERTY]: s(stamp) })).toBeNull();
    expect(readHeldButtonCode(undefined)).toBeNull();
  });

  it("still shows held code whose stamp is unreadable, without inventing an origin", () => {
    const held = readHeldButtonCode({ [HELD_ON_SELECT_PROPERTY]: s("X();"), [HELD_FROM_PROPERTY]: s("{not json") })!;
    expect(held.onSelect).toBe("X();");
    expect(held.application).toBe("an application");
    expect(parseHeldFrom("{not json")).toBeNull();
    expect(parseHeldFrom(JSON.stringify({ workspace: "w" }))).toBeNull();
  });

  // Phase 4 of BUG-0257: what a CLICK on a button holding code says is the Rust
  // button door's own answer (it runs approved bytes and refuses the rest), so
  // this module no longer composes a click sentence that could contradict it.
  //
  // SABOTAGE: re-add an exported `describeHeldButtonClick` to heldButtonCode.ts.
  it("composes no click sentence of its own: the door answers a click", async () => {
    const api = (await import("../heldButtonCode")) as Record<string, unknown>;
    for (const gone of [
      "describeHeldButtonClick",
      "describeHeldCellButtonClick",
      "describeRefusedCellButtonCommand",
      "recordButtonCellRefusal",
    ]) {
      expect(api[gone], `${gone} is back`).toBeUndefined();
    }
  });

  it("formats anchors the way the push refusal names them", () => {
    expect(cellA1(1, 1)).toBe("B2");
    expect(cellA1(0, 27)).toBe("AB1");
  });
});

// THE SPELLINGS ARE THE BACKEND'S. A drifted key would show nothing (the UI
// reads a key Rust never writes) -- held code invisible where it lives.
//
// SABOTAGE: change HELD_ON_SELECT_PROPERTY here to "heldOnselect".
describe("the held key names match app/src-tauri/src/controls.rs", () => {
  it("every constant has the same value in Rust", () => {
    const rust = nodeFs.readFileSync(
      nodePath.resolve(__dirname, "../../../src-tauri/src/controls.rs"),
      "utf8",
    );
    const pairs: [string, string][] = [
      ["HELD_ON_SELECT_PROPERTY", HELD_ON_SELECT_PROPERTY],
      ["HELD_MACRO_REF_PROPERTY", HELD_MACRO_REF_PROPERTY],
      ["HELD_FROM_PROPERTY", HELD_FROM_PROPERTY],
    ];
    for (const [name, value] of pairs) {
      const m = new RegExp(`pub const ${name}: &str = "([^"]+)";`).exec(rust);
      expect(m, `${name} not found in controls.rs`).not.toBeNull();
      expect(value, name).toBe(m![1]);
    }
    expect([...HELD_CONTROL_PROPERTIES].sort()).toEqual(pairs.map((p) => p[1]).sort());
  });
});

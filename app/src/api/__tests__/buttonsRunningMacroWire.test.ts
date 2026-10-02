//! FILENAME: app/src/api/__tests__/buttonsRunningMacroWire.test.ts
// PURPOSE: `listButtonsRunningMacro` is the ONE wrapper of
//          `list_controls_referencing_macro` (phase 3 of BUG-0257): the
//          delete-a-macro warning and the approval screen's "Buttons that run
//          this macro" both read it, so its wire shape must be Rust's.
// CONTEXT: The real @api wrapper with only the backend door doubled, plus a
//          drift check that reads Rust `MacroLinkingControl`
//          (app/src-tauri/src/controls.rs) at test time: every serialized field
//          there is a field here, camelCased -- the approval screen filters on
//          `application`, and a renamed field would silently list nothing.

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => ({ calls: [] as { cmd: string; args: unknown }[] }));

vi.mock("../backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    h.calls.push({ cmd, args });
    return [
      {
        sheetIndex: 1,
        sheetName: "Dashboard",
        row: 1,
        col: 1,
        heldBy: "Sales",
        kind: "control",
        caption: "Run report",
        application: "Sales",
      },
    ];
  },
}));

import {
  buttonRunningMacroCell,
  describeHeldMacroLink,
  listButtonsRunningMacro,
  type ButtonRunningMacro,
} from "../heldButtonCode";

beforeEach(() => {
  h.calls.length = 0;
});

describe("listButtonsRunningMacro", () => {
  it("asks list_controls_referencing_macro for the macro, and hands the rows back", async () => {
    const rows = await listButtonsRunningMacro("macro-report");
    expect(h.calls).toEqual([{ cmd: "list_controls_referencing_macro", args: { macroId: "macro-report" } }]);
    expect(rows[0].application).toBe("Sales");
    expect(buttonRunningMacroCell(rows[0])).toBe("Dashboard!B2");
  });

  it("says what a held link does, in one sentence", () => {
    expect(describeHeldMacroLink("macro-report")).toBe(
      "Runs the application's macro macro-report when clicked, only after you approve the application's code.",
    );
  });
});

describe("the wire shape is Rust's MacroLinkingControl", () => {
  it("every Rust field is a TypeScript field, camelCased", () => {
    const controls = fs.readFileSync(
      path.resolve(__dirname, "../../../src-tauri/src/controls.rs"),
      "utf8",
    );
    const start = controls.indexOf("pub struct MacroLinkingControl {");
    expect(start, "Rust MacroLinkingControl not found").toBeGreaterThanOrEqual(0);
    const body = controls.slice(start, controls.indexOf("\n}\n", start));
    const rustFields = [...body.matchAll(/^\s*pub (\w+):/gm)].map((m) =>
      m[1].replace(/_(\w)/g, (_, c: string) => c.toUpperCase()),
    );
    // A literal of the TS type: a missing key here is a compile error in the
    // type-checked tree, and the sorted comparison catches an extra Rust field.
    const sample: Required<ButtonRunningMacro> = {
      sheetIndex: 0,
      sheetName: "",
      row: 0,
      col: 0,
      heldBy: null,
      kind: "control",
      caption: "",
      application: null,
    };
    expect(rustFields.sort()).toEqual(Object.keys(sample).sort());
  });
});

describe("the delete-a-macro warning reads the same wrapper", () => {
  it("MacroRecorder's listControlsReferencingMacro delegates to it (one wrapper)", () => {
    const linked = fs.readFileSync(
      path.resolve(__dirname, "../../../extensions/MacroRecorder/lib/linkedButtons.ts"),
      "utf8",
    );
    expect(linked).toContain('from "@api/heldButtonCode"');
    expect(linked).toContain("return listButtonsRunningMacro(macroId);");
    expect(linked).not.toContain('"list_controls_referencing_macro"');
  });
});

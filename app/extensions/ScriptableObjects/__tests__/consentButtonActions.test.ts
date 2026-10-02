//! FILENAME: app/extensions/ScriptableObjects/__tests__/consentButtonActions.test.ts
// PURPOSE: M6 (phase 4 of BUG-0257), S8: an application's held inline button
//          code is an item on its approval screen -- listed by the hash of its
//          exact bytes, with every place it sits -- and only code the Rust door
//          could actually run is offered.
// CONTEXT: The door (app/src-tauri/src/scripting/control_action.rs) runs a held
//          `onSelect` only when the control is a BUTTON, no macro link (live or
//          held) wins, the user's own code does not win, the stamp decodes the
//          Rust way (`HeldFrom::decode` needs `workspace`) and names an
//          application, and the code is static. It then asks the approval of
//          `buttonAction:<sha256 of the exact bytes>` in that application's
//          record. Every test here drives the REAL @api listing over a doubled
//          backend and hashes with node:crypto, so the TypeScript id can only
//          pass by being the Rust door's id.

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  controls: new Map<number, Array<Record<string, unknown>>>(),
  fail: null as Error | null,
}));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  invokeBackend: async (cmd: string, args?: Record<string, unknown>) => {
    if (h.fail) throw h.fail;
    if (cmd === "get_sheets") return { sheets: [{ index: 0, name: "Dashboard" }, { index: 1, name: "Sheet2" }] };
    if (cmd === "get_all_controls") return h.controls.get(Number(args?.sheetIndex)) ?? [];
    if (cmd === "get_all_cell_types") return [];
    throw new Error(`unexpected command ${cmd}`);
  },
}));

// packageConsentSet lists macros through the @api facade; nothing here lists them.
vi.mock("@api", () => ({ listDistributedWorkbookScriptRecords: async () => [] }));

import {
  BUTTON_ACTION_CONSENT_PREFIX,
  heldInlineVerdict,
  listHeldButtonActions,
  parseHeldFromStrict,
} from "@api/heldButtonCode";
import {
  buttonCallName,
  describeButtonActionCall,
  describeButtonActionLocation,
  toConsentButtonActions,
} from "../lib/consentButtonActions";
import { packageConsentPlan, type PackageMacro } from "../lib/packageConsentSet";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const STAMP = (application: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ workspace: "ws-1", application, version: "1.0.0", ...over });

const prop = (value: string, valueType = "static") => ({ valueType, value });

/** A control as `get_all_controls` lists it. */
function control(
  sheetIndex: number,
  row: number,
  col: number,
  properties: Record<string, { valueType: string; value: string }>,
  controlType = "button",
): Record<string, unknown> {
  return { sheetIndex, row, col, metadata: { controlType, properties } };
}

/** A button holding `code` for `application`, captioned. */
function heldButton(
  sheetIndex: number,
  row: number,
  col: number,
  code: string,
  application = "Sales",
  extra: Record<string, { valueType: string; value: string }> = {},
): Record<string, unknown> {
  return control(sheetIndex, row, col, {
    text: prop(`Button ${row}`),
    heldOnSelect: prop(code),
    heldFrom: prop(STAMP(application)),
    ...extra,
  });
}

beforeEach(() => {
  h.controls.clear();
  h.fail = null;
});

describe("the approval item is the hash of the exact bytes, with every place it sits", () => {
  // SABOTAGE: group by position (sheet/row/col) instead of by hash in
  // groupHeldButtonActions (@api/heldButtonCode.ts) -> two items, one place each.
  it("two buttons with the same code are ONE item naming both, in sheet/row/col order", async () => {
    h.controls.set(0, [heldButton(0, 3, 1, "Report();"), heldButton(0, 1, 1, "Report();")]);
    h.controls.set(1, [heldButton(1, 0, 2, "Report();")]);
    const actions = (await listHeldButtonActions()).get("Sales")!;
    expect(actions).toHaveLength(1);
    expect(actions[0].locations.map(describeButtonActionLocation)).toEqual([
      'Dashboard!B2 "Button 1"',
      'Dashboard!B4 "Button 3"',
      'Sheet2!C1 "Button 0"',
    ]);
  });

  it("the id is 'buttonAction:' + the sha256 of the UTF-8 bytes -- the Rust door's id", async () => {
    // Multibyte on purpose: a UTF-16 or Latin-1 hash would differ here.
    const code = "Calcula.setCellValue('A1', 'Café ✓ 😀');\r\nCalcula.log(\"done\");";
    h.controls.set(0, [heldButton(0, 1, 1, code)]);
    const [action] = (await listHeldButtonActions()).get("Sales")!;
    expect(action.hash).toBe(sha256(code));
    expect(action.id).toBe(`buttonAction:${sha256(code)}`);
    expect(action.id.startsWith(BUTTON_ACTION_CONSENT_PREFIX)).toBe(true);
    // The bytes themselves, untouched: no trim, no line-ending normalisation.
    expect(action.source).toBe(code);
  });

  it("different code is a different item, and another application's button is its own group", async () => {
    h.controls.set(0, [
      heldButton(0, 1, 1, "A();"),
      heldButton(0, 2, 1, "B();"),
      heldButton(0, 3, 1, "A();", "Someone Else"),
    ]);
    const grouped = await listHeldButtonActions();
    expect([...grouped.keys()].sort()).toEqual(["Sales", "Someone Else"]);
    expect(grouped.get("Sales")!.map((a) => a.source).sort()).toEqual(["A();", "B();"]);
    // Sorted by id, so the record is byte-stable across grants.
    const ids = grouped.get("Sales")!.map((a) => a.id);
    expect(ids).toEqual([...ids].sort());
    expect(grouped.get("Someone Else")!.map((a) => a.source)).toEqual(["A();"]);
  });

  it("the application name is the stamp's, VERBATIM -- both Rust gates compare it raw", async () => {
    h.controls.set(0, [heldButton(0, 1, 1, "Go();", "  Sales  ")]);
    const grouped = await listHeldButtonActions();
    expect([...grouped.keys()]).toEqual(["  Sales  "]);
  });

  it("a listing that fails REJECTS -- a caller decides how to fail, nothing reads it as 'no code'", async () => {
    h.fail = new Error("backend down");
    await expect(listHeldButtonActions()).rejects.toThrow("backend down");
  });
});

describe("only code a click could run is offered for approval (the door's rule)", () => {
  // Each row here is a held onSelect the door would REFUSE (notAButton, a link
  // wins, own code wins, stampUnreadable, unsupportedValueType) -- approving it
  // would approve nothing that matters.
  //
  // SABOTAGE: drop the `controlType !== "button"` step (or any other) from
  // heldInlineVerdict -> its row is offered.
  it("excludes a shape, a linked button, a button with its own code, a bad stamp and a formula", async () => {
    h.controls.set(0, [
      heldButton(0, 1, 1, "Runs();"),
      control(0, 2, 1, { heldOnSelect: prop("Shape();"), heldFrom: prop(STAMP("Sales")) }, "shape"),
      heldButton(0, 3, 1, "HeldLink();", "Sales", { heldMacroRef: prop("macro-report") }),
      heldButton(0, 4, 1, "LiveLink();", "Sales", { macroRef: prop("macro-mine") }),
      heldButton(0, 5, 1, "Shadowed();", "Sales", { onSelect: prop("Mine();") }),
      control(0, 6, 1, { heldOnSelect: prop("NoWorkspace();"), heldFrom: prop(JSON.stringify({ application: "Sales", version: "1" })) }),
      control(0, 7, 1, { heldOnSelect: prop("Garbled();"), heldFrom: prop("{not json") }),
      control(0, 8, 1, {
        heldOnSelect: prop("=CONCAT(\"Run\",\"()\")"),
        heldFrom: prop(STAMP("Sales", { valueTypes: { onSelect: "formula" } })),
      }),
      control(0, 9, 1, { heldOnSelect: prop("Blank();"), heldFrom: prop(STAMP("   ")) }),
      control(0, 10, 1, { heldOnSelect: prop(""), heldFrom: prop(STAMP("Sales")) }),
    ]);
    const grouped = await listHeldButtonActions();
    expect([...grouped.keys()]).toEqual(["Sales"]);
    expect(grouped.get("Sales")!.map((a) => a.source)).toEqual(["Runs();"]);
  });

  it("says WHY each one never runs", () => {
    const verdict = (controlType: string, properties: Record<string, { valueType: string; value: string }>) =>
      heldInlineVerdict(controlType, properties);
    const held = { heldOnSelect: prop("X();"), heldFrom: prop(STAMP("Sales")) };
    expect(verdict("button", held)).toEqual({ runs: true, application: "Sales" });
    expect(verdict("shape", held)).toEqual({
      runs: false,
      why: "it sits on a shape, and only a button runs code when it is clicked",
    });
    expect(verdict("button", { ...held, heldMacroRef: prop("m") })).toMatchObject({ runs: false });
    expect(verdict("button", { ...held, onSelect: prop("Mine();") })).toMatchObject({ runs: false });
    expect(verdict("button", { ...held, heldOnSelect: prop("X();", "formula") })).toMatchObject({
      runs: false,
      why: "it came as a formula, which Calcula does not run as button code",
    });
    // No held inline code at all: nothing to decide.
    expect(verdict("button", { heldFrom: prop(STAMP("Sales")) })).toBeNull();
  });

  it("reads the stamp exactly as Rust's HeldFrom::decode does", () => {
    expect(parseHeldFromStrict(STAMP("Sales"))).toMatchObject({ application: "Sales", workspace: "ws-1" });
    // No default for workspace / application / version (serde: required).
    expect(parseHeldFromStrict(JSON.stringify({ application: "Sales", version: "1" }))).toBeNull();
    expect(parseHeldFromStrict(JSON.stringify({ workspace: "w", version: "1" }))).toBeNull();
    expect(parseHeldFromStrict(JSON.stringify({ workspace: "w", application: "Sales" }))).toBeNull();
    expect(parseHeldFromStrict(JSON.stringify({ workspace: 1, application: "Sales", version: "1" }))).toBeNull();
    // valueTypes: absent, or a map of strings. `null` is not a map to serde.
    expect(parseHeldFromStrict(STAMP("Sales", { valueTypes: null }))).toBeNull();
    expect(parseHeldFromStrict(STAMP("Sales", { valueTypes: { onSelect: 1 } }))).toBeNull();
    expect(parseHeldFromStrict(STAMP("Sales", { valueTypes: ["static"] }))).toBeNull();
    expect(parseHeldFromStrict(STAMP("Sales", { valueTypes: { onSelect: "formula" } }))!.valueTypes).toEqual({
      onSelect: "formula",
    });
    // Unknown fields are ignored, as serde ignores them.
    expect(parseHeldFromStrict(STAMP("Sales", { extra: true }))).not.toBeNull();
    expect(parseHeldFromStrict("[]")).toBeNull();
    expect(parseHeldFromStrict("")).toBeNull();
    expect(parseHeldFromStrict(null)).toBeNull();
  });
});

describe("a button action that is only a call of one of the application's macros", () => {
  const FIXTURE = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../src-tauri/src/scripting/fixtures/button_names.json"), "utf8"),
  ) as { callName: Array<{ code: string; expected: string | null }> };

  // SABOTAGE: put JavaScript's \s back into SINGLE_CALL in
  // lib/consentButtonActions.ts -> the U+FEFF row becomes an invocation.
  it("reads the call name exactly as the Rust door does -- every fixture row, no exceptions", () => {
    for (const row of FIXTURE.callName) {
      expect(buttonCallName(row.code), JSON.stringify(row.code)).toBe(row.expected);
    }
  });

  const macro = (over: Partial<PackageMacro>): PackageMacro => ({
    id: "macro-report",
    name: "Report",
    source: "Calcula.setCellValue('A1', 1);",
    description: "Recorded macro · runtime=notebook · 1 action",
    ...over,
  });

  it("names the macro a click runs", () => {
    expect(describeButtonActionCall("Report();", [macro({})], [])).toEqual({
      runsMacro: "Report",
      refusedBecause: null,
    });
    // By the SANITIZED name, as the Properties pane writes the call.
    expect(describeButtonActionCall("Month_end()", [macro({ name: "Month end" })], [])).toEqual({
      runsMacro: "Month end",
      refusedBecause: null,
    });
  });

  it("says up front when the door will refuse it: an object-script macro, two answers, an unapprovable macro", () => {
    expect(
      describeButtonActionCall("Report()", [macro({ description: "Recorded macro · runtime=objectScript · 3 actions" })], [])
        .refusedBecause,
    ).toContain("runs as an object script, which a button can reach only by linking the macro");
    expect(
      describeButtonActionCall("Report()", [macro({}), macro({ id: "macro-report-2" })], []).refusedBecause,
    ).toContain("names 2 of the application's macros");
    expect(describeButtonActionCall("Report()", [], [macro({})]).refusedBecause).toContain(
      "which this approval cannot cover",
    );
  });

  it("says nothing when the code is not a single call, or calls nothing the application ships", () => {
    expect(describeButtonActionCall("Report(); Other();", [macro({})], [])).toEqual({
      runsMacro: null,
      refusedBecause: null,
    });
    expect(describeButtonActionCall("Mine()", [macro({})], [])).toEqual({ runsMacro: null, refusedBecause: null });
  });

  it("the screen's items carry the code, every place, and the note", () => {
    const items = toConsentButtonActions(
      [
        {
          id: `buttonAction:${sha256("Report();")}`,
          hash: sha256("Report();"),
          source: "Report();",
          locations: [{ sheetIndex: 0, sheetName: "Dashboard", row: 1, col: 1, cell: "Dashboard!B2", caption: "Run" }],
        },
      ],
      [macro({})],
      [],
    );
    expect(items).toEqual([
      {
        id: `buttonAction:${sha256("Report();")}`,
        hash: sha256("Report();"),
        source: "Report();",
        locations: [{ cell: "Dashboard!B2", caption: "Run" }],
        runsMacro: "Report",
        refusedBecause: null,
      },
    ]);
  });
});

describe("the approval plan: button actions join the bare record, and own their id space", () => {
  const action = (code: string) => ({
    id: `buttonAction:${sha256(code)}`,
    hash: sha256(code),
    source: code,
    locations: [],
  });

  it("records object scripts, then macros, then button actions -- the actions by id and exact bytes", () => {
    const plan = packageConsentPlan(
      [{ id: "obj-1", source: "// object" }],
      [{ id: "macro-1", name: "M", source: "m();" }],
      [action("Report();")],
    );
    expect(plan.artifacts).toEqual([
      { id: "obj-1", source: "// object" },
      { id: "macro-1", source: "m();" },
      { id: `buttonAction:${sha256("Report();")}`, source: "Report();" },
    ]);
    expect(plan.buttonActions.map((a) => a.source)).toEqual(["Report();"]);
  });

  // SABOTAGE: drop the isReservedButtonActionId check for OBJECT SCRIPTS in
  // packageConsentPlan -> the object script is recorded (and Rust's writer
  // refuses the whole approval, since the id is not the hash of its source).
  it("an object script or a macro whose id starts with 'buttonAction:' is unapprovable", () => {
    const plan = packageConsentPlan(
      [
        { id: "buttonAction:x", name: "Sneaky", source: "// object" },
        { id: "obj-ok", name: "Fine", source: "// fine" },
      ],
      [
        { id: "buttonAction:y", name: "Sneaky macro", source: "m();" },
        { id: "macro-ok", name: "OK", source: "ok();" },
      ],
      [],
    );
    expect(plan.reserved).toEqual([
      { id: "buttonAction:x", name: "Sneaky" },
      { id: "buttonAction:y", name: "Sneaky macro" },
    ]);
    expect(plan.artifacts.map((a) => a.id)).toEqual(["obj-ok", "macro-ok"]);
    expect(plan.objectScripts.map((s) => s.id)).toEqual(["obj-ok"]);
    expect(plan.covered.map((m) => m.id)).toEqual(["macro-ok"]);
    // A reserved id is not the id-collision case, and is not reported as one.
    expect(plan.unapprovable).toEqual([]);
  });

  it("an object script or macro can never claim a button action's id", () => {
    const shared = action("Report();");
    const plan = packageConsentPlan(
      [{ id: shared.id, source: "// crafted" }],
      [{ id: shared.id, name: "Crafted", source: "crafted();" }],
      [shared],
    );
    expect(plan.artifacts).toEqual([{ id: shared.id, source: "Report();" }]);
    expect(plan.buttonActions).toHaveLength(1);
  });
});

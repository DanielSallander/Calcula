//! FILENAME: app/src/api/codeInventory.buttonActions.test.ts
// PURPOSE: M6 (phase 4 of BUG-0257), S10: "Code in This File" lists every
//          button action -- the inline `onSelect` code a control carries --
//          BY CONTENT. The user's own (a live slot) and each application's
//          (a held slot) are separate units; two buttons with one code are one
//          unit naming both cells; moving a button keeps the unit's id and
//          changing its code changes it. Per-workbook trust reads these ids, so
//          a positional id would turn every move into an "added script".
// CONTEXT: The four other code populations are doubled to empty; the control
//          listing is the REAL @api/heldButtonCode walk over a doubled backend.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  controls: new Map<number, Array<Record<string, unknown>>>(),
  fail: null as Error | null,
}));

vi.mock("./backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./backend")>()),
  invokeBackend: async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "get_sheets") return { sheets: [{ index: 0, name: "Dashboard" }, { index: 1, name: "Sheet2" }] };
    if (cmd === "get_all_controls") {
      if (h.fail) throw h.fail;
      return h.controls.get(Number(args?.sheetIndex)) ?? [];
    }
    throw new Error(`unexpected command ${cmd}`);
  },
}));
vi.mock("./objectScriptBackend", () => ({ loadAllObjectScripts: vi.fn(async () => []) }));
vi.mock("./moduleScriptBackend", () => ({
  listModuleScripts: vi.fn(async () => []),
  getModuleScript: vi.fn(async () => null),
  describeModuleScriptScope: () => "Workbook-global",
}));
vi.mock("./notebookBackend", () => ({ listNotebooks: vi.fn(async () => []), loadNotebook: vi.fn(async () => null) }));
vi.mock("./scriptHost/broker", () => ({ listMountedHandles: vi.fn(() => []) }));
vi.mock("./chartTransformScripts", () => ({
  loadPersistedTransformLibraryWithProvenance: vi.fn(async () => null),
  CHART_TRANSFORMS_SCRIPT_ID: "__calcula_chart_transforms__",
}));
vi.mock("./chartMarkScripts", () => ({
  loadPersistedMarkLibraryWithProvenance: vi.fn(async () => null),
  markScriptId: (id: string) => `__chartmark__:${id}`,
}));
vi.mock("./writebackValidators", () => ({ mountedWritebackValidators: vi.fn(() => []) }));
vi.mock("./scriptLibraries", () => ({
  listInstalledLibraries: vi.fn(async () => []),
  listLibraryRealms: vi.fn(() => []),
  readLockedSource: vi.fn(async () => ""),
}));
vi.mock("./customFunctions", () => ({
  loadPersistedLibrary: vi.fn(async () => null),
  CUSTOM_FUNCTIONS_SCRIPT_ID: "__calcula_custom_functions",
}));

import { getWorkbookCodeUnits, summarizeCodeInventory, QUICKJS_SURFACE_REACH } from "./codeInventory";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const prop = (value: string) => ({ valueType: "static", value });
const STAMP = (application: string) => JSON.stringify({ workspace: "ws", application, version: "1.0.0" });

function button(
  sheetIndex: number,
  row: number,
  col: number,
  properties: Record<string, { valueType: string; value: string }>,
  controlType = "button",
): Record<string, unknown> {
  return { sheetIndex, row, col, metadata: { controlType, properties } };
}

const own = (sheetIndex: number, row: number, col: number, code: string) =>
  button(sheetIndex, row, col, { onSelect: prop(code), text: prop("Mine") });
const held = (sheetIndex: number, row: number, col: number, code: string, application = "Sales") =>
  button(sheetIndex, row, col, { heldOnSelect: prop(code), heldFrom: prop(STAMP(application)), text: prop("Theirs") });

async function buttonUnits() {
  return (await getWorkbookCodeUnits()).filter((u) => u.buttonAction);
}

beforeEach(() => {
  h.controls.clear();
  h.fail = null;
});

describe("button actions are code units, by content", () => {
  // SABOTAGE: make buttonActionUnit's id positional (e.g. the first location's
  // cell) in codeInventory.ts -> the move test goes red.
  it("moving a button keeps the unit's id; changing its code changes it", async () => {
    h.controls.set(0, [own(0, 1, 1, "Calcula.setCellValue('A1', 1);")]);
    const [before] = await buttonUnits();
    expect(before.id).toBe(`buttonAction:${sha256("Calcula.setCellValue('A1', 1);")}`);
    expect(before.residence).toBe("Button OnSelect at Dashboard!B2");

    h.controls.set(0, []);
    h.controls.set(1, [own(1, 9, 4, "Calcula.setCellValue('A1', 1);")]);
    const [moved] = await buttonUnits();
    expect(moved.id, "a moved button is the same unit").toBe(before.id);
    expect(moved.residence).toBe("Button OnSelect at Sheet2!E10");

    h.controls.set(1, [own(1, 9, 4, "Calcula.setCellValue('A1', 2);")]);
    const [changed] = await buttonUnits();
    expect(changed.id, "changed code is a different unit").not.toBe(before.id);
  });

  it("two buttons with one code are ONE unit naming both cells", async () => {
    h.controls.set(0, [own(0, 3, 0, "Go();"), own(0, 1, 0, "Go();")]);
    h.controls.set(1, [own(1, 0, 0, "Go();")]);
    const units = await buttonUnits();
    expect(units).toHaveLength(1);
    expect(units[0].buttonAction!.locations.map((l) => l.cell)).toEqual(["Dashboard!A2", "Dashboard!A4", "Sheet2!A1"]);
    expect(units[0].residence).toBe("Button OnSelect at Dashboard!A2, Dashboard!A4, Sheet2!A1");
  });

  it("the user's own code and an application's held code are separate units, even with the same bytes", async () => {
    h.controls.set(0, [own(0, 1, 1, "Report();"), held(0, 2, 1, "Report();"), held(0, 3, 1, "Report();", "Payroll")]);
    const units = await buttonUnits();
    expect(units.map((u) => [u.provenance, u.sourcePackage])).toEqual([
      ["local", null],
      ["distributed", "Payroll"],
      ["distributed", "Sales"],
    ]);
    // All three are the same bytes, so the same content id; whose code it is
    // is provenance + application, never folded together.
    expect(new Set(units.map((u) => u.id)).size).toBe(1);
    const theirs = units.find((u) => u.sourcePackage === "Sales")!;
    expect(theirs.residence).toBe("Button OnSelect (held for the application) at Dashboard!B3");
    const summary = summarizeCodeInventory(units);
    expect(summary.local).toBe(1);
    expect(summary.distributed).toBe(2);
  });

  it("runs on the one-off surface the button door uses, with its derived reach", async () => {
    h.controls.set(0, [own(0, 1, 1, "Go();")]);
    const [unit] = await buttonUnits();
    expect(unit.surfaceId).toBe("one-off-script");
    expect(unit.interpreterReach).toEqual(QUICKJS_SURFACE_REACH["one-off-script"]);
    expect(unit.interpreterCapabilities).toEqual([]);
    expect(unit.declaredCapabilities).toEqual([]);
    expect(unit.source).toBe("Go();");
    expect(unit.name).toBe("Button code: Go();");
  });

  it("lists inline code on any control, saying when it is not a button", async () => {
    h.controls.set(0, [button(0, 1, 1, { onSelect: prop("Shape();") }, "shape")]);
    const [unit] = await buttonUnits();
    expect(unit.residence).toBe("Control OnSelect at Dashboard!B2");
  });
});

describe("a button listing that fails", () => {
  it("degrades to 'none' for the panel, which still lists everything else", async () => {
    h.fail = new Error("backend down");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await getWorkbookCodeUnits()).toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // SABOTAGE: ignore options.strictButtonActions in getWorkbookCodeUnits (always
  // go through safely) -> resolves to [] instead of rejecting.
  it("REJECTS when asked strictly -- per-workbook trust must read it as 'could not look'", async () => {
    h.fail = new Error("backend down");
    await expect(getWorkbookCodeUnits({ strictButtonActions: true })).rejects.toThrow("backend down");
  });
});

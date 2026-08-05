//! FILENAME: app/src/api/scriptHost/worker/__tests__/topLevelRange.test.ts
// PURPOSE: Verify the Wave 1 top-level range entry and the sheet-prefix fix in
//          the worker shims:
//           - api.range(address): "Sheet!" prefix (bare + quoted), plain A1 on
//             the active sheet, named-range resolution (refersTo parse), table
//             resolution (data body), and the A1-beats-name precedence rule;
//           - sheet context range("Sheet!A1"): the prefix is passed THROUGH as
//             the per-call sheet argument (host-side clamp), never dropped;
//           - namedRange(...).toRange() / table(...).toRange() sugar.
//          Everything routes over EXISTING broker methods — no new allowlist
//          rows — so the harness answers RPC by method name.

import { describe, it, expect } from "vitest";
import { buildWorkerContext } from "../contextShims";
import type { MountSpec, W2H } from "../../protocol";

type Responder = (method: string, args: unknown[]) => unknown;

/** The workbook the fake host serves: sheets Alpha (active) and Beta. */
const SHEET_NAMES = ["Alpha", "Beta"];

const NAMED_RANGES = [
  // Workbook-scoped, refersTo carries its own sheet prefix (the common case).
  { kind: "namedRange", id: "SalesData", name: "SalesData", sheetIndex: null, refersTo: "=Beta!$B$2:$C$4" },
  // Sheet-scoped, refersTo has NO prefix: the scope sheet is the fallback.
  { kind: "namedRange", id: "LocalName", name: "LocalName", sheetIndex: 1, refersTo: "A1:A3" },
  // Not a rectangle: must reject, not guess.
  { kind: "namedRange", id: "Weird", name: "Weird", sheetIndex: null, refersTo: "=OFFSET(A1,1,1)" },
  // A named range that LOOKS like a cell address: A1-parse must beat it.
  { kind: "namedRange", id: "A1", name: "A1", sheetIndex: null, refersTo: "=Beta!$Z$9" },
];

const TABLES = [
  // Full rectangle A1:C5 on Beta with 4 data rows -> one header row.
  { kind: "table", id: "tbl-1", name: "Orders", sheetIndex: 1, range: "A1:C5", rowCount: 4, columnCount: 3 },
];

function defaultRespond(method: string, args: unknown[]): unknown {
  switch (method) {
    case "api.getSheetNames":
      return [...SHEET_NAMES];
    case "api.getActiveSheet":
      return 0;
    case "api.listObjects":
      return args[0] === "namedRange" ? NAMED_RANGES : args[0] === "table" ? TABLES : [];
    case "sheet.getCellValue":
      return "v";
    default:
      return undefined;
  }
}

/** An unlocked sheet-script mount whose host auto-answers RPC. */
function unlockedContext(respond: Responder = defaultRespond) {
  const spec: MountSpec = {
    protocolVersion: 1,
    scriptId: "s1",
    objectType: "sheet",
    instanceId: "",
    tier: "unlocked",
    capabilities: [],
    apiVersion: "1.0",
    source: "",
    scriptName: "S",
    snapshot: {},
  };
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let settle: (callId: number, ok: boolean, value?: unknown, error?: { code: string; message: string }) => void = () => {};
  const post = (msg: W2H) => {
    if (msg.t !== "call") return;
    calls.push({ method: msg.method, args: msg.args });
    queueMicrotask(() => {
      try {
        settle(msg.callId, true, respond(msg.method, msg.args), undefined);
      } catch (e) {
        settle(msg.callId, false, undefined, {
          code: "HostError",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    });
  };
  const { context, rt } = buildWorkerContext(spec, post);
  settle = (callId, ok, value, error) => rt.settleCall(callId, ok, value, error);
  const sheet = context as Record<string, any>;
  return { api: sheet.api as Record<string, any>, sheet, calls };
}

const callsTo = (calls: Array<{ method: string; args: unknown[] }>, method: string) =>
  calls.filter((c) => c.method === method).map((c) => c.args);

describe("api.range(address) — top-level A1 entry", () => {
  it("a 'Sheet!' prefix binds the range to THAT sheet", async () => {
    const { api, calls } = unlockedContext();
    const r = await api.range("Beta!B2");
    expect(r.address).toBe("B2");
    await r.setValue("x");
    expect(callsTo(calls, "sheet.setCellValue")).toEqual([[1, 1, "x", 1]]);
  });

  it("a quoted 'Sheet Name'! prefix resolves too", async () => {
    const { api, calls } = unlockedContext();
    const r = await api.range("'Beta'!A1:B1");
    await r.setValues([["a", "b"]]);
    expect(callsTo(calls, "sheet.setRangeValues")).toEqual([[0, 0, [["a", "b"]], 1]]);
  });

  it("a plain A1 address binds to the ACTIVE sheet", async () => {
    const { api, calls } = unlockedContext();
    const r = await api.range("A1:B2");
    expect(r.address).toBe("A1:B2");
    await r.setValue("x");
    expect(callsTo(calls, "sheet.setCellValue")).toEqual([[0, 0, "x", 0]]);
  });

  it("an unknown sheet prefix rejects listing the workbook's sheets", async () => {
    const { api } = unlockedContext();
    await expect(api.range("Nope!A1")).rejects.toThrow(
      'No sheet named "Nope". Sheets in this workbook: "Alpha", "Beta"',
    );
  });

  it("a prefixed address with a malformed body rejects as an address (never a name)", async () => {
    const { api } = unlockedContext();
    await expect(api.range("Beta!SalesData")).rejects.toThrow(/Invalid cell reference/);
  });

  it("resolves a named range from its refersTo formula (prefix + $ markers)", async () => {
    const { api, calls } = unlockedContext();
    const r = await api.range("SalesData"); // =Beta!$B$2:$C$4
    expect(r.address).toBe("B2:C4");
    await r.setValue("x");
    expect(callsTo(calls, "sheet.setCellValue")).toEqual([[1, 1, "x", 1]]);
  });

  it("a prefix-less refersTo falls back to the name's scope sheet", async () => {
    const { api, calls } = unlockedContext();
    const r = await api.range("LocalName"); // A1:A3, scope sheet 1
    expect(r.address).toBe("A1:A3");
    await r.getValue();
    expect(callsTo(calls, "sheet.getCellValue")).toEqual([[0, 0, 1]]);
  });

  it("A1-parse WINS over a named range called 'A1'", async () => {
    const { api, calls } = unlockedContext();
    const r = await api.range("A1");
    await r.setValue("x");
    // The cell (0,0) on the active sheet — NOT Beta!Z9 from the name's refersTo.
    expect(callsTo(calls, "sheet.setCellValue")).toEqual([[0, 0, "x", 0]]);
    // The inventory was never even consulted.
    expect(callsTo(calls, "api.listObjects")).toEqual([]);
  });

  it("a non-rectangular named range rejects instead of guessing", async () => {
    const { api } = unlockedContext();
    await expect(api.range("Weird")).rejects.toThrow(
      'Named range "Weird" refers to "=OFFSET(A1,1,1)", which is not a rectangular range',
    );
  });

  it("resolves a table name to its DATA BODY (headers excluded)", async () => {
    const { api, calls } = unlockedContext();
    const r = await api.range("Orders"); // A1:C5 with 4 data rows -> A2:C5
    expect(r.address).toBe("A2:C5");
    await r.setValue("x");
    expect(callsTo(calls, "sheet.setCellValue")).toEqual([[1, 0, "x", 1]]);
  });

  it("table names resolve case-insensitively when unique", async () => {
    const { api } = unlockedContext();
    const r = await api.range("orders");
    expect(r.address).toBe("A2:C5");
  });

  it("an unresolvable string rejects listing the named ranges and tables", async () => {
    const { api } = unlockedContext();
    await expect(api.range("Nada")).rejects.toThrow(
      '"Nada" is not an A1 address, a named range, or a table in this workbook. ' +
        'Named ranges: "SalesData", "LocalName", "Weird", "A1"; tables: "Orders"',
    );
  });
});

describe("handle .toRange() sugar", () => {
  it("api.namedRange(name).toRange() resolves through the inventory", async () => {
    const { api, calls } = unlockedContext();
    const r = await api.namedRange("SalesData").toRange();
    expect(r.address).toBe("B2:C4");
    await r.getValue();
    expect(callsTo(calls, "sheet.getCellValue")).toEqual([[1, 1, 1]]);
  });

  it("api.namedRange(name).toRange() rejects for a missing name, listing names", async () => {
    const { api } = unlockedContext();
    await expect(api.namedRange("Missing").toRange()).rejects.toThrow(
      'No named range called "Missing". Named ranges in this workbook: ' +
        '"SalesData", "LocalName", "Weird", "A1"',
    );
  });

  it("api.table(id).toRange() is the grid-absolute data body", async () => {
    const { api, calls } = unlockedContext();
    const r = await api.table("tbl-1").toRange();
    expect(r.address).toBe("A2:C5");
    await r.setValue("x");
    // Grid coordinates over sheet.* — NOT the table-relative table.setCellValue.
    expect(callsTo(calls, "sheet.setCellValue")).toEqual([[1, 0, "x", 1]]);
    expect(callsTo(calls, "api.objectSetState")).toEqual([]);
  });

  it("api.table(id).toRange() rejects for an unknown id", async () => {
    const { api } = unlockedContext();
    await expect(api.table("tbl-9").toRange()).rejects.toThrow('No table with id "tbl-9"');
  });
});

describe("sheet context range() with a 'Sheet!' prefix", () => {
  it("passes the sheet NAME through on every call instead of dropping it", async () => {
    const { sheet, calls } = unlockedContext();
    const r = sheet.range("Beta!B2");
    expect(r.address).toBe("B2");
    await r.setValue("x");
    // The 4th argument is the NAME — host-side resolution + tier clamp decide
    // what it may reach; the worker never resolves it.
    expect(callsTo(calls, "sheet.setCellValue")).toEqual([[1, 1, "x", "Beta"]]);
  });

  it("a quoted prefix is unquoted before the pass-through", async () => {
    const { sheet, calls } = unlockedContext();
    await sheet.range("'Beta'!A1").getValue();
    expect(callsTo(calls, "sheet.getCellValue")).toEqual([[0, 0, "Beta"]]);
  });

  it("a prefix-less address keeps the bare own-sheet calls (no sheet argument)", async () => {
    const { sheet, calls } = unlockedContext();
    await sheet.range("B2").getValue();
    expect(callsTo(calls, "sheet.getCellValue")).toEqual([[1, 1]]);
  });
});

//! FILENAME: app/src/api/__tests__/buttonActionTrust.test.ts
// PURPOSE: M6 (phase 4 of BUG-0257), S10: per-workbook trust counts the
//          user's OWN button code -- by content. Adding a button with code of
//          your own lapses trust ("scriptAdded"); MOVING one does not; an
//          application's held code never enters trust (it has its own approval);
//          and a button listing that FAILS lapses trust instead of reading as
//          "this workbook has no button code".
// CONTEXT: workbookTrust.test.ts doubles the whole inventory, so it cannot see
//          how the inventory names a button. This suite runs the REAL
//          @api/codeInventory and the REAL @api/scriptSecurity together, with
//          only the backend and the other code populations doubled.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  controls: new Map<number, Array<Record<string, unknown>>>(),
  fail: null as Error | null,
}));

vi.mock("../backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backend")>()),
  invokeBackend: async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "get_sheets") return { sheets: [{ index: 0, name: "Dashboard" }, { index: 1, name: "Sheet2" }] };
    if (cmd === "get_all_controls") {
      if (h.fail) throw h.fail;
      return h.controls.get(Number(args?.sheetIndex)) ?? [];
    }
    if (cmd === "script_execution_status") return "needsApproval";
    return undefined;
  },
}));
vi.mock("../../core/lib/file-api", () => ({ getCurrentFilePath: async () => "C:\\Books\\Buttons.cala" }));
vi.mock("../objectScriptBackend", () => ({ loadAllObjectScripts: vi.fn(async () => []) }));
vi.mock("../moduleScriptBackend", () => ({
  listModuleScripts: vi.fn(async () => []),
  getModuleScript: vi.fn(async () => null),
  describeModuleScriptScope: () => "Workbook-global",
}));
vi.mock("../notebookBackend", () => ({ listNotebooks: vi.fn(async () => []), loadNotebook: vi.fn(async () => null) }));
vi.mock("../scriptHost/broker", () => ({ listMountedHandles: vi.fn(() => []) }));
vi.mock("../chartTransformScripts", () => ({
  loadPersistedTransformLibraryWithProvenance: vi.fn(async () => null),
  CHART_TRANSFORMS_SCRIPT_ID: "__calcula_chart_transforms__",
}));
vi.mock("../chartMarkScripts", () => ({
  loadPersistedMarkLibraryWithProvenance: vi.fn(async () => null),
  markScriptId: (id: string) => `__chartmark__:${id}`,
}));
vi.mock("../writebackValidators", () => ({ mountedWritebackValidators: vi.fn(() => []) }));
vi.mock("../scriptLibraries", () => ({
  listInstalledLibraries: vi.fn(async () => []),
  listLibraryRealms: vi.fn(() => []),
  readLockedSource: vi.fn(async () => ""),
}));
vi.mock("../customFunctions", () => ({
  loadPersistedLibrary: vi.fn(async () => null),
  CUSTOM_FUNCTIONS_SCRIPT_ID: "__calcula_custom_functions",
}));

import {
  collectLocalWorkbookScripts,
  evaluateCurrentWorkbookTrust,
  invalidateTrustCache,
  trustCurrentWorkbook,
} from "../scriptSecurity";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const prop = (value: string) => ({ valueType: "static", value });

const own = (sheetIndex: number, row: number, col: number, code: string): Record<string, unknown> => ({
  sheetIndex,
  row,
  col,
  metadata: { controlType: "button", properties: { onSelect: prop(code), text: prop("Mine") } },
});
const held = (sheetIndex: number, row: number, col: number, code: string): Record<string, unknown> => ({
  sheetIndex,
  row,
  col,
  metadata: {
    controlType: "button",
    properties: {
      heldOnSelect: prop(code),
      heldFrom: prop(JSON.stringify({ workspace: "ws", application: "Sales", version: "1.0.0" })),
    },
  },
});

const CODE = "Calcula.setCellValue('A1', 1);";

async function evaluate() {
  return (await evaluateCurrentWorkbookTrust({ refresh: true }))!.evaluation;
}

beforeEach(() => {
  localStorage.clear();
  invalidateTrustCache();
  h.controls.clear();
  h.fail = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the user's own button code in per-workbook trust", () => {
  it("is a trust unit keyed by the BARE content id", async () => {
    h.controls.set(0, [own(0, 1, 1, CODE)]);
    const scripts = await collectLocalWorkbookScripts();
    expect(scripts).toEqual([{ id: `buttonAction:${sha256(CODE)}`, name: `Button code: ${CODE}`, source: CODE }]);
  });

  // SABOTAGE: key button units positionally (or drop them from the inventory)
  // -> the move lapses trust, or the added button does not.
  it("MOVING a trusted button does not lapse trust", async () => {
    h.controls.set(0, [own(0, 1, 1, CODE)]);
    expect(await trustCurrentWorkbook()).toBe(true);
    expect((await evaluate()).status).toBe("trusted");

    h.controls.set(0, []);
    h.controls.set(1, [own(1, 7, 3, CODE)]);
    expect((await evaluate()).status, "a moved button is the same code").toBe("trusted");
  });

  it("ADDING a button with code of your own lapses trust ('scriptAdded')", async () => {
    h.controls.set(0, [own(0, 1, 1, CODE)]);
    expect(await trustCurrentWorkbook()).toBe(true);

    h.controls.set(0, [own(0, 1, 1, CODE), own(0, 2, 1, "Calcula.clearRange('A1:Z99');")]);
    const evaluation = await evaluate();
    expect(evaluation.status).toBe("lapsed");
    expect(evaluation.reason).toBe("scriptAdded");
    expect(evaluation.addedScripts.map((s) => s.id)).toEqual([`buttonAction:${sha256("Calcula.clearRange('A1:Z99');")}`]);
  });

  it("CHANGING a button's code lapses trust too (it is new code)", async () => {
    h.controls.set(0, [own(0, 1, 1, CODE)]);
    expect(await trustCurrentWorkbook()).toBe(true);
    h.controls.set(0, [own(0, 1, 1, "Calcula.setCellValue('A1', 999);")]);
    expect((await evaluate()).status).toBe("lapsed");
  });

  it("an application's HELD code never enters trust -- it has its own approval", async () => {
    h.controls.set(0, [own(0, 1, 1, CODE)]);
    expect(await trustCurrentWorkbook()).toBe(true);
    h.controls.set(0, [own(0, 1, 1, CODE), held(0, 4, 4, "Report();")]);
    expect((await evaluate()).status).toBe("trusted");
    expect((await collectLocalWorkbookScripts()).map((s) => s.id)).toEqual([`buttonAction:${sha256(CODE)}`]);
  });
});

describe("a button listing that fails", () => {
  // SABOTAGE: call getWorkbookCodeUnits() without { strictButtonActions: true }
  // in collectLocalWorkbookScripts (scriptSecurity.ts) -> the failure reads as
  // "no button code", and the trusted workbook stays trusted.
  it("makes collectLocalWorkbookScripts throw, which LAPSES trust instead of keeping it", async () => {
    h.controls.set(0, [own(0, 1, 1, CODE)]);
    expect(await trustCurrentWorkbook()).toBe(true);

    h.fail = new Error("backend down");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(collectLocalWorkbookScripts()).rejects.toThrow("backend down");
    const evaluation = await evaluate();
    expect(evaluation.status).toBe("lapsed");
    expect(evaluation.reason).toBe("inventoryUnavailable");
  });

  it("...and refuses to RECORD trust over an inventory it could not take", async () => {
    h.fail = new Error("backend down");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await trustCurrentWorkbook()).toBe(false);
  });
});

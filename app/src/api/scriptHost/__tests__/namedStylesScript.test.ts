//! FILENAME: app/src/api/scriptHost/__tests__/namedStylesScript.test.ts
// PURPOSE: Wave 4 (formatting breadth) — named cell styles + theme palette.
// COVERS:  (1) the three named-style validators (name gate, apply rectangle,
//              create format gate incl. the range-edge/protection refusals);
//          (2) ALLOWLIST wiring for the five api.* rows;
//          (3) executeApplyNamedStyle: rect dispatch to the Wave-4 backend
//              command, active-sheet clamp, bulk ceiling;
//          (4) executeCreateNamedStyle: the TRANSIENT-WRITE dance (scratch
//              cell outside the used range, ONE cancelled transaction, revert
//              even on failure), duplicate refusal, theme-format lowering,
//              scratch probing past a styled candidate, and the
//              already-open-batch variant (no begin/cancel of its own);
//          (5) worker shim dispatch: the five flat api methods and the
//              range.applyStyle() sugar (unlocked reach; restricted ranges
//              keep the honest throw).

import { describe, it, expect, vi } from "vitest";

vi.mock("../../grid", () => ({
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  convertFormulaStyle: vi.fn(async (f: string) => f),
}));

import {
  vNamedStyleName,
  vNamedStyleApply,
  vNamedStyleCreate,
  vNone,
  MAX_RANGE_CELLS,
} from "../validators";
import { ALLOWLIST } from "../allowlist";
import {
  executeApplyNamedStyle,
  executeCreateNamedStyle,
} from "../host";
import { buildWorkerContext, type WorkerRuntime } from "../worker/contextShims";
import type { MountSpec, W2H } from "../protocol";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asLib = (l: unknown) => l as any;

// ============================================================================
// (1) validators
// ============================================================================

describe("named-style validators", () => {
  it("vNamedStyleName wants a non-empty bounded string", () => {
    expect(vNamedStyleName(["Good"])).toBe(true);
    expect(vNamedStyleName([""])).not.toBe(true);
    expect(vNamedStyleName(["   "])).not.toBe(true);
    expect(vNamedStyleName([42])).not.toBe(true);
    expect(vNamedStyleName(["x".repeat(256)])).not.toBe(true);
  });

  it("vNamedStyleApply gates the name AND the rectangle", () => {
    expect(vNamedStyleApply(["Good", 0, 0, 4, 2])).toBe(true);
    expect(vNamedStyleApply(["Good", 0, 0, 4, 2, "Data"])).toBe(true);
    expect(vNamedStyleApply(["", 0, 0, 4, 2])).not.toBe(true);
    expect(vNamedStyleApply(["Good", 4, 0, 0, 2])).not.toBe(true); // inverted
    expect(vNamedStyleApply(["Good", 0, 0, MAX_RANGE_CELLS, 0])).not.toBe(true); // too big
  });

  it("vNamedStyleCreate takes the setRangeFormat vocabulary (incl. theme colors + fills)", () => {
    expect(vNamedStyleCreate(["Alert", { bold: true, textColor: "#ffffff" }])).toBe(true);
    expect(vNamedStyleCreate(["Alert", { textColor: { theme: "accent1", tint: 0.4 } }])).toBe(true);
    expect(vNamedStyleCreate(["Alert", { fill: { type: "solid", color: "#c00000" } }])).toBe(true);
    expect(vNamedStyleCreate(["Alert", { borderBottom: { style: "double", color: "#000000" } }])).toBe(true);
    expect(vNamedStyleCreate(["Alert", {}])).not.toBe(true);
    expect(vNamedStyleCreate(["Alert", { bgColor: "#ffffff" }])).not.toBe(true);
  });

  it("vNamedStyleCreate REFUSES the range-edge border keys with the per-cell fix", () => {
    for (const key of ["borderOutline", "borderInsideHorizontal", "borderInsideVertical"]) {
      const verdict = vNamedStyleCreate(["Alert", { [key]: { style: "thin", color: "#000000" } }]);
      expect(verdict, key).not.toBe(true);
      expect(String(verdict)).toContain("PER-CELL");
      expect(String(verdict)).toContain("borderTop");
    }
  });

  it("vNamedStyleCreate refuses the protection attributes (base gate, not the unlocked one)", () => {
    const verdict = vNamedStyleCreate(["Alert", { locked: false }]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("protection");
  });
});

// ============================================================================
// (2) allowlist wiring
// ============================================================================

describe("named-style + theme allowlist rows", () => {
  it("all five rows are unlocked-tier with no capability", () => {
    for (const method of [
      "api.listNamedStyles", "api.applyNamedStyle", "api.createNamedStyle",
      "api.deleteNamedStyle", "api.getThemePalette",
    ]) {
      expect(ALLOWLIST[method], method).toBeDefined();
      expect(ALLOWLIST[method].tier, method).toBe("unlocked");
      expect(ALLOWLIST[method].capability, method).toBeUndefined();
    }
    expect(ALLOWLIST["api.listNamedStyles"].class).toBe("read");
    expect(ALLOWLIST["api.getThemePalette"].class).toBe("read");
    expect(ALLOWLIST["api.applyNamedStyle"].class).toBe("mutate");
    expect(ALLOWLIST["api.createNamedStyle"].class).toBe("mutate");
    expect(ALLOWLIST["api.deleteNamedStyle"].class).toBe("mutate");
  });

  it("the rows carry the matching validators + the bulk ceiling on apply", () => {
    expect(ALLOWLIST["api.listNamedStyles"].validate).toBe(vNone);
    expect(ALLOWLIST["api.getThemePalette"].validate).toBe(vNone);
    expect(ALLOWLIST["api.applyNamedStyle"].validate).toBe(vNamedStyleApply);
    expect(ALLOWLIST["api.applyNamedStyle"].limits?.maxCells).toBe(MAX_RANGE_CELLS);
    expect(ALLOWLIST["api.createNamedStyle"].validate).toBe(vNamedStyleCreate);
    expect(ALLOWLIST["api.deleteNamedStyle"].validate).toBe(vNamedStyleName);
  });
});

// ============================================================================
// The mock backend
// ============================================================================

interface MockCall {
  op: string;
  args?: unknown[];
}

function makeNamedStyleLib(options?: {
  transactionOpen?: boolean;
  styledScratch?: boolean;
  createRejects?: string;
  existing?: Array<{ name: string; builtIn: boolean; category: string }>;
}) {
  const order: MockCall[] = [];
  const existing = options?.existing ?? [
    { name: "Good", builtIn: true, category: "Good, Bad and Neutral" },
  ];
  let viewportCalls = 0;
  const lib = {
    getActiveSheet: vi.fn(async () => 0),
    getSheets: vi.fn(async () => ({
      sheets: [0, 1, 2].map((i) => ({ index: i, name: `Sheet${i + 1}` })),
      activeIndex: 0,
    })),
    getNamedStyles: vi.fn(async () => existing),
    applyNamedStyleRange: vi.fn(async (...args: unknown[]) => {
      order.push({ op: "applyNamedStyleRange", args });
      return { cells: [], styles: [] };
    }),
    createNamedStyle: vi.fn(async (name: string, styleIndex: number, category: string) => {
      order.push({ op: "createNamedStyle", args: [name, styleIndex, category] });
      if (options?.createRejects) throw new Error(options.createRejects);
      return { name, builtIn: false, styleIndex, category };
    }),
    deleteNamedStyle: vi.fn(async () => undefined),
    getUsedRange: vi.fn(async () => ({
      startRow: 0, startCol: 0, endRow: 9, endCol: 4, empty: false,
    })),
    getViewportCells: vi.fn(async (sr: number, sc: number) => {
      viewportCalls++;
      // Optionally: the FIRST candidate is styled — the probe must walk on.
      if (options?.styledScratch && viewportCalls === 1) {
        return [{ row: sr, col: sc, styleIndex: 7, display: "", formula: null }];
      }
      return [];
    }),
    getUndoState: vi.fn(async () => ({
      transactionOpen: options?.transactionOpen ?? false,
    })),
    beginUndoTransaction: vi.fn(async (description: string) => {
      order.push({ op: "begin", args: [description] });
    }),
    commitUndoTransaction: vi.fn(async () => {
      order.push({ op: "commit" });
    }),
    cancelUndoTransaction: vi.fn(async () => {
      order.push({ op: "cancel" });
    }),
    applyFormatting: vi.fn(async (rows: number[], cols: number[], format: unknown) => {
      order.push({ op: "applyFormatting", args: [rows, cols, format] });
      return {
        cells: [{ row: rows[0], col: cols[0], styleIndex: 42, display: "" }],
        styles: [],
      };
    }),
    clearRangeWithOptions: vi.fn(async (...args: unknown[]) => {
      order.push({ op: "clear", args });
      return { count: 1 };
    }),
    getDocumentTheme: vi.fn(async () => ({
      name: "Office",
      colors: { accent1: "#4472c4", dark1: "#000000", light1: "#ffffff" },
      fonts: { heading: "Calibri Light", body: "Calibri" },
    })),
  };
  return { lib, order };
}

// ============================================================================
// (3) executeApplyNamedStyle
// ============================================================================

describe("executeApplyNamedStyle", () => {
  it("dispatches the rect command with the name-first argument order", async () => {
    const { lib } = makeNamedStyleLib();
    await executeApplyNamedStyle(asLib(lib), "Good", 1, 2, 3, 4);
    expect(lib.applyNamedStyleRange).toHaveBeenCalledWith("Good", 1, 2, 3, 4);
  });

  it("accepts a sheet ref that RESOLVES to the active sheet (index or name)", async () => {
    const { lib } = makeNamedStyleLib();
    await executeApplyNamedStyle(asLib(lib), "Good", 0, 0, 0, 0, 0);
    await executeApplyNamedStyle(asLib(lib), "Good", 0, 0, 0, 0, "Sheet1");
    expect(lib.applyNamedStyleRange).toHaveBeenCalledTimes(2);
  });

  it("REFUSES a non-active sheet (the backend command has no sheet slot)", async () => {
    const { lib } = makeNamedStyleLib();
    await expect(
      executeApplyNamedStyle(asLib(lib), "Good", 0, 0, 0, 0, 2),
    ).rejects.toThrow(/active sheet/);
    await expect(
      executeApplyNamedStyle(asLib(lib), "Good", 0, 0, 0, 0, "Sheet3"),
    ).rejects.toThrow(/active sheet/);
    expect(lib.applyNamedStyleRange).not.toHaveBeenCalled();
  });

  it("refuses a rectangle over the bulk ceiling", async () => {
    const { lib } = makeNamedStyleLib();
    await expect(
      executeApplyNamedStyle(asLib(lib), "Good", 0, 0, 999, 999),
    ).rejects.toThrow(/range too large/);
    expect(lib.applyNamedStyleRange).not.toHaveBeenCalled();
  });
});

// ============================================================================
// (4) executeCreateNamedStyle — the transient-write dance
// ============================================================================

describe("executeCreateNamedStyle", () => {
  it("runs the full dance in order: begin -> apply(scratch) -> create -> revert -> cancel", async () => {
    const { lib, order } = makeNamedStyleLib();
    const created = await executeCreateNamedStyle(asLib(lib), "Alert", { bold: true });
    expect(created).toEqual({ name: "Alert", builtIn: false, category: "Custom" });
    // Scratch = used range end + 2 on both axes (outside anything stored).
    expect(order.map((c) => c.op)).toEqual([
      "begin", "applyFormatting", "createNamedStyle", "clear", "cancel",
    ]);
    expect(order[1].args).toEqual([[11], [6], { bold: true }]);
    // The minted style index (42) is what the name registers against.
    expect(order[2].args).toEqual(["Alert", 42, "Custom"]);
    // The revert clears exactly the scratch cell, everything.
    expect(order[3].args).toEqual([11, 6, 11, 6, "all"]);
    // NEVER a commit: the record is dropped, not kept.
    expect(lib.commitUndoTransaction).not.toHaveBeenCalled();
  });

  it("lowers theme colors into *Theme/*Tint before the scratch write", async () => {
    const { lib } = makeNamedStyleLib();
    await executeCreateNamedStyle(asLib(lib), "Branded", {
      bold: true,
      textColor: { theme: "accent1", tint: 0.4 },
    });
    expect(lib.applyFormatting).toHaveBeenCalledWith([11], [6], {
      bold: true, textColorTheme: "accent1", textColorTint: 400,
    });
  });

  it("walks past a styled scratch candidate (a virgin cell or nothing)", async () => {
    const { lib } = makeNamedStyleLib({ styledScratch: true });
    await executeCreateNamedStyle(asLib(lib), "Alert", { italic: true });
    // First candidate (11, 6) was styled; the probe moved to (14, 11).
    expect(lib.applyFormatting).toHaveBeenCalledWith([14], [11], { italic: true });
  });

  it("refuses a duplicate name (case-insensitive) BEFORE touching the grid", async () => {
    const { lib } = makeNamedStyleLib();
    await expect(
      executeCreateNamedStyle(asLib(lib), "good", { bold: true }),
    ).rejects.toThrow(/already exists/);
    expect(lib.applyFormatting).not.toHaveBeenCalled();
    expect(lib.beginUndoTransaction).not.toHaveBeenCalled();
  });

  it("reverts the scratch cell and cancels EVEN when the backend create fails", async () => {
    const { lib, order } = makeNamedStyleLib({ createRejects: "boom" });
    await expect(
      executeCreateNamedStyle(asLib(lib), "Alert", { bold: true }),
    ).rejects.toThrow("boom");
    expect(order.map((c) => c.op)).toEqual([
      "begin", "applyFormatting", "createNamedStyle", "clear", "cancel",
    ]);
  });

  it("joins an already-open script batch instead of cancelling it", async () => {
    const { lib, order } = makeNamedStyleLib({ transactionOpen: true });
    await executeCreateNamedStyle(asLib(lib), "Alert", { bold: true });
    // No begin/cancel of its own — cancelling would destroy the script's
    // batch; the apply+revert pair nets to nothing inside it.
    expect(order.map((c) => c.op)).toEqual(["applyFormatting", "createNamedStyle", "clear"]);
    expect(lib.beginUndoTransaction).not.toHaveBeenCalled();
    expect(lib.cancelUndoTransaction).not.toHaveBeenCalled();
  });
});

// ============================================================================
// (5) worker shim dispatch + range sugar
// ============================================================================

interface PostedCall {
  callId: number;
  method: string;
  args: unknown[];
}

function makeContext(tier: "restricted" | "unlocked" = "unlocked"): {
  context: Record<string, unknown>;
  api: Record<string, unknown>;
  rt: WorkerRuntime;
  calls: PostedCall[];
  drain: () => void;
} {
  const calls: PostedCall[] = [];
  const spec = {
    protocolVersion: 1,
    scriptId: "wave4-named-styles-test",
    objectType: "sheet",
    instanceId: null,
    tier,
    capabilities: [],
    apiVersion: "1.0.0",
    scriptName: "Wave4NamedStyles",
    packageInfo: null,
    snapshot: {},
    source: "",
  } as unknown as MountSpec;
  const { context, rt } = buildWorkerContext(spec, (msg: W2H) => {
    if (msg.t === "call") calls.push({ callId: msg.callId, method: msg.method, args: msg.args });
  });
  const drain = (): void => {
    for (const entry of rt.pending.values()) clearTimeout(entry.timer);
    rt.pending.clear();
  };
  return {
    context: context as Record<string, unknown>,
    api: (context as Record<string, unknown>).api as Record<string, unknown>,
    rt,
    calls,
    drain,
  };
}

describe("worker shim: named styles + theme palette", () => {
  it("the flat api methods dispatch verbatim", () => {
    const { api, calls, drain } = makeContext();
    void (api.listNamedStyles as () => Promise<unknown>)();
    void (api.applyNamedStyle as (...a: unknown[]) => Promise<unknown>)("Good", 0, 0, 4, 2, "Data");
    void (api.createNamedStyle as (...a: unknown[]) => Promise<unknown>)("Alert", { bold: true });
    void (api.deleteNamedStyle as (...a: unknown[]) => Promise<unknown>)("Alert");
    void (api.getThemePalette as () => Promise<unknown>)();
    expect(calls.map((c) => [c.method, ...c.args])).toEqual([
      ["api.listNamedStyles"],
      ["api.applyNamedStyle", "Good", 0, 0, 4, 2, "Data"],
      ["api.createNamedStyle", "Alert", { bold: true }],
      ["api.deleteNamedStyle", "Alert"],
      ["api.getThemePalette"],
    ]);
    drain();
  });

  it("workbook-navigation ranges get applyStyle() riding api.applyNamedStyle WITH the sheet", async () => {
    const { api, rt, calls, drain } = makeContext();
    const wbPromise = (
      api.workbook as { sheet: (ref: unknown) => Promise<Record<string, unknown> | null> }
    ).sheet("Data");
    rt.settleCall(calls[0].callId, true, ["Intro", "Data"]);
    const sheet = await wbPromise;
    calls.length = 0;
    const range = (sheet as { range: (a: string) => Record<string, unknown> }).range("A1:B2");
    void (range.applyStyle as (name: string) => Promise<unknown>)("Heading 1");
    expect(calls[0]).toMatchObject({
      method: "api.applyNamedStyle",
      args: ["Heading 1", 0, 0, 1, 1, 1],
    });
    drain();
  });

  it("a RESTRICTED sheet range keeps the honest throw (unlocked-tier reach)", async () => {
    const { context, calls, drain } = makeContext("restricted");
    const range = (context.range as (a: string) => Record<string, unknown>)("A1:B2");
    await expect(
      (range.applyStyle as (name: string) => Promise<unknown>)("Good"),
    ).rejects.toThrow(/not available/);
    expect(calls.length).toBe(0);
    drain();
  });
});

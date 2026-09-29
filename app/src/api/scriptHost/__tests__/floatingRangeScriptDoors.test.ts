//! FILENAME: app/src/api/scriptHost/__tests__/floatingRangeScriptDoors.test.ts
// PURPOSE: The floating-range script doors' EXECUTORS (review 2026-09-27):
//          - `api.floatingRangeResize` goes through the owning extension's
//            seam (@api/floatingRangeService), never straight at the backend:
//            the extension's `resize` refuses a range its canvas LOCKS (a
//            frontend rule the backend never consults) and keeps the store,
//            regions and caches in step. Straight at `update_floating_range`,
//            a script grew a locked range every other door refused to touch;
//          - `api.createFloatingRange` ANNOUNCES the created row even when the
//            follow-up resize is refused (the create is not undoable, and an
//            unannounced row stayed invisible until some later reload).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invokeBackend = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
vi.mock("../../backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../backend")>()),
  invokeBackend: (...args: unknown[]) => invokeBackend(...args),
}));

import { executeCreateFloatingRange, executeFloatingRangeResize, executeFloatingRangeGetCells } from "../host";
import { BrokerError } from "../broker";
import {
  registerFloatingRangeProvider,
  resetFloatingRangeProvider,
  type FloatingRangeProvider,
} from "../../floatingRangeService";
import type { FloatingRangeInfo } from "../../floatingRanges";
import { AppEvents, onAppEvent } from "../../events";

const ID = "11111111-1111-7111-8111-111111111111";

function info(rows: number, cols: number): FloatingRangeInfo {
  return {
    id: ID,
    backingSheetId: "backing",
    hostSheetId: "host",
    x: 40,
    y: 40,
    rotation: 0,
    pinToGrid: false,
    rowCount: rows,
    colCount: cols,
    colWidths: {},
    rowHeights: {},
    showTitle: true,
    showColumnHeaders: true,
    showRowHeaders: true,
    name: "Float1",
    backingSheetIndex: 1,
    hostSheetIndex: 0,
  };
}

function provider(resize: FloatingRangeProvider["resize"]): FloatingRangeProvider {
  return {
    list: () => [],
    create: vi.fn(),
    resize,
    rename: vi.fn(),
    delete: vi.fn(),
    getCells: vi.fn(),
    setCells: vi.fn(),
  } as unknown as FloatingRangeProvider;
}

beforeEach(() => {
  invokeBackend.mockReset();
  invokeBackend.mockResolvedValue(null);
  resetFloatingRangeProvider();
});

afterEach(() => {
  resetFloatingRangeProvider();
});

describe("api.floatingRangeResize goes through the extension's seam", () => {
  it("asks the provider -- never the backend directly -- and reports the new window", async () => {
    const resize = vi.fn(async () => info(20, 8));
    registerFloatingRangeProvider(provider(resize));
    const ref = await executeFloatingRangeResize([ID, 20, 8]);
    expect(resize).toHaveBeenCalledWith(ID, 20, 8);
    expect(invokeBackend).not.toHaveBeenCalled();
    expect(ref).toMatchObject({ kind: "floatingRange", id: ID, rowCount: 20, columnCount: 8, range: "A1:H20" });
  });

  it("a range the canvas LOCKS is refused, and update_floating_range is never invoked", async () => {
    registerFloatingRangeProvider(
      provider(async () => {
        throw new Error('The floating range "Float1" is locked on this canvas; unlock it to change its size.');
      }),
    );
    const refused = executeFloatingRangeResize([ID, 20, 8]);
    await expect(refused).rejects.toBeInstanceOf(BrokerError);
    await expect(refused).rejects.toMatchObject({ code: "ValidationError", message: expect.stringMatching(/locked/) });
    expect(invokeBackend).not.toHaveBeenCalled();
  });

  it("with the extension not loaded, it refuses loudly instead of writing an invisible change", async () => {
    await expect(executeFloatingRangeResize([ID, 2, 2])).rejects.toMatchObject({ code: "HostError" });
    expect(invokeBackend).not.toHaveBeenCalled();
  });
});

describe("api.createFloatingRange announces the row even when its resize is refused", () => {
  it("a refused follow-up resize still tells the extension the created row exists", async () => {
    invokeBackend.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === "create_floating_range") return { ...info(1, 1) };
      if (cmd === "update_floating_range") throw new Error("Cannot move or resize a floating range on a protected sheet.");
      return null;
    });
    const heard: unknown[] = [];
    const off = onAppEvent(AppEvents.MUTATION_REFRESH, (detail) => heard.push(detail));
    try {
      await expect(executeCreateFloatingRange([{ rows: 5, cols: 3 }])).rejects.toThrow(/protected sheet/);
      expect(heard).toContainEqual(expect.objectContaining({ domains: ["floatingRanges"] }));
    } finally {
      off();
    }
  });

  it("control: a 1x1 create announces and returns the row", async () => {
    invokeBackend.mockImplementation(async () => ({ ...info(1, 1) }));
    const heard: unknown[] = [];
    const off = onAppEvent(AppEvents.MUTATION_REFRESH, (detail) => heard.push(detail));
    try {
      const ref = await executeCreateFloatingRange([undefined]);
      expect(ref).toMatchObject({ kind: "floatingRange", id: ID, range: "A1" });
      expect(heard.length).toBe(1);
      expect(invokeBackend).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });
});

// E10 (a): a script's read of a floating range asked the backend for the whole
// window in ONE call, and `get_range_cells_typed` refuses more than 100,000
// cells -- a window may be 1000 x 256 -- so `floatingRangeGetCells` failed on
// every large range. It also mapped each cell's `kind` from a field the wire
// does not carry (`type` is), so every cell came back with `kind: undefined`.
//
// Review B (2026-09-28): the first fix cut the read into bands HERE, a second
// copy of the extension's own banding (lib/frCellReads.ts) beside the
// backend's ceiling -- the copied recipe the Seam Rule forbids. The read now
// goes through the owning extension's seam (@api/floatingRangeService
// `getCells`), exactly as `api.floatingRangeResize` does; the banding is
// the provider's (pinned in FloatingRange's frSheetChange.test.ts).
describe("api.floatingRangeGetCells reads through the extension's seam (E10)", () => {
  function backendWith(rows: number, cols: number): string[] {
    const commands: string[] = [];
    invokeBackend.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      commands.push(cmd);
      if (cmd === "list_floating_ranges") return [{ ...info(rows, cols) }];
      return null;
    });
    return commands;
  }

  function readingProvider(): { getCells: ReturnType<typeof vi.fn> } {
    const getCells = vi.fn(async () => [
      { row: 999, col: 255, value: 7, display: "7", formula: "=3+4", type: "number" },
      { row: 3, col: 1, value: "x", display: "x", formula: null, type: "text" },
    ]);
    registerFloatingRangeProvider({ ...provider(vi.fn()), getCells } as unknown as FloatingRangeProvider);
    return { getCells };
  }

  it("asks the provider for the WHOLE window once -- never get_floating_range_cells -- and maps type to kind", async () => {
    const commands = backendWith(1000, 256);
    const { getCells } = readingProvider();
    const result = (await executeFloatingRangeGetCells([ID])) as {
      rowCount: number;
      colCount: number;
      cells: Array<{ row: number; col: number; kind: string; value: unknown; formula?: string }>;
    };
    expect(getCells).toHaveBeenCalledTimes(1);
    expect(getCells).toHaveBeenCalledWith(ID, 0, 0, 999, 255);
    expect(commands).not.toContain("get_floating_range_cells");
    expect(result.rowCount).toBe(1000);
    expect(result.colCount).toBe(256);
    expect(result.cells).toEqual([
      { row: 999, col: 255, kind: "number", value: 7, formula: "=3+4" },
      { row: 3, col: 1, kind: "text", value: "x", formula: undefined },
    ]);
  });

  it("with the extension not loaded, it refuses loudly and reads nothing from the backend", async () => {
    const commands = backendWith(4, 3);
    await expect(executeFloatingRangeGetCells([ID])).rejects.toMatchObject({ code: "HostError" });
    expect(commands).not.toContain("get_floating_range_cells");
  });

  it("control: an unknown id is a ValidationError, and the provider is not asked", async () => {
    backendWith(4, 3);
    const { getCells } = readingProvider();
    await expect(executeFloatingRangeGetCells(["22222222-2222-7222-8222-222222222222"])).rejects.toMatchObject({
      code: "ValidationError",
    });
    expect(getCells).not.toHaveBeenCalled();
  });
});

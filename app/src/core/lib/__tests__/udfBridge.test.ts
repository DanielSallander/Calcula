//! FILENAME: app/src/core/lib/__tests__/udfBridge.test.ts
// PURPOSE: Guard the UDF pre-resolution bridge in tauri-api.ts — specifically
//          that the BATCH path (paste, fill handle, multi-cell edit) runs the
//          same resolve pass as the single-cell path and forwards its results.
// CONTEXT: The batch bridge used to invoke update_cells_batch with `{updates}`
//          only, so a freshly pasted =MYUDF(...) had no pre-fetched value and
//          nothing stored to preserve — the backend's preserved_udf_value
//          returned #NAME? and the paste visibly corrupted the formula.

import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  updateCell,
  updateCellsBatch,
  setUdfResolveHook,
  type UdfPendingEdit,
  type UdfResolveResult,
} from "../tauri-api";

/** The arg bag a command was invoked with. */
function argsFor(command: string): Record<string, unknown> | undefined {
  const call = invokeMock.mock.calls.find((c) => c[0] === command);
  return call?.[1] as Record<string, unknown> | undefined;
}

describe("UDF pre-resolution bridge", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "update_cell") return { cells: [], dimensionChanges: [] };
      return [];
    });
    setUdfResolveHook(null);
  });

  it("runs the resolve pass for a BATCH and forwards udfResults", async () => {
    const seen: UdfPendingEdit[][] = [];
    setUdfResolveHook(async (edits) => {
      seen.push(edits);
      return {
        results: { "MYFN|[1]": { kind: "number", value: 42 } },
        volatileCells: [],
      } as UdfResolveResult;
    });

    await updateCellsBatch([
      { row: 0, col: 0, value: "=MYFN(A1)" },
      { row: 1, col: 0, value: "7", invariant: true },
    ]);

    // Every pending write is offered to the resolver, with the invariant flag.
    expect(seen).toEqual([
      [
        { row: 0, col: 0, value: "=MYFN(A1)", invariant: undefined },
        { row: 1, col: 0, value: "7", invariant: true },
      ],
    ]);
    const args = argsFor("update_cells_batch");
    expect(args?.updates).toHaveLength(2);
    expect(args?.udfResults).toEqual({ "MYFN|[1]": { kind: "number", value: 42 } });
  });

  it("forwards volatile cells so the backend can splice them into the recalc order", async () => {
    setUdfResolveHook(async () => ({
      results: { "TICK|[]": { kind: "number", value: 1 } },
      volatileCells: [{ row: 9, col: 3 }],
    }));

    await updateCellsBatch([{ row: 0, col: 0, value: "1" }]);

    expect(argsFor("update_cells_batch")?.udfVolatileCells).toEqual([{ row: 9, col: 3 }]);
  });

  it("omits both UDF keys entirely when the resolver has nothing (fast path)", async () => {
    setUdfResolveHook(async () => undefined);

    await updateCellsBatch([{ row: 0, col: 0, value: "plain text" }]);

    const args = argsFor("update_cells_batch");
    expect(args).toEqual({ updates: [{ row: 0, col: 0, value: "plain text" }] });
    expect("udfResults" in (args ?? {})).toBe(false);
    expect("udfVolatileCells" in (args ?? {})).toBe(false);
  });

  it("makes no extra IPC and sends no UDF keys when no hook is installed", async () => {
    await updateCellsBatch([{ row: 2, col: 2, value: "5" }]);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(argsFor("update_cells_batch")).toEqual({
      updates: [{ row: 2, col: 2, value: "5" }],
    });
  });

  it("never lets a failing resolver block the write", async () => {
    setUdfResolveHook(async () => {
      throw new Error("resolver exploded");
    });

    await expect(
      updateCellsBatch([{ row: 0, col: 0, value: "=MYFN(A1)" }]),
    ).resolves.toBeDefined();
    const args = argsFor("update_cells_batch");
    expect(args?.udfResults).toBeUndefined();
  });

  it("still resolves the single-cell path through the same hook", async () => {
    const seen: UdfPendingEdit[][] = [];
    setUdfResolveHook(async (edits) => {
      seen.push(edits);
      return { results: { "K|[]": { kind: "text", value: "ok" } }, volatileCells: [] };
    });

    await updateCell(4, 5, "=MYFN()");

    expect(seen).toEqual([[{ row: 4, col: 5, value: "=MYFN()" }]]);
    expect(argsFor("update_cell")?.udfResults).toEqual({ "K|[]": { kind: "text", value: "ok" } });
  });
});

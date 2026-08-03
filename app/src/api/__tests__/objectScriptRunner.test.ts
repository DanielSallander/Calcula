//! FILENAME: app/src/api/__tests__/objectScriptRunner.test.ts
// PURPOSE: `runObjectScriptOnce` is a real, complete execution: the mount is
//          awaited, the realm is always torn down, failures reach the caller,
//          and a killed run cannot leave an undo transaction open.
// CONTEXT: This primitive exists because the object-script vocabulary
//          (`context.api`) had no execution path that did not require owning an
//          on-grid object — which is why "Run" in the macro library could not be
//          implemented and was disabled instead. Everything the macro library
//          promises now rests on the properties pinned here.

import { describe, it, expect, beforeEach, vi } from "vitest";

const hostMountScript = vi.fn(async (_d: unknown) => undefined);
const hostUnmountScript = vi.fn((_id: string) => undefined);
const mountedIds = new Set<string>();
const workerAvailable = { value: true };

vi.mock("../scriptHost/host", () => ({
  hostMountScript: (d: unknown) => hostMountScript(d),
  hostUnmountScript: (id: string) => {
    mountedIds.delete(id);
    return hostUnmountScript(id);
  },
  hostIsMounted: (id: string) => mountedIds.has(id),
  workerRealmAvailable: () => workerAvailable.value,
}));

const undo = { open: false };
const cancelUndoTransaction = vi.fn(async () => {
  undo.open = false;
});

vi.mock("../lib", () => ({
  getUndoState: async () => ({ transactionOpen: undo.open }),
  cancelUndoTransaction: () => cancelUndoTransaction(),
}));

import { runObjectScriptOnce } from "../objectScriptRunner";

beforeEach(() => {
  hostMountScript.mockReset().mockResolvedValue(undefined);
  hostUnmountScript.mockReset();
  cancelUndoTransaction.mockClear();
  mountedIds.clear();
  undo.open = false;
  workerAvailable.value = true;
});

describe("runObjectScriptOnce", () => {
  it("mounts the source as an unlocked workbook script by default", async () => {
    await runObjectScriptOnce({ name: "Macro1426", source: "function setup(c){}" });

    expect(hostMountScript).toHaveBeenCalledTimes(1);
    const spec = hostMountScript.mock.calls[0][0] as Record<string, unknown>;
    expect(spec).toMatchObject({
      name: "Macro1426",
      source: "function setup(c){}",
      objectType: "workbook",
      instanceId: null,
      accessLevel: "unlocked",
      provenance: "local",
    });
    // The id is unique per run and cannot collide with a user's own script.
    expect(String(spec.id)).toMatch(/^__calcula_run-once_/);
  });

  it("gives every run a distinct id", async () => {
    await runObjectScriptOnce({ name: "A", source: "" });
    await runObjectScriptOnce({ name: "A", source: "" });
    const first = (hostMountScript.mock.calls[0][0] as { id: string }).id;
    const second = (hostMountScript.mock.calls[1][0] as { id: string }).id;
    expect(first).not.toBe(second);
  });

  it("tears the realm down after a successful run", async () => {
    hostMountScript.mockImplementation(async (d) => {
      mountedIds.add((d as { id: string }).id);
    });
    await runObjectScriptOnce({ name: "A", source: "" });
    expect(hostUnmountScript).toHaveBeenCalledTimes(1);
    expect(mountedIds.size).toBe(0);
  });

  it("propagates the script's own error — a run that failed is not a success", async () => {
    hostMountScript.mockRejectedValueOnce(new Error("ReferenceError: api is not defined"));
    await expect(
      runObjectScriptOnce({ name: "A", source: "" }),
    ).rejects.toThrow(/api is not defined/);
  });

  it("translates the mount deadline into language a Run user can act on", async () => {
    hostMountScript.mockRejectedValueOnce(new Error("Script mount timed out (10s)"));
    await expect(
      runObjectScriptOnce({ name: "Macro1426", source: "" }),
    ).rejects.toThrow(/still running after 10 seconds/);
  });

  it("refuses clearly when there is no worker realm at all", async () => {
    workerAvailable.value = false;
    await expect(runObjectScriptOnce({ name: "A", source: "" })).rejects.toThrow(
      /worker realm/i,
    );
    expect(hostMountScript).not.toHaveBeenCalled();
  });

  it("closes an undo transaction the run left open", async () => {
    // A recorded macro opens one in beginBatch. Killed before commitBatch, the
    // open group would swallow every later edit the user makes and quietly
    // break their Ctrl+Z.
    hostMountScript.mockImplementationOnce(async () => {
      undo.open = true;
      throw new Error("Script mount timed out (10s)");
    });

    await expect(runObjectScriptOnce({ name: "A", source: "" })).rejects.toThrow();
    expect(cancelUndoTransaction).toHaveBeenCalledTimes(1);
    expect(undo.open).toBe(false);
  });

  it("leaves a transaction that was ALREADY open alone", async () => {
    undo.open = true;
    await runObjectScriptOnce({ name: "A", source: "" });
    expect(cancelUndoTransaction).not.toHaveBeenCalled();
    expect(undo.open).toBe(true);
  });

  it("does not cancel anything when the run closed its own transaction", async () => {
    hostMountScript.mockImplementationOnce(async () => {
      undo.open = true; // beginBatch
      undo.open = false; // commitBatch
    });
    await runObjectScriptOnce({ name: "A", source: "" });
    expect(cancelUndoTransaction).not.toHaveBeenCalled();
  });
});

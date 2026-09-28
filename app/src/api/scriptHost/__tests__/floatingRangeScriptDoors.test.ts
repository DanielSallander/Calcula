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

import { executeCreateFloatingRange, executeFloatingRangeResize } from "../host";
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

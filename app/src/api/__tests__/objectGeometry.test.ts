//! FILENAME: app/src/api/__tests__/objectGeometry.test.ts
// PURPOSE: The OBJECT GEOMETRY seam's contract: `commitObjectGeometry` groups
//          the changes by provider inside ONE undo transaction (one begin, one
//          commit, every provider's commit between them), resolves only after
//          every involved provider has FLUSHED its debounced saves, and a
//          refusal is reported in ONE error toast (the provider reverted it);
//          plus the frontend-owned transaction: joiners never commit early, and
//          the opener's commit waits for work that joined while it waited.

import { describe, it, expect, beforeEach, vi } from "vitest";

const log: string[] = [];
vi.mock("../../core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/lib/tauri-api")>()),
  beginUndoTransaction: vi.fn(async (label: string) => {
    log.push(`begin:${label}`);
  }),
  commitUndoTransaction: vi.fn(async () => {
    log.push("commit");
  }),
}));

const toasts: Array<{ message: string; type?: string }> = [];
vi.mock("../notifications", () => ({
  showToast: (message: string, options: { type?: string } = {}) => {
    toasts.push({ message, type: options.type });
  },
}));

import {
  commitObjectGeometry,
  joinUndoTransaction,
  openUndoTransaction,
  previewObjectGeometry,
  registerObjectGeometryProvider,
  resetObjectGeometryProviders,
  runInUndoTransaction,
  type ObjectGeometryChange,
  type ObjectGeometryProvider,
} from "../objectGeometry";
import type { GridRegion } from "../gridOverlays";
import { beginUndoTransaction, commitUndoTransaction } from "../../core/lib/tauri-api";

function region(id: string, type: string, floating = { x: 0, y: 0, width: 100, height: 50 }): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating, data: {} };
}

function change(r: GridRegion, x: number, y: number, width = 100, height = 50): ObjectGeometryChange {
  return { region: r, x, y, width, height };
}

/** A macrotask: what an IPC round trip or a debounce actually costs. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A provider whose commit SCHEDULES a debounced save that only its flush lands. */
function debouncedProvider(name: string, types: string[]): ObjectGeometryProvider & { landed: string[] } {
  let pending: ObjectGeometryChange[] = [];
  const landed: string[] = [];
  return {
    types,
    landed,
    preview: vi.fn(),
    commit: vi.fn(async (changes) => {
      log.push(`commit:${name}:${changes.length}`);
      pending = [...pending, ...changes];
    }),
    flush: vi.fn(async () => {
      await tick();
      for (const c of pending) landed.push(c.region.id);
      pending = [];
      log.push(`flushed:${name}`);
    }),
  };
}

beforeEach(() => {
  resetObjectGeometryProviders();
  log.length = 0;
  toasts.length = 0;
  vi.mocked(beginUndoTransaction).mockClear();
  vi.mocked(commitUndoTransaction).mockClear();
});

describe("commitObjectGeometry: ONE undo step, grouped by provider", () => {
  it("runs every provider's commit, and its flush, between exactly one begin and one commit", async () => {
    const charts = debouncedProvider("charts", ["chart"]);
    const slicers = debouncedProvider("slicers", ["slicer"]);
    registerObjectGeometryProvider(charts);
    registerObjectGeometryProvider(slicers);

    const outcome = await commitObjectGeometry(
      [
        change(region("chart-1", "chart"), 10, 10),
        change(region("slicer-1", "slicer"), 20, 20),
        change(region("chart-2", "chart"), 30, 30),
      ],
      "Align Left",
    );

    expect(outcome).toEqual({ committed: 3, refused: 0, skipped: 0 });
    expect(beginUndoTransaction).toHaveBeenCalledTimes(1);
    expect(commitUndoTransaction).toHaveBeenCalledTimes(1);
    // Grouped: ONE commit call per provider, both charts in the first.
    expect(log).toEqual([
      "begin:Align Left",
      "commit:charts:2",
      "commit:slicers:1",
      "flushed:charts",
      "flushed:slicers",
      "commit",
    ]);
  });

  it("resolves only after every debounced save has LANDED", async () => {
    const charts = debouncedProvider("charts", ["chart"]);
    registerObjectGeometryProvider(charts);
    await commitObjectGeometry([change(region("chart-1", "chart"), 5, 5)], "Nudge");
    expect(charts.landed).toEqual(["chart-1"]);
    // ...and the transaction closed after the save, not before it.
    expect(log.indexOf("flushed:charts")).toBeLessThan(log.indexOf("commit"));
  });

  it("a REFUSED provider does not stop the others, and is told in ONE error toast", async () => {
    const charts = debouncedProvider("charts", ["chart"]);
    const refusing: ObjectGeometryProvider = {
      types: ["slicer"],
      commit: vi.fn(async () => {
        throw new Error("The sheet is protected.");
      }),
    };
    registerObjectGeometryProvider(charts);
    registerObjectGeometryProvider(refusing);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await commitObjectGeometry(
      [
        change(region("slicer-1", "slicer"), 1, 1),
        change(region("slicer-2", "slicer"), 2, 2),
        change(region("chart-1", "chart"), 3, 3),
      ],
      "Align Top",
    );
    errors.mockRestore();

    expect(outcome).toEqual({ committed: 1, refused: 2, skipped: 0 });
    expect(charts.landed).toEqual(["chart-1"]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe("error");
    expect(toasts[0].message).toContain("Align Top: 2 objects could not be moved.");
    expect(toasts[0].message).toContain("The sheet is protected.");
    // Still one step for what DID land.
    expect(beginUndoTransaction).toHaveBeenCalledTimes(1);
    expect(commitUndoTransaction).toHaveBeenCalledTimes(1);
  });

  it("a position-only family (canResize false) keeps its size", async () => {
    const commit = vi.fn(async () => {});
    registerObjectGeometryProvider({ types: ["floating-range"], canResize: () => false, commit });
    await commitObjectGeometry([change(region("fr-1", "floating-range"), 40, 40, 999, 999)], "Nudge");
    expect(commit).toHaveBeenCalledWith([expect.objectContaining({ x: 40, y: 40, width: 100, height: 50 })]);
  });

  it("changes no provider owns are skipped, and nothing at all opens no transaction", async () => {
    const outcome = await commitObjectGeometry([change(region("x-1", "unknown"), 1, 1)], "Nudge");
    expect(outcome).toEqual({ committed: 0, refused: 0, skipped: 1 });
    expect(beginUndoTransaction).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(0);
  });

  it("preview writes nothing and opens no transaction", () => {
    const charts = debouncedProvider("charts", ["chart"]);
    registerObjectGeometryProvider(charts);
    previewObjectGeometry([change(region("chart-1", "chart"), 9, 9)]);
    expect(charts.preview).toHaveBeenCalledTimes(1);
    expect(charts.commit).not.toHaveBeenCalled();
    expect(beginUndoTransaction).not.toHaveBeenCalled();
  });
});

describe("the frontend-owned undo transaction", () => {
  it("a commit inside an OPEN transaction joins it: still one begin and one commit, the commit last", async () => {
    const charts = debouncedProvider("charts", ["chart"]);
    registerObjectGeometryProvider(charts);
    const outer = openUndoTransaction("Move Objects");
    // A family's own persist joins too (a slicer co-move, say).
    const familyWrite = runInUndoTransaction("Move Slicers", async () => {
      await tick();
      log.push("slicer write");
    });
    await outer.run(() => commitObjectGeometry([change(region("chart-1", "chart"), 1, 1)], "Move Objects"));
    await outer.commit();
    await familyWrite;

    expect(beginUndoTransaction).toHaveBeenCalledTimes(1);
    expect(commitUndoTransaction).toHaveBeenCalledTimes(1);
    expect(log[0]).toBe("begin:Move Objects");
    expect(log.at(-1)).toBe("commit");
    expect(log).toContain("slicer write");
  });

  it("the opener's commit waits for work that joined WHILE it was waiting", async () => {
    const outer = openUndoTransaction("Move Objects");
    let late = false;
    void outer.run(async () => {
      await tick();
      // Joined after the commit started waiting.
      void joinUndoTransaction(async () => {
        await tick();
        await tick();
        late = true;
        log.push("late write");
      });
    });
    await outer.commit();
    expect(late).toBe(true);
    expect(log.indexOf("late write")).toBeLessThan(log.indexOf("commit"));
  });

  it("joinUndoTransaction with nothing open runs the write plainly (no begin/commit)", async () => {
    let ran = false;
    await joinUndoTransaction(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(beginUndoTransaction).not.toHaveBeenCalled();
    expect(commitUndoTransaction).not.toHaveBeenCalled();
  });

  it("runInUndoTransaction commits even when the work throws", async () => {
    await expect(
      runInUndoTransaction("Resize Slicers", async () => {
        throw new Error("half-written");
      }),
    ).rejects.toThrow("half-written");
    expect(beginUndoTransaction).toHaveBeenCalledTimes(1);
    expect(commitUndoTransaction).toHaveBeenCalledTimes(1);
  });
});

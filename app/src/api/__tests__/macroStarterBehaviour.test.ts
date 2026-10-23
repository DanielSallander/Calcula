//! FILENAME: app/src/api/__tests__/macroStarterBehaviour.test.ts
// PURPOSE: RUN the generated starter, not just read it: `setup(context)` is
//          evaluated against a recording fake of the unlocked API and must do
//          what the template's comments promise -- one read per selected area,
//          ONE write holding only the plain numbers (as numbers, the text cell
//          and the formula cell untouched), the undo bracket opened before the
//          write and closed after it even when a read fails, a notification in
//          both the button and the direct branch, and the two refusals (nothing
//          selected; no cell access) thrown before anything is touched.
// CONTEXT: docs/design/open-items.md section 2.ap. The source is compiled with
//          `new Function` exactly as a script body, and `setup` is invoked the
//          way the host invokes it: with `context.api` and `notify`, plus
//          `onClick` only on a button-shaped mount.

import { describe, it, expect, vi } from "vitest";
import { buildMacroStarterSource, macroNeedsCellAccessMessage } from "@api/scriptHost/macroStarter";

type Cell = { type: string; value: unknown; display: string; formula?: string };
type Area = { startRow: number; startCol: number; endRow: number; endCol: number };
type Selection = Area & { sheetIndex: number; activeRow: number; activeCol: number; areas: Area[] };

const A1_TO_A4: Area = { startRow: 0, startCol: 0, endRow: 3, endCol: 0 };
const C1: Area = { startRow: 0, startCol: 2, endRow: 0, endCol: 2 };

/** A1:A4 plus C1 (Ctrl+click), on sheet 0. */
const TWO_AREAS: Selection = {
  ...A1_TO_A4,
  sheetIndex: 0,
  activeRow: 0,
  activeCol: 0,
  areas: [A1_TO_A4, C1],
};

/** 10, 2.5, "x", =A1*2 (showing 20) down column A; 5 in C1. */
function fixtureRows(startRow: number, startCol: number): Cell[][] {
  if (startCol === 0 && startRow === 0) {
    return [
      [{ type: "number", value: 10, display: "10" }],
      [{ type: "number", value: 2.5, display: "2.5" }],
      [{ type: "text", value: "x", display: "x" }],
      [{ type: "number", value: 20, display: "20", formula: "=A1*2" }],
    ];
  }
  if (startCol === 2 && startRow === 0) {
    return [[{ type: "number", value: 5, display: "5" }]];
  }
  throw new Error(`unexpected read at r${startRow} c${startCol}`);
}

/** A recording fake of the parts of the unlocked API the starter touches. */
function makeApi(options: {
  selection: Selection | null;
  rows?: (startRow: number, startCol: number) => Cell[][];
}) {
  const log: string[] = [];
  const api = {
    getSelection: vi.fn(async () => {
      log.push("getSelection");
      return options.selection;
    }),
    getRangeValues: vi.fn(async (startRow: number, startCol: number) => {
      log.push("getRangeValues");
      return (options.rows ?? fixtureRows)(startRow, startCol);
    }),
    updateCellsBatch: vi.fn(async (_updates: { row: number; col: number; value: unknown }[]) => {
      log.push("updateCellsBatch");
    }),
    beginBatch: vi.fn(async () => {
      log.push("beginBatch");
    }),
    commitBatch: vi.fn(async () => {
      log.push("commitBatch");
    }),
    cancelBatch: vi.fn(async () => {
      log.push("cancelBatch");
    }),
  };
  return { api, log };
}

const SOURCE = buildMacroStarterSource("Macro1");

/** `setup(context)` of the compiled starter, as the mount would call it. */
const runSetup = new Function("context", SOURCE + "\nreturn setup(context);") as (
  context: unknown,
) => unknown;

/** Mount the starter: resolves/rejects with what `setup` returned or threw. */
function mount(context: unknown): Promise<unknown> {
  return Promise.resolve().then(() => runSetup(context));
}

describe("the direct branch (Developer > Macros > Run, the command line)", () => {
  it("adds 1 to every plain number across every area, in ONE write, and reports the count", async () => {
    const { api, log } = makeApi({ selection: TWO_AREAS });
    const notify = vi.fn();

    await expect(mount({ api, notify })).resolves.toBe(3);

    expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
    expect(api.updateCellsBatch).toHaveBeenCalledWith([
      { row: 0, col: 0, value: 11 },
      { row: 1, col: 0, value: 3.5 },
      { row: 0, col: 2, value: 6 },
    ]);
    // Numbers, never strings -- the write must survive any decimal separator.
    const written = api.updateCellsBatch.mock.calls[0][0];
    for (const u of written) expect(typeof u.value).toBe("number");

    // One read per area, each on the selection's sheet (the 5th argument).
    expect(api.getRangeValues).toHaveBeenCalledTimes(2);
    expect(api.getRangeValues).toHaveBeenNthCalledWith(1, 0, 0, 3, 0, 0);
    expect(api.getRangeValues).toHaveBeenNthCalledWith(2, 0, 2, 0, 2, 0);

    // The undo bracket: opened with the macro's name BEFORE the write, closed AFTER it.
    expect(api.beginBatch).toHaveBeenCalledTimes(1);
    expect(api.beginBatch).toHaveBeenCalledWith("Macro1");
    expect(api.commitBatch).toHaveBeenCalledTimes(1);
    expect(api.cancelBatch).not.toHaveBeenCalled();
    expect(log).toEqual([
      "getSelection",
      "beginBatch",
      "getRangeValues",
      "getRangeValues",
      "updateCellsBatch",
      "commitBatch",
    ]);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("Macro1: changed 3 cell(s).", "success");
  });

  it("refuses with the retry sentence when nothing is selected, before any batch is opened", async () => {
    const { api } = makeApi({ selection: null });
    const notify = vi.fn();

    await expect(mount({ api, notify })).rejects.toThrow(
      "Select the cells to change, then run Macro1 again.",
    );
    expect(api.beginBatch).not.toHaveBeenCalled();
    expect(api.getRangeValues).not.toHaveBeenCalled();
    expect(api.updateCellsBatch).not.toHaveBeenCalled();
    expect(api.commitBatch).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("writes nothing for a selection of text cells and says so", async () => {
    const { api } = makeApi({
      selection: { ...A1_TO_A4, sheetIndex: 0, activeRow: 0, activeCol: 0, areas: [A1_TO_A4] },
      rows: () => [
        [{ type: "text", value: "a", display: "a" }],
        [{ type: "text", value: "b", display: "b" }],
        [{ type: "empty", value: null, display: "" }],
        [{ type: "error", value: "#DIV/0!", display: "#DIV/0!" }],
      ],
    });
    const notify = vi.fn();

    await expect(mount({ api, notify })).resolves.toBe(0);
    expect(api.updateCellsBatch).not.toHaveBeenCalled();
    expect(api.commitBatch).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("Macro1: changed 0 cell(s).", "success");
  });

  it("closes the batch exactly once when a read fails, writes nothing, and lets the error through", async () => {
    const { api, log } = makeApi({
      selection: TWO_AREAS,
      rows: () => {
        throw new Error("range too large: 1048576 cells (max 100000)");
      },
    });
    const notify = vi.fn();

    await expect(mount({ api, notify })).rejects.toThrow("range too large");
    expect(api.updateCellsBatch).not.toHaveBeenCalled();
    expect(api.commitBatch).toHaveBeenCalledTimes(1);
    expect(api.cancelBatch).not.toHaveBeenCalled();
    expect(log).toEqual(["getSelection", "beginBatch", "getRangeValues", "commitBatch"]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("refuses a run without cell access with the shared sentence and touches nothing", async () => {
    const { api } = makeApi({ selection: TWO_AREAS });
    const notify = vi.fn();

    await expect(mount({ api: null, notify })).rejects.toThrow(macroNeedsCellAccessMessage("Macro1"));
    for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("the button branch (a button on the sheet runs it on every click)", () => {
  it("registers a click handler, returns nothing, and does the work only when clicked", async () => {
    const { api } = makeApi({ selection: TWO_AREAS });
    const notify = vi.fn();
    const handlers: Array<() => unknown> = [];
    const onClick = vi.fn((handler: () => unknown) => {
      handlers.push(handler);
    });

    await expect(mount({ api, notify, onClick })).resolves.toBeUndefined();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(api.getSelection).not.toHaveBeenCalled();
    expect(api.updateCellsBatch).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();

    await handlers[0]();
    expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
    expect(api.commitBatch).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("Macro1: changed 3 cell(s).", "success");

    // A second click is a second run, not a second registration.
    await handlers[0]();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(api.updateCellsBatch).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("reports a failing click as an error notification instead of an unhandled rejection", async () => {
    const { api } = makeApi({ selection: null });
    const notify = vi.fn();
    const handlers: Array<() => unknown> = [];

    await mount({ api, notify, onClick: (handler: () => unknown) => handlers.push(handler) });
    await expect(handlers[0]()).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("Select the cells to change, then run Macro1 again.", "error");
    expect(api.beginBatch).not.toHaveBeenCalled();
  });
});

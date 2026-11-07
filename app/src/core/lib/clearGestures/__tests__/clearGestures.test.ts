//! FILENAME: app/src/core/lib/clearGestures/__tests__/clearGestures.test.ts
// PURPOSE: Excel's Clear menu as gestures, against doubles of the backend:
//          what each one clears, ONE undo step when it takes several writes,
//          every Ctrl+click block, and every refusal SHOWN.
// CONTEXT: (Home tab = Excel's Home tab, 2026-10-04.)
//          - Clear Contents and Clear Formats sent a refusal (a protected sheet)
//            to the console, so the Delete key and the ribbon looked dead;
//            Clear All already alerted. Now all of them do.
//          - Clear Comments left NOTES in place; Excel's item is "Clear Comments
//            and Notes". Clear All left notes too.
//          - Remove Hyperlinks did not exist. Live Excel (build 20326,
//            2026-10-04): on every cell that HOLDS a link it removes the link
//            AND every format (bold, fill, number format, alignment, borders --
//            the cell goes back to the Normal style); a cell in the selection
//            WITHOUT a link keeps its formatting; values stay; one Undo
//            restores everything.
//          - The linked cells are read through Core's own IPC wrapper
//            (`getHyperlinksInRange` in tauri-api.ts), never a raw invoke: the
//            invoke double below REFUSES every call, so a gesture that went back
//            to a raw invoke would fail every Remove Hyperlinks test here.
//
// The dialog double takes the TAURI shape (alertAsync resolves a Promise).

import { describe, it, expect, vi, beforeEach } from "vitest";

const api = vi.hoisted(() => ({
  clearRange: vi.fn(),
  clearRangeWithOptions: vi.fn(),
  clearCommentsInRange: vi.fn(),
  clearNotesInRange: vi.fn(),
  clearHyperlinksInRange: vi.fn(),
  getHyperlinksInRange: vi.fn(),
  beginUndoTransaction: vi.fn(),
  commitUndoTransaction: vi.fn(),
  cancelUndoTransaction: vi.fn(),
}));
const invoke = vi.hoisted(() => vi.fn());
const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(), confirmAsync: vi.fn() }));
const emit = vi.hoisted(() => vi.fn());

vi.mock("../../tauri-api", () => api);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../dialogs", () => dialogs);
vi.mock("../../cellEvents", () => ({ cellEvents: { emit } }));

import type { Selection } from "../../../types";
import { runClearGesture, type ClearGestureHost } from "../clearGestures";

function sel(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  extra?: Selection["additionalRanges"],
): Selection {
  return { startRow, startCol, endRow, endCol, type: "cells", additionalRanges: extra };
}

/** The host's refresh: what the grid re-reads after the writes land. */
const refresh = vi.fn();

/** The grid that runs the gesture: its selection, and its refresh. */
function host(selection: Selection | null): ClearGestureHost {
  return { selection, refresh };
}

/** The writes the gesture made, in order, by name (the one READ is not a write). */
function writes(): string[] {
  const all: Array<{ name: string; order: number }> = [];
  for (const [name, fn] of Object.entries(api)) {
    if (name.endsWith("UndoTransaction") || name === "getHyperlinksInRange") continue;
    fn.mock.invocationCallOrder.forEach((order) => all.push({ name, order }));
  }
  return all.sort((a, b) => a.order - b.order).map((w) => w.name);
}

/** The links the backend reports for a range: `[row, col]` pairs. */
let links: Array<[number, number]> = [];

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  invoke.mockReset();
  dialogs.alertAsync.mockReset();
  emit.mockReset();
  refresh.mockReset();
  refresh.mockResolvedValue(undefined);
  api.clearRange.mockResolvedValue(0);
  api.clearRangeWithOptions.mockResolvedValue({});
  api.clearCommentsInRange.mockResolvedValue(0);
  api.clearNotesInRange.mockResolvedValue(0);
  api.clearHyperlinksInRange.mockResolvedValue(0);
  api.beginUndoTransaction.mockResolvedValue(9);
  api.commitUndoTransaction.mockResolvedValue(undefined);
  api.cancelUndoTransaction.mockResolvedValue(undefined);
  dialogs.alertAsync.mockReturnValue(Promise.resolve());
  links = [];
  api.getHyperlinksInRange.mockImplementation(async (startRow: number, startCol: number, endRow: number, endCol: number) =>
    links
      .filter(([r, c]) => r >= startRow && r <= endRow && c >= startCol && c <= endCol)
      .map(([row, col]) => ({ row, col, linkType: "url" })),
  );
  // No raw IPC from Core's gestures: every backend call goes through tauri-api.
  invoke.mockImplementation(async (cmd: string) => {
    throw new Error(`unexpected raw invoke ${cmd}`);
  });
});

// ---------------------------------------------------------------------------
// Refusals reach the user (they used to be logged only)
// ---------------------------------------------------------------------------

describe("every refusal is SHOWN", () => {
  it("Clear Contents: the backend's reason is alerted (Delete on a protected sheet)", async () => {
    api.clearRangeWithOptions.mockRejectedValue("The cell is on a protected sheet.");
    await runClearGesture("clearContents", host(sel(0, 0, 2, 2)));
    expect(dialogs.alertAsync).toHaveBeenCalledWith("The cell is on a protected sheet.");
    expect(emit).not.toHaveBeenCalled();
  });

  it("Clear Formats: the same", async () => {
    api.clearRangeWithOptions.mockRejectedValue(new Error("The cell is on a protected sheet."));
    await runClearGesture("clearFormatting", host(sel(0, 0, 2, 2)));
    expect(dialogs.alertAsync).toHaveBeenCalledWith("The cell is on a protected sheet.");
  });

  it("Clear All: still alerted, and its empty step cancelled", async () => {
    api.clearRangeWithOptions.mockRejectedValue("Protected.");
    await runClearGesture("clearAll", host(sel(0, 0, 2, 2)));
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Protected.");
    expect(api.cancelUndoTransaction).toHaveBeenCalledWith(9);
    expect(api.commitUndoTransaction).not.toHaveBeenCalled();
  });

  it("control: a successful clear says nothing", async () => {
    await runClearGesture("clearContents", host(sel(0, 0, 2, 2)));
    await runClearGesture("clearFormatting", host(sel(0, 0, 2, 2)));
    expect(dialogs.alertAsync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// What each one clears
// ---------------------------------------------------------------------------

describe("Clear Contents / Clear Formats / Clear Hyperlinks: one write per block", () => {
  // Delete is Clear CONTENTS (Excel keeps the formats): the contents clear,
  // never `clearRange`, which removed the cells' formats with their values.
  it("Clear Contents clears the range's CONTENTS, as one backend step, and announces a 'clear'", async () => {
    await runClearGesture("clearContents", host(sel(3, 1, 0, 2)));
    expect(api.clearRangeWithOptions.mock.calls).toEqual([[0, 1, 3, 2, "contents"]]);
    expect(api.clearRange, "clearRange removes formats too").not.toHaveBeenCalled();
    expect(api.beginUndoTransaction, "one write is its own undo step").not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1]).toBe("clear");
  });

  it("Clear Formats clears formats only", async () => {
    await runClearGesture("clearFormatting", host(sel(1, 1, 2, 2)));
    expect(api.clearRangeWithOptions.mock.calls).toEqual([[1, 1, 2, 2, "formats"]]);
  });

  it("Clear Hyperlinks clears the links and keeps the formatting (Excel's Clear Hyperlinks)", async () => {
    await runClearGesture("clearHyperlinks", host(sel(1, 1, 2, 2)));
    expect(writes()).toEqual(["clearHyperlinksInRange"]);
  });

  it("every Ctrl+click block is cleared (the Delete key used to clear only the last one), in ONE call (BUG-0394)", async () => {
    await runClearGesture("clearContents", host(sel(5, 5, 5, 5, [{ startRow: 0, startCol: 0, endRow: 1, endCol: 1 }])));
    // The main block (the active cell's) first -- @api selectionBlocks' one
    // order -- and the others as `moreAreas`: the backend gates every block
    // before it writes any and makes it ONE undo step itself.
    expect(api.clearRangeWithOptions.mock.calls).toEqual([
      [5, 5, 5, 5, "contents", undefined, { moreAreas: [{ startRow: 0, startCol: 0, endRow: 1, endCol: 1 }] }],
    ]);
    expect(api.beginUndoTransaction, "one call is its own undo step").not.toHaveBeenCalled();
  });
});

describe("Clear Comments and Notes", () => {
  it("clears threaded comments AND notes, as ONE undo step", async () => {
    await runClearGesture("clearComments", host(sel(0, 0, 4, 4)));
    expect(writes()).toEqual(["clearCommentsInRange", "clearNotesInRange"]);
    expect(api.clearNotesInRange.mock.calls).toEqual([[0, 0, 4, 4]]);
    expect(api.beginUndoTransaction).toHaveBeenCalledTimes(1);
    expect(api.commitUndoTransaction).toHaveBeenCalledWith(9);
  });

  it("refused after the comments went: what landed is committed, not dropped, and shown", async () => {
    api.clearNotesInRange.mockRejectedValue("Notes are locked.");
    await runClearGesture("clearComments", host(sel(0, 0, 4, 4)));
    expect(api.commitUndoTransaction).toHaveBeenCalledWith(9);
    expect(api.cancelUndoTransaction).not.toHaveBeenCalled();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Notes are locked.");
  });
});

describe("Clear All", () => {
  it("clears contents+formats, comments, NOTES and hyperlinks in one undo step", async () => {
    await runClearGesture("clearAll", host(sel(0, 0, 1, 1)));
    expect(writes()).toEqual([
      "clearRangeWithOptions",
      "clearCommentsInRange",
      "clearNotesInRange",
      "clearHyperlinksInRange",
    ]);
    expect(api.clearRangeWithOptions.mock.calls[0][4]).toBe("all");
    expect(api.beginUndoTransaction).toHaveBeenCalledTimes(1);
    expect(api.commitUndoTransaction).toHaveBeenCalledWith(9);
  });

  it("inside a script's open batch it joins and closes nothing", async () => {
    api.beginUndoTransaction.mockResolvedValue(null);
    await runClearGesture("clearAll", host(sel(0, 0, 1, 1)));
    expect(api.commitUndoTransaction).not.toHaveBeenCalled();
    expect(api.cancelUndoTransaction).not.toHaveBeenCalled();
  });
});

describe("Remove Hyperlinks (Excel: the links AND the linked cells' formatting)", () => {
  it("is ONE backend removeHyperlinks call over the block (the command clears each LINKED cell's link and format)", async () => {
    links = [
      [0, 0],
      [2, 3],
    ];
    await runClearGesture("removeHyperlinks", host(sel(0, 0, 3, 3)));
    // The command's own removeHyperlinks: the backend clears the links and the
    // formats of the LINKED cells only (B1 in the probe keeps its format;
    // clear_hyperlinks_tests.rs pins that half) in ONE undo step of its own.
    expect(api.clearRangeWithOptions.mock.calls).toEqual([[0, 0, 3, 3, "removeHyperlinks"]]);
    expect(api.clearHyperlinksInRange, "the link clear is the command's own half").not.toHaveBeenCalled();
    expect(api.clearRange, "values stay").not.toHaveBeenCalled();
    expect(api.beginUndoTransaction, "one call is its own undo step").not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("a selection with no link changes nothing and opens no step (Excel greys the item)", async () => {
    await runClearGesture("removeHyperlinks", host(sel(0, 0, 3, 3)));
    expect(writes()).toEqual([]);
    expect(api.beginUndoTransaction).not.toHaveBeenCalled();
    expect(dialogs.alertAsync).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("asks about every Ctrl+click block, and touches only the blocks that hold links", async () => {
    links = [[10, 10]];
    await runClearGesture("removeHyperlinks", host(sel(10, 10, 10, 11, [{ startRow: 0, startCol: 0, endRow: 1, endCol: 1 }])));
    expect(api.getHyperlinksInRange.mock.calls).toEqual([
      [10, 10, 10, 11],
      [0, 0, 1, 1],
    ]);
    expect(invoke, "no raw invoke").not.toHaveBeenCalled();
    expect(api.clearRangeWithOptions.mock.calls).toEqual([[10, 10, 10, 11, "removeHyperlinks"]]);
    expect(api.clearHyperlinksInRange).not.toHaveBeenCalled();
  });

  it("a refused clear is shown and nothing else runs", async () => {
    links = [[0, 0]];
    api.clearRangeWithOptions.mockRejectedValue("The cell is on a protected sheet.");
    await runClearGesture("removeHyperlinks", host(sel(0, 0, 0, 0)));
    expect(dialogs.alertAsync).toHaveBeenCalledWith("The cell is on a protected sheet.");
    expect(api.clearHyperlinksInRange).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});

it("no selection: nothing runs", async () => {
  await runClearGesture("clearAll", host(null));
  expect(writes()).toEqual([]);
  expect(api.beginUndoTransaction).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// The grid re-reads after a clear (review finding (b), 2026-10-04)
// ---------------------------------------------------------------------------
// The gesture announced ONE cell event and nothing else, so the Home ribbon --
// which re-reads the active cell's style on "grid:refresh" / "styles:refresh"
// -- kept Bold, Center and the number format lit after Clear Formats until the
// selection moved. The merge gesture beside it already refreshed its host.

describe("the host refreshes once the writes land", () => {
  for (const kind of ["clearContents", "clearFormatting", "clearComments", "clearHyperlinks", "clearAll"] as const) {
    it(`${kind}: refresh runs once, after every write`, async () => {
      await runClearGesture(kind, host(sel(0, 0, 1, 1)));
      expect(refresh).toHaveBeenCalledTimes(1);
      const lastWrite = Math.max(
        ...Object.entries(api)
          .filter(([name]) => !name.endsWith("UndoTransaction") && name !== "getHyperlinksInRange")
          .flatMap(([, fn]) => fn.mock.invocationCallOrder),
      );
      expect(refresh.mock.invocationCallOrder[0]).toBeGreaterThan(lastWrite);
    });
  }

  it("says whether FORMATS changed, so the style cache re-reads only then", async () => {
    await runClearGesture("clearFormatting", host(sel(0, 0, 1, 1)));
    await runClearGesture("clearAll", host(sel(0, 0, 1, 1)));
    links = [[0, 0]];
    await runClearGesture("removeHyperlinks", host(sel(0, 0, 1, 1)));
    await runClearGesture("clearContents", host(sel(0, 0, 1, 1)));
    await runClearGesture("clearComments", host(sel(0, 0, 1, 1)));
    expect(refresh.mock.calls).toEqual([
      [{ formats: true }],
      [{ formats: true }],
      [{ formats: true }],
      [{ formats: false }],
      [{ formats: false }],
    ]);
  });

  it("nothing landed (refused): no refresh", async () => {
    api.clearRangeWithOptions.mockRejectedValue("Protected.");
    await runClearGesture("clearFormatting", host(sel(0, 0, 1, 1)));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("part landed then refused: the grid still re-reads what changed", async () => {
    api.clearNotesInRange.mockRejectedValue("Notes are locked.");
    await runClearGesture("clearComments", host(sel(0, 0, 4, 4)));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a refresh that fails is logged, never thrown at the command", async () => {
    refresh.mockRejectedValue(new Error("canvas gone"));
    await expect(runClearGesture("clearContents", host(sel(0, 0, 1, 1)))).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Several areas: the refusable write of EVERY area goes first (finding (c))
// ---------------------------------------------------------------------------
// Writes went area by area -- [all(A), comments(A), notes(A), links(A), all(B)
// ...] -- so with B on a locked range of a protected sheet, A was wiped
// completely (contents, formats, comments, notes, links) before B's refusal.

describe("Clear All over several areas, a LATER area refused", () => {
  const twoAreas = () => sel(0, 0, 0, 0, [{ startRow: 5, startCol: 5, endRow: 5, endCol: 5 }]);
  const second = [{ startRow: 5, startCol: 5, endRow: 5, endCol: 5 }];

  it("ONE contents+formats call for every area runs before any comment, note or link is removed", async () => {
    await runClearGesture("clearAll", host(twoAreas()));
    expect(writes()).toEqual([
      "clearRangeWithOptions",
      "clearCommentsInRange",
      "clearNotesInRange",
      "clearHyperlinksInRange",
    ]);
    expect(api.clearRangeWithOptions.mock.calls).toEqual([[0, 0, 0, 0, "all", undefined, { moreAreas: second }]]);
    expect(api.clearCommentsInRange.mock.calls).toEqual([[0, 0, 0, 0, second]]);
    expect(api.clearNotesInRange.mock.calls).toEqual([[0, 0, 0, 0, second]]);
    expect(api.clearHyperlinksInRange.mock.calls).toEqual([[0, 0, 0, 0, second]]);
  });

  // BUG-0395: the backend refuses the WHOLE multi-area clear when one area
  // refuses (Excel [LIVE] 2026-11-04) -- so nothing landed, and the empty step
  // is cancelled. (It used to clear area by area: the first area's contents
  // and formats were gone before the second refused.)
  it("BUG-0395 the second area refused: NOTHING is cleared anywhere, the step is cancelled, and it is shown", async () => {
    api.clearRangeWithOptions.mockRejectedValue("The cell is on a protected sheet.");
    await runClearGesture("clearAll", host(twoAreas()));
    expect(api.clearRangeWithOptions).toHaveBeenCalledTimes(1);
    expect(api.clearCommentsInRange, "comments went before the refusal").not.toHaveBeenCalled();
    expect(api.clearNotesInRange, "notes went before the refusal").not.toHaveBeenCalled();
    expect(api.clearHyperlinksInRange, "links went before the refusal").not.toHaveBeenCalled();
    expect(api.cancelUndoTransaction, "nothing landed: the empty step goes").toHaveBeenCalledWith(9);
    expect(api.commitUndoTransaction).not.toHaveBeenCalled();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("The cell is on a protected sheet.");
  });

  it("Clear Comments and Notes: every area's comments in one call, then every area's notes", async () => {
    await runClearGesture("clearComments", host(twoAreas()));
    expect(writes()).toEqual(["clearCommentsInRange", "clearNotesInRange"]);
  });

  it("BUG-0736 Remove Hyperlinks: every area in ONE call with moreAreas (one undo step, all or nothing)", async () => {
    links = [
      [0, 0],
      [5, 5],
    ];
    await runClearGesture("removeHyperlinks", host(twoAreas()));
    expect(writes()).toEqual(["clearRangeWithOptions"]);
    const sent = api.clearRangeWithOptions.mock.calls[0];
    expect(sent[4]).toBe("removeHyperlinks");
    const firstArea = sent.slice(0, 4);
    const more = (sent[6] as { moreAreas: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }> }).moreAreas;
    expect(more).toHaveLength(1);
    expect([firstArea, [more[0].startRow, more[0].startCol, more[0].endRow, more[0].endCol]]).toEqual(
      [[0, 0, 0, 0], [5, 5, 5, 5]],
    );
    expect(api.beginUndoTransaction, "the one call records its own step").not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// How many backend calls a scattered selection costs (finding (d))
// ---------------------------------------------------------------------------
// BUG-0394: every area goes in ONE call per kind of write (the backend's
// `moreAreas`, one undo step and one dependents cascade). It was one call per
// area per kind of write -- 50 clears for 50 areas, 200 for Clear All. Pinned
// so a change in the count is a decision, not an accident.

describe("backend calls per area (pinned)", () => {
  const scattered = (n: number) =>
    sel(
      0,
      0,
      0,
      0,
      Array.from({ length: n - 1 }, (_, i) => ({ startRow: 2 * (i + 1), startCol: 0, endRow: 2 * (i + 1), endCol: 0 })),
    );

  it("BUG-0394 Delete over 50 Go To Special areas: ONE clear, ONE announcement, ONE refresh", async () => {
    await runClearGesture("clearContents", host(scattered(50)));
    expect(api.clearRangeWithOptions).toHaveBeenCalledTimes(1);
    const sent = api.clearRangeWithOptions.mock.calls[0];
    expect(sent[4]).toBe("contents");
    expect((sent[6] as { moreAreas: unknown[] }).moreAreas).toHaveLength(49);
    expect(api.clearRange).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("BUG-0394 Clear All over 50 areas: 4 writes in all", async () => {
    await runClearGesture("clearAll", host(scattered(50)));
    expect(writes()).toHaveLength(4);
  });
});

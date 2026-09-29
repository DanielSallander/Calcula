//! FILENAME: app/src/api/scriptHost/__tests__/scriptBatchOwnership.test.ts
// PURPOSE: X6 (wave D; wc-undo F4 + its new defect 4) and its review fix-up
//          (F1/F3). The backend has ONE undo-transaction slot: a begin while it
//          is open JOINS (and marks the step shared), and a bare commit /
//          cancel closes WHATEVER is open. So a caller may only close a
//          transaction its own begin OPENED -- which `begin_undo_transaction`
//          answers with a TICKET (null = joined) -- and it closes by presenting
//          that ticket, so the close lands only on that very transaction.
//          The script host broke the rule in five places (X6):
//            - api.beginBatch threw the answer away, and api.commitBatch /
//              api.cancelBatch closed whatever was open: a script whose batch
//              JOINED a user gesture's (or its own outer batch's) transaction
//              committed -- or dropped -- that transaction halfway;
//            - api.copySheet and api.addSheet with a POSITION opened and
//              committed a bracket of their own unconditionally;
//            - api.createNamedStyle probed "is one open?" and then JOINED
//              silently, and cancelled a stranger's transaction.
//          And the X6 fix itself went stale (review F1/F3): a sheet add /
//          delete / rename / move / copy ENDS the history, open transaction
//          included (Excel parity), as does a document swap -- after which the
//          script's "my begin opened it" record pointed at whatever a stranger
//          opened next: its commitBatch committed a user's chart drag halfway,
//          its cleanup cancelled a user's paste, a late sweep landed in the
//          NEXT document. The ticket closes that, and a batch whose own sheet
//          change ended its transaction RESUMES: the writes after the change
//          are still one step.
// CONTEXT: A faithful fake of the backend slot and its tickets
//          (core/engine/src/undo.rs begin_transaction_from_caller /
//          commit_transaction / cancel_transaction; app/src-tauri/src/
//          undo_commands.rs open_or_join_undo_transaction /
//          close_undo_transaction: a ticket closes only while it is the one the
//          stack issued last, no clear has happened since, and a transaction
//          is open; a bare close closes whatever is open and retires the
//          ticket). A write records into the open transaction, or as a step of
//          its own; a sheet add / copy / move ENDS the history, open
//          transaction included, as UndoStack::clear does. Executors take
//          `lib` as a parameter (the hiddenLines/canvasSheetScriptRows harness
//          style).

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

const mocks = vi.hoisted(() => ({
  grid: {
    refreshGridData: vi.fn(),
    refreshGridDimensions: vi.fn(),
    setActiveSheet: vi.fn((index: number, name: string, surface?: string) => ({
      type: "SET_ACTIVE_SHEET",
      index,
      name,
      surface,
    })),
  },
  dispatch: { dispatchGridAction: vi.fn() },
}));
vi.mock("../../grid", () => mocks.grid);
vi.mock("../../gridDispatch", () => mocks.dispatch);

import {
  executeAddSheet,
  executeBeginBatch,
  executeCancelBatch,
  executeCloseBatchLeftOpen,
  executeCommitBatch,
  executeCopySheet,
  executeCreateNamedStyle,
  hostCloseBatchLeftOpen,
  noteScriptDeparture,
  resetScriptBatchTracking,
  resumeScriptBatchAfterHistoryEnded,
  sweepScriptBatchesLeftOpen,
} from "../host";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asLib = (l: unknown) => l as any;

interface Step {
  label: string;
  writes: string[];
}

/** The backend's one transaction slot, its tickets and its history, faithfully. */
function makeBackend() {
  const steps: Step[] = [];
  let open: { label: string; writes: string[]; absorbed: boolean } | null = null;
  /** `UndoStack::clears_total`: moves on every clear. */
  let clears = 0;
  /** The ticket this stack issued last, with `clears` at the time. */
  let issued: { ticket: number; clears: number } | null = null;
  let nextTicket = 101;
  const sheets: Array<{ index: number; name: string; visibility: "visible" }> = [
    { index: 0, name: "Sheet1", visibility: "visible" },
    { index: 1, name: "Sheet2", visibility: "visible" },
  ];
  let active = 0;
  const reindex = () => sheets.forEach((s, i) => (s.index = i));
  /** A sheet structure command -- or a document swap -- ends the history
   *  (UndoStack::clear): every step AND the open transaction are dropped. */
  const endHistory = () => {
    steps.length = 0;
    open = null;
    clears += 1;
  };
  /** A write: into the open transaction, or a step of its own. */
  const write = (what: string) => {
    if (open) open.writes.push(what);
    else steps.push({ label: what, writes: [what] });
  };
  /** open_or_join_undo_transaction + begin_transaction_from_caller. */
  const begin = (label: string): number | null => {
    if (open) {
      open.absorbed = true;
      return null;
    }
    open = { label, writes: [], absorbed: false };
    const ticket = nextTicket++;
    issued = { ticket, clears };
    return ticket;
  };
  /** close_undo_transaction. */
  const close = (ticket: number | null | undefined, commit: boolean) => {
    const bare = ticket === undefined || ticket === null;
    const closes = bare || (open !== null && issued?.ticket === ticket && issued.clears === clears);
    if (issued && (closes || ticket === issued.ticket)) issued = null;
    if (!closes) return;
    if (commit && open && open.writes.length > 0) steps.push({ label: open.label, writes: open.writes });
    open = null;
  };
  const lib = {
    beginUndoTransaction: vi.fn(async (label: string): Promise<number | null> => begin(label)),
    commitUndoTransaction: vi.fn(async (ticket?: number | null) => close(ticket, true)),
    cancelUndoTransaction: vi.fn(async (ticket?: number | null) => close(ticket, false)),
    getUndoState: vi.fn(async () => ({ transactionOpen: open !== null })),
    getActiveSheet: vi.fn(async () => active),
    getSheets: vi.fn(async () => ({ sheets: sheets.map((s) => ({ ...s })), activeIndex: active })),
    copySheet: vi.fn(async (source: number, name?: string) => {
      endHistory();
      const copy = { index: 0, name: name ?? `${sheets[source].name} (2)`, visibility: "visible" as const };
      sheets.splice(source + 1, 0, copy);
      reindex();
      active = copy.index;
      return { sheets: sheets.map((s) => ({ ...s })), activeIndex: active };
    }),
    addSheet: vi.fn(async (name?: string) => {
      endHistory();
      sheets.push({ index: sheets.length, name: name ?? `Sheet${sheets.length + 1}`, visibility: "visible" });
      active = sheets.length - 1;
      return { sheets: sheets.map((s) => ({ ...s })), activeIndex: active };
    }),
    moveSheet: vi.fn(async (from: number, to: number) => {
      endHistory();
      const [moved] = sheets.splice(from, 1);
      sheets.splice(to, 0, moved);
      reindex();
      active = to;
      return { sheets: sheets.map((s) => ({ ...s })), activeIndex: active };
    }),
    // createNamedStyle's transient dance
    getNamedStyles: vi.fn(async () => []),
    getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 9, endCol: 4, empty: false })),
    getViewportCells: vi.fn(async () => []),
    applyFormatting: vi.fn(async (rows: number[], cols: number[]) => {
      write("scratch:apply");
      return { cells: [{ row: rows[0], col: cols[0], styleIndex: 42, display: "" }], styles: [] };
    }),
    createNamedStyle: vi.fn(async (name: string, styleIndex: number, category: string) => ({
      name,
      builtIn: false,
      styleIndex,
      category,
    })),
    clearRangeWithOptions: vi.fn(async () => {
      write("scratch:clear");
      return { count: 1 };
    }),
  };
  return {
    lib,
    steps,
    write,
    isOpen: () => open !== null,
    openLabel: () => open?.label ?? null,
    openAbsorbed: () => open?.absorbed ?? false,
    /** Another caller (a user gesture) opens the slot through the door. */
    strangerBegins: (label: string): number => {
      if (open) throw new Error("fixture: the slot is already open");
      return begin(label)!;
    },
    /** ...and commits it with its ticket. */
    strangerCommits: (ticket: number) => close(ticket, true),
    /** The user adds a sheet, or opens another workbook: the history ends. */
    endHistory,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Module state: no test inherits a batch another left open.
  resetScriptBatchTracking();
});

describe("api.beginBatch / commitBatch / cancelBatch close only what the script opened (X6)", () => {
  it("positive control: a batch that OPENED is committed as one step", async () => {
    const b = makeBackend();
    await executeBeginBatch(asLib(b.lib), "script-1", "Import rows");
    b.write("A1");
    b.write("A2");
    await executeCommitBatch(asLib(b.lib), "script-1");
    expect(b.steps).toEqual([{ label: "Import rows", writes: ["A1", "A2"] }]);
    expect(b.isOpen()).toBe(false);
    expect(b.lib.commitUndoTransaction, "the commit did not present the batch's ticket").toHaveBeenCalledWith(101);
  });

  it("a batch that JOINED a user's transaction does not commit it halfway", async () => {
    const b = makeBackend();
    const paste = b.strangerBegins("Paste");
    b.write("paste:A1");
    await executeBeginBatch(asLib(b.lib), "script-1", "Script");
    expect(b.openAbsorbed(), "the join must still MARK the step (the begin door)").toBe(true);
    b.write("script:B1");
    await executeCommitBatch(asLib(b.lib), "script-1");
    expect(b.isOpen(), "commitBatch closed the user's transaction it had only joined").toBe(true);
    b.write("paste:A2");
    b.strangerCommits(paste);
    expect(b.steps).toEqual([{ label: "Paste", writes: ["paste:A1", "script:B1", "paste:A2"] }]);
  });

  it("a batch that JOINED is not cancelled either: the opener's writes keep their undo step", async () => {
    const b = makeBackend();
    const paste = b.strangerBegins("Paste");
    b.write("paste:A1");
    await executeBeginBatch(asLib(b.lib), "script-1", "Script");
    await executeCancelBatch(asLib(b.lib), "script-1");
    expect(b.isOpen(), "cancelBatch dropped the user's transaction (its writes lost their undo step)").toBe(true);
    b.strangerCommits(paste);
    expect(b.steps).toEqual([{ label: "Paste", writes: ["paste:A1"] }]);
  });

  it("nested batches of one script: the inner commit leaves the outer open", async () => {
    const b = makeBackend();
    await executeBeginBatch(asLib(b.lib), "script-1", "Outer");
    b.write("A1");
    await executeBeginBatch(asLib(b.lib), "script-1", "Inner");
    b.write("A2");
    await executeCommitBatch(asLib(b.lib), "script-1");
    expect(b.isOpen(), "the inner commit closed the outer batch").toBe(true);
    b.write("A3");
    await executeCommitBatch(asLib(b.lib), "script-1");
    expect(b.steps).toEqual([{ label: "Outer", writes: ["A1", "A2", "A3"] }]);
  });

  it("a commitBatch with no begin of its own never closes another caller's transaction", async () => {
    const b = makeBackend();
    b.strangerBegins("Paste");
    await executeCommitBatch(asLib(b.lib), "script-1");
    await executeCancelBatch(asLib(b.lib), "script-1");
    expect(b.isOpen()).toBe(true);
    expect(b.lib.commitUndoTransaction).not.toHaveBeenCalled();
    expect(b.lib.cancelUndoTransaction).not.toHaveBeenCalled();
  });

  it("each script closes only its own: another script's commit leaves this one's batch open", async () => {
    const b = makeBackend();
    await executeBeginBatch(asLib(b.lib), "script-1", "Mine");
    await executeBeginBatch(asLib(b.lib), "script-2", "Theirs"); // joins
    b.write("A1");
    await executeCommitBatch(asLib(b.lib), "script-2");
    expect(b.openLabel()).toBe("Mine");
    await executeCommitBatch(asLib(b.lib), "script-1");
    expect(b.steps).toEqual([{ label: "Mine", writes: ["A1"] }]);
  });
});

describe("a sheet change or a document swap ends the batch's transaction: its close must not land on a stranger's (review F1/F3)", () => {
  it("commitBatch after the script's addSheet does not commit the user's next gesture halfway", async () => {
    const b = makeBackend();
    await executeBeginBatch(asLib(b.lib), "script-1", "Build report");
    b.write("A1");
    await executeAddSheet(asLib(b.lib), "Report", { before: 0 }, undefined); // ends the history
    b.strangerBegins("Move chart"); // a chart drag / an Arrange / another script's batch
    b.write("chart:x");
    await executeCommitBatch(asLib(b.lib), "script-1");
    expect(
      b.openLabel(),
      "the script's commitBatch committed the user's 'Move chart' transaction it never opened",
    ).toBe("Move chart");
  });

  it("the run's cleanup after addSheet does not cancel the user's paste", async () => {
    const b = makeBackend();
    await executeBeginBatch(asLib(b.lib), "run-9", "Macro");
    await executeAddSheet(asLib(b.lib), "Report", { before: 0 }, undefined);
    const paste = b.strangerBegins("Paste");
    b.write("paste:A1");
    await executeCloseBatchLeftOpen(asLib(b.lib), "run-9");
    expect(b.openLabel(), "the run's cleanup cancelled the user's 'Paste' transaction").toBe("Paste");
    b.strangerCommits(paste);
    expect(b.steps).toEqual([{ label: "Paste", writes: ["paste:A1"] }]);
  });

  it("a sheet change by the USER during the batch: the script's commit leaves the next gesture alone", async () => {
    const b = makeBackend();
    await executeBeginBatch(asLib(b.lib), "script-1", "Slow import");
    b.endHistory(); // the user renames a sheet while the script awaits a fetch
    b.strangerBegins("Fill series");
    await executeCancelBatch(asLib(b.lib), "script-1");
    expect(b.openLabel(), "the script's cancelBatch dropped the user's 'Fill series' step").toBe("Fill series");
  });

  it("a sheet change by the USER ENDS the batch: later writes are steps of their own, and commitBatch closes nothing", async () => {
    // What the beginBatch typings promise (wave E fix-up): only the script's
    // OWN sheet change is followed by a resume; the user's is not.
    const b = makeBackend();
    await executeBeginBatch(asLib(b.lib), "script-1", "Build");
    b.write("A1");
    b.endHistory(); // the user adds a sheet while the script sleeps
    b.write("A2");
    b.write("A3");
    const fill = b.strangerBegins("Fill series");
    b.write("B1");
    await executeCommitBatch(asLib(b.lib), "script-1");
    expect(b.openLabel(), "the script's commitBatch closed the user's 'Fill series' step").toBe("Fill series");
    b.strangerCommits(fill);
    expect(b.steps, "the writes after the user's sheet change were grouped by the ended batch").toEqual([
      { label: "A2", writes: ["A2"] },
      { label: "A3", writes: ["A3"] },
      { label: "Fill series", writes: ["B1"] },
    ]);
  });

  it("a sweep that lands after a document swap does not cancel the NEXT document's transaction", async () => {
    // The object-script manager unmounts its scripts BEFORE the host's reset
    // forgets their batches (scriptableObjects.ts resetObjectScriptManager),
    // so the unmount sweep runs for real on AFTER_OPEN / AFTER_NEW.
    const b = makeBackend();
    await executeBeginBatch(asLib(b.lib), "script-7", "Button macro");
    b.endHistory(); // File > Open: reset_document_scoped_stores clears the stack
    b.strangerBegins("Paste"); // the first gesture in the new workbook
    sweepScriptBatchesLeftOpen("script-7", async () => asLib(b.lib));
    await hostCloseBatchLeftOpen("script-7"); // awaits the sweep in flight
    expect(b.openLabel(), "the old document's sweep cancelled the new document's 'Paste'").toBe("Paste");
    expect(b.lib.cancelUndoTransaction, "the sweep never ran").toHaveBeenCalledWith(101);
  });

  it("positive control: the sweep still cancels the script's OWN batch when nothing ended it", async () => {
    const b = makeBackend();
    await executeBeginBatch(asLib(b.lib), "script-8", "Button macro");
    b.write("A1");
    sweepScriptBatchesLeftOpen("script-8", async () => asLib(b.lib));
    await expect(hostCloseBatchLeftOpen("script-8")).resolves.toBe(true);
    expect(b.isOpen(), "the script's own batch was left open for nobody to close").toBe(false);
  });

  it("hostUnmountScript sweeps through sweepScriptBatchesLeftOpen", () => {
    const host = fs.readFileSync(path.resolve(__dirname, "../host.ts"), "utf8");
    const unmount = host.slice(
      host.indexOf("export function hostUnmountScript("),
      host.indexOf("export function hostIsMounted("),
    );
    expect(unmount, "an unmount leaves the script's open batch open").toMatch(/sweepScriptBatchesLeftOpen\(scriptId\);/);
  });
});

describe("a batch outlives the script's OWN sheet change: the writes after it are still one step", () => {
  it("resumes under the same label, so the writes after an addSheet are ONE step", async () => {
    const b = makeBackend();
    await executeBeginBatch(asLib(b.lib), "script-1", "Build report");
    b.write("A1");
    await executeAddSheet(asLib(b.lib), "Report", undefined, undefined);
    await resumeScriptBatchAfterHistoryEnded(asLib(b.lib), "script-1");
    b.write("Report!A1");
    b.write("Report!A2");
    await executeCommitBatch(asLib(b.lib), "script-1");
    expect(b.steps, "the writes after the sheet add are not one step").toEqual([
      { label: "Build report", writes: ["Report!A1", "Report!A2"] },
    ]);
    expect(b.isOpen()).toBe(false);
  });

  it("does not take over a transaction somebody opened in between (it joins, and closes nothing)", async () => {
    const b = makeBackend();
    await executeBeginBatch(asLib(b.lib), "script-1", "Build report");
    await executeCopySheet(asLib(b.lib), 0, undefined, undefined);
    const drag = b.strangerBegins("Move chart");
    await resumeScriptBatchAfterHistoryEnded(asLib(b.lib), "script-1");
    b.write("A1");
    await executeCommitBatch(asLib(b.lib), "script-1");
    expect(b.openLabel(), "the resumed batch committed the user's 'Move chart' step").toBe("Move chart");
    b.strangerCommits(drag);
    expect(b.steps).toEqual([{ label: "Move chart", writes: ["A1"] }]);
  });

  it("keeps the script's own ticket when the change ended nothing", async () => {
    const b = makeBackend();
    await executeBeginBatch(asLib(b.lib), "script-1", "B");
    b.write("A1");
    await resumeScriptBatchAfterHistoryEnded(asLib(b.lib), "script-1"); // nothing was cleared
    b.write("A2");
    await executeCommitBatch(asLib(b.lib), "script-1");
    expect(b.steps, "a resume over a live transaction lost the script's own ticket").toEqual([
      { label: "B", writes: ["A1", "A2"] },
    ]);
  });

  it("a batch the script only JOINED is not resumed", async () => {
    const b = makeBackend();
    b.strangerBegins("Paste");
    await executeBeginBatch(asLib(b.lib), "script-1", "Script");
    b.endHistory();
    await resumeScriptBatchAfterHistoryEnded(asLib(b.lib), "script-1");
    expect(b.isOpen(), "the script opened a step for a batch that was never its own").toBe(false);
    expect(b.lib.beginUndoTransaction).toHaveBeenCalledTimes(1);
  });

  it("a resume whose begin fails does not turn the SUCCEEDED sheet change into an error", async () => {
    const b = makeBackend();
    await executeBeginBatch(asLib(b.lib), "script-1", "B");
    b.endHistory();
    b.lib.beginUndoTransaction.mockRejectedValueOnce(new Error("backend gone"));
    await expect(
      resumeScriptBatchAfterHistoryEnded(asLib(b.lib), "script-1"),
      "the script would be told its addSheet failed, though the sheet was added",
    ).resolves.toBeUndefined();
  });

  it("a resume that lands after its script departed closes what it opened", async () => {
    const b = makeBackend();
    await executeBeginBatch(asLib(b.lib), "run-3", "Macro");
    b.endHistory();
    const begin = b.lib.beginUndoTransaction.getMockImplementation()!;
    b.lib.beginUndoTransaction.mockImplementationOnce(async (label: string) => {
      const answer = await begin(label);
      noteScriptDeparture("run-3");
      return answer;
    });
    await resumeScriptBatchAfterHistoryEnded(asLib(b.lib), "run-3");
    expect(b.isOpen(), "a departed script's resumed batch was left open for nobody to close").toBe(false);
  });

  it("every script door that ends the history resumes the batch after it", () => {
    const host = fs.readFileSync(path.resolve(__dirname, "../host.ts"), "utf8");
    for (const door of ["addSheet", "deleteSheet", "renameSheet", "moveSheet", "copySheet"]) {
      const at = host.indexOf(`    case "api.${door}": {`);
      expect(at, `the api.${door} door is gone`).toBeGreaterThan(-1);
      const body = host.slice(at, host.indexOf("\n    }\n", at));
      expect(body, `api.${door} ends the history but does not resume the script's batch`).toMatch(
        /await resumeScriptBatchAfterHistoryEnded\(lib, definition\.id\);/,
      );
    }
  });
});

describe("positioned sheet adds and createNamedStyle go through withScriptUndoBatch (X6)", () => {
  it("a positioned copySheet inside a batch never closes the batch it only joined", async () => {
    const b = makeBackend();
    await executeBeginBatch(asLib(b.lib), "script-1", "B");
    b.write("A1");
    await executeCopySheet(asLib(b.lib), 0, undefined, { before: 0 });
    expect(b.lib.beginUndoTransaction, "the copy's bracket still begins (it JOINS)").toHaveBeenCalledTimes(2);
    expect(b.lib.commitUndoTransaction, "copySheet committed a transaction it had only joined").not.toHaveBeenCalled();
    expect(b.lib.cancelUndoTransaction, "copySheet cancelled a transaction it had only joined").not.toHaveBeenCalled();
  });

  it("a positioned addSheet inside a batch never closes the batch it only joined", async () => {
    const b = makeBackend();
    await executeBeginBatch(asLib(b.lib), "script-1", "B");
    b.write("A1");
    await executeAddSheet(asLib(b.lib), "New", { before: 0 }, undefined);
    expect(b.lib.commitUndoTransaction, "addSheet committed a transaction it had only joined").not.toHaveBeenCalled();
    expect(b.lib.cancelUndoTransaction, "addSheet cancelled a transaction it had only joined").not.toHaveBeenCalled();
  });

  it("a positioned copySheet on its own opens AND closes its own bracket, with its ticket (positive control)", async () => {
    const b = makeBackend();
    const added = await executeCopySheet(asLib(b.lib), 0, undefined, { before: 0 });
    expect(added).toEqual({ index: 0, name: "Sheet1 (2)" });
    expect(b.lib.beginUndoTransaction).toHaveBeenCalledTimes(1);
    expect(b.lib.commitUndoTransaction).toHaveBeenCalledWith(101);
    expect(b.isOpen()).toBe(false);
  });

  it("a positioned addSheet's bracket closes nothing after the history ended: not the user's next gesture", async () => {
    // The add ends the bracket's own transaction; a gesture that opens before
    // the bracket's commit lands must keep its step.
    const b = makeBackend();
    const move = b.lib.moveSheet.getMockImplementation()!;
    let drag = 0;
    b.lib.moveSheet.mockImplementationOnce(async (from: number, to: number) => {
      const result = await move(from, to);
      drag = b.strangerBegins("Move chart");
      return result;
    });
    await executeAddSheet(asLib(b.lib), "New", { before: 0 }, undefined);
    expect(b.openLabel(), "the positioned add's bracket committed the user's gesture halfway").toBe("Move chart");
    b.strangerCommits(drag);
  });

  it("createNamedStyle inside a batch MARKS the joined step and leaves it open", async () => {
    const b = makeBackend();
    await executeBeginBatch(asLib(b.lib), "script-1", "B");
    await executeCreateNamedStyle(asLib(b.lib), "Alert", { bold: true });
    expect(b.lib.beginUndoTransaction, "joined without the marking begin").toHaveBeenCalledTimes(2);
    expect(b.openAbsorbed()).toBe(true);
    expect(b.openLabel(), "the transient write closed the script's batch").toBe("B");
    expect(b.lib.cancelUndoTransaction).not.toHaveBeenCalled();
  });

  it("createNamedStyle never cancels a transaction a stranger opened while its begin was in flight", async () => {
    // Nothing is open when the call starts; a user's gesture opens the slot
    // before the begin lands, so the begin JOINS -- and cancelling would drop
    // the gesture's whole step (a probe taken before the begin said "closed").
    const b = makeBackend();
    const begin = b.lib.beginUndoTransaction.getMockImplementation()!;
    let paste = 0;
    b.lib.beginUndoTransaction.mockImplementationOnce(async (label: string) => {
      paste = b.strangerBegins("Paste");
      b.write("paste:A1");
      return begin(label);
    });
    await executeCreateNamedStyle(asLib(b.lib), "Alert", { bold: true });
    expect(b.isOpen(), "createNamedStyle cancelled the stranger's transaction").toBe(true);
    b.strangerCommits(paste);
    expect(b.steps[0]).toEqual({ label: "Paste", writes: ["paste:A1", "scratch:apply", "scratch:clear"] });
  });

  it("createNamedStyle on its own still DROPS its scratch records (positive control)", async () => {
    const b = makeBackend();
    await executeCreateNamedStyle(asLib(b.lib), "Alert", { bold: true });
    expect(b.steps, "the transient scratch write left an undo step").toEqual([]);
    expect(b.isOpen()).toBe(false);
    expect(b.lib.commitUndoTransaction).not.toHaveBeenCalled();
    expect(b.lib.cancelUndoTransaction, "the drop did not present its ticket").toHaveBeenCalledWith(101);
  });
});

describe("a batch left open when the script ends (X6)", () => {
  it("the script's OWN open batch is closed (cancelled: undo record dropped, writes kept)", async () => {
    const b = makeBackend();
    await executeBeginBatch(asLib(b.lib), "run-1", "Macro");
    b.write("A1");
    await expect(executeCloseBatchLeftOpen(asLib(b.lib), "run-1")).resolves.toBe(true);
    expect(b.isOpen()).toBe(false);
    expect(b.lib.cancelUndoTransaction).toHaveBeenCalledTimes(1);
    // Taken: a second sweep (the unmount's) finds nothing.
    await expect(executeCloseBatchLeftOpen(asLib(b.lib), "run-1")).resolves.toBe(false);
  });

  it("a batch the script only JOINED is left to its opener", async () => {
    const b = makeBackend();
    b.strangerBegins("Paste");
    await executeBeginBatch(asLib(b.lib), "run-1", "Macro");
    await expect(
      executeCloseBatchLeftOpen(asLib(b.lib), "run-1"),
      "the run's cleanup dropped the user's transaction (it claimed a batch the script only joined)",
    ).resolves.toBe(false);
    expect(b.isOpen(), "the run's cleanup dropped the user's transaction").toBe(true);
    expect(b.lib.cancelUndoTransaction).not.toHaveBeenCalled();
  });

  it("a script with no batch open closes nothing, whatever is open", async () => {
    const b = makeBackend();
    b.strangerBegins("Paste");
    await expect(executeCloseBatchLeftOpen(asLib(b.lib), "run-1")).resolves.toBe(false);
    expect(b.isOpen()).toBe(true);
  });

  it("a begin that lands after its script departed closes what it opened and refuses", async () => {
    const b = makeBackend();
    const begin = b.lib.beginUndoTransaction.getMockImplementation()!;
    b.lib.beginUndoTransaction.mockImplementationOnce(async (label: string) => {
      const answer = await begin(label);
      noteScriptDeparture("run-2"); // unmounted while the begin was in flight
      return answer;
    });
    await expect(executeBeginBatch(asLib(b.lib), "run-2", "Macro")).rejects.toThrow(/ended before its batch opened/);
    expect(b.isOpen(), "a departed script's batch was left open for nobody to close").toBe(false);
    await expect(executeCloseBatchLeftOpen(asLib(b.lib), "run-2")).resolves.toBe(false);
  });

  it("the runner's awaited close waits for an unmount sweep already in flight (a failed run)", async () => {
    // A failed mount tears its realm down itself (mountWorker's catch ->
    // hostUnmountScript), sweeping fire-and-forget BEFORE the runner's
    // `finally` asks to close the batch: that close must still not return
    // before the cancel has landed.
    const b = makeBackend();
    await executeBeginBatch(asLib(b.lib), "run-4", "Macro");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const cancel = b.lib.cancelUndoTransaction.getMockImplementation()!;
    b.lib.cancelUndoTransaction.mockImplementationOnce(async (ticket?: number | null) => {
      await held;
      return cancel(ticket);
    });
    sweepScriptBatchesLeftOpen("run-4", async () => asLib(b.lib));
    let closed = false;
    const closing = hostCloseBatchLeftOpen("run-4").then(() => {
      closed = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(closed, "the runner's close returned while the sweep's cancel was still in flight").toBe(false);
    release();
    await closing;
    expect(b.isOpen()).toBe(false);
  });
});

describe("the comment on api.cancelBatch says what cancel does (X6)", () => {
  it("cancel drops the transaction's undo record; it does not revert the writes", () => {
    const host = fs.readFileSync(path.resolve(__dirname, "../host.ts"), "utf8");
    expect(host, "the cancelBatch comment still claims the cancel REVERTED the batch").not.toMatch(
      /The cancel REVERTED whatever the batch wrote/,
    );
  });
});

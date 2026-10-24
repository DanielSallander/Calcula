//! FILENAME: app/src/shell/SheetTabs/__tests__/ephemeralSheets.test.ts
// PURPOSE: What the tab strip does about a TEMPORARY (drill-through) sheet,
//          rule by rule: a double-click on its tab KEEPS it (rename stays in
//          the tab menu), and a fresh read of the sheet list names the sheet
//          the user has just LEFT -- or nothing, in every case where a discard
//          would delete the wrong sheet or a sheet already gone.
// CONTEXT: docs/design/model-drillthrough.md 2.7. The observer in SheetTabs
//          runs ONLY on the backend-derived read; these helpers are its whole
//          decision, so a mounted strip is not needed to prove them (the
//          resolveTabClick.test.ts shape). The observer ITSELF
//          (`createEphemeralLeaveObserver`) is driven here read by read: when
//          it pauses, what it owes when a pause or a flow ends, and the order
//          of memory and discard. The mounted strip, the real flows and a FIFO
//          backend model are sheetTabsTemporarySheets.test.tsx.

import { describe, it, expect, vi } from "vitest";
import {
  EPHEMERAL_TAB_TOOLTIP,
  createEphemeralLeaveObserver,
  keepNotice,
  leaveObserverPaused,
  prevActiveOf,
  refusedDiscardOutcome,
  resolveEphemeralLeave,
  resolveTabDoubleClick,
  temporarySheetStateIn,
  type PrevActiveSheet,
} from "../ephemeralSheets";
import type { SheetInfo, SheetsResult } from "../../../core/lib/tauri-api";

const sheet = (index: number, name: string, extra: Partial<SheetInfo> = {}): SheetInfo => ({
  index,
  name,
  visibility: "visible",
  sheetId: `id-${name}`,
  ...extra,
});

const read = (activeIndex: number, ...sheets: SheetInfo[]): SheetsResult => ({ sheets, activeIndex });

const DRILL = sheet(2, "Drillthrough", { ephemeral: true });
const onDrill: PrevActiveSheet = { sheetId: "id-Drillthrough", ephemeral: true };

describe("resolveTabDoubleClick", () => {
  it("an ephemeral tab's double-click KEEPS the sheet", () => {
    expect(resolveTabDoubleClick(DRILL)).toBe("keep");
  });

  it("an ordinary tab's double-click renames, as it always has", () => {
    expect(resolveTabDoubleClick(sheet(0, "Sheet1"))).toBe("rename");
    expect(resolveTabDoubleClick(sheet(0, "Sheet1", { ephemeral: false }))).toBe("rename");
  });

  it("a tab the strip cannot resolve falls back to rename (the old path answers with an empty name)", () => {
    expect(resolveTabDoubleClick(undefined)).toBe("rename");
  });
});

describe("prevActiveOf -- what the observer remembers from a backend read", () => {
  it("the active sheet's id and flag", () => {
    expect(prevActiveOf(read(2, sheet(0, "Sheet1"), DRILL))).toEqual(onDrill);
    expect(prevActiveOf(read(0, sheet(0, "Sheet1"), DRILL))).toEqual({ sheetId: "id-Sheet1", ephemeral: false });
  });

  it("by the index FIELD, never list position (object-backed sheets are absent from the list)", () => {
    // Index 1 is an object sheet the list omits; the active sheet is at index 2.
    expect(prevActiveOf(read(2, sheet(0, "Sheet1"), DRILL))?.sheetId).toBe("id-Drillthrough");
  });

  it("null when the active sheet carries no id (an older backend) or is not listed", () => {
    expect(prevActiveOf(read(0, { index: 0, name: "Sheet1", visibility: "visible" }))).toBeNull();
    expect(prevActiveOf(read(0, sheet(0, "Sheet1", { sheetId: "" })))).toBeNull();
    expect(prevActiveOf(read(5, sheet(0, "Sheet1")))).toBeNull();
  });
});

describe("resolveEphemeralLeave -- the sheet the user has just LEFT", () => {
  it("the leave: the previously active sheet was ephemeral, is still listed and flagged, and another is active now", () => {
    expect(resolveEphemeralLeave(onDrill, read(0, sheet(0, "Sheet1"), DRILL))).toBe("id-Drillthrough");
  });

  it("nothing remembered (the first read, or an error fallback never adopted): null -- reaching a sheet is not leaving one", () => {
    expect(resolveEphemeralLeave(null, read(2, sheet(0, "Sheet1"), DRILL))).toBeNull();
  });

  it("the previously active sheet was ordinary: null", () => {
    expect(
      resolveEphemeralLeave({ sheetId: "id-Sheet1", ephemeral: false }, read(2, sheet(0, "Sheet1"), DRILL)),
    ).toBeNull();
  });

  it("the same id is still active (a delete of ANOTHER sheet lands on it; a plain re-read): null", () => {
    // Sheet1 (index 0) was deleted from the drill sheet's tab menu: the drill
    // sheet slid from index 2 to 1 and stays active.
    const after = read(1, sheet(1, "Drillthrough", { ephemeral: true }));
    expect(resolveEphemeralLeave(onDrill, after)).toBeNull();
    expect(resolveEphemeralLeave(onDrill, read(2, sheet(0, "Sheet1"), DRILL))).toBeNull();
  });

  it("the remembered sheet is no longer listed (already discarded; File > New / Open minted fresh ids): null", () => {
    expect(resolveEphemeralLeave(onDrill, read(0, sheet(0, "Sheet1")))).toBeNull();
    expect(resolveEphemeralLeave(onDrill, read(0, sheet(0, "Sheet1", { sheetId: "fresh-1" }), sheet(1, "Sheet2", { sheetId: "fresh-2" })))).toBeNull();
  });

  it("the fresh read no longer flags it (kept from its tab menu, or by a refused discard): null -- the backend's flag is the authority", () => {
    const kept = read(0, sheet(0, "Sheet1"), sheet(2, "Drillthrough", { ephemeral: false }));
    expect(resolveEphemeralLeave(onDrill, kept)).toBeNull();
    const unflagged = read(0, sheet(0, "Sheet1"), sheet(2, "Drillthrough"));
    expect(resolveEphemeralLeave(onDrill, unflagged)).toBeNull();
  });

  it("matches the active sheet by the index FIELD (a list with object sheets omitted)", () => {
    // Active index 3 is listed; index 1 is an omitted object sheet. The drill
    // sheet at index 2 was left.
    const next = read(3, sheet(0, "Sheet1"), DRILL, sheet(3, "Report"));
    expect(resolveEphemeralLeave(onDrill, next)).toBe("id-Drillthrough");
  });

  it("rule 2's shape: once the caller overwrites its memory with the fresh read, the same pair resolves to nothing a second time", () => {
    const next = read(0, sheet(0, "Sheet1"), DRILL);
    const first = resolveEphemeralLeave(onDrill, next);
    expect(first).toBe("id-Drillthrough");
    // The strip does this synchronously, before awaiting the discard; a
    // second `loadSheets` (the delete's own `sheets:refresh`) sees Sheet1.
    const remembered = prevActiveOf(next);
    expect(resolveEphemeralLeave(remembered, next)).toBeNull();
  });
});

describe("the tab's words", () => {
  it("say what a temporary sheet is and how to keep it", () => {
    expect(EPHEMERAL_TAB_TOOLTIP).toBe(
      "Temporary sheet: it closes when you leave it. Double-click the tab to keep it.",
    );
  });
});

// Review finding point-mode-discards-edited-sheet: the observer's skip was
// "the formula expects a reference RIGHT NOW", which turns false the moment a
// point-mode click inserts the reference while the backend is still on the
// other sheet. The pause is "a cell edit is OPEN", whatever its text.
/** Core's synchronous edit flags with nothing open or opening. */
const NO_FLAGS = { coreEditOpen: false, editorOpening: false };

describe("leaveObserverPaused -- the observer records nothing while ANY cell edit is open", () => {
  it("a Core edit pauses it whatever the formula looks like -- also once it no longer expects a reference", () => {
    expect(leaveObserverPaused({ value: "=" }, null, NO_FLAGS)).toBe(true);
    // The finding's step 3: `=Sales!B2` expects nothing, the backend is on Sales.
    expect(leaveObserverPaused({ value: "=Sales!B2" }, null, NO_FLAGS)).toBe(true);
    expect(leaveObserverPaused({ value: "plain text" }, null, NO_FLAGS)).toBe(true);
    expect(leaveObserverPaused({ value: "" }, null, NO_FLAGS)).toBe(true);
  });

  it("a live external session (a floating grid's cell edit) pauses it", () => {
    expect(leaveObserverPaused(null, { hostSheetIndex: 2 }, NO_FLAGS)).toBe(true);
    expect(leaveObserverPaused(null, "2:1:0", NO_FLAGS)).toBe(true);
  });

  // Review TSHELL4-DISCARD-LANDS-UNDER-OPEN-EDIT: an edit that is still OPENING
  // has no editing state yet -- only Core's synchronous flags see it.
  it("an edit that is OPENING pauses it: the typed-open latch, or Core's edit flag before its editing state exists", () => {
    expect(leaveObserverPaused(null, null, { coreEditOpen: false, editorOpening: true })).toBe(true);
    expect(leaveObserverPaused(null, null, { coreEditOpen: true, editorOpening: false })).toBe(true);
    expect(leaveObserverPaused(undefined, undefined, { coreEditOpen: true, editorOpening: true })).toBe(true);
  });

  it("no edit, no session and nothing opening: the observer judges the read", () => {
    expect(leaveObserverPaused(null, null, NO_FLAGS)).toBe(false);
    expect(leaveObserverPaused(undefined, undefined, NO_FLAGS)).toBe(false);
  });
});

/** A ticket-taking reader over one observer, as the strip's `loadSheets` is. */
function harness(options: { paused?: () => boolean; inFlight?: (id: string) => boolean } = {}) {
  const discards: string[] = [];
  const memoryAtDiscard: Array<PrevActiveSheet | null> = [];
  const observer = createEphemeralLeaveObserver({
    paused: options.paused ?? (() => false),
    discardInFlight: options.inFlight ?? (() => false),
    discard: (id) => {
      discards.push(id);
      memoryAtDiscard.push(observer.remembered());
    },
  });
  /** A read sent and answered with no flow around it. */
  const judge = (result: SheetsResult) => observer.observe(result, observer.readSent());
  return { observer, discards, memoryAtDiscard, judge };
}

const SHEET1 = sheet(0, "Sheet1");
const ON_DRILL = read(2, SHEET1, DRILL);
const ON_SHEET1 = read(0, SHEET1, DRILL);

describe("createEphemeralLeaveObserver -- the leave, the memory and the in-flight guard", () => {
  it("reaching a temporary sheet is not leaving it; leaving it discards it ONCE, by its stable id", () => {
    const { discards, judge } = harness();
    judge(ON_DRILL);
    expect(discards).toEqual([]);
    judge(ON_SHEET1);
    expect(discards).toEqual(["id-Drillthrough"]);
    // The delete's own re-reads see the same pair again: nothing more.
    judge(ON_SHEET1);
    judge(read(0, SHEET1));
    expect(discards).toEqual(["id-Drillthrough"]);
  });

  it("the memory is overwritten BEFORE the discard is issued (rule 2)", () => {
    const { memoryAtDiscard, judge } = harness();
    judge(ON_DRILL);
    judge(ON_SHEET1);
    expect(memoryAtDiscard).toEqual([{ sheetId: "id-Sheet1", ephemeral: false }]);
  });

  it("a sheet whose discard is already in flight is not discarded again (the memory still moves on)", () => {
    const { observer, discards, judge } = harness({ inFlight: (id) => id === "id-Drillthrough" });
    judge(ON_DRILL);
    judge(ON_SHEET1);
    expect(discards).toEqual([]);
    expect(observer.remembered()).toEqual({ sheetId: "id-Sheet1", ephemeral: false });
  });

  it("a keep moves the memory, so a later leave of the kept sheet discards nothing", () => {
    const { observer, discards, judge } = harness();
    judge(ON_DRILL);
    observer.kept("id-Drillthrough");
    expect(observer.remembered()).toEqual({ sheetId: "id-Drillthrough", ephemeral: false });
    judge(ON_SHEET1);
    expect(discards).toEqual([]);
    // A keep of ANOTHER sheet leaves the memory alone.
    const other = harness();
    other.judge(ON_DRILL);
    other.observer.kept("id-Sheet1");
    expect(other.observer.remembered()).toEqual({ sheetId: "id-Drillthrough", ephemeral: true });
  });
});

describe("createEphemeralLeaveObserver -- the pause while a cell edit is open (rule 3)", () => {
  it("a point-mode trip: reads during the edit record nothing, and the edit ending on the source sheet discards nothing", () => {
    let editOpen = false;
    const { observer, discards, judge } = harness({ paused: () => editOpen });
    judge(ON_DRILL);
    // Type "=" on the drill sheet, click the Sheet1 tab (point mode moves the
    // BACKEND to Sheet1 with no event), click B2: the formula expects nothing
    // now, and a read arrives with the backend still on Sheet1.
    editOpen = true;
    judge(ON_SHEET1);
    judge(ON_SHEET1);
    expect(discards).toEqual([]);
    expect(observer.remembered()).toEqual({ sheetId: "id-Drillthrough", ephemeral: true });
    // Enter: the commit switches back to the drill sheet, THEN closes the edit.
    editOpen = false;
    expect(observer.pauseEnded()).toBe(true);
    judge(ON_DRILL);
    expect(discards).toEqual([]);
  });

  it("a door switch during the edit, the edit then ending on another sheet: exactly one discard, on the re-read", () => {
    let editOpen = true;
    const { observer, discards, judge } = harness({ paused: () => editOpen });
    editOpen = false;
    judge(ON_DRILL);
    editOpen = true;
    judge(ON_SHEET1);
    expect(discards).toEqual([]);
    editOpen = false;
    expect(observer.pauseEnded()).toBe(true);
    judge(ON_SHEET1);
    expect(discards).toEqual(["id-Drillthrough"]);
  });

  it("a re-read is owed ONLY when a read was skipped, and only once", () => {
    let editOpen = true;
    const { observer, judge } = harness({ paused: () => editOpen });
    expect(observer.pauseEnded()).toBe(false);
    judge(ON_DRILL);
    expect(observer.pauseEnded()).toBe(true);
    expect(observer.pauseEnded()).toBe(false);
    editOpen = false;
    judge(ON_DRILL);
    expect(observer.pauseEnded()).toBe(false);
  });
});

// A discard asked for while a cell edit was open or opening is not SENT
// (SheetTabs.tsx `discardSheetById`); the leave is handed back as OWED, and
// the pause's one re-read settles it (review TSHELL4-DISCARD-LANDS-UNDER-OPEN-EDIT).
describe("createEphemeralLeaveObserver -- a leave whose discard was deferred is OWED", () => {
  it("the next judged read discards the owed sheet when it is still temporary and not active -- though the memory moved on", () => {
    const { observer, discards, judge } = harness();
    judge(ON_DRILL);
    judge(ON_SHEET1); // the leave: discard asked for...
    expect(discards).toEqual(["id-Drillthrough"]);
    // ...and not sent (an edit was opening); the memory already says Sheet1.
    observer.leaveDeferred("id-Drillthrough");
    expect(observer.remembered()).toEqual({ sheetId: "id-Sheet1", ephemeral: false });
    expect(observer.owedLeaves()).toEqual(["id-Drillthrough"]);
    // The pause's end owes the ONE re-read...
    expect(observer.pauseEnded()).toBe(true);
    // ...and that read discards the owed sheet, once.
    judge(ON_SHEET1);
    expect(discards).toEqual(["id-Drillthrough", "id-Drillthrough"]);
    expect(observer.owedLeaves()).toEqual([]);
    judge(ON_SHEET1);
    expect(discards).toHaveLength(2);
  });

  it("an owed sheet the user is ON is never discarded (a drill-from-drill refused under an edit), and the debt is dropped", () => {
    const { observer, discards, judge } = harness();
    judge(ON_DRILL);
    observer.leaveDeferred("id-Drillthrough");
    judge(ON_DRILL);
    expect(discards).toEqual([]);
    expect(observer.owedLeaves()).toEqual([]);
    // Leaving it LATER is an ordinary leave.
    judge(ON_SHEET1);
    expect(discards).toEqual(["id-Drillthrough"]);
  });

  it("an owed sheet that is gone, or kept, is dropped without a discard", () => {
    const gone = harness();
    gone.judge(read(0, SHEET1, DRILL));
    gone.observer.leaveDeferred("id-Drillthrough");
    gone.judge(read(0, SHEET1));
    expect(gone.discards).toEqual([]);
    expect(gone.observer.owedLeaves()).toEqual([]);

    const kept = harness();
    kept.judge(read(0, SHEET1, DRILL));
    kept.observer.leaveDeferred("id-Drillthrough");
    kept.judge(read(0, SHEET1, sheet(2, "Drillthrough", { ephemeral: false })));
    expect(kept.discards).toEqual([]);
    expect(kept.observer.owedLeaves()).toEqual([]);
  });

  it("the debt waits out a pause and a flow -- a read judged neither while paused nor mid-flow -- and is never sent twice", () => {
    let paused = true;
    let inFlight = false;
    const { observer, discards } = harness({ paused: () => paused, inFlight: () => inFlight });
    observer.leaveDeferred("id-Drillthrough");
    observer.observe(ON_SHEET1, observer.readSent());
    paused = false;
    observer.flowStarted();
    observer.observe(ON_SHEET1, observer.readSent());
    expect(discards, "nothing is discarded while paused or mid-flow").toEqual([]);
    expect(observer.owedLeaves()).toEqual(["id-Drillthrough"]);
    observer.flowSettled();
    // A discard of it already in flight: not sent again, and the debt is settled.
    inFlight = true;
    observer.observe(ON_SHEET1, observer.readSent());
    expect(discards).toEqual([]);
    expect(observer.owedLeaves()).toEqual([]);
  });

  it("the debt is registered before the next read issues any discard, so a discard deferred AGAIN keeps its own debt", () => {
    const owedAtDiscard: string[][] = [];
    const observer = createEphemeralLeaveObserver({
      paused: () => false,
      discardInFlight: () => false,
      discard: (id) => {
        owedAtDiscard.push(observer.owedLeaves());
        // The strip's discard finds an edit opening once more and defers again.
        observer.leaveDeferred(id);
      },
    });
    observer.observe(read(0, SHEET1, DRILL), observer.readSent());
    observer.leaveDeferred("id-Drillthrough");
    observer.observe(read(0, SHEET1, DRILL), observer.readSent());
    expect(owedAtDiscard, "the old debt was cleared before the discard was issued").toEqual([[]]);
    expect(observer.owedLeaves()).toEqual(["id-Drillthrough"]);
  });
});

describe("createEphemeralLeaveObserver -- the strip's own two-step flows", () => {
  it("a read SENT during a flow records nothing, even when it answers after the flow settled", () => {
    const { observer, discards } = harness();
    observer.observe(ON_DRILL, observer.readSent());
    observer.flowStarted();
    const midFlow = observer.readSent();
    expect(observer.flowSettled()).toBe(true);
    observer.observe(ON_SHEET1, midFlow);
    expect(discards).toEqual([]);
    expect(observer.remembered()).toEqual({ sheetId: "id-Drillthrough", ephemeral: true });
    // The settle's own re-read is judged.
    observer.observe(ON_SHEET1, observer.readSent());
    expect(discards).toEqual(["id-Drillthrough"]);
  });

  it("a read ANSWERED during a flow records nothing, whenever it was sent", () => {
    const { observer, discards } = harness();
    observer.observe(ON_DRILL, observer.readSent());
    const beforeFlow = observer.readSent();
    observer.flowStarted();
    observer.observe(ON_SHEET1, beforeFlow);
    expect(discards).toEqual([]);
    observer.flowSettled();
  });

  it("a read that STRADDLES a whole flow (sent before it, answered after it) records nothing", () => {
    const { observer, discards } = harness();
    observer.observe(ON_DRILL, observer.readSent());
    const straddling = observer.readSent();
    observer.flowStarted();
    observer.flowSettled();
    observer.observe(ON_SHEET1, straddling);
    expect(discards).toEqual([]);
  });

  it("the re-read is owed when the LAST flow in flight settles", () => {
    const { observer } = harness();
    observer.flowStarted();
    observer.flowStarted();
    expect(observer.flowSettled()).toBe(false);
    expect(observer.flowSettled()).toBe(true);
    // An unbalanced settle never drives the count negative.
    expect(observer.flowSettled()).toBe(true);
    observer.flowStarted();
    expect(observer.readSent().flowInFlight).toBe(true);
  });

  // Review TSHELL-3: the drill runner's discard waits on this, never between a flow's two steps.
  it("whenFlowsIdle resolves at once with no flow, and only when the LAST flow in flight settles", async () => {
    const { observer } = harness();
    expect(observer.flowsInFlight()).toBe(0);
    let idle = false;
    await observer.whenFlowsIdle().then(() => {
      idle = true;
    });
    expect(idle).toBe(true);

    observer.flowStarted();
    observer.flowStarted();
    expect(observer.flowsInFlight()).toBe(2);
    let released = 0;
    const waiters = [observer.whenFlowsIdle(), observer.whenFlowsIdle()].map((p) =>
      p.then(() => {
        released += 1;
      }),
    );
    observer.flowSettled();
    await Promise.resolve();
    expect(released, "one flow is still in flight").toBe(0);
    observer.flowSettled();
    await Promise.all(waiters);
    expect(released).toBe(2);
    expect(observer.flowsInFlight()).toBe(0);
  });
});

describe("what the strip says after a keep (keep-claims-success-it-did-not-get)", () => {
  const kept = read(0, SHEET1, sheet(2, "Drillthrough", { ephemeral: false }));
  const flagged = read(0, SHEET1, DRILL);
  const gone = read(0, SHEET1);

  it("temporarySheetStateIn reads THIS sheet's row: unflagged, flagged, or not listed", () => {
    expect(temporarySheetStateIn(kept, "id-Drillthrough")).toBe("kept");
    expect(temporarySheetStateIn(flagged, "id-Drillthrough")).toBe("temporary");
    expect(temporarySheetStateIn(gone, "id-Drillthrough")).toBe("gone");
    // An ordinary sheet elsewhere in the list says nothing about this one.
    expect(temporarySheetStateIn(read(0, SHEET1), "id-Sheet1")).toBe("kept");
  });

  it('"Sheet kept" ONLY when the answered list holds the sheet unflagged', () => {
    expect(keepNotice("kept")).toEqual({ message: "Sheet kept", variant: "success" });
    for (const state of ["temporary", "gone", "unknown"] as const) {
      const notice = keepNotice(state, "There is no sheet with that id.");
      expect(notice.variant, state).toBe("error");
      expect(notice.message, state).not.toMatch(/^Sheet kept/);
    }
  });

  it("each failure says what is true: still temporary, gone, or the refusal itself", () => {
    expect(keepNotice("temporary").message).toBe(
      "The sheet could not be kept: it is still temporary and will close when you leave it.",
    );
    expect(keepNotice("temporary", "Workbook structure is protected.").message).toBe(
      "The sheet could not be kept (Workbook structure is protected): it is still temporary and will close when you leave it.",
    );
    expect(keepNotice("gone").message).toBe("The sheet could not be kept: it is no longer in the workbook.");
    expect(keepNotice("unknown", "IPC down.").message).toBe("The sheet could not be kept: IPC down.");
  });
});

describe("what the strip says after a REFUSED discard", () => {
  const REASON = "The workbook structure is protected.";

  it('"Temporary sheet kept: <reason>" ONLY when the keep landed', () => {
    expect(refusedDiscardOutcome(REASON, "kept")).toEqual({
      gone: false,
      notice: { message: `Temporary sheet kept: ${REASON}`, variant: "info" },
    });
  });

  it("the keep failed too: a warning that the sheet is still temporary -- never 'kept'", () => {
    const outcome = refusedDiscardOutcome(REASON, "temporary", "There is no sheet with that id.");
    expect(outcome.gone).toBe(false);
    expect(outcome.notice?.variant).toBe("warning");
    expect(outcome.notice?.message).toBe(
      "The temporary sheet could not be closed (The workbook structure is protected) or kept: it is still temporary and will close when you leave it.",
    );
    const unknown = refusedDiscardOutcome(REASON, "unknown", "IPC down.");
    expect(unknown.notice?.message).toBe(
      "The temporary sheet could not be closed (The workbook structure is protected) or kept (IPC down).",
    );
    expect(unknown.notice?.message).not.toMatch(/kept:/);
  });

  it("the sheet is gone after all: nothing to tell, and the caller's goal holds", () => {
    expect(refusedDiscardOutcome("There is no sheet with that id.", "gone")).toEqual({ gone: true, notice: null });
  });
});

describe("the observer never calls the discard while paused or mid-flow (spy)", () => {
  it("paused + mid-flow reads produce no discard call at all", () => {
    const discard = vi.fn();
    let paused = true;
    const observer = createEphemeralLeaveObserver({
      paused: () => paused,
      discardInFlight: () => false,
      discard,
    });
    paused = false;
    observer.observe(ON_DRILL, observer.readSent());
    paused = true;
    observer.observe(ON_SHEET1, observer.readSent());
    paused = false;
    observer.flowStarted();
    observer.observe(ON_SHEET1, observer.readSent());
    expect(discard).not.toHaveBeenCalled();
    observer.flowSettled();
    observer.observe(ON_SHEET1, observer.readSent());
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith("id-Drillthrough");
  });
});

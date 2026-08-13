//! FILENAME: app/e2e/__tests__/walkerReplayPreconditions.test.ts
// PURPOSE: A recorded action must not be replayed against a workbook its
//          parameters no longer fit.
//
// CONTEXT (BUG-0039). `actionCatalog.ts`'s header promises that "preconditions
// are re-checked on replay, so removing a create simply causes dependent
// actions to be skipped rather than crash". They were re-checked — but the
// precondition could not SEE the recorded parameters, so it could only ask
// "are there at least two sheets?", never "does sheet 2 exist?".
//
// The shrinker records `sheet.rename {tabIndex: 2}` against a three-sheet
// workbook, then drops the `sheet.add` that made the third sheet and replays
// the rename against two. The product answers with a NATIVE alert — "Failed to
// rename sheet: Sheet index 2 out of range" — which blocks Tauri IPC while
// leaving the page perfectly responsive. Twelve of them stacked up during one
// shrink and the walk hung, silently, for its entire 30-minute timeout.
//
// Two things had to change and both are tested here: the precondition takes the
// params, and the trace source hands them over.

import { describe, it, expect } from "vitest";
import { ACTION_CATALOG, FULL_ACTION_CATALOG, createTraceSource, findAction } from "../walker";
import type { StateSnapshot } from "../invariants/stateSnapshot";
import type { ActionTrace } from "../walker";

function snapshot(sheetCount: number): StateSnapshot {
  return {
    logical: {
      slicers: [],
      charts: [],
      tables: [],
      pivots: [],
      timelines: [],
      sparklineGroups: [],
      selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      activeSheet: 0,
      sheetCount,
      isEditing: false,
    },
    visual: {
      ribbonTabs: [],
      visibleDialogCount: 0,
      nameBoxValue: "A1",
      formulaBarValue: "",
      ribbonBlockedBy: null,
    },
    consoleErrors: [],
    jsExceptions: [],
    timestamp: 0,
  } as unknown as StateSnapshot;
}

const trace = (actions: ActionTrace["actions"]): ActionTrace => ({
  version: 1,
  seed: 1,
  startedAt: "",
  actions,
});

describe("replay re-checks the RECORDED parameters, not just the shape of the state", () => {
  it("refuses sheet.rename whose recorded tabIndex no longer exists", () => {
    const rename = findAction("sheet.rename", FULL_ACTION_CATALOG)!;
    // Three sheets: index 2 is real.
    expect(rename.precondition(snapshot(3), { tabIndex: 2, name: "x" })).toBe(true);
    // Two sheets: index 2 is the exact input that raised the native alert.
    expect(rename.precondition(snapshot(2), { tabIndex: 2, name: "x" })).toBe(false);
  });

  it("refuses sheet.switch whose recorded tabIndex no longer exists", () => {
    const sw = findAction("sheet.switch", FULL_ACTION_CATALOG)!;
    expect(sw.precondition(snapshot(3), { tabIndex: 2 })).toBe(true);
    expect(sw.precondition(snapshot(2), { tabIndex: 2 })).toBe(false);
  });

  it("still lets the GENERATOR choose the action, where no params exist yet", () => {
    // pickParams runs after the precondition, so the generator's call has no
    // parameters at all. A precondition that demanded them would silently
    // remove both actions from generation — which is how this fix could have
    // re-created the very hole §10a was about.
    for (const id of ["sheet.rename", "sheet.switch"]) {
      const def = findAction(id, ACTION_CATALOG)!;
      expect(def.precondition(snapshot(3)), `${id} became ungeneratable`).toBe(true);
      expect(def.precondition(snapshot(1)), `${id} on a single-sheet workbook`).toBe(false);
    }
  });

  it("the trace source SKIPS the stale action instead of executing it", () => {
    // The end-to-end property: it is the source that must hand the recorded
    // params to the precondition. Without that wiring the case above passes and
    // the walk still hangs.
    const log = { skipped: [] as number[] };
    const source = createTraceSource(
      trace([
        { id: "sheet.rename", params: { tabIndex: 2, name: "Blad_53" } },
        { id: "cell.click", params: { ref: "A1" } },
      ]),
      FULL_ACTION_CATALOG,
      log
    );

    const first = source.next(snapshot(2), 1);
    expect(first?.id, "the out-of-range rename was replayed").toBe("cell.click");
    expect(log.skipped).toEqual([0]);
  });

  it("replays the same action when the workbook DOES still fit it", () => {
    // The control. A guard that skipped the action unconditionally would pass
    // the case above and quietly delete the sheet surface from every replay.
    const source = createTraceSource(
      trace([{ id: "sheet.rename", params: { tabIndex: 2, name: "Blad_53" } }]),
      FULL_ACTION_CATALOG
    );
    expect(source.next(snapshot(3), 1)?.id).toBe("sheet.rename");
  });
});

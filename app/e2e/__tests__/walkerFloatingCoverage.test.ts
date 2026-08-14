//! FILENAME: app/e2e/__tests__/walkerFloatingCoverage.test.ts
// PURPOSE: Pin the walker's floating-range coverage: the actions are
//          GENERATABLE, their effect is OBSERVED (not inferred), and the undo
//          oracle declines — rather than decides — a window that created one.
//
// CONTEXT. Floating Ranges landed 2026-08-13 (object-backed sheets,
// `=Float1!A1`) with ~50 unit tests and a journey, and NO walker reach: no
// catalog action could create one, so every oracle ran over workbooks where
// the feature did not exist — the exact "issued-by-nobody" hole §14a/§18c
// closed for sheet.unhide/sheet.tabColor one pass earlier.
//
// Two instrument rules are pinned here because each has already produced a
// false product defect once:
//
//   1. EFFECT IS MEASURED. `frChange` is recorded from the pre/post snapshots
//      (BUG-0031's lesson: an action that "ran" proves nothing).
//   2. FR CREATE MAKES A WINDOW UNDECIDABLE. Creation is the product's one
//      mutation that is neither undoable nor history-ending (add_sheet parity
//      without the clear — §16), so an oracle that decides such a window
//      reports the surviving object as an undo defect (BUG-0005/S12's shape,
//      BUG-0049's instrument-blames-product shape).

import { describe, it, expect } from "vitest";
import {
  summarizeCoverage,
  frShapeOf,
  frShapesDiffer,
} from "../walker/walkRunner";
import type { ActionTiming, FloatingShape } from "../walker/walkRunner";
import { ACTION_CATALOG, findAction } from "../walker";
import { frCreatedSinceBaseline } from "../oracles/undoRoundTrip";
import type { StateSnapshot, FloatingRangeSnapshotInfo } from "../invariants/stateSnapshot";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fr(over: Partial<FloatingRangeSnapshotInfo> = {}): FloatingRangeSnapshotInfo {
  return {
    id: "fr-1",
    name: "Float1",
    hostSheetIndex: 0,
    rows: 1,
    cols: 1,
    x: 150,
    y: 60,
    cellStamp: "",
    ...over,
  };
}

function snap(frs: FloatingRangeSnapshotInfo[]): StateSnapshot {
  return {
    logical: {
      floatingRanges: frs,
      sheetCount: 1,
      activeSheet: 0,
      sheetNames: ["Sheet1"],
    },
  } as unknown as StateSnapshot;
}

function timing(
  step: number,
  id: string,
  frChange?: { before: FloatingShape; after: FloatingShape },
  error?: string
): ActionTiming {
  return {
    step,
    id,
    params: {},
    startedAtMs: step * 100,
    durationMs: 10,
    ...(frChange ? { frChange } : {}),
    ...(error ? { error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Generatability
// ---------------------------------------------------------------------------

describe("the floating-range surface is reachable by generation", () => {
  it("generates all six fr actions", () => {
    const generated = new Set(ACTION_CATALOG.map((a) => a.id));
    for (const id of [
      "fr.create",
      "fr.setCell",
      "fr.resize",
      "fr.rename",
      "fr.refFromGrid",
      "fr.delete",
    ]) {
      expect(generated.has(id), `${id} is not generatable`).toBe(true);
    }
  });

  it("gates create on the object cap and everything else on existence", () => {
    const create = findAction("fr.create", ACTION_CATALOG)!;
    expect(create.precondition(snap([]))).toBe(true);
    expect(create.precondition(snap([fr(), fr({ id: "b" }), fr({ id: "c" })]))).toBe(
      false
    );

    for (const id of ["fr.setCell", "fr.resize", "fr.rename", "fr.refFromGrid", "fr.delete"]) {
      const def = findAction(id, ACTION_CATALOG)!;
      expect(def.precondition(snap([])), `${id} must not fire on an empty workbook`).toBe(
        false
      );
      expect(def.precondition(snap([fr()])), `${id} must fire when an FR exists`).toBe(
        true
      );
    }
  });

  it("re-checks RECORDED params on replay — the BUG-0039 rule", () => {
    // The shrinker drops the fr.resize that grew the window, then replays a
    // recorded write at row 3 against a 1x1 FR. The precondition must refuse.
    const setCell = findAction("fr.setCell", ACTION_CATALOG)!;
    const oneByOne = snap([fr({ rows: 1, cols: 1 })]);
    expect(
      setCell.precondition(oneByOne, { frIndex: 0, row: 3, col: 0, value: "7" })
    ).toBe(false);
    expect(
      setCell.precondition(oneByOne, { frIndex: 0, row: 0, col: 0, value: "7" })
    ).toBe(true);
    // And an index past the live list is refused, not resolved to undefined.
    expect(
      setCell.precondition(oneByOne, { frIndex: 4, row: 0, col: 0, value: "7" })
    ).toBe(false);
  });

  it("survives a legacy snapshot that predates the floatingRanges axis", () => {
    const legacy = { logical: { sheetCount: 1 } } as unknown as StateSnapshot;
    expect(findAction("fr.create", ACTION_CATALOG)!.precondition(legacy)).toBe(true);
    expect(findAction("fr.delete", ACTION_CATALOG)!.precondition(legacy)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Observed effect (frShape / summarizeCoverage)
// ---------------------------------------------------------------------------

describe("floating-range effect is measured, not inferred", () => {
  it("sees create, delete and resize through the shape", () => {
    const none = frShapeOf(snap([]));
    const one = frShapeOf(snap([fr()]));
    const grown = frShapeOf(snap([fr({ rows: 3, cols: 2 })]));
    expect(frShapesDiffer(none, one)).toBe(true);
    expect(frShapesDiffer(one, grown)).toBe(true);
    expect(frShapesDiffer(one, frShapeOf(snap([fr()])))).toBe(false);
  });

  it("sees a RENAME and a MOVE, which no count ever could", () => {
    const a = frShapeOf(snap([fr({ name: "Float1" })]));
    const renamed = frShapeOf(snap([fr({ name: "Fl_9" })]));
    const moved = frShapeOf(snap([fr({ x: 300 })]));
    expect(frShapesDiffer(a, renamed)).toBe(true);
    expect(frShapesDiffer(a, moved)).toBe(true);
  });

  it("sees a CELL WRITE through the content stamp — fr.setCell is observable", () => {
    // Geometry and name identical; only the content moved. Without the
    // cellStamp axis every fr.setCell was issued-but-never-observed (§14a).
    const empty = frShapeOf(snap([fr()]));
    const written = frShapeOf(snap([fr({ cellStamp: "0,0=42" })]));
    expect(frShapesDiffer(empty, written)).toBe(true);
  });

  it("keeps fr.refFromGrid OUT of the object accounting — its effect is a grid cell", () => {
    const summary = summarizeCoverage([timing(1, "fr.refFromGrid")]);
    expect(summary.fr.attempted).toBe(0);
    expect(summary.families.fr, "still counted as having run").toBe(1);
  });

  it("is order-insensitive — two FRs listed in either order are one state", () => {
    const ab = frShapeOf(snap([fr({ id: "a" }), fr({ id: "b" })]));
    const ba = frShapeOf(snap([fr({ id: "b" }), fr({ id: "a" })]));
    expect(frShapesDiffer(ab, ba)).toBe(false);
  });

  it("counts an fr action as effective only when the workbook answered", () => {
    const change = {
      before: frShapeOf(snap([])),
      after: frShapeOf(snap([fr()])),
    };
    const summary = summarizeCoverage([
      timing(1, "fr.create", change),
      timing(2, "fr.create"), // raced/no-op: nothing changed
      timing(3, "cell.click"),
    ]);
    expect(summary.fr.attempted).toBe(2);
    expect(summary.fr.effective).toBe(1);
    expect(summary.fr.byActionEffective).toEqual({ "fr.create": 1 });
  });

  it("names a NON-fr action that moved the object store", () => {
    const change = {
      before: frShapeOf(snap([fr({ rows: 2 })])),
      after: frShapeOf(snap([fr({ rows: 1 })])),
    };
    const summary = summarizeCoverage([timing(9, "undo", change)]);
    expect(summary.fr.attempted).toBe(0);
    expect(summary.unexpectedFrChanges).toEqual([{ step: 9, id: "undo" }]);
  });

  it("reports a wholly inert fr surface as zero, not as coverage", () => {
    const summary = summarizeCoverage([
      timing(1, "fr.create"),
      timing(2, "fr.setCell"),
      timing(3, "fr.delete"),
    ]);
    expect(summary.families.fr).toBe(3);
    expect(summary.fr.effective).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The undo oracle's decidability rule
// ---------------------------------------------------------------------------

describe("frCreatedSinceBaseline: FR creation makes a window undecidable", () => {
  it("returns exactly the ids the baseline never had", () => {
    expect(frCreatedSinceBaseline(["a"], ["a", "b", "c"])).toEqual(["b", "c"]);
  });

  it("returns nothing when the window only deleted or kept objects", () => {
    expect(frCreatedSinceBaseline(["a", "b"], ["a"])).toEqual([]);
    expect(frCreatedSinceBaseline(["a"], ["a"])).toEqual([]);
    expect(frCreatedSinceBaseline([], [])).toEqual([]);
  });

  it("treats a create-then-rename as the same surviving object", () => {
    // Rename ends the history (clearsTotal catches the window first), but the
    // id is stable across it — this function must not double-report.
    expect(frCreatedSinceBaseline(["a"], ["a"])).toEqual([]);
  });

  it("tolerates a baseline captured before the field existed", () => {
    expect(frCreatedSinceBaseline(undefined, ["a"])).toEqual(["a"]);
    expect(frCreatedSinceBaseline(undefined, [])).toEqual([]);
  });
});

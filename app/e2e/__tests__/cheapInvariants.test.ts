//! FILENAME: app/e2e/__tests__/cheapInvariants.test.ts
// PURPOSE: Unit tier for the per-action invariants — including the detector
//          self-test each one owes.
//
// CONTEXT: `CHEAP_INVARIANTS` had no unit tier at all, which is the same gap
// that let the trace minimiser ship discarding its own answer and the bug
// ledger ship re-issuing ids. An invariant that cannot be shown to FIRE is
// indistinguishable from one that is switched off — and this file exists
// because exactly that happened at the snapshot level: `visibleDialogCount`
// has been captured after every action since the beginning and NOTHING has
// ever read it, so a full-screen modal sat over the ribbon for half a walk
// while the run reported PASS (BUG-0037).

import { describe, it, expect } from "vitest";
import { CHEAP_INVARIANTS, selectionInBounds, uiNotBlocked } from "../oracles/cheapInvariants";
import type { StateSnapshot } from "../invariants/stateSnapshot";

function snapshot(overrides: {
  selection?: StateSnapshot["logical"]["selection"];
  ribbonBlockedBy?: StateSnapshot["visual"]["ribbonBlockedBy"];
} = {}): StateSnapshot {
  return {
    logical: {
      slicers: [],
      charts: [],
      tables: [],
      pivots: [],
      timelines: [],
      sparklineGroups: [],
      selection: overrides.selection ?? {
        startRow: 0,
        startCol: 0,
        endRow: 0,
        endCol: 0,
      },
      activeSheet: 0,
      sheetCount: 1,
      isEditing: false,
    },
    visual: {
      ribbonTabs: [],
      visibleDialogCount: 0,
      nameBoxValue: "A1",
      formulaBarValue: "",
      ribbonBlockedBy: overrides.ribbonBlockedBy ?? null,
    },
    consoleErrors: [],
    jsExceptions: [],
    timestamp: 0,
  } as unknown as StateSnapshot;
}

describe("cheap invariants", () => {
  it("registers every invariant in CHEAP_INVARIANTS exactly once", () => {
    const ids = CHEAP_INVARIANTS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("selection-in-bounds");
    expect(ids).toContain("ui-not-blocked");
  });

  describe("selection-in-bounds", () => {
    it("is quiet on a well-formed selection", () => {
      expect(selectionInBounds.check(snapshot())).toEqual([]);
    });

    it("FIRES on an inverted selection", () => {
      const v = selectionInBounds.check(
        snapshot({ selection: { startRow: 5, startCol: 0, endRow: 1, endCol: 0 } })
      );
      expect(v).toHaveLength(1);
      expect(v[0].message).toContain("endRow < startRow");
    });
  });

  describe("ui-not-blocked", () => {
    it("is quiet when nothing covers the ribbon", () => {
      expect(uiNotBlocked.check(snapshot())).toEqual([]);
    });

    it("FIRES on the exact shape that shipped: a role-less full-screen modal", () => {
      // Verbatim from the live census of the failing walk. `role` is null and
      // the class is an emotion hash, which is why neither `visibleDialogCount`
      // nor any selector-based check could have caught it — but the hit test
      // does, and the message must NAME the thing so the next reader does not
      // have to re-derive it from a hash.
      const v = uiNotBlocked.check(
        snapshot({
          ribbonBlockedBy: {
            tag: "div",
            className: "css-1fr3uyz",
            role: null,
            zIndex: "1050",
            text: "Customize Home TabXCurrent GroupsClipboard",
          },
        })
      );
      expect(v).toHaveLength(1);
      expect(v[0].invariantId).toBe("ui-not-blocked");
      expect(v[0].message).toContain("Customize Home Tab");
      expect(v[0].message).toContain("1050");
      expect(v[0].details.blocker).toBeTruthy();
    });
  });
});

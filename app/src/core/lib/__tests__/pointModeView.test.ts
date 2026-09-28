//! FILENAME: app/src/core/lib/__tests__/pointModeView.test.ts
// PURPOSE: The one predicate that says "the grid shows a sheet the published
//          object regions do not belong to" (cross-sheet point mode), and its
//          edge-triggered signal.
// CONTEXT: Paint and hit sites read `getLiveGridRegions()`, which is empty while
//          this predicate holds, and DOM overlays hide on the signal. The typeof
//          guard is load-bearing: an ordinary edit has no source index, and
//          without the guard every edit would blank every overlay on the sheet.

import { describe, it, expect, afterEach, vi } from "vitest";

const grid = vi.hoisted(() => ({
  snapshot: null as null | {
    editing: { sourceSheetIndex?: number } | null;
    sheetContext: { activeSheetIndex: number };
  },
}));

vi.mock("../../state/GridContext", () => ({
  getGridStateSnapshot: () => grid.snapshot,
}));

import {
  isPointModeOnForeignSheet,
  onPointModeViewChanged,
  notifyPointModeViewChanged,
} from "../pointModeView";
import { setExternalSessionParked, __resetExternalEditForTests } from "../formulaEditTarget";
import { createFakeExternalEdit } from "./helpers/fakeExternalEdit";

function snapshot(active: number, sourceSheetIndex?: number | null): void {
  grid.snapshot = {
    editing: sourceSheetIndex === null ? null : { sourceSheetIndex },
    sheetContext: { activeSheetIndex: active },
  };
}

afterEach(() => {
  __resetExternalEditForTests();
  grid.snapshot = null;
});

describe("isPointModeOnForeignSheet", () => {
  it("is true while an external session is PARKED", () => {
    snapshot(0, null);
    const fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=" });
    fake.register();
    expect(isPointModeOnForeignSheet()).toBe(false);
    setExternalSessionParked(0);
    expect(isPointModeOnForeignSheet()).toBe(true);
  });

  it("is true for a Core edit whose source sheet is not the active one", () => {
    snapshot(1, 0);
    expect(isPointModeOnForeignSheet()).toBe(true);
  });

  it("is FALSE for an ordinary edit, which carries no source index", () => {
    snapshot(1, undefined);
    expect(isPointModeOnForeignSheet()).toBe(false);
  });

  it("is false for a Core edit on its own sheet, with no edit, and before the grid mounts", () => {
    snapshot(1, 1);
    expect(isPointModeOnForeignSheet()).toBe(false);
    snapshot(1, null);
    expect(isPointModeOnForeignSheet()).toBe(false);
    grid.snapshot = null;
    expect(isPointModeOnForeignSheet()).toBe(false);
  });
});

describe("onPointModeViewChanged", () => {
  it("fires only on FLIPS, with the new value -- from the store (parked) and from notify (Core edit)", () => {
    snapshot(0, null);
    const heard: boolean[] = [];
    const off = onPointModeViewChanged((foreign) => heard.push(foreign));

    // A session registers: the store notifies, nothing flipped.
    const fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=" });
    fake.register();
    expect(heard).toEqual([]);

    // Parked: the store's notify is the flip.
    setExternalSessionParked(0);
    expect(heard).toEqual([true]);
    // Another notify with nothing changed is not a flip.
    notifyPointModeViewChanged();
    expect(heard).toEqual([true]);

    // Back on the host.
    setExternalSessionParked(2);
    expect(heard).toEqual([true, false]);

    // A Core cross-sheet edit: the snapshot is current only after the render,
    // which is when Spreadsheet.tsx calls notify.
    snapshot(1, 0);
    expect(heard).toEqual([true, false]);
    notifyPointModeViewChanged();
    expect(heard).toEqual([true, false, true]);
    snapshot(0, 0);
    notifyPointModeViewChanged();
    expect(heard).toEqual([true, false, true, false]);
    off();
  });

  it("an unsubscribed listener hears nothing more", () => {
    snapshot(0, null);
    const heard: boolean[] = [];
    const off = onPointModeViewChanged((foreign) => heard.push(foreign));
    off();
    const fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=" });
    fake.register();
    setExternalSessionParked(0);
    expect(heard).toEqual([]);
  });
});

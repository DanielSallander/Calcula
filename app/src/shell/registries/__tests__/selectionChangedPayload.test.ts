//! FILENAME: app/src/shell/registries/__tests__/selectionChangedPayload.test.ts
// PURPOSE: Wave 2 — the SELECTION_CHANGED app-event payload (the shape
//          sandboxed scripts receive) carries sheetIndex and EVERY area of a
//          multi-area selection, which the emitter used to drop, while the
//          main-thread callback listeners keep receiving the ORIGINAL
//          Selection object untouched.

import { describe, it, expect, vi, afterEach } from "vitest";
import { ExtensionRegistry } from "../ExtensionRegistry";
import { AppEvents, onAppEvent } from "../../../api/events";
import type { Selection } from "../../../core/types";

interface SelectionChangedPayload {
  row: number;
  col: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  sheetIndex: number;
  areas: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>;
}

function captureNext(): { payloads: Array<SelectionChangedPayload | null>; cleanup: () => void } {
  const payloads: Array<SelectionChangedPayload | null> = [];
  const cleanup = onAppEvent<SelectionChangedPayload | null>(
    AppEvents.SELECTION_CHANGED,
    (detail) => payloads.push(detail),
  );
  return { payloads, cleanup };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("SELECTION_CHANGED payload (Wave 2)", () => {
  it("carries sheetIndex and normalized areas, additionalRanges included", () => {
    const { payloads, cleanup } = captureNext();
    cleanups.push(cleanup);
    const selection: Selection = {
      // Dragged up-and-left: anchor (5,2) AFTER the active cell (1,0).
      startRow: 5,
      startCol: 2,
      endRow: 1,
      endCol: 0,
      type: "cells",
      sheetIndex: 3,
      additionalRanges: [{ startRow: 9, startCol: 9, endRow: 7, endCol: 8 }],
    };
    ExtensionRegistry.notifySelectionChange(selection);
    expect(payloads).toHaveLength(1);
    const p = payloads[0]!;
    // Legacy fields are untouched (anchor raw, active cell in row/col).
    expect(p).toMatchObject({
      row: 1, col: 0, startRow: 5, startCol: 2, endRow: 1, endCol: 0,
    });
    // The Wave 2 additions.
    expect(p.sheetIndex).toBe(3);
    expect(p.areas).toEqual([
      { startRow: 1, startCol: 0, endRow: 5, endCol: 2 },
      { startRow: 7, startCol: 8, endRow: 9, endCol: 9 },
    ]);
  });

  it("falls back to sheet 0 when neither the selection nor the grid snapshot knows better", () => {
    const { payloads, cleanup } = captureNext();
    cleanups.push(cleanup);
    ExtensionRegistry.notifySelectionChange({
      startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells",
    });
    expect(payloads[0]!.sheetIndex).toBe(0);
    expect(payloads[0]!.areas).toEqual([{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }]);
  });

  it("a single-area selection has exactly one area", () => {
    const { payloads, cleanup } = captureNext();
    cleanups.push(cleanup);
    ExtensionRegistry.notifySelectionChange({
      startRow: 2, startCol: 1, endRow: 4, endCol: 3, type: "cells", sheetIndex: 0,
    });
    expect(payloads[0]!.areas).toHaveLength(1);
  });

  it("null selection still broadcasts null", () => {
    const { payloads, cleanup } = captureNext();
    cleanups.push(cleanup);
    ExtensionRegistry.notifySelectionChange(null);
    expect(payloads).toEqual([null]);
  });

  it("main-thread listeners still receive the ORIGINAL Selection object", () => {
    const cb = vi.fn();
    const unsub = ExtensionRegistry.onSelectionChange(cb);
    cleanups.push(unsub as () => void);
    const selection: Selection = {
      startRow: 0, startCol: 0, endRow: 1, endCol: 1, type: "cells",
    };
    ExtensionRegistry.notifySelectionChange(selection);
    expect(cb).toHaveBeenCalledTimes(1);
    // Identity, not just deep equality — extensions compare references.
    expect(cb.mock.calls[0][0]).toBe(selection);
  });
});

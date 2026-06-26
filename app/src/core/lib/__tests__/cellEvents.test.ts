//! FILENAME: app/src/core/lib/__tests__/cellEvents.test.ts
// PURPOSE: cellEvents payload normalization — CELL_VALUES_CHANGED carries
//          {changes,source} and CELLS_UPDATED now carries the same {changes}
//          (so subscribers can scope work); both fire from one debounced flush.

import { describe, it, expect } from "vitest";
import { cellEvents } from "../cellEvents";
import { onAppEvent, AppEvents } from "../events";

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe("cellEvents payload normalization", () => {
  it("emits CELL_VALUES_CHANGED {changes,source} and CELLS_UPDATED {changes} together", async () => {
    const cvc: Array<{ changes: unknown[]; source: string }> = [];
    const cu: Array<{ changes?: unknown[] } | undefined> = [];
    const off1 = onAppEvent<{ changes: unknown[]; source: string }>(AppEvents.CELL_VALUES_CHANGED, (d) => cvc.push(d));
    const off2 = onAppEvent<{ changes?: unknown[] }>(AppEvents.CELLS_UPDATED, (d) => cu.push(d));

    cellEvents.emit({ row: 2, col: 3, newValue: "x", formula: null }, "user");
    await nextFrame();
    off1();
    off2();

    expect(cvc).toHaveLength(1);
    expect(cvc[0]).toMatchObject({ source: "user", changes: [{ row: 2, col: 3, newValue: "x" }] });
    // CELLS_UPDATED now carries the same changes (was payload-less before).
    expect(cu.at(-1)).toMatchObject({ changes: [{ row: 2, col: 3, newValue: "x" }] });
  });

  it("emitBatch (fill path) carries source 'fill' and maps every change", async () => {
    const cvc: Array<{ changes: unknown[]; source: string }> = [];
    const off = onAppEvent<{ changes: unknown[]; source: string }>(AppEvents.CELL_VALUES_CHANGED, (d) => cvc.push(d));

    cellEvents.emitBatch(
      [{ row: 1, col: 1, newValue: "a", formula: null }, { row: 2, col: 1, newValue: "b", formula: null }],
      "fill",
    );
    await nextFrame();
    off();

    expect(cvc.at(-1)?.source).toBe("fill");
    expect(cvc.at(-1)?.changes).toHaveLength(2);
  });
});

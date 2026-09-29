//! FILENAME: app/extensions/BuiltIn/FormatPainter/__tests__/formatPainterFirstClick.test.ts
// PURPOSE: The FIRST click after the painter starts paints. Found live
//          2026-09-29 (e2e fixall-edit K3): after Ctrl+Shift+C the first click
//          on B2 painted nothing and a second click did. The painter skipped
//          its "first selection callback" believing the registry replays the
//          current selection on subscribe; it does not, so the skipped callback
//          was the user's click. The registry double below behaves like the
//          real one (ExtensionRegistry.onSelectionChange only adds a listener).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  listeners: new Set<(s: unknown) => void>(),
  setCellStyle: vi.fn(async (_r: number, _c: number, _s: number) => {}),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getCell: vi.fn(async () => ({ styleIndex: 7 })),
  setCellStyle: (r: number, c: number, s: number) => h.setCellStyle(r, c, s),
  beginUndoTransaction: vi.fn(async () => 1),
  commitUndoTransaction: vi.fn(async () => {}),
  cancelUndoTransaction: vi.fn(async () => {}),
  dispatchGridAction: vi.fn(),
  restoreFocusToGrid: vi.fn(),
  registerEditGuard: () => () => {},
  // eslint-disable-next-line @typescript-eslint/naming-convention -- the real export name
  ExtensionRegistry: {
    onSelectionChange: (cb: (s: unknown) => void) => {
      h.listeners.add(cb);
      return () => h.listeners.delete(cb);
    },
  },
}));
vi.mock("@api/dialogs", () => ({ alertAsync: vi.fn(async () => {}) }));

import { activateFormatPainter, deactivateFormatPainter } from "../formatPainterLogic";
import { isFormatPainterActive } from "../formatPainterState";

const A1 = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" as const };
const B2 = { startRow: 1, startCol: 1, endRow: 1, endCol: 1, type: "cells" as const };

/** A click on a cell: Core's selection moves, then the button comes up. */
async function clickCell(sel: typeof A1): Promise<void> {
  for (const l of [...h.listeners]) l(sel);
  window.dispatchEvent(new MouseEvent("mouseup"));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  h.listeners.clear();
  h.setCellStyle.mockClear();
});
afterEach(() => {
  deactivateFormatPainter();
  vi.restoreAllMocks();
});

describe("the Format Painter's first click", () => {
  it("paints B2 on the FIRST click after the painter starts, and single-use stops it", async () => {
    await activateFormatPainter(false, A1);
    expect(isFormatPainterActive()).toBe(true);
    await clickCell(B2);
    expect(h.setCellStyle, "the first click painted nothing").toHaveBeenCalledWith(1, 1, 7);
    expect(isFormatPainterActive(), "single-use painter stayed on").toBe(false);
  });

  it("a notification that restates the SOURCE range is not a target", async () => {
    await activateFormatPainter(false, A1);
    await clickCell(A1);
    expect(h.setCellStyle).not.toHaveBeenCalled();
    expect(isFormatPainterActive(), "a re-announced source selection consumed the painter").toBe(true);
    await clickCell(B2);
    expect(h.setCellStyle).toHaveBeenCalledWith(1, 1, 7);
  });
});

//! FILENAME: app/extensions/BuiltIn/FormatPainter/__tests__/formatPainterSelectionOwner.test.ts
// PURPOSE: Format Painter refuses -- one toast, nothing captured or painted --
//          while a selection owner holds the selection, and still turns OFF.
// CONTEXT: BUG-0185. Starting the painter captures the SOURCE format from
//          Core's selection, and painting writes to Core's selection: with a
//          floating grid's cell selected, both are a cell HIDDEN under the
//          floating grid. Every door (Ctrl+Shift+C, the ribbon, the Edit menu,
//          Format Painter Lock) reaches `activateFormatPainter`, so that is
//          where it refuses. TEST owner (@api/selectionOwner).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  getCell: vi.fn(),
  setCellStyle: vi.fn(),
  begin: vi.fn(),
  commit: vi.fn(),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getCell: (...a: unknown[]) => h.getCell(...a),
  setCellStyle: (...a: unknown[]) => h.setCellStyle(...a),
  beginUndoTransaction: (...a: unknown[]) => h.begin(...a),
  commitUndoTransaction: (...a: unknown[]) => h.commit(...a),
  cancelUndoTransaction: vi.fn(),
  dispatchGridAction: vi.fn(),
  restoreFocusToGrid: vi.fn(),
  registerEditGuard: () => () => {},
  ExtensionRegistry: { onSelectionChange: () => () => {} },
}));
vi.mock("@api/dialogs", () => ({ alertAsync: vi.fn() }));

import { activateFormatPainter, applyFormatToTarget, deactivateFormatPainter } from "../formatPainterLogic";
import { isFormatPainterActive } from "../formatPainterState";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

const SOURCE = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" as const };
const TARGET = { startRow: 4, startCol: 4, endRow: 5, endCol: 5, type: "cells" as const };
const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};

beforeEach(() => {
  h.getCell.mockReset();
  h.getCell.mockResolvedValue({ styleIndex: 3 });
  h.setCellStyle.mockReset();
  h.setCellStyle.mockResolvedValue(undefined);
  h.begin.mockReset();
  h.commit.mockReset();
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
});

afterEach(() => {
  release();
  deactivateFormatPainter();
});

describe("Format Painter while a selection owner holds the selection", () => {
  it("starting it captures NOTHING from Core's hidden selection; one toast", async () => {
    owns = true;
    await activateFormatPainter(false, SOURCE);
    expect(h.getCell, "the painter captured the hidden cell's format").not.toHaveBeenCalled();
    expect(isFormatPainterActive()).toBe(false);
    expect(toasts.length).toBe(1);
  });

  it("a painter already running paints NOTHING onto a selection that is not Core's", async () => {
    await activateFormatPainter(true, SOURCE);
    expect(isFormatPainterActive()).toBe(true);
    owns = true;
    await applyFormatToTarget(TARGET);
    expect(h.setCellStyle, "the painter wrote to Core's hidden selection").not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
    expect(toasts.length).toBe(1);
  });

  it("it can still be turned OFF (the same door toggles it)", async () => {
    await activateFormatPainter(true, SOURCE);
    owns = true;
    await activateFormatPainter(true, SOURCE);
    expect(isFormatPainterActive()).toBe(false);
    expect(toasts).toEqual([]);
  });
});

describe("positive controls: nothing owns the selection", () => {
  it("starts, and paints the target", async () => {
    await activateFormatPainter(false, SOURCE);
    expect(h.getCell).toHaveBeenCalled();
    expect(isFormatPainterActive()).toBe(true);
    await applyFormatToTarget(TARGET);
    expect(h.setCellStyle).toHaveBeenCalledTimes(4);
    expect(toasts).toEqual([]);
  });
});

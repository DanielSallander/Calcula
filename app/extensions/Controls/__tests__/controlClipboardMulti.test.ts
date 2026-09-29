//! FILENAME: app/extensions/Controls/__tests__/controlClipboardMulti.test.ts
// PURPOSE: Copy / Paste / Duplicate act on EVERY selected control -- the keys
//          hand over the whole selection (lib/controlKeys.ts) -- and a paste
//          or duplicate of several is ONE undo step. Plus the paste cascade:
//          each paste lands one step further, 20 / 40 / 60 px.
// CONTEXT: Wave A review: once Ctrl+C / Ctrl+D reached Controls, they acted on
//          `selectedIds()[0]` only; with three shapes selected, Ctrl+D made one
//          copy and silently left two. While proving the paste path, the
//          cascade turned out to compound: a paste repositioned the CLIPBOARD's
//          own metadata in place, so the next paste started from the previous
//          copy -- 20, 60, 120 px instead of 20, 40, 60.
//
//          W25: a copy puts Controls' snapshots on the feature-neutral OBJECT
//          clipboard (@api/objectClipboard) and a paste pastes THAT clipboard
//          through each family's provider -- Controls' is registered here with
//          its real clipboard halves (snapshotControls / pasteControlSnapshots),
//          as the extension's activate() does.

import { describe, it, expect, beforeEach, vi } from "vitest";

const log: string[] = [];
const setControlMetadata = vi.fn();
const addFloatingControl = vi.fn();
const selectFloatingControl = vi.fn();
const getAllControls = vi.fn();
const getControlMetadata = vi.fn();

vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));
vi.mock("../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: vi.fn(async (label: string) => {
    log.push(`begin:${label}`);
  }),
  commitUndoTransaction: vi.fn(async () => {
    log.push("commit");
  }),
}));
vi.mock("../lib/controlApi", () => ({
  setControlMetadata: (...args: unknown[]) => setControlMetadata(...args),
  getControlMetadata: (...args: unknown[]) => getControlMetadata(...args),
  getAllControls: (...args: unknown[]) => getAllControls(...args),
}));
const CONTROLS: Record<string, { row: number; x: number; y: number }> = {
  "ctrl-1": { row: 1, x: 10, y: 10 },
  "ctrl-2": { row: 2, x: 100, y: 10 },
  "ctrl-3": { row: 3, x: 200, y: 10 },
};
vi.mock("../lib/floatingStore", () => ({
  getFloatingControl: (id: string) => {
    const c = CONTROLS[id];
    return c ? { id, sheetIndex: 0, row: c.row, col: 1, x: c.x, y: c.y, width: 80, height: 24 } : null;
  },
  addFloatingControl: (...args: unknown[]) => addFloatingControl(...args),
  makeFloatingControlId: (s: number, r: number, c: number) => `floating-${s}-${r}-${c}`,
  syncFloatingControlRegions: vi.fn(),
}));
vi.mock("../Button/floatingSelection", () => ({
  selectFloatingControl: (...args: unknown[]) => selectFloatingControl(...args),
}));
vi.mock("../Button/floatingRenderer", () => ({ invalidateFloatingButtonCache: vi.fn() }));
vi.mock("../Shape/shapeRenderer", () => ({ invalidateShapeCache: vi.fn() }));
vi.mock("../Image/imageRenderer", () => ({ invalidateImageCache: vi.fn() }));
vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAppEvent: vi.fn(),
}));

import {
  copyControl,
  copyControls,
  duplicateControls,
  pasteControl,
  pasteControlSnapshots,
  snapshotControls,
} from "../lib/controlClipboard";
import { registerControlObjectSelection } from "../lib/controlObjectSelection";
import { resetObjectSelectionProviders } from "@api/objectSelection";
import { resetObjectClipboard } from "@api/objectClipboard";

/** The metadata `get_control_metadata` answers for the control at `row`. */
function metadataFor(row: number) {
  const c = Object.values(CONTROLS).find((k) => k.row === row)!;
  return {
    controlType: "shape",
    properties: {
      x: { valueType: "static", value: String(c.x) },
      y: { valueType: "static", value: String(c.y) },
    },
  };
}

/** The x each backend write placed a copy at, in order. */
function writtenX(): number[] {
  return setControlMetadata.mock.calls.map((call) => Number((call[3] as { properties: { x: { value: string } } }).properties.x.value));
}

let nextRow = 100;

beforeEach(() => {
  log.length = 0;
  nextRow = 100;
  setControlMetadata.mockReset().mockImplementation(async () => {
    log.push("write");
  });
  addFloatingControl.mockReset();
  selectFloatingControl.mockReset();
  // Every write claims a fresh anchor row, so each copy is a new control.
  getAllControls.mockReset().mockImplementation(async () => {
    const taken = [];
    for (let r = 0; r < nextRow; r++) taken.push({ row: r, col: 0 });
    nextRow++;
    return taken;
  });
  getControlMetadata.mockReset().mockImplementation(async (_s: number, row: number) => metadataFor(row));
  resetObjectClipboard();
  resetObjectSelectionProviders();
  registerControlObjectSelection({ copyControls: snapshotControls, pasteControls: pasteControlSnapshots });
});

describe("Duplicate of several controls", () => {
  it("duplicates EVERY one, as ONE undo step, and the copies become the selection", async () => {
    await duplicateControls(["ctrl-1", "ctrl-2", "ctrl-3"]);

    expect(writtenX(), "not every selected control was duplicated").toEqual([30, 120, 220]);
    expect(addFloatingControl).toHaveBeenCalledTimes(3);
    // One transaction around the three creations (each records "Add control").
    expect(log[0]).toBe("begin:Duplicate Controls");
    expect(log.filter((l) => l === "write").length).toBe(3);
    expect(log[log.length - 1]).toBe("commit");
    // The first copy replaces the selection, the others join it.
    expect(selectFloatingControl.mock.calls.map((c) => c[1])).toEqual([false, true, true]);
  });

  it("control: ONE control needs no transaction (its own write is one undo step)", async () => {
    await duplicateControls(["ctrl-2"]);
    expect(writtenX()).toEqual([120]);
    expect(log).toEqual(["write"]);
  });
});

describe("Copy + Paste of several controls", () => {
  it("copies EVERY one, and a paste creates them all as ONE undo step", async () => {
    await copyControls(["ctrl-1", "ctrl-3"]);
    await pasteControl(0);
    expect(writtenX(), "the paste did not create every copied control").toEqual([30, 220]);
    // The object clipboard's one step (it may hold other families' objects too).
    expect(log[0]).toBe("begin:Paste Objects");
    expect(log[log.length - 1]).toBe("commit");
  });
});

describe("the paste cascade", () => {
  it("each paste lands one more step away from the ORIGINAL: 20, 40, 60 px", async () => {
    await copyControl("ctrl-1");
    await pasteControl(0);
    await pasteControl(0);
    await pasteControl(0);
    expect(writtenX(), "the paste repositioned the clipboard's own copy, so the cascade compounded").toEqual([
      30, 50, 70,
    ]);
  });
});

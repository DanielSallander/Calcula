//! FILENAME: app/extensions/Controls/__tests__/buttonIdBinding.test.ts
// PURPOSE: The id a caller gets back from the button seam and the id a run-mode
//          CLICK carries are the same string, from the same derivation.
// CONTEXT: A macro button is two records that must agree: the on-grid control,
//          and the object script bound to `instanceId`. If the seam's handle and
//          the click's `regionId` can ever differ, the script mounts against a
//          key nothing will ever emit — a button that exists, a script that
//          exists, and a click that does nothing. That is indistinguishable
//          from every other flavour of "nothing happens", so it is pinned here
//          rather than reasoned about.
//
//          Both sides go through `makeFloatingControlId`. This test pins the
//          behaviour (the region carries exactly that id) and the source
//          property that keeps it true (nothing re-spells the format by hand).

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

const captured: { regions: Array<Record<string, unknown>> } = { regions: [] };

vi.mock("@api/gridOverlays", () => ({
  replaceGridRegionsByType: (_type: string, regions: Array<Record<string, unknown>>) => {
    captured.regions = regions;
  },
  removeGridRegionsByType: () => undefined,
}));

vi.mock("../lib/designMode", () => ({ getDesignMode: () => false }));

import {
  addFloatingControl,
  getAllFloatingControls,
  makeFloatingControlId,
  removeFloatingControl,
  syncFloatingControlRegions,
} from "../lib/floatingStore";

beforeEach(() => {
  for (const ctrl of getAllFloatingControls()) removeFloatingControl(ctrl.id);
  captured.regions = [];
});

describe("the seam handle and the click's region id are the same string", () => {
  it("the overlay region carries exactly makeFloatingControlId(sheet, row, col)", () => {
    // What the seam returns to a caller (Macro Recorder's saveAsButtonScript
    // takes `handle.instanceId` from here and binds the object script to it).
    const handleId = makeFloatingControlId(2, 7, 3);

    addFloatingControl({
      id: handleId,
      sheetIndex: 2,
      row: 7,
      col: 3,
      x: 10,
      y: 20,
      width: 80,
      height: 28,
      controlType: "button",
    });
    syncFloatingControlRegions();

    expect(captured.regions).toHaveLength(1);
    // What a run-mode click emits as `detail.regionId`, which the script host
    // matches against the mounted script's `instanceId`.
    expect(captured.regions[0].id).toBe(handleId);
    expect(captured.regions[0].data).toMatchObject({
      sheetIndex: 2,
      row: 7,
      col: 3,
      controlType: "button",
    });
  });

  it("the anchor in the region round-trips back to the same id", () => {
    const handleId = makeFloatingControlId(0, 0, 0);
    addFloatingControl({
      id: handleId,
      sheetIndex: 0,
      row: 0,
      col: 0,
      x: 0,
      y: 0,
      width: 80,
      height: 28,
      controlType: "button",
    });
    syncFloatingControlRegions();

    const data = captured.regions[0].data as {
      sheetIndex: number;
      row: number;
      col: number;
    };
    // The click handler looks the control metadata up by (sheet, row, col) and
    // the script host matches by id: both must name the same control.
    expect(makeFloatingControlId(data.sheetIndex, data.row, data.col)).toBe(handleId);
  });

  it("nothing outside makeFloatingControlId spells the id format by hand", () => {
    // A second spelling is how a handle and a region drift apart. Neither the
    // Controls entry point nor the store may build the string itself.
    const files = ["index.ts", "lib/floatingStore.ts"];
    for (const rel of files) {
      const src = fs.readFileSync(
        path.resolve(__dirname, "..", rel),
        "utf8",
      );
      const handRolled = [...src.matchAll(/`control-\$\{/g)];
      const inDeriver = rel === "lib/floatingStore.ts" ? 1 : 0;
      expect(
        handRolled.length,
        `${rel} builds a control id by hand; use makeFloatingControlId()`,
      ).toBe(inDeriver);
    }
  });
});

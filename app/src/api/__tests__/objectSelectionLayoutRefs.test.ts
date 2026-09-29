//! FILENAME: app/src/api/__tests__/objectSelectionLayoutRefs.test.ts
// PURPOSE: The layout-ref source of @api/objectSelection -- which ids a
//          sheet's saved layout still NAMES (a canvas's locked / zOrder refs,
//          live or dead), asked by a family that recycles ids (Controls'
//          anchor allocator) so a new object never inherits a dead one's lock
//          or paint slot (wave C review of W25).

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  idsNamedByLayout,
  registerLayoutRefSource,
  resetObjectSelectionProviders,
} from "../objectSelection";
import { canvasObjectRef } from "../canvasSheet";

afterEach(() => {
  resetObjectSelectionProviders();
});

describe("idsNamedByLayout", () => {
  it("answers the ids of ONE kind the sheet's layout names, for that sheet only", () => {
    registerLayoutRefSource((sheet) =>
      sheet === 2
        ? [canvasObjectRef("control", "0:4"), canvasObjectRef("chart", "0:9"), canvasObjectRef("control", "3:1")]
        : [],
    );
    expect(idsNamedByLayout(2, "control"), "another kind's ids were counted as controls'").toEqual(["0:4", "3:1"]);
    expect(idsNamedByLayout(2, "chart")).toEqual(["0:9"]);
    expect(idsNamedByLayout(0, "control")).toEqual([]);
  });

  it("is empty with no source, and when the source throws (logged, never raised)", () => {
    expect(idsNamedByLayout(0, "control")).toEqual([]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    registerLayoutRefSource(() => {
      throw new Error("boom");
    });
    expect(idsNamedByLayout(0, "control")).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a stale cleanup does not remove a newer source; the reset hook forgets it", () => {
    const first = registerLayoutRefSource(() => [canvasObjectRef("control", "0:1")]);
    registerLayoutRefSource(() => [canvasObjectRef("control", "0:2")]);
    first();
    expect(idsNamedByLayout(0, "control")).toEqual(["0:2"]);
    resetObjectSelectionProviders();
    expect(idsNamedByLayout(0, "control")).toEqual([]);
  });
});

//! FILENAME: app/extensions/BuiltIn/ObjectPosition/__tests__/sizePosition.test.ts
// PURPOSE: The pure half of Size and Position (lib/sizePosition.ts): which
//          ONE geometry change the dialog's boxes ask for -- blank boxes keep
//          the current value, a changed size is at least 16, an unchanged one
//          is never touched, x/y never go below 0, a canvas page caps the size
//          and keeps the object on it (no snap, plan decision D7), a family
//          that cannot resize keeps its size, and nothing changed asks for
//          nothing.

import { describe, it, expect } from "vitest";
import type { GridRegion } from "@api/gridOverlays";
import { changedFields, initialFields, sizePositionChange, type SizePositionFields } from "../lib/sizePosition";

function region(rect: { x: number; y: number; width: number; height: number }): GridRegion {
  return { id: "slicer-1", type: "slicer", startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { ...rect } };
}

const AT = region({ x: 64, y: 32, width: 200, height: 100 });
const KEEP: SizePositionFields = { x: null, y: null, width: null, height: null };
const PAGE = { width: 1280, height: 720 };

function rect(c: ReturnType<typeof sizePositionChange>) {
  return c ? { x: c.x, y: c.y, width: c.width, height: c.height } : null;
}

describe("initialFields / changedFields", () => {
  it("the boxes start at the object's rectangle; a cell-anchored region gives blanks", () => {
    expect(initialFields(AT)).toEqual({ x: 64, y: 32, width: 200, height: 100 });
    expect(initialFields({ ...AT, floating: undefined })).toEqual(KEEP);
  });

  it("only the boxes the user changed are passed on", () => {
    const initial = initialFields(AT);
    expect(changedFields(initial, { ...initial, x: 480 })).toEqual({ x: 480, y: null, width: null, height: null });
    expect(changedFields(initial, initial)).toEqual(KEEP);
    expect(changedFields(initial, { ...initial, height: null })).toEqual({ x: null, y: null, width: null, height: null });
  });
});

describe("sizePositionChange", () => {
  it("nothing changed asks for nothing", () => {
    expect(sizePositionChange(AT, KEEP, null, { resize: true })).toBeNull();
    expect(sizePositionChange(AT, { x: 64, y: 32, width: 200, height: 100 }, null, { resize: true })).toBeNull();
    expect(sizePositionChange({ ...AT, floating: undefined }, { x: 1, y: 1, width: 1, height: 1 }, null, { resize: true })).toBeNull();
  });

  it("all four on a worksheet: exactly what was typed, from where it was", () => {
    const c = sizePositionChange(AT, { x: 480, y: 256, width: 320, height: 240 }, null, { resize: true });
    expect(rect(c)).toEqual({ x: 480, y: 256, width: 320, height: 240 });
    expect(c!.region).toBe(AT);
    expect(c!.from).toEqual({ x: 64, y: 32, width: 200, height: 100 });
  });

  it("no snap: 101 stays 101 on a snapping canvas", () => {
    expect(rect(sizePositionChange(AT, { ...KEEP, x: 101, y: 37 }, PAGE, { resize: true }))).toEqual({
      x: 101,
      y: 37,
      width: 200,
      height: 100,
    });
  });

  it("blank / non-finite boxes keep the current value", () => {
    expect(rect(sizePositionChange(AT, { x: 480, y: null, width: Number.NaN, height: null }, null, { resize: true }))).toEqual({
      x: 480,
      y: 32,
      width: 200,
      height: 100,
    });
  });

  it("a CHANGED size is at least 16; an unchanged smaller one is kept when only the position moves", () => {
    expect(rect(sizePositionChange(AT, { ...KEEP, width: 3, height: 0 }, null, { resize: true }))).toEqual({
      x: 64,
      y: 32,
      width: 16,
      height: 16,
    });
    const tiny = region({ x: 10, y: 10, width: 8, height: 8 });
    expect(rect(sizePositionChange(tiny, { ...KEEP, x: 40 }, null, { resize: true }))).toEqual({ x: 40, y: 10, width: 8, height: 8 });
  });

  it("x and y never go below 0", () => {
    expect(rect(sizePositionChange(AT, { ...KEEP, x: -50, y: -1 }, null, { resize: true }))).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });

  it("on a canvas page the object is KEPT on it: the origin clamps, the size is capped to the page", () => {
    expect(rect(sizePositionChange(AT, { ...KEEP, x: 1200, y: 700 }, PAGE, { resize: true }))).toEqual({
      x: 1080,
      y: 620,
      width: 200,
      height: 100,
    });
    expect(rect(sizePositionChange(AT, { ...KEEP, width: 5000, height: 900 }, PAGE, { resize: true }))).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    });
    // A worksheet has no page: the same request is taken as typed.
    expect(rect(sizePositionChange(AT, { ...KEEP, x: 1200, y: 700 }, null, { resize: true }))).toEqual({
      x: 1200,
      y: 700,
      width: 200,
      height: 100,
    });
  });

  it("a family that cannot resize (a floating grid) keeps its size whatever the boxes say", () => {
    expect(rect(sizePositionChange(AT, { x: 480, y: 256, width: 999, height: 999 }, null, { resize: false }))).toEqual({
      x: 480,
      y: 256,
      width: 200,
      height: 100,
    });
    expect(sizePositionChange(AT, { ...KEEP, width: 999 }, null, { resize: false })).toBeNull();
  });
});

//! FILENAME: app/src/api/__tests__/canvasObjectRefs.test.ts
// PURPOSE: The canvas object-ref vocabulary (@api/canvasSheet): THE list of
//          kinds, and the key a ref is looked up by.
// CONTEXT: These strings are PERSISTED -- a canvas layout's zOrder / locked
//          lists hold `{ kind, id }` refs and travel in .cala files and
//          published .calp applications. A renamed kind silently orphans every
//          saved ref (the object falls out of the saved order and jumps to the
//          top), so the list is pinned here exactly.

import { describe, it, expect } from "vitest";
import { CANVAS_OBJECT_KINDS, canvasObjectRef, canvasObjectRefKey } from "../canvasSheet";

describe("canvas object refs", () => {
  it("the kinds, exactly (persisted in every canvas layout)", () => {
    expect([...CANVAS_OBJECT_KINDS]).toEqual(["chart", "slicer", "timelineSlicer", "floatingRange", "pivot", "control"]);
    expect(new Set(CANVAS_OBJECT_KINDS).size).toBe(CANVAS_OBJECT_KINDS.length);
  });

  it("builds a ref and keys it as kind:id (a control id keeps its own colon)", () => {
    expect(canvasObjectRef("chart", "7")).toEqual({ kind: "chart", id: "7" });
    expect(canvasObjectRefKey(canvasObjectRef("control", "3:4"))).toBe("control:3:4");
    expect(canvasObjectRefKey({ kind: "slicer", id: "3:4" })).not.toBe(canvasObjectRefKey({ kind: "control", id: "3:4" }));
  });
});

// FILENAME: app/extensions/ModelEditor/__tests__/diagramPositions.test.ts
// PURPOSE: The remembered Free-mode arrangement must survive a round trip, and
//          must never hand the diagram something it cannot draw.
// CONTEXT: EVERY READ PATH RETURNS null RATHER THAN THROWING. This is a
//          cosmetic preference read during render; a diagram that refuses to
//          render because localStorage was unavailable, or held an older shape,
//          would be a far worse bug than one that forgets a layout. The tests
//          therefore assert the SHAPE of the failure, not just the happy path.
//
//          The pruning matters for a subtler reason: a stored position for a
//          table the model no longer has would sit in the file forever, and a
//          same-named table in a DIFFERENT model would inherit a position from
//          a layout nobody drew.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDiagramPositions,
  loadDiagramPositions,
  saveDiagramPositions,
} from "../lib/diagramPositions";

const TABLES = ["Sales", "Dim"];

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the remembered diagram arrangement", () => {
  it("round-trips what the user dragged", () => {
    saveDiagramPositions("conn-1", { Sales: { x: 10, y: 20 }, Dim: { x: 30, y: 40 } });
    expect(loadDiagramPositions("conn-1", TABLES)).toEqual({
      Sales: { x: 10, y: 20 },
      Dim: { x: 30, y: 40 },
    });
  });

  it("is scoped to the connection", () => {
    // Two models open in turn must not inherit each other's arrangement.
    saveDiagramPositions("conn-1", { Sales: { x: 10, y: 20 } });
    expect(loadDiagramPositions("conn-2", TABLES)).toBeNull();
  });

  it("prunes a table the model no longer has", () => {
    saveDiagramPositions("conn-1", { Sales: { x: 1, y: 2 }, Gone: { x: 3, y: 4 } });
    expect(loadDiagramPositions("conn-1", ["Sales"])).toEqual({ Sales: { x: 1, y: 2 } });
  });

  it("returns null when nothing survives the prune", () => {
    // Not an empty object: the caller uses null to mean "seed from the computed
    // layout", and an empty object would seed from nothing.
    saveDiagramPositions("conn-1", { Gone: { x: 3, y: 4 } });
    expect(loadDiagramPositions("conn-1", ["Sales"])).toBeNull();
  });

  it("refuses a coordinate that is not a NUMBER", () => {
    localStorage.setItem(
      "calcula.modelEditor.diagramPositions.conn-1",
      JSON.stringify({ Sales: { x: 1, y: 2 }, Dim: { x: "3", y: 4 }, Bad: { x: null, y: 0 } }),
    );
    expect(loadDiagramPositions("conn-1", ["Sales", "Dim", "Bad"])).toEqual({
      Sales: { x: 1, y: 2 },
    });
  });

  it("refuses a coordinate that is a number but not FINITE", () => {
    // A separate test because a separate check catches it, and the obvious
    // fixture does not reach that check: JSON cannot represent NaN or Infinity
    // as literals, so `JSON.stringify({x: NaN})` writes `null` and is caught by
    // the typeof test instead. The real path in is an overflowing NUMERIC
    // literal — `1e999` parses to Infinity — which is exactly what a corrupted
    // or hand-edited entry looks like.
    //
    // It matters because the value does not just misplace one node: the canvas
    // is sized from the extent of every position, so one Infinity makes the
    // whole SVG unrenderable.
    localStorage.setItem(
      "calcula.modelEditor.diagramPositions.conn-1",
      '{"Sales":{"x":1,"y":2},"Dim":{"x":1e999,"y":4}}',
    );
    expect(Number.isFinite(JSON.parse('{"x":1e999}').x), "the fixture really does parse to Infinity").toBe(
      false,
    );
    expect(loadDiagramPositions("conn-1", ["Sales", "Dim"])).toEqual({ Sales: { x: 1, y: 2 } });
  });

  it("survives a value that is not JSON at all", () => {
    localStorage.setItem("calcula.modelEditor.diagramPositions.conn-1", "{not json");
    expect(loadDiagramPositions("conn-1", TABLES)).toBeNull();
  });

  it("survives a value of the wrong SHAPE", () => {
    for (const junk of ["[]", '"a string"', "42", "null"]) {
      localStorage.setItem("calcula.modelEditor.diagramPositions.conn-1", junk);
      expect(loadDiagramPositions("conn-1", TABLES), junk).toBeNull();
    }
  });

  it("survives localStorage being unavailable, on read AND on write", () => {
    // A private window, or a browser set to block site data. The diagram must
    // still render; it just forgets.
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadDiagramPositions("conn-1", TABLES)).toBeNull();
    expect(() => saveDiagramPositions("conn-1", { Sales: { x: 1, y: 2 } })).not.toThrow();
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it("clears, and saving nothing clears too", () => {
    saveDiagramPositions("conn-1", { Sales: { x: 1, y: 2 } });
    clearDiagramPositions("conn-1");
    expect(loadDiagramPositions("conn-1", TABLES)).toBeNull();

    saveDiagramPositions("conn-1", { Sales: { x: 1, y: 2 } });
    saveDiagramPositions("conn-1", {});
    expect(
      localStorage.getItem("calcula.modelEditor.diagramPositions.conn-1"),
      "an empty arrangement removes the key rather than storing {}",
    ).toBeNull();
  });
});

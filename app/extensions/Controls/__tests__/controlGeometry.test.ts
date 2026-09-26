//! FILENAME: app/extensions/Controls/__tests__/controlGeometry.test.ts
// PURPOSE: Controls' geometry persistence (M8 part C): ONE
//          `set_control_geometry` batch per gesture -- never the old four to six
//          `set_control_property` calls per control -- for the canvas's arrange
//          seam AND for the extension's own drag / resize; a pinned control's
//          offsets travel in the batch; and a refused (atomic) batch puts every
//          control back where it was before the commit rejects.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const setControlGeometry = vi.fn(async (..._a: unknown[]) => 0);
const setControlProperty = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../lib/controlApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/controlApi")>()),
  setControlGeometry: (...a: unknown[]) => setControlGeometry(...a),
  setControlProperty: (...a: unknown[]) => setControlProperty(...a),
}));

import { controlGeometryChangesOf, createControlGeometryProvider } from "../lib/controlGeometry";
import {
  addFloatingControl,
  getFloatingControl,
  resetFloatingStore,
  type FloatingControl,
} from "../lib/floatingStore";
import type { GridRegion } from "@api/gridOverlays";
import type { ObjectGeometryChange } from "@api/objectGeometry";

function control(row: number, over: Partial<FloatingControl> = {}): FloatingControl {
  return {
    id: `control-0-${row}-0`,
    sheetIndex: 0,
    row,
    col: 0,
    x: 10,
    y: 10 + row * 100,
    width: 80,
    height: 30,
    controlType: "shape",
    ...over,
  } as FloatingControl;
}

function regionOf(c: FloatingControl): GridRegion {
  return {
    id: c.id,
    type: "floating-control",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: c.x, y: c.y, width: c.width, height: c.height },
    data: { sheetIndex: 0, row: c.row, col: 0, controlType: c.controlType },
  };
}

const deps = {
  cellOrigin: (row: number) => ({ x: 0, y: row * 20 }),
  invalidate: vi.fn(),
  refresh: vi.fn(),
  afterPersist: vi.fn(),
};

beforeEach(() => {
  resetFloatingStore();
  setControlGeometry.mockReset();
  setControlGeometry.mockResolvedValue(3);
  setControlProperty.mockClear();
  deps.invalidate.mockClear();
  deps.afterPersist.mockClear();
});

describe("the geometry provider", () => {
  it("three controls moved by an arrange: ONE setControlGeometry call, no per-property writes", async () => {
    const cs = [control(1), control(2), control(3, { pinToGrid: true })];
    for (const c of cs) addFloatingControl({ ...c });
    const changes: ObjectGeometryChange[] = cs.map((c) => ({
      region: regionOf(c),
      x: 200,
      y: c.y,
      width: c.width,
      height: c.height,
    }));

    await createControlGeometryProvider(deps).commit(changes);

    expect(setControlGeometry).toHaveBeenCalledTimes(1);
    expect(setControlProperty).not.toHaveBeenCalled();
    const batch = setControlGeometry.mock.calls[0][0] as Array<Record<string, number>>;
    expect(batch.map((b) => [b.row, b.x])).toEqual([
      [1, 200],
      [2, 200],
      [3, 200],
    ]);
    // A pinned control carries BOTH offsets, re-derived from its anchor
    // (anchor origin (0, 60): offset (200, 250)); an unpinned one neither.
    expect(batch[2]).toMatchObject({ offsetX: 200, offsetY: 310 - 60 });
    expect("offsetX" in batch[0]).toBe(false);
    expect(deps.afterPersist).toHaveBeenCalledWith([cs[0].id, cs[1].id, cs[2].id]);
  });

  it("a REFUSED (atomic) batch puts every control back where it was, then rejects", async () => {
    const cs = [control(1), control(2)];
    for (const c of cs) addFloatingControl({ ...c });
    setControlGeometry.mockRejectedValue(new Error("The sheet is protected."));
    const provider = createControlGeometryProvider(deps);
    await expect(
      provider.commit(cs.map((c) => ({ region: regionOf(c), x: 500, y: 5, width: 80, height: 30, from: { x: c.x, y: c.y, width: 80, height: 30 } }))),
    ).rejects.toThrow("The sheet is protected.");
    expect(getFloatingControl(cs[0].id)).toMatchObject({ x: 10, y: 110 });
    expect(getFloatingControl(cs[1].id)).toMatchObject({ x: 10, y: 210 });
    expect(deps.afterPersist).not.toHaveBeenCalled();
  });

  it("preview moves the store and writes nothing", () => {
    const c = control(1);
    addFloatingControl({ ...c });
    createControlGeometryProvider(deps).preview!([{ region: regionOf(c), x: 42, y: 43, width: 80, height: 30 }]);
    expect(getFloatingControl(c.id)).toMatchObject({ x: 42, y: 43 });
    expect(setControlGeometry).not.toHaveBeenCalled();
  });

  it("controlGeometryChangesOf skips unknown ids and duplicates", () => {
    addFloatingControl({ ...control(1) });
    expect(controlGeometryChangesOf(["control-0-1-0", "nope", "control-0-1-0"])).toHaveLength(1);
  });
});

describe("the extension's own drag / resize persist ONE batch per gesture (source wiring)", () => {
  const src = readFileSync(path.resolve(__dirname, "../index.ts"), "utf8");

  function handler(name: string): string {
    const at = src.indexOf(`const ${name} = (e: Event) => {`);
    expect(at).toBeGreaterThan(0);
    return src.slice(at, src.indexOf("\n  };\n", at));
  }

  it("moveComplete: one persistFloatingGeometry call for the dragged control and every co-mover", () => {
    const body = handler("handleMoveComplete");
    expect(body.match(/persistFloatingGeometry\(/g)).toHaveLength(1);
    expect(body).toContain("persistFloatingGeometry([controlId, ...");
  });

  it("resizeComplete: one persistFloatingGeometry call for the control and its group", () => {
    const body = handler("handleResizeComplete");
    expect(body.match(/persistFloatingGeometry\(/g)).toHaveLength(1);
    expect(body).toContain("persistFloatingGeometry([controlId, ...resizedIds])");
  });

  it("the persist is ONE set_control_geometry call, joined to an open undo transaction, and no per-property geometry write remains", () => {
    const at = src.indexOf("async function persistFloatingGeometry(");
    const body = src.slice(at, src.indexOf("\n}\n", at));
    expect(body).toContain("joinUndoTransaction(() => setControlGeometry(changes))");
    // Neither the persist nor the gesture handlers write one property at a
    // time any more (creation paths still seed a NEW control's properties).
    for (const text of [body, handler("handleMoveComplete"), handler("handleResizeComplete")]) {
      expect(text).not.toContain("setControlProperty");
    }
    expect(src).not.toContain("persistFloatingPosition(");
  });
});

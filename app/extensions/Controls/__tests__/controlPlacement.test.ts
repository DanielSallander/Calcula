//! FILENAME: app/extensions/Controls/__tests__/controlPlacement.test.ts
// PURPOSE: Free-positioned controls through the three create seams — a shape,
//          a button and a picture asked for at an exact x/y land at exactly
//          x/y, unpinned, and a request with NO anchor gets one the provider
//          allocates, which never collides with another control on the sheet,
//          not even when two inserts are in flight at once. And the historical
//          anchored path (anchor given, no x/y) is unchanged.
// CONTEXT: The anchor is the control's IDENTITY — the backend keys metadata by
//          cell, and `set_control_metadata` REPLACES whatever an occupied cell
//          holds (buttons and pictures by design). So a collision is not a
//          cosmetic overlap: it is a control silently wiped while the second
//          insert reports success. The concurrent case is the one that needs
//          the serialised allocation: the in-memory backend below answers
//          asynchronously, the way IPC does, so two allocations that are NOT
//          serialised both read the same state and both pick the same cell.
//
//          This runs the REAL create functions from index.ts against an
//          in-memory stand-in for the control-metadata commands, and checks
//          what they WROTE (the backend map) and what they REGISTERED (the
//          floating store) — not what they returned, which is the one thing a
//          broken implementation can get right by accident.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory control metadata backend (async, like the IPC it stands in for)
// ---------------------------------------------------------------------------

interface Meta {
  controlType: string;
  properties: Record<string, { valueType: string; value: string }>;
}

const backend = new Map<string, Meta>();
const key = (s: number, r: number, c: number) => `${s}:${r}:${c}`;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

vi.mock("../lib/controlApi", () => ({
  async getControlMetadata(s: number, r: number, c: number) {
    await tick();
    return backend.get(key(s, r, c)) ?? null;
  },
  async setControlMetadata(s: number, r: number, c: number, meta: Meta) {
    await tick();
    backend.set(key(s, r, c), JSON.parse(JSON.stringify(meta)));
    return meta;
  },
  async removeControlMetadata(s: number, r: number, c: number) {
    await tick();
    return backend.delete(key(s, r, c));
  },
  async getAllControls(s: number) {
    await tick();
    return [...backend.entries()]
      .map(([k, metadata]) => {
        const [sheetIndex, row, col] = k.split(":").map(Number);
        return { sheetIndex, row, col, metadata };
      })
      .filter((e) => e.sheetIndex === s);
  },
  setControlProperty: vi.fn(),
  resolveControlProperties: vi.fn(async () => ({})),
}));

// Grid geometry: default 100x24 cells, column 0 widened to 150 and row 0 to
// 30, so a WALK and a multiplication give different answers.
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGridStateSnapshot: () => ({
    config: { defaultCellWidth: 100, defaultCellHeight: 24, activeSheet: 0 },
    dimensions: {
      columnWidths: new Map([[0, 150]]),
      rowHeights: new Map([[0, 30]]),
    },
  }),
}));

// The picture path asks the renderer for the image's natural size.
vi.mock("../Image/imageRenderer", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMediaNaturalSize: vi.fn(async () => ({ width: 400, height: 200 })),
}));

vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAppEvent: vi.fn(),
}));

import {
  createShapeControlAt,
  createButtonControlAt,
  createPictureControlAt,
} from "../index";
import {
  getAllFloatingControls,
  getFloatingControl,
  removeFloatingControl,
} from "../lib/floatingStore";

const MEDIA = `media:${"a".repeat(64)}`;

function props(s: number, r: number, c: number): Record<string, string> {
  const meta = backend.get(key(s, r, c));
  expect(meta, `no control metadata at ${key(s, r, c)}`).toBeDefined();
  return Object.fromEntries(
    Object.entries(meta!.properties).map(([k, v]) => [k, v.value]),
  );
}

/** Seed an existing control the allocator has to steer around. */
function seed(s: number, r: number, c: number, controlType = "shape"): void {
  backend.set(key(s, r, c), { controlType, properties: {} });
}

beforeEach(() => {
  backend.clear();
  for (const ctrl of getAllFloatingControls()) removeFloatingControl(ctrl.id);
});

// ============================================================================
// Positioned: exactly x/y, unpinned
// ============================================================================

describe("a positioned create lands at exactly x/y, unpinned", () => {
  it("shape", async () => {
    const h = await createShapeControlAt({
      sheetIndex: 0,
      shapeType: "rectangle",
      x: 333,
      y: 77,
      width: 120,
      height: 60,
      text: "",
    });
    expect([h.x, h.y, h.width, h.height]).toEqual([333, 77, 120, 60]);
    const p = props(0, h.row, h.col);
    expect(p.x).toBe("333");
    expect(p.y).toBe("77");
    expect(p.pinToGrid).toBe("false");
    expect(p.text).toBe("");
    const stored = getFloatingControl(h.instanceId);
    expect(stored).toMatchObject({ x: 333, y: 77, width: 120, height: 60, controlType: "shape" });
  });

  it("button (with its own width/height)", async () => {
    const h = await createButtonControlAt({
      sheetIndex: 0,
      label: "Go",
      x: 40,
      y: 500,
      width: 140,
      height: 36,
    });
    expect([h.x, h.y, h.width, h.height]).toEqual([40, 500, 140, 36]);
    const p = props(0, h.row, h.col);
    expect([p.x, p.y, p.width, p.height]).toEqual(["40", "500", "140", "36"]);
    expect(p.pinToGrid).toBe("false");
    // `text`, never `label` — the original invisible-button bug.
    expect(p.text).toBe("Go");
    expect(p).not.toHaveProperty("label");
    expect(getFloatingControl(h.instanceId)).toMatchObject({ x: 40, y: 500, width: 140, height: 36 });
  });

  it("button without a size gets the 80x28 minimum, not the allocated cell's size", async () => {
    const h = await createButtonControlAt({ sheetIndex: 0, label: "Go", x: 10, y: 10 });
    expect([h.width, h.height]).toEqual([80, 28]);
  });

  it("picture", async () => {
    const h = await createPictureControlAt({
      sheetIndex: 0,
      mediaRef: MEDIA,
      x: 64,
      y: 256,
      width: 200,
      height: 100,
    });
    expect([h.x, h.y, h.width, h.height]).toEqual([64, 256, 200, 100]);
    const p = props(0, h.row, h.col);
    expect([p.x, p.y]).toEqual(["64", "256"]);
    expect(p.pinToGrid).toBe("false");
    expect(p.src).toBe(MEDIA);
    expect(getFloatingControl(h.instanceId)).toMatchObject({ x: 64, y: 256, controlType: "image" });
  });

  it("a named anchor WITH a position keeps the anchor and paints at the position", async () => {
    const h = await createShapeControlAt({
      sheetIndex: 0,
      row: 5,
      col: 2,
      shapeType: "rectangle",
      x: 12,
      y: 34,
    });
    expect([h.row, h.col, h.x, h.y]).toEqual([5, 2, 12, 34]);
    expect(props(0, 5, 2).x).toBe("12");
  });
});

// ============================================================================
// Allocated anchors never collide
// ============================================================================

describe("an omitted anchor is allocated, and never collides", () => {
  it("steers clear of every control already on the sheet (and ignores other sheets)", async () => {
    seed(0, 0, 0);
    seed(0, 7, 4);
    seed(1, 0, 99); // another sheet: irrelevant to sheet 0
    const h = await createShapeControlAt({ sheetIndex: 0, shapeType: "rectangle", x: 1, y: 1 });
    expect([h.row, h.col]).toEqual([0, 5]);
    expect(h.instanceId).toBe("control-0-0-5");
    expect(backend.size).toBe(4);
  });

  it("two creates in a row get different anchors", async () => {
    const a = await createShapeControlAt({ sheetIndex: 0, shapeType: "rectangle", x: 10, y: 10 });
    const b = await createShapeControlAt({ sheetIndex: 0, shapeType: "rectangle", x: 20, y: 20 });
    expect(a.instanceId).not.toBe(b.instanceId);
    expect(backend.size).toBe(2);
    expect(props(0, a.row, a.col).x).toBe("10");
    expect(props(0, b.row, b.col).x).toBe("20");
  });

  it("three inserts IN FLIGHT at once (shape, button, picture) get three anchors — nothing is replaced", async () => {
    const [s, b, p] = await Promise.all([
      createShapeControlAt({ sheetIndex: 0, shapeType: "rectangle", x: 1, y: 1 }),
      createButtonControlAt({ sheetIndex: 0, label: "B", x: 2, y: 2 }),
      createPictureControlAt({ sheetIndex: 0, mediaRef: MEDIA, x: 3, y: 3 }),
    ]);
    const ids = new Set([s.instanceId, b.instanceId, p.instanceId]);
    expect(ids.size).toBe(3);
    // Every control is still in the backend with its OWN type — a collision
    // would leave two entries, the survivor carrying the last writer's type.
    expect(backend.size).toBe(3);
    expect(backend.get(key(0, s.row, s.col))?.controlType).toBe("shape");
    expect(backend.get(key(0, b.row, b.col))?.controlType).toBe("button");
    expect(backend.get(key(0, p.row, p.col))?.controlType).toBe("image");
  });

  it("a failed create does not stall the next one", async () => {
    await expect(
      createShapeControlAt({ sheetIndex: 0, shapeType: "notAShape", x: 1, y: 1 }),
    ).rejects.toThrow(/Unknown shape/);
    await expect(
      createPictureControlAt({ sheetIndex: 0, mediaRef: "data:image/png;base64,AA", x: 1, y: 1 }),
    ).rejects.toThrow(/media handle/);
    const h = await createShapeControlAt({ sheetIndex: 0, shapeType: "rectangle", x: 5, y: 5 });
    expect(backend.size).toBe(1);
    expect(h.x).toBe(5);
  });
});

// ============================================================================
// Refusals
// ============================================================================

describe("a request that says nowhere, or half of somewhere, is refused", () => {
  it("neither an anchor nor a position", async () => {
    await expect(
      createShapeControlAt({ sheetIndex: 0, shapeType: "rectangle" } as never),
    ).rejects.toThrow(/anchor cell \(row \+ col\) or a position/);
    expect(backend.size).toBe(0);
  });

  it("x without y", async () => {
    await expect(
      createButtonControlAt({ sheetIndex: 0, label: "B", x: 5 } as never),
    ).rejects.toThrow(/both x and y/);
    expect(backend.size).toBe(0);
  });

  it("a negative or non-finite coordinate", async () => {
    await expect(
      createShapeControlAt({ sheetIndex: 0, shapeType: "rectangle", x: -1, y: 0 }),
    ).rejects.toThrow(/non-negative, finite/);
    await expect(
      createShapeControlAt({ sheetIndex: 0, shapeType: "rectangle", x: Number.NaN, y: 0 }),
    ).rejects.toThrow(/non-negative, finite/);
    expect(backend.size).toBe(0);
  });

  it("a zero-size button", async () => {
    await expect(
      createButtonControlAt({ sheetIndex: 0, label: "B", x: 5, y: 5, width: 0 }),
    ).rejects.toThrow(/positive number of pixels/);
    expect(backend.size).toBe(0);
  });
});

// ============================================================================
// The anchored path is unchanged
// ============================================================================

describe("the anchored path (anchor given, no x/y) behaves exactly as before", () => {
  it("shape: walked origin of the anchor cell, catalog default size, anchor kept", async () => {
    const h = await createShapeControlAt({ sheetIndex: 0, row: 2, col: 1, shapeType: "rectangle" });
    // col 0 is 150 wide; rows 0 (30) + 1 (24).
    expect([h.row, h.col, h.x, h.y]).toEqual([2, 1, 150, 54]);
    const p = props(0, 2, 1);
    expect([p.x, p.y, p.pinToGrid]).toEqual(["150", "54", "false"]);
  });

  it("shape: an occupied NAMED anchor is still refused, and the occupant survives", async () => {
    seed(0, 2, 1, "button");
    await expect(
      createShapeControlAt({ sheetIndex: 0, row: 2, col: 1, shapeType: "rectangle" }),
    ).rejects.toThrow(/already holds a button control/);
    expect(backend.get(key(0, 2, 1))?.controlType).toBe("button");
  });

  it("button: walked origin, at least the cell size", async () => {
    const h = await createButtonControlAt({ sheetIndex: 0, row: 0, col: 0, label: "B" });
    // Cell A1 is 150x30: wider than 80, taller than 28.
    expect([h.row, h.col, h.x, h.y, h.width, h.height]).toEqual([0, 0, 0, 0, 150, 30]);
    const h2 = await createButtonControlAt({ sheetIndex: 0, row: 1, col: 1, label: "C" });
    // Cell B2 is 100x24: the 28 px minimum height wins.
    expect([h2.x, h2.y, h2.width, h2.height]).toEqual([150, 30, 100, 28]);
    expect(props(0, 1, 1).pinToGrid).toBe("false");
  });

  it("picture: walked origin of the anchor cell", async () => {
    const h = await createPictureControlAt({ sheetIndex: 0, row: 1, col: 2, mediaRef: MEDIA });
    expect([h.row, h.col, h.x, h.y]).toEqual([1, 2, 250, 30]);
  });
});

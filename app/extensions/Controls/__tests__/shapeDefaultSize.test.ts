//! FILENAME: app/extensions/Controls/__tests__/shapeDefaultSize.test.ts
// PURPOSE: Canvas contract §4.3 -- `createShape` with NO size inserts the shape
//          at the catalog's own default size, on the POSITIONED path a canvas
//          uses (x/y, no anchor) as well as the anchored one. The Canvas tab's
//          Shapes menu promises "a pick inserts at the catalog's default size",
//          and the catalog it reads (`listShapeCatalog`) states that size: the
//          two must be the same number, or a menu that shows an arrow's
//          proportions inserts a box of someone else's.
// CONTEXT: The real create function from index.ts against the in-memory
//          control-metadata stand-in controlPlacement.test.ts uses.

import { describe, it, expect, beforeEach, vi } from "vitest";

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

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGridStateSnapshot: () => ({
    config: { defaultCellWidth: 100, defaultCellHeight: 24, activeSheet: 0 },
    dimensions: { columnWidths: new Map(), rowHeights: new Map() },
  }),
}));

vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAppEvent: vi.fn(),
}));

import { createShapeControlAt } from "../index";
import { getAllFloatingControls, getFloatingControl, removeFloatingControl } from "../lib/floatingStore";
import { listShapeCatalogEntries } from "../Shape/shapeCatalogEntries";

beforeEach(() => {
  backend.clear();
  for (const c of getAllFloatingControls()) removeFloatingControl(c.id);
});

describe("a shape created with no size", () => {
  // Shapes whose defaults differ from each other AND from the old canvas box
  // (160 x 96), so a hard-coded size cannot pass by accident.
  const IDS = ["rightArrow", "oval", "line", "roundedRectangularCallout", "chevron"];

  // SABOTAGE: `request.width ?? 160` in createShapeControlAt -> red.
  it.each(IDS)("%s: lands at the catalog's default size on a canvas (x/y, no anchor)", async (id) => {
    const entry = listShapeCatalogEntries().find((e) => e.id === id)!;
    expect(entry, id).toBeDefined();
    const h = await createShapeControlAt({ sheetIndex: 3, shapeType: id, x: 64, y: 32 });
    expect([h.width, h.height]).toEqual([entry.defaultWidth, entry.defaultHeight]);
    const p = backend.get(key(3, h.row, h.col))!.properties;
    expect([p.width.value, p.height.value]).toEqual([String(entry.defaultWidth), String(entry.defaultHeight)]);
    expect(getFloatingControl(h.instanceId)).toMatchObject({ width: entry.defaultWidth, height: entry.defaultHeight });
  });

  it("a size the caller gives still wins", async () => {
    const h = await createShapeControlAt({ sheetIndex: 3, shapeType: "oval", x: 0, y: 0, width: 50, height: 40 });
    expect([h.width, h.height]).toEqual([50, 40]);
  });
});

//! FILENAME: app/extensions/Controls/__tests__/shapeCatalogThumbnails.test.ts
// PURPOSE: Canvas contract §4.3 -- every ShapeCatalogEntry the seam lists
//          (@api/controlsService listShapeCatalog) carries a THUMBNAIL: a
//          normalized SVG path and the viewBox that frames it, built from the
//          same geometry the shape is painted from. And `createShape` with no
//          size inserts at the catalog's default size, which is the size a
//          canvas Shapes menu promises.
// CONTEXT: The Canvas tab's Shapes menu (CanvasSheet) may not import Controls'
//          gallery or `shapePathToSvgD` (Facade Rule), and a copied drawing is a
//          second source of truth -- so the picture travels on the seam.

import { describe, it, expect } from "vitest";
import { getShapeCategories, getShapeDefinition } from "../Shape/shapeCatalog";
import { shapeThumbnail } from "../Shape/shapePathToSvg";
import { listShapeCatalogEntries } from "../Shape/shapeCatalogEntries";

const NUMBER = /^-?\d+(\.\d+)?$/;

describe("the catalog thumbnails", () => {
  const entries = listShapeCatalogEntries();

  it("cover every catalog shape, in catalog order", () => {
    const ids = getShapeCategories().flatMap((c) => c.shapes.map((s) => s.id));
    expect(entries.map((e) => e.id)).toEqual(ids);
  });

  // SABOTAGE: drop `thumbnail` from the flattening in shapeCatalogEntries.ts
  // -> every entry fails here.
  it("give every entry a well-formed viewBox and path", () => {
    for (const e of entries) {
      expect(e.thumbnail, e.id).toBeDefined();
      const { viewBox, d } = e.thumbnail!;
      const box = viewBox.split(" ");
      expect(box, `${e.id} viewBox`).toHaveLength(4);
      for (const n of box) expect(n, `${e.id} viewBox ${viewBox}`).toMatch(NUMBER);
      expect(Number(box[2]), e.id).toBeGreaterThan(0);
      expect(Number(box[3]), e.id).toBeGreaterThan(0);
      expect(d.startsWith("M "), `${e.id} starts with a move`).toBe(true);
      for (const token of d.split(" ")) {
        expect(/^[MLCQZ]$/.test(token) || NUMBER.test(token), `${e.id} token "${token}"`).toBe(true);
      }
    }
  });

  it("frame the WHOLE drawing, overhangs included (a callout's tail, an arrow's head)", () => {
    for (const e of entries) {
      const [x, y, w, h] = e.thumbnail!.viewBox.split(" ").map(Number);
      const nums = e.thumbnail!.d.split(" ").filter((t) => NUMBER.test(t)).map(Number);
      for (let i = 0; i + 1 < nums.length; i += 2) {
        expect(nums[i], `${e.id} x`).toBeGreaterThanOrEqual(x);
        expect(nums[i], `${e.id} x`).toBeLessThanOrEqual(x + w);
        expect(nums[i + 1], `${e.id} y`).toBeGreaterThanOrEqual(y);
        expect(nums[i + 1], `${e.id} y`).toBeLessThanOrEqual(y + h);
      }
    }
  });

  it("are the shape's own geometry: a rectangle is its four corners", () => {
    expect(shapeThumbnail(getShapeDefinition("rectangle")!)).toEqual({
      viewBox: "-0.05 -0.05 1.1 1.1",
      d: "M 0 0 L 1 0 L 1 1 L 0 1 Z",
    });
  });

  // Polygons come from cos/sin and print 17 digits. The path is for a 16px
  // picture: four decimals are a hundredth of a pixel at 160px.
  it("round coordinates to four decimals", () => {
    const hex = entries.find((e) => e.id === "hexagon")!;
    for (const token of hex.thumbnail!.d.split(" ").filter((t) => NUMBER.test(t))) {
      expect(token.split(".")[1]?.length ?? 0, token).toBeLessThanOrEqual(4);
    }
  });

  it("keep the size and line facts the seam already promised", () => {
    const line = entries.find((e) => e.id === "line")!;
    expect(line.isLine).toBe(true);
    const rect = entries.find((e) => e.id === "rectangle")!;
    const def = getShapeDefinition("rectangle")!;
    expect([rect.defaultWidth, rect.defaultHeight]).toEqual([def.defaultWidth, def.defaultHeight]);
  });
});

//! FILENAME: app/src/api/__tests__/canvasSheetConstantsDrift.test.ts
// PURPOSE: The canvas layout ranges and page presets in `@api/canvasSheet` are
//          a MIRROR of the Rust authority (core/persistence/src/lib.rs). A
//          mirror that drifts turns the ribbon's and the script validator's
//          fast first answer into a wrong one: a grid size the tab accepts and
//          the backend refuses, or a preset the tab offers that Rust does not
//          know. Read the Rust source at test time; the direction is fixed
//          Rust -> TypeScript.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as canvas from "../canvasSheet";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUST = readFileSync(resolve(HERE, "../../../../core/persistence/src/lib.rs"), "utf8");

function rustConst(name: string): string {
  const m = RUST.match(new RegExp(`pub const ${name}: [^=]+= ([^;]+);`));
  if (!m) throw new Error(`core/persistence/src/lib.rs no longer defines ${name}`);
  return m[1].trim();
}

function rustNumber(name: string): number {
  return Number(rustConst(name).replace(/_/g, ""));
}

describe("canvas sheet constants mirror the Rust authority", () => {
  it.each([
    "CANVAS_DEFAULT_PAGE_WIDTH",
    "CANVAS_DEFAULT_PAGE_HEIGHT",
    "CANVAS_DEFAULT_GRID_SIZE_PX",
    "CANVAS_MIN_GRID_SIZE_PX",
    "CANVAS_MAX_GRID_SIZE_PX",
    "CANVAS_MIN_PAGE_EDGE_PX",
    "CANVAS_MAX_PAGE_EDGE_PX",
  ] as const)("%s", (name) => {
    expect((canvas as Record<string, unknown>)[name]).toBe(rustNumber(name));
  });

  it("the custom preset id", () => {
    expect(canvas.CANVAS_CUSTOM_PAGE_PRESET).toBe(JSON.parse(rustConst("CANVAS_CUSTOM_PAGE_PRESET")));
  });

  it("the page presets, in order, with their sizes", () => {
    const block = RUST.match(/pub const CANVAS_PAGE_PRESETS: [^=]+= &\[([\s\S]*?)\];/);
    expect(block, "CANVAS_PAGE_PRESETS not found in lib.rs").not.toBeNull();
    const rust = [...block![1].matchAll(/\("([^"]+)",\s*(\d+),\s*(\d+)\)/g)].map((m) => ({
      id: m[1],
      width: Number(m[2]),
      height: Number(m[3]),
    }));
    expect(rust.length).toBeGreaterThan(0);
    expect(canvas.CANVAS_PAGE_PRESETS.map(({ id, width, height }) => ({ id, width, height }))).toEqual(rust);
  });

  it("the default layout matches the defaults and validates", () => {
    const d = canvas.defaultCanvasLayout();
    expect(canvas.canvasPresetSize(d.pagePreset)).toEqual({ width: d.pageWidth, height: d.pageHeight });
    expect(canvas.checkCanvasLayoutPatch(d)).toBeNull();
  });
});

describe("checkCanvasLayoutPatch", () => {
  it("names the first out-of-range field", () => {
    expect(canvas.checkCanvasLayoutPatch({ gridSizePx: 0 })).toMatch(/Grid size/);
    expect(canvas.checkCanvasLayoutPatch({ gridSizePx: 12.5 })).toMatch(/Grid size/);
    expect(canvas.checkCanvasLayoutPatch({ pageWidth: 99 })).toMatch(/Page width/);
    expect(canvas.checkCanvasLayoutPatch({ pageHeight: 10_001 })).toMatch(/Page height/);
    expect(canvas.checkCanvasLayoutPatch({ pagePreset: "a4" })).toMatch(/Unknown page size/);
    expect(canvas.checkCanvasLayoutPatch({ background: "red" })).toMatch(/Background/);
  });

  it("accepts the edges of every range and an empty patch", () => {
    expect(canvas.checkCanvasLayoutPatch({})).toBeNull();
    expect(canvas.checkCanvasLayoutPatch({ gridSizePx: canvas.CANVAS_MIN_GRID_SIZE_PX })).toBeNull();
    expect(canvas.checkCanvasLayoutPatch({ gridSizePx: canvas.CANVAS_MAX_GRID_SIZE_PX })).toBeNull();
    expect(
      canvas.checkCanvasLayoutPatch({
        pagePreset: canvas.CANVAS_CUSTOM_PAGE_PRESET,
        pageWidth: canvas.CANVAS_MIN_PAGE_EDGE_PX,
        pageHeight: canvas.CANVAS_MAX_PAGE_EDGE_PX,
        background: "#abc",
      }),
    ).toBeNull();
  });
});

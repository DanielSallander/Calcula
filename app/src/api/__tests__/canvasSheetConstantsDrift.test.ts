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

  // The default preset id is Rust's `CanvasLayout::default` page_preset, not
  // a second copy of the string.
  it("the default preset id", () => {
    const m = RUST.match(/impl Default for CanvasLayout \{[\s\S]*?page_preset: "([^"]+)"/);
    expect(m, "CanvasLayout::default no longer names its page_preset").not.toBeNull();
    expect(canvas.defaultCanvasLayout().pagePreset).toBe(m![1]);
  });

  // CONTRACT-CANVAS 4.7: the two new layout fields exist in Rust under the
  // names the TypeScript mirror reads (serde camelCases them), and both are
  // omitted from the wire at their defaults -- which is why the TS fields are
  // OPTIONAL and the helpers below read an absent field as the default.
  it("wallpaper and objectsLocked are Rust fields, skipped at their defaults", () => {
    const body = RUST.match(/pub struct CanvasLayout \{([\s\S]*?)\n\}/);
    expect(body, "pub struct CanvasLayout not found").not.toBeNull();
    expect(body![1]).toMatch(/#\[serde\(skip_serializing_if = "String::is_empty"\)\]\s*pub wallpaper: String,/);
    expect(body![1]).toMatch(/#\[serde\(skip_serializing_if = "std::ops::Not::not"\)\]\s*pub objects_locked: bool,/);
  });
});

describe("the page presets, grouped as Power BI shows them", () => {
  it("every preset belongs to one of Power BI's page types, 16:9 first", () => {
    const types = canvas.CANVAS_PAGE_PRESETS.map((p) => p.type);
    expect([...new Set(types)]).toEqual(["16:9", "4:3", "letter", "tooltip"]);
  });

  it("the 16:9 sizes are HD (the default), Full HD, QHD and 4K", () => {
    const sizes = canvas.CANVAS_PAGE_PRESETS.filter((p) => p.type === "16:9").map((p) => [p.id, p.width, p.height]);
    expect(sizes).toEqual([
      ["16:9", 1280, 720],
      ["16:9-fhd", 1920, 1080],
      ["16:9-qhd", 2560, 1440],
      ["16:9-4k", 3840, 2160],
    ]);
    for (const p of canvas.CANVAS_PAGE_PRESETS) {
      expect(p.width / p.height === 16 / 9).toBe(p.type === "16:9");
    }
  });

  it("the type's first preset is the one its menu row picks", () => {
    expect(canvas.canvasPagePresetForType("16:9").id).toBe("16:9");
    expect(canvas.canvasPagePresetForType("tooltip")).toMatchObject({ id: "tooltip", width: 320, height: 240 });
    expect(canvas.canvasPagePresetType("16:9-4k")).toBe("16:9");
    expect(canvas.canvasPagePresetType("custom")).toBeNull();
    expect(canvas.canvasPagePresetType("a4")).toBeNull();
  });

  it("every preset has a label and a size label for the menus", () => {
    for (const p of canvas.CANVAS_PAGE_PRESETS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.sizeLabel).toContain(`${p.width} x ${p.height}`);
    }
  });
});

describe("wallpaper and Lock Objects readers", () => {
  it("an absent field reads as its default", () => {
    const d = canvas.defaultCanvasLayout();
    expect(canvas.canvasObjectsLocked(d)).toBe(false);
    expect(canvas.canvasWallpaper(d)).toBe("");
    expect(canvas.canvasObjectsLocked({ ...d, objectsLocked: true })).toBe(true);
    expect(canvas.canvasWallpaper({ ...d, wallpaper: "#123456" })).toBe("#123456");
    expect(canvas.canvasObjectsLocked(null)).toBe(false);
    expect(canvas.canvasWallpaper(undefined)).toBe("");
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
    expect(canvas.checkCanvasLayoutPatch({ wallpaper: "red" })).toMatch(/Wallpaper/);
    expect(canvas.checkCanvasLayoutPatch({ wallpaper: "#fff;x" })).toMatch(/Wallpaper/);
    expect(canvas.checkCanvasLayoutPatch({ objectsLocked: "yes" as unknown as boolean })).toMatch(/Lock Objects/);
  });

  it("accepts every preset id, a wallpaper and the page lock", () => {
    for (const p of canvas.CANVAS_PAGE_PRESETS) {
      expect(canvas.checkCanvasLayoutPatch({ pagePreset: p.id })).toBeNull();
    }
    expect(canvas.checkCanvasLayoutPatch({ wallpaper: "" })).toBeNull();
    expect(canvas.checkCanvasLayoutPatch({ wallpaper: "#0a0B0c" })).toBeNull();
    expect(canvas.checkCanvasLayoutPatch({ objectsLocked: true })).toBeNull();
    expect(canvas.checkCanvasLayoutPatch({ objectsLocked: false })).toBeNull();
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

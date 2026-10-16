//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotObjectFormat.test.ts
// PURPOSE: The canvas pivot box's @api/objectFormat provider and the pivot
//          kind's ONE bindable-properties registration (WP-C S10, 2.7 item 4):
//          - `bindingPath` answers FROM the exported table (the
//            objectFormatBindingPaths census reads it as text), every pointer
//            is a WP-D catalog row, `lockAspect` is never bindable;
//          - the defaults are today's box (white, a 1 px #c8c8c8 outline) with
//            everything Core-painted, the title text the pivot's name;
//          - a commit that changes nothing is NEVER sent (BUG-0477: the door
//            dirties the document on a no-op); a real one hands the frame store
//            the whole new container;
//          - a preview reaches the store transiently and ends;
//          - the registration names the box by pivot id (region and script
//            instance) and offers the box's container fields, group "Format";
//          - the Data format rows and their one-step write.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  regions: [] as Array<Record<string, unknown>>,
  info: null as unknown,
  setFormat: vi.fn(async () => undefined),
  labels: [] as string[],
}));

vi.mock("../pivot-api", () => ({ getPivotAtCell: vi.fn(async () => h.info) }));
vi.mock("../valueFieldEdits", () => ({ setPivotValueFieldFormat: h.setFormat }));
vi.mock("../../handlers/selectionHandler", () => ({ getCachedRegions: () => h.regions }));
vi.mock("@api/objectGeometry", () => ({
  runInUndoTransaction: async (label: string, fn: () => Promise<unknown>) => {
    h.labels.push(label);
    return fn();
  },
}));

import type { GridRegion } from "@api/gridOverlays";
import { VISUAL_CONTAINER_FIELD_IDS } from "@api/visualContainer";
import { registerObjectFormatProvider, resetObjectFormatProviders } from "@api/objectFormat";
import { bindingRefForInstance, bindingRefForRegion, getBindableProperties, isBindablePath } from "@api/objectBindings";
import {
  CONTAINER_BINDING_KIND,
  CONTAINER_BINDING_PATHS,
  PIVOT_BOX_BORDER_COLOR,
  createPivotObjectFormatProvider,
  pivotContainerDefaults,
  registerPivotBindableProperties,
  samePivotContainer,
  type PivotObjectFormatDeps,
} from "../pivotObjectFormat";
import { pivotDataFormats, setPivotDataFormat, PIVOT_DATA_FORMAT_UNDO_LABEL } from "../pivotDataFormats";

const REGION_TYPE = "pivot-visual";

function box(pivotId = "7"): GridRegion {
  return {
    id: `pivot-visual-${pivotId}`,
    type: REGION_TYPE,
    startRow: 0,
    startCol: 1024,
    endRow: 9,
    endCol: 1026,
    floating: { x: 10, y: 20, width: 300, height: 200 },
    data: { pivotId, name: "Sales" },
  };
}

function deps(stored: Record<string, unknown> | undefined | null): PivotObjectFormatDeps & {
  commits: Array<[string, unknown]>;
  previews: Array<[string, unknown]>;
} {
  const commits: Array<[string, unknown]> = [];
  const previews: Array<[string, unknown]> = [];
  return {
    regionType: REGION_TYPE,
    getStoredContainer: () => stored as never,
    commitContainer: async (id, c) => {
      commits.push([id, c]);
    },
    previewContainer: (id, c) => {
      previews.push([id, c]);
    },
    commits,
    previews,
  };
}

let cleanups: Array<() => void> = [];
beforeEach(() => {
  resetObjectFormatProviders();
  h.regions = [];
  h.info = null;
  h.labels = [];
  h.setFormat.mockClear();
});
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
});

describe("the binding table", () => {
  it("names the pivot kind and one WP-D catalog pointer per bindable field; lockAspect is never bindable", () => {
    expect(CONTAINER_BINDING_KIND).toBe("pivot");
    expect(Object.keys(CONTAINER_BINDING_PATHS).sort()).toEqual([...VISUAL_CONTAINER_FIELD_IDS].sort());
    expect(CONTAINER_BINDING_PATHS.lockAspect).toBeNull();
    for (const field of VISUAL_CONTAINER_FIELD_IDS) {
      const p = CONTAINER_BINDING_PATHS[field];
      if (p === null) continue;
      expect(p, field).toBe(`/canvasFrame/container/${field.split(".").join("/")}`);
      expect(isBindablePath("pivot", p), `${p} is not a catalog row`).toBeTruthy();
    }
  });

  it("bindingPath answers FROM the table (and nothing for a region that carries no pivot)", () => {
    const p = createPivotObjectFormatProvider(deps(undefined));
    for (const field of VISUAL_CONTAINER_FIELD_IDS) {
      expect(p.bindingPath!(box(), field)).toBe(CONTAINER_BINDING_PATHS[field]);
    }
    expect(p.bindingPath!({ ...box(), data: {} }, "title.text")).toBeNull();
  });
});

describe("defaults, read, capabilities", () => {
  it("today's box: white, a 1 px #c8c8c8 outline, square corners; Core paints all of it; the title is the pivot's name", () => {
    const d = pivotContainerDefaults("Sales");
    expect(d.background).toMatchObject({ show: true, color: "#ffffff", alpha: 1 });
    expect(d.border).toEqual({ show: true, color: PIVOT_BOX_BORDER_COLOR, width: 1, radius: 0 });
    expect(PIVOT_BOX_BORDER_COLOR).toBe("#c8c8c8");
    expect(d.paint).toEqual({ background: "core", border: "core", title: "core", shadow: "core" });
    expect(d.title).toMatchObject({ show: false, text: "Sales" });
  });

  it("read is the STORED container (a copy), {} without one; every capability is on", () => {
    const stored = { padding: { top: 4 } };
    const p = createPivotObjectFormatProvider(deps(stored));
    const read = p.read(box());
    expect(read).toEqual(stored);
    expect(read).not.toBe(stored);
    expect(createPivotObjectFormatProvider(deps(undefined)).read(box())).toEqual({});
    expect(Object.values(p.capabilities(box())).filter((v) => v === false)).toEqual([]);
    expect(p.capabilities(box()).titleText).toBe("free");
  });
});

describe("commit and preview", () => {
  it("a commit that changes nothing is NEVER sent (BUG-0477); a real one sends the whole new container", async () => {
    const d = deps({ background: { color: "#ffffff" } });
    const p = createPivotObjectFormatProvider(d);
    await p.commit(box(), { background: { color: "#ffffff" } });
    await p.commit(box(), {});
    expect(d.commits).toEqual([]);
    await p.commit(box(), { border: { radius: 6 } });
    expect(d.commits).toEqual([["7", { background: { color: "#ffffff" }, border: { radius: 6 } }]]);
  });

  it("clearing the last stored leaf sends NO container at all (undefined, not {})", async () => {
    const d = deps({ padding: { top: 4 } });
    await createPivotObjectFormatProvider(d).commit(box(), { padding: { top: null } });
    expect(d.commits).toEqual([["7", undefined]]);
  });

  it("a region with no frame (not a box) is refused with a sentence", async () => {
    const p = createPivotObjectFormatProvider(deps(null));
    await expect(p.commit(box(), { padding: { top: 2 } })).rejects.toThrow("no longer exists");
  });

  it("a preview reaches the store transiently; endPreview -- and a commit -- end it", async () => {
    const d = deps(undefined);
    const p = createPivotObjectFormatProvider(d);
    p.preview!(box(), { background: { color: "#123456" } });
    expect(d.previews).toEqual([["7", { background: { color: "#123456" } }]]);
    p.endPreview!();
    expect(d.previews[1]).toEqual(["7", null]);
    p.endPreview!();
    expect(d.previews).toHaveLength(2);
    p.preview!(box(), { padding: { left: 3 } });
    await p.commit(box(), { padding: { left: 3 } });
    expect(d.previews[3]).toEqual(["7", null]);
  });

  it("samePivotContainer: key order and an empty group are not differences", () => {
    expect(samePivotContainer({ padding: { top: 1, left: 2 } }, { padding: { left: 2, top: 1 } })).toBe(true);
    expect(samePivotContainer(undefined, {})).toBe(true);
    expect(samePivotContainer({ padding: {} }, undefined)).toBe(true);
    expect(samePivotContainer({ padding: { top: 1 } }, undefined)).toBe(false);
  });
});

describe("the pivot kind's bindable properties (WP-D registry)", () => {
  it("names the box by its pivot id -- from its region and from a script's pivot instance id", async () => {
    cleanups.push(registerPivotBindableProperties(REGION_TYPE));
    expect(await bindingRefForRegion(box("12"))).toEqual({ kind: "pivot", id: "12" });
    expect(await bindingRefForInstance("pivot", "12")).toEqual({ kind: "pivot", id: "12" });
    expect(await bindingRefForInstance("pivot", "not-a-pivot")).toBeNull();
  });

  it("offers the box's container fields (group Format), never lockAspect", async () => {
    cleanups.push(registerPivotBindableProperties(REGION_TYPE));
    cleanups.push(registerObjectFormatProvider(createPivotObjectFormatProvider(deps(undefined))));
    const got = await getBindableProperties(box("12"));
    expect(got?.ref).toEqual({ kind: "pivot", id: "12" });
    const pointers = got!.properties.map((d) => d.pointer);
    expect(pointers).toContain("/canvasFrame/container/title/text");
    expect(pointers).toContain("/canvasFrame/container/border/radius");
    expect(pointers.some((p) => p.endsWith("/lockAspect"))).toBe(false);
    expect(new Set(got!.properties.map((d) => d.group))).toEqual(new Set(["Format"]));
    expect(pointers).toHaveLength(VISUAL_CONTAINER_FIELD_IDS.length - 1);
  });
});

describe("Data format", () => {
  it("lists the value fields: key = index, the custom name or the measure, the OVERRIDE only, the model format as the source", async () => {
    h.regions = [{ pivotId: "7", startRow: 3, startCol: 4 }];
    h.info = {
      pivotId: "7",
      biModel: { measures: [{ name: "Revenue", formatString: "#,##0.00" }, { name: "Units" }] },
      fieldConfiguration: {
        valueFields: [
          { name: "[Revenue]", numberFormat: "#,##0.00", numberFormatFromModel: true },
          { name: "[Units]", customName: "Units sold", numberFormat: "0" },
        ],
      },
    };
    expect(await pivotDataFormats("7")).toEqual([
      { key: "0", label: "Revenue", format: null, sourceFormat: "#,##0.00" },
      { key: "1", label: "Units sold", format: "0", sourceFormat: null },
    ]);
  });

  it("a pivot not on the sheet, or unreadable, is a sentence -- never an empty list", async () => {
    await expect(pivotDataFormats("7")).rejects.toThrow("not on this sheet");
    h.regions = [{ pivotId: "7", startRow: 0, startCol: 0 }];
    await expect(pivotDataFormats("7")).rejects.toThrow("could not be read");
  });

  it("a write is ONE 'Number Format' undo step through the value-field door; the provider checks the key", async () => {
    await setPivotDataFormat("7", 1, "0.0%");
    expect(h.labels).toEqual([PIVOT_DATA_FORMAT_UNDO_LABEL]);
    expect(h.setFormat).toHaveBeenCalledWith("7", 1, "0.0%");

    const seen: Array<[string, number, string | null]> = [];
    const p = createPivotObjectFormatProvider({
      ...deps(undefined),
      setDataFormat: async (id, i, f) => {
        seen.push([id, i, f]);
      },
    });
    await p.setDataFormat!(box(), "1", null);
    expect(seen).toEqual([["7", 1, null]]);
    await expect(p.setDataFormat!(box(), "x", "0")).rejects.toThrow("names no value field");
  });
});

//! FILENAME: app/src/api/scriptHost/__tests__/canvasSheetScriptRows.test.ts
// PURPOSE: The script surface of the CANVAS sheet kind (2026-09-25).
// COVERS:  (1) the ALLOWLIST rows: api.getCanvasLayout (read) and
//              api.setCanvasLayout (mutate), same tier/no-capability as the
//              neighbouring sheet rows;
//          (2) the validators: vAddSheet's third (kind) argument, vCanvasLayout
//              refusing unknown AND read-only keys by name and out-of-range
//              values through the shared checkCanvasLayoutPatch, and vSetState
//              refusing a "canvas.*" aspect (the `return true` tail lesson);
//          (3) the HOST executors over a fake lib: getSheets reports a kind for
//              every sheet, addSheet forwards the kind on BOTH add paths, and
//              the layout rows resolve the sheet (active by default, index or
//              name otherwise) and refuse a worksheet by name;
//          (4) the WORKER shims: the exact broker tuples they send.
// CONTEXT: hiddenLines.test.ts harness style — the executors take `lib` as a
//          parameter and the grid-sync side effects are module-mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

const mocks = vi.hoisted(() => ({
  grid: {
    refreshGridData: vi.fn(),
    refreshGridDimensions: vi.fn(),
    setActiveSheet: vi.fn((index: number, name: string, surface?: string) => ({
      type: "SET_ACTIVE_SHEET",
      index,
      name,
      surface,
    })),
  },
  dispatch: { dispatchGridAction: vi.fn() },
}));
vi.mock("../../grid", () => mocks.grid);
vi.mock("../../gridDispatch", () => mocks.dispatch);

import {
  executeAddSheet,
  executeGetCanvasLayout,
  executeGetSheets,
  executeSetCanvasLayout,
} from "../host";
import {
  CANVAS_LAYOUT_READ_ONLY_KEYS,
  CANVAS_LAYOUT_SCRIPT_KEYS,
  vAddSheet,
  vCanvasLayout,
  vCanvasLayoutQuery,
  vObjectAspect,
  vSetState,
} from "../validators";
import { ALLOWLIST } from "../allowlist";
import { buildWorkerContext, type WorkerRuntime } from "../worker/contextShims";
import type { MountSpec, W2H } from "../protocol";
import { registerModelVisualProvider, type ModelVisualInfo } from "../../modelVisuals";
import {
  CANVAS_INTERACTION_KINDS,
  CANVAS_MAX_OBJECT_REFS,
  CANVAS_MAX_GRID_SIZE_PX,
  CANVAS_MIN_GRID_SIZE_PX,
  CANVAS_PAGE_PRESETS,
  defaultCanvasLayout,
} from "../../canvasSheet";
import type { CanvasLayout, SheetInfo } from "../../lib";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asLib = (l: unknown) => l as any;

const CANVAS_LAYOUT: CanvasLayout = {
  ...defaultCanvasLayout(),
  gridSizePx: 24,
  zOrder: [{ kind: "chart", id: "chart-1" }],
};

/** Active = 0 ("Data", a worksheet with NO kind field — the serde default);
 *  1 = "Board", a canvas; 2 = "Notes", an explicit worksheet. */
function sheetList(): SheetInfo[] {
  return [
    { index: 0, name: "Data", visibility: "visible" },
    { index: 1, name: "Board", visibility: "visible", kind: "canvas", canvasLayout: CANVAS_LAYOUT, tabColor: "#FF0000" },
    { index: 2, name: "Notes", visibility: "hidden", kind: "worksheet" },
  ];
}

function makeLib(activeIndex = 0) {
  const sheets = sheetList();
  const undo: string[] = [];
  return {
    undo,
    getActiveSheet: vi.fn(async () => activeIndex),
    getSheets: vi.fn(async () => ({ sheets, activeIndex })),
    // add_sheet APPENDS and activates the new sheet; the fake mirrors that.
    addSheet: vi.fn(async (name?: string, kind?: "worksheet" | "canvas") => {
      const index = sheets.length;
      sheets.push({
        index,
        name: name ?? `Sheet${index + 1}`,
        visibility: "visible",
        kind: kind ?? "worksheet",
        ...(kind === "canvas" ? { canvasLayout: defaultCanvasLayout() } : {}),
      });
      return { sheets: [...sheets], activeIndex: index };
    }),
    moveSheet: vi.fn(async (from: number, to: number) => {
      const [moved] = sheets.splice(from, 1);
      sheets.splice(to, 0, moved);
      sheets.forEach((s, i) => (s.index = i));
      return { sheets: [...sheets], activeIndex: to };
    }),
    beginUndoTransaction: vi.fn(async () => { undo.push("begin"); }),
    commitUndoTransaction: vi.fn(async () => { undo.push("commit"); }),
    cancelUndoTransaction: vi.fn(async () => { undo.push("cancel"); }),
    setCanvasLayout: vi.fn(async (patch: Partial<CanvasLayout>, _sheetIndex?: number) => ({
      ...CANVAS_LAYOUT,
      ...patch,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// (1) Allowlist rows
// ============================================================================

describe("canvas allowlist rows", () => {
  it("getCanvasLayout is an unlocked READ with no capability", () => {
    const policy = ALLOWLIST["api.getCanvasLayout"];
    expect(policy).toBeDefined();
    expect(policy.tier).toBe("unlocked");
    expect(policy.class).toBe("read");
    expect(policy.capability).toBeUndefined();
    expect(policy.validate).toBe(vCanvasLayoutQuery);
  });

  it("setCanvasLayout is an unlocked MUTATE with no capability — like setTabColor", () => {
    const policy = ALLOWLIST["api.setCanvasLayout"];
    expect(policy).toBeDefined();
    expect(policy.tier).toBe(ALLOWLIST["api.setTabColor"].tier);
    expect(policy.class).toBe("mutate");
    expect(policy.capability).toBeUndefined();
    expect(policy.validate).toBe(vCanvasLayout);
  });

  it("addSheet and getSheets say, in the consent text, that kinds exist", () => {
    expect(ALLOWLIST["api.addSheet"].desc).toMatch(/canvas/);
    expect(ALLOWLIST["api.getSheets"].desc).toMatch(/kind/);
  });
});

// ============================================================================
// (2) Validators
// ============================================================================

describe("vAddSheet — the kind argument", () => {
  it("accepts an omitted, null, worksheet or canvas kind", () => {
    expect(vAddSheet(["Report"])).toBe(true);
    expect(vAddSheet(["Report", undefined, undefined])).toBe(true);
    expect(vAddSheet(["Report", null, null])).toBe(true);
    expect(vAddSheet(["Report", undefined, "worksheet"])).toBe(true);
    expect(vAddSheet(["Board", { after: 0 }, "canvas"])).toBe(true);
    expect(vAddSheet([undefined, undefined, "canvas"])).toBe(true);
  });

  it("rejects any other kind with the accepted spellings", () => {
    expect(vAddSheet(["Report", undefined, "sheet3"])).toMatch(
      /kind must be "worksheet" or "canvas" \(got "sheet3"\)/,
    );
    expect(vAddSheet(["Report", undefined, "Canvas"])).toMatch(/kind must be/);
    expect(vAddSheet(["Report", undefined, 1])).toMatch(/kind must be .* \(got number\)/);
  });

  it("still checks the name and position first", () => {
    expect(vAddSheet(["Bad/Name", undefined, "canvas"])).not.toBe(true);
    expect(vAddSheet(["Report", { before: 0, after: 1 }, "canvas"])).toMatch(/before OR after/);
  });
});

describe("vCanvasLayoutQuery", () => {
  it("accepts an omitted sheet, an index or a name", () => {
    expect(vCanvasLayoutQuery([])).toBe(true);
    expect(vCanvasLayoutQuery([null])).toBe(true);
    expect(vCanvasLayoutQuery([1])).toBe(true);
    expect(vCanvasLayoutQuery(["Board"])).toBe(true);
  });

  it("rejects a malformed sheet reference", () => {
    expect(vCanvasLayoutQuery([-1])).toMatch(/sheet/);
    expect(vCanvasLayoutQuery([{}])).toMatch(/sheet/);
  });
});

describe("vCanvasLayout", () => {
  it("accepts a partial patch of settable keys, with or without a sheet", () => {
    expect(vCanvasLayout([{ gridSizePx: 20 }])).toBe(true);
    expect(vCanvasLayout([{ snapToGrid: false, showGrid: true }, "Board"])).toBe(true);
    expect(vCanvasLayout([{ pagePreset: "4:3" }, 1])).toBe(true);
    expect(vCanvasLayout([{ pagePreset: "custom", pageWidth: 1600, pageHeight: 900 }])).toBe(true);
    expect(vCanvasLayout([{ background: "#112233" }])).toBe(true);
    expect(vCanvasLayout([{ background: "" }])).toBe(true);
  });

  it("the settable keys are the eight cosmetic layout scalars plus interactions (DC-5)", () => {
    expect(Object.keys(CANVAS_LAYOUT_SCRIPT_KEYS).sort()).toEqual(
      ["background", "gridSizePx", "interactions", "pageHeight", "pagePreset", "pageWidth", "showGrid", "snapToGrid", "wallpaper"],
    );
    expect(CANVAS_LAYOUT_SCRIPT_KEYS.interactions).toBe("interactions");
  });

  it("refuses the READ-ONLY keys by name (zOrder / locked name other objects)", () => {
    expect(vCanvasLayout([{ zOrder: [] }])).toMatch(/"zOrder" cannot be set from a script/);
    expect(vCanvasLayout([{ gridSizePx: 20, locked: [] }])).toMatch(/"locked" cannot be set/);
  });

  // Review finding (2026-10-08): `wallpaper` and `objectsLocked` were in NO
  // list, so both were refused as "unknown" keys although getCanvasLayout
  // returns them -- and objectsLocked stayed unsettable only by omission,
  // with nothing to stop the next edit from adding it to the settable list.
  // Wallpaper is cosmetic like background: settable. Lock Objects binds the
  // SCRIPT too (the backend refuses a script's move on a locked page), so a
  // script that could turn it off could undo the page's lock: read-only,
  // refused with a reason that says so.
  it("wallpaper is settable, validated like background", () => {
    expect(vCanvasLayout([{ wallpaper: "#0a0b0c" }])).toBe(true);
    expect(vCanvasLayout([{ wallpaper: "" }])).toBe(true);
    expect(vCanvasLayout([{ wallpaper: 3 }])).toBe("wallpaper must be a string");
    expect(vCanvasLayout([{ wallpaper: "blue" }])).toMatch(/[Ww]allpaper/);
  });

  it("objectsLocked is READ-ONLY, refused by name with its own reason (it binds the script itself)", () => {
    const verdict = vCanvasLayout([{ objectsLocked: false }]);
    expect(verdict).toMatch(/"objectsLocked" cannot be set from a script/);
    expect(verdict).toMatch(/Lock Objects/);
    expect(verdict).not.toMatch(/unknown/);
  });

  // P4 S12 (owner decision DC-5): interactions became SETTABLE. Its shape is
  // checked here; that both refs of every pair exist on THAT canvas is the
  // host's check (executeSetCanvasLayout below). zOrder / locked stay read-only.
  describe("interactions (settable, DC-5)", () => {
    const chart = (id: string) => ({ kind: "chart", id });
    const pivot = (id: string) => ({ kind: "pivot", id });
    const one = (pair: Record<string, unknown>) => vCanvasLayout([{ interactions: { pairs: [pair] } }]);

    it("is settable, not read-only", () => {
      expect(CANVAS_LAYOUT_READ_ONLY_KEYS.has("interactions")).toBe(false);
      expect(CANVAS_LAYOUT_READ_ONLY_KEYS.has("zOrder")).toBe(true);
      expect(CANVAS_LAYOUT_READ_ONLY_KEYS.has("locked")).toBe(true);
    });

    it("accepts an empty value, a default mode, and pairs of every mode", () => {
      expect(vCanvasLayout([{ interactions: {} }])).toBe(true);
      expect(vCanvasLayout([{ interactions: { pairs: [] } }])).toBe(true);
      expect(vCanvasLayout([{ interactions: { defaultMode: "filter" } }])).toBe(true);
      expect(vCanvasLayout([{ interactions: { defaultMode: "highlight" } }, "Board"])).toBe(true);
      expect(
        vCanvasLayout([
          {
            interactions: {
              pairs: [
                { source: chart("c1"), target: pivot("p1"), mode: "none" },
                { source: chart("c1"), target: chart("c2"), mode: "highlight" },
                { source: { kind: "slicer", id: "s1" }, target: chart("c2"), mode: "filter" },
              ],
            },
          },
        ]),
      ).toBe(true);
    });

    it("refuses a 'none' or unknown default mode", () => {
      expect(vCanvasLayout([{ interactions: { defaultMode: "none" } }])).toMatch(
        /defaultMode must be "filter" or "highlight"/,
      );
      expect(vCanvasLayout([{ interactions: { defaultMode: "Filter" } }])).toMatch(/defaultMode/);
    });

    it("refuses a non-object value, an unknown key, and non-array pairs", () => {
      expect(vCanvasLayout([{ interactions: [] }])).toMatch(/interactions must be an object/);
      expect(vCanvasLayout([{ interactions: null }])).toMatch(/interactions must be an object/);
      expect(vCanvasLayout([{ interactions: { pair: [] } }])).toMatch(/unknown key "pair"/);
      expect(vCanvasLayout([{ interactions: { pairs: {} } }])).toMatch(/pairs must be an array/);
      expect(one({ source: chart("a"), target: chart("b"), mode: "none", note: 1 })).toMatch(/unknown key "note"/);
    });

    it("refuses a ref of a kind outside CANVAS_INTERACTION_KINDS, or a blank / padded id", () => {
      for (const kind of CANVAS_INTERACTION_KINDS) {
        expect(one({ source: { kind, id: "a" }, target: chart("b"), mode: "filter" }), kind).toBe(true);
      }
      expect(one({ source: { kind: "shape", id: "a" }, target: chart("b"), mode: "filter" })).toMatch(
        /source\.kind must be one of chart, pivot, slicer \(got "shape"\)/,
      );
      expect(one({ source: chart("a"), target: chart(""), mode: "filter" })).toMatch(
        /target\.id must be a non-empty object id/,
      );
      expect(one({ source: chart(" a"), target: chart("b"), mode: "filter" })).toMatch(/source\.id/);
      expect(one({ source: chart("a"), target: chart("b"), mode: "dim" })).toMatch(
        /mode must be "filter", "highlight" or "none"/,
      );
    });

    it("refuses a visual paired with itself, and a pair named twice", () => {
      expect(one({ source: chart("a"), target: chart("a"), mode: "none" })).toMatch(/cannot interact with itself/);
      expect(
        vCanvasLayout([
          {
            interactions: {
              pairs: [
                { source: chart("a"), target: chart("b"), mode: "none" },
                { source: chart("a"), target: chart("b"), mode: "filter" },
              ],
            },
          },
        ]),
      ).toMatch(/names the pair chart "a" -> chart "b" twice/);
      // The reverse direction is a different pair.
      expect(
        vCanvasLayout([
          {
            interactions: {
              pairs: [
                { source: chart("a"), target: chart("b"), mode: "none" },
                { source: chart("b"), target: chart("a"), mode: "none" },
              ],
            },
          },
        ]),
      ).toBe(true);
    });

    it("refuses more than CANVAS_MAX_OBJECT_REFS pairs (the @api/canvasSheet mirror, no literal)", () => {
      const pairs = Array.from({ length: CANVAS_MAX_OBJECT_REFS + 1 }, (_x, i) => ({
        source: chart("a"),
        target: chart(`t${i}`),
        mode: "none",
      }));
      expect(vCanvasLayout([{ interactions: { pairs } }])).toMatch(
        new RegExp(`${CANVAS_MAX_OBJECT_REFS + 1} entries; the limit is ${CANVAS_MAX_OBJECT_REFS}`),
      );
      expect(vCanvasLayout([{ interactions: { pairs: pairs.slice(1) } }])).toBe(true);
    });
  });

  // THE CENSUS: every field the Rust CanvasLayout declares is classified for
  // scripts exactly once -- settable or read-only -- so a new field cannot
  // arrive unclassified, and no field can be both.
  it("every Rust CanvasLayout field is in EXACTLY one of the settable / read-only lists", () => {
    const rust = fs.readFileSync(
      path.resolve(__dirname, "../../../../../core/persistence/src/lib.rs"),
      "utf8",
    );
    const at = rust.indexOf("pub struct CanvasLayout {");
    expect(at, "the Rust struct moved").toBeGreaterThan(-1);
    const body = rust.slice(at, rust.indexOf("\n}", at));
    const fields = [...body.matchAll(/^\s*pub (\w+):/gm)].map((m) =>
      m[1].replace(/_([a-z])/g, (_x, c: string) => c.toUpperCase()),
    );
    expect(fields.length, "parsed no fields").toBeGreaterThan(8);
    const settable = new Set(Object.keys(CANVAS_LAYOUT_SCRIPT_KEYS));
    for (const f of fields) {
      const n = Number(settable.has(f)) + Number(CANVAS_LAYOUT_READ_ONLY_KEYS.has(f));
      expect(n, `CanvasLayout field "${f}" must be classified once (settable or read-only)`).toBe(1);
    }
    // And neither list names a field Rust does not have.
    for (const k of [...settable, ...CANVAS_LAYOUT_READ_ONLY_KEYS]) expect(fields, k).toContain(k);
  });

  // The object browser (objectContexts.d.ts, generated from its template)
  // listed only three page sizes and neither new field.
  it("the script typings name every page preset and both new layout fields", () => {
    const dts = fs.readFileSync(
      path.resolve(__dirname, "../../../../scripts/scriptTypings/objectContexts.template.d.ts"),
      "utf8",
    );
    const read = dts.slice(dts.indexOf("declare interface ScriptCanvasLayout {"));
    const readBody = read.slice(0, read.indexOf("\n}"));
    for (const p of CANVAS_PAGE_PRESETS) expect(readBody, p.id).toContain(`"${p.id}"`);
    expect(readBody).toMatch(/wallpaper\?: string;/);
    expect(readBody).toMatch(/objectsLocked\?: boolean;/);
    expect(readBody).toMatch(/interactions\?: ScriptCanvasInteractions;/);
    const patch = dts.slice(dts.indexOf("declare interface ScriptCanvasLayoutPatch {"));
    const patchBody = patch.slice(0, patch.indexOf("\n}"));
    expect(patchBody).toMatch(/wallpaper\?: string;/);
    expect(patchBody).toMatch(/interactions\?: ScriptCanvasInteractions;/);
    expect(patchBody).not.toMatch(/objectsLocked/);
  });

  it("refuses an unknown key by name instead of dropping it", () => {
    const verdict = vCanvasLayout([{ gridSize: 20 }]);
    expect(verdict).toMatch(/unknown canvas layout key "gridSize"/);
    expect(verdict).toMatch(/gridSizePx/); // names the allowed list
  });

  it("refuses out-of-range values with the SHARED checkCanvasLayoutPatch message", () => {
    expect(vCanvasLayout([{ gridSizePx: CANVAS_MIN_GRID_SIZE_PX - 1 }])).toMatch(
      new RegExp(`Grid size must be a whole number from ${CANVAS_MIN_GRID_SIZE_PX} to ${CANVAS_MAX_GRID_SIZE_PX}`),
    );
    expect(vCanvasLayout([{ gridSizePx: CANVAS_MAX_GRID_SIZE_PX + 1 }])).toMatch(/Grid size/);
    expect(vCanvasLayout([{ gridSizePx: 10.5 }])).toMatch(/Grid size/);
    expect(vCanvasLayout([{ pageWidth: 50 }])).toMatch(/Page width/);
    expect(vCanvasLayout([{ pagePreset: "a4" }])).toMatch(/Unknown page size "a4"/);
    expect(vCanvasLayout([{ background: "red" }])).toMatch(/Background must be a CSS hex colour/);
  });

  it("type-checks each value before the range check", () => {
    expect(vCanvasLayout([{ gridSizePx: "20" }])).toBe("gridSizePx must be a number");
    expect(vCanvasLayout([{ gridSizePx: Number.NaN }])).toBe("gridSizePx must be a number");
    expect(vCanvasLayout([{ snapToGrid: "yes" }])).toBe("snapToGrid must be a boolean");
    expect(vCanvasLayout([{ background: 0 }])).toBe("background must be a string");
  });

  it("refuses a non-object or empty patch, and a malformed sheet", () => {
    expect(vCanvasLayout([null])).toMatch(/patch must be an object/);
    expect(vCanvasLayout([[{ gridSizePx: 20 }]])).toMatch(/patch must be an object/);
    expect(vCanvasLayout(["gridSizePx=20"])).toMatch(/patch must be an object/);
    expect(vCanvasLayout([{}])).toMatch(/at least one canvas layout key/);
    expect(vCanvasLayout([{ gridSizePx: 20 }, -3])).toMatch(/sheet/);
  });
});

describe("vSetState — a canvas layout is not an object aspect", () => {
  it("refuses every canvas.* aspect by name, pointing at the dedicated row", () => {
    for (const aspect of ["canvas.setLayout", "canvas.layout", "canvas.zOrder"]) {
      const verdict = vSetState([aspect, [{ gridSizePx: 20 }]]);
      expect(verdict, aspect).toMatch(/not an object aspect/);
      expect(verdict, aspect).toMatch(/api\.setCanvasLayout/);
    }
  });

  it("refuses it through the api.objectSetState door too", () => {
    expect(vObjectAspect(["chart", "chart-1", "canvas.setLayout", [{}]])).toMatch(
      /api\.setCanvasLayout/,
    );
  });

  it("leaves unrelated aspects alone (the prefix is exact)", () => {
    expect(vSetState(["canvasish.thing", []])).toBe(true);
  });
});

// ============================================================================
// (3) Host executors
// ============================================================================

describe("executeGetSheets", () => {
  it("reports a kind for EVERY sheet — absent means worksheet", async () => {
    const lib = makeLib();
    const listed = await executeGetSheets(asLib(lib));
    expect(listed).toEqual([
      { index: 0, name: "Data", kind: "worksheet", visibility: "visible", tabColor: null },
      { index: 1, name: "Board", kind: "canvas", visibility: "visible", tabColor: "#FF0000" },
      { index: 2, name: "Notes", kind: "worksheet", visibility: "hidden", tabColor: null },
    ]);
  });
});

describe("executeAddSheet — the kind is forwarded", () => {
  it("unpositioned: forwards kind to lib.addSheet and returns the new sheet", async () => {
    const lib = makeLib();
    const added = await executeAddSheet(asLib(lib), "Dashboard", undefined, "canvas");
    expect(lib.addSheet).toHaveBeenCalledTimes(1);
    expect(lib.addSheet).toHaveBeenCalledWith("Dashboard", "canvas");
    expect(added).toEqual({ index: 3, name: "Dashboard" });
    // Core was told the new ACTIVE sheet is a canvas surface.
    expect(mocks.grid.setActiveSheet).toHaveBeenCalledWith(3, "Dashboard", "canvas");
    expect(lib.undo).toEqual([]);
  });

  it("positioned: forwards kind on the add + move path too", async () => {
    const lib = makeLib();
    const added = await executeAddSheet(asLib(lib), "Dashboard", { before: "Board" }, "canvas");
    expect(lib.addSheet).toHaveBeenCalledWith("Dashboard", "canvas");
    expect(lib.moveSheet).toHaveBeenCalledWith(3, 1);
    expect(added).toEqual({ index: 1, name: "Dashboard" });
    expect(lib.undo).toEqual(["begin", "commit"]);
  });

  it("an omitted or null kind reaches lib as undefined (a worksheet)", async () => {
    const lib = makeLib();
    await executeAddSheet(asLib(lib), "Plain", undefined, undefined);
    await executeAddSheet(asLib(lib), null, null, null);
    expect(lib.addSheet.mock.calls).toEqual([
      ["Plain", undefined],
      [undefined, undefined],
    ]);
  });

  it("still refuses a duplicate name before adding anything", async () => {
    const lib = makeLib();
    await expect(executeAddSheet(asLib(lib), "board", undefined, "canvas")).rejects.toThrow(
      /A sheet named "Board" already exists/,
    );
    expect(lib.addSheet).not.toHaveBeenCalled();
  });
});

describe("executeGetCanvasLayout", () => {
  it("answers a canvas's layout by name or index, zOrder included (readable)", async () => {
    const lib = makeLib();
    expect(await executeGetCanvasLayout(asLib(lib), "Board")).toEqual(CANVAS_LAYOUT);
    expect(await executeGetCanvasLayout(asLib(lib), 1)).toEqual(CANVAS_LAYOUT);
  });

  it("defaults to the ACTIVE sheet", async () => {
    const lib = makeLib(1);
    expect(await executeGetCanvasLayout(asLib(lib))).toEqual(CANVAS_LAYOUT);
  });

  it("throws a clear error for a worksheet — named, never a default layout", async () => {
    const lib = makeLib();
    await expect(executeGetCanvasLayout(asLib(lib))).rejects.toThrow(
      /Sheet 'Data' is not a canvas sheet/,
    );
    await expect(executeGetCanvasLayout(asLib(lib), "Notes")).rejects.toThrow(
      /Sheet 'Notes' is not a canvas sheet/,
    );
  });

  it("an unknown sheet lists the real ones", async () => {
    const lib = makeLib();
    await expect(executeGetCanvasLayout(asLib(lib), "Nope")).rejects.toThrow(
      /getCanvasLayout: no sheet named "Nope" \(sheets: "Data" \(0\), "Board" \(1\), "Notes" \(2\)\)/,
    );
  });
});

describe("executeSetCanvasLayout", () => {
  it("resolves the sheet to its INDEX and returns the backend's resulting layout", async () => {
    const lib = makeLib();
    const result = await executeSetCanvasLayout(asLib(lib), { gridSizePx: 32 }, "Board");
    expect(lib.setCanvasLayout).toHaveBeenCalledWith({ gridSizePx: 32 }, 1);
    expect(result.gridSizePx).toBe(32);
  });

  it("defaults to the active sheet, passed as an explicit index", async () => {
    const lib = makeLib(1);
    await executeSetCanvasLayout(asLib(lib), { showGrid: false });
    expect(lib.setCanvasLayout).toHaveBeenCalledWith({ showGrid: false }, 1);
  });

  it("refuses a worksheet by name WITHOUT calling the backend", async () => {
    const lib = makeLib();
    await expect(executeSetCanvasLayout(asLib(lib), { gridSizePx: 32 }, 0)).rejects.toThrow(
      /Sheet 'Data' is not a canvas sheet/,
    );
    expect(lib.setCanvasLayout).not.toHaveBeenCalled();
  });

  // DC-5: every ref of an interaction pair must be a visual on THAT canvas,
  // asked of @api/modelVisuals. A pair naming nothing would be stored and do
  // nothing; a pair naming another page's visual likewise.
  describe("interactions: both refs must exist on that canvas", () => {
    const visual = (kind: "chart" | "pivot" | "slicer", id: string, sheetIndex: number): ModelVisualInfo => ({
      ref: { kind, id },
      name: id,
      sheetIndex,
      sheetId: null,
      connectionId: "conn-1",
      role: { source: true, target: true, canHighlight: kind === "chart", reason: null },
      label: kind,
    });
    let off: () => void = () => {};
    beforeEach(() => {
      off = registerModelVisualProvider({
        kind: "chart",
        // c1 and p1 on Board (1); c9 on another sheet (3).
        list: () => [visual("chart", "c1", 1), visual("pivot", "p1", 1), visual("chart", "c9", 3)],
      });
      return () => off();
    });

    it("forwards a patch whose pairs name visuals on the canvas", async () => {
      const lib = makeLib();
      const patch = {
        interactions: { pairs: [{ source: { kind: "chart" as const, id: "c1" }, target: { kind: "pivot" as const, id: "p1" }, mode: "none" as const }] },
      };
      await executeSetCanvasLayout(asLib(lib), patch, "Board");
      expect(lib.setCanvasLayout).toHaveBeenCalledWith(patch, 1);
    });

    it("refuses an unknown ref by name, listing the canvas's visuals, WITHOUT calling the backend", async () => {
      const lib = makeLib();
      const patch = {
        interactions: { pairs: [{ source: { kind: "chart" as const, id: "c1" }, target: { kind: "chart" as const, id: "ghost" }, mode: "none" as const }] },
      };
      await expect(executeSetCanvasLayout(asLib(lib), patch, "Board")).rejects.toThrow(
        /interactions\.pairs\[0\]\.target names chart "ghost", which is not a visual on canvas 'Board' \(visuals there: chart "c1", pivot "p1"\)/,
      );
      expect(lib.setCanvasLayout).not.toHaveBeenCalled();
    });

    it("refuses a visual that lives on ANOTHER sheet", async () => {
      const lib = makeLib();
      const patch = {
        interactions: { pairs: [{ source: { kind: "chart" as const, id: "c9" }, target: { kind: "chart" as const, id: "c1" }, mode: "filter" as const }] },
      };
      await expect(executeSetCanvasLayout(asLib(lib), patch, "Board")).rejects.toThrow(/source names chart "c9"/);
      expect(lib.setCanvasLayout).not.toHaveBeenCalled();
    });

    it("an empty pair list (clearing every pair) needs no lookup", async () => {
      const lib = makeLib();
      await executeSetCanvasLayout(asLib(lib), { interactions: { pairs: [] } }, "Board");
      await executeSetCanvasLayout(asLib(lib), { interactions: { defaultMode: "filter" } }, "Board");
      expect(lib.setCanvasLayout).toHaveBeenCalledTimes(2);
    });
  });
});

// ============================================================================
// (4) Worker shims
// ============================================================================

interface PostedCall {
  callId: number;
  method: string;
  args: unknown[];
}

function makeContext(): {
  api: Record<string, unknown>;
  rt: WorkerRuntime;
  calls: PostedCall[];
  drain: () => void;
} {
  const calls: PostedCall[] = [];
  const spec = {
    protocolVersion: 1,
    scriptId: "canvas-test",
    objectType: "sheet",
    instanceId: null,
    tier: "unlocked",
    capabilities: [],
    apiVersion: "1.0.0",
    scriptName: "Canvas",
    packageInfo: null,
    snapshot: {},
    source: "",
  } as unknown as MountSpec;
  const { context, rt } = buildWorkerContext(spec, (msg: W2H) => {
    if (msg.t === "call") calls.push({ callId: msg.callId, method: msg.method, args: msg.args });
  });
  const drain = (): void => {
    for (const entry of rt.pending.values()) clearTimeout(entry.timer);
    rt.pending.clear();
  };
  return { api: context.api as Record<string, unknown>, rt, calls, drain };
}

describe("worker shims", () => {
  it("api.addSheet forwards [name, position, kind]", () => {
    const { api, calls, drain } = makeContext();
    const addSheet = api.addSheet as (...a: unknown[]) => Promise<unknown>;
    void addSheet("Dashboard", undefined, "canvas");
    void addSheet("Plain");
    expect(calls[0]).toMatchObject({ method: "api.addSheet", args: ["Dashboard", undefined, "canvas"] });
    expect(calls[1]).toMatchObject({ method: "api.addSheet", args: ["Plain", undefined, undefined] });
    drain();
  });

  it("api.getSheets hands the host's kind through", async () => {
    const { api, rt, calls } = makeContext();
    const promise = (api.getSheets as () => Promise<unknown>)();
    const sheets = [
      { index: 0, name: "Data", kind: "worksheet", visibility: "visible", tabColor: null },
      { index: 1, name: "Board", kind: "canvas", visibility: "visible", tabColor: null },
    ];
    rt.settleCall(calls[0].callId, true, sheets);
    expect(await promise).toEqual(sheets);
  });

  it("getCanvasLayout / setCanvasLayout send the exact broker tuples", () => {
    const { api, calls, drain } = makeContext();
    void (api.getCanvasLayout as (...a: unknown[]) => Promise<unknown>)();
    void (api.getCanvasLayout as (...a: unknown[]) => Promise<unknown>)("Board");
    void (api.setCanvasLayout as (...a: unknown[]) => Promise<unknown>)({ gridSizePx: 20 }, 1);
    expect(calls.map((c) => [c.method, c.args])).toEqual([
      ["api.getCanvasLayout", [undefined]],
      ["api.getCanvasLayout", ["Board"]],
      ["api.setCanvasLayout", [{ gridSizePx: 20 }, 1]],
    ]);
    drain();
  });
});

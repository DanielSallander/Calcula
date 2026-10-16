//! FILENAME: app/extensions/FloatingRange/lib/__tests__/frObjectFormat.test.ts
// PURPOSE: The floating grid's visual-container provider (WP-C S12): the title
//          TEXT is the grid's name (a commit renames, never bound), the title
//          toggle is `showTitle` (never bound), every other leaf lands in the
//          range's container; the defaults keep today's look; the container's
//          padding and border GROW the derived frame and move the cells in, by
//          exactly the band Core's content rect leaves; a format commit goes
//          through on a Lock Objects page; a bound title colour paints, a bound
//          value on an identity leaf never does.
// CONTEXT: The provider is a factory with injected deps (the pivot / chart
//          pattern); the store, the frame math and Core's content rect are the
//          REAL ones.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ObjectBindingRef, ResolvedBinding } from "@api/objectBindings";

/** WP-D's resolved cache, doubled: "<kind>:<id>:<path>" -> resolved binding. */
const resolved = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@api/objectBindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/objectBindings")>()),
  getResolved: vi.fn((ref: ObjectBindingRef, path: string) => resolved.get(`${ref.kind}:${ref.id}:${path}`) ?? null),
}));

import {
  CONTAINER_BINDING_KIND,
  CONTAINER_BINDING_PATHS,
  FR_FORMAT_EMPTY_NAME,
  FR_FORMAT_GONE,
  createFrObjectFormatProvider,
  frBindableDescriptors,
  frContainerDefaults,
  frContainerOf,
  frInsets,
  frShowsTitle,
  frStoredContainer,
  invalidateFrContainers,
  planFrFormatCommit,
  resetFrContainers,
  type FrObjectFormatDeps,
} from "../frObjectFormat";
import {
  FLOATING_RANGE_REGION_TYPE,
  frGeometryEditable,
  getFloatingRangeById,
  resetFloatingRangeStore,
  setFrActiveSheetIndex,
  syncFloatingRangeRegions,
  upsertFromInfo,
} from "../floatingRangeStore";
import {
  FR_COL_HDR_H,
  FR_DEFAULT_COL_W,
  FR_DEFAULT_ROW_H,
  FR_ROW_HDR_W,
  FR_TITLE_H,
  frInnerBox,
  frTitleH,
  frameHeight,
  frameWidth,
  localCellOrigin,
} from "../frDimensions";
import { VISUAL_CONTAINER_FIELD_IDS, type ContainerFieldId } from "@api/visualContainer";
import { isBindablePath } from "@api/objectBindings";
import { getGridRegions, type GridRegion } from "@api/gridOverlays";
import { visualContentRect, type ContainerRegion } from "@api/visualContainerPaint";
import { registerLayoutSurfaceProvider } from "@api/layoutSurface";
import type { FloatingRangeInfo, FloatingRangePatch } from "@api/floatingRanges";

const FR_ID = "fr-uuid-7";

const INFO: FloatingRangeInfo = {
  id: FR_ID,
  backingSheetId: "backing",
  hostSheetId: "host",
  x: 100,
  y: 80,
  rotation: 0,
  pinToGrid: false,
  rowCount: 4,
  colCount: 3,
  colWidths: {},
  rowHeights: {},
  showTitle: true,
  showColumnHeaders: true,
  showRowHeaders: true,
  name: "Float7",
  backingSheetIndex: 1,
  hostSheetIndex: 0,
};

/** The frame of the untouched range: today's derived size. */
const BASE_W = FR_ROW_HDR_W + 3 * FR_DEFAULT_COL_W;
const BASE_H = FR_TITLE_H + FR_COL_HDR_H + 4 * FR_DEFAULT_ROW_H;

function region(): GridRegion {
  syncFloatingRangeRegions();
  const r = getGridRegions().find((g) => g.type === FLOATING_RANGE_REGION_TYPE && g.data?.frId === FR_ID);
  if (!r) throw new Error("the range published no region");
  return r;
}

/** Deps that write through to the REAL store, the way index.ts's applyFrPatch does. */
function deps(over: Partial<FrObjectFormatDeps> = {}) {
  const updates: Array<[string, FloatingRangePatch]> = [];
  const renames: Array<[string, string]> = [];
  const d: FrObjectFormatDeps = {
    regionType: FLOATING_RANGE_REGION_TYPE,
    getEntry: getFloatingRangeById,
    update: async (id, patch) => {
      updates.push([id, patch]);
      const e = getFloatingRangeById(id)!;
      upsertFromInfo({
        ...INFO,
        name: e.name,
        showTitle: patch.showTitle ?? e.showTitle,
        container: patch.container === undefined ? e.container : (patch.container ?? undefined),
      });
    },
    rename: async (id, name) => {
      renames.push([id, name]);
      const e = getFloatingRangeById(id)!;
      upsertFromInfo({ ...INFO, name, showTitle: e.showTitle, container: e.container });
    },
    republish: vi.fn(),
    ...over,
  };
  return { d, updates, renames };
}

let unregisterSurface: (() => void) | null = null;

beforeEach(() => {
  resolved.clear();
  resetFloatingRangeStore();
  setFrActiveSheetIndex(0);
  upsertFromInfo(INFO);
});

afterEach(() => {
  unregisterSurface?.();
  unregisterSurface = null;
  resetFloatingRangeStore();
  resetFrContainers();
});

// ============================================================================

describe("the binding table", () => {
  it("names the floatingRange kind and answers bindingPath FROM the table, for every field", () => {
    expect(CONTAINER_BINDING_KIND).toBe("floatingRange");
    const p = createFrObjectFormatProvider(deps().d);
    const r = region();
    for (const field of VISUAL_CONTAINER_FIELD_IDS) {
      expect(p.bindingPath!(r, field), field).toBe(CONTAINER_BINDING_PATHS[field]);
    }
  });

  it("never binds the identity leaves, the padding or the aspect lock (2.7, R10)", () => {
    const p = createFrObjectFormatProvider(deps().d);
    const r = region();
    const never: ContainerFieldId[] = [
      "title.text",
      "title.show",
      "padding.top",
      "padding.right",
      "padding.bottom",
      "padding.left",
      "lockAspect",
    ];
    for (const f of never) expect(p.bindingPath!(r, f), f).toBeNull();
    expect(p.bindingPath!(r, "title.color")).toBe("/container/title/color");
    expect(p.bindingPath!(r, "border.width")).toBe("/container/border/width");
  });

  it("every pointer it offers is a WP-D catalog row, and the registry descriptors are exactly those", () => {
    const offered = Object.values(CONTAINER_BINDING_PATHS).filter((p): p is string => p !== null);
    expect(offered.length).toBeGreaterThan(10);
    for (const p of offered) expect(isBindablePath("floatingRange", p), p).not.toBeNull();
    expect(frBindableDescriptors().map((d) => d.pointer)).toEqual(offered);
    expect(frBindableDescriptors().every((d) => d.group === "Format")).toBe(true);
  });
});

describe("defaults: today's look", () => {
  it("no container background or border, the #f0f0f0 / #333333 one-line title bar, the grid paints its own title", () => {
    const d = frContainerDefaults("Float7");
    expect(d.background.show).toBe(false);
    expect(d.border.show).toBe(false);
    expect(d.title.background).toBe("#f0f0f0");
    expect(d.title.color).toBe("#333333");
    expect(d.title.fontSize).toBe(11);
    expect(d.title.text).toBe("Float7");
    expect(d.paint).toEqual({ background: "core", border: "core", title: "family", shadow: "core" });
  });

  it("an untouched range keeps today's frame exactly: zero insets, a 20px title bar", () => {
    const e = getFloatingRangeById(FR_ID)!;
    expect(frInsets(e)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(frTitleH(e)).toBe(FR_TITLE_H);
    expect(frameWidth(e)).toBeCloseTo(BASE_W, 6);
    expect(frameHeight(e)).toBeCloseTo(BASE_H, 6);
    expect(frInnerBox(e)).toEqual({ x: 0, y: 0, width: frameWidth(e), height: frameHeight(e) });
  });

  it("the region carries the RESOLVED container", () => {
    const c = (region() as ContainerRegion).container!;
    expect(c.title.text).toBe("Float7");
    expect(c.title.show).toBe(true);
    expect(c.paint.title).toBe("family");
  });
});

describe("read: one spelling per fact", () => {
  it("the title text is the NAME and the title toggle is showTitle; the stored container never carries them", () => {
    upsertFromInfo({ ...INFO, showTitle: false, container: { title: { text: "nope", show: true, color: "#ff0000" } } });
    const e = getFloatingRangeById(FR_ID)!;
    expect(e.container).toEqual({ title: { color: "#ff0000" } });
    const p = createFrObjectFormatProvider(deps().d);
    expect(p.read(region())).toEqual({ title: { color: "#ff0000", text: "Float7", show: false } });
    expect(frStoredContainer(e).title).toEqual({ color: "#ff0000", text: "Float7", show: false });
  });

  it("capabilities: padding and an IDENTITY title, no lock aspect, no subtitle or divider, no data format", () => {
    const c = createFrObjectFormatProvider(deps().d).capabilities(region());
    expect(c.padding).toBe(true);
    expect(c.lockAspect).toBe(false);
    expect(c.titleText).toBe("identity");
    expect(c.subtitle).toBe(false);
    expect(c.divider).toBe(false);
    expect(c.dataFormat).toBe(false);
  });
});

describe("commit: three doors", () => {
  it("a new title TEXT is a rename (trimmed), and nothing else is written", async () => {
    const { d, updates, renames } = deps();
    await createFrObjectFormatProvider(d).commit(region(), { title: { text: "  Sales  " } });
    expect(renames).toEqual([[FR_ID, "Sales"]]);
    expect(updates).toEqual([]);
    expect(getFloatingRangeById(FR_ID)!.name).toBe("Sales");
  });

  it("the same name writes nothing; an empty name is refused with a sentence", async () => {
    const { d, updates, renames } = deps();
    const p = createFrObjectFormatProvider(d);
    await p.commit(region(), { title: { text: "Float7" } });
    await expect(p.commit(region(), { title: { text: "   " } })).rejects.toThrow(FR_FORMAT_EMPTY_NAME);
    expect(renames).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("the title toggle is showTitle (null = the default, shown), never a container leaf", async () => {
    const { d, updates } = deps();
    const p = createFrObjectFormatProvider(d);
    await p.commit(region(), { title: { show: false } });
    expect(updates).toEqual([[FR_ID, { showTitle: false }]]);
    expect(frTitleH(getFloatingRangeById(FR_ID)!)).toBe(0);
    await p.commit(region(), { title: { show: null } });
    expect(updates[1]).toEqual([FR_ID, { showTitle: true }]);
    expect(getFloatingRangeById(FR_ID)!.container).toBeUndefined();
  });

  it("every other leaf lands in the container -- ONE update with the toggle when both change", async () => {
    const { d, updates } = deps();
    await createFrObjectFormatProvider(d).commit(region(), {
      title: { show: false, color: "#112233" },
      border: { show: true, width: 2 },
    });
    expect(updates).toEqual([
      [FR_ID, { showTitle: false, container: { title: { color: "#112233" }, border: { show: true, width: 2 } } }],
    ]);
  });

  it("clearing the last leaf sends container null (the record carries no key)", async () => {
    upsertFromInfo({ ...INFO, container: { shadow: { show: true } } });
    const { d, updates } = deps();
    await createFrObjectFormatProvider(d).commit(region(), { shadow: { show: null } });
    expect(updates).toEqual([[FR_ID, { container: null }]]);
  });

  it("an unchanged leaf writes nothing", () => {
    upsertFromInfo({ ...INFO, container: { border: { width: 3 } } });
    const plan = planFrFormatCommit(getFloatingRangeById(FR_ID)!, { border: { width: 3 }, title: { show: true } });
    expect(plan).toEqual({ rename: null, update: null });
  });

  it("a vanished range is refused with a sentence", async () => {
    const { d } = deps({ getEntry: () => null });
    await expect(createFrObjectFormatProvider(d).commit(region(), { border: { show: true } })).rejects.toThrow(
      FR_FORMAT_GONE,
    );
  });
});

describe("padding: the frame GROWS, the cells move in, Core's content rect agrees", () => {
  it("a padding commit grows the derived frame by 2 x padding and moves the first cell in by it", async () => {
    const { d } = deps();
    await createFrObjectFormatProvider(d).commit(region(), {
      padding: { top: 12, right: 12, bottom: 12, left: 12 },
    });
    const e = getFloatingRangeById(FR_ID)!;
    expect(frameWidth(e)).toBeCloseTo(BASE_W + 24, 6);
    expect(frameHeight(e)).toBeCloseTo(BASE_H + 24, 6);
    expect(localCellOrigin(e, 0, 0)).toEqual({ x: 12 + FR_ROW_HDR_W, y: 12 + FR_TITLE_H + FR_COL_HDR_H });
    // The published region is the GROWN frame.
    expect(region().floating!.width).toBeCloseTo(BASE_W + 24, 6);
  });

  it("the grid's own frame IS Core's content rect (border + padding), so Core's band and the layout agree", () => {
    upsertFromInfo({
      ...INFO,
      container: { padding: { top: 12, right: 6, bottom: 3, left: 9 }, border: { show: true, width: 2 } },
    });
    const e = getFloatingRangeById(FR_ID)!;
    const r = region() as ContainerRegion;
    const content = visualContentRect(r);
    const inner = frInnerBox(e);
    expect(content.x - r.floating!.x).toBe(inner.x);
    expect(content.y - r.floating!.y).toBe(inner.y);
    expect(content.width).toBeCloseTo(inner.width, 6);
    expect(content.height).toBeCloseTo(inner.height, 6);
    expect(frInsets(e)).toEqual({ top: 14, right: 8, bottom: 5, left: 11 });
    // A hidden border takes no room.
    upsertFromInfo({ ...INFO, container: { border: { show: false, width: 9 } } });
    expect(frInsets(getFloatingRangeById(FR_ID)!)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it("goes through on a Lock Objects page: formatting is not geometry", async () => {
    unregisterSurface = registerLayoutSurfaceProvider({
      get: (i) =>
        i === 0
          ? {
              snapToGrid: false,
              gridSize: 16,
              showGrid: false,
              page: { width: 1280, height: 720 },
              editable: true,
              pageLockedReason: "The objects on this page are locked.",
            }
          : null,
    });
    expect(frGeometryEditable(FR_ID)).toBe(false);
    const { d, updates } = deps();
    await createFrObjectFormatProvider(d).commit(region(), { padding: { top: 12, right: 12, bottom: 12, left: 12 } });
    expect(updates).toHaveLength(1);
    expect(frameHeight(getFloatingRangeById(FR_ID)!)).toBeCloseTo(BASE_H + 24, 6);
  });
});

describe("the title bar follows the resolved title", () => {
  it("a larger title font grows the bar (never below 20px)", () => {
    upsertFromInfo({ ...INFO, container: { title: { fontSize: 24 } } });
    expect(frTitleH(getFloatingRangeById(FR_ID)!)).toBe(Math.ceil(24 * 1.25) + 6);
    upsertFromInfo({ ...INFO, container: { title: { fontSize: 8 } } });
    expect(frTitleH(getFloatingRangeById(FR_ID)!)).toBe(FR_TITLE_H);
  });

  it("a BOUND title colour paints; a bound value on the name or the toggle never does", () => {
    const bind = (path: string, value: unknown, display: string): void => {
      const r = { object: { kind: "floatingRange", id: FR_ID }, path, value, display, error: null, pending: false };
      resolved.set(`floatingRange:${FR_ID}:${path}`, r as ResolvedBinding);
    };
    bind("/container/title/color", "#00ff00", "#00ff00");
    // Even with a resolved value at the identity pointers (no catalog row
    // exists for them -- a direct write is refused), nothing is overlaid.
    bind("/container/title/text", "Hijack", "Hijack");
    bind("/container/title/show", false, "FALSE");
    invalidateFrContainers();
    const e = getFloatingRangeById(FR_ID)!;
    const c = frContainerOf(e);
    expect(c.title.color).toBe("#00ff00");
    expect(c.title.text).toBe("Float7");
    expect(c.title.show).toBe(true);
    expect(frShowsTitle(e)).toBe(true);
  });
});

describe("preview: transient, restored", () => {
  it("a preview shows on the frame without a write, and endPreview puts the range back", () => {
    const { d, updates } = deps();
    const p = createFrObjectFormatProvider(d);
    p.preview!(region(), { padding: { top: 10, right: 10, bottom: 10, left: 10 }, title: { show: false } });
    const e = getFloatingRangeById(FR_ID)!;
    expect(frameHeight(e)).toBeCloseTo(BASE_H + 20 - FR_TITLE_H, 6);
    expect(frShowsTitle(e)).toBe(false);
    expect(d.republish).toHaveBeenCalled();
    p.endPreview!();
    expect(frameHeight(e)).toBeCloseTo(BASE_H, 6);
    expect(frShowsTitle(e)).toBe(true);
    expect(updates).toEqual([]);
  });
});

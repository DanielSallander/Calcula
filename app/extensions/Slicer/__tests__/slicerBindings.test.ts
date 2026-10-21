//! FILENAME: app/extensions/Slicer/__tests__/slicerBindings.test.ts
// PURPOSE: A slicer's BOUND header (D-BIND S8c, @api/objectBindings):
//            - the renderer PAINTS the resolved header text, never the literal,
//              and the store keeps the literal;
//            - a pending value keeps the literal (no blank flash);
//            - a bound show-header = FALSE hides the header for the painter
//              AND for the hit test (paint == hit, BUG-0258) and gives the
//              region the hover grip;
//            - the registration answers the seam (ref from a region and from a
//              script instance, the two catalog rows), and a binding change of
//              a slicer -- only a slicer -- resyncs the regions and redraws.
// CONTEXT: The REAL seam: values enter its cache the way the bridge puts them
//          there (`applyResolvedValues`), and changes are announced the way the
//          bridge announces them (`notifyBindingsChanged`).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  slicer: null as Record<string, unknown> | null,
}));

vi.mock("../lib/slicerStore", () => ({
  getSlicerById: (id: string) => (id === "s1" ? (h.slicer ?? undefined) : undefined),
  getCachedItems: (id: string) => (id === "s1" ? [{ key: "North", label: "North", selected: true, hasData: true }] : undefined),
}));

vi.mock("@api/objectScriptBadge", () => ({
  drawObjectScriptBadgeIfPresent: () => {},
}));

vi.mock("@api", () => ({
  getSlicerItemBitmap: () => null,
  hasSlicerItemBitmapRenderer: () => false,
}));

import type { OverlayRenderContext, GridRegion } from "@api/gridOverlays";
import type { ResolvedBinding } from "@api/objectBindings";
import { getBindableProperties, bindingRefForInstance } from "@api/objectBindings";
import { applyResolvedValues, notifyBindingsChanged, resetCache } from "@api/objectBindings/cache";
import { renderSlicer, getSlicerHitDetail, resetScrollOffsets } from "../rendering/slicerRenderer";
import {
  SLICER_BINDABLE_PROPERTIES,
  SLICER_REGION_TYPE,
  installSlicerBindings,
  shownSlicer,
  slicerBindingRef,
} from "../lib/slicerBindings";
import { SLICER_REGION_TYPE as SELECTION_REGION_TYPE } from "../lib/slicerObjectSelection";

const B = { x: 100, y: 50, width: 180, height: 240 };
const REF = slicerBindingRef("s1");

function rb(path: string, over: Partial<ResolvedBinding>): ResolvedBinding {
  return { object: REF, path, value: null, display: "", error: null, pending: false, ...over };
}

function recorder(): { ctx: CanvasRenderingContext2D; texts: string[] } {
  const texts: string[] = [];
  const state: Record<string, unknown> = { fillStyle: "", strokeStyle: "", font: "", textAlign: "left", textBaseline: "alphabetic" };
  const ctx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in state) return state[prop];
        return (...args: unknown[]) => {
          if (prop === "fillText") texts.push(String(args[0]));
        };
      },
      set(_t, prop: string, value: unknown) {
        state[prop] = value;
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, texts };
}

function region(): GridRegion {
  return {
    id: "slicer-s1",
    type: "slicer",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 0, y: 0, width: B.width, height: B.height },
    data: { slicerId: "s1" },
  };
}

function paintTexts(): string[] {
  const { ctx, texts } = recorder();
  renderSlicer({
    ctx,
    region: region(),
    config: { rowHeaderWidth: B.x, colHeaderHeight: B.y },
    viewport: { scrollX: 0, scrollY: 0 },
    dimensions: {},
    canvasWidth: 1000,
    canvasHeight: 800,
  } as unknown as OverlayRenderContext);
  return texts;
}

beforeEach(() => {
  resetCache();
  resetScrollOffsets();
  h.slicer = {
    id: "s1",
    name: "Region",
    headerText: "Literal header",
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: B.width,
    height: B.height,
    showHeader: true,
    showSelectAll: false,
    arrangement: "vertical",
    columns: 1,
    itemGap: 4,
    itemPadding: 0,
    selectedItems: null,
    selectionMode: "standard",
    stylePreset: "SlicerStyleLight1",
  };
});

afterEach(() => {
  resetCache();
});

describe("a slicer's bound header text is painted; the literal stays in the store", () => {
  it("control: unbound, the literal header text is painted", () => {
    expect(paintTexts()).toContain("Literal header");
  });

  it("a resolved header text is painted instead of the literal", () => {
    applyResolvedValues([rb("/headerText", { value: "Revenue 2025", display: "Revenue 2025" })]);
    const texts = paintTexts();
    expect(texts).toContain("Revenue 2025");
    expect(texts).not.toContain("Literal header");
    // The store's record is never rewritten by a resolved value.
    expect(h.slicer!.headerText).toBe("Literal header");
  });

  it("a TEXT binding in error paints its error display (a header that cannot resolve says so)", () => {
    applyResolvedValues([rb("/headerText", { value: null, display: "#REF!", error: "The cell was deleted." })]);
    expect(paintTexts()).toContain("#REF!");
  });

  it("a PENDING value keeps the literal (no blank flash)", () => {
    applyResolvedValues([rb("/headerText", { pending: true })]);
    expect(paintTexts()).toContain("Literal header");
  });

  it("another slicer's binding paints nothing here", () => {
    applyResolvedValues([
      { ...rb("/headerText", { value: "Other", display: "Other" }), object: slicerBindingRef("s2") },
    ]);
    expect(paintTexts()).toContain("Literal header");
  });
});

describe("a bound show-header hides the header for the painter AND the hit test", () => {
  it("control: the stored header is painted and a press at its height hits the header", () => {
    expect(paintTexts()).toContain("Literal header");
    expect(getSlicerHitDetail(B.x + 20, B.y + 10, B, "s1")).toEqual({ type: "header" });
  });

  it("bound to FALSE: no header is painted and the same press is no longer a header press", () => {
    applyResolvedValues([rb("/showHeader", { value: false, display: "FALSE" })]);
    expect(paintTexts()).not.toContain("Literal header");
    expect(getSlicerHitDetail(B.x + 20, B.y + 10, B, "s1")).not.toEqual({ type: "header" });
    // The first item now sits at the top, where the header was.
    expect(getSlicerHitDetail(B.x + 20, B.y + 10, B, "s1")).toEqual({ type: "item", itemIndex: 0, itemValue: "North" });
    expect(h.slicer!.showHeader).toBe(true);
  });

  it("a non-text binding in ERROR keeps the literal show-header", () => {
    applyResolvedValues([rb("/showHeader", { value: null, display: "#VALUE!", error: "Not TRUE or FALSE." })]);
    expect(getSlicerHitDetail(B.x + 20, B.y + 10, B, "s1")).toEqual({ type: "header" });
  });

  it("shownSlicer returns the very record when nothing is bound, and never mutates it", () => {
    const s = h.slicer as { id: string; showHeader: boolean };
    expect(shownSlicer(s)).toBe(s);
    applyResolvedValues([rb("/showHeader", { value: false })]);
    const shown = shownSlicer(s);
    expect(shown).not.toBe(s);
    expect(shown.showHeader).toBe(false);
    expect(s.showHeader).toBe(true);
    expect(shownSlicer(shown)).toEqual(shown);
  });
});

describe("the slicer registration and the repaint on change", () => {
  let uninstall: (() => void) | null = null;
  const deps = {
    slicerExists: vi.fn((id: string) => id === "s1"),
    resyncRegions: vi.fn(),
    redraw: vi.fn(),
  };

  beforeEach(() => {
    deps.resyncRegions.mockClear();
    deps.redraw.mockClear();
    uninstall = installSlicerBindings(deps);
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("registers for the region type the slicer publishes its regions as", () => {
    expect(SLICER_REGION_TYPE).toBe(SELECTION_REGION_TYPE);
  });

  it("a slicer region -> its ref and the two catalog rows", async () => {
    const answer = await getBindableProperties(region());
    expect(answer?.ref).toEqual({ kind: "slicer", id: "s1" });
    expect(answer?.properties.map((p) => p.pointer)).toEqual(["/headerText", "/showHeader"]);
    expect(answer?.properties).toEqual(SLICER_BINDABLE_PROPERTIES);
  });

  it("a script's slicer instance -> its ref; an unknown id -> null", async () => {
    expect(await bindingRefForInstance("slicer", "s1")).toEqual({ kind: "slicer", id: "s1" });
    expect(await bindingRefForInstance("slicer", "nope")).toBeNull();
  });

  it("a binding change of a slicer resyncs the regions and redraws", () => {
    notifyBindingsChanged({ objects: [REF], reload: false });
    expect(deps.resyncRegions).toHaveBeenCalledTimes(1);
    expect(deps.redraw).toHaveBeenCalledTimes(1);
  });

  it("a reload redraws too", () => {
    notifyBindingsChanged({ objects: [], reload: true });
    expect(deps.redraw).toHaveBeenCalledTimes(1);
  });

  it("a CHART's binding change does not touch the slicers", () => {
    notifyBindingsChanged({ objects: [{ kind: "chart", id: "c1" }], reload: false });
    expect(deps.resyncRegions).not.toHaveBeenCalled();
    expect(deps.redraw).not.toHaveBeenCalled();
  });

  it("after uninstall nothing is registered or listened to", async () => {
    uninstall?.();
    uninstall = null;
    expect(await getBindableProperties(region())).toBeNull();
    notifyBindingsChanged({ objects: [REF], reload: false });
    expect(deps.redraw).not.toHaveBeenCalled();
  });
});

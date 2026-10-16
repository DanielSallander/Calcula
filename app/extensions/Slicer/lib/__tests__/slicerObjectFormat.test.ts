//! FILENAME: app/extensions/Slicer/lib/__tests__/slicerObjectFormat.test.ts
// PURPOSE: The slicer's visual-container provider (WP-C S11, D-FORMAT):
//            - MAPPING: the title text / show ARE headerText / showHeader (one
//              spelling per fact); every other leaf lives in `container`, which
//              never carries the title's text or visibility;
//            - ONE update call per commit carrying headerText, showHeader and
//              container together, and NONE for a patch that changes nothing;
//            - DEFAULTS from the slicer's style preset (background, border,
//              header colours), 3 px corners, a 12 pt bold title, and the paint
//              split (Core paints background / border / shadow, the slicer its
//              header);
//            - the header's height follows the title font, and the content box
//              is Core's (border inset, then padding);
//            - bindings: `bindingPath` answers FROM the exported table, and a
//              bound header text reaches the resolved title;
//            - preview: shown without a write, and ended by endPreview.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { GridRegion } from "@api/gridOverlays";
import type { ResolvedBinding } from "@api/objectBindings";
import { applyResolvedValues, resetCache } from "@api/objectBindings/cache";
import { VISUAL_CONTAINER_FIELD_IDS, lineHeightFor } from "@api/visualContainer";
import { resetPaintedContainerLayouts } from "@api/visualContainerPaint";
import { slicerStyleColors } from "../slicerStyles";
import type { Slicer, UpdateSlicerParams } from "../slicerTypes";
import {
  CONTAINER_BINDING_PATHS,
  createSlicerObjectFormatProvider,
  readSlicerContainer,
  resetSlicerFormatPreviews,
  resolveSlicerContainer,
  slicerContainerDefaults,
  slicerContentBox,
  slicerHeaderHeight,
  slicerUpdateFor,
} from "../slicerObjectFormat";

function slicer(over: Partial<Slicer> = {}): Slicer {
  return {
    id: "s1",
    name: "Region",
    headerText: null,
    sheetIndex: 0,
    x: 10,
    y: 20,
    width: 180,
    height: 240,
    sourceType: "pivot",
    cacheSourceId: "p1",
    fieldName: "Region",
    selectedItems: null,
    showHeader: true,
    columns: 1,
    stylePreset: "slicer-dark-3",
    selectionMode: "standard",
    hideNoData: false,
    indicateNoData: true,
    sortNoDataLast: true,
    forceSelection: false,
    showSelectAll: false,
    arrangement: "vertical",
    rows: 3,
    itemGap: 4,
    autogrid: true,
    itemPadding: 0,
    buttonRadius: 2,
    connectedSources: [],
    filterLevel: 1,
    ...over,
  };
}

const REGION: GridRegion = {
  id: "slicer-s1",
  type: "slicer",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 10, y: 20, width: 180, height: 240 },
  data: { slicerId: "s1" },
};

let current: Slicer;
const update = vi.fn(async (_id: string, _params: UpdateSlicerParams) => {});
const resync = vi.fn();

function provider() {
  return createSlicerObjectFormatProvider({
    getSlicer: (id) => (id === current.id ? current : undefined),
    update,
    resync,
  });
}

beforeEach(() => {
  current = slicer();
  update.mockClear();
  resync.mockClear();
  resetCache();
  resetSlicerFormatPreviews();
  resetPaintedContainerLayouts();
});

describe("mapping: one spelling per fact", () => {
  it("reads the title text / show from headerText / showHeader, the rest from container", () => {
    const s = slicer({
      headerText: "Pick a region",
      showHeader: false,
      container: { padding: { top: 6 }, border: { radius: 8 } },
    });
    expect(readSlicerContainer(s)).toEqual({
      padding: { top: 6 },
      border: { radius: 8 },
      title: { show: false, text: "Pick a region" },
    });
    // No header text stored: no title.text (the default, the slicer's name).
    expect(readSlicerContainer(slicer()).title).toEqual({ show: true });
  });

  it("a container that carries title text / show itself is never READ for them", () => {
    const s = slicer({ headerText: null, container: { title: { text: "stale", show: false, bold: false } } });
    expect(readSlicerContainer(s).title).toEqual({ show: true, bold: false });
  });

  it("splits a patch into headerText, showHeader and a container without them", () => {
    const params = slicerUpdateFor(current, {
      title: { text: "Regions", show: false, fontSize: 18 },
      padding: { left: 12 },
    });
    expect(params).toEqual({
      headerText: "Regions",
      showHeader: false,
      container: { title: { fontSize: 18 }, padding: { left: 12 } },
    });
  });

  it("a cleared title text goes back to the name (null); a cleared show is shown", () => {
    current = slicer({ headerText: "Custom", showHeader: false });
    expect(slicerUpdateFor(current, { title: { text: null, show: null } })).toEqual({
      headerText: null,
      showHeader: true,
    });
  });

  it("a patch that changes nothing makes no update", () => {
    current = slicer({ headerText: "Same", container: { border: { radius: 5 } } });
    expect(slicerUpdateFor(current, { title: { text: "Same", show: true }, border: { radius: 5 } })).toBeNull();
  });

  it("clearing the last container leaf sends container null (the record keeps no key)", () => {
    current = slicer({ container: { padding: { top: 4 } } });
    expect(slicerUpdateFor(current, { padding: { top: null } })).toEqual({ container: null });
  });
});

describe("the provider's commit: ONE update_slicer", () => {
  it("one call carries headerText, showHeader and container together", async () => {
    await provider().commit(REGION, { title: { text: "Area", show: true, color: "#112233" }, shadow: { show: true } });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("s1", {
      headerText: "Area",
      container: { title: { color: "#112233" }, shadow: { show: true } },
    });
  });

  it("a patch that changes nothing calls nothing", async () => {
    await provider().commit(REGION, { title: { show: true } });
    expect(update).not.toHaveBeenCalled();
  });

  it("a slicer that is gone is refused with a sentence, and nothing is written", async () => {
    const gone = { ...REGION, data: { slicerId: "nope" } };
    await expect(provider().commit(gone, { padding: { top: 2 } })).rejects.toThrow("The slicer no longer exists.");
    expect(update).not.toHaveBeenCalled();
  });

  it("the backend's refusal reaches the caller as the rejection", async () => {
    update.mockRejectedValueOnce(new Error("Slicer title color must be empty or a #rgb, #rrggbb or #rrggbbaa colour."));
    await expect(provider().commit(REGION, { title: { color: "#123" } })).rejects.toThrow(/colour/);
  });
});

describe("defaults come from the style preset", () => {
  it("background, border, header colours from the preset; 3 px corners; 12 pt bold; the paint split", () => {
    const colors = slicerStyleColors("slicer-dark-3");
    const d = slicerContainerDefaults(current);
    expect(d.background).toEqual({ show: true, color: colors.bg, alpha: 1, gradient: null });
    expect(d.border).toEqual({ show: true, color: colors.border, width: 1, radius: 3 });
    expect(d.title).toMatchObject({
      show: true,
      text: "Region",
      color: colors.headerFg,
      background: colors.headerBg,
      fontSize: 12,
      bold: true,
      align: "left",
    });
    expect(d.paint).toEqual({ background: "core", border: "core", title: "family", shadow: "core" });
    // Another preset, other colours: the defaults follow the preset.
    const light = slicerContainerDefaults(slicer({ stylePreset: "slicer-light-2" }));
    expect(light.title.background).toBe(slicerStyleColors("slicer-light-2").headerBg);
    expect(light.title.background).not.toBe(d.title.background);
  });

  it("the provider's defaults are the same", () => {
    expect(provider().defaults(REGION)).toEqual(slicerContainerDefaults(current));
  });
});

describe("the content box: Core's rect, the header from the title font", () => {
  it("the header is 32 px at the default 12 pt and grows with a bigger title", () => {
    expect(slicerHeaderHeight(resolveSlicerContainer(current))).toBe(32);
    current = slicer({ container: { title: { fontSize: 18 } } });
    expect(slicerHeaderHeight(resolveSlicerContainer(current))).toBe(Math.max(32, lineHeightFor(18) + 12));
    expect(slicerHeaderHeight(resolveSlicerContainer(slicer({ showHeader: false })))).toBe(0);
  });

  it("the content is inset by the border, then the padding", () => {
    const box = slicerContentBox(slicer({ container: { padding: { top: 12, right: 12, bottom: 12, left: 12 } } }), 180, 240);
    expect({ x: box.x, y: box.y, width: box.width, height: box.height }).toEqual({ x: 13, y: 13, width: 154, height: 214 });
    // Border hidden: the padding alone.
    const bare = slicerContentBox(slicer({ container: { border: { show: false } } }), 180, 240);
    expect({ x: bare.x, y: bare.y, width: bare.width, height: bare.height }).toEqual({ x: 0, y: 0, width: 180, height: 240 });
  });

  it("custom spacing below the title moves the items, not the header", () => {
    const box = slicerContentBox(slicer({ container: { spacing: { custom: true, belowTitle: 10 } } }), 180, 240);
    expect(box.headerH).toBe(32);
    expect(box.itemsTop).toBe(42);
  });
});

describe("bindings", () => {
  it("bindingPath answers FROM the exported table, for every field", () => {
    const p = provider();
    for (const field of VISUAL_CONTAINER_FIELD_IDS) {
      expect(p.bindingPath!(REGION, field), field).toBe(CONTAINER_BINDING_PATHS[field]);
    }
    expect(CONTAINER_BINDING_PATHS["title.text"]).toBe("/headerText");
    expect(CONTAINER_BINDING_PATHS["title.show"]).toBe("/showHeader");
    expect(CONTAINER_BINDING_PATHS.lockAspect).toBeNull();
    expect(CONTAINER_BINDING_PATHS["subtitle.text"]).toBeNull();
  });

  it("a BOUND header text and colour reach the resolved title (bound > stored)", () => {
    current = slicer({ headerText: "Literal", container: { title: { color: "#000000" } } });
    const ref = { kind: "slicer" as const, id: "s1" };
    const rb = (path: string, value: unknown, display: string): ResolvedBinding => ({
      object: ref,
      path,
      value,
      display,
      error: null,
      pending: false,
    });
    applyResolvedValues([rb("/headerText", "Bound", "Bound"), rb("/container/title/color", "#ff0000", "#ff0000")]);
    const c = resolveSlicerContainer(current);
    expect(c.title.text).toBe("Bound");
    expect(c.title.color).toBe("#ff0000");
    // The literal is still what the Format tab reads.
    expect(provider().read(REGION).title).toMatchObject({ text: "Literal", color: "#000000" });
  });
});

describe("preview: shown, never written", () => {
  it("a preview shows in the resolved container and is gone after endPreview", () => {
    const p = provider();
    p.preview!(REGION, { border: { radius: 12 }, title: { text: "Preview" } });
    expect(resolveSlicerContainer(current).border.radius).toBe(12);
    expect(resolveSlicerContainer(current).title.text).toBe("Preview");
    expect(resync).toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    p.endPreview!();
    expect(resolveSlicerContainer(current).border.radius).toBe(3);
    expect(resolveSlicerContainer(current).title.text).toBe("Region");
  });

  it("a commit ends the preview first", async () => {
    const p = provider();
    p.preview!(REGION, { border: { radius: 12 } });
    await p.commit(REGION, { border: { radius: 9 } });
    expect(update).toHaveBeenCalledWith("s1", { container: { border: { radius: 9 } } });
    expect(resolveSlicerContainer(current).border.radius).toBe(3);
  });
});

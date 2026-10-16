//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotStylePersist.test.tsx
// PURPOSE: The PERSISTED PivotTable style (WP-C S10, D-FORMAT "persist the
//          pivot style"):
//          - a gallery choice is ONE `update_pivot_properties { pivotId, style }`
//            and NO PIVOT_LAYOUT_CHANGED (which would schedule a full fields
//            update) -- also when it arrives through the Design sections'
//            shared `updateSharedLayout({ styleId })`; a mixed patch has its
//            styleId stripped from what is broadcast;
//          - the map is SEEDED from every region refresh (`PivotRegionData.style`
//            -- how an undo comes back), and the painter reads it;
//          - an unchanged style is never sent (BUG-0477), a gallery click keeps
//            the user's colour overrides, null clears to the default style,
//            and a bad override is refused before anything is sent;
//          - a layout change with no mounted editor is sent HEADLESSLY, with
//            one the editor sends it (one sender, never two).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  updatePivotProperties: vi.fn(async (_req: unknown) => ({})),
  emitted: [] as Array<[string, unknown]>,
  listeners: new Map<string, Set<(d: unknown) => void>>(),
  headless: vi.fn(async (_id: string, _patch: unknown) => ({})),
  readLayout: vi.fn(async (_id: string): Promise<Record<string, unknown> | null> => null),
  state: null as unknown,
  toasts: [] as string[],
}));

vi.mock("@api", () => ({
  onAppEvent: (event: string, cb: (d: unknown) => void) => {
    let set = h.listeners.get(event);
    if (!set) h.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  },
  emitAppEvent: (event: string, detail: unknown) => {
    h.emitted.push([event, detail]);
    for (const cb of [...(h.listeners.get(event) ?? [])]) cb(detail);
  },
  showToast: (m: string) => h.toasts.push(m),
}));
vi.mock("../pivot-api", () => ({
  updatePivotProperties: h.updatePivotProperties,
  getPivotTableInfo: vi.fn(async () => ({ sourceRange: "A1:B2" })),
}));
vi.mock("../../handlers/selectionHandler", () => ({ getActivePivotId: () => "p1" }));
vi.mock("../pivotLayoutEdits", () => ({ editPivotLayoutHeadless: h.headless, readPivotLayout: h.readLayout }));

import {
  effectivePivotStyle,
  getPersistedPivotStyle,
  resetPersistedPivotStyles,
  seedPivotStylesFromRegions,
  setPivotOverridePreview,
  setPivotStyle,
  subscribePersistedPivotStyles,
} from "../pivotStylePersist";
import { setPivotStylePreview } from "../pivotStyles";
import { updateSharedLayout, usePivotPanelState } from "../pivotPanelStore";
import { notePivotEditorMounted, resetPivotEditorPresence } from "../pivotEditorPresence";
import { PivotEvents } from "../../../_shared/lib/pivotEvents";
import type { PivotRegionData } from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const region = (pivotId: string, style?: PivotRegionData["style"]): PivotRegionData =>
  ({ pivotId, name: pivotId, startRow: 0, startCol: 0, endRow: 3, endCol: 3, isEmpty: false, isModel: false, ...(style ? { style } : {}) }) as PivotRegionData;

const flush = () => act(async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
});

let container: HTMLDivElement;
let root: Root;

/** Mount a Design section's store subscription (attaches the shared store, active pivot p1). */
function Probe(): React.ReactElement {
  h.state = usePivotPanelState();
  return <div />;
}

beforeEach(async () => {
  h.readLayout.mockReset();
  h.readLayout.mockResolvedValue(null);
  resetPersistedPivotStyles();
  resetPivotEditorPresence();
  setPivotStylePreview(null, null);
  h.updatePivotProperties.mockClear();
  h.headless.mockClear();
  h.emitted = [];
  h.toasts = [];
  h.listeners.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const layoutChanged = () => h.emitted.filter(([e]) => e === PivotEvents.PIVOT_LAYOUT_CHANGED);

describe("setPivotStyle -- THE style door", () => {
  it("a gallery choice is ONE update_pivot_properties with the style, and the map follows", async () => {
    await setPivotStyle("p1", "PivotStyleDark1");
    expect(h.updatePivotProperties).toHaveBeenCalledTimes(1);
    expect(h.updatePivotProperties).toHaveBeenCalledWith({ pivotId: "p1", style: { styleId: "PivotStyleDark1" } });
    expect(getPersistedPivotStyle("p1")).toEqual({ styleId: "PivotStyleDark1" });
    expect(layoutChanged()).toEqual([]);
  });

  it("an UNCHANGED style is never sent (BUG-0477: the door dirties the document on a no-op)", async () => {
    seedPivotStylesFromRegions([region("p1", { styleId: "PivotStyleDark1" })]);
    await setPivotStyle("p1", "PivotStyleDark1");
    await setPivotStyle("p2", null);
    expect(h.updatePivotProperties).not.toHaveBeenCalled();
  });

  it("a gallery click KEEPS the user's overrides; explicit overrides replace them; null clears to the default style", async () => {
    seedPivotStylesFromRegions([region("p1", { styleId: "PivotStyleLight1", themeOverrides: { headerBackground: "#112233" } })]);
    await setPivotStyle("p1", "PivotStyleDark1");
    expect(h.updatePivotProperties).toHaveBeenLastCalledWith({
      pivotId: "p1",
      style: { styleId: "PivotStyleDark1", themeOverrides: { headerBackground: "#112233" } },
    });
    await setPivotStyle("p1", "PivotStyleDark1", { headerBackground: null, borderColor: "#ABCDEF" });
    expect(h.updatePivotProperties).toHaveBeenLastCalledWith({
      pivotId: "p1",
      style: { styleId: "PivotStyleDark1", themeOverrides: { borderColor: "#abcdef" } },
    });
    await setPivotStyle("p1", null);
    expect(h.updatePivotProperties).toHaveBeenLastCalledWith({ pivotId: "p1", style: null });
    expect(getPersistedPivotStyle("p1")).toBeNull();
  });

  it("an override the backend would refuse is refused HERE, before anything is sent", async () => {
    await expect(setPivotStyle("p1", "PivotStyleDark1", { headerFontWeight: "#000000" })).rejects.toThrow("not a PivotTable style colour");
    await expect(setPivotStyle("p1", "PivotStyleDark1", { headerText: "red" })).rejects.toThrow("#rrggbb");
    expect(h.updatePivotProperties).not.toHaveBeenCalled();
  });

  it("a refused write changes nothing", async () => {
    h.updatePivotProperties.mockRejectedValueOnce(new Error("refused"));
    await expect(setPivotStyle("p1", "PivotStyleDark1")).rejects.toThrow("refused");
    expect(getPersistedPivotStyle("p1")).toBeNull();
  });
});

describe("seeding and what paints", () => {
  it("the map is SEEDED from each region refresh: set, changed, and back to the default when the region carries none", () => {
    const seen = vi.fn();
    const off = subscribePersistedPivotStyles(seen);
    expect(seedPivotStylesFromRegions([region("p1", { styleId: "PivotStyleMedium9" }), region("p2")])).toBe(true);
    expect(getPersistedPivotStyle("p1")).toEqual({ styleId: "PivotStyleMedium9" });
    expect(seedPivotStylesFromRegions([region("p1", { styleId: "PivotStyleMedium9" })]), "same again: no announcement").toBe(false);
    // An undo's refresh: the region comes back without a style.
    expect(seedPivotStylesFromRegions([region("p1")])).toBe(true);
    expect(getPersistedPivotStyle("p1")).toBeNull();
    expect(seen).toHaveBeenCalledTimes(2);
    off();
  });

  it("the painter reads the persisted style; a gallery hover and an open colour picker preview over it, transiently", () => {
    seedPivotStylesFromRegions([region("p1", { styleId: "PivotStyleMedium9", themeOverrides: { borderColor: "#010203" } })]);
    expect(effectivePivotStyle("p1")).toEqual({ styleId: "PivotStyleMedium9", overrides: { borderColor: "#010203" } });
    setPivotStylePreview("p1", "PivotStyleDark1");
    setPivotOverridePreview("p1", { headerText: "#ffffff" });
    expect(effectivePivotStyle("p1")).toEqual({
      styleId: "PivotStyleDark1",
      overrides: { borderColor: "#010203", headerText: "#ffffff" },
    });
    setPivotStylePreview(null, null);
    setPivotOverridePreview("p1", null);
    expect(effectivePivotStyle("p1").styleId).toBe("PivotStyleMedium9");
    expect(h.updatePivotProperties, "previews write nothing").not.toHaveBeenCalled();
    expect(effectivePivotStyle("unknown")).toEqual({ styleId: "", overrides: {} });
  });
});

describe("updateSharedLayout (the Design sections' shared door)", () => {
  async function activate(): Promise<void> {
    // The editor's own broadcast makes the layout state active (as on a real pivot).
    await act(async () => {
      for (const cb of [...(h.listeners.get(PivotEvents.PIVOT_LAYOUT_STATE) ?? [])]) {
        cb({ pivotId: "p1", layout: { showRowGrandTotals: true } });
      }
    });
  }

  it("a styleId-only patch goes to the style door: ONE update_pivot_properties and NO PIVOT_LAYOUT_CHANGED", async () => {
    await activate();
    updateSharedLayout({ styleId: "PivotStyleDark2" });
    await flush();
    expect(h.updatePivotProperties).toHaveBeenCalledTimes(1);
    expect(h.updatePivotProperties).toHaveBeenCalledWith({ pivotId: "p1", style: { styleId: "PivotStyleDark2" } });
    expect(layoutChanged()).toEqual([]);
    expect(h.headless).not.toHaveBeenCalled();
    // "" (Clear) is the default style.
    updateSharedLayout({ styleId: "" });
    await flush();
    expect(h.updatePivotProperties).toHaveBeenLastCalledWith({ pivotId: "p1", style: null });
  });

  it("a mixed patch: the style goes to its door, the rest is broadcast WITHOUT styleId to the mounted editor", async () => {
    await activate();
    const unmount = notePivotEditorMounted("p1");
    updateSharedLayout({ styleId: "PivotStyleDark3", showRowGrandTotals: false });
    await flush();
    expect(h.updatePivotProperties).toHaveBeenCalledTimes(1);
    const changed = layoutChanged();
    expect(changed).toHaveLength(1);
    expect(changed[0][1]).toEqual({ pivotId: "p1", layout: { showRowGrandTotals: false } });
    expect(h.headless).not.toHaveBeenCalled();
    unmount();
  });

  it("with NO editor mounted a layout change is sent headlessly (and not broadcast to nobody)", async () => {
    await activate();
    updateSharedLayout({ reportLayout: "tabular" });
    await flush();
    expect(h.headless).toHaveBeenCalledWith("p1", { reportLayout: "tabular" });
    expect(layoutChanged()).toEqual([]);
  });
});

describe("the sections show the pivot's REAL layout even with no editor mounted", () => {
  const layoutOf = () => (h.state as { layoutState: { layout: Record<string, unknown> } | null }).layoutState?.layout;

  it("an empty announcement with no editor mounted is filled from the definition", async () => {
    h.readLayout.mockResolvedValue({ showRowGrandTotals: false, reportLayout: "tabular" });
    await act(async () => {
      for (const cb of [...(h.listeners.get(PivotEvents.PIVOT_LAYOUT_STATE) ?? [])]) cb({ pivotId: "p1", layout: {} });
    });
    await flush();
    expect(h.readLayout).toHaveBeenCalledWith("p1");
    expect(layoutOf()).toEqual({ showRowGrandTotals: false, reportLayout: "tabular" });
  });

  it("with an editor mounted nothing is read: the editor states its own layout", async () => {
    h.readLayout.mockClear();
    const unmount = notePivotEditorMounted("p1");
    await act(async () => {
      for (const cb of [...(h.listeners.get(PivotEvents.PIVOT_LAYOUT_STATE) ?? [])]) cb({ pivotId: "p1", layout: {} });
    });
    await flush();
    expect(h.readLayout).not.toHaveBeenCalled();
    unmount();
  });

  it("a layout stated meanwhile (an edit) is newer and is not overwritten", async () => {
    let resolve!: (v: Record<string, unknown>) => void;
    h.readLayout.mockReturnValue(new Promise((r) => (resolve = r)));
    await act(async () => {
      for (const cb of [...(h.listeners.get(PivotEvents.PIVOT_LAYOUT_STATE) ?? [])]) cb({ pivotId: "p1", layout: {} });
    });
    await act(async () => {
      for (const cb of [...(h.listeners.get(PivotEvents.PIVOT_LAYOUT_STATE) ?? [])]) cb({ pivotId: "p1", layout: { valuesPosition: "rows" } });
    });
    await act(async () => resolve({ valuesPosition: "columns" }));
    await flush();
    expect(layoutOf()).toMatchObject({ valuesPosition: "rows" });
  });
});

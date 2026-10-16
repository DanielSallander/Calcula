//! FILENAME: app/extensions/CanvasSheet/__tests__/canvasPageBindings.test.ts
// PURPOSE: A canvas PAGE's bound colours (D-BIND S8c, @api/objectBindings),
//          read from the REAL page painter and the REAL store:
//            - a resolved background / wallpaper is PAINTED instead of the
//              literal, and the store keeps the literal;
//            - a pending value and an error (both rows are colours, never
//              text) keep the literal; another page's binding paints nothing;
//            - the canvasPage registration turns a page region (by SheetId or
//              by sheet index) into the page's ref and offers the two rows;
//            - a page's binding change redraws; another kind's does not.
// CONTEXT: The real seam cache, filled the way the bridge fills it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CanvasLayout, SheetsResult } from "@api";

const getSheets = vi.fn<() => Promise<SheetsResult>>();
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getSheets: () => getSheets(),
}));

vi.mock("@api/collaboration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/collaboration")>()),
  getSheetProvenance: () => Promise.resolve([]),
}));

let gridSnapshot: Record<string, unknown> | null = null;
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => gridSnapshot,
}));

import type { ResolvedBinding } from "@api/objectBindings";
import { getBindableProperties } from "@api/objectBindings";
import { applyResolvedValues, notifyBindingsChanged, resetCache } from "@api/objectBindings/cache";
import { CANVAS_PAGE_REGION_TYPE, canvasPageRegion, defaultCanvasLayout } from "@api/canvasSheet";
import { canvasAt, refreshCanvasSheets, resetCanvasSheetStore } from "../lib/canvasSheetStore";
import { paintCanvasPage, type PagePalette } from "../lib/pagePainter";
import {
  CANVAS_PAGE_BINDABLE_PROPERTIES,
  canvasPageBindingRef,
  canvasPageRefOfRegion,
  installCanvasPageBindings,
} from "../lib/canvasBindings";

const PALETTE: PagePalette = { outside: "#o", page: "#p", border: "#b", dot: "#d" };
const PAGE = canvasPageBindingRef("cv-1");

function layout(over: Partial<CanvasLayout> = {}): CanvasLayout {
  return { ...defaultCanvasLayout(), ...over };
}

function rb(path: string, over: Partial<ResolvedBinding>, object = PAGE): ResolvedBinding {
  return { object, path, value: null, display: "", error: null, pending: false, ...over };
}

/** The fills of the surround (first) and the page (second). */
function paintFills(): { surround: string; page: string } {
  const calls: string[] = [];
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    fillRect() {
      calls.push(String(this.fillStyle));
    },
    strokeRect: vi.fn(),
  };
  paintCanvasPage(
    {
      ctx,
      config: { rowHeaderWidth: 0, colHeaderHeight: 0 },
      viewport: { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 0, colCount: 0 },
      dimensions: {},
      canvasWidth: 400,
      canvasHeight: 300,
      freezeConfig: null,
    } as never,
    PALETTE,
    1,
  );
  return { surround: calls[0], page: calls[1] };
}

beforeEach(async () => {
  resetCache();
  resetCanvasSheetStore();
  gridSnapshot = { surface: "canvas", sheetContext: { activeSheetIndex: 1 }, zoom: 1 };
  getSheets.mockReset();
  getSheets.mockResolvedValue({
    activeIndex: 1,
    sheets: [
      { index: 0, name: "Data", visibility: "visible", sheetId: "ws-0" },
      {
        index: 1,
        name: "Dashboard",
        visibility: "visible",
        sheetId: "cv-1",
        kind: "canvas",
        canvasLayout: layout({ background: "#fafafa", wallpaper: "#204060" }),
      },
    ],
  });
  await refreshCanvasSheets();
});

afterEach(() => {
  resetCache();
});

describe("a page's bound background and wallpaper are painted; the literal stays in the store", () => {
  it("control: unbound, the literal colours are painted", () => {
    expect(paintFills()).toEqual({ surround: "#204060", page: "#fafafa" });
  });

  it("a resolved background paints the page; a resolved wallpaper paints the surround", () => {
    applyResolvedValues([
      rb("/background", { value: "#112233", display: "#112233" }),
      rb("/wallpaper", { value: "#445566", display: "#445566" }),
    ]);
    expect(paintFills()).toEqual({ surround: "#445566", page: "#112233" });
    // The store's layout is never rewritten by a resolved value.
    expect(canvasAt(1)?.layout.background).toBe("#fafafa");
    expect(canvasAt(1)?.layout.wallpaper).toBe("#204060");
  });

  it("a wallpaper bound on a page that has none of its own still paints", async () => {
    getSheets.mockResolvedValue({
      activeIndex: 1,
      sheets: [{ index: 1, name: "D", visibility: "visible", sheetId: "cv-1", kind: "canvas", canvasLayout: layout() }],
    });
    await refreshCanvasSheets();
    expect(paintFills().surround).toBe("#o");
    applyResolvedValues([rb("/wallpaper", { value: "rgb(10,20,30)", display: "rgb(10,20,30)" })]);
    expect(paintFills().surround).toBe("rgb(10,20,30)");
  });

  it("a PENDING value or an ERROR keeps the literal (a colour slot never paints an error)", () => {
    applyResolvedValues([
      rb("/background", { pending: true }),
      rb("/wallpaper", { value: null, display: "#VALUE!", error: "Not a colour." }),
    ]);
    expect(paintFills()).toEqual({ surround: "#204060", page: "#fafafa" });
  });

  it("another page's binding paints nothing here", () => {
    applyResolvedValues([rb("/background", { value: "#112233" }, canvasPageBindingRef("cv-9"))]);
    expect(paintFills().page).toBe("#fafafa");
  });
});

describe("the canvasPage registration and the repaint on change", () => {
  let uninstall: (() => void) | null = null;
  const redraw = vi.fn();

  beforeEach(() => {
    redraw.mockClear();
    uninstall = installCanvasPageBindings(redraw);
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("a page region by SheetId -> its ref and the two catalog rows", async () => {
    const answer = await getBindableProperties(canvasPageRegion(1, "cv-1"));
    expect(answer?.ref).toEqual({ kind: "canvasPage", id: "cv-1" });
    expect(answer?.properties).toEqual(CANVAS_PAGE_BINDABLE_PROPERTIES);
  });

  it("a page region by sheet INDEX resolves the SheetId from the store; a worksheet index has no ref", () => {
    expect(canvasPageRefOfRegion(canvasPageRegion(1))).toEqual({ kind: "canvasPage", id: "cv-1" });
    expect(canvasPageRefOfRegion(canvasPageRegion(0))).toBeNull();
    expect(canvasPageRefOfRegion({ ...canvasPageRegion(1), type: "chart" })).toBeNull();
    expect(canvasPageRegion(1).type).toBe(CANVAS_PAGE_REGION_TYPE);
  });

  it("a page's binding change redraws; a chart's does not", () => {
    notifyBindingsChanged({ objects: [{ kind: "chart", id: "c1" }], reload: false });
    expect(redraw).not.toHaveBeenCalled();
    notifyBindingsChanged({ objects: [PAGE], reload: false });
    expect(redraw).toHaveBeenCalledTimes(1);
    notifyBindingsChanged({ objects: [], reload: true });
    expect(redraw).toHaveBeenCalledTimes(2);
  });
});

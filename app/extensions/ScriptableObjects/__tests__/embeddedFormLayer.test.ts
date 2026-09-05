//! FILENAME: app/extensions/ScriptableObjects/__tests__/embeddedFormLayer.test.ts
// PURPOSE: The pixels half of M3c, on the one question the grid cannot answer
//          for it: WHICH SHEET is this surface on? A `GridRegion` carries no
//          sheet dimension and the Core renderer hands every published region of
//          a type to the overlay that owns it, so a layer that publishes its
//          whole store paints every form in the workbook on every sheet.
// CONTEXT: Everything the layer touches outside the DOM is doubled — the overlay
//          registry, the region store, the geometry helpers and the event bus —
//          so the render pass can be driven by hand, exactly as the Core
//          renderer drives it, and the host element inspected afterwards. The
//          PLACEMENT store is the real one (`@api/scriptHost/embeddedFormPlacements`
//          is a leaf module): the filter under test is a query against it.
//
//          THE DEFECT THIS FILE PINS, in the words of the extension that met it
//          first (`extensions/Controls/index.ts`): "a click on one of those
//          phantoms edited a control on a sheet the user was not looking at".

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  /** What `hostBridge.activeSheetIndex()` answers — the app's own truth. */
  activeSheet: 0,
  /**
   * How far the sheet is scrolled right, in pixels. The Core renderer folds the
   * scroll offset into the coordinates it hands an overlay, so moving this and
   * painting again IS a scroll as far as the layer is concerned — which is how
   * a placement gets carried out of the viewport here.
   */
  scrollX: 0,
  designMode: false,
  /** type -> the regions this module last published for it. */
  regions: new Map<string, Array<Record<string, unknown>>>(),
  /** The overlay the layer registered, so a paint can be driven by hand. */
  overlay: null as null | {
    type: string;
    render: (ctx: unknown) => void;
    hitTest?: (ctx: unknown) => boolean;
  },
  listeners: new Map<string, Set<(detail: unknown) => void>>(),
  emitted: [] as Array<{ name: string; detail: unknown }>,
  designModeListeners: new Set<() => void>(),
}));

vi.mock("@api", () => ({
  AppEvents: {
    GRID_REFRESH: "grid:refresh",
    ROWS_INSERTED: "app:rows-inserted",
    ROWS_DELETED: "app:rows-deleted",
    COLUMNS_INSERTED: "app:columns-inserted",
    COLUMNS_DELETED: "app:columns-deleted",
    SHEET_CHANGED: "app:sheet-changed",
    SHEET_DELETED: "app:sheet-deleted",
  },
  emitAppEvent: (name: string, detail?: unknown) => hoisted.emitted.push({ name, detail }),
  getDesignMode: () => hoisted.designMode,
  onAppEvent: (name: string, handler: (detail: unknown) => void) => {
    const set = hoisted.listeners.get(name) ?? new Set();
    set.add(handler);
    hoisted.listeners.set(name, set);
    return () => set.delete(handler);
  },
  onDesignModeChange: (handler: () => void) => {
    hoisted.designModeListeners.add(handler);
    return () => hoisted.designModeListeners.delete(handler);
  },
  // The geometry the Core renderer would supply: 50px row header, 24px column
  // header, 100x20 cells, no scroll. Concrete numbers so a box can be asserted.
  overlayGetColumnX: (_ctx: unknown, col: number) => 50 + col * 100 - hoisted.scrollX,
  overlayGetRowY: (_ctx: unknown, row: number) => 24 + row * 20,
  overlayGetRowHeaderWidth: () => 50,
  overlayGetColHeaderHeight: () => 24,
  registerGridOverlay: (registration: {
    type: string;
    render: (ctx: unknown) => void;
    hitTest?: (ctx: unknown) => boolean;
  }) => {
    hoisted.overlay = registration;
    return () => {
      hoisted.overlay = null;
    };
  },
  replaceGridRegionsByType: (type: string, regions: Array<Record<string, unknown>>) => {
    hoisted.regions.set(type, regions);
  },
  removeGridRegionsByType: (type: string) => {
    hoisted.regions.delete(type);
  },
}));

// React is never actually rendered here: the question is where the HOST element
// sits and whether it is showing, which is DOM the layer writes itself.
vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: () => undefined, unmount: () => undefined }),
}));
vi.mock("../components/scriptEmbed", () => ({
  ScriptEmbeddedFormView: () => null,
}));

import { EMBEDDED_FORM_REGION_TYPE, installEmbeddedFormLayer } from "../lib/embeddedFormLayer";
import type { ScriptEmbedHostDeps } from "../lib/scriptEmbedHost";
import {
  DEFAULT_EMBEDDED_FORM_HEIGHT,
  DEFAULT_EMBEDDED_FORM_WIDTH,
  EMBEDDED_FORM_ORPHAN_REMEDY,
  __resetEmbeddedFormPlacementsForTests,
  getEmbeddedFormPlacement,
  placeEmbeddedForm,
} from "@api/scriptHost/embeddedFormPlacements";
// The region SHAPE, from the facade — never Core's `findFloatingRegionAt`
// itself, however much the last describe in this file would like to call it.
// The Facade Rule is enforced against extension tests too (only the
// raw-backend-door ban is relaxed for them, app/eslint.boundaries.js), so the
// Core half of that coupling is asserted where Core already owns it
// (`src/core/lib/gridRenderer/layout/__tests__/headerVisibility.test.ts` drives
// `findFloatingRegionAt` directly) and this file pins the half it produces.
import type { GridRegion } from "@api/gridOverlays";
// Core's REAL pointer rule — not doubled with `@api` above, on purpose: what
// this surface has to prove is that CORE stands down over its card, and a
// double of the rule would prove only that this file agrees with itself.
import { isPointerClaimed } from "@api/pointerClaims";

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

let parent: HTMLDivElement;
let canvas2d: CanvasRenderingContext2D;
/**
 * Every rectangle the layer asked the CANVAS to stroke. Spied rather than
 * ignored because the design-mode outline used to be one of these, drawn inside
 * a box the opaque card covers — ink no user could ever see (see the layer's
 * header). Nothing should reach it now.
 */
let strokeRectSpy: ReturnType<typeof vi.fn>;
let layer: { deps: ScriptEmbedHostDeps; dispose: () => void } | null = null;

const bridge = {
  openSession: async () => ({ ok: true as const, paneId: "pane-1" }),
  closeSession: () => undefined,
  activeSheetIndex: async () => hoisted.activeSheet,
};

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** The regions the layer has published for its own type, in order. */
function published(): Array<Record<string, unknown>> {
  return hoisted.regions.get(EMBEDDED_FORM_REGION_TYPE) ?? [];
}

function publishedIds(): string[] {
  return published().map((r) => r.id as string);
}

/** Drive ONE paint of one region, the way the Core renderer would. */
function paint(region: Record<string, unknown>): void {
  hoisted.overlay?.render({
    ctx: canvas2d,
    region,
    config: {},
    viewport: { scrollX: 0, scrollY: 0 },
    dimensions: { columnWidths: new Map(), rowHeights: new Map() },
    canvasWidth: 800,
    canvasHeight: 600,
  });
}

/** Drive a whole paint pass over whatever is currently published. */
function paintAll(): void {
  for (const region of published()) paint(region);
}

function hostEl(placementId: string): HTMLDivElement | null {
  return parent.querySelector<HTMLDivElement>(`[data-embedded-form="${placementId}"]`);
}

function fire(name: string, detail: unknown): void {
  for (const handler of hoisted.listeners.get(name) ?? []) handler(detail);
}

/** Was the canvas asked to repaint since the marker? */
function refreshedSince(marker: number): boolean {
  return hoisted.emitted.slice(marker).some((e) => e.name === "grid:refresh");
}

/** Every paint edge the layer announced, in order, since the subscription. */
function watchVisibility(): Array<[string, boolean]> {
  const seen: Array<[string, boolean]> = [];
  layer!.deps.onSurfaceVisibility((placementId, visible) => {
    seen.push([placementId, visible]);
  });
  return seen;
}

beforeEach(() => {
  hoisted.activeSheet = 0;
  hoisted.scrollX = 0;
  hoisted.designMode = false;
  hoisted.regions.clear();
  hoisted.overlay = null;
  hoisted.listeners.clear();
  hoisted.emitted.length = 0;
  hoisted.designModeListeners.clear();
  __resetEmbeddedFormPlacementsForTests();

  parent = document.createElement("div");
  const canvas = document.createElement("canvas");
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  strokeRectSpy = vi.fn();
  canvas2d = {
    canvas,
    save: () => undefined,
    restore: () => undefined,
    strokeRect: strokeRectSpy,
    setLineDash: () => undefined,
    strokeStyle: "",
    lineWidth: 0,
  } as unknown as CanvasRenderingContext2D;
});

afterEach(() => {
  layer?.dispose();
  layer = null;
  parent.remove();
  __resetEmbeddedFormPlacementsForTests();
});

// ---------------------------------------------------------------------------

describe("an embedded form paints on ITS sheet, and only on its sheet", () => {
  it("publishes a region for the active sheet's placements and none for the others", async () => {
    const here = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 0, anchorCol: 0 });
    placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 1, anchorRow: 0, anchorCol: 0 });
    placeEmbeddedForm({ scriptId: "form-b", sheetIndex: 4, anchorRow: 7, anchorCol: 3 });

    layer = installEmbeddedFormLayer(bridge);
    await flush();

    // The whole store is three placements; the grid gets ONE region, because a
    // GridRegion carries no sheet and the renderer would paint all three.
    expect(publishedIds()).toEqual([here.id]);
  });

  it("seeds from the app rather than assuming sheet 0 — a workbook can open on any sheet", async () => {
    const onThree = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 2, anchorRow: 1, anchorCol: 1 });
    placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 1, anchorCol: 1 });
    hoisted.activeSheet = 2;

    layer = installEmbeddedFormLayer(bridge);
    await flush();

    expect(publishedIds()).toEqual([onThree.id]);
  });

  it("takes the surface off the grid when the user switches away from its sheet", async () => {
    const p = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 0, anchorCol: 0 });
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    paintAll();

    // On its own sheet it is a real, opaque, clickable box over A1.
    const el = hostEl(p.id);
    expect(el).not.toBeNull();
    expect(el!.style.display).toBe("block");
    expect(el!.style.pointerEvents).toBe("auto");
    expect(el!.style.width).toBe(`${DEFAULT_EMBEDDED_FORM_WIDTH}px`);
    expect(el!.style.height).toBe(`${DEFAULT_EMBEDDED_FORM_HEIGHT}px`);
    const staleRegion = published()[0];

    // The user clicks the Sheet2 tab.
    const marker = hoisted.emitted.length;
    hoisted.activeSheet = 1;
    fire("app:sheet-changed", { sheetIndex: 1 });
    await flush();

    // Nothing of Sheet1's is published for Sheet2 ...
    expect(publishedIds()).toEqual([]);
    // ... and the element that was covering Sheet1!A1 is no longer covering
    // Sheet2!A1. This is the failure: an unpublished region is never handed to
    // the render pass again, so hiding cannot wait for one.
    expect(el!.style.display).toBe("none");
    // The canvas is asked to repaint, or the arriving sheet's forms would not
    // appear until something else happened to trigger a frame.
    expect(refreshedSince(marker)).toBe(true);

    // Belt and braces: even a frame still holding the stale region must not
    // paint it.
    paint(staleRegion);
    expect(el!.style.display).toBe("none");
  });

  it("brings the surface back when the user switches to its sheet again", async () => {
    const p = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 0, anchorCol: 0 });
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    paintAll();

    hoisted.activeSheet = 1;
    fire("app:sheet-changed", { sheetIndex: 1 });
    await flush();
    expect(hostEl(p.id)!.style.display).toBe("none");

    hoisted.activeSheet = 0;
    fire("app:sheet-changed", { sheetIndex: 0 });
    await flush();
    expect(publishedIds()).toEqual([p.id]);
    paintAll();
    expect(hostEl(p.id)!.style.display).toBe("block");
  });

  it("asks the app which sheet it is on when SHEET_CHANGED arrives with no detail", async () => {
    const p = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 0, anchorCol: 0 });
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    paintAll();

    // The shell dispatches SHEET_CHANGED without a detail on the undo of a
    // sheet add/delete/reorder (`shell/bootstrap.ts`). Ignoring it would leave
    // the layer painting the sheet the user just left.
    hoisted.activeSheet = 3;
    fire("app:sheet-changed", undefined);
    await flush();

    expect(publishedIds()).toEqual([]);
    expect(hostEl(p.id)!.style.display).toBe("none");
  });

  it("a phantom on another sheet claims nothing, in Design Mode as in run mode", async () => {
    const p = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 0, anchorCol: 0 });
    hoisted.designMode = true;
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    paintAll();

    // On its own sheet, in Design Mode: click-through, and outlined so the user
    // can see the box that was taking their clicks a moment ago.
    const el = hostEl(p.id)!;
    expect(el.style.display).toBe("block");
    expect(el.style.pointerEvents).toBe("none");

    hoisted.activeSheet = 1;
    fire("app:sheet-changed", { sheetIndex: 1 });
    await flush();

    // Other sheet: the element is off the screen, so neither its box nor its
    // outline is over Sheet2's cells. A claim that survived a tab click is the
    // defect extensions/Controls/index.ts names by hand — "a click on one of
    // those phantoms edited a control on a sheet the user was not looking at".
    expect(el.style.display).toBe("none");
    expect(publishedIds()).toEqual([]);
  });

  it("tells the wiring which sheet is up, and when it changes", async () => {
    // The SECOND consumer of the sheet the layer tracks. A placement on a sheet
    // the user has not visited is never painted, so it never reports itself
    // visible — and the wiring must still learn that its sheet has come up,
    // because that is when its session may open against the right sheet
    // (lib/scriptEmbedHost.ts, the gate in `openSurface`). Without this edge the
    // form would sit at "Starting this form…" until some unrelated placement
    // change happened to run a reconcile.
    hoisted.activeSheet = 2;
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    expect(layer.deps.activeSheetIndex()).toBe(2);

    const told: number[] = [];
    const off = layer.deps.onActiveSheetChange((sheetIndex) => told.push(sheetIndex));

    hoisted.activeSheet = 1;
    fire("app:sheet-changed", { sheetIndex: 1 });
    await flush();
    expect(told).toEqual([1]);
    // The answer and the announcement are the same fact, so a subscriber that
    // reads instead of remembering gets the same number.
    expect(layer.deps.activeSheetIndex()).toBe(1);

    // A repeat of the sheet already up is not a change: re-announcing it would
    // run a reconcile per repaint.
    fire("app:sheet-changed", { sheetIndex: 1 });
    await flush();
    expect(told).toEqual([1]);

    off();
    hoisted.activeSheet = 0;
    fire("app:sheet-changed", { sheetIndex: 0 });
    await flush();
    expect(told).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// THE SECOND DEFECT THIS FILE PINS: a surface nobody can see must READ nothing.
//
// The host arms a bound-cell watch on "visible" and takes it down on "hidden"
// (`paneSessionDeps`, api/scriptHost/host.ts). That signal used to be the React
// component's mount effect — and this layer hides with `display: none`, which
// unmounts nothing, so a form bound to A1:A20 and scrolled out of the viewport
// kept its watch armed: every later edit to a bound cell was re-read (one audit
// entry per cell) and announced to the script as `onPaneChange { source:
// "cell" }` for a surface nobody could see. The report now leaves from the same
// branches that write `display`, and these tests drive those branches.
// ---------------------------------------------------------------------------

describe("the layer reports when a surface starts and stops being painted", () => {
  it("says HIDDEN when a placement is scrolled out of the viewport, and VISIBLE on the way back", async () => {
    const p = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 0, anchorCol: 0 });
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    const seen = watchVisibility();

    paintAll();
    expect(seen).toEqual([[p.id, true]]);
    expect(hostEl(p.id)!.style.display).toBe("block");

    // The user scrolls right until the box has left the canvas. The element and
    // its React root SURVIVE this — the session is live — which is exactly why
    // nothing above this module can report the edge.
    hoisted.scrollX = 2000;
    paintAll();
    expect(hostEl(p.id)!.style.display).toBe("none");
    expect(seen).toEqual([
      [p.id, true],
      [p.id, false],
    ]);

    hoisted.scrollX = 0;
    paintAll();
    expect(hostEl(p.id)!.style.display).toBe("block");
    expect(seen).toEqual([
      [p.id, true],
      [p.id, false],
      [p.id, true],
    ]);
  });

  it("announces a CHANGE only — a steady paint pass reports nothing", async () => {
    const p = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 0, anchorCol: 0 });
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    const seen = watchVisibility();

    // The grid repaints every frame, and a "visible" costs the host an armed
    // watch plus one audited re-read per bound cell: re-announcing the steady
    // state would turn scrolling within the viewport into a read storm.
    for (let i = 0; i < 8; i++) paintAll();
    expect(seen).toEqual([[p.id, true]]);

    hoisted.scrollX = 2000;
    for (let i = 0; i < 8; i++) paintAll();
    expect(seen).toEqual([
      [p.id, true],
      [p.id, false],
    ]);
  });

  it("says HIDDEN when the user switches away from the surface's sheet", async () => {
    const p = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 0, anchorCol: 0 });
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    const seen = watchVisibility();
    paintAll();
    expect(seen).toEqual([[p.id, true]]);

    // A tab click hides the departing sheet's hosts in `syncRegions`, because an
    // unpublished region is never handed to the render pass again. That branch
    // has to report too, or a form on Sheet1 goes on reading Sheet1's cells for
    // a user working on Sheet2.
    hoisted.activeSheet = 1;
    fire("app:sheet-changed", { sheetIndex: 1 });
    await flush();
    expect(hostEl(p.id)!.style.display).toBe("none");
    expect(seen).toEqual([
      [p.id, true],
      [p.id, false],
    ]);
  });

  it("stops reporting to a subscriber that let go, without stopping the hide itself", async () => {
    const p = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 0, anchorCol: 0 });
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    const seen: Array<[string, boolean]> = [];
    const off = layer.deps.onSurfaceVisibility((placementId, visible) => {
      seen.push([placementId, visible]);
    });
    paintAll();
    expect(seen).toEqual([[p.id, true]]);

    // The wiring tears down (the extension is deactivating) while the layer
    // paints one more frame. The pixels must still behave; only the report goes.
    off();
    hoisted.scrollX = 2000;
    paintAll();
    expect(hostEl(p.id)!.style.display).toBe("none");
    expect(seen).toEqual([[p.id, true]]);
  });
});

// ---------------------------------------------------------------------------
// THE POINTER CLAIM. `pointer-events: auto` decides only whether the browser's
// hit test can LAND on this element; it says nothing about who owns the press
// once it has. This element is a DESCENDANT of `S.GridArea`, where Core binds
// `onMouseDown`, so the press bubbled on into the grid — which calls
// `event.preventDefault()` before its first await (cancelling the browser's
// focus on the widget the user clicked) and moved the cell selection to the cell
// UNDER the card. A click on an on-grid form's input never focused it; the write
// landed in the journey only because `locator.fill()` focuses programmatically.
// ---------------------------------------------------------------------------

describe("the card claims the pointer", () => {
  it("a press on the card is not the grid's press", async () => {
    const p = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 0, anchorCol: 0 });
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    paintAll();

    expect(isPointerClaimed({ target: hostEl(p.id)!, button: 0 })).toBe(true);
  });

  it("a press on a WIDGET inside the card is claimed too", async () => {
    const p = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 0, anchorCol: 0 });
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    paintAll();

    // The React tree lives inside the host; the claim has to cover it, or the
    // grid takes the very press the form exists for.
    const input = document.createElement("input");
    hostEl(p.id)!.appendChild(input);
    expect(isPointerClaimed({ target: input, button: 0 })).toBe(true);
  });

  it("the canvas beside it is still the grid's", async () => {
    placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 0, anchorCol: 0 });
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    paintAll();

    expect(isPointerClaimed({ target: canvas2d.canvas, button: 0 })).toBe(false);
  });

  it("does not claim RIGHT presses — the orphan remedy is a right-click", async () => {
    const p = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 0, anchorCol: 0 });
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    paintAll();

    // `EMBEDDED_FORM_ORPHAN_REMEDY` tells the user to right-click the anchor
    // cell, which is under this card. A claim that took the secondary button
    // would make the remedy this module prints unreachable.
    expect(isPointerClaimed({ target: hostEl(p.id)!, button: 2 })).toBe(false);
  });

  it("DESIGN MODE suspends the claim, and gives it back", async () => {
    const p = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 0, anchorCol: 0 });
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    paintAll();
    const el = hostEl(p.id)!;
    expect(isPointerClaimed({ target: el, button: 0 })).toBe(true);

    hoisted.designMode = true;
    for (const handler of hoisted.designModeListeners) handler();
    paintAll();
    // Both halves of the escape move together — they are one call.
    expect(el.style.pointerEvents).toBe("none");
    expect(isPointerClaimed({ target: el, button: 0 })).toBe(false);

    hoisted.designMode = false;
    for (const handler of hoisted.designModeListeners) handler();
    paintAll();
    expect(el.style.pointerEvents).toBe("auto");
    expect(isPointerClaimed({ target: el, button: 0 })).toBe(true);
  });

  it("a host created while Design Mode is already on claims nothing", async () => {
    const p = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 0, anchorCol: 0 });
    hoisted.designMode = true;
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    paintAll();

    // `ensureHost` and the paint both go through `applyPointerRule`, so the
    // element cannot be born claiming what the mode has suspended.
    expect(isPointerClaimed({ target: hostEl(p.id)!, button: 0 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE THIRD DEFECT THIS FILE PINS: Design Mode's outline has to be VISIBLE.
//
// Design Mode's promise on this surface is exactly two things — your clicks come
// back, and you can see the box that was taking them. The second half was a
// `ctx.strokeRect` on the grid canvas, inside a box covered by an opaque card
// (`EmbedRoot`, `background: var(--dialog-bg)`) on a positioned element at
// `z-index: 6` above that canvas. Not one pixel of it ever reached the user: the
// mode gave the clicks back and said nothing about what had taken them, which is
// the same defect `extensions/Controls/Shape/shapeHitRegions.ts` traced for
// M3b's own outline. It is now a CSS `outline` on the host element, which paints
// after the element's descendants — so these tests read the ELEMENT, and assert
// that nothing is drawn where it cannot be seen.
// ---------------------------------------------------------------------------

describe("Design Mode outlines the box where the user can see it", () => {
  it("outlines the host element while Design Mode is on, and clears it when it goes off", async () => {
    const p = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 0, anchorCol: 0 });
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    paintAll();

    // Run mode: the box takes the clicks and says nothing about it.
    const el = hostEl(p.id)!;
    expect(el.style.pointerEvents).toBe("auto");
    expect(el.style.outline).toBe("none");

    // The user turns Design Mode on to get the cells under the card back. The
    // layer's whole answer to the toggle is a repaint, so drive one.
    const marker = hoisted.emitted.length;
    hoisted.designMode = true;
    for (const handler of hoisted.designModeListeners) handler();
    expect(refreshedSince(marker)).toBe(true);
    paintAll();

    // Both halves of the promise, on the one element: click-through, AND a
    // dashed box the user can actually see, drawn just inside its own edge.
    expect(el.style.pointerEvents).toBe("none");
    expect(el.style.outline).toBe("1px dashed rgba(0, 120, 212, 0.9)");
    expect(el.style.outlineOffset).toBe("-1px");

    // Off again: the outline is CLEARED, not left standing. A dashed box around
    // a surface that is taking the clicks again says the opposite of the truth.
    hoisted.designMode = false;
    for (const handler of hoisted.designModeListeners) handler();
    paintAll();
    expect(el.style.pointerEvents).toBe("auto");
    expect(el.style.outline).toBe("none");
  });

  it("draws nothing on the canvas, where the card would cover it", async () => {
    placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 0, anchorCol: 0 });
    hoisted.designMode = true;
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    paintAll();

    // THE FAILURE THIS PINS: `strokeRect` inside the host's box is ink under an
    // opaque element. The layer may paint on the canvas outside the card one day
    // — this asserts only that it does not try to paint the outline underneath
    // it, which is the whole of what it used to do.
    expect(strokeRectSpy).not.toHaveBeenCalled();
  });

  it("takes the outline with it when the surface hides — there is no sibling to strand", async () => {
    const p = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 0, anchorCol: 0 });
    hoisted.designMode = true;
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    paintAll();

    const el = hostEl(p.id)!;
    expect(el.style.outline).toBe("1px dashed rgba(0, 120, 212, 0.9)");
    // The canvas and this one host element: the outline is a style ON the host,
    // not an element beside it. M3b's shape outlines ARE siblings and have to be
    // removed by hand on every hide path, and a missed one leaves a dashed
    // rectangle standing over whatever scrolls into that space.
    expect([...parent.children].map((c) => c.tagName)).toEqual(["CANVAS", "DIV"]);

    hoisted.scrollX = 2000;
    paintAll();
    expect(el.style.display).toBe("none");
    expect([...parent.children].map((c) => c.tagName)).toEqual(["CANVAS", "DIV"]);
  });

  it("registers no overlay hitTest — Core cannot reach one for a cell-anchored region", async () => {
    placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 0, anchorCol: 0 });
    hoisted.designMode = true;
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    paintAll();

    // `checkOverlayBody` (core/hooks/useMouseSelection/layout/
    // overlayMoveHandlers.ts) is the ONLY production consumer of a
    // registration's `hitTest`, and it computes `getFloatingCanvasBounds` first
    // and `continue`s when that is null — which it is for every region without a
    // `floating` box. These regions are cell-anchored, so a `hitTest` here is
    // answered to nobody. One was registered, and a unit test that called it
    // directly reported it working: that pair is why "Design Mode selects the
    // object" was written into this module's header and believed twice.
    expect(hoisted.overlay!.hitTest).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// THE REMEDY HAS TO BE REACHABLE THROUGH THE CARD THAT PROMISES IT
//
// Every orphan sentence now reads one constant, `EMBEDDED_FORM_ORPHAN_REMEDY`,
// and that constant tells the user to RIGHT-CLICK the cell at the form's
// top-left corner and pick a grid menu item. The card is opaque, sits over that
// very cell at `z-index: 6` and takes pointer input (`pointer-events: auto`
// outside Design Mode), so the promise is only true because of a coupling
// NOTHING in M3c pinned: the grid's own context menu is bound to `GridArea`
// (`onContextMenu={handleContextMenu}`, core/components/Spreadsheet/
// Spreadsheet.tsx), which the host element bubbles to — and `handleContextMenu`
// then RETURNS WITHOUT OPENING THE CELL MENU when `findFloatingRegionAt` finds a
// region under the pointer (Spreadsheet.tsx, "Right-click on a floating object
// … the grid CELL context menu must not open"). That predicate skips every
// region with no `floating` box, and these are cell-anchored, so today the menu
// opens over the card.
//
// WHICH MAKES THE OBVIOUS NEXT CHANGE THE DANGEROUS ONE. The reviewer who found
// the "drag it onto a cell" sentences proposed wiring the drag by giving this
// region a `floating` box. That single field would ALSO suppress the cell menu
// over the card and silently take away both items the sentence names — the
// same defect again, one layer down, with the wording tests still green because
// the words would not have changed. The words are pinned in three other files;
// what is pinned HERE is the one field that decides whether they are true.
// ---------------------------------------------------------------------------

describe("an orphan's card does not eat the right-click its own sentence asks for", () => {
  it("publishes NO floating box for an orphan, which is what leaves the cell menu reachable", async () => {
    // The failure scenario exactly: a form anchored to row 5, and somebody
    // deletes row 5.
    const p = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 5, anchorCol: 2 });
    layer = installEmbeddedFormLayer(bridge);
    await flush();
    fire("app:rows-deleted", { startRow: 5, count: 1 });
    await flush();
    expect(getEmbeddedFormPlacement(p.id)!.orphaned).toBe(true);

    // The card is still on the grid, opaque and taking clicks, over the very
    // cell the remedy tells the user to right-click.
    paintAll();
    const el = hostEl(p.id)!;
    expect(el.style.display).toBe("block");
    expect(el.style.pointerEvents).toBe("auto");

    // The region the layer REALLY published — not a hand-built copy, because a
    // copy is what would go on passing after the layer changed.
    const region = published()[0] as unknown as GridRegion;
    expect(region.id).toBe(p.id);
    expect(
      region.floating,
      `a right-click on this card must still reach the grid's cell menu, because the remedy is: ${EMBEDDED_FORM_ORPHAN_REMEDY}`,
    ).toBeUndefined();
  });
});

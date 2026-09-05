//! FILENAME: app/extensions/Controls/__tests__/shapeFrameBudgetLifecycle.test.ts
// PURPOSE: That the live-frame budget measures frames that are ALIVE, not frames
//          ever created — across a sheet switch, which PARKS a frame rather than
//          removing it, and across File > New / File > Open, which used to
//          release nothing at all.
// CONTEXT: `releaseUnpaintedShapeOverlays` deliberately hides a departing sheet's
//          frames instead of removing them, so the state their own scripts built
//          survives the user coming back — and it kept their share of a cap that
//          is 24 frames for the whole SESSION. Nothing ever gave it back: the
//          budget's releases all run from teardown paths a parked shape reaches
//          by definition never, and `resetScriptFrameBudget` had exactly one
//          caller in the repo, which was its own test. So twenty-four frames on
//          a sheet nobody was looking at refused every frame on the sheet the
//          user WAS looking at, and the second workbook of a session inherited
//          the first one's charges.
//
//          `shapeFrameBudgetRefusal.test.ts` covers what a shape DOES when the
//          budget refuses it (paints from the catalog, says why, stops asking).
//          This file covers whether the refusal should have happened at all.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Hoisted for the same reason as the refusal suite's: `vi.mock` factories are
// lifted above every declaration in the file.
const { toasts } = vi.hoisted(() => ({ toasts: [] as unknown[][] }));

vi.mock("@api/gridOverlays", () => ({
  overlayGetRowHeaderWidth: () => 0,
  overlayGetColHeaderHeight: () => 0,
  overlaySheetToCanvas: (_c: unknown, x: number, y: number) => ({ canvasX: x, canvasY: y }),
  requestOverlayRedraw: () => undefined,
  replaceGridRegionsByType: () => undefined,
  removeGridRegionsByType: () => undefined,
}));
vi.mock("@api", () => ({
  getShapeBitmap: () => null,
  hasShapeBitmapRenderer: () => false,
}));
vi.mock("@api/events", () => ({ emitAppEvent: () => undefined }));
vi.mock("@api/notifications", () => ({ showToast: (...args: unknown[]) => toasts.push(args) }));
// An empty property bag: `fetchShapeData` returns early, so no dynamic import is
// reached and the catalog defaults are what a canvas-painted shape would draw.
vi.mock("../lib/controlApi", () => ({ resolveControlProperties: async () => ({}) }));
vi.mock("../Button/floatingSelection", () => ({
  isFloatingControlSelected: () => false,
  getSelectedFloatingControls: () => [] as string[],
}));

import {
  renderFloatingShape,
  setShapeHtmlContent,
  getShapeHtmlContent,
  getShapeFrameRefusal,
  getShapeOverlayFrame,
  migrateShapeInstanceId,
  releaseAllShapeHtmlOverlays,
} from "../Shape/shapeRenderer";
import {
  SHAPE_HIT_SHIM_ATTR,
  resetShapeHitRegions,
  setShapeHitRegions,
} from "../Shape/shapeHitRegions";
import { announceFloatingControlRegions } from "../lib/regionPublication";
import {
  addFloatingControl,
  reanchorFloatingControls,
  resetFloatingStore,
} from "../lib/floatingStore";
import {
  MAX_LIVE_SCRIPT_FRAMES,
  claimScriptFrameSlot,
  parkedScriptFrameCount,
  resetScriptFrameBudget,
  scriptFrameBudgetUsage,
} from "../../_shared/scriptFrame";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// jsdom does not implement `HTMLIFrameElement.sandbox`, and `updateHtmlOverlay`
// opens with `el.sandbox.add("allow-scripts")`.
if (!document.createElement("iframe").sandbox) {
  Object.defineProperty(HTMLIFrameElement.prototype, "sandbox", {
    configurable: true,
    get(this: HTMLIFrameElement) {
      return {
        add: (...tokens: string[]) => {
          const present = (this.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean);
          this.setAttribute("sandbox", [...new Set([...present, ...tokens])].join(" "));
        },
      };
    },
  });
}

/** On-grid control ids are anchor-derived: `control-<sheet>-<row>-<col>`. */
function idFor(sheetIndex: number, row: number): string {
  return `control-${sheetIndex}-${row}-1`;
}

function sheetIds(sheetIndex: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => idFor(sheetIndex, i));
}

const HTML = "<button>Save</button>";

let parent: HTMLDivElement;
let canvas: HTMLCanvasElement;
let painted: string[];
let warn: ReturnType<typeof vi.spyOn>;
let ctx: CanvasRenderingContext2D;

/** A canvas context that answers every 2D call and remembers which it was asked
 *  to make — "the shape painted itself instead of its frame" is the presence of
 *  `fill` and `stroke` here. */
function recordingCtx(el: HTMLCanvasElement): CanvasRenderingContext2D {
  const target: Record<string, unknown> = { canvas: el, globalAlpha: 1 };
  return new Proxy(target, {
    get: (obj, prop) => {
      if (prop in obj) return obj[prop as string];
      return (...args: unknown[]) => {
        painted.push(args.length > 0 ? `${String(prop)}(${args.length})` : String(prop));
      };
    },
    set: (obj, prop, value) => {
      obj[prop as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/** Paint one shape, the way the overlay dispatcher does. `row` doubles as the
 *  vertical offset so shapes do not sit on top of each other. */
function paint(id: string, sheetIndex: number, row: number): void {
  renderFloatingShape({
    ctx,
    canvasWidth: 4000,
    canvasHeight: 4000,
    region: {
      id,
      floating: { x: 10, y: 10 + row * 5, width: 120, height: 40 },
      data: { controlType: "shape", sheetIndex, row, col: 1 },
    },
  } as never);
}

/** A sheet whose scripts have just declared their html, then painted — the
 *  FIRST time the user sees it. */
function mountSheet(sheetIndex: number, ids: string[]): void {
  announceFloatingControlRegions(new Set(ids));
  for (const [row, id] of ids.entries()) {
    setShapeHtmlContent(id, HTML);
    paint(id, sheetIndex, row);
  }
}

/**
 * Coming BACK to a sheet: the store republishes its ids and the render pass
 * paints them, and that is all.
 *
 * Nothing re-declares the html — the scripts never unmounted and will not
 * declare again on their own, which is the whole reason the departing frames are
 * parked rather than torn down. It also means the content hash still matches, so
 * a revisit never reaches the claim: whatever takes a returning frame off the
 * eviction list has to be on the paint path itself.
 */
function revisitSheet(sheetIndex: number, ids: string[]): void {
  announceFloatingControlRegions(new Set(ids));
  for (const [row, id] of ids.entries()) paint(id, sheetIndex, row);
}

function frameFor(id: string): HTMLIFrameElement | null {
  return parent.querySelector<HTMLIFrameElement>(`iframe[data-shape-overlay="${id}"]`);
}

function frameCount(): number {
  return parent.querySelectorAll("iframe[data-shape-overlay]").length;
}

function shims(): HTMLElement[] {
  return [...parent.querySelectorAll<HTMLElement>(`[${SHAPE_HIT_SHIM_ATTR}]`)];
}

/** Put a PINNED shape in the real store, so the real re-anchor can shift it.
 *  Unpinned is the default and never follows the grid, so a control that is to
 *  be re-keyed by a structural edit has to say so. */
function addPinnedShape(row: number): string {
  const id = idFor(0, row);
  addFloatingControl({
    id,
    sheetIndex: 0,
    row,
    col: 1,
    x: 10,
    y: 10 + row * 5,
    width: 120,
    height: 40,
    controlType: "shape",
    pinToGrid: true,
  });
  return id;
}

/** The extension's own rowInsert shift, spelled exactly as `Controls/index.ts`
 *  builds it — anything at or below the insertion point moves down. */
const rowInsert = (at: number, count: number) =>
  (row: number, col: number): { row: number; col: number } => ({
    row: row >= at ? row + count : row,
    col,
  });

/** Mirrors `movesWithCells`: only a pinned control follows the grid. */
const movesWithCells = (ctrl: { pinToGrid?: boolean }): boolean => ctrl.pinToGrid === true;

beforeEach(() => {
  resetScriptFrameBudget();
  resetFloatingStore();
  resetShapeHitRegions();
  toasts.length = 0;
  painted = [];
  parent = document.createElement("div");
  canvas = document.createElement("canvas");
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  ctx = recordingCtx(canvas);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  releaseAllShapeHtmlOverlays();
  resetShapeHitRegions();
  resetFloatingStore();
  resetScriptFrameBudget();
  warn.mockRestore();
  document.body.innerHTML = "";
});

// ===========================================================================
// 1. The failure scenario: a full sheet, then the NEXT sheet
// ===========================================================================

describe("switching sheets with a full budget of html shapes", () => {
  it("gives the new sheet its frames instead of spending the cap on hidden ones", () => {
    const sheet1 = sheetIds(0, MAX_LIVE_SCRIPT_FRAMES);
    mountSheet(0, sheet1);
    expect(frameCount()).toBe(MAX_LIVE_SCRIPT_FRAMES);
    expect(scriptFrameBudgetUsage().frames).toBe(MAX_LIVE_SCRIPT_FRAMES);

    // The sheet switch: the store publishes the NEW sheet's ids, and every frame
    // that is no longer painted is parked — hidden, still charged, and from now
    // on preemptible.
    const sheet2 = sheetIds(1, MAX_LIVE_SCRIPT_FRAMES);
    announceFloatingControlRegions(new Set(sheet2));
    expect(parkedScriptFrameCount()).toBe(MAX_LIVE_SCRIPT_FRAMES);
    for (const id of sheet1) expect(frameFor(id)?.style.display).toBe("none");

    mountSheet(1, sheet2);

    // Every shape on the sheet the user is actually looking at has its frame.
    for (const id of sheet2) expect(frameFor(id)).not.toBeNull();
    for (const id of sheet2) expect(getShapeFrameRefusal(id)).toBeUndefined();
    // ...and the cap still holds: the parked frames paid for them.
    expect(frameCount()).toBe(MAX_LIVE_SCRIPT_FRAMES);
    expect(scriptFrameBudgetUsage().frames).toBe(MAX_LIVE_SCRIPT_FRAMES);
    // Nothing was refused, so nothing was announced.
    expect(toasts).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("brings a sheet's shapes back when the user switches back", () => {
    const sheet1 = sheetIds(0, MAX_LIVE_SCRIPT_FRAMES);
    const sheet2 = sheetIds(1, MAX_LIVE_SCRIPT_FRAMES);
    mountSheet(0, sheet1);
    mountSheet(1, sheet2);
    revisitSheet(0, sheet1);

    for (const id of sheet1) expect(frameFor(id)).not.toBeNull();
    for (const id of sheet1) expect(getShapeFrameRefusal(id)).toBeUndefined();
    expect(frameCount()).toBe(MAX_LIVE_SCRIPT_FRAMES);
  });
});

// ===========================================================================
// 2. Parking is still free when nothing needs the room
// ===========================================================================

describe("a parked frame with no pressure on the budget", () => {
  it("keeps its element — and therefore its own state — across the switch", () => {
    const a = idFor(0, 0);
    mountSheet(0, [a]);
    const original = frameFor(a);
    expect(original).not.toBeNull();

    // A sheet with no html shapes of its own: the store publishes its (empty)
    // region set, and the departing frame is parked with 23 slots to spare.
    announceFloatingControlRegions(new Set<string>());
    expect(frameFor(a)).toBe(original);
    expect(original?.style.display).toBe("none");
    expect(parkedScriptFrameCount()).toBe(1);

    revisitSheet(0, [a]);
    // The SAME element, so its srcdoc was never reloaded: the reason parking
    // exists at all, and the reason this is preemption rather than a release.
    expect(frameFor(a)).toBe(original);
    expect(original?.style.display).toBe("block");
    expect(parkedScriptFrameCount()).toBe(0);
  });

  it("is not evictable once it is painted again", () => {
    const a = idFor(0, 0);
    mountSheet(0, [a]);
    announceFloatingControlRegions(new Set<string>());
    revisitSheet(0, [a]);

    // Fill the budget around the one live frame and ask for one more. With
    // nothing parked, the claim must be refused rather than tearing down the
    // frame the user is looking at. A revisit never re-claims — the content did
    // not change — so nothing but the paint path itself can have unparked it.
    for (let i = 1; i < MAX_LIVE_SCRIPT_FRAMES; i++) claimScriptFrameSlot(`other-${i}`, 10);
    expect(claimScriptFrameSlot("late", 10).granted).toBe(false);
    expect(frameFor(a)).not.toBeNull();
    expect(frameFor(a)?.style.display).toBe("block");
  });
});

// ===========================================================================
// 3. The document lifecycle
// ===========================================================================

describe("File > New / File > Open", () => {
  it("hands back every charge, so the next workbook starts with a full budget", () => {
    const sheet1 = sheetIds(0, MAX_LIVE_SCRIPT_FRAMES);
    mountSheet(0, sheet1);
    expect(scriptFrameBudgetUsage().frames).toBe(MAX_LIVE_SCRIPT_FRAMES);

    // What `reloadForNewDocument` now calls.
    releaseAllShapeHtmlOverlays();

    expect(scriptFrameBudgetUsage()).toEqual({ frames: 0, bytes: 0 });
    expect(parkedScriptFrameCount()).toBe(0);
    expect(frameCount()).toBe(0);

    // The second workbook of the session gets all 24 of them.
    const next = sheetIds(0, MAX_LIVE_SCRIPT_FRAMES);
    mountSheet(0, next);
    for (const id of next) expect(getShapeFrameRefusal(id)).toBeUndefined();
    expect(frameCount()).toBe(MAX_LIVE_SCRIPT_FRAMES);
  });

  it("takes the previous document's html with it", () => {
    const a = idFor(0, 0);
    mountSheet(0, [a]);
    expect(getShapeHtmlContent(a)).toBe(HTML);

    releaseAllShapeHtmlOverlays();

    // A control's id derives from its anchor cell, so an ORDINARY shape in the
    // new workbook at the same anchor would otherwise paint the old workbook's
    // frame content.
    expect(getShapeHtmlContent(a)).toBeUndefined();
    painted = [];
    paint(a, 0, 0);
    expect(frameFor(a)).toBeNull();
    expect(painted).toContain("fill");
    expect(scriptFrameBudgetUsage().frames).toBe(0);
  });

  it("releases a parked frame's charge too", () => {
    const sheet1 = sheetIds(0, 3);
    mountSheet(0, sheet1);
    announceFloatingControlRegions(new Set<string>());
    expect(parkedScriptFrameCount()).toBe(3);

    releaseAllShapeHtmlOverlays();

    expect(scriptFrameBudgetUsage()).toEqual({ frames: 0, bytes: 0 });
    expect(parkedScriptFrameCount()).toBe(0);
    expect(frameCount()).toBe(0);
  });
});

// ===========================================================================
// 4. A re-anchor that lands one shape's id on another's
//
// A control id IS its anchor cell, and `reanchorFloatingControls` re-keys a
// pinned control onto its new anchor with no collision check while an unpinned
// control sitting at that anchor keeps its id. Mixed pin states in one column
// are the ordinary case — unpinned is the default and the Properties Pane pins
// one control at a time — so a row delete can put two live html shapes on one
// id. Everything keyed by that id is then overwritten, and both halves of what
// gets overwritten used to be silently kept: the displaced iframe stayed in the
// canvas parent with no map entry naming it (nothing could ever remove it
// again) and its bytes stayed in the budget's running total forever.
// ===========================================================================

describe("two html shapes whose ids collide after a structural edit", () => {
  it("takes the displaced frame's element and its charge with it", () => {
    // The free shape anchored at row 8, the pinned one at row 10 of the same
    // column, both painted.
    const free = idFor(0, 8);
    const pinned = idFor(0, 10);
    announceFloatingControlRegions(new Set([free, pinned]));
    setShapeHtmlContent(free, HTML);
    paint(free, 0, 8);
    // Each document carries its own instance id, so the two charges differ by a
    // byte or two — which is what makes "the survivor is charged for the frame
    // that actually survived" an assertion rather than a coincidence.
    const freeBytes = scriptFrameBudgetUsage().bytes;
    setShapeHtmlContent(pinned, HTML);
    paint(pinned, 0, 10);
    expect(frameCount()).toBe(2);
    const both = scriptFrameBudgetUsage();
    expect(both.frames).toBe(2);
    const pinnedBytes = both.bytes - freeBytes;
    const arriving = getShapeOverlayFrame(pinned);

    // Rows 8-9 are deleted. The free shape keeps its id and its pixels — an
    // unpinned control is never handed to the shift at all, not even when its
    // own anchor row is one of the deleted ones — while the pinned one
    // re-anchors onto row 8, so the rename lands on an id already in use.
    migrateShapeInstanceId(pinned, free);

    // One frame in the DOM, and it is the one that moved.
    expect(frameCount()).toBe(1);
    expect(getShapeOverlayFrame(free)).toBe(arriving);
    expect(getShapeOverlayFrame(pinned)).toBeNull();
    // The element's own label says so too — `frameFor` finds it by the id the
    // element carries, which is how a frame in the canvas parent is traced back
    // to a control at all.
    expect(frameFor(free)).toBe(arriving);
    // ...and the budget charges for exactly that one. It used to keep both
    // charges against a single map entry, which no release could undo.
    expect(scriptFrameBudgetUsage()).toEqual({ frames: 1, bytes: pinnedBytes });

    releaseAllShapeHtmlOverlays();
    expect(scriptFrameBudgetUsage()).toEqual({ frames: 0, bytes: 0 });
    expect(frameCount()).toBe(0);
  });

  it("takes the displaced shape's pointer claims with it too", () => {
    // A shim is not keyed to the frame it covers — it CLOSES OVER the element —
    // and the displaced control's frame is removed by the migration above. Left
    // behind, the shim is reused by the arrival on its next paint (the reuse
    // rule is "same rectangle COUNT", which two one-button shapes trivially
    // satisfy) and every claimed click is posted into a detached document:
    // swallowed on the way in by the shim's own stopPropagation, delivered
    // nowhere, for the rest of the session.
    const free = idFor(0, 8);
    const pinned = idFor(0, 10);
    announceFloatingControlRegions(new Set([free, pinned]));
    setShapeHitRegions(free, [{ id: "save", x: 0, y: 0, width: 40, height: 20 }]);
    setShapeHtmlContent(free, HTML);
    paint(free, 0, 8);
    setShapeHitRegions(pinned, [{ id: "run", x: 0, y: 0, width: 40, height: 20 }]);
    setShapeHtmlContent(pinned, HTML);
    paint(pinned, 0, 10);
    expect(shims()).toHaveLength(2);

    migrateShapeInstanceId(pinned, free);
    expect(shims()).toHaveLength(0);

    // The arrival rebuilds its own claim on the next paint, over the frame it
    // actually has and for the rectangle IT declared.
    paint(free, 0, 8);
    expect(shims().map((s) => s.dataset.hitRegionId)).toEqual(["run"]);

    // ...and a click on it reaches that frame. This is the half a length check
    // cannot see: a reused shim still says "run" while posting into the removed
    // element, so the script hears nothing at all.
    const arriving = getShapeOverlayFrame(free);
    const postMessage = vi.fn();
    Object.defineProperty(arriving, "contentWindow", {
      configurable: true,
      value: { postMessage },
    });
    shims()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 5. The edit that produced the collision in the first place
//
// A shift moves a BLOCK of anchors, so the destinations are the block's own
// ids: two pinned shapes one row apart, with a row inserted above them, are
// renamed `r5 -> r6` and `r6 -> r7`. Applied in store order the first of those
// displaced a live shape that had not moved yet — which is a collision the edit
// invented, between two controls that stay one row apart throughout. Ordering
// the renames so a destination is always vacant dissolves it: the frames, the
// documents and the charges all survive the edit untouched.
// ===========================================================================

describe("a row inserted above two pinned html shapes one row apart", () => {
  it("keeps both frames, both documents and both charges", () => {
    const upper = addPinnedShape(5);
    const lower = addPinnedShape(6);
    announceFloatingControlRegions(new Set([upper, lower]));
    setShapeHtmlContent(upper, "<b>upper</b>");
    paint(upper, 0, 5);
    setShapeHtmlContent(lower, "<b>lower</b>");
    paint(lower, 0, 6);
    const both = scriptFrameBudgetUsage();
    expect(both.frames).toBe(2);
    expect(frameCount()).toBe(2);

    // The structural edit, through the real store with the real hook.
    reanchorFloatingControls(0, rowInsert(0, 1), movesWithCells, {
      onRename: migrateShapeInstanceId,
    });

    // Each shape's own document moved with it, rather than one being overwritten
    // and the other carried on under an id that is not its control's.
    expect(getShapeHtmlContent(idFor(0, 6))).toBe("<b>upper</b>");
    expect(getShapeHtmlContent(idFor(0, 7))).toBe("<b>lower</b>");
    // Two frames on screen, and the budget charging for exactly those two. It
    // read one frame holding both documents' bytes, with the surplus charged to
    // no id at all — unrecoverable, because release can only subtract what the
    // map still holds.
    expect(frameCount()).toBe(2);
    expect(scriptFrameBudgetUsage()).toEqual(both);
  });

  it("does not drift by a document per edit as the user keeps editing", () => {
    const upper = addPinnedShape(5);
    const lower = addPinnedShape(6);
    announceFloatingControlRegions(new Set([upper, lower]));
    setShapeHtmlContent(upper, "<b>upper</b>");
    paint(upper, 0, 5);
    setShapeHtmlContent(lower, "<b>lower</b>");
    paint(lower, 0, 6);
    const both = scriptFrameBudgetUsage();

    // Each edit cost a phantom megabyte, and roughly sixteen of them reached the
    // 16 MB cap — at which point the next content change on ANY shape was
    // refused with a total the user cannot reconcile with the two tiles on
    // screen. Four is enough to show the total is flat rather than climbing.
    let upperRow = 5;
    let lowerRow = 6;
    for (let edit = 0; edit < 4; edit++) {
      reanchorFloatingControls(0, rowInsert(0, 1), movesWithCells, {
        onRename: migrateShapeInstanceId,
      });
      upperRow += 1;
      lowerRow += 1;
      // The paint that follows every structural edit, under the new ids.
      announceFloatingControlRegions(new Set([idFor(0, upperRow), idFor(0, lowerRow)]));
      paint(idFor(0, upperRow), 0, upperRow);
      paint(idFor(0, lowerRow), 0, lowerRow);

      expect(scriptFrameBudgetUsage()).toEqual(both);
      expect(frameCount()).toBe(2);
      expect(getShapeFrameRefusal(idFor(0, upperRow))).toBeUndefined();
      expect(getShapeFrameRefusal(idFor(0, lowerRow))).toBeUndefined();
    }
    expect(parkedScriptFrameCount()).toBe(0);
  });
});

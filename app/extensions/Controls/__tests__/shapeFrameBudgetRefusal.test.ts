//! FILENAME: app/extensions/Controls/__tests__/shapeFrameBudgetRefusal.test.ts
// PURPOSE: What an on-grid `ui.html` shape does when the live-frame budget
//          refuses its frame — it paints as an ORDINARY shape, it says why, and
//          it stops asking a question whose answer it already has.
// CONTEXT: `updateHtmlOverlay` returned void, so a refusal removed the frame and
//          returned, and `renderFloatingShape` returned straight after it —
//          never reaching the shape catalog below. The shape painted no fill, no
//          stroke, no text, not even the default rectangle a shape without any
//          html would draw, while `hitTestFloatingShape` (canvas-side, and
//          unaffected) kept it selectable: an invisible hole in the grid. The
//          refusal was mute as well — `claimScriptFrameSlot` builds a sentence
//          naming the budget and the way out, the call site dropped it, and the
//          pane card host (CustomControlHost.tsx) shows that same sentence in
//          place of its frame, so the two hosts disagreed about what a refusal
//          looks like.
//
//          Reachable far below the 24-frame cap: the per-call validator lets one
//          document reach 5 MB (`vHtml`) against a 16 MB aggregate, so the
//          FOURTH large-html shape is refused on bytes. Both doors are exercised.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Hoisted because `vi.mock`'s factories are hoisted above every declaration in
// the file, and a factory that closed over an ordinary `const` would read it in
// its temporal dead zone the moment the mocked module is first imported.
const { claimCalls, toasts } = vi.hoisted(() => ({
  claimCalls: [] as Array<{ id: string; bytes: number }>,
  toasts: [] as unknown[][],
}));

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
// An empty property bag: `fetchShapeData` returns early, so the renderer paints
// the catalog defaults — a blue rectangle — and no dynamic import is reached.
vi.mock("../lib/controlApi", () => ({ resolveControlProperties: async () => ({}) }));
vi.mock("../Button/floatingSelection", () => ({
  isFloatingControlSelected: () => false,
  getSelectedFloatingControls: () => [] as string[],
}));

// A PARTIAL mock: the budget itself is the real one (the test and the renderer
// must share its state, or "fill the budget" would fill a different budget), and
// only the claim is wrapped, to count how often the renderer asks. That count is
// the assertion for "stops re-claiming every frame" — a refused shape keeps no
// frame and no content hash, so nothing else distinguishes one attempt from
// sixty.
vi.mock("../../_shared/scriptFrame", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../_shared/scriptFrame")>();
  return {
    ...actual,
    claimScriptFrameSlot: (id: string, bytes: number) => {
      claimCalls.push({ id, bytes });
      return actual.claimScriptFrameSlot(id, bytes);
    },
  };
});

import {
  renderFloatingShape,
  setShapeHtmlContent,
  removeShapeHtmlOverlay,
  getShapeFrameRefusal,
} from "../Shape/shapeRenderer";
import { resetShapeHitRegions } from "../Shape/shapeHitRegions";
import {
  MAX_LIVE_SCRIPT_FRAMES,
  MAX_LIVE_SCRIPT_FRAME_BYTES,
  claimScriptFrameSlot,
  releaseScriptFrameSlot,
  resetScriptFrameBudget,
} from "../../_shared/scriptFrame";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// jsdom does not implement `HTMLIFrameElement.sandbox`, and `updateHtmlOverlay`
// opens with `el.sandbox.add("allow-scripts")`. Standing the accessor up keeps
// the GRANTED path exercising the real renderer rather than throwing before it.
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

const ID = "control-0-2-1";
const SHAPE = { x: 100, y: 60, width: 200, height: 120 };
const HTML = "<button>Save</button>";

let parent: HTMLDivElement;
let canvas: HTMLCanvasElement;
let painted: string[];

/** Silence the refusal's own diagnostic while still counting it. */
function spyOnWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => undefined);
}
let warn: ReturnType<typeof spyOnWarn>;

/** A canvas context that answers every 2D call and REMEMBERS which ones it was
 *  asked to make. "The shape painted nothing" is exactly the absence of `fill`
 *  and `stroke` here, so the recording is the point. */
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

let ctx: CanvasRenderingContext2D;

function paint(shape = SHAPE): void {
  renderFloatingShape({
    ctx,
    canvasWidth: 800,
    canvasHeight: 600,
    region: {
      id: ID,
      floating: { ...shape },
      data: { controlType: "shape", sheetIndex: 0, row: 2, col: 1 },
    },
  } as never);
}

function overlayFrame(): HTMLIFrameElement | null {
  return parent.querySelector<HTMLIFrameElement>("iframe[data-shape-overlay]");
}

/** True when the ordinary shape-catalog path actually ran: it fills the path
 *  and strokes it, which is what a shape with no html has always drawn. */
function drewTheOrdinaryShape(): boolean {
  return painted.includes("fill") && painted.includes("stroke");
}

/** Occupy the budget with OTHER frames, the way a dashboard's other shapes do. */
function fillFrameCount(): void {
  for (let i = 0; i < MAX_LIVE_SCRIPT_FRAMES; i++) {
    claimScriptFrameSlot(`other-${i}`, 10);
  }
}

beforeEach(() => {
  resetScriptFrameBudget();
  resetShapeHitRegions();
  claimCalls.length = 0;
  toasts.length = 0;
  painted = [];
  parent = document.createElement("div");
  canvas = document.createElement("canvas");
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  ctx = recordingCtx(canvas);
  warn = spyOnWarn();
  setShapeHtmlContent(ID, HTML);
});

afterEach(() => {
  removeShapeHtmlOverlay(ID);
  resetShapeHitRegions();
  resetScriptFrameBudget();
  warn.mockRestore();
  document.body.innerHTML = "";
});

// ===========================================================================
// 1. The failure scenario: the last shape on a full-budget dashboard
// ===========================================================================

describe("a shape whose html frame the budget refuses", () => {
  it("PAINTS THE ORDINARY SHAPE instead of leaving a hole in the grid", () => {
    fillFrameCount();
    paint();

    expect(getShapeFrameRefusal(ID)).toContain(String(MAX_LIVE_SCRIPT_FRAMES));
    // No frame — the budget said no, and nothing half-built was stranded.
    expect(overlayFrame()).toBeNull();
    // ...and the shape is on screen: the catalog's fill and stroke, in the
    // default colours a shape with no html draws.
    expect(drewTheOrdinaryShape()).toBe(true);
    expect((ctx as unknown as { fillStyle: string }).fillStyle).toBe("#4472C4");
    expect((ctx as unknown as { strokeStyle: string }).strokeStyle).toBe("#2F528F");
  });

  it("says why — once — instead of dropping the sentence the budget wrote", () => {
    fillFrameCount();
    paint();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(ID);
    expect(String(warn.mock.calls[0][0])).toContain("close or clear one");
    // The pane card host renders this same sentence in place of its frame; the
    // on-grid host toasts it, so the two hosts no longer disagree about whether
    // a refusal is visible at all.
    expect(toasts).toHaveLength(1);
    expect(String(toasts[0][0])).toContain("close or clear one");
    expect(toasts[0][1]).toEqual({ variant: "warning" });
  });

  it("stays quiet across the repaints that follow, and stops re-claiming", () => {
    fillFrameCount();
    paint();
    const claimsAfterFirstPaint = claimCalls.length;
    paint();
    paint();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(toasts).toHaveLength(1);
    // The refused shape has no frame and no content hash, so every repaint
    // re-entered the "needs a document" branch and rebuilt a document the
    // validator lets reach 5 MB — sixty times a second, for an answer already
    // known. Nothing moved, so nothing was asked again.
    expect(claimCalls.length).toBe(claimsAfterFirstPaint);
    // ...and it is still painted on every one of those frames.
    expect(drewTheOrdinaryShape()).toBe(true);
  });
});

// ===========================================================================
// 2. The cheaper door: bytes, not count
// ===========================================================================

describe("the byte budget refusing a large document", () => {
  it("refuses on bytes well below the frame cap, and the shape still paints", () => {
    // One other frame holding almost the whole 16 MB aggregate — reachable with
    // four honest shapes, because one document may legally be 5 MB.
    claimScriptFrameSlot("other-big", MAX_LIVE_SCRIPT_FRAME_BYTES - 10);
    paint();

    expect(getShapeFrameRefusal(ID)).toContain("make the content smaller");
    expect(overlayFrame()).toBeNull();
    expect(drewTheOrdinaryShape()).toBe(true);
  });
});

// ===========================================================================
// 3. The way out the sentence names actually works
// ===========================================================================

describe("a refusal that the user clears", () => {
  it("takes the frame on the next paint once another frame is released", () => {
    fillFrameCount();
    paint();
    expect(overlayFrame()).toBeNull();

    // Exactly what the message tells the user to do.
    releaseScriptFrameSlot("other-0");
    painted = [];
    paint();

    expect(getShapeFrameRefusal(ID)).toBeUndefined();
    const frame = overlayFrame();
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    // The frame owns the pixels again: the canvas paints no shape under it.
    expect(drewTheOrdinaryShape()).toBe(false);
  });

  it("announces a SECOND filling of the budget rather than staying silent", () => {
    fillFrameCount();
    paint();
    releaseScriptFrameSlot("other-0");
    paint();
    expect(getShapeFrameRefusal(ID)).toBeUndefined();

    // The shape's own frame now holds a slot; fill the budget around it again.
    removeShapeHtmlOverlay(ID);
    setShapeHtmlContent(ID, HTML);
    claimScriptFrameSlot("other-0", 10);
    painted = [];
    paint();

    expect(getShapeFrameRefusal(ID)).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(toasts).toHaveLength(2);
    expect(drewTheOrdinaryShape()).toBe(true);
  });
});

// ===========================================================================
// 4. A granted frame is untouched by any of this
// ===========================================================================

describe("a shape whose frame the budget grants", () => {
  it("paints the frame and no canvas shape, and records no refusal", () => {
    paint();
    expect(overlayFrame()).not.toBeNull();
    expect(getShapeFrameRefusal(ID)).toBeUndefined();
    expect(drewTheOrdinaryShape()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(0);
  });

  it("does not rebuild its document on repaints either", () => {
    paint();
    const afterFirst = claimCalls.length;
    paint();
    paint();
    // The content hash short-circuits this one; the refused case above needs
    // its own record because it has no hash to compare against.
    expect(claimCalls.length).toBe(afterFirst);
  });
});

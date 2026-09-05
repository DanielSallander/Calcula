//! FILENAME: app/extensions/Controls/__tests__/shapeHitRegions.test.ts
// PURPOSE: The DOM half of M3b — a shape script's `ui.html` frame is
//          click-through until it DECLARES rectangles, each declared rectangle
//          claims pointer input and forwards it into the frame, everything else
//          still reaches the grid, and the claim dies with the frame.
// CONTEXT: `updateHtmlOverlay` set every overlay iframe to
//          `pointer-events: none` UNCONDITIONALLY, with the comment that it
//          "allows click-through" — so the whole `ui.html` surface was
//          decorative and no script could ever be clicked. The fix must not
//          overshoot in the other direction: an interactive FRAME would swallow
//          every pointer event inside the shape's box, including the ones that
//          select, move and resize the shape, so the frame stays
//          `pointer-events: none` forever and the claim is made by host-owned
//          shim elements over the declared rectangles only.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const requestOverlayRedraw = vi.fn();

vi.mock("@api/gridOverlays", () => ({
  overlayGetRowHeaderWidth: () => 0,
  overlayGetColHeaderHeight: () => 0,
  overlaySheetToCanvas: (_c: unknown, x: number, y: number) => ({ canvasX: x, canvasY: y }),
  requestOverlayRedraw: () => requestOverlayRedraw(),
  // Section 6 drives the REAL floating store, which publishes through these two.
  // The region list itself is the app's, not this test's — what is asserted is
  // what the store announces on either side of a publication.
  replaceGridRegionsByType: () => undefined,
  removeGridRegionsByType: () => undefined,
}));
vi.mock("@api", () => ({
  getShapeBitmap: () => null,
  hasShapeBitmapRenderer: () => false,
}));
vi.mock("@api/events", () => ({ emitAppEvent: () => undefined }));
// An empty property bag: `fetchShapeData` returns early, so the renderer paints
// from its defaults and no dynamic import of the floating store is reached.
vi.mock("../lib/controlApi", () => ({ resolveControlProperties: async () => ({}) }));
vi.mock("../Button/floatingSelection", () => ({
  isFloatingControlSelected: () => false,
  getSelectedFloatingControls: () => [] as string[],
}));

import { setDesignMode } from "@api/designMode";
import { isPointerClaimed } from "@api/pointerClaims";
import { SHAPE_HIT_POINTER_MESSAGE_TYPE } from "@api/scriptHost/shapeHitRegionSpec";
// The envelope's tag comes from the module that owns both ends of it. Asserted
// as a literal here, this test pinned a copy against a copy: it would have gone
// on passing while the host router moved to a renamed constant and every
// claimed click landed on a frame that no longer answered to this spelling.
import { SCRIPT_FRAME_MESSAGE_TAG } from "../../_shared/scriptFrame";
import {
  renderFloatingShape,
  setShapeHtmlContent,
  removeShapeHtmlOverlay,
} from "../Shape/shapeRenderer";
import {
  SHAPE_HIT_OUTLINE_ATTR,
  SHAPE_HIT_SHIM_ATTR,
  getShapeHitRegions,
  resetShapeHitRegions,
  setShapeHitRegions,
  shapeHitShimRects,
} from "../Shape/shapeHitRegions";
import {
  addFloatingControl,
  removeFloatingControlsForSheet,
  resetFloatingStore,
  syncFloatingControlRegions,
} from "../lib/floatingStore";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// jsdom does not implement `HTMLIFrameElement.sandbox`, and `updateHtmlOverlay`
// opens with `el.sandbox.add("allow-scripts")` — the line that gives the frame
// its opaque origin. Standing the accessor up here keeps this test exercising
// the REAL renderer instead of a re-implementation of it, which is the only way
// an assertion about `style.pointerEvents` means anything.
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
/** The shape's box in sheet pixels; with zero header gutters this is also its
 *  canvas box, so every expected shim coordinate below is `origin + region`. */
const SHAPE = { x: 100, y: 60, width: 200, height: 120 };

let parent: HTMLDivElement;
let canvas: HTMLCanvasElement;
let canvasClicks: number;

/** A canvas context that answers every 2D call and remembers its element. */
function fakeCtx(el: HTMLCanvasElement): CanvasRenderingContext2D {
  const target: Record<string, unknown> = { canvas: el, globalAlpha: 1 };
  return new Proxy(target, {
    get: (obj, prop) => (prop in obj ? obj[prop as string] : () => undefined),
    set: (obj, prop, value) => {
      obj[prop as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function overlayCtx(shape = SHAPE) {
  return {
    ctx: fakeCtx(canvas),
    canvasWidth: 800,
    canvasHeight: 600,
    region: {
      id: ID,
      floating: { ...shape },
      data: { controlType: "shape", sheetIndex: 0, row: 2, col: 1 },
    },
  } as never;
}

/** Paint one frame of the grid. */
function paint(shape = SHAPE): void {
  renderFloatingShape(overlayCtx(shape));
}

function frame(): HTMLIFrameElement {
  const el = parent.querySelector<HTMLIFrameElement>("iframe[data-shape-overlay]");
  if (!el) throw new Error("no overlay iframe was created");
  return el;
}

function shims(): HTMLElement[] {
  return [...parent.querySelectorAll<HTMLElement>(`[${SHAPE_HIT_SHIM_ATTR}]`)];
}

function outlines(): HTMLElement[] {
  return [...parent.querySelectorAll<HTMLElement>(`[${SHAPE_HIT_OUTLINE_ATTR}]`)];
}

/** Replace the sandboxed frame's unreachable `contentWindow` with a spy. */
function spyOnFrameMessages(): ReturnType<typeof vi.fn> {
  const postMessage = vi.fn();
  Object.defineProperty(frame(), "contentWindow", {
    configurable: true,
    value: { postMessage },
  });
  return postMessage;
}

beforeEach(() => {
  setDesignMode(false);
  parent = document.createElement("div");
  canvas = document.createElement("canvas");
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  canvasClicks = 0;
  canvas.addEventListener("click", () => {
    canvasClicks++;
  });
  setShapeHtmlContent(ID, "<button>Save</button>");
});

afterEach(() => {
  removeShapeHtmlOverlay(ID);
  resetShapeHitRegions();
  setDesignMode(false);
  document.body.innerHTML = "";
});

// ===========================================================================
// 1. No declaration: exactly today's behaviour
// ===========================================================================

describe("a frame that declared nothing", () => {
  it("is click-through, and puts no element over the grid", () => {
    paint();
    expect(frame().style.pointerEvents).toBe("none");
    expect(shims()).toHaveLength(0);
  });

  it("stays click-through however many frames are painted", () => {
    paint();
    paint();
    paint();
    expect(frame().style.pointerEvents).toBe("none");
    expect(shims()).toHaveLength(0);
  });

  it("is out of the tab order as well — click-through is the mouse only", () => {
    paint();
    // `pointer-events: none` is a hit-testing property and stops nothing else.
    // An iframe keeps its place in the sequential focus order however it is
    // styled, so Tab walked off the grid, into the frame's document and onto
    // whatever the script drew — and a `ui.html`-only script's `<input>` read
    // what was typed there, with no rectangle declared and no `ui.htmlInput`.
    // `inert` is what actually removes the document's focusable areas; the
    // shims are siblings rather than children, so the claimed path is untouched.
    expect(frame().hasAttribute("inert")).toBe(true);
  });
});

// ===========================================================================
// 2. A declared rectangle
// ===========================================================================

describe("a declared rectangle", () => {
  beforeEach(() => {
    setShapeHitRegions(ID, [{ id: "save", x: 8, y: 12, width: 60, height: 24 }]);
    paint();
  });

  it("gets one shim, placed at the frame's origin plus the declared offset", () => {
    const [shim] = shims();
    expect(shims()).toHaveLength(1);
    // Frame-local (8,12) inside a frame whose top-left is the shape's (100,60).
    expect(shim.style.left).toBe("108px");
    expect(shim.style.top).toBe("72px");
    expect(shim.style.width).toBe("60px");
    expect(shim.style.height).toBe("24px");
    expect(shim.dataset.hitRegionId).toBe("save");
  });

  it("claims pointer input, while the FRAME itself never does", () => {
    expect(shims()[0].style.pointerEvents).toBe("auto");
    // The frame staying "none" is the whole safety property: a script gets the
    // rectangles it named, never the rest of its box.
    expect(frame().style.pointerEvents).toBe("none");
    // ...and it stays inert with the claim standing, because on this host a
    // claim buys SYNTHESIZED pointer messages and never focus — which is what
    // lets `ui.htmlInput` promise "pointer input only: there is no key stream"
    // on the grid. An inert document still receives postMessage, so the
    // delivery test below is unaffected.
    expect(frame().hasAttribute("inert")).toBe(true);
  });

  it("sits above the frame it belongs to", () => {
    expect(Number(shims()[0].style.zIndex)).toBeGreaterThan(Number(frame().style.zIndex));
  });

  it("delivers a click into the frame, in the frame's own coordinates", () => {
    const postMessage = spyOnFrameMessages();
    shims()[0].dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [message] = postMessage.mock.calls[0];
    expect(message.target).toBe(SCRIPT_FRAME_MESSAGE_TAG);
    expect(message.instanceId).toBe(ID);
    expect(message.type).toBe(SHAPE_HIT_POINTER_MESSAGE_TYPE);
    expect(message.data.region).toBe("save");
    expect(message.data.kind).toBe("click");
    // Frame-local, NOT canvas pixels: the script never learns where on the grid
    // its shape is. (jsdom reports no offset within the shim, so this is the
    // rectangle's own corner — 8,12 — rather than 108,72.)
    expect(message.data.x).toBe(8);
    expect(message.data.y).toBe(12);
  });

  it("reports a pointerdown as well, so a frame can react before the click", () => {
    const postMessage = spyOnFrameMessages();
    shims()[0].dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(postMessage.mock.calls[0][0].data.kind).toBe("pointerdown");
  });

  it("forwards a DOUBLE-click too, rather than swallowing it", () => {
    // Core's double-click door now honours the claim (gridPointerEntry.ts), so
    // without this the gesture reaches nothing at all — not the grid, not the
    // script — which is a worse answer than either of the two the host can give.
    const postMessage = spyOnFrameMessages();
    shims()[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0 }));

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [message] = postMessage.mock.calls[0];
    expect(message.data.kind).toBe("dblclick");
    expect(message.data.region).toBe("save");
    expect(message.data.x).toBe(8);
    expect(message.data.y).toBe(12);
  });

  it("stops the claimed double-click bubbling to the ancestor Core listens on", () => {
    // The canvas is a SIBLING of the shim, so it never sees this event either
    // way; `parent` stands for `S.GridArea`, which is where Core's handlers
    // actually are, and is the only place a bubble could do damage.
    spyOnFrameMessages();
    let bubbled = 0;
    parent.addEventListener("dblclick", () => {
      bubbled++;
    });
    shims()[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(bubbled).toBe(0);
  });

  it("does not let the claimed click reach the grid canvas", () => {
    spyOnFrameMessages();
    shims()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(canvasClicks).toBe(0);
  });

  it("leaves every other pixel of the frame to the grid", () => {
    // Two halves of "passes through": nothing the host placed covers the point,
    // and a click there still reaches the canvas listener untouched.
    const rects = shapeHitShimRects(
      getShapeHitRegions(ID),
      SHAPE.x,
      SHAPE.y,
      SHAPE.width,
      SHAPE.height,
    );
    const outside = { x: 100 + 150, y: 60 + 100 }; // frame-local (150,100)
    const covered = rects.some(
      (r) =>
        outside.x >= r.left &&
        outside.x < r.left + r.width &&
        outside.y >= r.top &&
        outside.y < r.top + r.height,
    );
    expect(covered).toBe(false);

    canvas.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(canvasClicks).toBe(1);
  });

  it("CLAIMS THE POINTER against Core's own rule, so the grid stands down", () => {
    // The bug this pins: a shim stops `pointerdown` and `click`, and Core
    // listens for `mousedown` — on `S.GridArea`, an ANCESTOR of this element —
    // so the press bubbled straight past into the grid, which selected the
    // shape and opened the properties pane over a rectangle the script owns.
    // Asserted through Core's REAL predicate rather than by reading the
    // attribute here, so a rename or a rule change in Core reds this surface
    // instead of leaving it silently decorative again.
    expect(isPointerClaimed({ target: shims()[0], button: 0 })).toBe(true);
  });

  it("claims nothing on an undeclared pixel — that press is still the grid's", () => {
    expect(isPointerClaimed({ target: frame(), button: 0 })).toBe(false);
    expect(isPointerClaimed({ target: canvas, button: 0 })).toBe(false);
  });

  it("does not claim RIGHT presses, so the shape's own menu stays reachable", () => {
    expect(isPointerClaimed({ target: shims()[0], button: 2 })).toBe(false);
  });

  it("does not claim right-click, so the shape's own menu stays reachable", () => {
    // The menu handlers route by client point from a window listener; the shim
    // must not stop the event, or a fully claimed frame would be a shape the
    // user can never open a menu on.
    let sawContextMenu = 0;
    const onMenu = (): void => {
      sawContextMenu++;
    };
    window.addEventListener("contextmenu", onMenu);
    shims()[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    window.removeEventListener("contextmenu", onMenu);
    expect(sawContextMenu).toBe(1);
  });
});

// ===========================================================================
// 3. Geometry: clipping and the frame's box
// ===========================================================================

describe("the trusted store re-checks the budget", () => {
  it("refuses an over-budget declaration WHOLE and leaves the previous claim standing", () => {
    // vHitRegions refuses this at the broker; this is the second check, at the
    // boundary where a claim becomes a DOM element and where any host-side
    // emitter of the app event can reach. Truncating would leave a frame
    // interactive in some of the places its author asked for and not others.
    setShapeHitRegions(ID, [{ id: "save", x: 8, y: 12, width: 60, height: 24 }]);
    paint();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setShapeHitRegions(
      ID,
      Array.from({ length: 17 }, (_, i) => ({ id: `r${i}`, x: 0, y: 0, width: 4, height: 4 })),
    );
    warn.mockRestore();
    expect(getShapeHitRegions(ID).map((r) => r.id)).toEqual(["save"]);
    paint();
    expect(shims()).toHaveLength(1);
    expect(shims()[0].dataset.hitRegionId).toBe("save");
  });

  it("keeps a copy, so a caller holding its array cannot change the claim later", () => {
    const declared = [{ id: "save", x: 8, y: 12, width: 60, height: 24 }];
    setShapeHitRegions(ID, declared);
    declared.push({ id: "sneak", x: 0, y: 0, width: 200, height: 120 });
    expect(getShapeHitRegions(ID)).toHaveLength(1);
  });
});

describe("two rectangles that overlap", () => {
  it("give the shared pixels to the LAST declared, the way a painter's order reads", () => {
    // Nothing computes this: the shims are appended in declaration order, so
    // the later one is the later sibling and the browser puts it on top. The
    // test pins the ORDER the elements are created in, which is the only thing
    // the host controls and the only thing that could silently reverse.
    setShapeHitRegions(ID, [
      { id: "under", x: 0, y: 0, width: 100, height: 100 },
      { id: "over", x: 40, y: 40, width: 20, height: 20 },
    ]);
    paint();
    expect(shims().map((s) => s.dataset.hitRegionId)).toEqual(["under", "over"]);
  });
});

describe("a rectangle is clipped to the frame that owns it", () => {
  it("trims a rectangle that runs past the frame's edge", () => {
    const [rect] = shapeHitShimRects([{ id: "wide", x: 180, y: 0, width: 100, height: 10 }], 0, 0, 200, 120);
    expect(rect.width).toBe(20);
    expect(rect.left).toBe(180);
  });

  it("drops one that falls entirely outside — a claim cannot reach past the frame", () => {
    expect(shapeHitShimRects([{ id: "off", x: 400, y: 0, width: 10, height: 10 }], 0, 0, 200, 120))
      .toHaveLength(0);
  });

  it("reports the clipped corner as the frame-local origin of the shim", () => {
    // Negative-coordinate rectangles never reach here (vHitRegions refuses
    // them), but a frame clipped by a header shrinks, and the shim must still
    // report the point the frame would measure.
    const [rect] = shapeHitShimRects([{ id: "a", x: 5, y: 5, width: 50, height: 50 }], 300, 200, 200, 120);
    expect(rect.frameX).toBe(5);
    expect(rect.frameY).toBe(5);
    expect(rect.left).toBe(305);
    expect(rect.top).toBe(205);
  });
});

// ===========================================================================
// 4. Design Mode — the user's escape, and the chrome that makes it legible
//
// THE OUTLINE HAS TO BE ABOVE THE FRAME, AND THAT IS THE ASSERTION. It was a
// `ctx.strokeRect` onto the grid canvas, and the user never saw a pixel of it:
// the frame is an OPAQUE (`background: #ffffff`) positioned sibling of that
// canvas in the same parent at `z-index: 5`, the canvas is positioned with no
// z-index, and every outline rectangle is clipped INSIDE the frame's box — so
// the frame painted over all of it, every time. The old test asserted the
// strokeRect ARGUMENTS, which is exactly the assertion that let it through:
// the numbers were right and the ink was invisible. So these assert where the
// outline sits in the stack, not what coordinates it was drawn at.
// ===========================================================================

describe("design mode", () => {
  beforeEach(() => {
    setShapeHitRegions(ID, [{ id: "whole", x: 0, y: 0, width: 200, height: 120 }]);
    paint();
  });

  it("suspends every claim, so a fully claimed shape can still be grabbed", () => {
    expect(shims()).toHaveLength(1);
    setDesignMode(true);
    paint();
    expect(shims()).toHaveLength(0);
    // The frame is still painted — only the claim is suspended.
    expect(frame().style.display).toBe("block");
  });

  it("gives the claim back when design mode goes off again", () => {
    setDesignMode(true);
    paint();
    setDesignMode(false);
    paint();
    expect(shims()).toHaveLength(1);
  });

  it("outlines each declared rectangle ABOVE the frame, where the user can see it", () => {
    setDesignMode(true);
    paint();

    expect(outlines()).toHaveLength(1);
    const [outline] = outlines();
    // Same stacking parent as the frame, or comparing z-index would mean
    // nothing — the frame's z-index only out-paints a SIBLING.
    expect(outline.parentElement).toBe(frame().parentElement);
    expect(Number(outline.style.zIndex)).toBeGreaterThan(Number(frame().style.zIndex));
    // ...and it is a real, painted box at the declared rectangle.
    expect(outline.style.borderStyle).toBe("dashed");
    expect(outline.style.left).toBe("100px");
    expect(outline.style.top).toBe("60px");
    expect(outline.style.width).toBe("200px");
    expect(outline.style.height).toBe("120px");
    expect(outline.dataset.hitRegionId).toBe("whole");
  });

  it("never claims input with the element that SHOWS a claim", () => {
    // Design Mode's promise is that the clicks come back. An outline element
    // sitting above the frame with `pointer-events: auto` would take them
    // straight back off the user — a shim by another name.
    setDesignMode(true);
    paint();
    expect(outlines()[0].style.pointerEvents).toBe("none");
    // ...nor with Core's claim rule, which is the half `pointer-events` alone
    // does not cover: the outline is not hit-testable, so it can never BE the
    // target, but an outline that carried the attribute would claim every press
    // that landed on a descendant of it.
    expect(isPointerClaimed({ target: outlines()[0], button: 0 })).toBe(false);

    outlines()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // Nothing swallowed it: the event still reaches the window, and no shim
    // exists to forward it into the frame.
    expect(shims()).toHaveLength(0);
  });

  it("takes the outline down when design mode goes off", () => {
    setDesignMode(true);
    paint();
    expect(outlines()).toHaveLength(1);
    setDesignMode(false);
    paint();
    // A dashed rectangle left over a frame that is claiming those pixels again
    // says the opposite of what is true.
    expect(outlines()).toHaveLength(0);
    expect(shims()).toHaveLength(1);
  });

  it("outlines nothing when the script declared nothing", () => {
    setShapeHitRegions(ID, []);
    setDesignMode(true);
    paint();
    expect(outlines()).toHaveLength(0);
  });

  it("takes the outline away with the frame when it scrolls out of view", () => {
    setDesignMode(true);
    paint();
    expect(outlines()).toHaveLength(1);
    // Scrolled until its right edge meets the row header: `updateHtmlOverlay`
    // hides the frame, and a dashed rectangle naming a claim that is nowhere on
    // screen must go with it.
    paint({ x: -200, y: 60, width: 200, height: 120 });
    expect(frame().style.display).toBe("none");
    expect(outlines()).toHaveLength(0);
  });

  it("re-uses its elements across repaints instead of churning the DOM", () => {
    // The paint runs every frame; rebuilding the elements each time would make
    // scrolling in Design Mode a DOM storm. Same reuse rule as the shims.
    setDesignMode(true);
    paint();
    const first = outlines()[0];
    paint();
    expect(outlines()[0]).toBe(first);
  });

  it("follows a re-declaration to the new rectangles", () => {
    setDesignMode(true);
    paint();
    setShapeHitRegions(ID, [{ id: "corner", x: 10, y: 20, width: 30, height: 40 }]);
    paint();
    const [outline] = outlines();
    expect(outlines()).toHaveLength(1);
    expect(outline.dataset.hitRegionId).toBe("corner");
    expect(outline.style.left).toBe("110px");
    expect(outline.style.top).toBe("80px");
  });
});

// ===========================================================================
// 5. The claim dies with the frame
// ===========================================================================

describe("releasing the frame", () => {
  beforeEach(() => {
    setShapeHitRegions(ID, [{ id: "save", x: 8, y: 12, width: 60, height: 24 }]);
    paint();
  });

  it("an empty declaration releases it immediately — the unmount sweep's door", () => {
    expect(shims()).toHaveLength(1);
    setShapeHitRegions(ID, []);
    expect(shims()).toHaveLength(0);
    expect(getShapeHitRegions(ID)).toHaveLength(0);
    // ...and does not come back on the next paint.
    paint();
    expect(shims()).toHaveLength(0);
  });

  it("removing the html overlay drops the claim with it", () => {
    removeShapeHtmlOverlay(ID);
    expect(shims()).toHaveLength(0);
    expect(getShapeHitRegions(ID)).toHaveLength(0);
  });

  it("a frame clipped out of view claims nothing", () => {
    // `display: none` does not travel to the shims — they are siblings of the
    // iframe, not children — so a hidden frame that kept its shims would leave
    // invisible click-eaters over whatever scrolled into that space.
    // Scrolled until its right edge exactly meets the row header: past the
    // renderer's early-outs, and `updateHtmlOverlay` hides it.
    paint({ x: -200, y: 60, width: 200, height: 120 });
    expect(frame().style.display).toBe("none");
    expect(shims()).toHaveLength(0);
  });

  it("a shape scrolled entirely past the viewport claims nothing either", () => {
    // This one takes the renderer's EARLY-OUT, which never reaches
    // updateHtmlOverlay at all — so the release has to happen at the return.
    // (The frame itself is left painted at its stale position by that same
    // early-out; that is pre-existing and visible, where a stale shim would be
    // invisible and would eat clicks.)
    expect(shims()).toHaveLength(1);
    paint({ x: 5000, y: 5000, width: 200, height: 120 });
    expect(shims()).toHaveLength(0);
  });
});

// ===========================================================================
// 6. ...and when the shape stops being PAINTED AT ALL
//
// Every release above runs from inside the render pass or from an explicit
// teardown, so all of them assume the shape is still being rendered. A sheet
// switch is neither: `removeFloatingControlsForSheet` + `syncFloatingControlRegions`
// drop the departing sheet's overlay region, `renderFloatingShape` is never
// called for that control again, and nothing repositions or removes its shims.
// They stayed at the canvas pixels the shape used to occupy, `pointer-events:
// auto`, eating every click on the NEXT sheet's bare grid — and Design Mode
// could not give them back, because its suspension lives in the very function
// that is no longer called.
// ===========================================================================

describe("a shape that stops being painted", () => {
  const OTHER_SHEET_ID = "control-1-4-3";

  /** Put a control in the store and publish the store, the way a sheet load does. */
  function publish(id: string, sheetIndex: number): void {
    addFloatingControl({
      id,
      sheetIndex,
      row: 2,
      col: 1,
      x: SHAPE.x,
      y: SHAPE.y,
      width: SHAPE.width,
      height: SHAPE.height,
      controlType: "shape",
    });
    syncFloatingControlRegions();
  }

  /** Exactly the store calls `reloadForSheetChange` makes: drop the departing
   *  sheet's controls, then republish (`loadFloatingControls` ends in
   *  `syncFloatingControlRegions` even when the new sheet has no controls). */
  function leaveSheet(sheetIndex: number): void {
    removeFloatingControlsForSheet(sheetIndex);
    syncFloatingControlRegions();
  }

  beforeEach(() => {
    resetFloatingStore();
    setShapeHitRegions(ID, [{ id: "whole", x: 0, y: 0, width: 200, height: 120 }]);
    publish(ID, 0);
    paint();
  });

  afterEach(() => {
    resetFloatingStore();
  });

  it("releases its claim when the sheet's controls are swapped out", () => {
    expect(shims()).toHaveLength(1);
    leaveSheet(0);
    expect(shims()).toHaveLength(0);
    // ...and the frame goes with it, so the user is not left looking at a stale
    // picture of Sheet1's shape while working on Sheet2.
    expect(frame().style.display).toBe("none");
  });

  it("keeps what the script DECLARED, so the shape is interactive on the way back", () => {
    leaveSheet(0);
    // The script is still mounted and will never re-declare on its own: parking
    // the DOM must not throw away the claim, or returning to the sheet would
    // show a frame no click can reach.
    expect(getShapeHitRegions(ID)).toHaveLength(1);
    publish(ID, 0);
    paint();
    expect(shims()).toHaveLength(1);
    expect(frame().style.display).toBe("block");
  });

  it("releases its design-mode OUTLINE when the sheet's controls are swapped out", () => {
    // The same sweep, wearing the other coat. In Design Mode a shape has no
    // shims at all, so a sweep that reads only the shim map finds nothing to
    // release and leaves a dashed rectangle drawn over the next sheet's grid,
    // naming a claim that nothing on screen is making.
    setDesignMode(true);
    paint();
    expect(shims()).toHaveLength(0);
    expect(outlines()).toHaveLength(1);
    leaveSheet(0);
    expect(outlines()).toHaveLength(0);
    expect(frame().style.display).toBe("none");
  });

  it("does not touch a shape that is still published", () => {
    // The sweep is keyed on the published set, so a publication that drops some
    // OTHER control must leave this one claiming exactly what it claimed.
    publish(OTHER_SHEET_ID, 1);
    removeFloatingControlsForSheet(1);
    syncFloatingControlRegions();
    expect(shims()).toHaveLength(1);
    expect(frame().style.display).toBe("block");
  });

  it("releases every claim when the store is reset wholesale", () => {
    // `resetFloatingStore` drops the regions itself instead of going through
    // `syncFloatingControlRegions`, so it is a SECOND publication door — one
    // that File > New and extension deactivation both come through.
    resetFloatingStore();
    expect(shims()).toHaveLength(0);
    expect(frame().style.display).toBe("none");
  });
});

// ===========================================================================
// 7. A RE-DECLARATION THAT KEEPS THE COUNT
//
// `render.setHitRegions` is an ordinary repeatable broker row, so a script
// re-declares its rectangles on every re-layout. `syncShapeHitDom` rebuilds
// the elements only when the NUMBER changed and otherwise repositions the ones
// it has — and the pointer handlers used to close over the rect they were BUILT
// with. Two rectangles re-declared as two other rectangles therefore left the
// element saying one thing (`dataset.hitRegionId`) and the message into the
// frame saying another: a click on the rectangle drawn over Cancel told the
// script `save` was pressed, at the old rectangle's frame-local origin.
//
// Every assertion here reads the POSTED message, not the attribute: asserting
// `dataset.hitRegionId` alone passes on the broken code, which is exactly why
// section 3's over-budget case (the only other re-declaration in this file)
// missed it.
// ===========================================================================

describe("a re-declaration with the same number of rectangles", () => {
  /**
   * What the frame is actually TOLD when this shim receives a pointer event.
   *
   * Parameterised by KIND because `createShim` installs two independent
   * listeners, and each one reads the current rectangle for itself. A test that
   * only ever dispatches "click" leaves the pointerdown handler unpinned — its
   * stale-closure form passes the whole file — so the two are exercised
   * separately below rather than assumed to share a fate.
   */
  function pointerAndRead(
    shim: HTMLElement,
    kind: "click" | "pointerdown",
  ): { region: string; x: number; y: number } {
    const postMessage = spyOnFrameMessages();
    shim.dispatchEvent(new MouseEvent(kind, { bubbles: true, button: 0 }));
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [message] = postMessage.mock.calls[0];
    return { region: message.data.region, x: message.data.x, y: message.data.y };
  }

  function clickAndRead(shim: HTMLElement): { region: string; x: number; y: number } {
    return pointerAndRead(shim, "click");
  }

  it("reports the id the shim now stands for, not the one it was built with", () => {
    setShapeHitRegions(ID, [
      { id: "save", x: 0, y: 0, width: 60, height: 24 },
      { id: "cancel", x: 70, y: 0, width: 60, height: 24 },
    ]);
    paint();
    // The same two ids in the other order: same count, so the elements survive.
    setShapeHitRegions(ID, [
      { id: "cancel", x: 0, y: 0, width: 60, height: 24 },
      { id: "save", x: 70, y: 0, width: 60, height: 24 },
    ]);
    paint();

    const [first] = shims();
    expect(first.dataset.hitRegionId).toBe("cancel");
    expect(clickAndRead(first).region).toBe("cancel");
  });

  it("reports the moved rectangle's NEW frame-local origin", () => {
    setShapeHitRegions(ID, [
      { id: "a", x: 0, y: 0, width: 60, height: 24 },
      { id: "b", x: 70, y: 0, width: 60, height: 24 },
    ]);
    paint();
    setShapeHitRegions(ID, [
      { id: "a", x: 0, y: 90, width: 60, height: 24 },
      { id: "b", x: 70, y: 0, width: 60, height: 24 },
    ]);
    paint();

    const [moved] = shims();
    // Where the user sees it: the frame's origin (60) plus the new offset.
    expect(moved.style.top).toBe("150px");
    // ...and where the script is told it was clicked, which has to agree.
    expect(clickAndRead(moved)).toEqual({ region: "a", x: 0, y: 90 });
  });

  it("holds when ONE rectangle becomes one other — no reordering needed", () => {
    // The narrowest form of the failure: no multi-button toolbar, no swap, just
    // a single claim replaced by a different single claim.
    setShapeHitRegions(ID, [{ id: "one", x: 0, y: 0, width: 60, height: 24 }]);
    paint();
    setShapeHitRegions(ID, [{ id: "two", x: 10, y: 30, width: 60, height: 24 }]);
    paint();

    expect(shims()).toHaveLength(1);
    expect(clickAndRead(shims()[0])).toEqual({ region: "two", x: 10, y: 30 });
  });

  it("still gives overlapping pixels to the LAST declared after a reorder", () => {
    // Section 3 pins this for a FRESH declaration. Reuse could have broken it a
    // second way — the elements keep their sibling order, so if shim i stopped
    // standing for rect i the painter's order would silently reverse.
    setShapeHitRegions(ID, [
      { id: "under", x: 0, y: 0, width: 100, height: 100 },
      { id: "over", x: 40, y: 40, width: 20, height: 20 },
    ]);
    paint();
    setShapeHitRegions(ID, [
      { id: "over", x: 40, y: 40, width: 20, height: 20 },
      { id: "under", x: 0, y: 0, width: 100, height: 100 },
    ]);
    paint();

    // querySelectorAll is document order, which is the order the browser hit-tests.
    expect(shims().map((s) => s.dataset.hitRegionId)).toEqual(["over", "under"]);
    expect(clickAndRead(shims()[1]).region).toBe("under");
  });

  it("reports the current rectangle on POINTERDOWN too, not only on click", () => {
    // The two listeners are separate closures over separate lookups, so "the
    // click path is fixed" says nothing about the pointerdown path. Measured:
    // with only `onPointerDown` left reading its build-time rect, every other
    // assertion in this file still passed — so a partial fix would have shipped
    // silently, and a script that acts on press (drag start, pressed-state
    // feedback) would keep running the previous declaration's handler.
    setShapeHitRegions(ID, [
      { id: "save", x: 0, y: 0, width: 60, height: 24 },
      { id: "cancel", x: 70, y: 0, width: 60, height: 24 },
    ]);
    paint();
    setShapeHitRegions(ID, [
      { id: "cancel", x: 0, y: 40, width: 60, height: 24 },
      { id: "save", x: 70, y: 0, width: 60, height: 24 },
    ]);
    paint();

    expect(pointerAndRead(shims()[0], "pointerdown")).toEqual({
      region: "cancel",
      x: 0,
      y: 40,
    });
  });
});

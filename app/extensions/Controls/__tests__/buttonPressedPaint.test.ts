//! FILENAME: app/extensions/Controls/__tests__/buttonPressedPaint.test.ts
// PURPOSE: A run-mode button LOOKS pressed while its press is held inside it
//          (BUG-0258 design phase 4c; Button/floatingRenderer.ts): no raised
//          highlight, a 12% black wash over the face, the caption 1 px down
//          and right -- and back to the raised look the moment the press ends
//          or the pointer slides off. Plus: while the press is held, the
//          button's object-selection provider owns Escape (the press cancels
//          on it), so a canvas does not also deselect the button.
// CONTEXT: The press state is the real lib/buttonPress.ts; the hit test it
//          asks while the pointer moves is doubled. The live journey samples
//          the button's centre pixel held vs released (moving-objects step 15).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ inside: true }));

vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/gridOverlays")>()),
  requestOverlayRedraw: () => {},
  topFloatingRegionAtClient: () => (h.inside ? { id: "control-0-2-1" } : null),
}));
// An empty property bag: the renderer paints its defaults and fetches nothing further.
vi.mock("../lib/controlApi", () => ({ resolveControlProperties: async () => ({}) }));

import { renderFloatingButton, BUTTON_PRESSED_SHADE } from "../Button/floatingRenderer";
import { beginFloatingButtonPress, cancelFloatingButtonPress } from "../lib/buttonPress";
import { createControlSelectionProvider } from "../lib/controlObjectSelection";

const ID = "control-0-2-1";

interface Fill {
  style: unknown;
  alpha: number;
}

/** A canvas context that records every fill (style + alpha) and every caption. */
function recordingCtx(): { ctx: CanvasRenderingContext2D; fills: Fill[]; texts: Array<{ text: string; x: number; y: number }> } {
  const fills: Fill[] = [];
  const texts: Array<{ text: string; x: number; y: number }> = [];
  const target: Record<string, unknown> = {
    globalAlpha: 1,
    fillStyle: "#000",
    fill: () => fills.push({ style: target.fillStyle, alpha: target.globalAlpha as number }),
    fillText: (text: string, x: number, y: number) => texts.push({ text, x, y }),
  };
  const ctx = new Proxy(target, {
    get: (obj, prop) => (prop in obj ? obj[prop as string] : () => undefined),
    set: (obj, prop, value) => {
      obj[prop as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, fills, texts };
}

/** Paint the button at sheet (64, 64), 160 x 40; headers 50 x 24, no scroll. */
function paint() {
  const rec = recordingCtx();
  renderFloatingButton({
    ctx: rec.ctx,
    canvasWidth: 2000,
    canvasHeight: 2000,
    config: { rowHeaderWidth: 50, colHeaderHeight: 24 },
    viewport: { scrollX: 0, scrollY: 0 },
    region: {
      id: ID,
      type: "floating-control",
      floating: { x: 64, y: 64, width: 160, height: 40 },
      data: { controlType: "button", sheetIndex: 0, row: 2, col: 1, movable: false },
    },
  } as never);
  return rec;
}

const CENTRE = { x: 50 + 64 + 80, y: 24 + 64 + 20 };
const highlight = (fills: Fill[]) => fills.filter((f) => f.style === "#f0f0f0");
const wash = (fills: Fill[]) => fills.filter((f) => f.style === "#000000" && f.alpha === BUTTON_PRESSED_SHADE);

beforeEach(() => {
  h.inside = true;
});

afterEach(() => {
  cancelFloatingButtonPress();
});

describe("the pressed look", () => {
  it("control: released, the button is raised -- the highlight, no wash, the caption centred", () => {
    const { fills, texts } = paint();
    expect(highlight(fills)).toHaveLength(1);
    expect(wash(fills)).toHaveLength(0);
    expect(texts[0]).toMatchObject({ x: CENTRE.x, y: CENTRE.y });
  });

  it("HELD inside: no highlight, a 12% black wash, the caption 1 px down and right", () => {
    beginFloatingButtonPress({ controlId: ID, regionId: ID, run: () => {} });
    const { fills, texts } = paint();
    expect(BUTTON_PRESSED_SHADE).toBe(0.12);
    expect(highlight(fills), "a pressed button still shows its raised highlight").toHaveLength(0);
    expect(wash(fills), "a pressed button is not darker").toHaveLength(1);
    expect(texts[0]).toMatchObject({ x: CENTRE.x + 1, y: CENTRE.y + 1 });
  });

  it("held but SLID OFF: raised again; back in: pressed again", () => {
    beginFloatingButtonPress({ controlId: ID, regionId: ID, run: () => {} });
    h.inside = false;
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 900, clientY: 900, buttons: 1 }));
    expect(wash(paint().fills), "still pressed with the pointer off the button").toHaveLength(0);
    h.inside = true;
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 190, clientY: 105, buttons: 1 }));
    expect(wash(paint().fills)).toHaveLength(1);
  });

  it("the press ended: raised again", () => {
    beginFloatingButtonPress({ controlId: ID, regionId: ID, run: () => {} });
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 190, clientY: 105, button: 0 }));
    const { fills } = paint();
    expect(wash(fills)).toHaveLength(0);
    expect(highlight(fills)).toHaveLength(1);
  });
});

describe("a held press owns Escape through the object-selection provider", () => {
  it("owned only while the press lives", () => {
    const provider = createControlSelectionProvider();
    expect(provider.ownsKey?.("Escape")).toBe(false);
    beginFloatingButtonPress({ controlId: ID, regionId: ID, run: () => {} });
    expect(provider.ownsKey?.("Escape"), "a canvas would deselect the button under a held press").toBe(true);
    expect(provider.ownsKey?.("Tab")).toBe(false);
    cancelFloatingButtonPress();
    expect(provider.ownsKey?.("Escape")).toBe(false);
  });
});

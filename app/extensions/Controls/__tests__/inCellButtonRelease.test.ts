//! FILENAME: app/extensions/Controls/__tests__/inCellButtonRelease.test.ts
// PURPOSE: An IN-CELL (cell-anchored) button control runs on RELEASE on its
//          cell, and sliding off cancels -- the owner's answer for every button
//          (BUG-0258 design phase 4; the floating button has done this since
//          M7, lib/buttonPress.ts):
//            - in run mode the cell click interceptor CLAIMS the press for its
//              release (a release claim, @api/cellClickInterceptors) and asks
//              the door NOTHING at the press;
//            - the claim's target is that one cell;
//            - its release asks the door once, for that button;
//            - Design Mode and a cell that is not a button are not claimed
//              (Core selects the cell);
//            - while held over the cell it LOOKS pressed (Button/rendering.ts):
//              no raised highlight, the floating button's 12% black wash, the
//              caption 1 px down and right -- and raised again the moment the
//              look goes off; never in Design Mode.
// CONTEXT: The real interceptor and the real in-cell renderer, with the door,
//          the grid snapshot and the style store doubled. WHEN a claim runs is
//          Core's press session (src/core/lib/cellPressRelease.ts, its own
//          tests and the wiring test of Core's mouse-down door).

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: unknown }[],
  design: false,
  styleIndex: 1,
}));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    h.calls.push({ cmd, args });
    if (cmd === "run_control_action") return { kind: "nothing", message: null };
    return undefined;
  },
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/notifications")>()),
  showToast: () => {},
}));
vi.mock("../../../src/api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/api/grid")>()),
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 2 } }),
}));
vi.mock("../../../src/api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/api/lib")>()),
  getAllStyles: async () => [{}, { button: true }],
  getCell: async () => ({ styleIndex: h.styleIndex }),
}));
vi.mock("../lib/designMode", () => ({ getDesignMode: () => h.design }));

import { isCellPressed, isCellReleaseClaim, type CellReleaseClaim } from "@api/cellClickInterceptors";
import { buttonClickInterceptor, refreshStyleCache } from "../Button/interceptors";
import { drawButton } from "../Button/rendering";
import { BUTTON_PRESSED_SHADE } from "../Button/floatingRenderer";

const doorAsked = () => h.calls.filter((c) => c.cmd === "run_control_action");

async function pressOn(row: number, col: number) {
  return buttonClickInterceptor(row, col, { clientX: 0, clientY: 0 });
}

beforeEach(async () => {
  h.calls.length = 0;
  h.design = false;
  h.styleIndex = 1;
  await refreshStyleCache();
});

describe("an in-cell button control: the press is claimed, the release runs it", () => {
  it("run mode: the press is CLAIMED and the door is asked nothing at the press", async () => {
    const answer = await pressOn(4, 1);
    expect(isCellReleaseClaim(answer), "the in-cell button still acts on the press").toBe(true);
    expect(doorAsked(), "the button ran on the PRESS").toEqual([]);
  });

  it("its target is exactly its own cell, and it has a pressed look", async () => {
    const claim = (await pressOn(4, 1)) as CellReleaseClaim;
    expect(claim.targetAt({ clientX: 0, clientY: 0, row: 4, col: 1 })).toBe(claim.key);
    expect(claim.targetAt({ clientX: 0, clientY: 0, row: 4, col: 2 }), "a release on the next cell runs the button").toBeNull();
    expect(claim.targetAt({ clientX: 0, clientY: 0, row: 5, col: 1 })).toBeNull();
    expect(typeof claim.setPressed).toBe("function");
  });

  it("its release asks the door ONCE, for that button", async () => {
    const claim = (await pressOn(4, 1)) as CellReleaseClaim;
    await claim.runAtRelease({ clientX: 3, clientY: 4, row: 4, col: 1 });
    expect(doorAsked()).toHaveLength(1);
    const request = (doorAsked()[0].args as { request: Record<string, unknown> }).request;
    expect({ kind: request.kind, sheetIndex: request.sheetIndex, row: request.row, col: request.col }).toEqual({
      kind: "control",
      sheetIndex: 2,
      row: 4,
      col: 1,
    });
  });

  it("Design Mode: not claimed -- the press selects the cell, nothing runs", async () => {
    h.design = true;
    expect(await pressOn(4, 1)).toBe(false);
    expect(doorAsked()).toEqual([]);
  });

  it("a cell that is not a button: not claimed", async () => {
    h.styleIndex = 0;
    expect(await pressOn(4, 1)).toBe(false);
  });
});

// ============================================================================
// The pressed look (Button/rendering.ts)
// ============================================================================

interface Fill {
  style: unknown;
  alpha: number;
}

function recordingCtx(): { ctx: CanvasRenderingContext2D; fills: Fill[]; texts: Array<{ x: number; y: number }> } {
  const fills: Fill[] = [];
  const texts: Array<{ x: number; y: number }> = [];
  const target: Record<string, unknown> = {
    globalAlpha: 1,
    fillStyle: "#000",
    fill: () => fills.push({ style: target.fillStyle, alpha: target.globalAlpha as number }),
    fillText: (_t: string, x: number, y: number) => texts.push({ x, y }),
    measureText: () => ({ width: 10 }),
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

/** Paint the button cell (4, 1) at canvas [100..200] x [80..104]. */
function paint(row = 4, col = 1) {
  const rec = recordingCtx();
  drawButton({
    ctx: rec.ctx,
    row,
    col,
    cellLeft: 100,
    cellTop: 80,
    cellRight: 200,
    cellBottom: 104,
    display: "Run",
    styleIndex: 1,
    styleCache: new Map([[1, { button: true, fontSize: 11 }]]),
  } as never);
  return rec;
}

const CENTRE = { x: 150, y: 92 };
const highlight = (fills: Fill[]) => fills.filter((f) => f.style === "#f0f0f0");
const wash = (fills: Fill[]) => fills.filter((f) => f.style === "#000000" && f.alpha === BUTTON_PRESSED_SHADE);

describe("the in-cell button LOOKS pressed while held over its cell", () => {
  it("control: not held -- raised, no wash, the caption centred", () => {
    const { fills, texts } = paint();
    expect(highlight(fills)).toHaveLength(1);
    expect(wash(fills)).toHaveLength(0);
    expect(texts[0]).toEqual(CENTRE);
  });

  it("held over the cell: no highlight, the floating button's 12% wash, the caption 1 px down and right", async () => {
    const claim = (await pressOn(4, 1)) as CellReleaseClaim;
    claim.setPressed!(true);
    try {
      expect(isCellPressed(4, 1)).toBe(true);
      const { fills, texts } = paint();
      expect(highlight(fills), "a pressed button still shows its raised highlight").toHaveLength(0);
      expect(wash(fills), "a pressed button is not darker").toHaveLength(1);
      expect(texts[0]).toEqual({ x: CENTRE.x + 1, y: CENTRE.y + 1 });
      // Another button cell is not pressed.
      expect(wash(paint(4, 2).fills)).toHaveLength(0);
    } finally {
      claim.setPressed!(false);
    }
    expect(wash(paint().fills), "still pressed after the look went off").toHaveLength(0);
  });

  it("never in Design Mode (there the cell is selected and edited, never pressed)", async () => {
    const claim = (await pressOn(4, 1)) as CellReleaseClaim;
    claim.setPressed!(true);
    h.design = true;
    try {
      expect(wash(paint().fills)).toHaveLength(0);
    } finally {
      claim.setPressed!(false);
    }
  });
});

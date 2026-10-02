//! FILENAME: app/extensions/CellTypes/__tests__/buttonCellRelease.test.ts
// PURPOSE: A BUTTON CELL (Cell Type: Button) runs on RELEASE on its cell, and
//          sliding off cancels -- the owner's answer for every button (BUG-0258
//          design phase 4):
//            - in run mode its onClick CLAIMS the press for its release (a
//              release claim, @api/cellClickInterceptors): the door is asked
//              nothing at the press, the cell is selected at the press (the
//              keyboard follows the press, as a Windows button takes the focus);
//            - the claim's target is that one cell;
//            - its release asks the door once, naming the sheet read at the
//              PRESS;
//            - Design Mode is not claimed (the press selects and edits);
//            - while held over the cell it LOOKS pressed: a 12% black wash, no
//              raised bottom shading, the label 1 px down and right.
// CONTEXT: The real cell type with the door, the grid snapshot and the grid
//          dispatch doubled. WHEN a claim runs is Core's press session
//          (src/core/lib/cellPressRelease.ts); the registry passes the claim to
//          it unchanged (src/api/__tests__/cellTypes.test.ts).

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: unknown }[],
  design: false,
  sheet: 4,
  dispatched: [] as unknown[],
}));

vi.mock("../../../src/api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/api/backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    h.calls.push({ cmd, args });
    if (cmd === "run_control_action") return { kind: "nothing", message: null };
    return undefined;
  },
}));
vi.mock("../../../src/api/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/api/notifications")>()),
  showToast: () => {},
}));
vi.mock("../../../src/api/designMode", () => ({ getDesignMode: () => h.design }));
vi.mock("../../../src/api/gridDispatch", () => ({ dispatchGridAction: (a: unknown) => void h.dispatched.push(a) }));
vi.mock("../../../src/api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/api/grid")>()),
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: h.sheet } }),
}));

import { isCellPressed, isCellReleaseClaim, type CellReleaseClaim } from "@api/cellClickInterceptors";
import { buttonCellType, BUTTON_CELL_PRESSED_SHADE } from "../types/button";

const doorAsked = () => h.calls.filter((c) => c.cmd === "run_control_action");

async function pressOn(row: number, col: number) {
  return buttonCellType.onClick!({
    row,
    col,
    typeId: "calcula.button",
    params: {},
    event: { clientX: 0, clientY: 0 },
  } as never);
}

beforeEach(() => {
  h.calls.length = 0;
  h.dispatched.length = 0;
  h.design = false;
  h.sheet = 4;
});

describe("a button cell: the press is claimed, the release runs it", () => {
  it("run mode: the press is CLAIMED, the door is asked nothing, and the cell is selected at the press", async () => {
    const answer = await pressOn(6, 2);
    expect(isCellReleaseClaim(answer), "the button cell still acts on the press").toBe(true);
    expect(doorAsked(), "the button cell ran on the PRESS").toEqual([]);
    expect(h.dispatched).toHaveLength(1);
    expect(JSON.stringify(h.dispatched[0])).toContain('"startRow":6');
  });

  it("its target is exactly its own cell, and it has a pressed look", async () => {
    const claim = (await pressOn(6, 2)) as CellReleaseClaim;
    expect(claim.targetAt({ clientX: 0, clientY: 0, row: 6, col: 2 })).toBe(claim.key);
    expect(claim.targetAt({ clientX: 0, clientY: 0, row: 6, col: 3 })).toBeNull();
    expect(claim.targetAt({ clientX: 0, clientY: 0, row: 7, col: 2 })).toBeNull();
    expect(typeof claim.setPressed).toBe("function");
  });

  it("its release asks the door ONCE, naming the sheet read at the PRESS", async () => {
    const claim = (await pressOn(6, 2)) as CellReleaseClaim;
    h.sheet = 9;
    await claim.runAtRelease({ clientX: 0, clientY: 0, row: 6, col: 2 });
    expect(doorAsked()).toHaveLength(1);
    const request = (doorAsked()[0].args as { request: Record<string, unknown> }).request;
    expect({ kind: request.kind, sheetIndex: request.sheetIndex, row: request.row, col: request.col }).toEqual({
      kind: "cell",
      sheetIndex: 4,
      row: 6,
      col: 2,
    });
  });

  it("Design Mode: not claimed -- the press selects and edits, nothing runs", async () => {
    h.design = true;
    expect(await pressOn(6, 2)).toBe(false);
    expect(doorAsked()).toEqual([]);
  });
});

// ============================================================================
// The pressed look
// ============================================================================

interface Fill {
  style: unknown;
  alpha: number;
}

function recordingCtx() {
  const fills: Fill[] = [];
  const strokes: unknown[] = [];
  const texts: Array<{ x: number; y: number }> = [];
  const target: Record<string, unknown> = {
    globalAlpha: 1,
    fillStyle: "#000",
    strokeStyle: "#000",
    fill: () => fills.push({ style: target.fillStyle, alpha: target.globalAlpha as number }),
    stroke: () => strokes.push(target.strokeStyle),
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
  return { ctx, fills, strokes, texts };
}

/** Paint the button cell (6, 2) at canvas [100..200] x [80..104]. */
function paint(row = 6, col = 2) {
  const rec = recordingCtx();
  buttonCellType.render({
    ctx: rec.ctx,
    row,
    col,
    cellLeft: 100,
    cellTop: 80,
    cellRight: 200,
    cellBottom: 104,
    value: "Go",
    params: {},
    typeId: "calcula.button",
    hasFormula: false,
    display: "Go",
    styleIndex: 0,
    styleCache: new Map(),
  } as never);
  return rec;
}

const wash = (fills: Fill[]) => fills.filter((f) => f.style === "#000000" && f.alpha === BUTTON_CELL_PRESSED_SHADE);
const raisedShading = (strokes: unknown[]) => strokes.filter((s) => s === "rgba(0, 0, 0, 0.12)");

describe("the button cell LOOKS pressed while held over it", () => {
  it("control: not held -- no wash, the raised shading, the label centred", () => {
    const { fills, strokes, texts } = paint();
    expect(wash(fills)).toHaveLength(0);
    expect(raisedShading(strokes)).toHaveLength(1);
    expect(texts[0]).toEqual({ x: 150, y: 92.5 });
  });

  it("held over the cell: the 12% wash, no raised shading, the label 1 px down and right; another cell is raised", async () => {
    const claim = (await pressOn(6, 2)) as CellReleaseClaim;
    claim.setPressed!(true);
    try {
      expect(isCellPressed(6, 2)).toBe(true);
      expect(BUTTON_CELL_PRESSED_SHADE).toBe(0.12);
      const { fills, strokes, texts } = paint();
      expect(wash(fills), "a pressed button cell is not darker").toHaveLength(1);
      expect(raisedShading(strokes), "a pressed button cell still looks raised").toHaveLength(0);
      expect(texts[0]).toEqual({ x: 151, y: 93.5 });
      expect(wash(paint(6, 3).fills)).toHaveLength(0);
    } finally {
      claim.setPressed!(false);
    }
    expect(wash(paint().fills), "still pressed after the look went off").toHaveLength(0);
  });
});

//! FILENAME: app/extensions/FloatingRange/rendering/__tests__/frContainerPaint.test.ts
// PURPOSE: The floating grid paints INSIDE its visual container (WP-C S12):
//          with padding, its own white frame, title bar, strips and cells all
//          land inside the content rect and under its clip -- nothing of the
//          grid in the padding band, where Core paints the container -- and the
//          title bar paints from the RESOLVED title style (fill, ink, font,
//          alignment, underline), so a formatted or bound colour shows.
// CONTEXT: The recording context double (_shared/lib/__tests__/recordingCtx)
//          tracks the clip like a real context; the title bar's style is read
//          off a small spy context at the moment of each draw.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FloatingRangeInfo } from "@api/floatingRanges";

vi.mock("@api/floatingRanges", () => ({
  FLOATING_RANGE_MAX_ROWS: 1000,
  FLOATING_RANGE_MAX_COLS: 256,
  listFloatingRanges: vi.fn(async () => []),
  updateFloatingRange: vi.fn(async () => ({})),
  getFloatingRangeCells: vi.fn(async () => [{ row: 0, col: 0, type: "text", value: "v", display: "v" }]),
}));

vi.mock("@api/lib", () => ({
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true })),
}));

vi.mock("../../editor/frEditor", () => ({
  layoutFrEditorForFrame: vi.fn(),
}));

import type { OverlayRenderContext } from "@api/gridOverlays";
import type { ResolvedVisualText } from "@api/visualContainer";
import { renderFloatingRange, resetFrRenderCaches, paintFrTitleBar, frTitleFont } from "../frRenderer";
import {
  upsertFromInfo,
  resetFloatingRangeStore,
  getFloatingRangeById,
  FLOATING_RANGE_REGION_TYPE,
} from "../../lib/floatingRangeStore";
import { frContainerOf, frContainerDefaults } from "../../lib/frObjectFormat";
import { frameWidth, frameHeight, frInnerBox, FR_TITLE_H } from "../../lib/frDimensions";
import { createRecordingCtx, rectInside } from "../../../_shared/lib/__tests__/recordingCtx";

const FR_ID = "fr-container";
const FRAME_X = 100;
const FRAME_Y = 60;
const PAD = 12;

function info(overrides: Partial<FloatingRangeInfo> = {}): FloatingRangeInfo {
  return {
    id: FR_ID,
    backingSheetId: "backing",
    hostSheetId: "host",
    x: FRAME_X,
    y: FRAME_Y,
    rotation: 0,
    pinToGrid: false,
    rowCount: 3,
    colCount: 2,
    colWidths: {},
    rowHeights: {},
    showTitle: true,
    showColumnHeaders: true,
    showRowHeaders: true,
    name: "Float9",
    backingSheetIndex: 2,
    hostSheetIndex: 0,
    ...overrides,
  };
}

function overlayCtx(ctx: CanvasRenderingContext2D): OverlayRenderContext {
  const entry = getFloatingRangeById(FR_ID)!;
  return {
    ctx,
    region: {
      id: `fr-${FR_ID}`,
      type: FLOATING_RANGE_REGION_TYPE,
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
      floating: { x: FRAME_X, y: FRAME_Y, width: frameWidth(entry), height: frameHeight(entry) },
      container: frContainerOf(entry),
      data: { frId: FR_ID },
    },
    config: { rowHeaderWidth: 0, colHeaderHeight: 0 },
    viewport: { scrollX: 0, scrollY: 0 },
    dimensions: {},
    canvasWidth: 2000,
    canvasHeight: 2000,
  } as unknown as OverlayRenderContext;
}

beforeEach(() => {
  resetFloatingRangeStore();
  resetFrRenderCaches();
});

afterEach(() => {
  resetFloatingRangeStore();
  resetFrRenderCaches();
});

describe("the grid paints inside the container's content rect", () => {
  it("with padding, every draw of the grid lands inside the content rect and under its clip", () => {
    upsertFromInfo(info({ container: { padding: { top: PAD, right: PAD, bottom: PAD, left: PAD } } }));
    const entry = getFloatingRangeById(FR_ID)!;
    const inner = frInnerBox(entry);
    const content = { x: FRAME_X + inner.x, y: FRAME_Y + inner.y, width: inner.width, height: inner.height };
    expect(content.x).toBe(FRAME_X + PAD);

    const rec = createRecordingCtx();
    renderFloatingRange(overlayCtx(rec.ctx));
    expect(rec.ops.length).toBeGreaterThan(3);
    // The grid's white frame starts at the content origin, not at the outer one.
    const firstFill = rec.ops.find((o) => o.op === "fillRect")!;
    expect(firstFill.rect).toEqual(content);
    for (const op of rec.ops) {
      expect(op.clip, `${op.op} has a clip`).not.toBeNull();
      expect(rectInside(op.clip!, content), `${op.op} clipped inside the content rect`).toBe(true);
    }
  });

  it("control: without a container the grid fills its whole frame, exactly as before", () => {
    upsertFromInfo(info());
    const entry = getFloatingRangeById(FR_ID)!;
    const rec = createRecordingCtx();
    renderFloatingRange(overlayCtx(rec.ctx));
    const firstFill = rec.ops.find((o) => o.op === "fillRect")!;
    expect(firstFill.rect).toEqual({ x: FRAME_X, y: FRAME_Y, width: frameWidth(entry), height: frameHeight(entry) });
  });
});

/** A context that records the style in force at every draw. */
function spyCtx() {
  const draws: Array<{ op: string; fillStyle: unknown; strokeStyle: unknown; font: string; textAlign: string; args: number[]; text?: string }> = [];
  const state = { fillStyle: "" as unknown, strokeStyle: "" as unknown, font: "", textAlign: "start", textBaseline: "alphabetic", lineWidth: 1 };
  const record = (op: string, args: unknown[], text?: string) =>
    draws.push({
      op,
      fillStyle: state.fillStyle,
      strokeStyle: state.strokeStyle,
      font: state.font,
      textAlign: state.textAlign,
      args: args.filter((a): a is number => typeof a === "number"),
      text,
    });
  const ctx = {
    get fillStyle() { return state.fillStyle; },
    set fillStyle(v: unknown) { state.fillStyle = v; },
    get strokeStyle() { return state.strokeStyle; },
    set strokeStyle(v: unknown) { state.strokeStyle = v; },
    get font() { return state.font; },
    set font(v: string) { state.font = v; },
    get textAlign() { return state.textAlign; },
    set textAlign(v: string) { state.textAlign = v; },
    get textBaseline() { return state.textBaseline; },
    set textBaseline(v: string) { state.textBaseline = v; },
    get lineWidth() { return state.lineWidth; },
    set lineWidth(v: number) { state.lineWidth = v; },
    fillRect: (...a: number[]) => record("fillRect", a),
    fillText: (t: string, ...a: number[]) => record("fillText", a, t),
    measureText: (t: string) => ({ width: t.length * 6 }),
    beginPath: () => {},
    moveTo: (...a: number[]) => record("moveTo", a),
    lineTo: (...a: number[]) => record("lineTo", a),
    stroke: () => record("stroke", []),
    rect: () => {},
    clip: () => {},
    save: () => {},
    restore: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, draws };
}

describe("the title bar paints from the RESOLVED title", () => {
  const base = (): ResolvedVisualText => ({ ...frContainerDefaults("Float9").title });

  it("today's look by default: #f0f0f0 bar, #333333 semibold 11px name at the left", () => {
    const { ctx, draws } = spyCtx();
    paintFrTitleBar(ctx, base(), "Float9", 10, 20, 200, FR_TITLE_H);
    expect(draws[0]).toMatchObject({ op: "fillRect", fillStyle: "#f0f0f0", args: [10, 20, 200, FR_TITLE_H] });
    const text = draws.find((d) => d.op === "fillText")!;
    expect(text).toMatchObject({ text: "Float9", fillStyle: "#333333", textAlign: "left" });
    expect(text.font).toBe("600 11px 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif");
    expect(text.args[0]).toBe(16);
  });

  it("a formatted title: its fill, ink, font, alignment and underline", () => {
    const { ctx, draws } = spyCtx();
    const t: ResolvedVisualText = {
      ...base(),
      background: "#102030",
      color: "#00ff00",
      fontSize: 16,
      bold: false,
      italic: true,
      underline: true,
      align: "right",
      fontFamily: "Georgia",
    };
    paintFrTitleBar(ctx, t, "Float9", 0, 0, 200, 26);
    expect(draws[0]).toMatchObject({ op: "fillRect", fillStyle: "#102030" });
    const text = draws.find((d) => d.op === "fillText")!;
    expect(text).toMatchObject({ fillStyle: "#00ff00", textAlign: "right", font: "italic 400 16px Georgia" });
    expect(text.args[0]).toBe(194);
    // The underline is stroked in the text's ink, under the measured text.
    const lastStroke = draws.filter((d) => d.op === "stroke").pop()!;
    expect(lastStroke.strokeStyle).toBe("#00ff00");
    expect(frTitleFont({ italic: false, bold: true, fontSize: 12, fontFamily: "Arial" })).toBe("600 12px Arial");
  });
});

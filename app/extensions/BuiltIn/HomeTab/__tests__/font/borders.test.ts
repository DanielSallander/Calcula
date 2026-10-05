//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/font/borders.test.ts
// PURPOSE: What Excel's Borders presets WRITE (CONTRACT 3.4), as the pure plan
//          and as the runner that executes it: the calls per preset, the line
//          the current Line Color / Line Style give them, the "thick" and
//          "double" presets that ignore the line style, the shared edge a
//          neighbour outside the selection owns, ONE undo step, the refresh
//          the ribbon's formatting door does, and every refusal reaching the
//          user.
// CONTEXT: Every expectation below was MEASURED in live Excel 365 through COM
//          on 2026-10-04 (home-font lane report, "Excel probe"): a fresh,
//          never-saved, off-screen instance; presets run with
//          CommandBars.ExecuteMso("BorderBottomNoToggle" ...), the menu's own
//          rows; borders read back with Range.Borders(edge).
//          - Bottom/Top/Left/Right on a multi-row/column range write ONLY the
//            outer edge, and are not toggles (twice = still there).
//          - "Thick" means Excel's MEDIUM weight (xlMedium), solid; "Double"
//            is the double line; both keep the Line Color and ignore the Line
//            Style. Every other preset draws in the Line Style (dashed after
//            Line Style > Dashed) and the Line Color (red after Line Color >
//            Red).
//          - An edge is ONE line in Excel: B1's bottom reads as B2's top, No
//            Border on B2:C3 removes lines B1/A2/D3/B4 drew on the shared
//            edges, and Top Border on A2 replaces A1's double bottom.
//          Calcula stores each cell's four sides separately and the renderer
//          paints the heavier of two coincident sides, so matching Excel means
//          clearing the NEIGHBOUR's coincident side whenever a preset writes or
//          clears an outer edge.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

const lib = vi.hoisted(() => ({
  applyBorderPreset: vi.fn(),
  applyFormatting: vi.fn(),
  getViewportCells: vi.fn(),
  getStyle: vi.fn(),
  beginUndoTransaction: vi.fn(),
  commitUndoTransaction: vi.fn(),
  cancelUndoTransaction: vi.fn(),
}));
vi.mock("@api/lib", () => lib);

const grid = vi.hoisted(() => ({
  snapshot: null as Record<string, unknown> | null,
}));
vi.mock("@api/grid", () => ({ getGridStateSnapshot: () => grid.snapshot }));

const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock("@api/dialogs", () => dialogs);

import { CommandRegistry, CoreCommands } from "@api/commands";
import { cellEvents } from "@api/cellEvents";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";
import {
  AUTOMATIC_LINE_COLOR,
  BORDER_PRESETS,
  DEFAULT_BORDER_PEN,
  DEFAULT_BORDER_PRESET,
  LINE_STYLES,
  NEIGHBOUR_READ_LIMIT,
  applyBorderChoice,
  borderPen,
  chooseBorder,
  lastBorderPreset,
  openMoreBorders,
  planBorderPreset,
  sharedEdgeStrip,
  type BorderPen,
  type CellRect,
} from "../../components/font/borders";

// ============================================================================
// Harness
// ============================================================================

const BOUNDS = { rows: 1048576, cols: 16384 };
const B2C3: CellRect = { startRow: 1, startCol: 1, endRow: 2, endCol: 2 };
const THIN: BorderPen = { color: null, style: "thin" };

/** What reached the backend, in order. */
const log: string[] = [];
let toasts: ToastPayload[] = [];
let releaseOwner: (() => void) | null = null;
const events: string[] = [];
const onEvent = (e: Event): void => {
  events.push(e.type);
};

/** Styles by index for the neighbour reads; index 0 is the default (no borders). */
const NO_SIDE = { style: "none", color: "#000000", width: 0 };
const THIN_SIDE = { style: "thin", color: "#000000", width: 1 };
let styles = new Map<number, Record<string, unknown>>();
/** Cells getViewportCells answers: [row, col, styleIndex]. */
let stored: Array<[number, number, number]> = [];

function styleWith(sides: Partial<Record<"borderTop" | "borderBottom" | "borderLeft" | "borderRight", typeof THIN_SIDE>>) {
  return { borderTop: NO_SIDE, borderBottom: NO_SIDE, borderLeft: NO_SIDE, borderRight: NO_SIDE, ...sides };
}

function selectBlock(rect: CellRect, extra: CellRect[] = []): void {
  grid.snapshot = {
    selection: { ...rect, type: "cells", additionalRanges: extra.map((r) => ({ ...r })) },
    config: { totalRows: BOUNDS.rows, totalCols: BOUNDS.cols },
  };
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

beforeEach(() => {
  log.length = 0;
  events.length = 0;
  toasts = [];
  styles = new Map([[0, styleWith({})]]);
  stored = [];
  registerToastSink((t) => toasts.push(t));
  dialogs.alertAsync.mockClear();
  lastBorderPreset.reset();
  borderPen.reset();
  selectBlock(B2C3);
  lib.applyBorderPreset.mockReset().mockImplementation(async (...args: unknown[]) => {
    log.push(`preset:${JSON.stringify(args)}`);
    return { cells: [{ row: 1, col: 1, display: "", formula: null, styleIndex: 3 }], styles: [] };
  });
  lib.applyFormatting.mockReset().mockImplementation(async (rows: number[], cols: number[], f: unknown) => {
    log.push(`format:${JSON.stringify([rows, cols, f])}`);
    return { cells: [], styles: [] };
  });
  lib.getViewportCells.mockReset().mockImplementation(async (r0: number, c0: number, r1: number, c1: number) => {
    log.push(`read:${r0},${c0},${r1},${c1}`);
    const out: Array<{ row: number; col: number; styleIndex: number; display: string }> = [];
    for (const [row, col, styleIndex] of stored) {
      if (row >= r0 && row <= r1 && col >= c0 && col <= c1) out.push({ row, col, styleIndex, display: "" });
    }
    return out;
  });
  lib.getStyle.mockReset().mockImplementation(async (i: number) => styles.get(i));
  lib.beginUndoTransaction.mockReset().mockImplementation(async (label: string) => {
    log.push(`begin:${label}`);
    return 7;
  });
  lib.commitUndoTransaction.mockReset().mockImplementation(async (t?: number) => {
    log.push(`commit:${t}`);
  });
  lib.cancelUndoTransaction.mockReset().mockImplementation(async (t?: number) => {
    log.push(`cancel:${t}`);
  });
  for (const name of ["grid:refresh", "styles:refresh"]) window.addEventListener(name, onEvent);
});

afterEach(() => {
  releaseOwner?.();
  releaseOwner = null;
  for (const name of ["grid:refresh", "styles:refresh"]) window.removeEventListener(name, onEvent);
  vi.restoreAllMocks();
});

/** Only the backend writes, without the reads and the transaction. */
function writes(): string[] {
  return log.filter((l) => l.startsWith("preset:") || l.startsWith("format:"));
}

// ============================================================================
// The menu's data
// ============================================================================

describe("the presets", () => {
  it("are Excel's thirteen, in Excel's order, with its words and the CONTRACT's pictures", () => {
    expect(BORDER_PRESETS.map((p) => [p.label, p.icon])).toEqual([
      ["Bottom Border", "BorderBottom"],
      ["Top Border", "BorderTop"],
      ["Left Border", "BorderLeft"],
      ["Right Border", "BorderRight"],
      ["No Border", "BorderNone"],
      ["All Borders", "BorderAll"],
      ["Outside Borders", "BorderOutside"],
      ["Thick Outside Borders", "BorderThickOutside"],
      ["Bottom Double Border", "BorderDoubleBottom"],
      ["Thick Bottom Border", "BorderThickBottom"],
      ["Top and Bottom Border", "BorderTopBottom"],
      ["Top and Thick Bottom Border", "BorderTopThickBottom"],
      ["Top and Double Bottom Border", "BorderTopDoubleBottom"],
    ]);
    // Three runs between Excel's separators: 4 edges, 4 range presets, 5 combinations.
    expect(BORDER_PRESETS.map((p) => p.section)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
  });

  it("the face's default is Bottom Border, the pen's is Automatic thin", () => {
    expect(DEFAULT_BORDER_PRESET).toBe("bottom");
    expect(lastBorderPreset.get()).toBe("bottom");
    expect(DEFAULT_BORDER_PEN).toEqual({ color: null, style: "thin" });
    expect(AUTOMATIC_LINE_COLOR).toBe("#000000");
  });

  it("Line Style offers the six Calcula can store, in Excel's list order", () => {
    // Excel: None, Thin, Hair, Dotted, Dashed, DashDot, DashDotDot, Double,
    // Medium, MediumDashed, MediumDashDot, MediumDashDotDot, SlantDashDot,
    // Thick (UIA names, measured). Calcula stores thin/medium/thick solid,
    // dashed, dotted and double.
    expect(LINE_STYLES.map((s) => s.label)).toEqual(["Thin", "Dotted", "Dashed", "Double", "Medium", "Thick"]);
  });
});

// ============================================================================
// The plan (pure)
// ============================================================================

describe("planBorderPreset", () => {
  const side = (style: string, color = "#000000") => ({ style, color });

  it("edge presets write ONLY the outer row or column (Excel, measured)", () => {
    expect(planBorderPreset("bottom", B2C3, THIN).writes).toEqual([
      { kind: "sides", rows: [2], cols: [1, 2], formatting: { borderBottom: side("thin") } },
    ]);
    expect(planBorderPreset("top", B2C3, THIN).writes).toEqual([
      { kind: "sides", rows: [1], cols: [1, 2], formatting: { borderTop: side("thin") } },
    ]);
    expect(planBorderPreset("left", B2C3, THIN).writes).toEqual([
      { kind: "sides", rows: [1, 2], cols: [1], formatting: { borderLeft: side("thin") } },
    ]);
    expect(planBorderPreset("right", B2C3, THIN).writes).toEqual([
      { kind: "sides", rows: [1, 2], cols: [2], formatting: { borderRight: side("thin") } },
    ]);
  });

  it("range presets go through the tier-aware preset command", () => {
    expect(planBorderPreset("none", B2C3, THIN).writes).toEqual([
      { kind: "preset", rect: B2C3, preset: "none", style: "solid", color: "#000000", width: 0 },
    ]);
    expect(planBorderPreset("all", B2C3, THIN).writes).toEqual([
      { kind: "preset", rect: B2C3, preset: "allBorders", style: "solid", color: "#000000", width: 1 },
    ]);
    expect(planBorderPreset("outside", B2C3, THIN).writes).toEqual([
      { kind: "preset", rect: B2C3, preset: "outside", style: "solid", color: "#000000", width: 1 },
    ]);
  });

  it("'Thick' is Excel's MEDIUM weight, solid, whatever the line style (measured xlMedium)", () => {
    const dashedRed: BorderPen = { color: "#ff0000", style: "dashed" };
    expect(planBorderPreset("thickOutside", B2C3, dashedRed).writes).toEqual([
      { kind: "preset", rect: B2C3, preset: "outside", style: "solid", color: "#ff0000", width: 2 },
    ]);
    expect(planBorderPreset("thickBottom", B2C3, dashedRed).writes).toEqual([
      { kind: "sides", rows: [2], cols: [1, 2], formatting: { borderBottom: side("medium", "#ff0000") } },
    ]);
  });

  it("'Double' presets draw the double line in the line colour, whatever the line style", () => {
    const dotted: BorderPen = { color: "#00b050", style: "dotted" };
    expect(planBorderPreset("doubleBottom", B2C3, dotted).writes).toEqual([
      { kind: "sides", rows: [2], cols: [1, 2], formatting: { borderBottom: side("double", "#00b050") } },
    ]);
  });

  it("every other preset draws in the Line Style and Line Color (measured: dashed, red)", () => {
    const pen: BorderPen = { color: "#ff0000", style: "dashed" };
    expect(planBorderPreset("bottom", B2C3, pen).writes[0]).toEqual({
      kind: "sides",
      rows: [2],
      cols: [1, 2],
      formatting: { borderBottom: side("dashed", "#ff0000") },
    });
    expect(planBorderPreset("all", B2C3, pen).writes[0]).toMatchObject({ style: "dashed", width: 1, color: "#ff0000" });
  });

  it("each line style maps to the preset command's (style, width) and the side word", () => {
    const expected: Record<string, [string, number]> = {
      thin: ["solid", 1],
      medium: ["solid", 2],
      thick: ["solid", 3],
      dashed: ["dashed", 1],
      dotted: ["dotted", 1],
      double: ["double", 1],
    };
    for (const s of LINE_STYLES) {
      const pen: BorderPen = { color: null, style: s.id };
      expect(planBorderPreset("outside", B2C3, pen).writes[0]).toMatchObject({
        style: expected[s.id][0],
        width: expected[s.id][1],
      });
      expect(planBorderPreset("top", B2C3, pen).writes[0]).toMatchObject({
        formatting: { borderTop: { style: s.id } },
      });
    }
  });

  it("the two-edge presets are ONE call on a one-row selection, two otherwise", () => {
    const row: CellRect = { startRow: 4, startCol: 0, endRow: 4, endCol: 1 };
    expect(planBorderPreset("topThickBottom", row, THIN).writes).toEqual([
      { kind: "sides", rows: [4], cols: [0, 1], formatting: { borderTop: side("thin"), borderBottom: side("medium") } },
    ]);
    expect(planBorderPreset("topDoubleBottom", B2C3, THIN).writes).toEqual([
      { kind: "sides", rows: [1], cols: [1, 2], formatting: { borderTop: side("thin") } },
      { kind: "sides", rows: [2], cols: [1, 2], formatting: { borderBottom: side("double") } },
    ]);
    expect(planBorderPreset("topBottom", B2C3, THIN).writes).toEqual([
      { kind: "sides", rows: [1], cols: [1, 2], formatting: { borderTop: side("thin") } },
      { kind: "sides", rows: [2], cols: [1, 2], formatting: { borderBottom: side("thin") } },
    ]);
  });

  it("names the outer edges whose shared line it owns", () => {
    expect(planBorderPreset("bottom", B2C3, THIN).sharedEdges).toEqual(["bottom"]);
    expect(planBorderPreset("left", B2C3, THIN).sharedEdges).toEqual(["left"]);
    expect(planBorderPreset("topDoubleBottom", B2C3, THIN).sharedEdges).toEqual(["top", "bottom"]);
    for (const p of ["none", "all", "outside", "thickOutside"] as const) {
      expect(planBorderPreset(p, B2C3, THIN).sharedEdges).toEqual(["top", "bottom", "left", "right"]);
    }
  });
});

describe("sharedEdgeStrip", () => {
  it("is the row or column just outside the edge, with the side that coincides with it", () => {
    expect(sharedEdgeStrip(B2C3, "top", BOUNDS)).toEqual({ startRow: 0, startCol: 1, endRow: 0, endCol: 2, side: "borderBottom" });
    expect(sharedEdgeStrip(B2C3, "bottom", BOUNDS)).toEqual({ startRow: 3, startCol: 1, endRow: 3, endCol: 2, side: "borderTop" });
    expect(sharedEdgeStrip(B2C3, "left", BOUNDS)).toEqual({ startRow: 1, startCol: 0, endRow: 2, endCol: 0, side: "borderRight" });
    expect(sharedEdgeStrip(B2C3, "right", BOUNDS)).toEqual({ startRow: 1, startCol: 3, endRow: 2, endCol: 3, side: "borderLeft" });
  });

  it("there is none at the sheet's edge", () => {
    const corner: CellRect = { startRow: 0, startCol: 0, endRow: 1048575, endCol: 16383 };
    for (const edge of ["top", "bottom", "left", "right"] as const) {
      expect(sharedEdgeStrip(corner, edge, BOUNDS)).toBeNull();
    }
  });
});

// ============================================================================
// The runner
// ============================================================================

describe("applyBorderChoice", () => {
  it("runs the plan inside ONE undo step named after the preset, then refreshes like the formatting door", async () => {
    const emitted: number[] = [];
    const off = cellEvents.subscribe((e) => emitted.push(e.row));
    await applyBorderChoice("outside");
    off();
    expect(log[0]).toBe("begin:Outside Borders");
    expect(log[log.length - 1]).toBe("commit:7");
    expect(writes()).toEqual([`preset:${JSON.stringify([1, 1, 2, 2, "outside", "solid", "#000000", 1])}`]);
    // The four neighbour strips were read, nothing there to clear.
    expect(log.filter((l) => l.startsWith("read:"))).toEqual(["read:0,1,0,2", "read:3,1,3,2", "read:1,0,2,0", "read:1,3,2,3"]);
    expect(events).toEqual(["styles:refresh", "grid:refresh"]);
    expect(emitted).toEqual([1]);
  });

  it("uses the remembered pen: Line Color and Line Style", async () => {
    borderPen.set({ color: "#ff0000", style: "dashed" });
    await applyBorderChoice("bottom");
    expect(writes()[0]).toBe(
      `format:${JSON.stringify([[2], [1, 2], { borderBottom: { style: "dashed", color: "#ff0000" } }])}`,
    );
  });

  it("No Border also clears the lines neighbours OUTSIDE the range draw on its edges (Excel's one-line edge)", async () => {
    styles.set(5, styleWith({ borderBottom: THIN_SIDE })); // B1 / C1 own the top edge
    styles.set(6, styleWith({ borderRight: THIN_SIDE })); // A3 owns part of the left edge
    styles.set(8, styleWith({ borderTop: THIN_SIDE, borderBottom: THIN_SIDE })); // C4 owns part of the bottom edge
    stored = [[0, 1, 5], [0, 2, 5], [2, 0, 6], [1, 0, 0], [3, 2, 8], [3, 1, 0]];
    await applyBorderChoice("none");
    expect(writes()).toEqual([
      `preset:${JSON.stringify([1, 1, 2, 2, "none", "solid", "#000000", 0])}`,
      `format:${JSON.stringify([[0], [1, 2], { borderBottom: { style: "none", color: "#000000" } }])}`,
      `format:${JSON.stringify([[3], [2], { borderTop: { style: "none", color: "#000000" } }])}`,
      `format:${JSON.stringify([[2], [0], { borderRight: { style: "none", color: "#000000" } }])}`,
    ]);
    // Only the coincident side is cleared (C4's own bottom is not this edge,
    // so the write above names borderTop alone), only where a line exists
    // (B4, A2 hold none: nothing written there), and one call per strip.
  });

  it("an edge preset replaces the neighbour's line on that edge (Top Border under a double bottom)", async () => {
    selectBlock({ startRow: 1, startCol: 0, endRow: 1, endCol: 0 });
    styles.set(4, styleWith({ borderBottom: { style: "double", color: "#000000", width: 1 } }));
    stored = [[0, 0, 4]];
    await applyBorderChoice("top");
    expect(writes()).toEqual([
      `format:${JSON.stringify([[1], [0], { borderTop: { style: "thin", color: "#000000" } }])}`,
      `format:${JSON.stringify([[0], [0], { borderBottom: { style: "none", color: "#000000" } }])}`,
    ]);
  });

  it("a neighbour strip longer than the read limit is left alone (a whole column's neighbour)", async () => {
    selectBlock({ startRow: 0, startCol: 1, endRow: BOUNDS.rows - 1, endCol: 1 });
    expect(BOUNDS.rows).toBeGreaterThan(NEIGHBOUR_READ_LIMIT);
    await applyBorderChoice("left");
    expect(log.filter((l) => l.startsWith("read:"))).toEqual([]);
  });

  it("each block of a multi-area selection gets its own preset", async () => {
    const d5: CellRect = { startRow: 4, startCol: 3, endRow: 4, endCol: 3 };
    selectBlock(B2C3, [d5]);
    await applyBorderChoice("all");
    expect(writes()).toEqual([
      `preset:${JSON.stringify([1, 1, 2, 2, "allBorders", "solid", "#000000", 1])}`,
      `preset:${JSON.stringify([4, 3, 4, 3, "allBorders", "solid", "#000000", 1])}`,
    ]);
  });

  it("a backwards-dragged selection is normalised", async () => {
    selectBlock({ startRow: 2, startCol: 2, endRow: 1, endCol: 1 });
    await applyBorderChoice("bottom");
    expect(writes()[0]).toBe(`format:${JSON.stringify([[2], [1, 2], { borderBottom: { style: "thin", color: "#000000" } }])}`);
  });

  it("chooseBorder remembers the preset for the face, then applies it", async () => {
    await chooseBorder("thickBottom");
    expect(lastBorderPreset.get()).toBe("thickBottom");
    expect(writes()[0]).toContain("medium");
  });
});

describe("refusals", () => {
  it("while something else owns the selection: one toast naming the preset, nothing written, no step", async () => {
    releaseOwner = registerSelectionOwner({ id: "t", label: "the test object's cells", ownsSelection: () => true });
    const ok = await applyBorderChoice("all");
    expect(ok).toBe(false);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain("All Borders");
    expect(lib.applyBorderPreset).not.toHaveBeenCalled();
    expect(lib.beginUndoTransaction).not.toHaveBeenCalled();
  });

  it("a backend refusal reaches the user, and the step is still COMMITTED (what landed stays undoable)", async () => {
    lib.applyBorderPreset.mockRejectedValueOnce(new Error("Cell B2 is locked on a protected sheet."));
    const ok = await applyBorderChoice("outside");
    expect(ok).toBe(false);
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Cell B2 is locked on a protected sheet.");
    expect(log[log.length - 1]).toBe("commit:7");
    expect(log).not.toContain("cancel:7");
  });

  it("a begin that fails still applies (as separate steps), and closes nothing", async () => {
    lib.beginUndoTransaction.mockRejectedValueOnce(new Error("no slot"));
    const ok = await applyBorderChoice("bottom");
    expect(ok).toBe(true);
    expect(writes()).toHaveLength(1);
    expect(lib.commitUndoTransaction).not.toHaveBeenCalled();
  });

  it("with no selection nothing happens", async () => {
    grid.snapshot = null;
    expect(await applyBorderChoice("all")).toBe(false);
    expect(log).toEqual([]);
  });
});

describe("More Borders...", () => {
  it("opens Format Cells on its Border tab through the ONE door, and a refusal reaches the user", async () => {
    const execute = vi.spyOn(CommandRegistry, "execute").mockResolvedValue(undefined as never);
    await openMoreBorders();
    expect(execute).toHaveBeenCalledWith(CoreCommands.FORMAT_CELLS, { tab: "border" });
    execute.mockRejectedValueOnce(new Error("nope"));
    await openMoreBorders();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("nope");
  });
});

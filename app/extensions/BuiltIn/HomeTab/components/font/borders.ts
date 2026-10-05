//! FILENAME: app/extensions/BuiltIn/HomeTab/components/font/borders.ts
// PURPOSE: What Excel's Borders split button (CONTRACT 3.4) holds and does:
//          the thirteen presets and their words and pictures, the pen (Line
//          Color, Line Style) they draw with, the face's remembered preset, the
//          PURE plan of backend calls a preset makes for a selection rectangle,
//          and the runner that executes it as ONE undo step.
// CONTEXT: The data and behaviour behind BordersSplitButton.tsx, kept out of
//          the component file so that file exports only the component.
//
//          WHAT EXCEL DOES, measured live through COM on 2026-10-04 (fresh,
//          never-saved, off-screen Excel 365; each preset run with
//          CommandBars.ExecuteMso on the MENU's own control -- the
//          "...NoToggle" ids whose screentips are the menu's words -- and read
//          back with Range.Borders(edge); home-font report, "Excel probe"):
//
//          - Bottom / Top / Left / Right on a multi-row or multi-column range
//            write ONLY the outer edge (B2:C4 Bottom Border: B4/C4 bottom
//            thin, B2/B3 bottom untouched). They are NOT toggles: run twice,
//            the line stays; run over a thick bottom, it becomes thin.
//          - "Thick" (Thick Bottom, Thick Outside, Top and Thick Bottom) is
//            Excel's MEDIUM weight (xlMedium), solid -- Calcula's `medium`,
//            width 2 -- never its heaviest line. "Double" is the double line.
//            Both keep the Line Color and IGNORE the Line Style.
//          - Every other preset draws in the current Line Style (Bottom Border
//            and All Borders came out DASHED after Line Style > Dashed) and
//            every preset in the current Line Color (red after Line Color >
//            Red). Excel enters its Draw Border mode when a pen is picked;
//            that mode is deferred (owner decision 1(3)), so here picking a
//            pen only changes what the presets draw with.
//          - Outside Borders and the Top/Bottom combinations leave the cells'
//            INSIDE edges alone (a dashed inside line survived Outside).
//          - AN EDGE IS ONE LINE. Setting B1's bottom reads back as B2's top.
//            No Border on B2:C3 removed the lines B1, A2, D3 and B4 drew on
//            the range's edges (thick red ones too) and its diagonals; Top
//            Border on A2 REPLACED A1's double bottom with thin.
//
//          Calcula stores each cell's four sides separately and the renderer
//          paints the heavier of two coincident sides (cells.ts `queueBorder`),
//          so a line a neighbour OUTSIDE the selection draws on a shared edge
//          survives anything written inside. To match Excel, the runner reads
//          the row/column just outside each edge a preset writes or clears and
//          clears the coincident side wherever a neighbour has one. Clearing
//          (rather than also writing the line there) keeps Excel's ownership:
//          the line belongs to the cells the user formatted, so Clear Formats
//          on them removes it, and a neighbour that had no border gets no
//          style written at all. That read is bounded by NEIGHBOUR_READ_LIMIT:
//          the strip beside a WHOLE COLUMN is a million cells, and reading it
//          through the frontend is not worth a border. Beyond the limit the
//          neighbour's line is left (see the lane report; the right home for
//          this rule is the backend's apply_border_preset).
//
//          THE CALLS. Range presets (No Border, All, Outside, Thick Outside)
//          go through `applyBorderPreset`, which is range-aware (row/column
//          tiers for whole rows/columns, writes only cells that change,
//          replicates to grouped sheets). Edge presets go through
//          `applyFormatting` on the edge row or column, as the survey
//          (font.md section 3) prescribes: the preset command has no "one
//          outer edge" preset.

import type { RibbonIconKey } from "@api";
import { CoreCommands } from "@api/commands";
import { alertAsync } from "@api/dialogs";
import { getGridStateSnapshot } from "@api/grid";
import {
  applyBorderPreset,
  applyFormatting,
  beginUndoTransaction,
  cancelUndoTransaction,
  commitUndoTransaction,
  getStyle,
  getViewportCells,
} from "@api/lib";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import { selectionBlocks } from "@api/selectionBlocks";
import { announceFormattingResult } from "@api/announceFormatting";
import type { CellData, StyleData } from "@api/types";
import { ownUndoTransaction } from "@api/undoTicket";
import { messageOf, runCommand } from "../runCommand";
import { AUTOMATIC_INK } from "./kitColors";
import { createSessionValue } from "./sessionStore";

// ============================================================================
// The menu's data
// ============================================================================

/** The thirteen presets, by stable id (test-id suffix `fmt-borders-<id>`). */
export type BorderPresetId =
  | "bottom"
  | "top"
  | "left"
  | "right"
  | "none"
  | "all"
  | "outside"
  | "thickOutside"
  | "doubleBottom"
  | "thickBottom"
  | "topBottom"
  | "topThickBottom"
  | "topDoubleBottom";

/** One preset row of Excel's Borders menu. */
export interface BorderPresetRow {
  id: BorderPresetId;
  /** Excel's words; also the face's name, the action a refusal names and the
   *  undo step. */
  label: string;
  /** Its picture (CONTRACT section 7), resolved at render. */
  icon: RibbonIconKey;
  /** Which of Excel's three separator-bounded runs it is in. */
  section: 0 | 1 | 2;
}

/** Excel's presets, in Excel's order (menu-Borders capture, 2026-10-04). */
export const BORDER_PRESETS: readonly BorderPresetRow[] = [
  { id: "bottom", label: "Bottom Border", icon: "BorderBottom", section: 0 },
  { id: "top", label: "Top Border", icon: "BorderTop", section: 0 },
  { id: "left", label: "Left Border", icon: "BorderLeft", section: 0 },
  { id: "right", label: "Right Border", icon: "BorderRight", section: 0 },
  { id: "none", label: "No Border", icon: "BorderNone", section: 1 },
  { id: "all", label: "All Borders", icon: "BorderAll", section: 1 },
  { id: "outside", label: "Outside Borders", icon: "BorderOutside", section: 1 },
  { id: "thickOutside", label: "Thick Outside Borders", icon: "BorderThickOutside", section: 1 },
  { id: "doubleBottom", label: "Bottom Double Border", icon: "BorderDoubleBottom", section: 2 },
  { id: "thickBottom", label: "Thick Bottom Border", icon: "BorderThickBottom", section: 2 },
  { id: "topBottom", label: "Top and Bottom Border", icon: "BorderTopBottom", section: 2 },
  { id: "topThickBottom", label: "Top and Thick Bottom Border", icon: "BorderTopThickBottom", section: 2 },
  { id: "topDoubleBottom", label: "Top and Double Bottom Border", icon: "BorderTopDoubleBottom", section: 2 },
];

const PRESETS_BY_ID: ReadonlyMap<BorderPresetId, BorderPresetRow> = new Map(BORDER_PRESETS.map((p) => [p.id, p]));

/** The row of a preset id. */
export function borderPresetRow(id: BorderPresetId): BorderPresetRow {
  return PRESETS_BY_ID.get(id) ?? BORDER_PRESETS[0];
}

/** The line styles Calcula can store (the backend's side words). */
export type LineStyleId = "thin" | "dotted" | "dashed" | "double" | "medium" | "thick";

/** One row of Line Style >. */
export interface LineStyleRow {
  id: LineStyleId;
  label: string;
}

/**
 * Line Style >, in EXCEL's list order (UIA names, measured: None, Thin, Hair,
 * Dotted, Dashed, DashDot, DashDotDot, Double, Medium, MediumDashed,
 * MediumDashDot, MediumDashDotDot, SlantDashDot, Thick) restricted to the six
 * Calcula's border model can store. Excel's None row is not offered: picking
 * "no line" as a pen only makes sense for Draw Border, which is deferred.
 */
export const LINE_STYLES: readonly LineStyleRow[] = [
  { id: "thin", label: "Thin" },
  { id: "dotted", label: "Dotted" },
  { id: "dashed", label: "Dashed" },
  { id: "double", label: "Double" },
  { id: "medium", label: "Medium" },
  { id: "thick", label: "Thick" },
];

/** What the presets draw with. `color` null = Automatic. */
export interface BorderPen {
  color: string | null;
  style: LineStyleId;
}

/** The ink of an Automatic line (Excel's automatic border colour is black). */
export const AUTOMATIC_LINE_COLOR: string = AUTOMATIC_INK;

/** A fresh Excel's pen: Automatic, thin. */
export const DEFAULT_BORDER_PEN: BorderPen = Object.freeze({ color: null, style: "thin" }) as BorderPen;

/** The face's default: Bottom Border, as in a fresh Excel. */
export const DEFAULT_BORDER_PRESET: BorderPresetId = "bottom";

/** The preset the face shows and re-applies: the one used last this session. */
export const lastBorderPreset = createSessionValue<BorderPresetId>(DEFAULT_BORDER_PRESET);

/** The pen the presets draw with, this session. */
export const borderPen = createSessionValue<BorderPen>(DEFAULT_BORDER_PEN);

/** More Borders...: Format Cells on its Border tab, with All Borders' picture
 *  (Excel's row shows the same drawing). */
export const MORE_BORDERS = { label: "More Borders...", slug: "more", icon: "BorderAll" } as const satisfies {
  label: string;
  slug: string;
  icon: RibbonIconKey;
};

// ============================================================================
// The plan (pure)
// ============================================================================

/** A normalised selection block (start <= end). */
export interface CellRect {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** The sheet's size in rows and columns. */
export interface SheetBounds {
  rows: number;
  cols: number;
}

/** One rectangle edge. */
export type Edge = "top" | "bottom" | "left" | "right";

/** A cell side field of `applyFormatting`. */
export type SideField = "borderTop" | "borderBottom" | "borderLeft" | "borderRight";

/** A side as `applyFormatting` takes it. */
export interface SideParam {
  style: string;
  color: string;
}

/** The sides one applyFormatting call writes. */
export type SideFormatting = Partial<Record<SideField, SideParam>>;

/** One backend call of a plan. */
export type BorderWrite =
  | {
      kind: "preset";
      rect: CellRect;
      preset: "none" | "allBorders" | "outside";
      /** The preset command's line style word. */
      style: "solid" | "dashed" | "dotted" | "double";
      color: string;
      /** 0 (no line) .. 3 (thick). */
      width: number;
    }
  | {
      kind: "sides";
      /** Written as the cross product rows x cols (applyFormatting). */
      rows: number[];
      cols: number[];
      formatting: SideFormatting;
    };

/** What a preset does to one block. */
export interface BorderPlan {
  writes: BorderWrite[];
  /** The outer edges whose (shared) line the preset writes or clears; a
   *  neighbour's coincident side on each is cleared after (see header). */
  sharedEdges: Edge[];
}

const ALL_EDGES: readonly Edge[] = ["top", "bottom", "left", "right"];

/** The preset command's (style, width) for a pen line style. */
const PRESET_LINE: Readonly<Record<LineStyleId, [style: "solid" | "dashed" | "dotted" | "double", width: number]>> = {
  thin: ["solid", 1],
  medium: ["solid", 2],
  thick: ["solid", 3],
  dashed: ["dashed", 1],
  dotted: ["dotted", 1],
  double: ["double", 1],
};

/** Excel's "Thick" presets: MEDIUM, solid (measured xlMedium). */
const THICK_SIDE_WORD = "medium";
const THICK_PRESET_WIDTH = 2;

function span(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

/**
 * The backend calls `preset` makes on one block with `pen`. Pure: no reads,
 * no writes, so every row of the menu is pinned against Excel's measured
 * behaviour without a backend.
 */
export function planBorderPreset(preset: BorderPresetId, rect: CellRect, pen: BorderPen): BorderPlan {
  const color = pen.color ?? AUTOMATIC_LINE_COLOR;
  const line: SideParam = { style: pen.style, color };
  const thick: SideParam = { style: THICK_SIDE_WORD, color };
  const double: SideParam = { style: "double", color };
  const rows = span(rect.startRow, rect.endRow);
  const cols = span(rect.startCol, rect.endCol);
  const topRow = [rect.startRow];
  const bottomRow = [rect.endRow];
  const [penStyle, penWidth] = PRESET_LINE[pen.style];

  const range = (p: "none" | "allBorders" | "outside", style: typeof penStyle, width: number): BorderPlan => ({
    writes: [{ kind: "preset", rect, preset: p, style, color, width }],
    sharedEdges: [...ALL_EDGES],
  });
  const sides = (r: number[], c: number[], formatting: SideFormatting): BorderWrite => ({
    kind: "sides",
    rows: r,
    cols: c,
    formatting,
  });
  /** Top and <bottom>: ONE call on a one-row block, else one per edge. */
  const topAnd = (bottom: SideParam): BorderPlan => ({
    writes:
      rect.startRow === rect.endRow
        ? [sides(topRow, cols, { borderTop: line, borderBottom: bottom })]
        : [sides(topRow, cols, { borderTop: line }), sides(bottomRow, cols, { borderBottom: bottom })],
    sharedEdges: ["top", "bottom"],
  });

  switch (preset) {
    case "bottom":
      return { writes: [sides(bottomRow, cols, { borderBottom: line })], sharedEdges: ["bottom"] };
    case "top":
      return { writes: [sides(topRow, cols, { borderTop: line })], sharedEdges: ["top"] };
    case "left":
      return { writes: [sides(rows, [rect.startCol], { borderLeft: line })], sharedEdges: ["left"] };
    case "right":
      return { writes: [sides(rows, [rect.endCol], { borderRight: line })], sharedEdges: ["right"] };
    case "none":
      return range("none", "solid", 0);
    case "all":
      return range("allBorders", penStyle, penWidth);
    case "outside":
      return range("outside", penStyle, penWidth);
    case "thickOutside":
      return range("outside", "solid", THICK_PRESET_WIDTH);
    case "doubleBottom":
      return { writes: [sides(bottomRow, cols, { borderBottom: double })], sharedEdges: ["bottom"] };
    case "thickBottom":
      return { writes: [sides(bottomRow, cols, { borderBottom: thick })], sharedEdges: ["bottom"] };
    case "topBottom":
      return topAnd(line);
    case "topThickBottom":
      return topAnd(thick);
    case "topDoubleBottom":
      return topAnd(double);
  }
}

/** The row or column just outside one edge of `rect`, with the side of its
 *  cells that coincides with that edge; null at the sheet's edge. */
export interface SharedEdgeStrip extends CellRect {
  side: SideField;
}

export function sharedEdgeStrip(rect: CellRect, edge: Edge, bounds: SheetBounds): SharedEdgeStrip | null {
  switch (edge) {
    case "top":
      return rect.startRow > 0
        ? { startRow: rect.startRow - 1, startCol: rect.startCol, endRow: rect.startRow - 1, endCol: rect.endCol, side: "borderBottom" }
        : null;
    case "bottom":
      return rect.endRow < bounds.rows - 1
        ? { startRow: rect.endRow + 1, startCol: rect.startCol, endRow: rect.endRow + 1, endCol: rect.endCol, side: "borderTop" }
        : null;
    case "left":
      return rect.startCol > 0
        ? { startRow: rect.startRow, startCol: rect.startCol - 1, endRow: rect.endRow, endCol: rect.startCol - 1, side: "borderRight" }
        : null;
    case "right":
      return rect.endCol < bounds.cols - 1
        ? { startRow: rect.startRow, startCol: rect.endCol + 1, endRow: rect.endRow, endCol: rect.endCol + 1, side: "borderLeft" }
        : null;
  }
}

/** The longest neighbour strip the runner reads: one full row of columns.
 *  The strip beside a whole column (a million rows) is not read. */
export const NEIGHBOUR_READ_LIMIT = 16384;

// ============================================================================
// The runner
// ============================================================================

const DEFAULT_BOUNDS: SheetBounds = { rows: 1048576, cols: 16384 };

/** The selection's blocks -- `@api/selectionBlocks`, the ONE split every
 *  formatting door uses (the main block first, each Ctrl+click range
 *  normalised, an exact repeat dropped; this file's own copy did not drop
 *  repeats) -- and the sheet's size, from the grid's live snapshot. */
function selectionAndBounds(): { blocks: CellRect[]; bounds: SheetBounds } | null {
  const snapshot = getGridStateSnapshot();
  const sel = snapshot?.selection;
  if (!sel) return null;
  const config = (snapshot as { config?: { totalRows?: number; totalCols?: number } }).config;
  const bounds: SheetBounds = {
    rows: config?.totalRows ?? DEFAULT_BOUNDS.rows,
    cols: config?.totalCols ?? DEFAULT_BOUNDS.cols,
  };
  return { blocks: selectionBlocks(sel), bounds };
}

/** A side that paints (the renderer's own test). */
function paints(side: StyleData["borderTop"] | undefined): boolean {
  return side !== undefined && side !== null && side.style !== "none" && side.width > 0;
}

const NO_LINE: SideParam = { style: "none", color: AUTOMATIC_LINE_COLOR };

/**
 * Clear the coincident side of every neighbour that draws a line on `edge`.
 * Reads the EFFECTIVE styles (get_viewport_cells resolves row/column tiers),
 * caches each style once, and writes only the cells that have a line there --
 * a neighbour with no border gets nothing written.
 */
async function clearSharedEdge(rect: CellRect, edge: Edge, bounds: SheetBounds, styleCache: Map<number, Promise<StyleData>>): Promise<CellData[]> {
  const strip = sharedEdgeStrip(rect, edge, bounds);
  if (!strip) return [];
  const length = (strip.endRow - strip.startRow + 1) * (strip.endCol - strip.startCol + 1);
  if (length > NEIGHBOUR_READ_LIMIT) return [];
  const cells = await getViewportCells(strip.startRow, strip.startCol, strip.endRow, strip.endCol);
  const owners: CellData[] = [];
  for (const cell of cells) {
    let style = styleCache.get(cell.styleIndex);
    if (!style) {
      style = getStyle(cell.styleIndex);
      styleCache.set(cell.styleIndex, style);
    }
    if (paints((await style)[strip.side])) owners.push(cell);
  }
  if (owners.length === 0) return [];
  // A top/bottom strip is ONE row (the owners differ by column); a
  // left/right strip is ONE column. applyFormatting writes rows x cols, so
  // either way the cross product is exactly the owners.
  const horizontal = edge === "top" || edge === "bottom";
  const rows = horizontal ? [strip.startRow] : owners.map((c) => c.row);
  const cols = horizontal ? owners.map((c) => c.col) : [strip.startCol];
  const result = await applyFormatting(rows, cols, { [strip.side]: NO_LINE });
  return result.cells;
}

async function runWrite(write: BorderWrite): Promise<CellData[]> {
  if (write.kind === "preset") {
    const { rect } = write;
    const result = await applyBorderPreset(
      rect.startRow,
      rect.startCol,
      rect.endRow,
      rect.endCol,
      write.preset,
      write.style,
      write.color,
      write.width,
    );
    return result.cells;
  }
  const result = await applyFormatting(write.rows, write.cols, write.formatting);
  return result.cells;
}

/** What every Home formatting door does after a write: the ONE announcement
 *  (`@api/announceFormatting`) -- the cells, then a style and grid repaint. */
function announce(cells: CellData[]): void {
  announceFormattingResult({ cells, styles: [] });
}

/**
 * Apply `preset` with the session's pen (or `pen`) to every block of the
 * selection, as ONE undo step named after the preset. Answers whether it
 * applied; never throws -- a refusal reaches the user.
 *
 * Asks the selection owner FIRST, before a transaction is opened: a floating
 * grid's cell owning the selection refuses here with one toast, and no empty
 * step is left behind.
 */
export async function applyBorderChoice(preset: BorderPresetId, pen: BorderPen = borderPen.get()): Promise<boolean> {
  const row = borderPresetRow(preset);
  const action = row.label;
  if (refuseIfSelectionOwned(action)) return false;
  const selection = selectionAndBounds();
  if (!selection) return false;

  // A begin that fails still lets the preset apply (as several steps, what
  // every formatting button does without a transaction). A begin that JOINS
  // a script's batch closes nothing: the holder closes it.
  const tx = ownUndoTransaction(await beginUndoTransaction(action).catch(() => null), {
    commitUndoTransaction,
    cancelUndoTransaction,
  });
  const written: CellData[] = [];
  let ok = true;
  try {
    const styleCache = new Map<number, Promise<StyleData>>();
    for (const rect of selection.blocks) {
      const plan = planBorderPreset(preset, rect, pen);
      for (const write of plan.writes) written.push(...(await runWrite(write)));
      for (const edge of plan.sharedEdges) {
        written.push(...(await clearSharedEdge(rect, edge, selection.bounds, styleCache)));
      }
    }
  } catch (err) {
    ok = false;
    void alertAsync(messageOf(err));
  } finally {
    // COMMIT, never cancel: what landed stays undoable (a cancel drops the
    // undo record and keeps the writes). An empty step commits to nothing.
    await tx.commit().catch((err) => console.error("[HomeTab] Borders: closing the undo step failed:", err));
    announce(written);
  }
  return ok;
}

/** A preset row was chosen: it becomes the face (Excel), then applies. */
export async function chooseBorder(preset: BorderPresetId): Promise<boolean> {
  lastBorderPreset.set(preset);
  return applyBorderChoice(preset);
}

/** More Borders...: the FORMAT_CELLS command, the ONE door to the dialog (it
 *  refuses while something else owns the selection). Never throws. */
export async function openMoreBorders(): Promise<void> {
  await runCommand(CoreCommands.FORMAT_CELLS, { tab: "border" });
}

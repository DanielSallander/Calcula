//! FILENAME: app/extensions/Pivot/lib/pivotModelVisuals.ts
// PURPOSE: The Pivot family's part in cross-filtering (P4, G4, S7): which
//          canvas pivot BOXES exist, which model each reads, and the provider
//          @api/modelVisuals lists them through.
// CONTEXT: Edit interactions (CanvasSheet), the script host and the resolver's
//          consumers ask @api/modelVisuals which visuals exist and what each
//          can do; none of them may import Pivot (the Seam Rule), so Pivot
//          lists its own boxes here.
//
//          THE BOXES. A canvas pivot is a floating `pivot-visual` box; the
//          region sync announces the active sheet's pivots on every refresh
//          (`PivotEvents.PIVOT_REGIONS_UPDATED`), and the ones with a
//          `canvasFrame` are the boxes. They are remembered per sheet, so a
//          page left keeps its boxes listed (its selections survive a page
//          switch in the session).
//
//          THE MODEL. A box's region says WHETHER it is a model pivot
//          (`isModel`), not which connection: that is read once per pivot
//          from `get_pivot_bi_metadata` (connection id and the model's table
//          names, which split a "Table.Column" field whose table name holds a
//          dot) and kept until the model changes (`bi:model-changed`).
//
//          ROLES (spec 2.2). A BI pivot box: a source (every box is on a
//          canvas), a target (a paint-only filtered view, pivotCrossFilterView.ts),
//          never a highlight. A range pivot box reads cells: no role, "Reads
//          cells, not the model". A model box whose model is not read yet (or
//          could not be) has no connection and says so.

import { registerModelVisualProvider, type ModelVisualInfo } from "@api/modelVisuals";
import { getReportPagesSnapshot, reportPageById, sheetIdAt, type ReportPagesSnapshot } from "@api/reportPages";
import type { BiPivotModelInfo, PivotRegionData } from "./pivot-api";
import { pivotBackend } from "./pivotBackend";

/** Why a range pivot plays no part (its disabled None icon's title). */
export const RANGE_PIVOT_REASON = "Reads cells, not the model";
/** Why a model pivot whose model has not been read yet plays no part (for now). */
export const PIVOT_MODEL_PENDING_REASON = "Its model is still being read";
/** Why a model pivot whose model could not be read plays no part. */
export const PIVOT_MODEL_UNREAD_REASON = "Its model could not be read";

/** One canvas pivot box as the cross-filter surfaces see it. */
export interface PivotBox {
  pivotId: string;
  name: string;
  /** The TRUE sheet index the box was announced on. */
  sheetIndex: number;
  /** The sheet's stable id when the page list knew it at the announcement. */
  sheetId: string | null;
  /** A data-model (BI) pivot. */
  isModel: boolean;
}

/** What a model pivot reads: its connection and the model's table names. */
export interface PivotModelInfo {
  connectionId: string;
  tableNames: string[];
}

/** Boxes by the sheet index they were announced on. */
const boxesBySheet = new Map<number, PivotBox[]>();
/** The sheet whose regions were announced last (the active canvas). */
let lastSheetIndex: number | null = null;
/** Model info per pivot: absent = not read yet, null = not a model pivot or unreadable. */
const modelInfo = new Map<string, PivotModelInfo | null>();
/** Reads in flight, so one pivot is read once however many ask. */
const modelReads = new Map<string, Promise<PivotModelInfo | null>>();
/** Bumped on every forget: a read that started before it is not stored. */
let modelEpoch = 0;

/**
 * Remember the boxes the region sync announced for `sheetIndex` (the active
 * sheet): every region with a canvas frame. Replaces that sheet's list.
 */
export function notePivotBoxes(regions: readonly PivotRegionData[], sheetIndex: number): PivotBox[] {
  const pages = getReportPagesSnapshot();
  const sheetId = sheetIdAt(pages, sheetIndex);
  const boxes: PivotBox[] = regions
    .filter((r) => r.canvasFrame != null && typeof r.pivotId === "string" && r.pivotId !== "")
    .map((r) => ({
      pivotId: r.pivotId,
      name: r.name || r.pivotId,
      sheetIndex,
      sheetId,
      isModel: r.isModel === true,
    }));
  // A pivot is on one sheet: an announcement here takes it off any other.
  const ids = new Set(boxes.map((b) => b.pivotId));
  for (const [idx, list] of [...boxesBySheet.entries()]) {
    if (idx === sheetIndex) continue;
    const kept = list.filter((b) => !ids.has(b.pivotId));
    if (kept.length === 0) boxesBySheet.delete(idx);
    else if (kept.length !== list.length) boxesBySheet.set(idx, kept);
  }
  if (boxes.length === 0) boxesBySheet.delete(sheetIndex);
  else boxesBySheet.set(sheetIndex, boxes);
  lastSheetIndex = sheetIndex;
  return boxes;
}

/** The box `pivotId` names, or null. */
export function getPivotBox(pivotId: string): PivotBox | null {
  for (const list of boxesBySheet.values()) {
    const hit = list.find((b) => b.pivotId === pivotId);
    if (hit) return hit;
  }
  return null;
}

/** The boxes of the sheet announced last (the active canvas). */
export function currentPivotBoxes(): readonly PivotBox[] {
  return lastSheetIndex === null ? [] : boxesBySheet.get(lastSheetIndex) ?? [];
}

/** Forget one box (its pivot was deleted). */
export function forgetPivotBox(pivotId: string): void {
  for (const [idx, list] of [...boxesBySheet.entries()]) {
    const kept = list.filter((b) => b.pivotId !== pivotId);
    if (kept.length === list.length) continue;
    if (kept.length === 0) boxesBySheet.delete(idx);
    else boxesBySheet.set(idx, kept);
  }
  modelInfo.delete(pivotId);
  modelReads.delete(pivotId);
}

/** The page (sheet id) a box is on, from the page list now (it may have learnt the id since). */
export function pivotBoxSheetId(box: PivotBox, pages: ReportPagesSnapshot = getReportPagesSnapshot()): string | null {
  return box.sheetId ?? sheetIdAt(pages, box.sheetIndex);
}

/** The model a pivot reads: undefined = not read yet, null = none (a range pivot, or unreadable). */
export function pivotModelInfo(pivotId: string): PivotModelInfo | null | undefined {
  return modelInfo.has(pivotId) ? modelInfo.get(pivotId)! : undefined;
}

function infoFrom(meta: BiPivotModelInfo | null | undefined): PivotModelInfo | null {
  if (!meta || typeof meta.connectionId !== "string" || meta.connectionId === "") return null;
  const tableNames = Array.isArray(meta.tables)
    ? meta.tables.map((t) => t?.name).filter((n): n is string => typeof n === "string" && n !== "")
    : [];
  return { connectionId: String(meta.connectionId), tableNames };
}

/**
 * Read (once) the model a pivot reads. A failed read is stored as null and
 * said in the console: the box then plays no part instead of failing every
 * later question.
 */
export function ensurePivotModelInfo(pivotId: string): Promise<PivotModelInfo | null> {
  if (modelInfo.has(pivotId)) return Promise.resolve(modelInfo.get(pivotId)!);
  const inflight = modelReads.get(pivotId);
  if (inflight) return inflight;
  const epoch = modelEpoch;
  const read = pivotBackend
    .invoke<BiPivotModelInfo | null>("get_pivot_bi_metadata", { pivotId })
    .then((meta) => infoFrom(meta))
    .catch((err) => {
      console.warn(`[Pivot] The model of PivotTable "${pivotId}" could not be read:`, err);
      return null;
    })
    .then((info) => {
      if (epoch === modelEpoch && modelReads.get(pivotId) === read) {
        modelInfo.set(pivotId, info);
        modelReads.delete(pivotId);
      }
      return info;
    });
  modelReads.set(pivotId, read);
  return read;
}

/** Forget every pivot's model (the model changed: tables, connection). */
export function forgetPivotModelInfo(): void {
  modelEpoch++;
  modelInfo.clear();
  modelReads.clear();
}

/** The cross-filter view of ONE box. Pure over the box, its model info and the page list. */
export function pivotModelVisualInfo(
  box: PivotBox,
  info: PivotModelInfo | null | undefined,
  pages: ReportPagesSnapshot,
): ModelVisualInfo {
  const sheetId = pivotBoxSheetId(box, pages);
  const page = sheetId ? reportPageById(pages, sheetId) : null;
  const base = {
    ref: { kind: "pivot" as const, id: box.pivotId },
    name: box.name,
    sheetIndex: page?.index ?? box.sheetIndex,
    sheetId,
    label: "PivotTable",
  };
  if (!box.isModel) {
    return { ...base, connectionId: null, role: { source: false, target: false, canHighlight: false, reason: RANGE_PIVOT_REASON } };
  }
  if (!info) {
    return {
      ...base,
      connectionId: null,
      role: {
        source: false,
        target: false,
        canHighlight: false,
        reason: info === undefined ? PIVOT_MODEL_PENDING_REASON : PIVOT_MODEL_UNREAD_REASON,
      },
    };
  }
  return { ...base, connectionId: info.connectionId, role: { source: true, target: true, canHighlight: false, reason: null } };
}

/** Every known box, as @api/modelVisuals lists it. A model not read yet is asked for (once). */
export function listPivotModelVisuals(): ModelVisualInfo[] {
  const pages = getReportPagesSnapshot();
  const knownIds = new Set(pages.sheetIdByIndex.values());
  const out: ModelVisualInfo[] = [];
  for (const list of boxesBySheet.values()) {
    for (const box of list) {
      // A box of an earlier document (its sheet id is not one of this
      // document's) is not listed.
      if (box.sheetId !== null && knownIds.size > 0 && !knownIds.has(box.sheetId)) continue;
      const info = pivotModelInfo(box.pivotId);
      if (box.isModel && info === undefined) void ensurePivotModelInfo(box.pivotId);
      out.push(pivotModelVisualInfo(box, info, pages));
    }
  }
  return out;
}

/** Register the Pivot provider. Returns its unregister function. */
export function registerPivotModelVisuals(): () => void {
  return registerModelVisualProvider({ kind: "pivot", list: listPivotModelVisuals });
}

/** Forget every box and every model (File > New / Open, deactivation, tests). */
export function resetPivotModelVisuals(): void {
  boxesBySheet.clear();
  lastSheetIndex = null;
  forgetPivotModelInfo();
}

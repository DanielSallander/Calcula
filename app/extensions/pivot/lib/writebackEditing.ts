//! FILENAME: app/extensions/Pivot/lib/writebackEditing.ts
// PURPOSE: Writeback-column editing support for BI pivots.
// CONTEXT: A model designer defines a writeback column (e.g. Forecast on
// dim_customer keyed by ID). When that column is placed as a LOOKUP row field,
// end users may type values into its cells on LEAF data rows. The typed value
// is routed to biWritebackSetValue (keyed by the row's key-column labels) and
// the pivot re-projects — the grid cell itself is never written.
//
// This module owns the editability model:
//  - a per-connection cache of writeback field metas (biWritebackListColumns),
//  - a per-pivot precomputed context (which view columns are editable and how
//    to assemble the key), rebuilt whenever pivot regions refresh,
//  - resolveWritebackCell(): the synchronous GRAIN-RULE check used by the
//    edit/range guards and the commit guard.

import {
  biWritebackListColumns,
  biWritebackSetValue,
  type BiWritebackFieldMeta,
} from "@api";
import { getLocaleSettings } from "@api/locale";
import type {
  PivotRegionInfo,
  PivotViewResponse,
  PivotCellData,
  PivotRowType,
  ReportLayout,
} from "@api/pivotTypes";
import { getPivotAtCell } from "./pivot-api";
import { getCachedPivotView, getCellWindowCache } from "./pivotViewStore";
import { findPivotRegionAtCell, getCachedRegions } from "../handlers/selectionHandler";
import type { PivotRegionData } from "../types";

// ============================================================================
// Types
// ============================================================================

/** Resolved edit target for one writeback-editable pivot cell. */
export interface WritebackCellTarget {
  connectionId: string;
  writebackId: string;
  /** The host row's key values (label text), in the meta's keyColumns order. */
  key: string[];
  columnName: string;
}

/** How to read one key value from the pivot view. */
type KeyPart =
  | { kind: "group"; groupIndex: number }
  | { kind: "attr"; attrIndex: number };

interface EditableColumn {
  meta: BiWritebackFieldMeta;
  keyPlan: KeyPart[];
}

/** Precomputed per-pivot lookup structure (cheap to consult from guards). */
interface PivotWritebackContext {
  connectionId: string;
  /** Non-lookup (GROUP) row fields, in definition order. */
  groupCount: number;
  /** LOOKUP (attribute) row fields, in definition order. */
  attrCount: number;
  reportLayout: ReportLayout;
  /** Number of view columns occupied by GROUP labels (layout-dependent). */
  groupColCount: number;
  /** viewCol -> editable writeback column at that view column. */
  editableByViewCol: Map<number, EditableColumn>;
  /** attrIndex -> viewCol of that attribute column. */
  attrViewCols: number[];
}

// ============================================================================
// State
// ============================================================================

/** connectionId -> in-flight/settled fetch of that model's writeback metas. */
const metasByConnection = new Map<string, Promise<BiWritebackFieldMeta[]>>();

/** pivotId -> precomputed context (null = known non-editable pivot). */
const contexts = new Map<string, PivotWritebackContext | null>();

/** pivotId -> in-flight context build (dedupe). */
const inflightBuilds = new Map<string, Promise<void>>();

/** Safety cap for the ancestor-row walk (bounded by pivot row count anyway). */
const ANCESTOR_WALK_LIMIT = 200_000;

// ============================================================================
// Context building
// ============================================================================

/** Fetch (and cache) the writeback column metas of one connection's model. */
function metasFor(connectionId: string): Promise<BiWritebackFieldMeta[]> {
  let cached = metasByConnection.get(connectionId);
  if (!cached) {
    cached = biWritebackListColumns(connectionId).catch((err) => {
      // Drop the failed fetch so a later prepare can retry.
      metasByConnection.delete(connectionId);
      console.warn("[pivot-writeback] biWritebackListColumns failed:", err);
      return [] as BiWritebackFieldMeta[];
    });
    metasByConnection.set(connectionId, cached);
  }
  return cached;
}

/** Derive the per-pivot context from fresh region info + connection metas. */
function deriveContext(
  info: PivotRegionInfo,
  metas: BiWritebackFieldMeta[],
): PivotWritebackContext | null {
  const connectionId = info.biModel?.connectionId;
  if (!connectionId || metas.length === 0) return null;

  const rowFields = info.fieldConfiguration.rowFields;
  const groupFields = rowFields.filter((f) => !f.isLookup);
  const attrFields = rowFields.filter((f) => f.isLookup);
  // A lookup needs at least one GROUP field to define the leaf grain.
  if (attrFields.length === 0 || groupFields.length === 0) return null;

  const reportLayout: ReportLayout =
    info.fieldConfiguration.layout.reportLayout ?? "compact";
  // Mirrors the engine's calculate_row_label_columns(): compact shares ONE
  // column across all GROUP fields; outline/tabular give each its own.
  const groupColCount = reportLayout === "compact" ? 1 : groupFields.length;

  const metaByFieldKey = new Map<string, BiWritebackFieldMeta>();
  for (const m of metas) {
    metaByFieldKey.set(`${m.table}.${m.name}`, m);
  }

  const editableByViewCol = new Map<number, EditableColumn>();
  const attrViewCols: number[] = [];
  for (let ai = 0; ai < attrFields.length; ai++) {
    attrViewCols.push(groupColCount + ai);
  }

  for (let ai = 0; ai < attrFields.length; ai++) {
    const meta = metaByFieldKey.get(attrFields[ai].name);
    if (!meta) continue;

    // GRAIN RULE (c): every key column must be present among the row fields
    // of the same host table (as a GROUP field or another lookup).
    const keyPlan: KeyPart[] = [];
    let complete = true;
    for (const keyCol of meta.keyColumns) {
      const fieldKey = `${meta.table}.${keyCol}`;
      // A writeback column can't key itself.
      if (fieldKey === attrFields[ai].name) {
        complete = false;
        break;
      }
      const groupIndex = groupFields.findIndex((f) => f.name === fieldKey);
      if (groupIndex !== -1) {
        keyPlan.push({ kind: "group", groupIndex });
        continue;
      }
      const attrIndex = attrFields.findIndex((f) => f.name === fieldKey);
      if (attrIndex !== -1) {
        keyPlan.push({ kind: "attr", attrIndex });
        continue;
      }
      complete = false;
      break;
    }
    if (!complete || keyPlan.length === 0) continue;

    editableByViewCol.set(attrViewCols[ai], { meta, keyPlan });
  }

  if (editableByViewCol.size === 0) return null;

  return {
    connectionId,
    groupCount: groupFields.length,
    attrCount: attrFields.length,
    reportLayout,
    groupColCount,
    editableByViewCol,
    attrViewCols,
  };
}

async function buildContext(
  pivotId: string,
  startRow: number,
  startCol: number,
): Promise<PivotWritebackContext | null> {
  const info = await getPivotAtCell(startRow, startCol);
  if (!info || info.pivotId !== pivotId) return null;
  const connectionId = info.biModel?.connectionId;
  if (!connectionId) return null;
  const metas = await metasFor(connectionId);
  return deriveContext(info, metas);
}

/**
 * (Re)build the writeback context of every non-empty pivot region.
 * Called whenever pivot regions refresh (load, field changes, sheet switch)
 * so editability checks stay cheap and synchronous during interaction.
 * Non-blocking; failures leave the pivot non-editable (fail safe).
 */
export function prepareWritebackContexts(regions: PivotRegionData[]): void {
  for (const r of regions) {
    if (r.isEmpty) {
      contexts.delete(r.pivotId);
      continue;
    }
    if (inflightBuilds.has(r.pivotId)) continue;
    const build = buildContext(r.pivotId, r.startRow, r.startCol)
      .then((ctx) => {
        contexts.set(r.pivotId, ctx);
      })
      .catch((err) => {
        console.warn("[pivot-writeback] context build failed:", err);
        contexts.delete(r.pivotId);
      })
      .finally(() => {
        inflightBuilds.delete(r.pivotId);
      });
    inflightBuilds.set(r.pivotId, build);
  }
}

/**
 * Invalidate cached writeback metas (and dependent pivot contexts) after a
 * model change, then rebuild from the current sheet's regions.
 */
export function handleWritebackModelChanged(connectionId?: string): void {
  if (connectionId) {
    metasByConnection.delete(connectionId);
  } else {
    metasByConnection.clear();
  }
  for (const [pivotId, ctx] of contexts) {
    if (!connectionId || !ctx || ctx.connectionId === connectionId) {
      contexts.delete(pivotId);
    }
  }
  prepareWritebackContexts(getCachedRegions());
}

/** Clear all cached state (extension deactivation). */
export function resetWritebackEditingState(): void {
  metasByConnection.clear();
  contexts.clear();
  inflightBuilds.clear();
}

// ============================================================================
// Cell resolution (the grain rule)
// ============================================================================

function getRowMeta(
  view: PivotViewResponse,
  viewRow: number,
): { rowType: PivotRowType; depth: number } | null {
  if (view.isWindowed) {
    const d = view.rowDescriptors?.[viewRow];
    return d ? { rowType: d.rowType, depth: d.depth } : null;
  }
  const r = view.rows[viewRow];
  return r ? { rowType: r.rowType, depth: r.depth } : null;
}

function getRowCells(
  pivotId: string,
  view: PivotViewResponse,
  viewRow: number,
): PivotCellData[] | null {
  if (view.isWindowed) {
    return getCellWindowCache(pivotId)?.getRow(viewRow)?.cells ?? null;
  }
  return view.rows[viewRow]?.cells ?? null;
}

/** Read a label cell's text as a key value; null when blank/unreadable. */
function readLabel(cell: PivotCellData | undefined): string | null {
  if (!cell) return null;
  const v = cell.value;
  if (typeof v === "string") return v !== "" ? v : null;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return null;
}

/**
 * Read the label of a GROUP key field for the given leaf row.
 * Tries the leaf row's own label cell first (covers the field's own level,
 * repeated labels, and first-of-group rows), then walks UP to the nearest
 * ancestor data row at the key field's depth (compact layouts and
 * non-repeated outline/tabular labels).
 */
function readGroupKeyLabel(
  pivotId: string,
  view: PivotViewResponse,
  ctx: PivotWritebackContext,
  leafRow: number,
  leafDepth: number,
  groupIndex: number,
): string | null {
  const col = ctx.reportLayout === "compact" ? 0 : groupIndex;

  if (groupIndex === leafDepth || ctx.reportLayout !== "compact") {
    const own = readLabel(getRowCells(pivotId, view, leafRow)?.[col]);
    if (own !== null) return own;
    if (groupIndex === leafDepth) return null;
  }

  for (let r = leafRow - 1, hops = 0; r >= 0 && hops < ANCESTOR_WALK_LIMIT; r--, hops++) {
    const meta = getRowMeta(view, r);
    if (!meta) return null;
    if (meta.rowType === "ColumnHeader" || meta.rowType === "FilterRow") return null;
    if (meta.rowType !== "Data") continue; // skip subtotal / grand-total rows
    if (meta.depth === groupIndex) {
      return readLabel(getRowCells(pivotId, view, r)?.[col]);
    }
    if (meta.depth < groupIndex) return null; // left the subtree — bail out
  }
  return null;
}

/**
 * Resolve a grid cell to a writeback edit target, enforcing the GRAIN RULE:
 *  (a) the cell is in the view column of a writeback column placed as LOOKUP,
 *  (b) the row is a LEAF data row (innermost group level; no totals/headers),
 *  (c) every key column's value is readable from the row's label cells.
 * Returns null otherwise. Synchronous and cheap — safe to call from guards.
 */
export function resolveWritebackCell(
  pivotId: string,
  sheetRow: number,
  sheetCol: number,
): WritebackCellTarget | null {
  const ctx = contexts.get(pivotId);
  if (!ctx) return null;

  const region = findPivotRegionAtCell(sheetRow, sheetCol);
  if (!region || region.pivotId !== pivotId || region.isEmpty) return null;

  const view = getCachedPivotView(pivotId);
  if (!view) return null;
  // Structural cross-check: the context derives from the pivot's field config,
  // the view from the last query. On drift (e.g. mid-update) fail safe.
  if ((view.rowLabelColCount ?? 0) !== ctx.groupColCount + ctx.attrCount) return null;

  const viewRow = sheetRow - region.startRow;
  const viewCol = sheetCol - region.startCol;
  const editable = ctx.editableByViewCol.get(viewCol);
  if (!editable) return null;

  const rowMeta = getRowMeta(view, viewRow);
  if (!rowMeta) return null;
  // Leaf data rows only — subtotals, grand totals, headers and collapsed
  // (shallower) rows are never editable.
  if (rowMeta.rowType !== "Data" || rowMeta.depth !== ctx.groupCount - 1) return null;

  const cells = getRowCells(pivotId, view, viewRow);
  const cell = cells?.[viewCol];
  if (!cell || cell.cellType !== "RowHeader") return null;

  const key: string[] = [];
  for (const part of editable.keyPlan) {
    const label =
      part.kind === "attr"
        ? readLabel(cells?.[ctx.attrViewCols[part.attrIndex]])
        : readGroupKeyLabel(pivotId, view, ctx, viewRow, rowMeta.depth, part.groupIndex);
    if (label === null) return null;
    key.push(label);
  }

  return {
    connectionId: ctx.connectionId,
    writebackId: editable.meta.id,
    key,
    columnName: editable.meta.name,
  };
}

// ============================================================================
// Value submission
// ============================================================================

/**
 * Normalize the typed editor value and submit it to the model.
 * Empty input clears the entry (value = null). Throws with the backend's
 * human-readable message on constraint violations.
 */
export async function submitWritebackValue(
  target: WritebackCellTarget,
  rawValue: string,
): Promise<void> {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith("=")) {
    throw new Error(
      `Formulas can't be entered in the writeback column "${target.columnName}" — type a plain value.`,
    );
  }
  let value: string | null = trimmed === "" ? null : trimmed;
  if (value !== null) {
    // The backend parses numbers invariantly; fold a locale decimal comma
    // ("1,5") into "1.5" so numeric input works under e.g. sv-SE.
    try {
      const locale = await getLocaleSettings();
      if (locale.decimalSeparator === "," && /^-?\d+,\d+$/.test(value)) {
        value = value.replace(",", ".");
      }
    } catch {
      // Locale lookup is best-effort; submit the raw value.
    }
  }
  await biWritebackSetValue(target.connectionId, target.writebackId, target.key, value);
}

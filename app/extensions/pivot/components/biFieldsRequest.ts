//! FILENAME: app/extensions/Pivot/components/biFieldsRequest.ts
// PURPOSE: The ONE mapping from the field-list editor's zones to an
//          `update_bi_pivot_fields` request, and the ONE rule for which item
//          filters (hidden items) that request carries. Every editor path that
//          sends the request goes through `buildBiUpdateRequest`: a zone edit,
//          the Update button of a deferred layout, and the LOOKUP toggle.
// CONTEXT: A field ref's hidden items are THREE-state on the wire
//          (`BiFieldRef` in @api/pivotTypes): ABSENT = keep what the pivot
//          hides now for that Table.Column, a list = exactly these, `[]` = the
//          filter was removed.
//
//          The zone chips carry a hidden-items list for DISPLAY -- the Pivot
//          Layout DSL renders it as `NOT IN (...)` -- seeded from the pivot
//          when the pane mounted. The header dropdown, a slicer, a ribbon
//          filter and the context menu all change a pivot's filters behind the
//          editor's back; the editor re-reads the definition after each view
//          change (`reconcileChipHiddenItems` below), but that read is async,
//          so a chip's list is never proof of what the pivot hides.
//          The editor used to echo every chip's list on every layout edit, and
//          the backend honours a sent list, so a filter the user had cleared
//          or changed elsewhere came silently back on the next unrelated edit
//          (review2 slicerbe finding 4). And it could not REMOVE one either: a
//          deleted NOT IN clause sent nothing, which means "keep" (finding 10).
//
//          So a real Table.Column field -- in any zone -- sends a list ONLY
//          when the user changed that field's item filter in THIS editor and
//          the backend has not acknowledged it yet (`HiddenItemEdits`, kept by
//          usePivotEditorState); `[]` when the edit removed the filter. Every
//          other field sends nothing, and the backend keeps what the pivot has.
//
//          A calculation-group chip is the exception: its item subset lives
//          ONLY on the chip (the backend reads it off the placement, and an
//          absent list there means every item), so it always sends the chip's.
//
//          A RANGE pivot's `update_pivot_fields` follows the same rule since
//          BUG-0184 (`rangeRequestWithHiddenItemEdits` below): it used to read
//          an absent list as CLEAR, so the editor had to echo every chip's list,
//          and the same stale-echo race applied.

import type {
  BiFieldRef,
  BiHierarchyFieldRef,
  BiValueFieldRef,
  CalculatedFieldDef,
  LayoutConfig,
  PivotFieldConfig,
  PivotId,
  UpdateBiPivotFieldsRequest,
  UpdatePivotFieldsRequest,
  ValueColumnRefDef,
} from './types';
import { CALC_GROUP_TABLE } from './types';
import { splitBiFieldKey } from '../../_shared/lib/biFieldKey';

/**
 * Item-filter edits made in the editor and not yet acknowledged by the
 * backend: zone field name ("Table.Column") -> the hidden items to send.
 * An empty list means the user REMOVED the field's filter.
 */
export type HiddenItemEdits = ReadonlyMap<string, readonly string[]>;

/** A zone field as the mappers read it (a ZoneField or a PivotFieldConfig). */
export interface BiZoneFieldLike {
  name: string;
  hiddenItems?: string[];
}

/** A value field as the mappers read it. */
export interface BiValueFieldLike {
  name: string;
  customName?: string;
}

/** What the editor knows besides the zones. */
export interface BiRequestContext {
  /** Names of the model's calculation groups (their chips carry the plain group name). */
  calcGroupNames: ReadonlySet<string>;
  /** The model's table names, for splitting "Table.Column" (a table name can contain dots). */
  biTableNames: readonly string[];
  /** Every column in LOOKUP mode ("Table.Column"), placed or not. */
  lookupColumns: ReadonlySet<string>;
  /** The item-filter edits this request carries. */
  hiddenItemEdits: HiddenItemEdits;
}

/** The zones (and the optional extras) one request is built from. */
export interface BiZoneSource {
  pivotId: PivotId;
  rowFields?: readonly BiZoneFieldLike[];
  columnFields?: readonly BiZoneFieldLike[];
  valueFields?: readonly BiValueFieldLike[];
  filterFields?: readonly BiZoneFieldLike[];
  layout?: LayoutConfig;
  calculatedFields?: CalculatedFieldDef[];
  valueColumnOrder?: ValueColumnRefDef[];
}

/** True when a field name is a placed hierarchy ("Table.__hierarchy__.Name"). */
export function isHierarchyField(name: string): boolean {
  return name.includes('.__hierarchy__.');
}

/** Parse a hierarchy field key "Table.__hierarchy__.Name" into a BiHierarchyFieldRef. */
export function toHierarchyFieldRef(name: string): BiHierarchyFieldRef {
  const parts = name.split('.__hierarchy__.');
  return { table: parts[0], hierarchy: parts[1], expanded: [] };
}

/** Parse a BI field key "Table.Column" into a BiFieldRef, optionally marking it
 *  as lookup. Table names can contain dots, so it resolves against the model's. */
export function toBiFieldRef(name: string, tableNames: readonly string[], isLookup?: boolean): BiFieldRef {
  const { table, column } = splitBiFieldKey(name, tableNames);
  return { table, column, isLookup };
}

/** Parse a BI measure field key "[MeasureName]" into a BiValueFieldRef. */
export function toBiValueFieldRef(name: string, customName?: string): BiValueFieldRef {
  const measureName = name.startsWith('[') && name.endsWith(']')
    ? name.substring(1, name.length - 1)
    : name;
  return { measureName, customName };
}

/**
 * One zone field as a request ref. A calculation-group chip becomes its pseudo
 * ref and carries the chip's own item subset. A real Table.Column field carries
 * hidden items ONLY when `ctx.hiddenItemEdits` names it -- otherwise the ref
 * has no `hiddenItems` key at all, which the backend reads as "keep".
 */
export function toBiZoneFieldRef(f: BiZoneFieldLike, ctx: BiRequestContext): BiFieldRef {
  if (ctx.calcGroupNames.has(f.name)) {
    return { table: CALC_GROUP_TABLE, column: f.name, hiddenItems: f.hiddenItems };
  }
  const ref = toBiFieldRef(f.name, ctx.biTableNames, ctx.lookupColumns.has(f.name));
  const edited = ctx.hiddenItemEdits.get(f.name);
  return edited === undefined ? ref : { ...ref, hiddenItems: [...edited] };
}

/** The `update_bi_pivot_fields` request for these zones. */
export function buildBiUpdateRequest(
  src: BiZoneSource,
  ctx: BiRequestContext,
): UpdateBiPivotFieldsRequest {
  const isCalcGroupField = (f: { name: string }) => ctx.calcGroupNames.has(f.name);
  const isRealBiField = (f: { name: string }) =>
    (f.name.includes('.') && !isHierarchyField(f.name)) || isCalcGroupField(f);
  const toRef = (f: BiZoneFieldLike) => toBiZoneFieldRef(f, ctx);

  const rowFields = src.rowFields ?? [];
  const columnFields = src.columnFields ?? [];
  const rowHierarchies = rowFields
    .filter((f) => isHierarchyField(f.name))
    .map((f) => toHierarchyFieldRef(f.name));
  const columnHierarchies = columnFields
    .filter((f) => isHierarchyField(f.name))
    .map((f) => toHierarchyFieldRef(f.name));

  return {
    pivotId: src.pivotId,
    rowFields: rowFields.filter(isRealBiField).map(toRef),
    columnFields: columnFields.filter(isRealBiField).map(toRef),
    valueFields: (src.valueFields ?? [])
      .filter((f) => !isCalcGroupField(f))
      .map((f) => toBiValueFieldRef(f.name, f.customName)),
    filterFields: (src.filterFields ?? []).filter(isRealBiField).map(toRef),
    rowHierarchies: rowHierarchies.length > 0 ? rowHierarchies : undefined,
    columnHierarchies: columnHierarchies.length > 0 ? columnHierarchies : undefined,
    layout: src.layout,
    lookupColumns: [...ctx.lookupColumns],
    calculatedFields: src.calculatedFields,
    valueColumnOrder: src.valueColumnOrder,
    // `slicerFields` is deliberately NOT sent: absent means KEEP the slicer
    // fields the pivot carries (canvas/model slicers, ribbon filters) with
    // their hidden items. Sending `[]` would drop every slicer filter on the
    // pivot with each layout edit.
  };
}

/**
 * The `update_pivot_fields` request a RANGE pivot's editor sends: the zones as
 * built, with a row, column or filter field carrying hidden items ONLY when
 * `edits` names it (the user changed its item filter in this editor; `[]` =
 * removed) -- the model pivot's rule. Every other field has NO `hiddenItems`
 * key, which the backend reads as "keep what the pivot hides now" (BUG-0184:
 * it used to read it as CLEAR, so every chip's display list was echoed, and a
 * filter changed elsewhere within one round trip came silently back).
 */
export function rangeRequestWithHiddenItemEdits(
  request: UpdatePivotFieldsRequest,
  edits: HiddenItemEdits,
): UpdatePivotFieldsRequest {
  const zone = (fields: PivotFieldConfig[] | undefined): PivotFieldConfig[] | undefined =>
    fields?.map((field) => {
      const sent: PivotFieldConfig = { ...field };
      delete sent.hiddenItems; // the chip's list is display, never an edit
      const edited = edits.get(field.name);
      return edited === undefined ? sent : { ...sent, hiddenItems: [...edited] };
    });
  return {
    ...request,
    rowFields: zone(request.rowFields),
    columnFields: zone(request.columnFields),
    filterFields: zone(request.filterFields),
  };
}

// ============================================================================
// Which item filters the user changed
// ============================================================================

/** Two hidden-item lists name the same items (order and repeats ignored). */
export function sameHiddenItems(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  const sa = new Set(a ?? []);
  const sb = new Set(b ?? []);
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

/**
 * Compare the zones a Pivot Layout DSL edit produced with the zones before it,
 * field by field (matched by name, in any zone: moving a field between zones
 * is not an item-filter edit -- the backend keys a filter by Table.Column):
 *
 * - the previous entry hid items and the new one hides none -> an edit to
 *   `[]`, and the field is STORED with `hiddenItems: []` (the clause was
 *   deleted; "none" would read as "keep" on the wire);
 * - the list changed -> an edit to the new list;
 * - unchanged -> no edit (the field keeps whatever the pivot has now);
 * - a field that was not placed before and arrives with a list -> an edit;
 * - a field named in `unresolved` -> NO edit, and the field keeps the previous
 *   entry's list. That is a filter the DSL could not turn into hidden items
 *   (an inclusion `Field = ("a")` whose full item list is not loaded, see
 *   dslCompile.ts): the compiler hands it back with no list, the same shape as
 *   a deleted clause, and reading it as one CLEARED the field's filter when
 *   the user had asked to narrow it (review3 finding 3).
 *
 * Pure. Returns the fields to store (same order) and the edits.
 */
export function diffHiddenItemEdits<T extends BiZoneFieldLike>(
  previous: readonly BiZoneFieldLike[],
  incoming: readonly T[],
  unresolved: ReadonlySet<string> = new Set(),
): { fields: T[]; edits: Map<string, string[]> } {
  const prevByName = new Map<string, BiZoneFieldLike>();
  for (const p of previous) {
    if (!prevByName.has(p.name)) prevByName.set(p.name, p);
  }
  const edits = new Map<string, string[]>();
  const fields = incoming.map((f) => {
    const next = f.hiddenItems ?? [];
    const prev = prevByName.get(f.name);
    if (unresolved.has(f.name)) {
      return prev ? { ...f, hiddenItems: prev.hiddenItems } : f;
    }
    if (!prev) {
      if (next.length > 0) edits.set(f.name, [...next]);
      return f;
    }
    if (sameHiddenItems(prev.hiddenItems, next)) return f;
    edits.set(f.name, [...next]);
    return next.length === 0 ? { ...f, hiddenItems: [] } : f;
  });
  return { fields, edits };
}

// ============================================================================
// Keeping the chips' display lists in step with the pivot
// ============================================================================

/** One placed field as the pivot's definition reports it (a `ZoneFieldInfo`). */
export interface PivotDefinitionField {
  sourceIndex: number;
  name: string;
  hiddenItems?: string[];
}

/** The pivot's row, column and filter fields as its definition holds them now
 *  (the zones of a `PivotFieldConfiguration`). */
export interface PivotHiddenItemsSnapshot {
  rowFields: readonly PivotDefinitionField[];
  columnFields: readonly PivotDefinitionField[];
  filterFields: readonly PivotDefinitionField[];
}

/**
 * Bring the chips' hidden items up to what the pivot's definition hides NOW.
 *
 * The chips' lists are seeded when the pane mounts, and the header dropdown,
 * the context menu, a slicer and a ribbon filter all change a pivot's filters
 * without going through the editor. A stale list is wrong twice over: the DSL
 * shows a `NOT IN` the pivot no longer has (and a cut/paste of that line sends
 * it back), and -- before BUG-0184, when `update_pivot_fields` read an absent
 * list as CLEAR and the editor had to echo every chip's -- a RANGE pivot's
 * request silently re-applied a filter cleared elsewhere (review3 finding 1,
 * the range half of review2 slicerbe finding 4).
 *
 * A range chip (sourceIndex >= 0) is matched by source index, a model or
 * calculation-group chip (-1) by name, a hierarchy chip never. A chip with a
 * PENDING edit (`pending`, keyed by name) is left alone: the user's edit is
 * newer than the definition. A field the definition hides nothing on gets `[]`.
 *
 * Pure. Returns `chips` itself when nothing changed.
 */
export function reconcileChipHiddenItems<T extends { sourceIndex: number; name: string; hiddenItems?: string[] }>(
  chips: T[],
  snapshot: PivotHiddenItemsSnapshot,
  pending: ReadonlyMap<string, unknown>,
): T[] {
  const defined = [...snapshot.rowFields, ...snapshot.columnFields, ...snapshot.filterFields];
  const find = (chip: T): PivotDefinitionField | undefined => {
    if (chip.sourceIndex >= 0) return defined.find((d) => d.sourceIndex === chip.sourceIndex);
    if (chip.sourceIndex === -1) return defined.find((d) => d.name === chip.name);
    return undefined;
  };
  let changed = false;
  const next = chips.map((chip) => {
    if (pending.has(chip.name)) return chip;
    const def = find(chip);
    if (!def || sameHiddenItems(chip.hiddenItems, def.hiddenItems)) return chip;
    changed = true;
    return { ...chip, hiddenItems: [...(def.hiddenItems ?? [])] };
  });
  return changed ? next : chips;
}

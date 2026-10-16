//! FILENAME: app/extensions/Charts/lib/designQueryWells.ts
// PURPOSE: The FIELD WELLS of a design-query chart (Power BI's "Build visual"
//          wells: Axis, Legend, Values, Filters; a Card's Fields; a KPI's
//          Indicator / Trend axis / Goal; a Gauge's Value / Target / Minimum /
//          Maximum) as a pure view over the chart's ONE stored fact, its
//          pivot-layout DSL text.
// CONTEXT: WP-C S9b (D-PANE: a design-query chart's Fields tab). The DSL is
//          the only spelling of the query (`spec.data.dslText`); the wells are
//          never stored. Reading: the DSL is compiled with the shared pipeline
//          (`processDsl`, a CompileContext over the connection's BI model) into
//          the four pivot zones, and the zones are distributed over the mark's
//          wells. Writing: the edited wells are folded back into the zones and
//          serialized with the shared `serialize` -- so a dotted BI table name
//          ("BI.dim_customer.fullname") is written unquoted by the serializer's
//          own rule, never by a second spelling here.
//
//          A WELL IS A VIEW, NOT A COPY. A zone the mark has no well for (a
//          Card whose query also has ROWS) is carried through every edit as it
//          was; VALUES entries that no single-slot well shows (a KPI's third
//          measure) ride along after the wells' own, in order.
//
//          NOTHING IS LOST SILENTLY. The zones cannot hold everything the DSL
//          can say (SORT, TOP N, CALC, an inclusion filter with no member list
//          to invert, an aliased measure the serializer cannot re-spell), so
//          the wells are offered for editing ONLY when serializing the
//          compiled zones gives back the same query (`sameDesignQuery`, the
//          canonical comparison). Otherwise they are shown read-only with the
//          reason, and the Design tab is where the query is edited.
//
//          GAUGE INDICES. The gauge painter reads its target / minimum /
//          maximum from series indices in `markOptions` (series 0 is always
//          the value). A wells edit writes VALUES as [Value, Target?, Minimum?,
//          Maximum?, ...others] and returns the three indices to be written in
//          the SAME commit, the target always explicitly (-1 = none): left
//          implicit, a lone Minimum at index 1 would be read as the target.

import { processDsl, serialize } from "../../_shared/dsl/pivotLayout";
import { sameDesignQuery } from "../../_shared/dsl/pivotLayout/canonical";
import type {
  BiPivotModelInfo,
  CalculatedFieldDef,
  DragField,
  DropZoneType,
  LayoutConfig,
  ZoneField,
} from "../../_shared/components/types";
import type { ChartMark, GaugeMarkOptions, MarkOptions } from "../types";

// ============================================================================
// Wells per mark
// ============================================================================

/** What a well holds: model columns (and hierarchies, calculation groups) or measures. */
export type WellAccepts = "dimension" | "measure";

/** One field well of a mark. */
export interface WellDef {
  /** Stable id (DOM: `data-well-id`). */
  id: string;
  /** What the reader sees ("Axis", "Legend", "Values", ...). */
  label: string;
  /** The pivot zone the well reads and writes. */
  zone: DropZoneType;
  /** Holds one field: a drop REPLACES its occupant (Power BI). */
  single: boolean;
  accepts: WellAccepts;
  /** For a single-slot value well: what it means in the painter. */
  role?: "value" | "target" | "min" | "max" | "indicator" | "goal" | "fields";
}

const FILTERS_WELL: WellDef = { id: "filters", label: "Filters", zone: "filters", single: false, accepts: "dimension" };

/** Marks whose category axis is a real X / Y axis ("Axis"); the rest say "Category". */
const AXIS_MARKS = new Set<string>([
  "bar", "horizontalBar", "line", "area", "scatter", "waterfall", "combo",
  "bubble", "histogram", "stock", "boxPlot", "pareto",
]);

/** The wells a mark offers, in display order. */
export function wellsForMark(mark: ChartMark): WellDef[] {
  switch (mark) {
    case "card":
      return [
        { id: "fields", label: "Fields", zone: "values", single: true, accepts: "measure", role: "fields" },
        FILTERS_WELL,
      ];
    case "multiRowCard":
      return [
        { id: "category", label: "Category", zone: "rows", single: false, accepts: "dimension" },
        { id: "fields", label: "Fields", zone: "values", single: false, accepts: "measure" },
        FILTERS_WELL,
      ];
    case "kpi":
      return [
        { id: "indicator", label: "Indicator", zone: "values", single: true, accepts: "measure", role: "indicator" },
        { id: "trendAxis", label: "Trend axis", zone: "rows", single: false, accepts: "dimension" },
        { id: "goal", label: "Goal", zone: "values", single: true, accepts: "measure", role: "goal" },
        FILTERS_WELL,
      ];
    case "gauge":
      return [
        { id: "value", label: "Value", zone: "values", single: true, accepts: "measure", role: "value" },
        { id: "target", label: "Target value", zone: "values", single: true, accepts: "measure", role: "target" },
        { id: "min", label: "Minimum value", zone: "values", single: true, accepts: "measure", role: "min" },
        { id: "max", label: "Maximum value", zone: "values", single: true, accepts: "measure", role: "max" },
        FILTERS_WELL,
      ];
    default:
      return [
        {
          id: AXIS_MARKS.has(mark) ? "axis" : "category",
          label: AXIS_MARKS.has(mark) ? "Axis" : "Category",
          zone: "rows",
          single: false,
          accepts: "dimension",
        },
        { id: "legend", label: "Legend", zone: "columns", single: false, accepts: "dimension" },
        { id: "values", label: "Values", zone: "values", single: false, accepts: "measure" },
        FILTERS_WELL,
      ];
  }
}

/** The drag-registry key of a chart well (`DropZone.dropKey`). Never a DropZoneType. */
export function chartWellKey(wellId: string): string {
  return `chart-well:${wellId}`;
}

/** The well id behind a `fromKey`, or null when the drag did not start in a chart well. */
export function wellIdOfKey(key: string | undefined): string | null {
  return key !== undefined && key.startsWith("chart-well:") ? key.slice("chart-well:".length) : null;
}

// ============================================================================
// Zones <-> wells
// ============================================================================

/** The compiled query as the pivot editor's zone state. */
export interface DesignQueryZones {
  rows: ZoneField[];
  columns: ZoneField[];
  values: ZoneField[];
  filters: ZoneField[];
  layout: LayoutConfig;
  calculatedFields: CalculatedFieldDef[];
}

/** What a well edit changes: the wells, and the VALUES no well shows. */
export interface WellsState {
  wells: Readonly<Record<string, readonly ZoneField[]>>;
  /** VALUES entries no single-slot well shows; written after the wells' own. */
  extraValues: readonly ZoneField[];
}

/** The wells of one chart, read from its DSL. */
export interface WellsModel extends WellsState {
  mark: ChartMark;
  defs: WellDef[];
  /** The full compiled zones (the base every write starts from). */
  zones: DesignQueryZones;
  /** Zones the query uses that the mark has no well for (kept as they are). */
  unshownZones: DropZoneType[];
  /** Whether a wells edit may rewrite the DSL (see the file header). */
  editable: boolean;
  /** Why not, as a sentence; null when editable. */
  reason: string | null;
}

export const WELLS_QUERY_HAS_ERRORS =
  "The query has errors, so its fields cannot be shown here. Fix it on the Design tab.";
export const WELLS_QUERY_NOT_REPRESENTABLE =
  "This query uses clauses the field wells cannot show (such as SORT, TOP, CALC, an alias or a filter's item list). Edit it on the Design tab.";

/** The gauge's series indices as the painter resolves them (types.ts GaugeMarkOptions). */
function gaugeIndices(opts: MarkOptions | undefined, count: number): { target: number; min: number; max: number } {
  const g = (opts ?? {}) as GaugeMarkOptions;
  const idx = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) ? v : -1);
  return {
    target: typeof g.targetSeriesIndex === "number" ? idx(g.targetSeriesIndex) : count >= 2 ? 1 : -1,
    min: idx(g.minSeriesIndex),
    max: idx(g.maxSeriesIndex),
  };
}

/** Distribute compiled zones over a mark's wells, pure. */
export function zonesToWells(
  mark: ChartMark,
  markOptions: MarkOptions | undefined,
  zones: DesignQueryZones,
): WellsState & { unshownZones: DropZoneType[] } {
  const defs = wellsForMark(mark);
  const wells: Record<string, ZoneField[]> = {};
  const shownZones = new Set<DropZoneType>();
  for (const def of defs) {
    if (def.zone === "values") continue;
    shownZones.add(def.zone);
    wells[def.id] = [...zones[def.zone]];
  }

  const valueDefs = defs.filter((d) => d.zone === "values");
  let extraValues: ZoneField[] = [];
  if (valueDefs.length > 0) shownZones.add("values");
  if (valueDefs.length === 1 && !valueDefs[0].single) {
    wells[valueDefs[0].id] = [...zones.values];
  } else if (valueDefs.length > 0) {
    // Single slots, positional; the gauge's slots follow its markOptions.
    const claimed = new Set<number>();
    const slotIndex = (def: WellDef, position: number): number => {
      if (mark !== "gauge") return position;
      const g = gaugeIndices(markOptions, zones.values.length);
      switch (def.role) {
        case "value": return 0;
        case "target": return g.target;
        case "min": return g.min;
        case "max": return g.max;
        default: return -1;
      }
    };
    valueDefs.forEach((def, position) => {
      const i = slotIndex(def, position);
      const ok = i >= 0 && i < zones.values.length && !claimed.has(i);
      wells[def.id] = ok ? [zones.values[i]] : [];
      if (ok) claimed.add(i);
    });
    extraValues = zones.values.filter((_, i) => !claimed.has(i));
  }

  const unshownZones = (["rows", "columns", "values", "filters"] as DropZoneType[]).filter(
    (z) => !shownZones.has(z) && zones[z].length > 0,
  );
  return { wells, extraValues, unshownZones };
}

/** The gauge indices a wells write sets (undefined = cleared). */
export type GaugeIndexPatch = Pick<GaugeMarkOptions, "targetSeriesIndex" | "minSeriesIndex" | "maxSeriesIndex">;

/** The result of folding wells back into zones. */
export type WellsWriteResult =
  | { ok: true; zones: DesignQueryZones; markOptions: GaugeIndexPatch | null }
  | { ok: false; error: string };

/** Fold edited wells back into the query's zones, pure. */
export function wellsToZones(model: Pick<WellsModel, "mark" | "zones">, state: WellsState): WellsWriteResult {
  const defs = wellsForMark(model.mark);
  const zones: DesignQueryZones = {
    ...model.zones,
    rows: [...model.zones.rows],
    columns: [...model.zones.columns],
    values: [...model.zones.values],
    filters: [...model.zones.filters],
  };
  const get = (id: string): ZoneField[] => [...(state.wells[id] ?? [])];

  for (const def of defs) {
    if (def.zone !== "values") zones[def.zone] = get(def.id);
  }

  const valueDefs = defs.filter((d) => d.zone === "values");
  let markOptions: GaugeIndexPatch | null = null;
  if (valueDefs.length === 1 && !valueDefs[0].single) {
    zones.values = get(valueDefs[0].id);
  } else if (valueDefs.length > 0) {
    // Positional slots: an empty FIRST slot under a filled later one would
    // shift the later field into the first meaning. Refuse it instead.
    const first = valueDefs[0];
    const filledLater = valueDefs.slice(1).find((d) => get(d.id).length > 0);
    if (get(first.id).length === 0 && filledLater) {
      return {
        ok: false,
        error: `Add a field to ${first.label} before ${filledLater.label}: the ${model.mark === "gauge" ? "gauge" : "visual"} reads ${first.label} first.`,
      };
    }
    const values: ZoneField[] = [];
    const at: Record<string, number> = {};
    for (const def of valueDefs) {
      const f = get(def.id)[0];
      if (f) {
        at[def.role ?? def.id] = values.length;
        values.push(f);
      }
    }
    values.push(...state.extraValues);
    zones.values = values;
    if (model.mark === "gauge") {
      markOptions = {
        targetSeriesIndex: at.target ?? -1,
        minSeriesIndex: at.min,
        maxSeriesIndex: at.max,
      };
    }
  }
  return { ok: true, zones, markOptions };
}

// ============================================================================
// DSL <-> wells
// ============================================================================

/** The query text of a set of zones (the shared serializer; BI names by its own quoting rule). */
export function serializeZones(zones: DesignQueryZones, biModel: BiPivotModelInfo | null): string {
  return serialize(zones.rows, zones.columns, zones.values, zones.filters, zones.layout, {
    biModel: biModel ?? undefined,
    calculatedFields: zones.calculatedFields.length > 0 ? zones.calculatedFields : undefined,
  });
}

/** Read a chart's wells from its DSL against the connection's model. */
export function readWells(
  dslText: string,
  biModel: BiPivotModelInfo,
  mark: ChartMark,
  markOptions: MarkOptions | undefined,
): WellsModel {
  const result = processDsl(dslText, { sourceFields: [], biModel });
  const zones: DesignQueryZones = {
    rows: result.rows,
    columns: result.columns,
    values: result.values,
    filters: result.filters,
    layout: result.layout,
    calculatedFields: result.calculatedFields,
  };
  const dist = zonesToWells(mark, markOptions, zones);
  const hasErrors = result.errors.some((e) => e.severity === "error");
  let reason: string | null = null;
  if (hasErrors) {
    reason = WELLS_QUERY_HAS_ERRORS;
  } else if (dslText.trim() !== "" && !sameDesignQuery(serializeZones(zones, biModel), dslText)) {
    reason = WELLS_QUERY_NOT_REPRESENTABLE;
  }
  return {
    mark,
    defs: wellsForMark(mark),
    zones,
    ...dist,
    editable: reason === null,
    reason,
  };
}

/** The DSL (and, for a gauge, the indices) a wells state writes. */
export type WellsDslResult =
  | { ok: true; dslText: string; markOptions: GaugeIndexPatch | null }
  | { ok: false; error: string };

/** Fold a wells state back into DSL text, pure. */
export function wellsToDsl(model: WellsModel, state: WellsState, biModel: BiPivotModelInfo): WellsDslResult {
  const folded = wellsToZones(model, state);
  if (!folded.ok) return folded;
  return { ok: true, dslText: serializeZones(folded.zones, biModel), markOptions: folded.markOptions };
}

// ============================================================================
// Edits (pure, on a WellsState)
// ============================================================================

/** "[Revenue]" -> true: the field list's spelling of a measure. */
export function isMeasureName(name: string): boolean {
  return name.startsWith("[") && name.endsWith("]");
}

function bare(name: string): string {
  return isMeasureName(name) ? name.slice(1, -1) : name;
}

/** A new zone field for a dragged / checked field, in the compiler's own convention. */
export function zoneFieldFor(name: string, isNumeric: boolean, biModel: BiPivotModelInfo | null): ZoneField {
  if (!isMeasureName(name)) return { sourceIndex: -1, name, isNumeric };
  const measure = biModel?.measures.find((m) => m.name.toLowerCase() === bare(name).toLowerCase());
  const bracket = `[${measure?.name ?? bare(name)}]`;
  return {
    sourceIndex: -1,
    name: bracket,
    isNumeric: true,
    ...(measure ? { aggregation: measure.aggregation } : {}),
    customName: bracket,
  };
}

/** An edit's outcome: the new state, or the sentence that refuses it. */
export type WellEditResult = { ok: true; state: WellsState } | { ok: false; error: string };

function sameField(a: ZoneField, b: ZoneField): boolean {
  return a.name.toLowerCase() === b.name.toLowerCase();
}

function cloneWells(state: WellsState): Record<string, ZoneField[]> {
  const out: Record<string, ZoneField[]> = {};
  for (const [k, v] of Object.entries(state.wells)) out[k] = [...v];
  return out;
}

function acceptsRefusal(def: WellDef, field: ZoneField): string | null {
  const measure = isMeasureName(field.name);
  if (def.accepts === "measure" && !measure) return `${def.label} takes a measure. Drag a measure from the Measures folder.`;
  if (def.accepts === "dimension" && measure) return `${def.label} takes a column, not a measure.`;
  return null;
}

/**
 * Drop a field on a well. From the field list it is ADDED; from another well
 * of this chart (`fromKey`) it MOVES. A column lives on one axis only, so it
 * leaves the other ROWS / COLUMNS wells; a measure already in a multi-value well
 * is not added twice; a single-slot well's occupant is replaced.
 */
export function dropOnWell(
  defs: readonly WellDef[],
  state: WellsState,
  wellId: string,
  drag: DragField,
  insertIndex: number | undefined,
  biModel: BiPivotModelInfo | null,
): WellEditResult {
  const def = defs.find((d) => d.id === wellId);
  if (!def) return { ok: false, error: `This chart has no ${wellId} well.` };
  const wells = cloneWells(state);
  const fromWell = wellIdOfKey(drag.fromKey);
  let field: ZoneField;
  if (fromWell !== null && drag.fromIndex !== undefined && wells[fromWell]?.[drag.fromIndex]) {
    field = wells[fromWell][drag.fromIndex];
  } else {
    field = zoneFieldFor(drag.name, drag.isNumeric, biModel);
  }
  const refusal = acceptsRefusal(def, field);
  if (refusal) return { ok: false, error: refusal };

  if (fromWell !== null && drag.fromIndex !== undefined && wells[fromWell]) {
    wells[fromWell].splice(drag.fromIndex, 1);
  }
  const target = wells[wellId] ?? [];
  if (def.zone === "rows" || def.zone === "columns") {
    // One axis per column; a FILTER on the same column may stay beside it.
    for (const d of defs) {
      if ((d.zone === "rows" || d.zone === "columns") && d.id !== wellId && wells[d.id]) {
        wells[d.id] = wells[d.id].filter((f) => !sameField(f, field));
      }
    }
  }
  if (def.single) {
    wells[wellId] = [field];
  } else {
    const existing = target.findIndex((f) => sameField(f, field));
    let at = insertIndex === undefined ? target.length : Math.max(0, Math.min(insertIndex, target.length));
    if (existing >= 0) {
      target.splice(existing, 1);
      if (existing < at) at -= 1;
    }
    target.splice(at, 0, field);
    wells[wellId] = target;
  }
  return { ok: true, state: { wells, extraValues: [...state.extraValues] } };
}

/** Remove the field at `index` of a well. */
export function removeFromWell(state: WellsState, wellId: string, index: number): WellsState {
  const wells = cloneWells(state);
  if (wells[wellId]) wells[wellId].splice(index, 1);
  return { wells, extraValues: [...state.extraValues] };
}

/**
 * Move a field within one well. `to` is an INSERTION index counted before the
 * field is taken out (the DropZone / pill-menu convention: "move down" is
 * `index + 2`).
 */
export function reorderWell(state: WellsState, wellId: string, from: number, to: number): WellsState {
  const wells = cloneWells(state);
  const list = wells[wellId];
  if (!list || from < 0 || from >= list.length) return { wells, extraValues: [...state.extraValues] };
  const [item] = list.splice(from, 1);
  const at = Math.max(0, Math.min(to > from ? to - 1 : to, list.length));
  list.splice(at, 0, item);
  return { wells, extraValues: [...state.extraValues] };
}

/** The first well of a mark that takes a dimension (where a checked column goes). */
function firstDimensionWell(defs: readonly WellDef[]): WellDef | null {
  return defs.find((d) => d.accepts === "dimension" && d.zone !== "filters") ?? defs.find((d) => d.accepts === "dimension") ?? null;
}

/**
 * The field list's checkbox on a COLUMN: checked adds it to the mark's first
 * dimension well, unchecked takes it out of every dimension well.
 */
export function toggleColumn(defs: readonly WellDef[], state: WellsState, key: string, isNumeric: boolean, checked: boolean): WellEditResult {
  if (!checked) {
    const wells = cloneWells(state);
    for (const d of defs) {
      if (d.accepts === "dimension" && wells[d.id]) {
        wells[d.id] = wells[d.id].filter((f) => f.name.toLowerCase() !== key.toLowerCase());
      }
    }
    return { ok: true, state: { wells, extraValues: [...state.extraValues] } };
  }
  const target = firstDimensionWell(defs);
  if (!target) return { ok: false, error: "This visual has no well for a column." };
  return dropOnWell(defs, state, target.id, { sourceIndex: -1, name: key, isNumeric }, undefined, null);
}

/**
 * The field list's checkbox on a MEASURE: checked adds it to the first value
 * well with room (a multi-value well, else the first EMPTY single slot);
 * unchecked takes it out of every value well and out of the unshown values.
 */
export function toggleMeasure(
  defs: readonly WellDef[],
  state: WellsState,
  measureName: string,
  checked: boolean,
  biModel: BiPivotModelInfo | null,
): WellEditResult {
  const name = `[${bare(measureName)}]`;
  if (!checked) {
    const wells = cloneWells(state);
    const keep = (f: ZoneField) => f.name.toLowerCase() !== name.toLowerCase();
    for (const d of defs) {
      if (d.accepts === "measure" && wells[d.id]) wells[d.id] = wells[d.id].filter(keep);
    }
    return { ok: true, state: { wells, extraValues: state.extraValues.filter(keep) } };
  }
  const target = defs.find((d) => d.accepts === "measure" && (!d.single || (state.wells[d.id] ?? []).length === 0));
  if (!target) {
    return { ok: false, error: "Every value well is full. Drop the measure on a well to replace its field." };
  }
  return dropOnWell(defs, state, target.id, { sourceIndex: -1, name, isNumeric: true }, undefined, biModel);
}

/** The "Table.Column" keys the query uses (any zone), for the field list's checkboxes. */
export function usedColumnsOf(model: WellsModel, state: WellsState): Set<string> {
  const out = new Set<string>();
  const add = (f: ZoneField) => {
    if (!isMeasureName(f.name)) out.add(f.name);
  };
  for (const def of model.defs) if (def.accepts === "dimension") (state.wells[def.id] ?? []).forEach(add);
  for (const z of model.unshownZones) if (z !== "values") model.zones[z].forEach(add);
  return out;
}

/** The bare measure names the query uses, for the field list's checkboxes. */
export function usedMeasuresOf(model: WellsModel, state: WellsState): Set<string> {
  const out = new Set<string>();
  const add = (f: ZoneField) => {
    if (isMeasureName(f.name)) out.add(bare(f.name));
  };
  for (const def of model.defs) if (def.accepts === "measure") (state.wells[def.id] ?? []).forEach(add);
  state.extraValues.forEach(add);
  return out;
}

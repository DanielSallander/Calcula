//! FILENAME: app/extensions/Pivot/lib/pivotFieldsRequest.ts
// PURPOSE: The ONE recipe that turns a pivot's zones into an `update_pivot_fields`
//          request and sends it -- used by the field-list editor
//          (usePivotEditorState / PivotEditor) AND by the value-cell context
//          menu's headless edits (valueFieldEdits.ts), so a menu edit sends back
//          exactly what the editor would.
// CONTEXT: Moved (behaviour-preserving) out of usePivotEditorState.buildUpdateRequest
//          and PivotEditor.handleUpdate's send branch (WP-A S10). One correction
//          rides with the move, BUG-0465: the calculated fields are merged into
//          the Values zone at their place in `definition.value_column_order`
//          (`mergeCalculatedIntoValues`), not appended. The editor used to
//          append them, and since every request rebuilds the order from the
//          zone's positions -- and `update_pivot_fields` REPLACES the order --
//          the first unrelated edit moved an interleaved calculated column to
//          the right end. A headless edit built the same way would have done it
//          on every Summarize / Show Values As / Remove from the menu.

import { pivot } from "@api/pivot";
import {
  getDefaultAggregation,
  getValueFieldDisplayName,
  type CalculatedFieldDef,
  type LayoutConfig,
  type PivotFieldConfig,
  type ShowValuesAs,
  type UpdateBiPivotFieldsRequest,
  type UpdatePivotFieldsRequest,
  type ValueColumnRefDef,
  type ValueFieldConfig,
  type ZoneField,
} from "../components/types";
import {
  buildBiUpdateRequest,
  rangeRequestWithHiddenItemEdits,
  type BiRequestContext,
  type HiddenItemEdits,
} from "../components/biFieldsRequest";
import { showAsRuleFor } from "./showAsRule";

/** The four zones one request is built from. Values may hold calculated fields (`isCalculated`). */
export interface PivotZones {
  rows: ZoneField[];
  columns: ZoneField[];
  values: ZoneField[];
  filters: ZoneField[];
}

/** What a model pivot's request needs besides the zones (the item-filter edits travel separately). */
export type PivotFieldsBiContext = Omit<BiRequestContext, "hiddenItemEdits">;

/** A calculated field as a Values-zone entry (the shape the editor's chips use). */
function calculatedZoneField(cf: CalculatedFieldDef): ZoneField {
  return {
    sourceIndex: -2, // Marker for calculated fields
    name: cf.name,
    isNumeric: true,
    isCalculated: true,
    customName: cf.name,
    calculatedFormula: cf.formula,
    ...(cf.numberFormat ? { numberFormat: cf.numberFormat } : {}),
  };
}

/**
 * ONE recipe for the Values zone a request is built from: the value fields
 * with the calculated fields merged in as `isCalculated` entries, placed by
 * `order` (definition.value_column_order, transported since WP-A S1) and
 * appended after the values when `order` is empty or absent (the engine's
 * default, and the editor's behaviour before the order was transported).
 *
 * An order entry that names no field (out of range) or repeats one is skipped;
 * a field the order does not name is appended after the ordered ones (values
 * first, then calculated fields), so no field is ever lost. Pure.
 */
export function mergeCalculatedIntoValues(
  values: readonly ZoneField[],
  calculated: readonly CalculatedFieldDef[] | undefined,
  order: readonly ValueColumnRefDef[] | undefined,
): ZoneField[] {
  const calcs = calculated ?? [];
  if (!order || order.length === 0) {
    return [...values, ...calcs.map(calculatedZoneField)];
  }
  const usedValues = new Set<number>();
  const usedCalcs = new Set<number>();
  const merged: ZoneField[] = [];
  for (const ref of order) {
    if (ref.type === "value") {
      if (ref.index < 0 || ref.index >= values.length || usedValues.has(ref.index)) continue;
      usedValues.add(ref.index);
      merged.push(values[ref.index]);
    } else {
      if (ref.index < 0 || ref.index >= calcs.length || usedCalcs.has(ref.index)) continue;
      usedCalcs.add(ref.index);
      merged.push(calculatedZoneField(calcs[ref.index]));
    }
  }
  values.forEach((v, i) => {
    if (!usedValues.has(i)) merged.push(v);
  });
  calcs.forEach((cf, i) => {
    if (!usedCalcs.has(i)) merged.push(calculatedZoneField(cf));
  });
  return merged;
}

/**
 * The name a Values-zone value field is SENT under -- the name the pivot's
 * column shows and a calculated field's formula names it by. A model field
 * keeps its `[Measure]` in `name` (toBiValueFieldRef extracts the measure from
 * it; the custom display name travels in `customName`); a range field is its
 * custom name, else Excel's default "<Aggregation> of <field>", so changing
 * the aggregation of an un-renamed field RENAMES it ("Sum of Units" becomes
 * "Max of Units").
 */
export function valueFieldRequestName(f: ZoneField): string {
  if (f.sourceIndex === -1) return f.name;
  return f.customName || getValueFieldDisplayName(f.name, f.aggregation ?? getDefaultAggregation(f.isNumeric));
}

/** A character a bare calculated-field reference may hold (calculated.rs Tokenizer: alphanumeric, `_`, `.`). */
function isBareRefChar(c: string): boolean {
  return /[\p{L}\p{N}_.]/u.test(c);
}

/** `name` spelled so the calculated-field tokenizer reads it back as ONE reference, in the style `style` was written. */
function spellReference(name: string, style: "bare" | "quoted" | "bracket"): string | null {
  const bareOk = /^[\p{L}\p{N}_][\p{L}\p{N}_.]*( [\p{L}\p{N}_][\p{L}\p{N}_.]*)*$/u.test(name);
  if (style === "bare" && bareOk) return name;
  if (style === "bracket" && !name.includes("]")) return `[${name}]`;
  if (!name.includes("'")) return `'${name}'`;
  if (!name.includes("]")) return `[${name}]`;
  return null;
}

/**
 * Rewrite every reference to the field `oldName` in a calculated-field
 * `formula` so it names `newName`, keeping how each was written ('quoted',
 * [bracketed] or bare). Matching follows the engine's own rule: case-insensitive,
 * a surrounding `[...]` ignored (calculated.rs `ref_names_match`). The scan is
 * the engine tokenizer's: "string literals" are skipped, and a bare word
 * followed by `(` is a function, never a field. Returns `formula` unchanged
 * when nothing names `oldName`, or when `newName` cannot be spelled as one
 * reference (it holds both `'` and `]`).
 */
export function renameCalculatedReferences(formula: string, oldName: string, newName: string): string {
  const norm = (s: string) => {
    const t = s.trim();
    return (t.length >= 2 && t.startsWith("[") && t.endsWith("]") ? t.slice(1, -1) : t).toLowerCase();
  };
  const target = norm(oldName);
  if (!target || norm(newName) === target) return formula;
  const chars = Array.from(formula);
  let out = "";
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '"') {
      // A string literal; "" inside is an escaped quote.
      let j = i + 1;
      while (j < chars.length) {
        if (chars[j] === '"') {
          if (chars[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += chars.slice(i, j + 1).join("");
      i = j + 1;
      continue;
    }
    if (c === "'" || c === "[") {
      const close = c === "'" ? "'" : "]";
      let j = i + 1;
      while (j < chars.length && chars[j] !== close) j++;
      const name = chars.slice(i + 1, j).join("");
      const original = chars.slice(i, j + 1).join("");
      const spelled = norm(name) === target ? spellReference(newName, c === "'" ? "quoted" : "bracket") : null;
      out += spelled ?? original;
      i = j + 1;
      continue;
    }
    if (isBareRefChar(c) && !/[0-9.]/.test(c)) {
      // A bare word; a space joins the next word when that one starts with a
      // letter, digit or `_` ("Sum of Units"), as the engine tokenizer does.
      let j = i;
      let name = "";
      while (j < chars.length) {
        const ch = chars[j];
        if (isBareRefChar(ch)) {
          name += ch;
          j++;
        } else if (ch === " ") {
          let k = j + 1;
          while (k < chars.length && chars[k] === " ") k++;
          if (k < chars.length && /[\p{L}\p{N}_]/u.test(chars[k])) {
            name += ch;
            j++;
          } else {
            break;
          }
        } else {
          break;
        }
      }
      const trimmed = name.replace(/ +$/, "");
      const end = i + Array.from(trimmed).length;
      let k = end;
      while (k < chars.length && chars[k] === " ") k++;
      const isFunction = chars[k] === "(";
      const spelled = !isFunction && norm(trimmed) === target ? spellReference(newName, "bare") : null;
      out += spelled ?? trimmed;
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Replace the Values-zone entry at `index` with `next` and carry a RENAME into
 * the calculated fields: when the name the field is sent under changes (an
 * aggregation change renames "Sum of Units" to "Max of Units"; a new custom
 * name), every calculated field whose formula named the old name names the new
 * one. Without it the calculated column went blank, silently, after Summarize
 * Values By (e2e canvas-pick-cells J13). A name another value field still
 * carries is not renamed (the reference still resolves to that one). Pure.
 */
export function replaceValueField(values: readonly ZoneField[], index: number, next: ZoneField): ZoneField[] {
  const out = values.map((f, i) => (i === index ? next : f));
  const prev = values[index];
  if (!prev || prev.isCalculated || next.isCalculated) return out;
  const oldName = valueFieldRequestName(prev);
  const newName = valueFieldRequestName(next);
  if (oldName === newName) return out;
  const lower = oldName.toLowerCase();
  const stillNamed = out.some((f, i) => i !== index && !f.isCalculated && valueFieldRequestName(f).toLowerCase() === lower);
  if (stillNamed) return out;
  return out.map((f) => {
    if (!f.isCalculated || !f.calculatedFormula) return f;
    const formula = renameCalculatedReferences(f.calculatedFormula, oldName, newName);
    return formula === f.calculatedFormula ? f : { ...f, calculatedFormula: formula };
  });
}

/**
 * The `update_pivot_fields` request for `zones` (moved verbatim from the
 * editor hook). The Values zone may interleave regular value fields and
 * calculated fields (`isCalculated`): they are separated here and the unified
 * column order is built from their positions. `layout` is sent when given (the
 * editor always sends its own); a headless edit sends none, and the backend
 * then keeps the pivot's layout.
 *
 * Returns the request plus the calculated fields and the order it carries
 * (undefined when empty), which the editor keeps for its Design-tab serializer.
 */
export function buildPivotFieldsRequest(
  pivotId: string,
  zones: PivotZones,
  layout?: LayoutConfig,
): { request: UpdatePivotFieldsRequest; calculatedFields?: CalculatedFieldDef[]; valueColumnOrder?: ValueColumnRefDef[] } {
  // Row/column fields carry hiddenItems too (a placed calculation group's
  // item subset rides on its chip like a field filter). These are the
  // chips' DISPLAY lists: the sender passes a real field's list only when
  // it was edited -- a model pivot through `buildBiUpdateRequest`, a RANGE
  // pivot through `rangeRequestWithHiddenItemEdits` (biFieldsRequest.ts;
  // `update_pivot_fields` keeps an unsent list since BUG-0184).
  const rowFields: PivotFieldConfig[] = zones.rows.map((f) => ({
    sourceIndex: f.sourceIndex,
    name: f.name,
    hiddenItems: f.hiddenItems,
  }));

  const columnFields: PivotFieldConfig[] = zones.columns.map((f) => ({
    sourceIndex: f.sourceIndex,
    name: f.name,
    hiddenItems: f.hiddenItems,
  }));

  // Separate regular values from calculated fields and build ordering
  const regularValues: ValueFieldConfig[] = [];
  const calcFields: CalculatedFieldDef[] = [];
  const columnOrder: ValueColumnRefDef[] = [];

  for (const f of zones.values) {
    if (f.isCalculated) {
      const calcIdx = calcFields.length;
      calcFields.push({
        name: f.customName || f.name,
        formula: f.calculatedFormula || "",
        numberFormat: f.numberFormat,
      });
      columnOrder.push({ type: "calculated", index: calcIdx });
    } else {
      const valIdx = regularValues.length;
      const aggregation = f.aggregation ?? getDefaultAggregation(f.isNumeric);
      const displayName = valueFieldRequestName(f);
      // A calculation relative to a BASE (Running Total In, Difference
      // From, % Of, ...) travels as the `showAs` rule: the plain string has
      // no room for the base, and without one the backend left every value
      // as it was (e2e fixall-pivot X1).
      const showAs = showAsRuleFor(f.showValuesAs, f.baseField, f.baseItem);
      regularValues.push({
        sourceIndex: f.sourceIndex,
        name: displayName,
        aggregation,
        // The OVERRIDE only: a format ADOPTED from the model is not sent back,
        // or the next edit would freeze it into an override (BUG-0478).
        numberFormat: f.numberFormatFromModel ? undefined : f.numberFormat,
        showValuesAs: f.showValuesAs as ShowValuesAs | undefined,
        ...(showAs ? { showAs } : {}),
        customName: f.customName || undefined,
      });
      columnOrder.push({ type: "value", index: valIdx });
    }
  }

  // Build filter fields with hidden items
  const filterFields: PivotFieldConfig[] = zones.filters.map((f) => ({
    sourceIndex: f.sourceIndex,
    name: f.name,
    hiddenItems: f.hiddenItems,
  }));

  const calculatedFields = calcFields.length > 0 ? calcFields : undefined;
  const valueColumnOrder = columnOrder.length > 0 ? columnOrder : undefined;
  return {
    request: {
      pivotId,
      rowFields,
      columnFields,
      valueFields: regularValues,
      filterFields,
      layout,
      calculatedFields,
      valueColumnOrder,
    },
    calculatedFields,
    valueColumnOrder,
  };
}

/**
 * Send a fields request (moved from PivotEditor.handleUpdate's send branch):
 * a model pivot (`bi` given) through `buildBiUpdateRequest` +
 * `update_bi_pivot_fields`, a range pivot through
 * `rangeRequestWithHiddenItemEdits` + `update_pivot_fields`. A real field's
 * item filter travels ONLY when `hiddenItemEdits` names it (biFieldsRequest.ts).
 * Rejects with the backend's error; the caller decides what to tell the user.
 */
export async function sendPivotFieldsUpdate(
  request: UpdatePivotFieldsRequest,
  hiddenItemEdits: HiddenItemEdits,
  bi: PivotFieldsBiContext | null,
): Promise<void> {
  if (bi) {
    const biRequest: UpdateBiPivotFieldsRequest = buildBiUpdateRequest(request, { ...bi, hiddenItemEdits });
    console.log(`[CALP-DIAG] PivotEditor.handleUpdate: BI pivot, pivotId=${request.pivotId}`);
    console.log(`[CALP-DIAG]   request rows=${request.rowFields?.length}, cols=${request.columnFields?.length}, vals=${request.valueFields?.length}`);
    console.log(`[CALP-DIAG]   biRequest: rows=${biRequest.rowFields.length} [${biRequest.rowFields.map((f) => `${f.table}.${f.column}`).join(", ")}]`);
    console.log(`[CALP-DIAG]   biRequest: vals=${biRequest.valueFields.length} [${biRequest.valueFields.map((f) => f.measureName).join(", ")}]`);
    await pivot.updateBiFields(biRequest);
    return;
  }
  // A range pivot sends a field's item filter only when it was edited
  // there, the same rule (BUG-0184: an absent list now keeps).
  await pivot.updateFields(rangeRequestWithHiddenItemEdits(request, hiddenItemEdits));
}

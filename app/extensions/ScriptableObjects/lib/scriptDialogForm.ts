//! FILENAME: app/extensions/ScriptableObjects/lib/scriptDialogForm.ts
// PURPOSE: Pure form-state helpers for the trusted script dialog (ui.dialog).
// CONTEXT: The React component owns rendering; everything that decides what a
//          field STARTS as, whether an answer is acceptable, and what shape the
//          script finally receives lives here, where it is testable without a
//          DOM. The broker's vDialogForm already guaranteed the spec's shape —
//          these helpers only deal with what the USER typed into it.

import type { ScriptDialogField, ScriptDialogFormSpec } from "@api";
import { normalizeDialogOption } from "@api";

/** In-progress editor state: every control holds a string except checkboxes. */
export type ScriptDialogFormValues = Record<string, string | boolean>;

/** The initial value for one field: its `default`, else an empty control. */
export function initialFieldValue(field: ScriptDialogField): string | boolean {
  if (field.type === "checkbox") {
    return field.default === true;
  }
  if (field.default !== undefined) {
    return String(field.default);
  }
  // A select with no default lands on its first option rather than on a blank
  // entry the spec never declared — a dropdown that starts empty reads as a
  // missing choice even when the script offered a perfectly good one.
  if (field.type === "select" && field.options && field.options.length > 0) {
    return normalizeDialogOption(field.options[0]).value;
  }
  return "";
}

/** Seed the whole form. */
export function initialFormValues(spec: ScriptDialogFormSpec): ScriptDialogFormValues {
  const values: ScriptDialogFormValues = {};
  for (const field of spec.fields) {
    values[field.name] = initialFieldValue(field);
  }
  return values;
}

/**
 * Validate one answer. Returns null when acceptable, else the message shown
 * under the control. Bounds come from the field spec; the script never sees a
 * value that violates its own declaration.
 */
export function validateFieldValue(
  field: ScriptDialogField,
  value: string | boolean,
): string | null {
  if (field.type === "checkbox") {
    // "required" on a checkbox is the "I agree" pattern: it must be ticked.
    return field.required && value !== true ? "This must be checked" : null;
  }
  const text = typeof value === "string" ? value : "";
  const empty = text.trim().length === 0;
  if (empty) {
    return field.required ? "This is required" : null;
  }
  if (field.type === "number") {
    const n = Number(text);
    if (!Number.isFinite(n)) return "Enter a number";
    if (field.min !== undefined && n < field.min) return `Must be at least ${field.min}`;
    if (field.max !== undefined && n > field.max) return `Must be at most ${field.max}`;
  }
  if (field.type === "select") {
    const allowed = (field.options ?? []).map((o) => normalizeDialogOption(o).value);
    if (!allowed.includes(text)) return "Choose one of the listed options";
  }
  if (field.maxLength !== undefined && text.length > field.maxLength) {
    return `Must be ${field.maxLength} characters or fewer`;
  }
  return null;
}

/** Every field's error, keyed by name (absent = acceptable). */
export function validateFormValues(
  spec: ScriptDialogFormSpec,
  values: ScriptDialogFormValues,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of spec.fields) {
    const error = validateFieldValue(field, values[field.name] ?? "");
    if (error !== null) errors[field.name] = error;
  }
  return errors;
}

/**
 * The object the script receives. Types follow the FIELD's declared type, not
 * the DOM's: a number field yields a number, a checkbox a boolean, everything
 * else a string. An optional field left blank yields null — distinguishable
 * from "" (which is what an explicitly cleared text field gives), so a script
 * can tell "not answered" from "answered with nothing".
 */
export function buildFormResult(
  spec: ScriptDialogFormSpec,
  values: ScriptDialogFormValues,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of spec.fields) {
    const raw = values[field.name];
    if (field.type === "checkbox") {
      result[field.name] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw : "";
    if (text.trim().length === 0 && !field.required) {
      result[field.name] = null;
      continue;
    }
    result[field.name] = field.type === "number" ? Number(text) : text;
  }
  return result;
}

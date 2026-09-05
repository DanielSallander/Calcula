//! FILENAME: app/extensions/ScriptableObjects/components/formDesigner/propertyFields.ts
// PURPOSE: What the property panel offers for the selected widget — one row per
//          key the spec allows that widget to carry, with the editor that key's
//          value type deserves.
// CONTEXT: M5b of docs/design/typescript-forms.md §14.
//
//          DRIVEN BY THE SPEC'S OWN KEY TABLE. `FORM_WIDGET_KEYS`
//          (@api/scriptHost/scriptFormSpec) is the allowlist the validator
//          refuses unknown keys against; this module reads THAT, so the panel
//          can never offer a key `checkFormSpec` would reject, and a key added
//          to the spec cannot be silently unreachable in the designer. The
//          guard is a test, not a habit: `editorFor` answers `null` for a key it
//          has no editor for, and the designer's test asserts that never
//          happens for any type.
//
//          STRUCTURAL KEYS ARE NOT PROPERTIES. `children`, `pages`, a table's
//          `rows` and `type` itself are edited on the canvas — a textarea of
//          JSON in a property panel is a second, worse editor for the thing the
//          designer exists to replace. They are declared here as `structural`
//          rather than omitted, so the table above stays exhaustive.

import {
  FORM_SPEC_KEYS,
  FORM_WIDGET_KEYS,
  MAX_DIALOG_MESSAGE,
  MAX_FORM_GRID_COLUMNS,
  MAX_FORM_WIDTH,
  MIN_FORM_WIDTH,
  type FormWidgetType,
} from "@api/scriptHost/scriptFormSpec";

/** How one key is edited. */
export type PropertyEditor =
  | { kind: "text"; multiline?: boolean; placeholder?: string }
  | { kind: "number"; min?: number; max?: number; integer?: boolean }
  | { kind: "boolean" }
  | { kind: "choice"; values: readonly string[] }
  /** A list of plain strings (choices, table headings). */
  | { kind: "stringList"; itemLabel: string }
  /** `number | "fill"`. */
  | { kind: "widthOrFill" }
  /** Edited on the canvas, never here. */
  | { kind: "structural" };

export interface PropertyField {
  key: string;
  label: string;
  editor: PropertyEditor;
  help?: string;
}

/** Listbox visible-row ceiling, mirrored from the validator's own bound. */
const MAX_LISTBOX_ROWS = 50;
const MAX_GAP = 64;
const MAX_SPACER = 400;
const MAX_IMAGE_HEIGHT = 2_000;
const MAX_TABLE_MAX_ROWS = 500;

const HUMAN_LABELS: Readonly<Record<string, string>> = {
  allowEmpty: "Allow empty",
  bind: "Bound to",
  cancelLabel: "Cancel button",
  maxLength: "Max length",
  maxRows: "Max rows",
  submitLabel: "Submit button",
  submitOnEnter: "Enter submits",
  writeOn: "Write cell on",
};

/** "maxLength" -> "Max length"; the table above wins where it has an entry. */
export function labelForKey(key: string): string {
  const known = HUMAN_LABELS[key];
  if (known) return known;
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The editor for one key on one widget type, or null when this module has
 * none — which the designer's test treats as a defect, never as "skip it".
 */
export function editorFor(type: FormWidgetType, key: string): PropertyEditor | null {
  switch (key) {
    case "type":
    case "children":
    case "pages":
      return { kind: "structural" };
    case "name":
      return { kind: "text", placeholder: "identifier" };
    case "label":
    case "title":
    case "placeholder":
    case "alt":
      return { kind: "text" };
    case "help":
      return { kind: "text", multiline: true };
    case "text":
      // A label's text is a paragraph; a button's is a caption.
      return { kind: "text", multiline: type === "label" };
    case "style":
      return { kind: "choice", values: ["normal", "heading", "muted"] };
    case "role":
      return { kind: "choice", values: ["default", "submit", "cancel"] };
    case "layout":
      return { kind: "choice", values: ["row", "column"] };
    case "writeOn":
      return { kind: "choice", values: ["submit", "change"] };
    case "hidden":
    case "disabled":
    case "required":
    case "danger":
    case "multi":
    case "multiline":
    case "allowEmpty":
      return { kind: "boolean" };
    case "bind":
      return { kind: "text", placeholder: 'B2, Sheet1!B2, or a defined name' };
    case "src":
      // A `media:{sha256}` handle of a picture already in this workbook, or "".
      // The designer never accepts a path, a URL or bytes — the same rule the
      // validator enforces (BUG-0086).
      return { kind: "text", placeholder: 'media:… (a picture already in this workbook), or empty' };
    case "options":
      return { kind: "stringList", itemLabel: "Option" };
    case "columns":
      return type === "table"
        ? { kind: "stringList", itemLabel: "Heading" }
        : { kind: "number", min: 1, max: MAX_FORM_GRID_COLUMNS, integer: true };
    case "rows":
      // A listbox's `rows` is how tall it is; a table's is its DATA.
      return type === "listbox"
        ? { kind: "number", min: 1, max: MAX_LISTBOX_ROWS, integer: true }
        : { kind: "structural" };
    case "default":
      if (type === "checkbox" || type === "toggle") return { kind: "boolean" };
      if (type === "number") return { kind: "number" };
      return { kind: "text" };
    case "min":
      // Only `number` and `date` carry a `min`, so the split is the whole story.
      return type === "number"
        ? { kind: "number" }
        : { kind: "text", placeholder: "YYYY-MM-DD" };
    case "max":
      // `max` is carried by a THIRD type: a progress bar's ceiling is a number too, and
      // routing it to the date box put the key out of reach — the row wrote
      // "100" and the validator refused it with "must be a number greater than
      // 0", while an existing numeric `max` was greyed out as something this
      // panel cannot edit. The bound is STRICT, and this editor's `min` is
      // inclusive, so the floor is the smallest positive number there is.
      if (type === "number") return { kind: "number" };
      if (type === "progress") return { kind: "number", min: Number.MIN_VALUE };
      return { kind: "text", placeholder: "YYYY-MM-DD" };
    case "step":
      return { kind: "number" };
    case "value":
      return { kind: "number" };
    case "maxLength":
      return { kind: "number", min: 1, max: MAX_DIALOG_MESSAGE, integer: true };
    case "maxRows":
      return { kind: "number", min: 1, max: MAX_TABLE_MAX_ROWS, integer: true };
    case "size":
      return { kind: "number", min: 0, max: MAX_SPACER, integer: true };
    case "gap":
      return { kind: "number", min: 0, max: MAX_GAP, integer: true };
    case "height":
      return { kind: "number", min: 1, max: MAX_IMAGE_HEIGHT, integer: true };
    case "width":
      return { kind: "widthOrFill" };
    default:
      return null;
  }
}

/** Every key the selected widget may carry, with its editor. */
export function fieldsForType(type: FormWidgetType): PropertyField[] {
  const out: PropertyField[] = [];
  for (const key of FORM_WIDGET_KEYS[type]) {
    const editor = editorFor(type, key);
    if (!editor) continue;
    out.push({ key, label: labelForKey(key), editor });
  }
  return out;
}

/** The editor for one FORM-level key, or null. `children` is the canvas. */
export function specEditorFor(key: string): PropertyEditor | null {
  switch (key) {
    case "children":
      return { kind: "structural" };
    case "title":
    case "submitLabel":
    case "cancelLabel":
    case "focus":
      return { kind: "text" };
    case "description":
      return { kind: "text", multiline: true };
    case "width":
      return { kind: "number", min: MIN_FORM_WIDTH, max: MAX_FORM_WIDTH, integer: true };
    case "writeOn":
      return { kind: "choice", values: ["submit", "change"] };
    case "submitOnEnter":
      return { kind: "boolean" };
    default:
      return null;
  }
}

/** Every form-level key, with its editor. */
export function specFields(): PropertyField[] {
  const out: PropertyField[] = [];
  for (const key of FORM_SPEC_KEYS) {
    const editor = specEditorFor(key);
    if (!editor) continue;
    out.push({ key, label: labelForKey(key), editor });
  }
  return out;
}

/**
 * Whether the value currently in the script is one this editor can round-trip.
 *
 * A `bind` written as `{ cell: "B2", sheet: "Sheet1" }` is perfectly legal and
 * the designer must NOT flatten it to a string just because its editor is a
 * text box — that would silently change what the form reads. Such a row is
 * shown, disabled, saying so; the code editor is where it is changed.
 */
export function editorFits(editor: PropertyEditor, value: unknown): boolean {
  if (value === undefined) return true;
  switch (editor.kind) {
    case "text":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "choice":
      return typeof value === "string" && editor.values.includes(value);
    case "stringList":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string");
    case "widthOrFill":
      return typeof value === "number" || value === "fill";
    case "structural":
      return true;
  }
}

//! FILENAME: app/src/api/formDesigner/formEmit.ts
// PURPOSE: Print a FormSpec back out as the JavaScript object literal that goes
//          inside the designer-owned `#region` — deterministically, in the
//          file's own line ending and indentation.
// CONTEXT: M5a of docs/design/typescript-forms.md §14. This is the half of ONE
//          ARTIFACT that writes: there is no stored layout to print from, only
//          the spec the designer holds, and what comes out of here IS the
//          layout from the next read onwards.
//
//          WHY A CANONICAL KEY ORDER. The designer holds a plain object, and
//          its key order is whatever order the designer's own code happened to
//          assign in — so printing `Object.keys` order would make the diff of
//          "moved one widget" also reshuffle unrelated lines. The orders below
//          are a PRESENTATION choice and nothing else: what a spec may contain
//          is decided by `checkFormSpec` (scriptHost/validators.ts) and this
//          file never restates it. A key the orders do not mention still gets
//          printed, after the ones they do.
//
//          WHY A LINE BUDGET. A widget reads best on one line — that is how the
//          scaffold writes them — but a widget with a long options list does
//          not. So a value is printed compactly when it fits in the budget from
//          its own indentation, and expanded when it does not. The decision is
//          a pure function of the value, so the same spec always prints the
//          same bytes.

/** Characters a printed line may reach before the value is expanded. */
const LINE_BUDGET = 100;

/** Spec-level keys, in the order `FormSpec` declares them. `children` last. */
const SPEC_KEY_ORDER: readonly string[] = [
  "title",
  "description",
  "submitLabel",
  "cancelLabel",
  "width",
  "writeOn",
  "submitOnEnter",
  "focus",
  "children",
];

/** Widget keys: what it IS, then what it says, then how it behaves, then what it contains. */
const WIDGET_KEY_ORDER: readonly string[] = [
  "type",
  "name",
  "label",
  "title",
  "text",
  "style",
  "role",
  "danger",
  "placeholder",
  "help",
  "default",
  "bind",
  "required",
  "writeOn",
  "options",
  "layout",
  "allowEmpty",
  "multi",
  "multiline",
  "maxLength",
  "min",
  "max",
  "step",
  "value",
  "columns",
  "rows",
  "maxRows",
  "src",
  "alt",
  "height",
  "size",
  "gap",
  "hidden",
  "disabled",
  "width",
  "pages",
  "children",
];

/** A tabs page is only ever `{ title, children }`. */
const PAGE_KEY_ORDER: readonly string[] = ["title", "children"];

/** Everything else (a `{ range }`, a `{ value, label }`) keeps the author's order. */
const NO_KEY_ORDER: readonly string[] = [];

/** A key that can be written bare rather than quoted. */
const BARE_KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface FormEmitOptions {
  /** The file's line ending. */
  eol: string;
  /** One level of indentation, as the literal string it costs. */
  indentUnit: string;
  /** Indentation the emitted statement itself sits at. */
  baseIndent: string;
}

/** A value the emitter cannot turn into source. Caught by the writer. */
export class FormEmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormEmitError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitKey(key: string): string {
  return BARE_KEY_RE.test(key) ? key : JSON.stringify(key);
}

function emitScalar(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new FormEmitError(`the layout holds the number ${String(value)}, which cannot be written into a script`);
      }
      // -0 prints as "0"; nothing in a form spec distinguishes the two.
      return JSON.stringify(value);
    default:
      throw new FormEmitError(
        `the layout holds a ${typeof value} value, which cannot be written into a script`,
      );
  }
}

/** Which order this key's CONTENTS should be printed in. */
function orderForChild(key: string): readonly string[] {
  if (key === "children") return WIDGET_KEY_ORDER;
  if (key === "pages") return PAGE_KEY_ORDER;
  return NO_KEY_ORDER;
}

function orderedKeys(object: Record<string, unknown>, order: readonly string[]): string[] {
  const present = Object.keys(object).filter((key) => object[key] !== undefined);
  const ranked = present
    .filter((key) => order.includes(key))
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const rest = present.filter((key) => !order.includes(key));
  return [...ranked, ...rest];
}

/** The one-line form of a value. Always produced; the caller decides if it fits. */
function emitCompact(value: unknown, order: readonly string[]): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => emitCompact(entry, order)).join(", ")}]`;
  }
  if (isPlainObject(value)) {
    const keys = orderedKeys(value, order);
    if (keys.length === 0) return "{}";
    const body = keys
      .map((key) => `${emitKey(key)}: ${emitCompact(value[key], orderForChild(key))}`)
      .join(", ");
    return `{ ${body} }`;
  }
  return emitScalar(value);
}

function emitValue(
  value: unknown,
  indent: string,
  order: readonly string[],
  options: FormEmitOptions,
  forceExpand = false,
): string {
  if (!forceExpand) {
    const compact = emitCompact(value, order);
    if (indent.length + compact.length <= LINE_BUDGET) return compact;
  }
  const inner = indent + options.indentUnit;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const parts = value.map((entry) => `${inner}${emitValue(entry, inner, order, options)},`);
    return `[${options.eol}${parts.join(options.eol)}${options.eol}${indent}]`;
  }
  if (isPlainObject(value)) {
    const keys = orderedKeys(value, order);
    if (keys.length === 0) return "{}";
    const parts = keys.map(
      (key) =>
        `${inner}${emitKey(key)}: ${emitValue(value[key], inner, orderForChild(key), options)},`,
    );
    return `{${options.eol}${parts.join(options.eol)}${options.eol}${indent}}`;
  }
  return emitScalar(value);
}

/**
 * The whole `form.define({ … });` statement, indented at `baseIndent`.
 *
 * `callee` is re-emitted exactly as the script spelled it (`form.define`,
 * `ctx.define`, …) so the designer never renames the author's parameter. The
 * spec object is always expanded — a form's layout is the thing being edited,
 * and collapsing it onto one line to save a few characters would make every
 * later diff unreadable.
 */
export function emitDefineStatement(
  callee: string,
  spec: unknown,
  options: FormEmitOptions,
): string {
  const body = emitValue(spec, options.baseIndent, SPEC_KEY_ORDER, options, true);
  return `${options.baseIndent}${callee}(${body});`;
}

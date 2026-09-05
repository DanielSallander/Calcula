//! FILENAME: app/src/api/scriptHost/scriptFormSpec.ts
// PURPOSE: The DECLARATIVE shape of a script-defined FORM (the VBA UserForm
//          replacement) plus its hard size limits and the data-only app events
//          the host registry and the trusted renderer exchange. Leaf module: it
//          imports ONLY scriptDialogSpec.ts (the five-field dialog spec this
//          generalizes) and scriptOrigin.ts (the trust origin, which imports
//          nothing), so the validator (validators.ts), the host registry
//          (scriptForms.ts), the worker shim (contextShims.ts) and the trusted
//          renderer (ScriptableObjects/components/scriptForm/) all agree on one
//          definition without forming an import cycle.
//
// WHY DECLARATIVE (the same rule as scriptDialogSpec.ts, and the owner's
// decision for release one): a script says "a required text box labelled
// Customer bound to B2" and TRUSTED host code paints it. No iframe, no
// script-authored markup, no script-authored chrome — so a form cannot imitate
// the application, cannot render a fake password box, and inherits the app skin
// for free. The script-supplied `title` is body content, never the dialog's
// identity band: the header always states which script is asking.
//
// WHAT CROSSES THE WORKER BOUNDARY is exactly what is declared here: a tree of
// plain objects (structured-clone data), patches to it, and the values the
// user entered. Handlers never leave the worker; the host invokes them by name.

import {
  DIALOG_FIELD_NAME_RE,
  MAX_DIALOG_FIELD_LABEL,
  MAX_DIALOG_FIELD_NAME,
  MAX_DIALOG_LABEL,
  MAX_DIALOG_MESSAGE,
  MAX_DIALOG_OPTION_TEXT,
  MAX_DIALOG_TITLE,
  RESERVED_DIALOG_FIELD_NAMES,
} from "./scriptDialogSpec";
import { scriptOriginForMount, type MountOrigin } from "./scriptOrigin";

// Re-exported so the validator and renderer reach every form limit from ONE
// module (a widget label is bounded exactly like a dialog field label).
export {
  DIALOG_FIELD_NAME_RE,
  MAX_DIALOG_FIELD_LABEL,
  MAX_DIALOG_FIELD_NAME,
  MAX_DIALOG_LABEL,
  MAX_DIALOG_MESSAGE,
  MAX_DIALOG_OPTION_TEXT,
  MAX_DIALOG_TITLE,
  RESERVED_DIALOG_FIELD_NAMES,
};

// ============================================================================
// Limits (enforced by the validator; restated in the renderer's clamps)
// ============================================================================

/** Most widgets (of any type, containers included) one form may declare. */
export const MAX_FORM_NODES = 200;
/** Deepest nesting of containers (group/tabs/row/column/grid). */
export const MAX_FORM_DEPTH = 8;
/** Most INPUT widgets (the ones with a `name` that lands in the result). */
export const MAX_FORM_INPUTS = 64;
/** Most choices one radio / dropdown / listbox may offer inline. */
export const MAX_FORM_OPTIONS = 500;
/** Most cells (rows x columns) one read-only table may carry inline. */
export const MAX_FORM_TABLE_CELLS = 5_000;
/** Most pages one tabs widget may declare. */
export const MAX_FORM_TABS = 12;
/** Columns a grid container may span. */
export const MAX_FORM_GRID_COLUMNS = 6;
/** Dialog width bounds (px); the renderer additionally clamps to the viewport. */
export const MIN_FORM_WIDTH = 320;
export const MAX_FORM_WIDTH = 1200;
/** Longest `bind` string ("Sheet1!B2", a defined name). */
export const MAX_FORM_BIND_CHARS = 64;
/** Most keys in `show({ initial })` and in a patch's `values`. */
export const MAX_FORM_INITIAL_KEYS = 64;
/** Longest text value a form may carry per widget (Excel's cell text cap). */
export const MAX_FORM_VALUE_CHARS = 32_767;
/** Most control entries one `update` patch may address. */
export const MAX_FORM_PATCH_CONTROLS = 64;
/** Longest per-control error message a script may set. */
export const MAX_FORM_ERROR_CHARS = 200;
/** `form.update` calls admitted per second per open form (host token bucket). */
export const FORM_UPDATE_PER_SECOND = 30;
/** `show` attempts admitted per minute per script — bounds a re-show loop. */
export const FORM_SHOWS_PER_MINUTE = 20;

/** The widget types a form may declare. `html` is RESERVED for a later
 *  milestone and is refused by the release-one validator. */
export const FORM_WIDGET_TYPES = [
  "label",
  "textbox",
  "number",
  "date",
  "checkbox",
  "toggle",
  "radio",
  "dropdown",
  "listbox",
  "button",
  "group",
  "tabs",
  "row",
  "column",
  "grid",
  "spacer",
  "image",
  "table",
  "progress",
] as const;
export type FormWidgetType = (typeof FORM_WIDGET_TYPES)[number];
export const FORM_WIDGET_TYPE_SET: ReadonlySet<string> = new Set(FORM_WIDGET_TYPES);

/** Widget types that carry a `name` and produce a value in the result. */
export const FORM_INPUT_TYPES = [
  "textbox",
  "number",
  "date",
  "checkbox",
  "toggle",
  "radio",
  "dropdown",
  "listbox",
] as const;
export const FORM_INPUT_TYPE_SET: ReadonlySet<string> = new Set(FORM_INPUT_TYPES);

/** Widget types whose `children` / `pages` nest further widgets. */
export const FORM_CONTAINER_TYPES = ["group", "tabs", "row", "column", "grid"] as const;
export const FORM_CONTAINER_TYPE_SET: ReadonlySet<string> = new Set(FORM_CONTAINER_TYPES);

/** Members every widget may carry (FormWidgetBase). */
export const FORM_WIDGET_BASE_KEYS = [
  "type", "name", "label", "help", "hidden", "disabled", "width",
] as const;
/** Members every INPUT widget may carry in addition (FormInputBase). */
export const FORM_INPUT_BASE_KEYS = [
  ...FORM_WIDGET_BASE_KEYS, "bind", "required", "writeOn",
] as const;

/**
 * Per-type key allowlist. The validator refuses an unknown key BY NAME — a
 * silently ignored typo is a support ticket, and `pattern` in particular must
 * never be accepted anywhere (a script-supplied regex run against keystrokes in
 * the trusted main thread is a ReDoS surface with no sandbox around it).
 *
 * It lives here rather than in validators.ts because it is a fact about the
 * SHAPE, and a second reader needs it: the visual designer's property panel
 * offers exactly the keys a widget may carry, and drives that list from this
 * table rather than from a copy that drifts the first time a key is added
 * (`components/formDesigner/propertyFields.ts`, whose own test asserts every
 * key here has an editor).
 */
export const FORM_WIDGET_KEYS: Readonly<Record<FormWidgetType, readonly string[]>> = {
  label:    [...FORM_WIDGET_BASE_KEYS, "text", "style"],
  textbox:  [...FORM_INPUT_BASE_KEYS, "default", "placeholder", "multiline", "maxLength"],
  number:   [...FORM_INPUT_BASE_KEYS, "default", "min", "max", "step"],
  date:     [...FORM_INPUT_BASE_KEYS, "default", "min", "max"],
  checkbox: [...FORM_INPUT_BASE_KEYS, "default"],
  toggle:   [...FORM_INPUT_BASE_KEYS, "default"],
  radio:    [...FORM_INPUT_BASE_KEYS, "options", "default", "layout"],
  dropdown: [...FORM_INPUT_BASE_KEYS, "options", "default", "allowEmpty"],
  listbox:  [...FORM_INPUT_BASE_KEYS, "options", "multi", "default", "rows"],
  button:   [...FORM_WIDGET_BASE_KEYS, "text", "role", "danger"],
  group:    [...FORM_WIDGET_BASE_KEYS, "title", "children"],
  tabs:     [...FORM_WIDGET_BASE_KEYS, "pages"],
  row:      [...FORM_WIDGET_BASE_KEYS, "children", "gap"],
  column:   [...FORM_WIDGET_BASE_KEYS, "children", "gap"],
  grid:     [...FORM_WIDGET_BASE_KEYS, "columns", "children"],
  spacer:   [...FORM_WIDGET_BASE_KEYS, "size"],
  image:    [...FORM_WIDGET_BASE_KEYS, "src", "alt", "height"],
  table:    [...FORM_WIDGET_BASE_KEYS, "columns", "rows", "maxRows"],
  progress: [...FORM_WIDGET_BASE_KEYS, "value", "max", "text"],
};

/** The form-level keys `checkFormSpec` admits, in `FormSpec` declaration order. */
export const FORM_SPEC_KEYS = [
  "title", "description", "submitLabel", "cancelLabel",
  "width", "writeOn", "submitOnEnter", "focus", "children",
] as const;

// ============================================================================
// Spec shapes
// ============================================================================

/** A value a widget holds and a bound cell receives. Listbox `multi` yields string[]. */
export type FormValue = string | number | boolean | null;

/** One choice in a radio / dropdown / listbox. Scripts may also pass a bare string. */
export interface FormOption {
  value: string;
  label?: string;
}

/**
 * Where a choice list comes from. Inline options cross as data; `{ range }`
 * names cells the HOST reads at show time under the script's own tier (an
 * audited read like any other), so a script can never populate a list with
 * cells it could not read itself.
 */
export type FormOptions = Array<string | FormOption> | { range: string };

/**
 * What a widget reads its initial value from and writes its answer to.
 * A bare string is an A1 cell ("B2", "Sheet1!B2") or a defined name; the host
 * resolves it at show time. `{ control }` names a Controls-pane value
 * (GET.CONTROLVALUE) and is read-only.
 */
export type FormBinding =
  | string
  | { cell: string; sheet?: string | number }
  | { name: string }
  | { control: string };

export interface FormWidgetBase {
  /** Result key for inputs; an addressable id for everything else. */
  name?: string;
  label?: string;
  /** Secondary line under the control. */
  help?: string;
  hidden?: boolean;
  disabled?: boolean;
  /** Fixed width in px, or "fill" to stretch. */
  width?: number | "fill";
}

export interface FormInputBase extends FormWidgetBase {
  name: string;
  bind?: FormBinding;
  required?: boolean;
  /** Per-widget override of the form-level `writeOn`. */
  writeOn?: "submit" | "change";
}

export type FormWidget =
  | ({ type: "label"; text: string; style?: "normal" | "heading" | "muted" } & FormWidgetBase)
  | ({ type: "textbox"; default?: string; placeholder?: string; multiline?: boolean; maxLength?: number } & FormInputBase)
  | ({ type: "number"; default?: number; min?: number; max?: number; step?: number } & FormInputBase)
  | ({ type: "date"; default?: string; min?: string; max?: string } & FormInputBase)
  | ({ type: "checkbox"; default?: boolean } & FormInputBase)
  | ({ type: "toggle"; default?: boolean } & FormInputBase)
  | ({ type: "radio"; options: FormOptions; default?: string; layout?: "row" | "column" } & FormInputBase)
  | ({ type: "dropdown"; options: FormOptions; default?: string; allowEmpty?: boolean } & FormInputBase)
  | ({ type: "listbox"; options: FormOptions; multi?: boolean; default?: string | string[]; rows?: number } & FormInputBase)
  | ({ type: "button"; name: string; text: string; role?: "default" | "submit" | "cancel"; danger?: boolean } & FormWidgetBase)
  | ({ type: "group"; title?: string; children: FormWidget[] } & FormWidgetBase)
  | ({ type: "tabs"; pages: Array<{ title: string; children: FormWidget[] }> } & FormWidgetBase)
  | ({ type: "row"; children: FormWidget[]; gap?: number } & FormWidgetBase)
  | ({ type: "column"; children: FormWidget[]; gap?: number } & FormWidgetBase)
  | ({ type: "grid"; columns: number; children: FormWidget[] } & FormWidgetBase)
  | ({ type: "spacer"; size?: number } & FormWidgetBase)
  /** `src` is a `media:{sha256}` handle already in this workbook, or "" — never bytes, a path or a URL. */
  | ({ type: "image"; src: string; alt?: string; height?: number } & FormWidgetBase)
  | ({
      type: "table";
      columns: string[];
      rows: Array<Array<FormValue>> | { range: string };
      maxRows?: number;
    } & FormWidgetBase)
  | ({ type: "progress"; name: string; value: number; max?: number; text?: string } & FormWidgetBase);

/** The whole form a script hands to `form.define(spec)`. */
export interface FormSpec {
  /** Script-supplied heading, rendered as BODY content (never as chrome). */
  title?: string;
  /** Optional paragraph above the widgets. */
  description?: string;
  submitLabel?: string;
  cancelLabel?: string;
  /** Dialog width in px, clamped to MIN_FORM_WIDTH..MAX_FORM_WIDTH and the viewport. */
  width?: number;
  /** When bound widgets write their cells: on Submit (default) or on each committed change. */
  writeOn?: "submit" | "change";
  /** Enter in a single-line input submits (default true). */
  submitOnEnter?: boolean;
  /** Widget to focus when the form opens (default: the first enabled input). */
  focus?: string;
  children: FormWidget[];
}

/** What `form.update(patch)` may change while the form is open. */
export interface FormPatch {
  values?: Record<string, FormValue | string[]>;
  controls?: Record<
    string,
    {
      disabled?: boolean;
      hidden?: boolean;
      label?: string;
      /** label / button / progress caption. */
      text?: string;
      options?: FormOptions;
      /** Error text under the control; null clears it. */
      error?: string | null;
      /** progress: current value / max. */
      value?: number;
      max?: number;
    }
  >;
  focus?: string;
  /** Banner above the widgets; null clears it. */
  message?: { text: string; kind?: "info" | "warning" | "error" } | null;
}

/** What `onSubmit` may return. Anything else (including nothing) accepts. */
export type FormSubmitVerdict =
  | void
  | undefined
  | false
  | "cancel"
  | { cancel: true; errors?: Record<string, string>; message?: string };

export interface FormChangeDetail {
  name: string;
  value: FormValue | string[];
  values: Record<string, FormValue | string[]>;
  /** "user" for a keystroke/click, "cell" when a bound cell changed underneath. */
  source: "user" | "cell";
}
export interface FormClickDetail {
  name: string;
  values: Record<string, FormValue | string[]>;
}
export type FormCloseReason = "submit" | "cancel" | "script" | "deadline" | "unmount";
export interface FormCloseDetail {
  reason: FormCloseReason;
  values: Record<string, FormValue | string[]>;
}

// ============================================================================
// Provenance — STRUCTURAL, never a magic string
// ============================================================================

/**
 * Where a form came from, as data the renderer branches on.
 *
 * This used to be one string, `scriptOrigin`, in which the value `"local"` meant
 * "a script in this workbook" and every OTHER value was a package name. So an
 * application NAMED `local` made the identity band read "A form from a script in
 * this workbook" — exactly the impersonation the band exists to prevent, reached
 * by choosing a name. The name was being asked to carry the verdict as well as
 * the content, and one of those two jobs was always going to win.
 *
 * A discriminated union has no such value: `{ kind: "package", name: "local" }`
 * paints as a package, because `kind` is the only thing the phrasing reads and
 * nothing a publisher can type ever lands in it.
 *
 * THE SAME UNION IS NOW THE TRUST HANDLE'S ORIGIN. The form band was fixed
 * first, while `ScriptHandle.origin` was still a string carrying the same
 * collision for the capability gates and the R7 trust predicate. Both now read
 * ONE definition (`scriptOrigin.ts`), so the band and the gate cannot come to
 * different conclusions about the same script. A form is always shown for a
 * MOUNTED script, so its origin is the mount subset — local or package, never
 * the preview kind a dry-run handle carries.
 */
export type FormOrigin = MountOrigin;

/**
 * The origin of a MOUNTED script, from its authoritative definition.
 *
 * An alias for the canonical `scriptOriginForMount` (scriptOrigin.ts), kept
 * under the form-facing name the renderer and its tests already use. Derived
 * from `provenance` — the field the pull path stamps (`core/calp/src/pull.rs`) —
 * and never from the package name, which stays pure content. A distributed
 * script with no name gets `"(unknown package)"`, the same placeholder
 * `buildHandleFromDefinition` (broker.ts) puts on the trust handle, so the band
 * and the cross-script trust predicate spell one publisher one way.
 */
export const formOriginForMount: (definition: {
  provenance?: string;
  packageName?: string;
}) => FormOrigin = scriptOriginForMount;

// ============================================================================
// Host registry <-> trusted renderer (data-only app events, main window)
// ============================================================================

/**
 * What the renderer seeds a widget with. `display` is the formatted text the
 * grid shows for a bound cell (painted while the widget is unfocused); `value`
 * is the TYPED value the widget edits and the host writes back — never the
 * display string (the entry ladder refuses currency text, so echoing
 * "£1,234.50" would store TEXT).
 */
export interface FormSeed {
  value: FormValue | string[];
  display?: string;
  /** Present when the bound cell holds a formula; shown on focus, never rewritten unless edited. */
  formula?: string;
  /** The binding could not be read at this script's tier; `reason` says why. */
  readOnly?: boolean;
  reason?: string;
  /** image widgets: the resolved data URL for a `media:` handle. */
  imageUrl?: string;
  /** Choice lists resolved from a `{ range }` source. */
  options?: FormOption[];
  /** table widgets: rows resolved from a `{ range }` source. */
  rows?: FormValue[][];
}

/** Host -> renderer: open this form. Identity is HOST-supplied, never from the script. */
export const SCRIPT_FORM_REQUEST_EVENT = "scriptable-objects:script-form-request";
/** Host -> renderer: change what an open form shows (a script patch, refreshed seeds, or submit errors). */
export const SCRIPT_FORM_PATCH_EVENT = "scriptable-objects:script-form-patch";
/** Host -> renderer: close an open form (submitted, closed by script, deadline, unmount). */
export const SCRIPT_FORM_CLOSE_EVENT = "scriptable-objects:script-form-close";
/** Renderer -> host: what the user did. */
export const SCRIPT_FORM_INPUT_EVENT = "scriptable-objects:script-form-input";

export interface ScriptFormRequestPayload {
  showId: string;
  /** Authoritative identity — from the mount handle, never from the script. */
  scriptId: string;
  scriptName: string;
  /**
   * Local, or the package a distributed script arrived in — as a DISCRIMINATED
   * shape, so no package name can ever select the local phrasing (`FormOrigin`).
   */
  origin: FormOrigin;
  /** Set when ANOTHER script opened this form on the owner's behalf. */
  callerName?: string;
  spec: FormSpec;
  /** Initial values per input name (bound reads, then `initial`, then defaults). */
  seeds: Record<string, FormSeed>;
  /** Restricted tier: the sheet the bindings are pinned to. */
  pinnedSheetName?: string;
  /** Editor preview: nothing is written, Submit shows a would-write summary. */
  preview?: boolean;
}

export interface ScriptFormPatchPayload {
  showId: string;
  patch?: FormPatch;
  /** Refreshed seeds for widgets whose bound cell changed underneath. */
  seeds?: Record<string, FormSeed>;
  /**
   * The submit was REFUSED and the form stays open, so the renderer must leave
   * its pending state and let the user act again.
   *
   * A separate flag rather than "errors or message is present", because the
   * declared verdict type admits a BARE refusal — `false`, `"cancel"`, or
   * `{ cancel: true }` with nothing else, which is VBA's `Cancel = True` and
   * the shape a script writes when it simply does not want to close yet.
   * Inferring refusal from the payload's other fields locked the form: no
   * errors and no message read as "not refused", the Submit and Cancel buttons
   * stayed disabled showing "Working…", and the only way out was to close the
   * dialog — which orphaned the session holding the app-wide modal slot.
   */
  refused?: boolean;
  /** Submit was refused: per-widget errors and/or a banner. The form stays open. */
  errors?: Record<string, string>;
  message?: { text: string; kind?: "info" | "warning" | "error" } | null;
}

export interface ScriptFormClosePayload {
  showId: string;
  reason: FormCloseReason;
}

export type ScriptFormInputKind =
  /** The renderer mounted the form; `show()` resolves on this. */
  | "shown"
  | "change"
  | "click"
  | "submit"
  /** Cancel / Escape / X / backdrop, or the dialog closed without an answer. */
  | "cancel"
  /** Focus/keystroke that changes nothing — re-arms the idle deadline only. */
  | "interaction";

export interface ScriptFormInputPayload {
  showId: string;
  kind: ScriptFormInputKind;
  /** change / click: the widget. */
  name?: string;
  /** change: the widget's new value. */
  value?: FormValue | string[];
  /** Every input's current value, always. */
  values: Record<string, FormValue | string[]>;
}

/** Normalize an option (bare string or {value,label}) for rendering. */
export function normalizeFormOption(option: string | FormOption): FormOption {
  return typeof option === "string"
    ? { value: option, label: option }
    : { value: option.value, label: option.label ?? option.value };
}

/** True for a plain-identifier widget name that may become a result key. */
export function isValidFormName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= MAX_DIALOG_FIELD_NAME &&
    DIALOG_FIELD_NAME_RE.test(name) &&
    !RESERVED_DIALOG_FIELD_NAMES.has(name)
  );
}

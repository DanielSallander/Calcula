//! FILENAME: app/src/api/scriptHost/scriptDialogSpec.ts
// PURPOSE: The DECLARATIVE shape of a script-requested modal dialog (the
//          `ui.dialog` capability) plus its hard size limits. Leaf module: it
//          imports NOTHING, so the pure validator (validators.ts), the host
//          request registry (scriptDialogs.ts) and the trusted renderer
//          (ScriptableObjects/components/ScriptDialogPrompt.tsx) all agree on
//          one definition without forming an import cycle.
//
// WHY DECLARATIVE: a script says "a required text field labelled Reason" and
// TRUSTED host code paints it. No iframe, no script-authored markup, no
// script-authored chrome — so a dialog cannot imitate the application's own UI,
// cannot render a fake password box, and inherits the app skin for free. The
// script-supplied `title` is body content, never the dialog's identity band:
// the header always states which script is asking (see scriptDialogs.ts).

// ============================================================================
// Limits (enforced by the validator; restated in the renderer's clamps)
// ============================================================================

/** Longest message / prompt default a script may pass. */
export const MAX_DIALOG_MESSAGE = 4_000;
/** Longest script-supplied heading. */
export const MAX_DIALOG_TITLE = 120;
/** Longest button caption. */
export const MAX_DIALOG_LABEL = 40;
/** Longest field label / help text / placeholder. */
export const MAX_DIALOG_FIELD_LABEL = 200;
/** Most fields one form may declare. */
export const MAX_DIALOG_FIELDS = 32;
/** Most choices one select field may offer. */
export const MAX_DIALOG_OPTIONS = 200;
/** Longest single select option value/label. */
export const MAX_DIALOG_OPTION_TEXT = 200;
/** Longest field name (the result-object key). */
export const MAX_DIALOG_FIELD_NAME = 64;

/** Field names are result-object KEYS, so they must be plain identifiers —
 *  no "__proto__", no dots, nothing that reads as a path. */
export const DIALOG_FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Result keys that would collide with Object.prototype plumbing. */
export const RESERVED_DIALOG_FIELD_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "hasOwnProperty",
  "toString",
  "valueOf",
]);

/** The declarative field kinds a form may use. */
export const DIALOG_FIELD_TYPES = ["text", "number", "date", "select", "checkbox"] as const;
export type ScriptDialogFieldType = (typeof DIALOG_FIELD_TYPES)[number];

export const DIALOG_FIELD_TYPE_SET: ReadonlySet<string> = new Set(DIALOG_FIELD_TYPES);

// ============================================================================
// Spec shapes
// ============================================================================

/** One choice in a `select` field. Scripts may also pass a bare string. */
export interface ScriptDialogOption {
  value: string;
  label?: string;
}

/**
 * One declarative form field. `name` is the key its answer lands under in the
 * result object; every other member is presentation or client-side validation.
 *
 * There is deliberately NO regex `pattern` member: running a script-supplied
 * regular expression against user keystrokes in the trusted main thread is a
 * ReDoS surface with no sandbox around it. Required / min / max / maxLength
 * cover the real cases; anything richer belongs in the script, after the
 * dialog resolves.
 */
export interface ScriptDialogField {
  name: string;
  label: string;
  type: ScriptDialogFieldType;
  /** Empty (or unchecked-but-required) blocks submit. */
  required?: boolean;
  /** Initial value. Type-appropriate: string | number | boolean. */
  default?: string | number | boolean;
  placeholder?: string;
  /** Secondary line under the control. */
  help?: string;
  /** text: render a textarea instead of a single-line input. */
  multiline?: boolean;
  /** text: maximum entered length. */
  maxLength?: number;
  /** number: inclusive bounds + spinner step. */
  min?: number;
  max?: number;
  step?: number;
  /** select: the choices (required, non-empty). */
  options?: Array<string | ScriptDialogOption>;
}

/** The whole form a script hands to `caps.dialog.form(spec)`. */
export interface ScriptDialogFormSpec {
  /** Script-supplied heading, rendered as BODY content (never as chrome). */
  title?: string;
  /** Optional paragraph above the fields. */
  description?: string;
  submitLabel?: string;
  cancelLabel?: string;
  fields: ScriptDialogField[];
}

/** Options accepted by alert() and confirm(). */
export interface ScriptDialogTextOptions {
  title?: string;
  okLabel?: string;
  /** confirm() only — omit for alert(). */
  cancelLabel?: string;
  /** confirm() only — style the confirm button as destructive. */
  danger?: boolean;
}

/** Options accepted by prompt(). */
export interface ScriptDialogPromptOptions {
  title?: string;
  okLabel?: string;
  cancelLabel?: string;
  defaultValue?: string;
  placeholder?: string;
  multiline?: boolean;
  maxLength?: number;
}

/** Normalize a select option (bare string or {value,label}) for rendering. */
export function normalizeDialogOption(option: string | ScriptDialogOption): ScriptDialogOption {
  return typeof option === "string" ? { value: option, label: option } : { value: option.value, label: option.label ?? option.value };
}

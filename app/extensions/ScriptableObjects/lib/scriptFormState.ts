//! FILENAME: app/extensions/ScriptableObjects/lib/scriptFormState.ts
// PURPOSE: Pure state helpers for the trusted TypeScript Forms renderer (the
//          VBA UserForm replacement). Everything that decides what a widget
//          STARTS as, whether a submit is acceptable, what shape the script
//          receives, how a script patch lands, and which widgets the user has
//          touched lives here — DOM-free, so it is testable without React.
// CONTEXT: The host registry (@api/scriptHost/scriptForms.ts) validated the
//          spec before it reached the renderer: every string is bounded and
//          every name is an identifier. These helpers deal only with what the
//          USER did to it, and with the TYPED seed values the host resolved for
//          bound cells. There is deliberately no script-supplied regex anywhere
//          in validation: required / min / max / maxLength / membership cover
//          the real cases, and a pattern would be a ReDoS surface on the
//          trusted main thread.

import type {
  FormOption,
  FormPatch,
  FormSeed,
  FormSpec,
  FormValue,
  FormWidget,
} from "@api/scriptHost/scriptFormSpec";
import { FORM_INPUT_TYPE_SET, normalizeFormOption } from "@api/scriptHost/scriptFormSpec";
import { coerceFormValue } from "@api/scriptHost/scriptFormBindings";

// ============================================================================
// Types
// ============================================================================

/** A value one widget holds. Listbox `multi` yields string[]. */
export type ScriptFormValue = FormValue | string[];
/** Every input's current value, keyed by widget name. */
export type ScriptFormValues = Record<string, ScriptFormValue>;

/** A widget narrowed to one `type`. */
export type WidgetOf<T extends FormWidget["type"]> = Extract<FormWidget, { type: T }>;

/** The widgets that carry a `name` and land in the result. */
export type FormInputWidget = WidgetOf<
  "textbox" | "number" | "date" | "checkbox" | "toggle" | "radio" | "dropdown" | "listbox"
>;

/** The widgets whose choices come from `options`. */
export type FormChoiceWidget = WidgetOf<"radio" | "dropdown" | "listbox">;

/** One widget with its index route from the root (`children`/`pages` indices). */
export interface FormWidgetEntry<W extends FormWidget = FormWidget> {
  widget: W;
  path: number[];
}

/** What a script's `form.update` patch may override on one control. */
export interface FormControlOverride {
  disabled?: boolean;
  hidden?: boolean;
  label?: string;
  text?: string;
  options?: FormOption[];
  error?: string;
  value?: number;
  max?: number;
}

/** The renderer's patchable state: values plus per-control overrides. */
export interface ScriptFormState {
  values: ScriptFormValues;
  controls: Record<string, FormControlOverride>;
}

/** What `validateFormValues` needs beyond the spec to judge a widget. */
export interface FormValidationContext {
  seeds?: Record<string, FormSeed>;
  controls?: Record<string, FormControlOverride>;
}

// ============================================================================
// Tree walking
// ============================================================================

/** True for a widget that carries a `name` and produces a result value. */
export function isInputWidget(widget: FormWidget): widget is FormInputWidget {
  return FORM_INPUT_TYPE_SET.has(widget.type);
}

/** The nested widgets of a container, or null for a leaf. Tabs flatten page-major. */
function childrenOf(widget: FormWidget): Array<{ index: number[]; children: FormWidget[] }> | null {
  switch (widget.type) {
    case "group":
    case "row":
    case "column":
    case "grid":
      return [{ index: [], children: widget.children }];
    case "tabs":
      return widget.pages.map((page, p) => ({ index: [p], children: page.children }));
    default:
      return null;
  }
}

/** Every widget in tree order (depth-first, pages in order) with its path. */
export function collectWidgets(spec: FormSpec): FormWidgetEntry[] {
  const out: FormWidgetEntry[] = [];
  const walk = (widgets: FormWidget[], prefix: number[]): void => {
    widgets.forEach((widget, i) => {
      const path = [...prefix, i];
      out.push({ widget, path });
      const nested = childrenOf(widget);
      if (nested) {
        for (const { index, children } of nested) walk(children, [...path, ...index]);
      }
    });
  };
  walk(spec.children, []);
  return out;
}

/** Every INPUT widget in tree order with its path. */
export function collectInputs(spec: FormSpec): FormWidgetEntry<FormInputWidget>[] {
  const out: FormWidgetEntry<FormInputWidget>[] = [];
  for (const entry of collectWidgets(spec)) {
    if (isInputWidget(entry.widget)) out.push({ widget: entry.widget, path: entry.path });
  }
  return out;
}

/** Every input name reachable under one widget subtree (the widget itself included). */
export function inputNamesUnder(widgets: FormWidget[]): string[] {
  return collectInputs({ children: widgets }).map((e) => e.widget.name);
}

/**
 * Input names a CONTAINER hides or disables from above.
 *
 * A container's `hidden` / `disabled` is inherited by everything inside it —
 * `Frame` renders nothing for a hidden container, so its children are not on
 * screen at all. Judging those inputs anyway is how a required text box inside
 * `{ type: "group", hidden: true }` blocked Submit with an error the form had
 * nowhere to paint: the user pressed Save and watched nothing happen, with no
 * way to find out why.
 *
 * Control overrides count, because a script sets exactly this through
 * `form.control("advanced").show(false)` / `.enable(false)`.
 */
export function containerSuppressed(
  spec: FormSpec,
  controls: Record<string, FormControlOverride> = {},
): { hidden: Set<string>; disabled: Set<string> } {
  const hidden = new Set<string>();
  const disabled = new Set<string>();
  const walk = (widgets: FormWidget[], offHidden: boolean, offDisabled: boolean): void => {
    for (const widget of widgets) {
      const override = widget.name ? controls[widget.name] : undefined;
      const isHidden = offHidden || widget.hidden === true || override?.hidden === true;
      const isDisabled = offDisabled || widget.disabled === true || override?.disabled === true;
      if (isInputWidget(widget)) {
        if (offHidden) hidden.add(widget.name);
        if (offDisabled) disabled.add(widget.name);
      }
      const nested = childrenOf(widget);
      if (!nested) continue;
      for (const { children } of nested) walk(children, isHidden, isDisabled);
    }
  };
  walk(spec.children, false, false);
  return { hidden, disabled };
}

// ============================================================================
// Value coercion
// ============================================================================

/** Text view of any value: null/undefined -> "", arrays joined, booleans Excel-style. */
export function asText(value: ScriptFormValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

/** Boolean view: true / non-zero / "true" / "1" are on, everything else off. */
export function asBool(value: ScriptFormValue | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const t = value.trim().toUpperCase();
    return t === "TRUE" || t === "1";
  }
  return false;
}

/** List view: arrays as-is (strings only), a non-blank scalar as a one-item list. */
export function asList(value: ScriptFormValue | undefined): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (value === null || value === undefined) return [];
  const text = asText(value);
  return text === "" ? [] : [text];
}

/** True for "nothing entered": null, undefined, blank text, empty list. */
export function isBlank(value: ScriptFormValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.trim().length === 0;
  return false;
}

/** A finite number from a number or numeric text, else null. */
export function toNumberOrNull(value: ScriptFormValue | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const t = value.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Excel serial day -> ISO date (whole days; 25569 is 1970-01-01). */
export function serialToIso(serial: number): string {
  if (!Number.isFinite(serial)) return "";
  const ms = Math.round((serial - 25569) * 86_400_000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What a raw seed / patch value means for THIS widget. A number widget keeps a
 * number (never the display text — the entry ladder refuses currency text, so
 * echoing "£1,234.50" would store TEXT); a checkbox keeps a boolean; a listbox
 * keeps a list. Text that does not parse as a number is kept as text so the
 * validator can name the problem instead of silently blanking the field.
 */
export function coerceValue(widget: FormInputWidget, raw: ScriptFormValue | undefined): ScriptFormValue {
  // ONE RULE, IN THE SHARED LEAF. The host keeps its own copy of every value
  // (form.values, the dirty test, the write-back), and every place the two
  // realms disagreed about a value's SHAPE produced a defect — a single-select
  // listbox judged dirty while untouched, an `initial` string written over an
  // untouched cell, a script's set("7") leaving the mirror holding a string.
  // So this delegates rather than restating the rules.
  return coerceFormValue(widget.type, widget.type === "listbox" && widget.multi === true, raw);
}

/** Same answer, ignoring representation: 1234.5 vs "1234.5", true vs 1, [] vs "". */
export function sameFormValue(a: ScriptFormValue | undefined, b: ScriptFormValue | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = asList(a);
    const y = asList(b);
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  const na = a ?? "";
  const nb = b ?? "";
  if (na === nb) return true;
  if (typeof na === "boolean" || typeof nb === "boolean") {
    return asBool(na) === asBool(nb);
  }
  if (typeof na === "number" || typeof nb === "number") {
    const x = toNumberOrNull(na);
    const y = toNumberOrNull(nb);
    return x !== null && y !== null && x === y;
  }
  return false;
}

// ============================================================================
// Options
// ============================================================================

/** Inline options normalized, or the seed's resolved list when the spec used `{ range }`. */
export function resolveOptions(widget: FormChoiceWidget, seeds: Record<string, FormSeed>): FormOption[] {
  if (Array.isArray(widget.options)) return widget.options.map(normalizeFormOption);
  const seeded = seeds[widget.name]?.options;
  return seeded ? seeded.map(normalizeFormOption) : [];
}

/** The options a widget currently offers: a patch override wins over the spec/seed. */
export function effectiveOptions(
  widget: FormChoiceWidget,
  seeds: Record<string, FormSeed>,
  controls: Record<string, FormControlOverride>,
): FormOption[] {
  return controls[widget.name]?.options ?? resolveOptions(widget, seeds);
}

// ============================================================================
// Initial values
// ============================================================================

/** The widget's declared default, else the empty value of its type. */
export function defaultValue(widget: FormInputWidget, seeds: Record<string, FormSeed>): ScriptFormValue {
  switch (widget.type) {
    case "textbox":
      return widget.default ?? "";
    case "number":
      return widget.default !== undefined && Number.isFinite(widget.default) ? widget.default : null;
    case "date":
      return widget.default ?? "";
    case "checkbox":
    case "toggle":
      return widget.default === true;
    case "radio":
      return widget.default ?? "";
    case "dropdown": {
      if (widget.default !== undefined) return widget.default;
      if (widget.allowEmpty) return "";
      // A dropdown with no default lands on its first option rather than on a
      // blank entry the spec never declared (scriptDialogForm.initialFieldValue
      // reached the same conclusion for the five-field dialog).
      const options = resolveOptions(widget, seeds);
      return options.length > 0 ? options[0].value : "";
    }
    case "listbox": {
      if (widget.multi) {
        if (Array.isArray(widget.default)) return [...widget.default];
        return widget.default !== undefined ? [widget.default] : [];
      }
      if (Array.isArray(widget.default)) return widget.default[0] ?? "";
      return widget.default ?? "";
    }
  }
}

/** Seed the whole form: a seed wins, then the declared default, then the type's empty value. */
export function initialFormValues(spec: FormSpec, seeds: Record<string, FormSeed>): ScriptFormValues {
  const values: ScriptFormValues = {};
  for (const { widget } of collectInputs(spec)) {
    const seed = seeds[widget.name];
    values[widget.name] = seed !== undefined ? coerceValue(widget, seed.value) : defaultValue(widget, seeds);
  }
  return values;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate one answer against the widget's own declaration. Returns null when
 * acceptable, else the message shown under the control.
 */
export function validateInputValue(
  widget: FormInputWidget,
  value: ScriptFormValue | undefined,
  options: FormOption[] = [],
): string | null {
  const allowed = options.map((o) => o.value);
  switch (widget.type) {
    case "checkbox":
    case "toggle":
      // "required" on a checkbox is the "I agree" pattern: it must be ticked.
      return widget.required && value !== true ? "This must be checked" : null;
    case "textbox": {
      const text = asText(value);
      if (text.trim().length === 0) return widget.required ? "This is required" : null;
      if (widget.maxLength !== undefined && text.length > widget.maxLength) {
        return `Must be ${widget.maxLength} characters or fewer`;
      }
      return null;
    }
    case "number": {
      if (isBlank(value)) return widget.required ? "This is required" : null;
      const n = typeof value === "number" ? value : toNumberOrNull(value);
      if (n === null || !Number.isFinite(n)) return "Enter a number";
      if (widget.min !== undefined && n < widget.min) return `Must be at least ${widget.min}`;
      if (widget.max !== undefined && n > widget.max) return `Must be at most ${widget.max}`;
      return null;
    }
    case "date": {
      const text = asText(value).trim();
      if (text.length === 0) return widget.required ? "This is required" : null;
      if (!ISO_DATE_RE.test(text)) return "Enter a date (YYYY-MM-DD)";
      if (widget.min !== undefined && text < widget.min) return `Must be on or after ${widget.min}`;
      if (widget.max !== undefined && text > widget.max) return `Must be on or before ${widget.max}`;
      return null;
    }
    case "radio": {
      const text = asText(value);
      if (text === "") return widget.required ? "Choose an option" : null;
      return allowed.includes(text) ? null : "Choose one of the listed options";
    }
    case "dropdown": {
      const text = asText(value);
      if (text === "") return widget.required ? "Choose an option" : null;
      return allowed.includes(text) ? null : "Choose one of the listed options";
    }
    case "listbox": {
      if (widget.multi) {
        const chosen = asList(value);
        if (chosen.length === 0) return widget.required ? "Choose at least one" : null;
        return chosen.every((v) => allowed.includes(v)) ? null : "Choose only listed options";
      }
      const text = asText(value);
      if (text === "") return widget.required ? "Choose an option" : null;
      return allowed.includes(text) ? null : "Choose one of the listed options";
    }
  }
}

/**
 * Every input's error, keyed by name (absent = acceptable). Widgets the user
 * cannot act on are not judged: hidden, disabled, and bindings the host marked
 * read-only or formula-backed — an error the user cannot fix would block
 * Submit forever.
 */
export function validateFormValues(
  spec: FormSpec,
  values: ScriptFormValues,
  context: FormValidationContext = {},
): Record<string, string> {
  const seeds = context.seeds ?? {};
  const controls = context.controls ?? {};
  const errors: Record<string, string> = {};
  // A container above the widget counts too: a hidden group is not rendered at
  // all, so an error on an input inside it can never be seen or fixed.
  const suppressed = containerSuppressed(spec, controls);
  for (const { widget } of collectInputs(spec)) {
    const override = controls[widget.name];
    if (widget.hidden || override?.hidden || suppressed.hidden.has(widget.name)) continue;
    if (widget.disabled || override?.disabled || suppressed.disabled.has(widget.name)) continue;
    const seed = seeds[widget.name];
    if (seed?.readOnly || seed?.formula !== undefined) continue;
    const options =
      widget.type === "radio" || widget.type === "dropdown" || widget.type === "listbox"
        ? effectiveOptions(widget, seeds, controls)
        : [];
    const error = validateInputValue(widget, values[widget.name], options);
    if (error !== null) errors[widget.name] = error;
  }
  return errors;
}

// ============================================================================
// Result
// ============================================================================

/**
 * The object the script receives. Types follow the WIDGET's declared type, not
 * the DOM's: a number widget yields a number, a checkbox/toggle a boolean, a
 * multi listbox a string[], everything else a string. An optional widget left
 * blank yields null — distinguishable from "" (an explicitly cleared text box),
 * so a script can tell "not answered" from "answered with nothing".
 */
export function buildFormResult(spec: FormSpec, values: ScriptFormValues): ScriptFormValues {
  const result: ScriptFormValues = {};
  for (const { widget } of collectInputs(spec)) {
    const raw = values[widget.name];
    switch (widget.type) {
      case "checkbox":
      case "toggle":
        result[widget.name] = raw === true;
        break;
      case "number":
        result[widget.name] = toNumberOrNull(raw);
        break;
      case "listbox":
        if (widget.multi) {
          result[widget.name] = asList(raw);
          break;
        }
        result[widget.name] = textOrNull(asText(raw), widget.required === true);
        break;
      default:
        result[widget.name] = textOrNull(asText(raw), widget.required === true);
        break;
    }
  }
  return result;
}

function textOrNull(text: string, required: boolean): string | null {
  return text.trim().length === 0 && !required ? null : text;
}

// ============================================================================
// Patches
// ============================================================================

/**
 * Land a script's `form.update` patch: values merge in, per-control overrides
 * accumulate by name (later patches win field by field), `error: null` clears
 * the error. Inline `options` are normalized; a `{ range }` source in a patch
 * is left to the host (which re-seeds) and does not change the list here.
 * Returns a NEW state; the input is never mutated.
 */
export function applyFormPatch(state: ScriptFormState, patch: FormPatch): ScriptFormState {
  const values = patch.values ? { ...state.values, ...patch.values } : state.values;
  const controls: Record<string, FormControlOverride> = { ...state.controls };
  for (const [name, change] of Object.entries(patch.controls ?? {})) {
    const next: FormControlOverride = { ...(controls[name] ?? {}) };
    if (change.disabled !== undefined) next.disabled = change.disabled;
    if (change.hidden !== undefined) next.hidden = change.hidden;
    if (change.label !== undefined) next.label = change.label;
    if (change.text !== undefined) next.text = change.text;
    if (Array.isArray(change.options)) next.options = change.options.map(normalizeFormOption);
    if (change.error !== undefined) {
      if (change.error === null) delete next.error;
      else next.error = change.error;
    }
    if (change.value !== undefined) next.value = change.value;
    if (change.max !== undefined) next.max = change.max;
    controls[name] = next;
  }
  return { values, controls };
}

// ============================================================================
// Landing a host PATCH (values, control overrides, refreshed seeds)
// ============================================================================

/** The live state a renderer holds for one session; what a PATCH changes. */
export interface FormLiveState {
  values: ScriptFormValues;
  controls: Record<string, FormControlOverride>;
  seeds: Record<string, FormSeed>;
  /** Dirty names whose bound cell changed underneath (re-seeded while edited). */
  stale: ReadonlySet<string>;
}

/** What `landFormPatch` hands back, beside the next live state. */
export interface FormLandedPatch extends FormLiveState {
  /** The input names the patch's `values` named; the caller clears their errors. */
  patchedNames: string[];
}

/**
 * Land what the host sent — a script's patch and/or refreshed seeds — on the
 * live state, WITHOUT touching a DOM or a React hook, so the modal form and
 * the modeless pane cannot disagree about what a patch means.
 *
 * The rules, in order:
 *  - a script's `values` land through `applyFormPatch` and are then COERCED to
 *    the widget's type, so `values: { amount: "12" }` is 12 on a number widget
 *    (the same ladder the seed went through);
 *  - refreshed seeds land ONLY on widgets the user has not touched. "Untouched"
 *    is: never edited, or edited back to what it held before (the previous
 *    seed's value, else the declared default). A dirty widget keeps the user's
 *    value and joins `stale`, so the renderer can say the cell moved underneath.
 *
 * Identity is preserved where nothing changed: `values` is the same object
 * when neither `patch.values` nor `seeds` arrived, and `seeds` / `stale` are
 * the same objects when no seeds arrived — so a caller can compare references
 * to decide what to re-render, and never mutate the input.
 */
export function landFormPatch(
  state: FormLiveState,
  incoming: { patch?: FormPatch; seeds?: Record<string, FormSeed> },
  inputsByName: ReadonlyMap<string, FormInputWidget>,
  touched: ReadonlySet<string>,
): FormLandedPatch {
  let values = state.values;
  let controls = state.controls;
  let seeds = state.seeds;
  let stale = state.stale;
  const patchedNames: string[] = [];

  if (incoming.patch) {
    const applied = applyFormPatch({ values, controls }, incoming.patch);
    if (incoming.patch.values) {
      for (const name of Object.keys(incoming.patch.values)) {
        patchedNames.push(name);
        const widget = inputsByName.get(name);
        if (widget) applied.values[name] = coerceValue(widget, applied.values[name]);
      }
    }
    values = applied.values;
    controls = applied.controls;
  }

  if (incoming.seeds) {
    const nextSeeds = { ...state.seeds };
    const nextStale = new Set(state.stale);
    values = { ...values };
    for (const [name, seed] of Object.entries(incoming.seeds)) {
      const widget = inputsByName.get(name);
      const previous = nextSeeds[name];
      nextSeeds[name] = seed;
      if (!widget) continue;
      const before =
        previous !== undefined ? coerceValue(widget, previous.value) : defaultValue(widget, state.seeds);
      const untouched = !touched.has(name) || sameFormValue(values[name], before);
      if (untouched) {
        values[name] = coerceValue(widget, seed.value);
        nextStale.delete(name);
      } else {
        nextStale.add(name);
      }
    }
    seeds = nextSeeds;
    stale = nextStale;
  }

  return { values, controls, seeds, stale, patchedNames };
}

// ============================================================================
// Dirty tracking
// ============================================================================

/**
 * The names whose current value differs from what the seed put there. With a
 * spec, the seed is coerced the way `initialFormValues` coerced it, so an
 * untouched widget is never dirty merely because the seed carried a different
 * representation ({ value: 1234.5, display: "£1,234.50" } is not dirty until
 * the user actually types 1300). Only seeded names can be dirty — an unbound
 * widget has nothing to be dirty against.
 */
export function dirtySet(
  values: ScriptFormValues,
  seeds: Record<string, FormSeed>,
  spec?: FormSpec,
): Set<string> {
  const inputs = new Map<string, FormInputWidget>();
  if (spec) {
    for (const { widget } of collectInputs(spec)) inputs.set(widget.name, widget);
  }
  const dirty = new Set<string>();
  for (const [name, seed] of Object.entries(seeds)) {
    const widget = inputs.get(name);
    const expected = widget ? coerceValue(widget, seed.value) : seed.value;
    if (!sameFormValue(values[name], expected)) dirty.add(name);
  }
  return dirty;
}

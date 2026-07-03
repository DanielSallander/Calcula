//! FILENAME: app/src/api/controlValues.ts
// PURPOSE: Feature-neutral facade for enumerating named control values.
// CONTEXT: The Controls pane extension owns pane controls (sliders, dropdowns,
//   checkboxes, buttons, custom scripted controls) and the ribbon-filter items
//   sharing its strip. Consumers (Animation, scripts, other extensions) need to
//   enumerate name->value and observe changes WITHOUT importing the extension.
//   The ControlsPane extension provides the implementation via
//   registerControlValuesProvider (IoC, same pattern as chartParams.ts).
//   The authoritative snapshot for formula evaluation (GET.CONTROLVALUE) is
//   built Rust-side (pane_control::values::collect_control_values); this facade
//   is the frontend mirror for UI/extension consumers.

/**
 * A control's current value. Mirrors the Rust `engine::ControlValue` enum
 * (serde: tag = "kind", content = "value", camelCase).
 */
export type ControlValue =
  | { kind: "number"; value: number }
  | { kind: "text"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "textList"; value: string[] };

/** A named control as enumerated across the control families. */
export interface NamedControl {
  /** Entity id (uuid) of the owning pane control / ribbon filter. */
  id: string;
  /** User-visible unique name — the GET.CONTROLVALUE lookup key. */
  name: string;
  /** Which family the control belongs to. */
  source: "paneControl" | "ribbonFilter";
  /** The pane control type ("slider" | "dropdown" | ...) or "filter". */
  controlType: string;
  /** Current value; undefined for value-less controls (e.g. buttons). */
  value: ControlValue | undefined;
}

/** The control-values surface, implemented by the ControlsPane extension. */
export interface ControlValuesProvider {
  /** All named controls the pane knows about (pane controls + ribbon filters). */
  list(): NamedControl[];
  /** The current value of a named control (case-insensitive), or undefined. */
  get(name: string): ControlValue | undefined;
}

let registered: ControlValuesProvider | null = null;

/**
 * Provide the control-values implementation. Called once by the ControlsPane
 * extension in activate(), and with `null` on deactivate. Inverts the
 * dependency so this facade never imports the extension.
 */
export function registerControlValuesProvider(impl: ControlValuesProvider | null): void {
  registered = impl;
}

/** All named controls (empty if the ControlsPane extension is unavailable). */
export function listControlValues(): NamedControl[] {
  return registered ? registered.list() : [];
}

/** A named control's current value (undefined if missing / unavailable). */
export function getControlValue(name: string): ControlValue | undefined {
  return registered ? registered.get(name) : undefined;
}

/**
 * Window event fired by the ControlsPane extension whenever a control value
 * changes. detail: ControlValueChangedDetail. `transient` is true for
 * uncommitted preview changes (e.g. mid-drag slider frames) that must not
 * trigger persistence or formula recalc.
 */
export const CONTROL_VALUE_CHANGED = "controlValue:changed";

export interface ControlValueChangedDetail {
  id: string;
  name: string;
  value: ControlValue | undefined;
  transient: boolean;
}

/** Subscribe to control-value changes. Returns an unsubscribe function. */
export function onControlValueChange(
  cb: (detail: ControlValueChangedDetail) => void,
): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<ControlValueChangedDetail>).detail;
    if (detail) cb(detail);
  };
  window.addEventListener(CONTROL_VALUE_CHANGED, handler);
  return () => window.removeEventListener(CONTROL_VALUE_CHANGED, handler);
}

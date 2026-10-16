//! FILENAME: app/extensions/Controls/lib/types.ts
// PURPOSE: TypeScript type definitions for the Controls extension.
// CONTEXT: Mirrors Rust controls.rs types for frontend use.

import { SHAPE_PROPERTIES, getShapePropertiesWithDeclared } from "../Shape/shapeProperties";
import { IMAGE_PROPERTIES } from "../Image/imageProperties";
import { PAGE_NAVIGATOR_PROPERTIES } from "../PageNavigator/pageNavigatorProperties";
import { PAGE_NAVIGATOR_CONTROL_TYPE } from "@api/buttonControlService";

// ============================================================================
// Control Property Types
// ============================================================================

/**
 * A single stored property value. Every property the UI or a script writes is
 * "static" text (a `=...` value is text too): a property that FOLLOWS a
 * formula is a binding (`@api/objectBindings`), and the backend refuses
 * `valueType: "formula"` for it. "formula" survives only on CODE slots
 * (`onSelect`, `macroRef`, the held slots, `action*`), whose value type an
 * application carries byte-identical.
 */
export interface ControlPropertyValue {
  /** "static", or "formula" on an application's code slot only. */
  valueType: "static" | "formula";
  /** The stored value. */
  value: string;
}

/** Metadata for a control instance at a specific cell. */
export interface ControlMetadata {
  /** Control type identifier: "button", "checkbox", etc. */
  controlType: string;
  /**
   * The control's STABLE identity -- what a property binding names it by
   * (`@api/objectBindings`, `{ kind: "control", id: uid }`). Minted by the
   * backend (`controls::assign_uid`): a create gets a fresh one, a replace
   * keeps the existing control's, and a paste that arrives carrying its
   * source's uid is re-minted. Read it from what `set_control_metadata` /
   * `get_control_metadata` RETURN, never from a local copy (a copied control's
   * local metadata still carries its source's uid). Absent only before the
   * backend has seen the control.
   */
  uid?: string;
  /** Map of property name to property value */
  properties: Record<string, ControlPropertyValue>;
}

/** A control entry with its location (returned from get_all_controls). */
export interface ControlEntry {
  sheetIndex: number;
  row: number;
  col: number;
  metadata: ControlMetadata;
}

/**
 * One floating control's new geometry for `set_control_geometry` (mirrors Rust
 * `ControlGeometryChange` in api_types.rs). The control is addressed by its
 * anchor and must already exist. The backend stores the values exactly as the
 * old per-property `persistFloatingPosition` did (it is now
 * `persistFloatingGeometry`, one batch) -- the static properties x / y / width
 * / height (and offsetX / offsetY for a pinned control) as
 * `String(Math.round(v))` -- so pass the unrounded numbers. The offsets travel
 * together: pass both (pinned control) or neither.
 */
export interface ControlGeometryChange {
  sheetIndex: number;
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
  offsetX?: number;
  offsetY?: number;
}

/**
 * One control's APPEARANCE writes for `set_control_appearance` (mirrors Rust
 * `ControlAppearanceChange` in api_types.rs): the Format pane's batch, ONE
 * undo step ("Format control") that joins an open transaction. Every write is
 * stored `"static"`. Refused whole, before anything is written: a code /
 * action / held key, a structural key (pinToGrid, embedded, shapeType, x, y,
 * width, height, offsetX, offsetY, uid, name), a bad `container*` value, the
 * same control twice, an empty entry, an unknown control.
 */
export interface ControlAppearanceChange {
  sheetIndex: number;
  row: number;
  col: number;
  properties: ControlAppearanceWrite[];
}

/** One `key = value` of a ControlAppearanceChange (Rust `ControlAppearanceWrite`). */
export interface ControlAppearanceWrite {
  key: string;
  value: string;
}

// ============================================================================
// Button Property Definitions
// ============================================================================

/** Property definition for the Properties Pane UI. */
export interface PropertyDefinition {
  /** Property key name (e.g., "text", "fill", "onSelect") */
  key: string;
  /** Display label in the Properties Pane */
  label: string;
  /** Input type for static values */
  inputType: "text" | "color" | "number" | "script" | "code" | "boolean" | "select";
  /** For "select": the choices, in menu order (the stored value and the word shown). */
  options?: ReadonlyArray<{ value: string; label: string }>;
  /** Default static value */
  defaultValue: string;
  /** Whether this property supports formula mode */
  supportsFormula: boolean;
  /** Named section group (e.g., "Fill & Outline", "Text") */
  group?: string;
  /** Slider minimum (for number inputs) */
  min?: number;
  /** Slider maximum */
  max?: number;
  /** Slider step increment */
  step?: number;
  /** Render side-by-side with next inline property */
  inline?: boolean;
  /**
   * Show the value, refuse to let the pane edit it.
   *
   * For properties whose value is a HANDLE the host issued rather than text the
   * user authors — today: an image's `src`, which is `media:{sha256}` and only
   * ever comes back from `read_media_file`. A free-text box there let anyone
   * type `https://tracker.example/pixel.gif` into a document property, with the
   * CSP as the only thing between that and a beacon firing on every open.
   */
  readOnly?: boolean;
  /** Explains a `readOnly` row. Shown under the value and as its tooltip. */
  readOnlyHint?: string;
}

/** All property definitions for a Button control. */
export const BUTTON_PROPERTIES: PropertyDefinition[] = [
  {
    key: "text",
    label: "Text",
    inputType: "text",
    defaultValue: "Button",
    supportsFormula: true,
    group: "Appearance",
  },
  {
    key: "fill",
    label: "Fill",
    inputType: "color",
    defaultValue: "#e0e0e0",
    supportsFormula: true,
    group: "Appearance",
  },
  {
    key: "color",
    label: "Color",
    inputType: "color",
    defaultValue: "#000000",
    supportsFormula: true,
    group: "Appearance",
  },
  {
    key: "borderColor",
    label: "Border Color",
    inputType: "color",
    defaultValue: "#999999",
    supportsFormula: true,
    group: "Appearance",
  },
  // The face's outline width: the button's visual-container BORDER width (WP-C
  // D-FORMAT, "border = outline"); "0" = no outline.
  {
    key: "strokeWidth",
    label: "Border Width",
    inputType: "number",
    defaultValue: "1",
    supportsFormula: true,
    group: "Appearance",
    min: 0,
    max: 20,
    step: 1,
  },
  {
    key: "fontSize",
    label: "Font Size",
    inputType: "number",
    defaultValue: "11",
    supportsFormula: true,
    group: "Appearance",
    min: 6,
    max: 72,
    step: 1,
  },
  {
    key: "width",
    label: "Width",
    inputType: "number",
    defaultValue: "80",
    supportsFormula: true,
    group: "Size",
    inline: true,
  },
  {
    key: "height",
    label: "Height",
    inputType: "number",
    defaultValue: "28",
    supportsFormula: true,
    group: "Size",
    inline: true,
  },
  {
    key: "embedded",
    label: "Embedded",
    inputType: "boolean",
    defaultValue: "false",
    supportsFormula: false,
    group: "Layout",
  },
  {
    key: "pinToGrid",
    label: "Pin to grid",
    inputType: "boolean",
    // Floating controls are created with this false (they hold a pixel
    // position). In-cell controls have no stored value and default to pinned,
    // because an in-cell control's position simply IS its anchor cell.
    defaultValue: "false",
    supportsFormula: false,
    group: "Layout",
  },
  {
    key: "onSelect",
    label: "OnSelect",
    inputType: "code",
    defaultValue: "",
    supportsFormula: false,
    group: "Actions",
  },
  {
    key: "tooltip",
    label: "Tooltip",
    inputType: "text",
    defaultValue: "",
    supportsFormula: true,
    group: "Appearance",
  },
];

/** Get property definitions for a given control type. */
export function getPropertyDefinitions(controlType: string, instanceId?: string): PropertyDefinition[] {
  switch (controlType) {
    case "button":
      return BUTTON_PROPERTIES;
    case "shape":
      return getShapePropertiesWithDeclared(instanceId);
    case "image":
      return IMAGE_PROPERTIES;
    case PAGE_NAVIGATOR_CONTROL_TYPE:
      return PAGE_NAVIGATOR_PROPERTIES;
    default:
      return [];
  }
}

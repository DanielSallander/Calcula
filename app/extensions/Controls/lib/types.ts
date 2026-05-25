//! FILENAME: app/extensions/Controls/lib/types.ts
// PURPOSE: TypeScript type definitions for the Controls extension.
// CONTEXT: Mirrors Rust controls.rs types for frontend use.

import { SHAPE_PROPERTIES, getShapePropertiesWithDeclared } from "../Shape/shapeProperties";
import { IMAGE_PROPERTIES } from "../Image/imageProperties";

// ============================================================================
// Control Property Types
// ============================================================================

/** A single property value: either a static value or a formula. */
export interface ControlPropertyValue {
  /** "static" or "formula" */
  valueType: "static" | "formula";
  /** The static value or formula string (formulas start with "=") */
  value: string;
}

/** Metadata for a control instance at a specific cell. */
export interface ControlMetadata {
  /** Control type identifier: "button", "checkbox", etc. */
  controlType: string;
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
  inputType: "text" | "color" | "number" | "script" | "code" | "boolean";
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
    default:
      return [];
  }
}

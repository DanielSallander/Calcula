//! FILENAME: app/extensions/Controls/Shape/shapeProperties.ts
// PURPOSE: Property definitions for Shape controls.
// CONTEXT: Used by PropertiesPane to render shape property editors.

import type { PropertyDefinition } from "../lib/types";
import type { DeclaredProperty } from "../../../src/api/scriptableObjects";

// ============================================================================
// Script-Declared Properties (runtime)
// ============================================================================

/** Map of controlId -> declared properties from shape scripts. */
const declaredPropertiesMap = new Map<string, DeclaredProperty[]>();

/** Set declared properties for a shape instance (called from script runtime). */
export function setDeclaredProperties(instanceId: string, props: DeclaredProperty[]): void {
  declaredPropertiesMap.set(instanceId, props);
}

/** Get declared properties for a shape instance. */
export function getDeclaredProperties(instanceId: string): DeclaredProperty[] {
  return declaredPropertiesMap.get(instanceId) || [];
}

/** Clear declared properties for a shape instance (on script unmount). */
export function clearDeclaredProperties(instanceId: string): void {
  declaredPropertiesMap.delete(instanceId);
}

/**
 * Get shape properties with any script-declared properties merged in.
 * Declared properties appear in a "Custom" group at the end.
 */
export function getShapePropertiesWithDeclared(instanceId?: string): PropertyDefinition[] {
  if (!instanceId) return SHAPE_PROPERTIES;

  const declared = declaredPropertiesMap.get(instanceId);
  if (!declared || declared.length === 0) return SHAPE_PROPERTIES;

  const customDefs: PropertyDefinition[] = declared.map((d) => ({
    key: d.key,
    label: d.label,
    inputType: d.type === "boolean" ? "boolean" : d.type === "color" ? "color" : d.type === "number" ? "number" : "text",
    defaultValue: d.defaultValue || "",
    supportsFormula: d.type !== "boolean",
    group: "Custom",
  }));

  return [...SHAPE_PROPERTIES, ...customDefs];
}

// ============================================================================
// Static Property Definitions
// ============================================================================

/** All property definitions for a Shape control. */
export const SHAPE_PROPERTIES: PropertyDefinition[] = [
  // -- Shape Identity --
  {
    key: "shapeType",
    label: "Shape Type",
    inputType: "text",
    defaultValue: "rectangle",
    supportsFormula: false,
    group: "Shape",
  },

  // -- Fill & Stroke --
  {
    key: "fill",
    label: "Fill",
    inputType: "color",
    defaultValue: "#4472C4",
    supportsFormula: true,
    group: "Fill & Outline",
  },
  {
    key: "stroke",
    label: "Outline",
    inputType: "color",
    defaultValue: "#2F528F",
    supportsFormula: true,
    group: "Fill & Outline",
  },
  {
    key: "strokeWidth",
    label: "Outline Width",
    inputType: "number",
    defaultValue: "1",
    supportsFormula: true,
    group: "Fill & Outline",
    min: 0,
    max: 10,
    step: 0.5,
  },

  // -- Text --
  {
    key: "text",
    label: "Text",
    inputType: "text",
    defaultValue: "",
    supportsFormula: true,
    group: "Text",
  },
  {
    key: "textColor",
    label: "Color",
    inputType: "color",
    defaultValue: "#FFFFFF",
    supportsFormula: true,
    group: "Text",
  },
  {
    key: "fontSize",
    label: "Size",
    inputType: "number",
    defaultValue: "11",
    supportsFormula: true,
    group: "Text",
    min: 6,
    max: 72,
    step: 1,
  },
  {
    key: "fontBold",
    label: "Bold",
    inputType: "boolean",
    defaultValue: "false",
    supportsFormula: false,
    group: "Text",
    inline: true,
  },
  {
    key: "fontItalic",
    label: "Italic",
    inputType: "boolean",
    defaultValue: "false",
    supportsFormula: false,
    group: "Text",
    inline: true,
  },

  // -- Transform --
  {
    key: "opacity",
    label: "Opacity",
    inputType: "number",
    defaultValue: "1",
    supportsFormula: true,
    group: "Transform",
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: "rotation",
    label: "Rotation",
    inputType: "number",
    defaultValue: "0",
    supportsFormula: true,
    group: "Transform",
    min: 0,
    max: 360,
    step: 1,
  },
  {
    key: "flipH",
    label: "Flip Horizontal",
    inputType: "boolean",
    defaultValue: "false",
    supportsFormula: false,
    group: "Transform",
    inline: true,
  },
  {
    key: "flipV",
    label: "Flip Vertical",
    inputType: "boolean",
    defaultValue: "false",
    supportsFormula: false,
    group: "Transform",
    inline: true,
  },

  // -- Size --
  {
    key: "width",
    label: "Width",
    inputType: "number",
    defaultValue: "120",
    supportsFormula: true,
    group: "Size",
    inline: true,
  },
  {
    key: "height",
    label: "Height",
    inputType: "number",
    defaultValue: "80",
    supportsFormula: true,
    group: "Size",
    inline: true,
  },
];

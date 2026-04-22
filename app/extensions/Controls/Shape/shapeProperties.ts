//! FILENAME: app/extensions/Controls/Shape/shapeProperties.ts
// PURPOSE: Property definitions for Shape controls.
// CONTEXT: Used by PropertiesPane to render shape property editors.

import type { PropertyDefinition } from "../lib/types";

/** All property definitions for a Shape control. */
export const SHAPE_PROPERTIES: PropertyDefinition[] = [
  // -- Shape Identity --
  {
    key: "shapeType",
    label: "Shape Type",
    inputType: "text",
    defaultValue: "rectangle",
    supportsFormula: false,
  },

  // -- Fill & Stroke --
  {
    key: "fill",
    label: "Fill",
    inputType: "color",
    defaultValue: "#4472C4",
    supportsFormula: true,
  },
  {
    key: "stroke",
    label: "Outline",
    inputType: "color",
    defaultValue: "#2F528F",
    supportsFormula: true,
  },
  {
    key: "strokeWidth",
    label: "Outline Width",
    inputType: "number",
    defaultValue: "1",
    supportsFormula: true,
  },

  // -- Text --
  {
    key: "text",
    label: "Text",
    inputType: "text",
    defaultValue: "",
    supportsFormula: true,
  },
  {
    key: "textColor",
    label: "Text Color",
    inputType: "color",
    defaultValue: "#FFFFFF",
    supportsFormula: true,
  },
  {
    key: "fontSize",
    label: "Font Size",
    inputType: "number",
    defaultValue: "11",
    supportsFormula: true,
  },
  {
    key: "fontBold",
    label: "Bold",
    inputType: "boolean",
    defaultValue: "false",
    supportsFormula: false,
  },
  {
    key: "fontItalic",
    label: "Italic",
    inputType: "boolean",
    defaultValue: "false",
    supportsFormula: false,
  },

  // -- Layout --
  {
    key: "opacity",
    label: "Opacity",
    inputType: "number",
    defaultValue: "1",
    supportsFormula: true,
  },
  {
    key: "rotation",
    label: "Rotation",
    inputType: "number",
    defaultValue: "0",
    supportsFormula: true,
  },
  {
    key: "flipH",
    label: "Flip Horizontal",
    inputType: "boolean",
    defaultValue: "false",
    supportsFormula: false,
  },
  {
    key: "flipV",
    label: "Flip Vertical",
    inputType: "boolean",
    defaultValue: "false",
    supportsFormula: false,
  },

  {
    key: "width",
    label: "Width",
    inputType: "number",
    defaultValue: "120",
    supportsFormula: true,
  },
  {
    key: "height",
    label: "Height",
    inputType: "number",
    defaultValue: "80",
    supportsFormula: true,
  },
];

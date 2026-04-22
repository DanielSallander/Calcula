//! FILENAME: app/extensions/Controls/Image/imageProperties.ts
// PURPOSE: Property definitions for Image controls.
// CONTEXT: Used by PropertiesPane to render image property editors.

import type { PropertyDefinition } from "../lib/types";

/** All property definitions for an Image control. */
export const IMAGE_PROPERTIES: PropertyDefinition[] = [
  // -- Source --
  {
    key: "src",
    label: "Source",
    inputType: "text",
    defaultValue: "",
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
    defaultValue: "200",
    supportsFormula: true,
  },
  {
    key: "height",
    label: "Height",
    inputType: "number",
    defaultValue: "150",
    supportsFormula: true,
  },
];

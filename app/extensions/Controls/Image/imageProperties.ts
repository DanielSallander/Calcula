//! FILENAME: app/extensions/Controls/Image/imageProperties.ts
// PURPOSE: Property definitions for Image controls.
// CONTEXT: Used by PropertiesPane to render image property editors.

import type { PropertyDefinition } from "../lib/types";

/** All property definitions for an Image control. */
export const IMAGE_PROPERTIES: PropertyDefinition[] = [
  // -- Source --
  //
  // READ-ONLY, deliberately. `src` holds a `media:{sha256}` handle the host
  // issued for bytes it read and validated itself; it is not text a user
  // authors. As a free-text box this was a hole with no bottom: anyone could
  // type `https://tracker.example/pixel.gif` into a document property and get a
  // beacon that fires on every open, on every machine the file reaches — with
  // the CSP's `img-src 'self' data: blob:` as the ONLY thing stopping it. A
  // security control that exists in one line of `tauri.conf.json` and nowhere
  // else is not a control, it is a coincidence. The picture is chosen through
  // Insert > Image, which is the one door that validates.
  {
    key: "src",
    label: "Source",
    inputType: "text",
    defaultValue: "",
    supportsFormula: false,
    group: "Image",
    readOnly: true,
    readOnlyHint:
      "Set by Insert > Image. The picture is stored inside this document and " +
      "referenced by content hash.",
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
    defaultValue: "200",
    supportsFormula: true,
    group: "Size",
    inline: true,
  },
  {
    key: "height",
    label: "Height",
    inputType: "number",
    defaultValue: "150",
    supportsFormula: true,
    group: "Size",
    inline: true,
  },
  {
    key: "pinToGrid",
    label: "Pin to grid",
    inputType: "boolean",
    // Shapes and images are always floating, so they hold a pixel position by
    // default and only follow the grid when the user pins them.
    defaultValue: "false",
    supportsFormula: false,
    group: "Layout",
  },
];

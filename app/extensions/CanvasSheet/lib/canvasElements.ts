//! FILENAME: app/extensions/CanvasSheet/lib/canvasElements.ts
// PURPOSE: What the Canvas tab's ELEMENTS menus list (CONTRACT-CANVAS section
//          3; Power BI's Insert > Elements): the Shapes menu's two headed
//          groups in Power BI's order and words, the Buttons menu's rows, and
//          the one door Run Macro... opens.
// CONTEXT: Pure data plus the macro door. The menus themselves are drawn by
//          components/CanvasElementsSection.tsx.
//
//          SHAPES. Power BI's shapes menu (April 2021) names its own rows --
//          "Speech bubble", "Tab: rounded top corners" -- and draws each one's
//          outline. The rows here are those names over Calcula's catalog ids
//          (Controls/Shape/shapeCatalog.ts, reached ONLY through
//          @api/controlsService `listShapeCatalog`), and the picture of each
//          row is the catalog's OWN geometry (`ShapeCatalogEntry.thumbnail`,
//          CONTRACT 4.3) -- never a copied drawing, which would be a second
//          source of truth. A row whose id the catalog does not hold (a
//          provider without it) is left out, never shown dead. Power BI's
//          "Pill" has no catalog shape and is left out; "Speech bubble" is the
//          rounded rectangular callout, its nearest.
//
//          RUN MACRO... is "the existing macroRef flow" (contract section 3):
//          a macro-LINKED button is made by Developer > Macros (the Macro
//          Recorder's library), whose "Add button" links the chosen macro by
//          id. The Canvas tab opens that dialog by its public command id -- a
//          registry address, like the "chart:createDialog" dialog id
//          insertOnCanvas opens -- and never builds a macroRef button itself.

import { CommandRegistry } from "@api/commands";

/** One Shapes-menu row: Power BI's name over a catalog id. */
export interface ShapeMenuRow {
  /** The catalog id (`createShape`'s shapeType; the `canvas-shapes-<id>` suffix). */
  id: string;
  /** Power BI's name for it. */
  label: string;
}

/** Shapes v > Basic shapes, in Power BI's order (contract section 3). */
export const BASIC_SHAPE_ROWS: readonly ShapeMenuRow[] = [
  { id: "rectangle", label: "Rectangle" },
  { id: "roundedRectangle", label: "Rounded rectangle" },
  { id: "oval", label: "Oval" },
  { id: "line", label: "Line" },
  { id: "isoscelesTriangle", label: "Isosceles triangle" },
  { id: "rightTriangle", label: "Right triangle" },
  { id: "parallelogram", label: "Parallelogram" },
  { id: "trapezoid", label: "Trapezoid" },
  { id: "diamond", label: "Diamond" },
  { id: "pentagon", label: "Pentagon" },
  { id: "hexagon", label: "Hexagon" },
  { id: "octagon", label: "Octagon" },
  { id: "heart", label: "Heart" },
  { id: "roundedRectangularCallout", label: "Speech bubble" },
  { id: "roundSameSide", label: "Tab: rounded top corners" },
  { id: "snipSameSide", label: "Tab: snipped top corners" },
];

/** Shapes v > Arrows, in Power BI's order (contract section 3). */
export const ARROW_SHAPE_ROWS: readonly ShapeMenuRow[] = [
  { id: "rightArrow", label: "Right arrow" },
  { id: "leftArrow", label: "Left arrow" },
  { id: "upArrow", label: "Up arrow" },
  { id: "downArrow", label: "Down arrow" },
  { id: "homePentagon", label: "Pentagon arrow" },
  { id: "chevron", label: "Chevron" },
];

/**
 * The Macro Recorder's "Developer > Macros" command (its macro library, whose
 * "Add button" links a macro to a new button). A command id is a registry
 * address any extension may execute; the Canvas tab never imports the Macro
 * Recorder.
 */
export const MACRO_LIBRARY_COMMAND = "macroRecorder.library";

/** Whether Run Macro... can open anything (the Macro Recorder is loaded). */
export function canOpenMacroLibrary(): boolean {
  return CommandRegistry.has(MACRO_LIBRARY_COMMAND);
}

/** Buttons v > Run Macro...: open the macro library (see the header). */
export async function openMacroLibrary(): Promise<void> {
  await CommandRegistry.execute(MACRO_LIBRARY_COMMAND);
}

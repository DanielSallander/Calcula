//! FILENAME: app/extensions/ScriptableObjects/components/formDesigner/widgetPalette.ts
// PURPOSE: The kinds of widget the designer can add, and the widget each one
//          becomes the moment it lands.
// CONTEXT: M5b of docs/design/typescript-forms.md §14.
//
//          EVERY DEFAULT MUST ALREADY BE LEGAL. A dropped widget is written
//          into the user's script immediately (there is nowhere else to put it
//          — ONE ARTIFACT), and `writeFormRegion` runs `checkFormSpec` BEFORE
//          it writes. So a default that is missing a required member is not a
//          placeholder the user fills in later: it is a drop that refuses with
//          a validator message the user did not cause. The defaults below
//          therefore carry every member the validator demands — a radio's
//          options, a table's columns, a grid's column count, a tabs widget's
//          first page — and nothing else, so the emitted line stays short.
//
//          A NAME IS MINTED, NOT ASKED FOR. Inputs, buttons and progress bars
//          MUST carry a unique identifier, and a drop that opened a naming
//          prompt would be a modal in the middle of a drag. The palette mints
//          `textbox`, `textbox2`, … from the names already in the form
//          (`uniqueWidgetName`), and the property panel is where it gets a
//          better one.

import {
  FORM_WIDGET_TYPES,
  type FormSpec,
  type FormWidget,
  type FormWidgetType,
} from "@api/scriptHost/scriptFormSpec";

import { uniqueWidgetName } from "./designerModel";

export interface PaletteEntry {
  type: FormWidgetType;
  /** What the palette button says. */
  label: string;
  /** One line of what it is for, shown as the button's title. */
  hint: string;
  /** Palette section, so nineteen buttons read as four short groups. */
  group: "Input" | "Choice" | "Layout" | "Display";
}

export const WIDGET_PALETTE: readonly PaletteEntry[] = [
  { type: "textbox", label: "Text box", hint: "A single- or multi-line text field", group: "Input" },
  { type: "number", label: "Number", hint: "A numeric field with optional min, max and step", group: "Input" },
  { type: "date", label: "Date", hint: "A date field", group: "Input" },
  { type: "checkbox", label: "Check box", hint: "A true/false box", group: "Input" },
  { type: "toggle", label: "Toggle", hint: "A true/false switch", group: "Input" },
  { type: "dropdown", label: "Drop-down", hint: "One choice from a list", group: "Choice" },
  { type: "radio", label: "Radio group", hint: "One choice, all options visible", group: "Choice" },
  { type: "listbox", label: "List box", hint: "One or many choices from a scrolling list", group: "Choice" },
  { type: "group", label: "Group", hint: "A titled box around other widgets", group: "Layout" },
  { type: "row", label: "Row", hint: "Lays its children out side by side", group: "Layout" },
  { type: "column", label: "Column", hint: "Lays its children out stacked", group: "Layout" },
  { type: "grid", label: "Grid", hint: "Lays its children out in columns", group: "Layout" },
  { type: "tabs", label: "Tabs", hint: "Pages the user switches between", group: "Layout" },
  { type: "spacer", label: "Spacer", hint: "Empty vertical space", group: "Layout" },
  { type: "label", label: "Label", hint: "A line of text", group: "Display" },
  { type: "button", label: "Button", hint: "A button your script hears through onClick", group: "Display" },
  { type: "image", label: "Image", hint: "A picture already stored in this workbook", group: "Display" },
  { type: "table", label: "Table", hint: "A read-only table of rows", group: "Display" },
  { type: "progress", label: "Progress", hint: "A progress bar your script advances", group: "Display" },
];

/** The palette covers every declared widget type except the reserved `html`. */
export const PALETTE_TYPES: ReadonlySet<string> = new Set(WIDGET_PALETTE.map((e) => e.type));

/** Types `FORM_WIDGET_TYPES` declares that the palette deliberately omits. */
export const PALETTE_OMITTED: readonly string[] = FORM_WIDGET_TYPES.filter((t) => !PALETTE_TYPES.has(t));

/**
 * The widget a palette entry becomes, named uniquely within `spec`.
 *
 * Pure: it reads the names already in the form and returns a new object.
 */
export function newWidgetOfType(type: FormWidgetType, spec: FormSpec): FormWidget {
  const name = (base: string): string => uniqueWidgetName(spec, base);
  switch (type) {
    case "label":
      return { type: "label", text: "Text" };
    case "textbox":
      return { type: "textbox", name: name("textbox"), label: "Text" };
    case "number":
      return { type: "number", name: name("number"), label: "Number" };
    case "date":
      return { type: "date", name: name("date"), label: "Date" };
    case "checkbox":
      return { type: "checkbox", name: name("checkbox"), label: "Check box" };
    case "toggle":
      return { type: "toggle", name: name("toggle"), label: "Toggle" };
    case "radio":
      return {
        type: "radio",
        name: name("radio"),
        label: "Choice",
        options: ["Option 1", "Option 2"],
      };
    case "dropdown":
      return {
        type: "dropdown",
        name: name("dropdown"),
        label: "Choice",
        options: ["Option 1", "Option 2"],
      };
    case "listbox":
      return {
        type: "listbox",
        name: name("listbox"),
        label: "Choices",
        options: ["Option 1", "Option 2"],
      };
    case "button":
      return { type: "button", name: name("button"), text: "Button" };
    case "group":
      return { type: "group", title: "Group", children: [] };
    case "tabs":
      return { type: "tabs", pages: [{ title: "Page 1", children: [] }] };
    case "row":
      return { type: "row", children: [] };
    case "column":
      return { type: "column", children: [] };
    case "grid":
      return { type: "grid", columns: 2, children: [] };
    case "spacer":
      return { type: "spacer", size: 8 };
    case "image":
      // "" is the ONLY src a designer may write: a script (and therefore its
      // designer) may REFERENCE media already in the workbook, never introduce
      // bytes, and the handle for an existing picture is typed in afterwards.
      return { type: "image", src: "", alt: "Image" };
    case "table":
      return { type: "table", columns: ["Column 1"], rows: [] };
    case "progress":
      return { type: "progress", name: name("progress"), value: 0 };
    default:
      return { type: "label", text: "Text" };
  }
}

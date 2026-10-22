//! FILENAME: app/src/api/__tests__/ribbonIcons.test.tsx
// PURPOSE: Pin the RibbonIcon namespace (keys only grow; the 34 historical keys
//          are frozen) and hold every drawing in it to the duotone set's rules.
// CONTEXT: RibbonIcon is a contract with three kinds of caller: homeTabIcons
//          (persisted item ids), AddInsRibbonSection (sandboxed add-in icon
//          TOKENS resolved as `keyof typeof RibbonIcon`) and the HomeTab tests'
//          Proxy mocks. A key that disappears breaks an installed add-in
//          silently — it falls back to the generic glyph — so the frozen list
//          below is typed out here, independently of the source, on purpose.
//
//          The rendering checks are the rules from icons/frame.tsx made
//          executable: a 24-unit viewBox, no <text>, no colour literal, every
//          paint one of the four channels, never both ACCENT and DANGER, and no
//          free-standing stroke thinner than the 3-unit rule allows.
//
//          Excel's Home tab (2026-10-04) added 60 keys whose menus show many
//          pictures side by side (13 border presets, 12 paste options, four Fill
//          directions, six orientations). The "menu families" block below holds
//          each such menu to the rule ICONS.md 2.3 states in words: two rows of
//          one menu never show the same drawing.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as fs from "fs";
import * as path from "path";
import { RibbonIcon, type RibbonIconProps } from "../ribbonIcons";
import {
  HOME_ICONS,
  CHART_ICONS,
  DATA_ICONS,
  GENERIC_ICONS,
  IconFrame,
  SOFT,
  STRONG,
  ACCENT,
  DANGER,
  MIN_STROKE,
  PIXEL_STROKE,
  PIXEL_GRID,
} from "../icons";
import { findHardcodedColours } from "../layout/testing";
import { VISUALS_FAMILY_GAPS } from "../../../scripts/icon-accent-contact.mjs";

/** The 34 keys that existed before the duotone redraw. Typed out, not
 *  imported: the point is to fail if the SOURCE drops one. */
const FROZEN_KEYS = [
  "Cut",
  "Copy",
  "Paste",
  "FormatPainter",
  "FontSizeUp",
  "FontSizeDown",
  "FormatCells",
  "FillColor",
  "AlignTop",
  "AlignMiddle",
  "AlignBottom",
  "AlignLeft",
  "AlignCenter",
  "AlignRight",
  "WrapText",
  "IndentIncrease",
  "IndentDecrease",
  "MergeCells",
  "Percent",
  "Comma",
  "NumberFormat",
  "DecimalIncrease",
  "DecimalDecrease",
  "CellStyles",
  "InsertRow",
  "InsertColumn",
  "DeleteRow",
  "DeleteColumn",
  "Undo",
  "Redo",
  "Find",
  "ClearContents",
  "ClearFormatting",
  "ClearAll",
] as const;

/** Every key the Calcula Clusters contract adds. Also typed out: consumers
 *  are being written against these names in parallel. */
const CONTRACT_KEYS = [
  // chart family
  "ChartColumn", "ChartBar", "ChartLine", "ChartArea", "ChartPie", "ChartDonut",
  "ChartScatter", "ChartWaterfall", "ChartCombo", "ChartRadar", "ChartBubble",
  "ChartHistogram", "ChartFunnel", "ChartTreemap", "ChartStock", "ChartBoxPlot",
  "ChartSunburst", "ChartPareto",
  // chart furniture / actions
  "ChartTitle", "Gridlines", "Legend", "AxisLabels", "DataLabels", "Grouped",
  "Stacked", "Stacked100", "SecondaryAxis", "Trendline", "MarkOptions",
  "LineStraight", "LineSmooth", "LineStep", "Markers", "Palette", "Series",
  "Filter", "SwitchRowCol", "EditChart", "SaveImage", "FormatPoint", "Code",
  // generic
  "Group", "More", "MoreHorizontal", "Close", "ChevronUp", "ChevronDown",
  "ChevronLeft", "ChevronRight", "Check", "Plus", "Minus", "Refresh", "Delete",
  "Settings", "Sidebar", "Ribbon", "Pencil", "Layout", "Text", "Pointer", "Play",
  "Pause", "Stop", "StepForward", "StepBack", "Loop", "Resize", "Keyboard",
  "Image", "Info", "Warn", "Error", "Success", "Link", "Lock", "Eye", "Download",
  "Upload", "Sort", "Calendar", "Clock", "Search", "Script", "Model", "Panel",
  "Controls", "Database", "Folder", "Save",
  // home extras
  "Superscript", "Subscript", "FontColor", "Replace",
  // Excel's Merge menu (2026-10-02; the plain merge is the frozen MergeCells)
  "MergeCenter", "MergeAcross", "UnmergeCells",
  // data / BI / page layout
  "Table", "Pivot", "PivotFields", "CalcField", "FilterPages", "Fx",
  "ChangeSource", "Slicer", "Timeline", "Sparkline", "SparkLine", "SparkColumn",
  "SparkWinLoss", "Report", "Lightning", "Theme", "Fonts", "Colors", "Effects",
  "Margins", "Orientation", "PageSize", "PrintArea", "Breaks", "Background",
  "TableStyle", "BandedRows", "BandedColumns", "HeaderRow", "TotalRow",
  "FirstColumn", "LastColumn", "FilterButton", "Subtotals", "GrandTotals",
  "ReportLayout", "BlankRows", "Expand", "Collapse", "ClearFilter", "Connection",
  // Excel's Home tab (2026-10-04; docs/design/ICONS.md section 4). Typed out
  // for the same reason as the rest: the Home groups are being written
  // against these names in parallel.
  // - alignment: Excel's orientation menu, and the CANVAS menu's object
  //   alignment (the pre-2026-10-04 AlignTop/Middle/Bottom drawings)
  "TextOrientation", "AngleCounterclockwise", "AngleClockwise", "VerticalText",
  "RotateTextUp", "RotateTextDown", "ObjectAlignTop", "ObjectAlignMiddle",
  "ObjectAlignBottom",
  // - the Canvas Align menu's horizontal rows, added by the same day's icon
  //   review: Left / Center / Right drew the TEXT paragraph pictures beside
  //   the object pictures of Top / Middle / Bottom
  "ObjectAlignLeft", "ObjectAlignCenter", "ObjectAlignRight",
  // - cells
  "InsertCells", "DeleteCells", "FormatMenu", "InsertSheet", "DeleteSheet",
  "RowHeight", "ColumnWidth", "RenameSheet", "ProtectSheet",
  // - font: the Underline split and the Borders split
  "Underline", "DoubleUnderline", "BorderBottom", "BorderTop", "BorderLeft",
  "BorderRight", "BorderNone", "BorderAll", "BorderOutside", "BorderThickOutside",
  "BorderDoubleBottom", "BorderThickBottom", "BorderTopBottom",
  "BorderTopThickBottom", "BorderTopDoubleBottom", "LineColor",
  // - clipboard: the Paste split's options
  "PasteFormulas", "PasteFormulasNumberFormats", "PasteKeepSourceFormatting",
  "PasteNoBorders", "PasteColumnWidths", "PasteTranspose", "PasteValues",
  "PasteValuesNumberFormats", "PasteValuesSourceFormatting", "PasteFormatting",
  "PasteLink", "PasteSpecial",
  // - number and styles
  "Accounting", "ConditionalFormatting", "FormatAsTable",
  // - editing
  "AutoSum", "FillDown", "FillRight", "FillUp", "FillLeft", "Clear",
  "RemoveHyperlinks", "SortFilter", "SortAscending", "SortDescending", "GoTo",
  // Power BI's report authoring on the Canvas tab (2026-10-08; ICONS.md
  // section 4). Typed out because the Canvas tab, the Charts gallery and the
  // Controls button menu are written against these names in parallel.
  // - the Visuals gallery: chart variants, the new visuals and its hero
  "ChartBarStacked", "ChartBarStacked100", "ChartAreaStacked", "ChartAreaStacked100",
  "ChartComboStacked", "ChartCard", "ChartMultiRowCard", "ChartKpi", "ChartGauge",
  "AllVisuals", "Matrix",
  // - Pages and Elements, and the Buttons menu's rows
  "NewPage", "Shapes", "ButtonControl", "FloatingGrid", "PageNavigator", "NavigateBack",
  "ClearSlicers",
  // - Arrange, Page and View
  "SizePosition", "FitToPage", "FitToWidth", "ActualSize", "SnapToGrid", "ShowGrid",
  "LockObjects", "DesignMode", "Wallpaper",
] as const;

/**
 * The pictures that sit side by side in one menu or one pill. Each family must
 * be N DRAWINGS: no key is an alias of another (`toBe`), and no two render the
 * same markup. A shared picture would show the same icon on two rows of the
 * same menu for two different commands -- the "one icon used twice" failure
 * of ICONS.md 2.3, which the Merge test below pinned first for its four rows.
 */
/* eslint-disable @typescript-eslint/naming-convention -- the family names are the human labels it.each prints in each test's title ("Sort & Filter: every key is its own drawing"), not identifiers. */
const MENU_FAMILIES: Readonly<Record<string, readonly (keyof typeof RibbonIcon)[]>> = {
  // Font > Borders: the 13 presets, Line Color, and More Borders (= BorderAll).
  Borders: [
    "BorderBottom", "BorderTop", "BorderLeft", "BorderRight", "BorderNone", "BorderAll",
    "BorderOutside", "BorderThickOutside", "BorderDoubleBottom", "BorderThickBottom",
    "BorderTopBottom", "BorderTopThickBottom", "BorderTopDoubleBottom", "LineColor",
  ],
  // Font > Underline: the face is the letter; the two rows are drawings.
  Underline: ["Underline", "DoubleUnderline"],
  // Clipboard > Paste: the face and its twelve options.
  Paste: [
    "Paste", "PasteFormulas", "PasteFormulasNumberFormats", "PasteKeepSourceFormatting",
    "PasteNoBorders", "PasteColumnWidths", "PasteTranspose", "PasteValues",
    "PasteValuesNumberFormats", "PasteValuesSourceFormatting", "PasteFormatting",
    "PasteLink", "PasteSpecial",
  ],
  // Alignment: the vertical pill sits right above the horizontal one.
  Alignment: ["AlignTop", "AlignMiddle", "AlignBottom", "AlignLeft", "AlignCenter", "AlignRight", "WrapText"],
  // Alignment > Orientation: the face (= the Format Cell Alignment row) and five rows.
  Orientation: [
    "TextOrientation", "AngleCounterclockwise", "AngleClockwise", "VerticalText",
    "RotateTextUp", "RotateTextDown",
  ],
  // Canvas > Align: the menu's face and its six rows, and the text alignments
  // they must not be confused with.
  "Object alignment": [
    "AlignObjects", "ObjectAlignLeft", "ObjectAlignCenter", "ObjectAlignRight",
    "ObjectAlignTop", "ObjectAlignMiddle", "ObjectAlignBottom",
    "AlignLeft", "AlignCenter", "AlignRight", "AlignTop", "AlignMiddle", "AlignBottom",
  ],
  // Cells: the Insert, Delete and Format heroes and every row of their menus.
  Cells: [
    "InsertCells", "InsertRow", "InsertColumn", "InsertSheet", "DeleteCells", "DeleteRow",
    "DeleteColumn", "DeleteSheet", "FormatMenu", "RowHeight", "ColumnWidth", "RenameSheet",
    "ProtectSheet", "Lock", "FormatCells",
  ],
  // Styles: the three heroes, and the table pictures they sit beside.
  Styles: ["ConditionalFormatting", "FormatAsTable", "CellStyles", "TableStyle", "Table"],
  // Number: the Accounting split beside the drawn number keys.
  Number: ["Accounting", "NumberFormat", "Percent", "Comma", "DecimalIncrease", "DecimalDecrease"],
  // Editing > Fill: four directions, Flash Fill.
  Fill: ["FillDown", "FillRight", "FillUp", "FillLeft", "Lightning"],
  // Editing > Clear: the face (= the Clear All row: Excel shows its eraser for
  // both) and the menu's other pictured rows, Clear Formats and Remove
  // Hyperlinks. Then the Clear pictures the menu does NOT show, so that none
  // can stand in for a row: ClearContents (the catalog's Clear Contents
  // button), the frozen ClearAll (a STACK of cells with a red X; the menu's
  // Clear All row is the eraser, so ClearAll is no longer Excel's picture for
  // that command) and Link (the chain Remove Hyperlinks draws whole).
  Clear: ["Clear", "ClearFormatting", "RemoveHyperlinks", "ClearContents", "ClearAll", "Link"],
  // Editing > Sort & Filter.
  "Sort & Filter": ["SortFilter", "SortAscending", "SortDescending", "Sort", "Filter", "ClearFilter", "Refresh"],
  // Editing > Find & Select.
  "Find & Select": ["Find", "Replace", "GoTo"],
  // Editing: AutoSum's face beside the menu faces.
  Editing: ["AutoSum", "FillDown", "Clear", "SortFilter", "Find"],
  // The two colour splits: the host paints the colour, so the glyphs differ by shape.
  Colour: ["FillColor", "FontColor", "LineColor"],
  // ---- The Canvas tab: Power BI's report authoring (2026-10-08) ------------
  // The Visuals gallery: every tile of the card popover (Power BI's pane order,
  // then the new visuals, the table tiles and Calcula's extra charts) and the
  // All Visuals hero that opens it. Thirty-four pictures on one surface; two
  // that drew the same thing would be one visual offered twice.
  "Visuals gallery": [
    "ChartBarStacked", "Stacked", "ChartBar", "ChartColumn", "ChartBarStacked100", "Stacked100",
    "ChartLine", "ChartArea", "ChartAreaStacked", "ChartAreaStacked100", "ChartComboStacked", "ChartCombo",
    "ChartWaterfall", "ChartFunnel", "ChartScatter", "ChartPie", "ChartDonut", "ChartTreemap", "ChartGauge",
    "ChartCard", "ChartMultiRowCard", "ChartKpi",
    "Matrix", "Table", "Slicer", "Timeline",
    "ChartRadar", "ChartBubble", "ChartHistogram", "ChartStock", "ChartBoxPlot", "ChartSunburst", "ChartPareto",
    "AllVisuals",
  ],
  // The grid-shaped things a report page can hold, side by side on one tab:
  // the Matrix and Table tiles, the Floating Grid hero, and the pivot pictures
  // Matrix must not be confused with (Pivot is Insert > PivotTable's face;
  // GrandTotals IS Power BI's matrix picture, already taken by the pivot
  // option, which is why Matrix merges its totals into one L).
  "Canvas grids": ["Matrix", "Table", "FloatingGrid", "Pivot", "GrandTotals", "HeaderRow"],
  // Pages > New Page: a report page, not Home's worksheet insert or More's tiles.
  Pages: ["NewPage", "InsertSheet", "Report", "More"],
  // Elements: the five heroes, and the faces they replaced on 2026-10-08
  // (Layout drew Shape, Controls drew Button, Table drew Floating Grid).
  Elements: ["Text", "ButtonControl", "Shapes", "Image", "FloatingGrid", "Layout", "Controls", "Table"],
  // Elements > Buttons: the menu's rows, and the pictures each must not echo.
  Buttons: ["ButtonControl", "PageNavigator", "NavigateBack", "ClearSlicers", "ClearFilter", "Slicer", "Undo", "Controls"],
  // Arrange: the menus' faces and the toggles beside them. Resize drew Size &
  // Position until 2026-10-08, and the same picture also drew Fit to Window.
  Arrange: [
    "BringForward", "SendBackward", "BringToFront", "SendToBack", "AlignObjects", "Lock",
    "SizePosition", "Resize", "LockObjects",
  ],
  // Page: the page-size face and the two colour splits (Page Background,
  // Wallpaper), the Themes gallery face, and the page-view face beside them.
  Page: ["PageSize", "Background", "Wallpaper", "Theme", "FitToPage"],
  // View > Page View: the face (= Fit to Page) and its three radio rows, and
  // the pictures Fit to Window and Actual Size borrowed until 2026-10-08.
  "Page view": ["FitToPage", "FitToWidth", "ActualSize", "Resize", "Search"],
  // View: the grid toggles and Design Mode, and the pictures they replaced
  // (chart Gridlines drew Snap to Grid, Pencil drew Design Mode) or sit
  // beside (Arrange's Lock; Home's ProtectSheet, the known look-alike).
  View: ["ShowGrid", "SnapToGrid", "LockObjects", "DesignMode", "Gridlines", "Pencil", "Lock", "ProtectSheet"],
  // Edit interactions (P4, 2026-10-17): the Arrange hero, the three buttons
  // it puts on every other visual (side by side in one strip), and the
  // pictures they must not echo (Filter's funnel, the plain column chart,
  // Arrange's neighbours).
  "Edit interactions": [
    "EditInteractions", "InteractionFilter", "InteractionHighlight", "InteractionNone",
    "Filter", "ClearFilter", "ChartColumn", "Stacked", "AlignObjects", "BringForward",
  ],
};
/* eslint-enable @typescript-eslint/naming-convention */

const CHANNELS = new Set<string>([SOFT, STRONG, ACCENT, DANGER]);
const ALL_KEYS = Object.keys(RibbonIcon) as Array<keyof typeof RibbonIcon>;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

function renderIcon(key: keyof typeof RibbonIcon, props: RibbonIconProps = {}): SVGSVGElement {
  const Icon = RibbonIcon[key];
  act(() => {
    root.render(<Icon {...props} />);
  });
  const svg = container.querySelector("svg");
  if (!svg) throw new Error(`${key} rendered no <svg>`);
  return svg;
}

/** The painted shapes of an icon: every descendant of the root <svg> that is
 *  not a grouping or metadata element. */
function shapesOf(svg: SVGSVGElement): Element[] {
  return Array.from(svg.querySelectorAll("*")).filter(
    (el) => !["g", "title", "defs"].includes(el.tagName.toLowerCase()),
  );
}

// ============================================================================
// The namespace
// ============================================================================

describe("RibbonIcon namespace", () => {
  it("keeps every one of the 34 frozen keys", () => {
    const missing = FROZEN_KEYS.filter((k) => !(k in RibbonIcon));
    expect(missing).toEqual([]);
  });

  it("has every key the Clusters contract adds", () => {
    const missing = CONTRACT_KEYS.filter((k) => !(k in RibbonIcon));
    expect(missing).toEqual([]);
  });

  it("has at least 140 keys", () => {
    expect(ALL_KEYS.length).toBeGreaterThanOrEqual(140);
  });

  it("every key is a component (a function)", () => {
    const notComponents = ALL_KEYS.filter((k) => typeof RibbonIcon[k] !== "function");
    expect(notComponents).toEqual([]);
  });

  it("the four groups are disjoint, so no key silently shadows another", () => {
    const groups = { HOME_ICONS, CHART_ICONS, DATA_ICONS, GENERIC_ICONS };
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const [groupName, group] of Object.entries(groups)) {
      for (const key of Object.keys(group)) {
        const earlier = seen.get(key);
        if (earlier) collisions.push(`${key} in ${earlier} and ${groupName}`);
        else seen.set(key, groupName);
      }
    }
    expect(collisions).toEqual([]);
    expect(seen.size).toBe(ALL_KEYS.length);
  });

  it("the aliases re-use one drawing rather than copying it", () => {
    expect(RibbonIcon.Find).toBe(RibbonIcon.Search);
    expect(RibbonIcon.EditChart).toBe(RibbonIcon.Pencil);
    expect(RibbonIcon.SaveImage).toBe(RibbonIcon.Download);
  });

  it("Excel's four Merge commands are four drawings, never aliases of each other", () => {
    // Excel's Merge & Center menu shows four different pictures (tall row with
    // a double arrow, tall row with a right arrow, thin row, thin row cut into
    // cells). An alias here would show the same picture for two different
    // commands in that menu, which is the "one icon used twice" failure.
    const merge = [
      RibbonIcon.MergeCenter,
      RibbonIcon.MergeAcross,
      RibbonIcon.MergeCells,
      RibbonIcon.UnmergeCells,
    ];
    for (let i = 0; i < merge.length; i++) {
      for (let j = i + 1; j < merge.length; j++) {
        expect(merge[i]).not.toBe(merge[j]);
      }
    }
    const markup = (["MergeCenter", "MergeAcross", "MergeCells", "UnmergeCells"] as const).map(
      (key) => renderIcon(key, { size: 20 }).innerHTML,
    );
    expect(new Set(markup).size).toBe(4);
  });
});

describe("menu families: one drawing per row", () => {
  it.each(Object.entries(MENU_FAMILIES))("%s: every key is its own drawing", (_family, keys) => {
    const missing = keys.filter((k) => !(k in RibbonIcon));
    expect(missing).toEqual([]);
    // No alias: two keys sharing a COMPONENT would show one picture twice.
    const aliases: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        if (RibbonIcon[keys[i]] === RibbonIcon[keys[j]]) aliases.push(`${keys[i]} = ${keys[j]}`);
      }
    }
    expect(aliases).toEqual([]);
    // And no copy: two components drawing the same markup are an alias too.
    const byMarkup = new Map<string, string>();
    const copies: string[] = [];
    for (const key of keys) {
      const markup = renderIcon(key, { size: 20 }).innerHTML;
      const earlier = byMarkup.get(markup);
      if (earlier) copies.push(`${key} draws ${earlier}`);
      else byMarkup.set(markup, key);
    }
    expect(copies).toEqual([]);
  });
});

/** The channels an icon paints with, as a set. */
function paintsOf(key: keyof typeof RibbonIcon): Set<string | null> {
  const svg = renderIcon(key, { size: 20 });
  return new Set(shapesOf(svg).flatMap((el) => [el.getAttribute("fill"), el.getAttribute("stroke")]));
}

describe("Excel's Home tab drawings (2026-10-04)", () => {
  it("text alignment is Excel's text block (no accent); object alignment keeps the accent edge", () => {
    // Excel's Align Top / Middle / Bottom are ONE three-line text block placed
    // at the top, middle or bottom, in one colour: the block's position is the
    // whole meaning. The pre-2026-10-04 drawings (an ACCENT edge rule with a
    // SOFT object hugging it) say "align an OBJECT to this edge", which is what
    // the Canvas Arrange menu does with them, so they live on as ObjectAlign*.
    for (const key of ["AlignTop", "AlignMiddle", "AlignBottom"] as const) {
      const paints = paintsOf(key);
      expect(paints.has(ACCENT), `${key} paints ACCENT`).toBe(false);
      expect(paints.has(STRONG), `${key} paints no STRONG text`).toBe(true);
    }
    for (const key of ["ObjectAlignTop", "ObjectAlignMiddle", "ObjectAlignBottom"] as const) {
      const paints = paintsOf(key);
      expect(paints.has(ACCENT), `${key} lost its accent edge`).toBe(true);
      expect(paints.has(SOFT), `${key} lost its soft object`).toBe(true);
    }
  });

  it("the Canvas Arrange menu aligns objects with the ObjectAlign drawings, all six rows", () => {
    // Office's Align menu draws all six rows as objects against an edge. Until
    // the 2026-10-04 icon review Left / Center / Right still showed the TEXT
    // paragraph pictures one separator above the object pictures.
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../extensions/CanvasSheet/components/CanvasArrangeSection.tsx"),
      "utf8",
    );
    for (const edge of ["Left", "Center", "Right", "Top", "Middle", "Bottom"]) {
      expect(source).toContain(`RibbonIcon.ObjectAlign${edge}`);
      // The TEXT alignment drawing in an object menu reads as "align the text".
      expect(source).not.toMatch(new RegExp(`RibbonIcon\\.Align${edge}\\b`));
    }
  });

  it("ObjectAlignLeft / Center / Right are ObjectAlignTop / Middle / Bottom mirrored across the diagonal", () => {
    // Written out, not transformed, so every edge stays on the pixel grid: the
    // same rects with x and y (and width and height) swapped.
    const rects = (key: keyof typeof RibbonIcon): string[] =>
      Array.from(renderIcon(key, { size: 20 }).querySelectorAll("rect")).map((r) =>
        ["x", "y", "width", "height", "rx", "fill"].map((a) => r.getAttribute(a)).join(","),
      );
    const flipped = (key: keyof typeof RibbonIcon): string[] =>
      Array.from(renderIcon(key, { size: 20 }).querySelectorAll("rect")).map((r) =>
        ["y", "x", "height", "width", "rx", "fill"].map((a) => r.getAttribute(a)).join(","),
      );
    expect(rects("ObjectAlignLeft")).toEqual(flipped("ObjectAlignTop"));
    expect(rects("ObjectAlignCenter")).toEqual(flipped("ObjectAlignMiddle"));
    expect(rects("ObjectAlignRight")).toEqual(flipped("ObjectAlignBottom"));
  });

  it("the 45-degree orientation pictures stand Wrap Text's letters upright and step the word", () => {
    // Turned 45 degrees, a 6 px letter keeps only two clean pixels of its hole
    // and the word "ab" painted as two rings: a "%", beside the Number group's
    // real % (2026-10-04 icon review, both reviewers). Upright, every hole is a
    // clean 2 x 2 px; the angle is carried by stepping the word along it and
    // by the arrow.
    const wrap = renderIcon("WrapText", { size: 20 });
    const letters = new Set(
      Array.from(wrap.querySelectorAll("path"))
        .filter((p) => p.getAttribute("fill") === STRONG)
        .map((p) => p.getAttribute("d")),
    );
    for (const key of ["AngleCounterclockwise", "AngleClockwise", "TextOrientation"] as const) {
      const svg = renderIcon(key, { size: 20 });
      const turned = Array.from(svg.querySelectorAll("[transform]"))
        .map((el) => el.getAttribute("transform") ?? "")
        .filter((t) => /rotate|matrix/.test(t));
      expect(turned, `${key} turns its letters`).toEqual([]);
      const strong = Array.from(svg.querySelectorAll("path")).filter((p) => p.getAttribute("fill") === STRONG);
      expect(strong.length, `${key} letters`).toBe(2);
      for (const p of strong) expect(letters.has(p.getAttribute("d")), `${key} draws its own letter`).toBe(true);
    }
  });

  it("Paste Formulas draws its fx FILLED on whole pixels, and Formulas & Number Formatting the same fx", () => {
    // The x as two 2.6 diagonals in a 4.1 box painted a solid 6 x 6 px star
    // with 12 half-covered accent pixels; a whole-pixel staircase has one.
    const formulas = renderIcon("PasteFormulas", { size: 20 });
    const stroked = shapesOf(formulas).filter((el) => {
      const s = el.getAttribute("stroke");
      return s !== null && s !== "none";
    });
    expect(stroked.map((el) => el.getAttribute("d"))).toEqual([]);
    const fx = Array.from(formulas.querySelectorAll("path"))
      .filter((p) => p.getAttribute("fill") === ACCENT)
      .map((p) => p.getAttribute("d"));
    expect(fx.length).toBe(2);
    const compound = new Set(
      Array.from(renderIcon("PasteFormulasNumberFormats", { size: 20 }).querySelectorAll("path")).map((p) =>
        p.getAttribute("d"),
      ),
    );
    for (const d of fx) expect(compound.has(d)).toBe(true);
  });

  it("Paste Transpose turns its arrow on the pixel grid (no arc)", () => {
    // The double-headed quarter arc had 24 half-covered accent pixels and read
    // as a hook; an elbow of PIXEL_STROKE runs paints crisp.
    const svg = renderIcon("PasteTranspose", { size: 20 });
    const lines = shapesOf(svg).filter((el) => {
      const s = el.getAttribute("stroke");
      return s !== null && s !== "none";
    });
    expect(lines.length).toBeGreaterThan(0);
    for (const el of lines) {
      expect(Number(el.getAttribute("stroke-width"))).toBe(PIXEL_STROKE);
      expect(isPixelAlignedAxisPath(el), el.getAttribute("d") ?? "").toBe(true);
    }
  });

  it("Paste Link's two links meet end to end instead of passing through each other", () => {
    // Interlocked at 0.75 scale, each link ran through the other's hole and
    // both holes kept one clean pixel: the chain painted as a solid capsule.
    const svg = renderIcon("PasteLink", { size: 20 });
    const chain = Array.from(svg.querySelectorAll("path")).find((p) => p.getAttribute("stroke") === ACCENT);
    expect(chain).toBeDefined();
    const links = capsulesOf(chain!.getAttribute("d") ?? "");
    expect(links.length).toBe(2);
    const [a, b] = links;
    // Two capsules overlap exactly when their centrelines come closer than
    // the sum of their radii.
    expect(segmentDistance(a.from, a.to, b.from, b.to)).toBeGreaterThanOrEqual(a.r + b.r - 0.05);
  });

  it("Remove Hyperlinks is Excel's whole chain with a red X in the free corner (Clear Filter's idiom)", () => {
    // Excel draws the chain with an X at its lower right; the set already says
    // "remove this" that way (ClearFilter: the funnel and a corner X). The
    // broken chain with a slash was 17 x 17 units, under the fill rule.
    const svg = renderIcon("RemoveHyperlinks", { size: 20 });
    expect(svg.querySelectorAll("[transform]").length, "the chain is written out").toBe(0);
    const red = shapesOf(svg).filter((el) => el.getAttribute("stroke") === DANGER || el.getAttribute("fill") === DANGER);
    expect(red.length).toBe(1);
    const coords = (red[0].getAttribute("d") ?? "").match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    expect(/^[MLZ\d.\s-]+$/.test(red[0].getAttribute("d") ?? ""), "absolute moves and lines only").toBe(true);
    for (const v of coords) {
      expect(v).toBeGreaterThanOrEqual(14.4);
      expect(v).toBeLessThanOrEqual(21.6);
    }
    const chain = shapesOf(svg).filter((el) => el.getAttribute("stroke") === STRONG);
    expect(chain.length).toBe(1);
    expect(capsulesOf(chain[0].getAttribute("d") ?? "").length).toBe(2);
  });

  it("the colour splits carry no accent: the host's bar is the colour", () => {
    // ColorSwatch variant="bar" paints the chosen colour under the glyph. A
    // green part of the drawing would read as the chosen colour beside it.
    for (const key of ["FillColor", "FontColor"] as const) {
      const paints = paintsOf(key);
      expect(paints.has(ACCENT) || paints.has(DANGER), `${key} paints a colour channel`).toBe(false);
    }
  });

  it("the destructive Cells verbs are DANGER and the inserting ones ACCENT", () => {
    for (const key of ["DeleteCells", "DeleteRow", "DeleteColumn", "DeleteSheet", "RemoveHyperlinks"] as const) {
      expect(paintsOf(key).has(DANGER), `${key} paints no DANGER`).toBe(true);
    }
    for (const key of ["InsertCells", "InsertRow", "InsertColumn", "InsertSheet"] as const) {
      const paints = paintsOf(key);
      expect(paints.has(ACCENT), `${key} paints no ACCENT`).toBe(true);
      expect(paints.has(DANGER), `${key} paints DANGER`).toBe(false);
    }
  });
});

/** The endpoints of an ABSOLUTE path (M/L/H/V/A/Z, relative l/h/v too), in
 *  order: the corners a polygon, a rounded polygon or a written-out glyph
 *  passes through. An arc contributes its end point only. */
function pointsOf(d: string): Array<[number, number]> {
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const out: Array<[number, number]> = [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  const num = (): number => Number(tokens[i++]);
  const at = (nx: number, ny: number): void => {
    x = nx;
    y = ny;
    out.push([x, y]);
  };
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    switch (cmd) {
      case "M": case "L": { const nx = num(); at(nx, num()); if (cmd === "M") cmd = "L"; break; }
      case "l": { const nx = x + num(); at(nx, y + num()); break; }
      case "H": at(num(), y); break;
      case "h": at(x + num(), y); break;
      case "V": at(x, num()); break;
      case "v": at(x, y + num()); break;
      case "A": { i += 5; const nx = num(); at(nx, num()); break; }
      case "Z": case "z": cmd = ""; break;
      default: throw new Error(`pointsOf: unsupported command ${cmd} in ${d}`);
    }
  }
  return out;
}

type Pt = [number, number];
/** One straight run or circular arc of a path. */
interface Segment {
  kind: "line" | "arc";
  from: Pt;
  to: Pt;
  r?: number;
  large?: boolean;
  sweep?: boolean;
}

/** The straight runs and circular arcs of an M/L/H/V/A/Z path (absolute or
 *  relative), in order; a closing Z is a run back to the subpath's start.
 *  Anything else -- a curve, an elliptical arc -- throws, so a check built on
 *  it can never pass by not seeing a shape. */
function segmentsOf(d: string): Segment[] {
  const t = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const out: Segment[] = [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  const num = (): number => Number(t[i++]);
  const lineTo = (nx: number, ny: number): void => {
    out.push({ kind: "line", from: [x, y], to: [nx, ny] });
    x = nx;
    y = ny;
  };
  while (i < t.length) {
    if (/[A-Za-z]/.test(t[i])) cmd = t[i++];
    switch (cmd) {
      case "M": x = sx = num(); y = sy = num(); cmd = "L"; break;
      case "m": x = sx = x + num(); y = sy = y + num(); cmd = "l"; break;
      case "L": { const nx = num(); lineTo(nx, num()); break; }
      case "l": { const nx = x + num(); lineTo(nx, y + num()); break; }
      case "H": lineTo(num(), y); break;
      case "h": lineTo(x + num(), y); break;
      case "V": lineTo(x, num()); break;
      case "v": lineTo(x, y + num()); break;
      case "A": case "a": {
        const rx = num();
        const ry = num();
        i += 1; // the x-axis rotation, which a circle ignores
        const large = num() === 1;
        const sweep = num() === 1;
        let nx = num();
        let ny = num();
        if (cmd === "a") { nx += x; ny += y; }
        if (Math.abs(rx - ry) > 1e-9) throw new Error(`segmentsOf: elliptical arc in ${d}`);
        out.push({ kind: "arc", from: [x, y], to: [nx, ny], r: rx, large, sweep });
        x = nx;
        y = ny;
        break;
      }
      case "Z": case "z": lineTo(sx, sy); cmd = ""; break;
      default: throw new Error(`segmentsOf: unsupported command ${cmd} in ${d}`);
    }
  }
  return out;
}

/** A circular arc's centre, its radius as the renderer scales it, its start
 *  angle and its signed sweep (SVG 1.1 F.6.5 with rx = ry and no rotation). */
function arcGeometry(s: Segment): { c: Pt; r: number; a0: number; da: number } {
  const [x1, y1] = s.from;
  const [x2, y2] = s.to;
  const hx = (x1 - x2) / 2;
  const hy = (y1 - y2) / 2;
  let r = s.r ?? 0;
  const lambda = (hx * hx + hy * hy) / (r * r);
  if (lambda > 1) r *= Math.sqrt(lambda);
  const sign = s.large !== s.sweep ? 1 : -1;
  const coef = sign * Math.sqrt(Math.max(0, (r * r - hx * hx - hy * hy) / (hx * hx + hy * hy)));
  const c: Pt = [coef * hy + (x1 + x2) / 2, -coef * hx + (y1 + y2) / 2];
  const a0 = Math.atan2(y1 - c[1], x1 - c[0]);
  let da = Math.atan2(y2 - c[1], x2 - c[0]) - a0;
  if (s.sweep && da < 0) da += 2 * Math.PI;
  if (!s.sweep && da > 0) da -= 2 * Math.PI;
  return { c, r, a0, da };
}

/** The points that bound an arc: its two ends, and every axis extreme of its
 *  circle that the sweep passes (a bowl's bulge, a dome's apex). */
function arcPoints(s: Segment): Pt[] {
  const { c, r, a0, da } = arcGeometry(s);
  const turn = (v: number): number => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const pts: Pt[] = [s.from, s.to];
  for (const ang of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    const along = da >= 0 ? turn(ang - a0) : turn(a0 - ang);
    if (along <= Math.abs(da) + 1e-9) pts.push([c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)]);
  }
  return pts;
}

/** The box the element's ink really covers: a rect's sides, a circle's
 *  extremes, a path's runs and arc bulges, widened by half the stroke where
 *  the element is a stroked line. Any other element throws. */
function inkBox(el: Element): { minX: number; minY: number; maxX: number; maxY: number } {
  const tag = el.tagName.toLowerCase();
  const n = (a: string): number => Number(el.getAttribute(a));
  let pts: Pt[];
  if (tag === "rect") pts = [[n("x"), n("y")], [n("x") + n("width"), n("y") + n("height")]];
  else if (tag === "circle") pts = [[n("cx") - n("r"), n("cy") - n("r")], [n("cx") + n("r"), n("cy") + n("r")]];
  else if (tag === "path") pts = segmentsOf(el.getAttribute("d") ?? "").flatMap((s) => (s.kind === "arc" ? arcPoints(s) : [s.from, s.to]));
  else throw new Error(`inkBox: cannot measure <${tag}>`);
  if (pts.length === 0) throw new Error(`inkBox: <${tag}> has no points`);
  const stroke = el.getAttribute("stroke");
  const half = stroke && stroke !== "none" && el.getAttribute("fill") !== stroke ? n("stroke-width") / 2 : 0;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs) - half, minY: Math.min(...ys) - half, maxX: Math.max(...xs) + half, maxY: Math.max(...ys) + half };
}

/** The numbers of `rect` elements painted with `fill`. */
function rectBoxes(key: keyof typeof RibbonIcon): Array<{ x: number; y: number; w: number; h: number; fill: string | null }> {
  return Array.from(renderIcon(key, { size: 20 }).querySelectorAll("rect")).map((r) => ({
    x: Number(r.getAttribute("x")),
    y: Number(r.getAttribute("y")),
    w: Number(r.getAttribute("width")),
    h: Number(r.getAttribute("height")),
    fill: r.getAttribute("fill"),
  }));
}

/** The Edit interactions keys (P4 S10, 2026-10-17). */
const INTERACTION_KEYS = ["EditInteractions", "InteractionFilter", "InteractionHighlight", "InteractionNone"] as const;

describe("Edit interactions (P4, 2026-10-17)", () => {
  it("registers the four keys as components of their own", () => {
    for (const key of INTERACTION_KEYS) {
      expect(key in RibbonIcon, key).toBe(true);
      expect(typeof RibbonIcon[key]).toBe("function");
    }
    expect(new Set(INTERACTION_KEYS.map((k) => RibbonIcon[k])).size).toBe(4);
  });

  it("draws them in the frame's own coordinates (no transform)", () => {
    const turned = INTERACTION_KEYS.filter((key) => renderIcon(key, { size: 20 }).querySelector("[transform]"));
    expect(turned).toEqual([]);
  });

  it("None draws no accent (nothing passes through); Filter and Highlight draw it", () => {
    const fills = (key: (typeof INTERACTION_KEYS)[number]) =>
      shapesOf(renderIcon(key, { size: 20 })).map((el) => el.getAttribute("fill") ?? el.getAttribute("stroke"));
    expect(fills("InteractionNone")).not.toContain(ACCENT);
    expect(fills("InteractionFilter")).toContain(ACCENT);
    expect(fills("InteractionHighlight")).toContain(ACCENT);
    expect(fills("InteractionHighlight")).toContain(SOFT);
  });
});

describe("Power BI's report authoring on the Canvas tab (2026-10-08)", () => {
  const CANVAS_KEYS = CONTRACT_KEYS.slice(CONTRACT_KEYS.indexOf("ChartBarStacked"));

  it("names all 27 new keys", () => {
    expect(CANVAS_KEYS.length).toBe(27);
  });

  it("draws every new picture in the frame's own coordinates (no transform at all)", () => {
    // The designers wrote every scaled or moved part out as coordinates (the
    // Button's cursor; until 2026-10-22 also the Card's digits), so the
    // pixel-grid checks read what actually paints.
    const turned = CANVAS_KEYS.filter((key) => renderIcon(key, { size: 20 }).querySelector("[transform]"));
    expect(turned).toEqual([]);
  });

  it("KPI is Power BI's pair of triangles with ONE accent: ACCENT points up, STRONG points down, no DANGER", () => {
    // Owner decision 2026-10-08: Power BI's green up and red down triangles
    // become ACCENT and STRONG, because ACCENT and DANGER never share an icon
    // and a red triangle would read as "delete".
    const svg = renderIcon("ChartKpi", { size: 20 });
    expect(paintsOf("ChartKpi").has(DANGER)).toBe(false);
    const byFill = (fill: string): Element[] => shapesOf(svg).filter((el) => el.getAttribute("fill") === fill);
    const pointsUp = (el: Element): boolean => {
      const pts = pointsOf(el.getAttribute("d") ?? "");
      const ys = pts.map((p) => p[1]);
      const spread = (atY: number): number => {
        const xs = pts.filter((p) => Math.abs(p[1] - atY) < 1.5).map((p) => p[0]);
        return Math.max(...xs) - Math.min(...xs);
      };
      return spread(Math.min(...ys)) < spread(Math.max(...ys));
    };
    const accent = byFill(ACCENT).filter((el) => el.tagName.toLowerCase() === "path");
    const strong = byFill(STRONG).filter((el) => el.tagName.toLowerCase() === "path");
    expect(accent.length).toBe(1);
    expect(strong.length).toBe(1);
    expect(pointsUp(accent[0]), "the ACCENT triangle points up").toBe(true);
    expect(pointsUp(strong[0]), "the STRONG triangle points down").toBe(false);
  });

  it("Clear All Slicers is a clearing verb: DANGER and no ACCENT, like Clear Filter", () => {
    for (const key of ["ClearSlicers", "ClearFilter"] as const) {
      const paints = paintsOf(key);
      expect(paints.has(DANGER), `${key} paints no DANGER`).toBe(true);
      expect(paints.has(ACCENT), `${key} paints ACCENT`).toBe(false);
    }
  });

  it("a stacked picture's two categories end at least 4 px apart; a 100% picture's end together", () => {
    // Before 2026-10-08 Stacked's columns topped out 2 px apart and read as
    // Stacked100 at 20px; in a gallery that shows both side by side the
    // difference of shape is the only thing that tells them apart. Since
    // 2026-10-22 (the Visuals family, ICONS.md 2.5) every mark is a crisp
    // STRONG root, THE cut and an ACCENT D end of the SAME length, so the
    // ends differ by the roots: 4.8 (4 px), against Stacked100's 0. The floor
    // of 2026-10-08 was 6.0; in this construction that needs a 4.8 root under
    // a 6.0 end, a mushroom the designers rendered and declined.
    /** Each mark's value end: the picture's shapes grouped by their
     *  cross-axis span (a column's x-range, a bar's y-range), the end being
     *  the far side of the group's real ink (inkBox: a D end's semicircle
     *  counts to its apex, so a square end or a smaller cap measures true). */
    const markEnds = (key: keyof typeof RibbonIcon, axis: "column" | "bar"): number[] => {
      const ends = new Map<string, number>();
      for (const el of shapesOf(renderIcon(key, { size: 20 }))) {
        const box = inkBox(el);
        const span = axis === "column" ? `${box.minX.toFixed(3)}..${box.maxX.toFixed(3)}` : `${box.minY.toFixed(3)}..${box.maxY.toFixed(3)}`;
        const end = axis === "column" ? box.minY : box.maxX;
        const was = ends.get(span);
        ends.set(span, was === undefined ? end : axis === "column" ? Math.min(was, end) : Math.max(was, end));
      }
      return Array.from(ends.values());
    };
    const apart = (ends: number[]): number => Math.max(...ends) - Math.min(...ends);
    expect(markEnds("Stacked", "column").length).toBe(2);
    expect(apart(markEnds("Stacked", "column"))).toBeGreaterThanOrEqual(4.8 - 1e-6);
    expect(markEnds("Stacked100", "column").length).toBe(2);
    expect(apart(markEnds("Stacked100", "column"))).toBeCloseTo(0);
    expect(markEnds("ChartBarStacked", "bar").length).toBe(2);
    expect(apart(markEnds("ChartBarStacked", "bar"))).toBeGreaterThanOrEqual(4.8 - 1e-6);
    expect(markEnds("ChartBarStacked100", "bar").length).toBe(2);
    expect(apart(markEnds("ChartBarStacked100", "bar"))).toBeCloseTo(0);
    // The areas: the 100% accent fills down from a FLAT top across the plot;
    // the stacked accent is a band whose top is the zigzag.
    const accentTopRun = (key: keyof typeof RibbonIcon): number => {
      const accent = shapesOf(renderIcon(key, { size: 20 })).find((el) => el.getAttribute("fill") === ACCENT);
      const pts = pointsOf(accent?.getAttribute("d") ?? "");
      const top = Math.min(...pts.map((p) => p[1]));
      const xs = pts.filter((p) => Math.abs(p[1] - top) < 1e-9).map((p) => p[0]);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(accentTopRun("ChartAreaStacked100")).toBeGreaterThanOrEqual(14.4);
    expect(accentTopRun("ChartAreaStacked")).toBeLessThan(4.8);
  });

  it("Button's cursor is the Pointer at two-thirds size, written out", () => {
    // A Pointer redraw must be mirrored here; this fails until it is.
    const silhouette = (key: keyof typeof RibbonIcon): Array<[number, number]> => {
      const el = shapesOf(renderIcon(key, { size: 20 })).find(
        (s) => s.tagName.toLowerCase() === "path" && s.getAttribute("fill") === STRONG,
      );
      if (!el) throw new Error(`${key} draws no STRONG path`);
      return pointsOf(el.getAttribute("d") ?? "");
    };
    const pointer = silhouette("Pointer");
    const cursor = silhouette("ButtonControl");
    expect(cursor.length).toBe(pointer.length);
    const [tipX, tipY] = pointer[0];
    const [toX, toY] = cursor[0];
    for (let i = 0; i < pointer.length; i++) {
      expect(cursor[i][0]).toBeCloseTo(toX + (pointer[i][0] - tipX) * 0.66, 2);
      expect(cursor[i][1]).toBeCloseTo(toY + (pointer[i][1] - tipY) * 0.66, 2);
    }
  });

  it("Matrix merges its totals into ONE accent L, so it differs from GrandTotals by shape", () => {
    const accents = (key: keyof typeof RibbonIcon): number =>
      shapesOf(renderIcon(key, { size: 20 })).filter((el) => el.getAttribute("fill") === ACCENT).length;
    expect(accents("Matrix")).toBe(1);
    expect(accents("GrandTotals")).toBeGreaterThan(1);
  });

  // ---- the Canvas icon reviews (2026-10-08) --------------------------------
  // Two reviews of the 28 pictures (Power BI fidelity; 20px legibility and the
  // set's rules) found five pictures that read as a neighbour or as something
  // else. Each test below pins the property the fix restored, as a relation
  // where one key draws another's part.

  /** The x-extent [left, right] of a filled shape: a rect's box, or the
   *  extreme x of a path's points (end points, so arcs count by their ends). */
  const xExtent = (el: Element): [number, number] => {
    if (el.tagName.toLowerCase() === "rect") {
      const x = Number(el.getAttribute("x"));
      return [x, x + Number(el.getAttribute("width"))];
    }
    const xs = pointsOf(el.getAttribute("d") ?? "").map((p) => p[0]);
    return [Math.min(...xs), Math.max(...xs)];
  };

  it("Line and stacked column shows Stacked's TWO columns; Line and clustered column three whole ones", () => {
    // The family rule (chart.tsx, Power BI's pane row 2, tiles 5 and 6): two
    // split marks against three whole ones is what tells a stacked picture
    // from a clustered one at 20px. The first ChartComboStacked drew three
    // columns under the line and differed from ChartCombo only by its caps.
    // Its columns are Stacked's columns, so a Stacked redraw must carry over.
    const strongColumns = (key: keyof typeof RibbonIcon): Array<[number, number]> =>
      shapesOf(renderIcon(key, { size: 20 }))
        .filter((el) => el.getAttribute("fill") === STRONG)
        .map(xExtent)
        .sort((a, b) => a[0] - b[0]);
    expect(strongColumns("ChartCombo").length).toBe(3);
    const combo = strongColumns("ChartComboStacked");
    const stacked = strongColumns("Stacked");
    expect(combo.length).toBe(2);
    expect(stacked.length).toBe(2);
    for (let i = 0; i < 2; i++) {
      expect(combo[i][0]).toBeCloseTo(stacked[i][0], 9);
      expect(combo[i][1]).toBeCloseTo(stacked[i][1], 9);
    }
  });

  it("Grouped draws two WHOLE columns on Stacked's two slots: one STRONG, one ACCENT", () => {
    // Chart Design's layout toggle shows Grouped | Stacked | 100% side by
    // side. Since 2026-10-22 the three are one picture three ways: the same
    // two PAIR slots filled whole (two series beside each other), split, or
    // split to the full height. Grouped's columns stand on Stacked's slots,
    // so a Stacked redraw must carry over (their heights are Grouped's own);
    // and it is not ChartColumn's three MARK columns.
    const shapes = shapesOf(renderIcon("Grouped", { size: 20 }));
    const strong = shapes.filter((el) => el.getAttribute("fill") === STRONG).map(xExtent);
    const accent = shapes.filter((el) => el.getAttribute("fill") === ACCENT).map(xExtent);
    expect(shapes.length).toBe(2);
    expect(strong.length).toBe(1);
    expect(accent.length).toBe(1);
    const stacked = shapesOf(renderIcon("Stacked", { size: 20 }))
      .filter((el) => el.getAttribute("fill") === STRONG)
      .map(xExtent)
      .sort((a, b) => a[0] - b[0]);
    expect(strong[0][0]).toBeCloseTo(stacked[0][0], 9);
    expect(strong[0][1]).toBeCloseTo(stacked[0][1], 9);
    expect(accent[0][0]).toBeCloseTo(stacked[1][0], 9);
    expect(accent[0][1]).toBeCloseTo(stacked[1][1], 9);
  });

  it("Card and KPI are each a value over a SOFT rule, with no frame round them", () => {
    // Power BI's card is a large "123" with a grey caption rule under it; the
    // first ChartCard put the rule in a soft frame's bottom wall, and at 20px
    // it read as a monitor with a chin, heavier than any visual beside it and
    // wider than the set's 2.4 margins. KPI on the same row draws its value
    // over the same SOFT rule and no box: the two cards say it one way. Since
    // 2026-10-22 the rule is marks.tsx's CardRule, on the field's bottom edge.
    for (const key of ["ChartCard", "ChartKpi"] as const) {
      const shapes = shapesOf(renderIcon(key, { size: 20 }));
      const soft = shapes.filter((el) => el.getAttribute("fill") === SOFT);
      expect(soft.length, `${key} draws exactly one SOFT shape, the rule`).toBe(1);
      const rule = soft[0];
      expect(rule.tagName.toLowerCase()).toBe("rect");
      expect(Number(rule.getAttribute("height")), `${key}'s rule is a 2.4 bar`).toBe(2.4);
      const ruleTop = Number(rule.getAttribute("y"));
      for (const el of shapes) {
        if (el === rule) continue;
        // Real ink: a stroke counts to its edge and an arc to its bulge, and
        // an element inkBox cannot measure fails instead of passing unseen.
        expect(inkBox(el).maxY, `${key}: everything else stands above the rule`).toBeLessThan(ruleTop);
      }
    }
    // The card's digits keep the set's 2.4 margins: every ACCENT part's real
    // ink (the 3's bowls reach the right margin exactly).
    const digits = shapesOf(renderIcon("ChartCard", { size: 20 })).filter(
      (el) => el.getAttribute("fill") === ACCENT || el.getAttribute("stroke") === ACCENT,
    );
    expect(digits.length).toBe(3);
    for (const el of digits) {
      const box = inkBox(el);
      expect(box.minX, el.getAttribute("d") ?? "").toBeGreaterThanOrEqual(2.4 - 1e-6);
      expect(box.maxX, el.getAttribute("d") ?? "").toBeLessThanOrEqual(21.6 + 1e-6);
    }
  });

  it("Matrix paints Power BI's colours: SOFT header cells over STRONG cells, so it is not Floating Grid's outline", () => {
    // data.tsx maps Power BI's grey to SOFT and its white cells to STRONG.
    // The first Matrix had a STRONG header over SOFT cells -- the inverse, and
    // Floating Grid's silhouette (a full-width STRONG bar over grey cells).
    // Since 2026-10-22 its cells are the Visuals family's 3 x 3 lattice (4.8
    // cells, THE 2.4 gap; ICONS.md 2.5): the header is a ROW of three SOFT
    // cells, and cells meet the lattice, so their corners are square.
    const rects = rectBoxes("Matrix");
    const header = rects.filter((r) => r.fill === SOFT);
    const cells = rects.filter((r) => r.fill === STRONG);
    expect(header.length).toBe(3);
    expect(cells.length).toBe(2);
    for (const r of header) expect(r.y).toBe(2.4);
    for (const r of [...header, ...cells]) expect([r.w, r.h]).toEqual([4.8, 4.8]);
    for (const r of cells) expect(r.y).toBeGreaterThan(Math.max(...header.map((h) => h.y + h.h)));
    const rounded = Array.from(renderIcon("Matrix", { size: 20 }).querySelectorAll("rect")).filter(
      (r) => Number(r.getAttribute("rx") ?? 0) !== 0,
    );
    expect(rounded).toEqual([]);
    expect(rectBoxes("FloatingGrid").find((r) => r.w === 19.2)?.fill).toBe(STRONG);
  });

  it("Page Navigator's page buttons sit ABOVE the page (tabs), so it is not Legend's page over keys", () => {
    // The first Page Navigator was a soft box over three marks on Legend's
    // columns with the first one green: Legend at 20px. Power BI's navigator
    // is a row of page tabs; tabs over the page is the familiar picture.
    const rects = rectBoxes("PageNavigator");
    const page = rects.filter((r) => r.fill === SOFT);
    const tabs = rects.filter((r) => r.fill !== SOFT);
    expect(page.length).toBe(1);
    expect(tabs.length).toBe(3);
    for (const tab of tabs) expect(tab.y + tab.h).toBeLessThan(page[0].y);
    const legend = rectBoxes("Legend");
    const legendBody = legend.find((r) => r.fill === SOFT);
    for (const key of legend.filter((r) => r.fill !== SOFT)) expect(key.y).toBeGreaterThan(legendBody?.y ?? Infinity);
  });

  it("Lock Objects locks Shapes' objects (a square and a circle) with Protect Sheet's padlock body", () => {
    // The first Lock Objects drew grey blocks top and left round a padlock
    // bottom right -- Home's Protect Sheet with other cells. Its objects are
    // now a square and a circle, Shapes' own (a circle is a shape no sheet
    // cell is). The padlock body is copied from Protect Sheet's (only the
    // keyhole differs), so the copy is pinned: a padlock redraw must follow.
    const svg = renderIcon("LockObjects", { size: 20 });
    const soft = shapesOf(svg).filter((el) => el.getAttribute("fill") === SOFT);
    expect(soft.map((el) => el.tagName.toLowerCase()).sort()).toEqual(["circle", "rect"]);
    const circle = soft.find((el) => el.tagName.toLowerCase() === "circle");
    const shapesCircle = renderIcon("Shapes", { size: 20 }).querySelector("circle");
    expect(circle?.getAttribute("r")).toBe(shapesCircle?.getAttribute("r"));
    const outline = (key: keyof typeof RibbonIcon): string => {
      const body = shapesOf(renderIcon(key, { size: 20 })).find(
        (el) => el.tagName.toLowerCase() === "path" && el.getAttribute("fill") === ACCENT,
      );
      return (body?.getAttribute("d") ?? "").split(/Z/i)[0];
    };
    expect(outline("LockObjects")).not.toBe("");
    expect(outline("LockObjects")).toBe(outline("ProtectSheet"));
  });

  it("All Visuals (the 30px hero) has every point of its marks on whole pixels at 30px", () => {
    // AllVisuals is drawn for its 30px hero, where one pixel is 0.8 units; the
    // first drawing's 3.6 columns at x 6.0 and 10.8 fell on 7.5 and 13.5 px.
    // (A 1.2-grid edge is whole only at 20px, a 2.4 one at both; the hero's
    // four 10 px tiles cannot all sit on the 2.4 grid.) Since 2026-10-22 the
    // hero is drawn in paths (D-marks, the exploded pie, a ring), so every rect
    // edge, every path end point and every circle's extremes are read, and an
    // element the check cannot read fails it.
    const onThirty = (v: number): boolean => Math.abs(v / 0.8 - Math.round(v / 0.8)) < 1e-6;
    const values = shapesOf(renderIcon("AllVisuals", { size: 30 })).flatMap((el) => {
      const tag = el.tagName.toLowerCase();
      const n = (a: string): number => Number(el.getAttribute(a));
      if (tag === "rect") return [n("x"), n("y"), n("x") + n("width"), n("y") + n("height")];
      if (tag === "circle") return [n("cx") - n("r"), n("cx") + n("r"), n("cy") - n("r"), n("cy") + n("r")];
      if (tag === "path") return pointsOf(el.getAttribute("d") ?? "").flat();
      throw new Error(`AllVisuals draws a <${tag}> this check cannot read`);
    });
    expect(values.length).toBeGreaterThan(20);
    expect(values.filter((v) => !onThirty(v))).toEqual([]);
  });

  /** The Visuals family (ICONS.md 2.5): the gallery's 34 pictures and Chart
   *  Design's Grouped, which sits beside two of them in one toggle. */
  const VISUALS_FAMILY: ReadonlyArray<keyof typeof RibbonIcon> = [...MENU_FAMILIES["Visuals gallery"], "Grouped"];

  it("the Visuals family keeps its corner rule: square or a full curve, never an in-between radius", () => {
    // ICONS.md 2.5 (2026-10-22): square where a part meets something, a full
    // curve where it ends freely -- the rx 1.6 on 3-5 px parts that made the
    // first Visuals icons paint as lumps. A rect's radius (rx, or ry alone)
    // must be 0 or half its short side. In a FILLED path every arc smaller
    // than a mark (r < 4.8) must be a full curve: a semicircle (a D end, a
    // pill end, half a ring), a large arc (a disc's body: the gauge's hub, a
    // three-quarter pie), or a wedge centred on one of the path's own points
    // (a pie's quarter). A rounded corner fits none of the three. Arcs of a
    // mark's radius or more are the round pictures' rings and the quarter
    // circles of the Matrix and the Histogram. Stroked lines (series, digits)
    // have round caps and are held by the stroke rules instead.
    const offenders: string[] = [];
    for (const key of VISUALS_FAMILY) {
      const svg = renderIcon(key, { size: 20 });
      for (const r of Array.from(svg.querySelectorAll("rect"))) {
        const rx = Number(r.getAttribute("rx") ?? r.getAttribute("ry") ?? 0);
        const half = Math.min(Number(r.getAttribute("width")), Number(r.getAttribute("height"))) / 2;
        if (rx !== 0 && Math.abs(rx - half) > 1e-9) offenders.push(`${key}: rx ${rx} on a rect whose half short side is ${half}`);
      }
      for (const p of Array.from(svg.querySelectorAll("path"))) {
        const fill = p.getAttribute("fill");
        if (!fill || fill === "none") continue;
        const segs = segmentsOf(p.getAttribute("d") ?? "");
        const vertices = segs.flatMap((s) => [s.from, s.to]);
        for (const s of segs) {
          if (s.kind !== "arc" || (s.r ?? 0) >= 4.8 - 1e-9) continue;
          const chord = Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]);
          const semicircle = Math.abs(chord - 2 * (s.r ?? 0)) < 1e-3;
          const { c } = arcGeometry(s);
          const wedge = vertices.some((v) => Math.hypot(v[0] - c[0], v[1] - c[1]) < 1e-3);
          if (!semicircle && !s.large && !wedge) offenders.push(`${key}: an r ${s.r} corner in ${p.getAttribute("d")}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the Visuals family puts every straight edge of a filled shape on whole pixels at 20px", () => {
    // ICONS.md 2.3 and 2.5: a horizontal or vertical edge off the 1.2 grid
    // paints a half-covered grey row. Read: a square rect's four sides, a
    // pill's two long sides (its ends are curves), and every horizontal or
    // vertical run of a filled path (a closing Z included). Curves, diagonals
    // and stroked lines antialias anyway. The 30px hero has its own grid test.
    const offenders: string[] = [];
    for (const key of VISUALS_FAMILY.filter((k) => k !== "AllVisuals")) {
      for (const el of shapesOf(renderIcon(key, { size: 20 }))) {
        const fill = el.getAttribute("fill");
        if (!fill || fill === "none") continue;
        const tag = el.tagName.toLowerCase();
        const n = (a: string): number => Number(el.getAttribute(a));
        const edges: number[] = [];
        if (tag === "rect") {
          const rx = Number(el.getAttribute("rx") ?? el.getAttribute("ry") ?? 0);
          const [x, y, w, h] = [n("x"), n("y"), n("width"), n("height")];
          if (rx === 0 || w > h) edges.push(y, y + h);
          if (rx === 0 || h > w) edges.push(x, x + w);
        } else if (tag === "path") {
          for (const s of segmentsOf(el.getAttribute("d") ?? "")) {
            if (s.kind !== "line" || Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]) < 1e-9) continue;
            if (Math.abs(s.to[1] - s.from[1]) < 1e-9) edges.push(s.from[1]);
            else if (Math.abs(s.to[0] - s.from[0]) < 1e-9) edges.push(s.from[0]);
          }
        } else if (tag !== "circle") {
          throw new Error(`${key} draws a <${tag}> this check cannot read`);
        }
        for (const v of edges) if (!onPixelGrid(v)) offenders.push(`${key}: <${tag}> edge at ${v}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the Visuals family is the one the contact check holds to THE gap", () => {
    // `npm run check:icon-contact` measures the family's ACCENT at 2.4 (the
    // 30px hero at its own 1.6) and never allowlists a family key; its list
    // must be this family, or a new visual would slip to the set's 1.2.
    expect(Object.keys(VISUALS_FAMILY_GAPS).sort()).toEqual([...VISUALS_FAMILY].sort());
    for (const key of VISUALS_FAMILY) expect(VISUALS_FAMILY_GAPS[key], key).toBe(key === "AllVisuals" ? 1.6 : 2.4);
  });
});

// ============================================================================
// Every drawing
// ============================================================================

describe("every RibbonIcon drawing", () => {
  it.each(ALL_KEYS)("%s renders a 24-unit svg at 16 and 30", (key) => {
    for (const size of [16, 30]) {
      const svg = renderIcon(key, { size });
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg.getAttribute("width")).toBe(String(size));
      expect(svg.getAttribute("height")).toBe(String(size));
    }
  });

  it.each(ALL_KEYS)("%s defaults to 16px and is decorative", (key) => {
    const svg = renderIcon(key);
    expect(svg.getAttribute("width")).toBe("16");
    expect(svg.getAttribute("height")).toBe("16");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
  });

  it.each(ALL_KEYS)("%s has no <text> and no hardcoded colour", (key) => {
    renderIcon(key, { size: 30 });
    expect(container.querySelector("text")).toBeNull();
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it.each(ALL_KEYS)("%s paints only with the four channels", (key) => {
    const svg = renderIcon(key);
    const offChannel: string[] = [];
    for (const el of shapesOf(svg)) {
      for (const attr of ["fill", "stroke"]) {
        const value = el.getAttribute(attr);
        if (value !== null && value !== "none" && !CHANNELS.has(value)) {
          offChannel.push(`<${el.tagName}> ${attr}="${value}"`);
        }
      }
    }
    expect(offChannel).toEqual([]);
  });

  it.each(ALL_KEYS)("%s paints at least one SOFT or STRONG shape", (key) => {
    const svg = renderIcon(key);
    const grounded = shapesOf(svg).some((el) =>
      ["fill", "stroke"].some((attr) => {
        const value = el.getAttribute(attr);
        return value === SOFT || value === STRONG;
      }),
    );
    expect(grounded).toBe(true);
  });

  it.each(ALL_KEYS)("%s never uses ACCENT and DANGER together", (key) => {
    const svg = renderIcon(key);
    const paints = new Set(
      shapesOf(svg).flatMap((el) => [el.getAttribute("fill"), el.getAttribute("stroke")]),
    );
    expect(paints.has(ACCENT) && paints.has(DANGER)).toBe(false);
  });

  it.each(ALL_KEYS)("%s has no free-standing stroke thinner than the 3-unit rule", (key) => {
    const svg = renderIcon(key);
    const thin: string[] = [];
    for (const el of shapesOf(svg)) {
      const stroke = el.getAttribute("stroke");
      if (stroke === null || stroke === "none") continue;
      // A stroke in the SAME channel as the fill only rounds a filled shape's
      // corners; it is not a line, so the minimum does not apply to it.
      if (el.getAttribute("fill") === stroke) continue;
      const width = Number(el.getAttribute("stroke-width"));
      if (width >= MIN_STROKE) continue;
      // The one exception: two whole pixels on a pixel-aligned straight run.
      if (width === PIXEL_STROKE && isPixelAlignedAxisPath(el)) continue;
      thin.push(`<${el.tagName}> stroke-width=${width} d=${el.getAttribute("d") ?? ""}`);
    }
    expect(thin).toEqual([]);
  });

  it.each(ALL_KEYS)("%s only turns, moves or mirrors (no transform scales a shape)", (key) => {
    // The stroke rules above read the stroke-width ATTRIBUTE. Under a scale the
    // painted line is not that width, so a scaled group would pass a line the
    // rules forbid. The Excel letters (WrapText, the orientation menu) are
    // placed by translate and rotate only, for exactly this reason.
    const svg = renderIcon(key);
    const scaled = Array.from(svg.querySelectorAll("[transform]"))
      .map((el) => el.getAttribute("transform") ?? "")
      .filter((t) => !isRigidTransform(t));
    expect(scaled).toEqual([]);
  });

  it.each(ALL_KEYS)("%s draws its 2 px square marks square (rx 0)", (key) => {
    // ICONS.md 2.3: a 2 px mark with ANY corner radius paints as a plus sign
    // at 150% (the Borders family measured it first). The Paste family's %
    // and No Borders dots were rx 0.6 until the 2026-10-04 icon review; at
    // 100% rx 0 changes nothing.
    const svg = renderIcon(key);
    const rounded = Array.from(svg.querySelectorAll("rect"))
      .filter((r) => Number(r.getAttribute("width")) === 2.4 && Number(r.getAttribute("height")) === 2.4)
      .filter((r) => Number(r.getAttribute("rx") ?? 0) !== 0)
      .map((r) => `x=${r.getAttribute("x")} y=${r.getAttribute("y")} rx=${r.getAttribute("rx")}`);
    expect(rounded).toEqual([]);
  });

  it.each(ALL_KEYS)("%s draws no PIXEL_STROKE line inside a transform", (key) => {
    // isPixelAlignedAxisPath reads `d` as written. Inside a rotation a path
    // written on the grid paints off it, so a 2.4 line must be drawn in the
    // frame's own coordinates (the rotated Excel letters are FILLED, and the
    // orientation arrows sit outside their rotated words).
    const svg = renderIcon(key);
    const offenders: string[] = [];
    for (const el of shapesOf(svg)) {
      if (Number(el.getAttribute("stroke-width")) !== PIXEL_STROKE) continue;
      if (el.closest("[transform]")) offenders.push(`<${el.tagName}> d=${el.getAttribute("d") ?? ""}`);
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * True when every function in an SVG `transform` list keeps lengths: a
 * translate, a rotate, or a matrix whose 2x2 part is a rotation or a mirror
 * (its columns unit length and at right angles). scale() and skew*() never are.
 */
function isRigidTransform(transform: string): boolean {
  const CALL = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  // Anything between the calls other than separators is not a transform we know.
  if (transform.replace(CALL, "").replace(/[\s,]/g, "") !== "") return false;
  return Array.from(transform.matchAll(CALL)).every(([, name, argText]) => {
    if (name === "translate" || name === "rotate") return true;
    const args = (argText.match(/-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? []).map(Number);
    if (name !== "matrix" || args.length !== 6) return false;
    const [a, b, c, d] = args;
    const near = (x: number, y: number): boolean => Math.abs(x - y) < 1e-9;
    return near(a * a + b * b, 1) && near(c * c + d * d, 1) && near(a * c + b * d, 0);
  });
}

/** A chain link written out as a capsule outline: `M p1 L p2 A r r 0 0 s p3 L
 *  p4 A r r 0 0 s p1 Z` (absolute coordinates). Its centreline runs between
 *  the midpoints of the two arcs' chords; `r` is the arcs' radius. */
interface Capsule {
  from: readonly [number, number];
  to: readonly [number, number];
  r: number;
}

/** The capsules of a path made only of such subpaths ([] for anything else). */
function capsulesOf(d: string): Capsule[] {
  const subpaths = d.split(/(?=M)/).map((s) => s.trim()).filter(Boolean);
  const out: Capsule[] = [];
  for (const sub of subpaths) {
    const m = sub.match(
      /^M(-?[\d.]+)[ ,](-?[\d.]+)L(-?[\d.]+)[ ,](-?[\d.]+)A(-?[\d.]+)[ ,]-?[\d.]+[ ,]0[ ,]0[ ,][01][ ,](-?[\d.]+)[ ,](-?[\d.]+)L(-?[\d.]+)[ ,](-?[\d.]+)A-?[\d.]+[ ,]-?[\d.]+[ ,]0[ ,]0[ ,][01][ ,]-?[\d.]+[ ,]-?[\d.]+Z$/,
    );
    if (!m) return [];
    const [x1, y1, x2, y2, r, x3, y3, x4, y4] = m.slice(1).map(Number);
    out.push({ from: [(x4 + x1) / 2, (y4 + y1) / 2], to: [(x2 + x3) / 2, (y2 + y3) / 2], r });
  }
  return out;
}

/** The shortest distance between two segments in the plane (0 when they cross). */
function segmentDistance(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  d: readonly [number, number],
): number {
  const cross = (o: readonly [number, number], p: readonly [number, number], q: readonly [number, number]): number =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  const toSegment = (p: readonly [number, number], s: readonly [number, number], e: readonly [number, number]): number => {
    const dx = e[0] - s[0], dy = e[1] - s[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / len2));
    return Math.hypot(p[0] - (s[0] + t * dx), p[1] - (s[1] + t * dy));
  };
  return Math.min(toSegment(a, c, d), toSegment(b, c, d), toSegment(c, a, b), toSegment(d, a, b));
}

describe("the capsule helpers measure what they claim", () => {
  it("reads a written-out link and tells touching links from interlocked ones", () => {
    // The pre-review Paste Link (interlocked) and the end-to-end chain.
    const interlocked = capsulesOf(
      "M10.34 16.17L12.35 14.16A2.48 2.48 0 0 1 15.85 17.66L13.84 19.67A2.48 2.48 0 0 1 10.34 16.17ZM14.16 12.35L16.17 10.33A2.48 2.48 0 0 1 19.67 13.83L17.66 15.85A2.48 2.48 0 0 1 14.16 12.35Z",
    );
    expect(interlocked.length).toBe(2);
    const [a, b] = interlocked;
    expect(segmentDistance(a.from, a.to, b.from, b.to)).toBeLessThan(a.r + b.r - 1);
    expect(capsulesOf("M4.8 6H19.2")).toEqual([]);
    expect(segmentDistance([0, 0], [10, 10], [0, 10], [10, 0])).toBe(0);
    expect(segmentDistance([0, 0], [1, 0], [3, 0], [4, 0])).toBeCloseTo(2);
  });
});

/** True when `v` is a whole number of device pixels at 20px (a multiple of
 *  PIXEL_GRID), within float noise. */
function onPixelGrid(v: number): boolean {
  const q = v / PIXEL_GRID;
  return Math.abs(q - Math.round(q)) < 1e-6;
}

/**
 * A PIXEL_STROKE path is legal only when EVERY segment is horizontal or
 * vertical and runs along a pixel-grid line, so both edges of the 2.4 stroke
 * (centre +/- 1.2) land on pixel boundaries. Only M/L/H/V/Z (absolute or
 * relative) can guarantee that; any curve or arc fails.
 */
function isPixelAlignedAxisPath(el: Element): boolean {
  if (el.tagName.toLowerCase() !== "path") return false;
  const tokens = (el.getAttribute("d") ?? "").match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  const num = (): number => Number(tokens[i++]);
  const segment = (nx: number, ny: number): boolean => {
    const horizontal = Math.abs(ny - y) < 1e-9;
    const vertical = Math.abs(nx - x) < 1e-9;
    const ok = (horizontal && onPixelGrid(y)) || (vertical && onPixelGrid(x));
    x = nx;
    y = ny;
    return ok;
  };
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    switch (cmd) {
      case "M": x = startX = num(); y = startY = num(); cmd = "L"; break;
      case "m": x = startX = x + num(); y = startY = y + num(); cmd = "l"; break;
      case "L": { const nx = num(); if (!segment(nx, num())) return false; break; }
      case "l": { const nx = x + num(); if (!segment(nx, y + num())) return false; break; }
      case "H": if (!segment(num(), y)) return false; break;
      case "h": if (!segment(x + num(), y)) return false; break;
      case "V": if (!segment(x, num())) return false; break;
      case "v": if (!segment(x, y + num())) return false; break;
      case "Z": case "z": if (!segment(startX, startY)) return false; cmd = ""; break;
      default: return false;
    }
  }
  return true;
}

describe("the PIXEL_STROKE exception has teeth", () => {
  const path = (d: string): Element => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
    el.setAttribute("d", d);
    return el;
  };
  it("accepts straight runs on the pixel grid, absolute and relative", () => {
    expect(isPixelAlignedAxisPath(path("M4.8 6H19.2"))).toBe(true);
    expect(isPixelAlignedAxisPath(path("M12 3.6v16.8M4.8 12h14.4"))).toBe(true);
    expect(isPixelAlignedAxisPath(path("M3.6 3.6L3.6 20.4L20.4 20.4"))).toBe(true);
  });
  it("refuses a run between pixels, a diagonal and a curve", () => {
    expect(isPixelAlignedAxisPath(path("M4.8 6.6H19.2"))).toBe(false);
    expect(isPixelAlignedAxisPath(path("M4.8 4.8L19.2 19.2"))).toBe(false);
    expect(isPixelAlignedAxisPath(path("M4.8 6a2 2 0 0 1 4 0"))).toBe(false);
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    expect(isPixelAlignedAxisPath(circle)).toBe(false);
  });
});

describe("the transform rules have teeth", () => {
  it("accepts turns, moves and mirrors", () => {
    expect(isRigidTransform("rotate(-45 12 12)")).toBe(true);
    expect(isRigidTransform("rotate(-45 6 18) translate(6 7.2)")).toBe(true);
    expect(isRigidTransform("translate(10.8 20.4) rotate(-90)")).toBe(true);
    expect(isRigidTransform("matrix(1 0 0 -1 0 18)")).toBe(true);
    expect(isRigidTransform("matrix(-1,0,0,1,24,0)")).toBe(true);
  });
  it("refuses a scale, a skew, a stretching matrix and an unknown token", () => {
    expect(isRigidTransform("scale(0.75)")).toBe(false);
    expect(isRigidTransform("translate(2 2) scale(1.2)")).toBe(false);
    expect(isRigidTransform("skewX(10)")).toBe(false);
    expect(isRigidTransform("matrix(0.75 0 0 0.75 3 3)")).toBe(false);
    expect(isRigidTransform("rotate(45) bogus")).toBe(false);
  });
  it("a PIXEL_STROKE line inside a rotated group is found", () => {
    act(() => {
      root.render(
        <IconFrame size={20}>
          <g transform="rotate(45 12 12)">
            <path d="M4.8 12H19.2" fill="none" stroke={ACCENT} strokeWidth={PIXEL_STROKE} />
          </g>
        </IconFrame>,
      );
    });
    const line = container.querySelector("path")!;
    expect(isPixelAlignedAxisPath(line)).toBe(true); // the `d` alone looks legal...
    expect(line.closest("[transform]")).not.toBeNull(); // ...which is why the group is checked
  });
});

// ============================================================================
// The frame
// ============================================================================

describe("IconFrame", () => {
  it("is aria-hidden without a title and announced with one", () => {
    act(() => {
      root.render(
        <IconFrame size={20}>
          <rect x="2" y="2" width="20" height="20" rx="3" fill={SOFT} />
        </IconFrame>,
      );
    });
    let svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("role")).toBeNull();

    act(() => {
      root.render(
        <IconFrame size={20} title="Insert chart">
          <rect x="2" y="2" width="20" height="20" rx="3" fill={SOFT} />
        </IconFrame>,
      );
    });
    svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBeNull();
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.querySelector("title")?.textContent).toBe("Insert chart");
  });
});

// ============================================================================
// The source
// ============================================================================

describe("src/api/icons source", () => {
  const ICONS_DIR = path.resolve(__dirname, "../icons");
  const files = fs
    .readdirSync(ICONS_DIR)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => ({ name: f, text: fs.readFileSync(path.join(ICONS_DIR, f), "utf8") }));

  it("finds the icon modules", () => {
    // marks.tsx (2026-10-22) is the Visuals family's construction kit.
    expect(files.map((f) => f.name).sort()).toEqual(
      ["chart.tsx", "data.tsx", "frame.tsx", "generic.tsx", "home.tsx", "index.ts", "marks.tsx"].sort(),
    );
  });

  it.each(files.map((f) => [f.name, f.text] as const))(
    "%s contains no colour literal and draws no <text>",
    (_name, text) => {
      // No hex ANYWHERE, comments included: the whole folder is literal-free.
      expect(text).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(text).not.toMatch(/\brgba?\(|\bhsla?\(/);
      // The comments explain the <text> ban, so look for the element only in
      // code.
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code).not.toMatch(/<text[\s>/]/);
    },
  );
});

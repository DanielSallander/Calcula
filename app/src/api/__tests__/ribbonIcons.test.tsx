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
} from "../icons";
import { findHardcodedColours } from "../layout/testing";

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
  // data / BI / page layout
  "Table", "Pivot", "PivotFields", "CalcField", "FilterPages", "Fx",
  "ChangeSource", "Slicer", "Timeline", "Sparkline", "SparkLine", "SparkColumn",
  "SparkWinLoss", "Report", "Lightning", "Theme", "Fonts", "Colors", "Effects",
  "Margins", "Orientation", "PageSize", "PrintArea", "Breaks", "Background",
  "TableStyle", "BandedRows", "BandedColumns", "HeaderRow", "TotalRow",
  "FirstColumn", "LastColumn", "FilterButton", "Subtotals", "GrandTotals",
  "ReportLayout", "BlankRows", "Expand", "Collapse", "ClearFilter", "Connection",
] as const;

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
      if (!(width >= MIN_STROKE)) thin.push(`<${el.tagName}> stroke-width=${width}`);
    }
    expect(thin).toEqual([]);
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
    expect(files.map((f) => f.name).sort()).toEqual(
      ["chart.tsx", "data.tsx", "frame.tsx", "generic.tsx", "home.tsx", "index.ts"].sort(),
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

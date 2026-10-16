//! FILENAME: app/extensions/Pivot/__tests__/pivotStyleSourceDrift.test.ts
// PURPOSE: Ruling R3 (WP-C S10b): the pivot style presets are ONE data file,
//          styles/excelPivotStyles.json, read by this extension AND by the Rust
//          backend (app/src-tauri/src/pivot/grid_theme.rs `include_str!`), so the
//          hidden grid under a pivot -- and so a copy of its cells -- wears the
//          colours the box paints. The compiler cannot see across the boundary,
//          so this test reads the Rust source as TEXT (the
//          visualContainerLimitsDrift.test.ts shape) and pins:
//            1. the Rust include path resolves to the SAME file this extension
//               imports, and the TS module imports it (no second list on either
//               side: no colour literal in the TS styles module, none of the
//               old fixed constants in the Rust writer);
//            2. the module's catalogue IS the file's content;
//            3. DEFAULT_PIVOT_THEME's style keys ARE the file's fallbackTheme;
//            4. the resolution rule, case for case with the Rust test
//               `the_resolution_rule_matches_the_extension` (grid_theme_tests.rs).
//          The Rust tests pin the reverse direction (`rust_reads_the_file_the_
//          extension_imports`).

import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

vi.mock("@api/gridOverlays", () => ({ requestOverlayRedraw: vi.fn() }));

import {
  DEFAULT_EXCEL_PIVOT_STYLE,
  EXCEL_PIVOT_STYLES,
  EXCEL_PIVOT_STYLE_THEMES,
  FALLBACK_PIVOT_STYLE_THEME,
} from "../styles/excelPivotStyles";
import { getThemeOverridesForStyle, resolvePivotStyleOverrides, DEFAULT_PIVOT_STYLE_ID } from "../lib/pivotStyles";
import { DEFAULT_PIVOT_THEME, createPivotTheme } from "../rendering/pivot";

const APP = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP, rel), "utf8").replace(/\r\n/g, "\n");

const DATA_REL = "extensions/Pivot/styles/excelPivotStyles.json";
const TS_MODULE_REL = "extensions/Pivot/styles/excelPivotStyles.ts";
const RUST_REL = "src-tauri/src/pivot/grid_theme.rs";
const RUST_WRITER_REL = "src-tauri/src/pivot/operations.rs";
const FIX = `Edit ${DATA_REL} only; ${TS_MODULE_REL} and ${RUST_REL} must keep reading it.`;

interface DataFile {
  defaultStyle: string;
  fallbackTheme: Record<string, string>;
  styles: Array<Record<string, unknown> & { name: string; theme: Record<string, string> }>;
}
const DATA = JSON.parse(read(DATA_REL)) as DataFile;

describe("pivot style presets: one file, two readers", () => {
  it("the Rust backend include_str!s the very file this extension imports", () => {
    const rust = read(RUST_REL);
    const literal = /include_str!\("([^"]+)"\)/.exec(rust);
    expect(literal, `${RUST_REL} has no include_str! of the style data. ${FIX}`).not.toBeNull();
    const constPath = /pub\(crate\) const PIVOT_STYLE_DATA_PATH: &str = "([^"]+)";/.exec(rust);
    expect(constPath?.[1], `${RUST_REL}: PIVOT_STYLE_DATA_PATH and the include_str! literal disagree`).toBe(literal![1]);
    const rustTarget = path.resolve(path.dirname(path.join(APP, RUST_REL)), literal![1]);
    expect(rustTarget, FIX).toBe(path.join(APP, DATA_REL));

    const tsModule = read(TS_MODULE_REL);
    expect(tsModule, `${TS_MODULE_REL} must import the data file`).toContain('import pivotStyleData from "./excelPivotStyles.json";');
  });

  it("neither side keeps a hand-copied preset list", () => {
    const tsModule = read(TS_MODULE_REL);
    expect(tsModule.match(/#[0-9a-fA-F]{6}\b/g) ?? [], `${TS_MODULE_REL} spells colours again. ${FIX}`).toEqual([]);
    const writer = read(RUST_WRITER_REL);
    for (const gone of ["PIVOT_HEADER_BG", "PIVOT_TOTAL_BG", "PIVOT_GRAND_TOTAL_BG", "PIVOT_FILTER_BG", "PIVOT_BORDER_COLOR", "PIVOT_HEADER_BORDER", "Color::new("]) {
      expect(writer.includes(gone), `${RUST_WRITER_REL} still carries ${gone}: the hidden grid would not follow the style`).toBe(false);
    }
  });

  it("the extension's catalogue IS the file's content", () => {
    expect(EXCEL_PIVOT_STYLES).toEqual(DATA.styles);
    expect(DEFAULT_EXCEL_PIVOT_STYLE).toBe(DATA.defaultStyle);
    expect(DEFAULT_PIVOT_STYLE_ID).toBe(DATA.defaultStyle);
    expect(FALLBACK_PIVOT_STYLE_THEME).toEqual(DATA.fallbackTheme);
    for (const style of DATA.styles) {
      expect(EXCEL_PIVOT_STYLE_THEMES.get(style.name), style.name).toEqual(style.theme);
      expect(getThemeOverridesForStyle(style.name), style.name).toEqual(style.theme);
      expect(Object.keys(style.theme).sort(), `${style.name}: its theme keys are not the fallback theme's`).toEqual(
        Object.keys(DATA.fallbackTheme).sort(),
      );
    }
  });

  it("DEFAULT_PIVOT_THEME's style keys are the file's fallbackTheme", () => {
    for (const [key, value] of Object.entries(DATA.fallbackTheme)) {
      expect((DEFAULT_PIVOT_THEME as unknown as Record<string, unknown>)[key], key).toBe(value);
    }
  });
});

describe("pivot style resolution: the rule the backend mirrors", () => {
  const preset = (name: string): Record<string, string> => DATA.styles.find((s) => s.name === name)!.theme;
  const resolved = (styleId: string | null, overrides?: Record<string, string>): Record<string, unknown> =>
    createPivotTheme(resolvePivotStyleOverrides(styleId, overrides)) as unknown as Record<string, unknown>;
  const withFallback = (theme: Record<string, string>): Record<string, unknown> =>
    ({ ...DEFAULT_PIVOT_THEME, ...theme }) as unknown as Record<string, unknown>;

  it("no style or \"\" = the default style; an unknown id = the fallback theme", () => {
    expect(resolved(null)).toEqual(withFallback(preset(DATA.defaultStyle)));
    expect(resolved("")).toEqual(withFallback(preset(DATA.defaultStyle)));
    expect(resolved("NoSuchStyle")).toEqual(DEFAULT_PIVOT_THEME);
    expect(resolved("PivotStyleDark1")).toEqual(withFallback(preset("PivotStyleDark1")));
    expect(resolved("PivotStyleDark1")).not.toEqual(resolved(null));
  });

  it("an override wins only for a style colour key with a #rrggbb value", () => {
    const dark1 = resolved("PivotStyleDark1");
    const over = resolved("PivotStyleDark1", {
      grandTotalBackground: "#112233",
      headerText: "#AbCdEf",
      headerFontWeight: "#000000",
      fontFamily: "#000000",
      valueBackground: "red",
      labelBackground: "#12345",
    });
    expect(over.grandTotalBackground).toBe("#112233");
    expect(over.headerText).toBe("#AbCdEf");
    expect(over.headerFontWeight).toBe(dark1.headerFontWeight);
    expect(over.fontFamily).toBe(DEFAULT_PIVOT_THEME.fontFamily);
    expect(over.valueBackground).toBe(dark1.valueBackground);
    expect(over.labelBackground).toBe(dark1.labelBackground);
  });
});

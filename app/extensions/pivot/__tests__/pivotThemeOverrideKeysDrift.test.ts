//! FILENAME: app/extensions/Pivot/__tests__/pivotThemeOverrideKeysDrift.test.ts
// PURPOSE: The persisted PivotTable style's colour OVERRIDE keys cross the
//          Rust <-> TypeScript boundary as map keys (Rust
//          `pivot_engine::PIVOT_THEME_OVERRIDE_KEYS`, core/pivot-engine/src/
//          definition.rs; spec 2.8.2, review R2-12): Rust validates them on
//          every write, and they NAME TypeScript `PivotTheme` fields
//          (rendering/pivot.ts). The compiler cannot see across, so this test
//          reads the Rust array as TEXT (direction Rust -> TS) and pins:
//            1. the Rust array == the extension's PIVOT_THEME_OVERRIDE_KEYS
//               (lib/pivotStylePersist.ts), element for element -- so the
//               Style card can never offer a key the backend refuses;
//            2. every key is a COLOUR field of PivotTheme, checked against a
//               table typed `satisfies Record<PivotThemeColourKey, true>` AND
//               compared at run time with DEFAULT_PIVOT_THEME's own string
//               fields (test files are outside `check-types`, so the run-time
//               diff is what fails when a PivotTheme field is renamed).

import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

vi.mock("@api/gridOverlays", () => ({ requestOverlayRedraw: vi.fn() }));
vi.mock("../lib/pivot-api", () => ({ updatePivotProperties: vi.fn() }));

import { PIVOT_THEME_OVERRIDE_KEYS } from "../lib/pivotStylePersist";
import { DEFAULT_PIVOT_THEME, type PivotTheme } from "../rendering/pivot";

const REPO = path.resolve(__dirname, "../../../..");
const DEFINITION_RS = "core/pivot-engine/src/definition.rs";

/** The string elements of `pub const PIVOT_THEME_OVERRIDE_KEYS: &[&str] = &[ ... ];`, in order. */
export function rustOverrideKeys(src: string): string[] | null {
  const m = /pub const PIVOT_THEME_OVERRIDE_KEYS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/.exec(src);
  if (!m) return null;
  const body = m[1].replace(/\/\/.*$/gm, "");
  return Array.from(body.matchAll(/"([^"]*)"/g), (x) => x[1]);
}

/** The PivotTheme keys whose value is a colour (string), never a number or the font weight. */
type PivotThemeColourKey = Exclude<
  { [K in keyof PivotTheme]: PivotTheme[K] extends string ? K : never }[keyof PivotTheme],
  "fontFamily" | "headerFontWeight"
>;

const COLOUR_KEYS = {
  headerText: true,
  labelText: true,
  valueText: true,
  totalText: true,
  grandTotalText: true,
  filterText: true,
  headerBackground: true,
  labelBackground: true,
  valueBackground: true,
  totalBackground: true,
  grandTotalBackground: true,
  filterRowBackground: true,
  alternateRowBackground: true,
  borderColor: true,
  headerBorderColor: true,
  filterButtonBackground: true,
  filterButtonBorder: true,
  filterButtonHoverBackground: true,
  filterDropdownArrow: true,
  iconColor: true,
  iconHoverColor: true,
  selectionBackground: true,
  selectionBorder: true,
} satisfies Record<PivotThemeColourKey, true>;

describe("PIVOT_THEME_OVERRIDE_KEYS: Rust -> TypeScript", () => {
  const src = fs.readFileSync(path.join(REPO, DEFINITION_RS), "utf8").replace(/\r\n/g, "\n");
  const rust = rustOverrideKeys(src);

  it("the Rust array is found and is not empty (the parse has something to compare)", () => {
    expect(rust, `PIVOT_THEME_OVERRIDE_KEYS not found in ${DEFINITION_RS}`).not.toBeNull();
    expect(rust!.length).toBeGreaterThan(5);
  });

  it("equals the extension's list, element for element", () => {
    expect([...PIVOT_THEME_OVERRIDE_KEYS]).toEqual(rust);
  });

  it("the colour-key table IS PivotTheme's colour fields (run time: test files are not type-checked)", () => {
    const fromTheme = Object.entries(DEFAULT_PIVOT_THEME)
      .filter(([k, v]) => typeof v === "string" && k !== "fontFamily" && k !== "headerFontWeight")
      .map(([k]) => k)
      .sort();
    expect(Object.keys(COLOUR_KEYS).sort()).toEqual(fromTheme);
  });

  it("every key names a COLOUR field of PivotTheme", () => {
    for (const key of rust!) {
      expect(Object.prototype.hasOwnProperty.call(COLOUR_KEYS, key), `${key} is not a PivotTheme colour key`).toBe(true);
      expect(typeof (DEFAULT_PIVOT_THEME as unknown as Record<string, unknown>)[key]).toBe("string");
    }
  });

  it("the parse has teeth: a planted key, a dropped key and a missing array are all seen", () => {
    const planted = src.replace(`"borderColor",`, `"borderColor",\n    "fontSize",`);
    expect(rustOverrideKeys(planted)).toContain("fontSize");
    const dropped = src.replace(`    "headerText",\n`, "");
    expect(rustOverrideKeys(dropped)).not.toContain("headerText");
    expect(rustOverrideKeys("pub const OTHER: &[&str] = &[];")).toBeNull();
  });
});

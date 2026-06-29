//! FILENAME: app/extensions/Charts/lib/__tests__/chartParams.test.ts
// PURPOSE: C5 slice 1 — named params: value coercion, validation, resolution
//          (literal + mocked cell), and end-to-end injection into filter /
//          calculate expressions via applyTransforms.

import { vi, describe, it, expect, beforeEach } from "vitest";

// resolveParams reads a cell via dataSourceResolver.resolveParamCell — stub it.
vi.mock("../dataSourceResolver", () => ({ resolveParamCell: vi.fn() }));

import { resolveParamCell } from "../dataSourceResolver";
import { resolveParams, coerceToFormulaValue, coerceCellValue, validateParams } from "../chartParams";
import { applyTransforms } from "../chartTransforms";
import type { ChartSpec, ParamSpec, FilterTransform, CalculateTransform, ParsedChartData } from "../../types";

const mockCell = resolveParamCell as unknown as ReturnType<typeof vi.fn>;
const specWithParams = (params: ParamSpec[]): ChartSpec => ({ data: "Sheet1!A1:B3", params } as unknown as ChartSpec);

beforeEach(() => mockCell.mockReset());

describe("coerceToFormulaValue", () => {
  it("preserves number/boolean and coerces numeric/boolean-looking strings", () => {
    expect(coerceToFormulaValue(42)).toBe(42);
    expect(coerceToFormulaValue(true)).toBe(true);
    expect(coerceToFormulaValue("42")).toBe(42);
    expect(coerceToFormulaValue("3.5")).toBe(3.5);
    expect(coerceToFormulaValue("TRUE")).toBe(true);
    expect(coerceToFormulaValue("false")).toBe(false);
  });

  it("keeps non-numeric text as a string and maps empty/null to \"\"", () => {
    expect(coerceToFormulaValue("North")).toBe("North");
    expect(coerceToFormulaValue("")).toBe("");
    expect(coerceToFormulaValue(null)).toBe("");
    expect(coerceToFormulaValue(undefined)).toBe("");
  });
});

describe("coerceCellValue (formatted cell display)", () => {
  it("parses formatted/locale numbers like the chart data reader does", () => {
    expect(coerceCellValue("$1,000")).toBe(1000);
    expect(coerceCellValue("50%")).toBe(0.5);
    expect(coerceCellValue("(123)")).toBe(-123);
    expect(coerceCellValue("42")).toBe(42);
    expect(coerceCellValue("0")).toBe(0);
  });

  it("maps booleans and keeps non-numeric text / empty", () => {
    expect(coerceCellValue("TRUE")).toBe(true);
    expect(coerceCellValue("false")).toBe(false);
    expect(coerceCellValue("North")).toBe("North");
    expect(coerceCellValue("")).toBe("");
  });
});

describe("validateParams", () => {
  it("flags reserved names, duplicates, cross-sheet refs, and missing names", () => {
    const issues = validateParams([
      { name: "value", value: 1 },
      { name: "T", value: 1 },
      { name: "T", value: 2 },
      { name: "X", cellRef: "=Sheet2!A1" },
      { name: "", value: 0 },
    ]);
    expect(issues.some((m) => m.includes("reserved"))).toBe(true);
    expect(issues.some((m) => m.includes("Duplicate"))).toBe(true);
    expect(issues.some((m) => m.includes("cross-sheet"))).toBe(true);
    expect(issues.some((m) => m.includes("missing a name"))).toBe(true);
  });

  it("accepts a clean param set", () => {
    expect(validateParams([{ name: "Threshold", value: 100 }, { name: "Region", cellRef: "=B1" }])).toEqual([]);
  });
});

describe("resolveParams", () => {
  it("resolves literal values without reading cells", async () => {
    const map = await resolveParams(specWithParams([{ name: "T", value: 100 }, { name: "Label", value: "hi" }]));
    expect(map.get("T")).toBe(100);
    expect(map.get("Label")).toBe("hi");
    expect(mockCell).not.toHaveBeenCalled();
  });

  it("resolves a cell ref to its coerced value", async () => {
    mockCell.mockResolvedValue("42");
    const map = await resolveParams(specWithParams([{ name: "T", cellRef: "=B1" }]));
    expect(map.get("T")).toBe(42);
  });

  it("parses a formatted cell value (currency) via the data-cell coercion", async () => {
    mockCell.mockResolvedValue("$1,000");
    const map = await resolveParams(specWithParams([{ name: "T", cellRef: "=B1" }]));
    expect(map.get("T")).toBe(1000);
  });

  it("falls back to the literal default when the cell is empty", async () => {
    mockCell.mockResolvedValue(null);
    const map = await resolveParams(specWithParams([{ name: "T", cellRef: "=B1", value: "def" }]));
    expect(map.get("T")).toBe("def");
  });

  it("skips reserved names and keeps the first of duplicate names", async () => {
    const map = await resolveParams(specWithParams([
      { name: "value", value: 1 },
      { name: "T", value: 1 },
      { name: "T", value: 2 },
    ]));
    expect(map.has("value")).toBe(false);
    expect(map.get("T")).toBe(1);
  });

  it("returns an empty map when no params are declared", async () => {
    expect((await resolveParams({ data: "A1:B2" } as unknown as ChartSpec)).size).toBe(0);
  });
});

describe("param injection into transforms", () => {
  const data: ParsedChartData = {
    categories: ["a", "b", "c"],
    series: [{ name: "v", values: [50, 150, 250], color: null }],
  };

  it("filters using a param referenced in the predicate", async () => {
    const filter: FilterTransform = { type: "filter", field: "v", predicate: "value > [Threshold]" };
    const out = await applyTransforms(data, [filter], undefined, undefined, undefined, new Map([["Threshold", 100]]));
    expect(out.categories).toEqual(["b", "c"]);
    expect(out.series[0].values).toEqual([150, 250]);
  });

  it("keeps all rows (no silent drop) when the referenced param is absent", async () => {
    const filter: FilterTransform = { type: "filter", field: "v", predicate: "value > [Threshold]" };
    const out = await applyTransforms(data, [filter]); // no params -> #NAME? -> rows kept
    expect(out.categories).toEqual(["a", "b", "c"]);
  });

  it("computes a calculated series using a param", async () => {
    const calc: CalculateTransform = { type: "calculate", expr: "v * [Mult]", as: "scaled" };
    const out = await applyTransforms(data, [calc], undefined, undefined, undefined, new Map([["Mult", 2]]));
    expect(out.series.find((s) => s.name === "scaled")?.values).toEqual([100, 300, 500]);
  });

  it("never lets a param shadow a reserved built-in (value wins)", async () => {
    // A rogue param literally named 'value' must not override the field value.
    const filter: FilterTransform = { type: "filter", field: "v", predicate: "value > 100" };
    const out = await applyTransforms(data, [filter], undefined, undefined, undefined, new Map([["value", 9999]]));
    // Built-in 'value' = each row's v, so 150 & 250 pass — not all rows via 9999.
    expect(out.categories).toEqual(["b", "c"]);
  });

  it("never lets a param shadow a real series of the same name (series wins)", async () => {
    const calc: CalculateTransform = { type: "calculate", expr: "v + 0", as: "copy" };
    const out = await applyTransforms(data, [calc], undefined, undefined, undefined, new Map([["v", 9999]]));
    // 'v' resolves to the series value per row, not the param's 9999.
    expect(out.series.find((s) => s.name === "copy")?.values).toEqual([50, 150, 250]);
  });

  it("resolves a bracketed param reference written with internal spaces", async () => {
    const filter: FilterTransform = { type: "filter", field: "v", predicate: "value > [ Threshold ]" };
    const out = await applyTransforms(data, [filter], undefined, undefined, undefined, new Map([["Threshold", 100]]));
    expect(out.categories).toEqual(["b", "c"]);
  });
});

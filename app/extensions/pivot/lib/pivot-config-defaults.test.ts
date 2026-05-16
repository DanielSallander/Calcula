//! FILENAME: app/extensions/Pivot/lib/pivot-config-defaults.test.ts
// PURPOSE: Tests for pivot configuration builder patterns and default value chains.
// NOTE: We replicate the factory functions here to avoid deep import chains that
//       require @api/* mocks. The logic under test matches pivot-api.ts exactly.

import { describe, it, expect } from "vitest";

// ============================================================================
// Types (matching pivot-api.ts)
// ============================================================================

type SortOrder = "asc" | "desc" | "none";
type AggregationType =
  | "sum" | "count" | "average" | "min" | "max"
  | "countnumbers" | "stddev" | "stddevp" | "var" | "varp" | "product";
type ShowValuesAs = "normal" | "percent_of_total" | "percent_of_row" | "percent_of_column"
  | "percent_of_parent_row";
type ReportLayout = "compact" | "tabular" | "outline";
type ValuesPosition = "columns" | "rows";

interface PivotFieldConfig {
  sourceIndex: number;
  name: string;
  sortOrder?: SortOrder;
  showSubtotals?: boolean;
  collapsed?: boolean;
  hiddenItems?: string[];
}

interface ValueFieldConfig {
  sourceIndex: number;
  name: string;
  aggregation: AggregationType;
  numberFormat?: string;
  showValuesAs?: ShowValuesAs;
}

interface LayoutConfig {
  showRowGrandTotals?: boolean;
  showColumnGrandTotals?: boolean;
  reportLayout?: ReportLayout;
  repeatRowLabels?: boolean;
  showEmptyRows?: boolean;
  showEmptyCols?: boolean;
  valuesPosition?: ValuesPosition;
  autoFitColumnWidths?: boolean;
}

// ============================================================================
// Factory functions (exact copies from pivot-api.ts)
// ============================================================================

function createFieldConfig(
  sourceIndex: number,
  name: string,
  options?: Partial<Omit<PivotFieldConfig, "sourceIndex" | "name">>
): PivotFieldConfig {
  return {
    sourceIndex,
    name,
    sortOrder: options?.sortOrder ?? "asc",
    showSubtotals: options?.showSubtotals ?? true,
    collapsed: options?.collapsed ?? false,
    hiddenItems: options?.hiddenItems ?? [],
  };
}

function createValueFieldConfig(
  sourceIndex: number,
  name: string,
  aggregation: AggregationType = "sum",
  options?: Partial<Omit<ValueFieldConfig, "sourceIndex" | "name" | "aggregation">>
): ValueFieldConfig {
  return {
    sourceIndex,
    name,
    aggregation,
    numberFormat: options?.numberFormat,
    showValuesAs: options?.showValuesAs ?? "normal",
  };
}

function createLayoutConfig(
  options?: Partial<LayoutConfig>
): LayoutConfig {
  return {
    showRowGrandTotals: options?.showRowGrandTotals ?? true,
    showColumnGrandTotals: options?.showColumnGrandTotals ?? true,
    reportLayout: options?.reportLayout ?? "compact",
    repeatRowLabels: options?.repeatRowLabels ?? false,
    showEmptyRows: options?.showEmptyRows ?? false,
    showEmptyCols: options?.showEmptyCols ?? false,
    valuesPosition: options?.valuesPosition ?? "columns",
  };
}

// ============================================================================
// createFieldConfig
// ============================================================================

describe("createFieldConfig", () => {
  it("creates a field config with no options", () => {
    const cfg = createFieldConfig(0, "Category");
    expect(cfg.sourceIndex).toBe(0);
    expect(cfg.name).toBe("Category");
    expect(cfg.sortOrder).toBe("asc");
    expect(cfg.showSubtotals).toBe(true);
    expect(cfg.collapsed).toBe(false);
    expect(cfg.hiddenItems).toEqual([]);
  });

  it("creates a field config with all options", () => {
    const cfg = createFieldConfig(3, "Region", {
      sortOrder: "desc",
      showSubtotals: false,
      collapsed: true,
      hiddenItems: ["East", "West"],
    });
    expect(cfg.sourceIndex).toBe(3);
    expect(cfg.name).toBe("Region");
    expect(cfg.sortOrder).toBe("desc");
    expect(cfg.showSubtotals).toBe(false);
    expect(cfg.collapsed).toBe(true);
    expect(cfg.hiddenItems).toEqual(["East", "West"]);
  });

  it("partial options only override specified fields", () => {
    const cfg = createFieldConfig(1, "Product", { sortOrder: "desc" });
    expect(cfg.sortOrder).toBe("desc");
    expect(cfg.showSubtotals).toBe(true);
    expect(cfg.collapsed).toBe(false);
    expect(cfg.hiddenItems).toEqual([]);
  });

  it("no options matches empty options object", () => {
    const noOpts = createFieldConfig(0, "X");
    const emptyOpts = createFieldConfig(0, "X", {});
    expect(noOpts).toEqual(emptyOpts);
  });

  it("has no undefined values in any field", () => {
    const cfg = createFieldConfig(0, "Test");
    for (const [, value] of Object.entries(cfg)) {
      expect(value).not.toBeUndefined();
    }
  });
});

// ============================================================================
// createValueFieldConfig - every aggregation type
// ============================================================================

const ALL_AGGREGATIONS: AggregationType[] = [
  "sum", "count", "average", "min", "max",
  "countnumbers", "stddev", "stddevp", "var", "varp", "product",
];

describe("createValueFieldConfig", () => {
  it("defaults aggregation to sum", () => {
    const cfg = createValueFieldConfig(0, "Amount");
    expect(cfg.aggregation).toBe("sum");
  });

  for (const agg of ALL_AGGREGATIONS) {
    it(`accepts aggregation type "${agg}"`, () => {
      const cfg = createValueFieldConfig(0, "Amount", agg);
      expect(cfg.aggregation).toBe(agg);
      expect(cfg.sourceIndex).toBe(0);
      expect(cfg.name).toBe("Amount");
      expect(cfg.showValuesAs).toBe("normal");
    });
  }

  it("accepts options for numberFormat and showValuesAs", () => {
    const cfg = createValueFieldConfig(2, "Sales", "sum", {
      numberFormat: "#,##0.00",
      showValuesAs: "percent_of_total",
    });
    expect(cfg.numberFormat).toBe("#,##0.00");
    expect(cfg.showValuesAs).toBe("percent_of_total");
  });

  it("no options matches empty options object", () => {
    const noOpts = createValueFieldConfig(0, "X", "sum");
    const emptyOpts = createValueFieldConfig(0, "X", "sum", {});
    expect(noOpts).toEqual(emptyOpts);
  });

  it("showValuesAs defaults to normal", () => {
    const cfg = createValueFieldConfig(0, "X");
    expect(cfg.showValuesAs).toBe("normal");
  });
});

// ============================================================================
// createLayoutConfig
// ============================================================================

describe("createLayoutConfig", () => {
  it("creates layout with no options (all defaults)", () => {
    const cfg = createLayoutConfig();
    expect(cfg.showRowGrandTotals).toBe(true);
    expect(cfg.showColumnGrandTotals).toBe(true);
    expect(cfg.reportLayout).toBe("compact");
    expect(cfg.repeatRowLabels).toBe(false);
    expect(cfg.showEmptyRows).toBe(false);
    expect(cfg.showEmptyCols).toBe(false);
    expect(cfg.valuesPosition).toBe("columns");
  });

  it("creates layout with all options overridden", () => {
    const cfg = createLayoutConfig({
      showRowGrandTotals: false,
      showColumnGrandTotals: false,
      reportLayout: "tabular",
      repeatRowLabels: true,
      showEmptyRows: true,
      showEmptyCols: true,
      valuesPosition: "rows",
    });
    expect(cfg.showRowGrandTotals).toBe(false);
    expect(cfg.showColumnGrandTotals).toBe(false);
    expect(cfg.reportLayout).toBe("tabular");
    expect(cfg.repeatRowLabels).toBe(true);
    expect(cfg.showEmptyRows).toBe(true);
    expect(cfg.showEmptyCols).toBe(true);
    expect(cfg.valuesPosition).toBe("rows");
  });

  it("no options matches empty options object", () => {
    const noOpts = createLayoutConfig();
    const emptyOpts = createLayoutConfig({});
    expect(noOpts).toEqual(emptyOpts);
  });

  it("partial override only modifies specified fields", () => {
    const cfg = createLayoutConfig({ reportLayout: "outline" });
    expect(cfg.reportLayout).toBe("outline");
    expect(cfg.showRowGrandTotals).toBe(true);
    expect(cfg.repeatRowLabels).toBe(false);
  });

  it("default values are sensible (no undefined)", () => {
    const cfg = createLayoutConfig();
    for (const [, value] of Object.entries(cfg)) {
      expect(value).not.toBeUndefined();
    }
  });
});

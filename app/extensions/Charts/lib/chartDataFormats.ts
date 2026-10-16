//! FILENAME: app/extensions/Charts/lib/chartDataFormats.ts
// PURPOSE: The Data format card's rows for a design-query chart: one per
//          measure the chart's query plots, with the user's override
//          (`spec.fieldFormats[measure]`) and what the model says
//          (`MeasureFieldInfo.formatString`, shown as the placeholder).
// CONTEXT: Injected into the chart's @api/objectFormat provider by activate()
//          (lib/chartObjectFormat.ts imports no store-reading module: the store
//          imports it). The query is compiled exactly as the reader compiles it
//          (`compileDesignQuerySource`), so the rows name the measures the
//          chart really plots, in plot order.

import type { DataFormatField } from "@api/objectFormat";
import type { BiPivotModelInfo } from "../../_shared/components/types";
import type { ChartSpec } from "../types";
import { isDesignQueryDataSource } from "../types";
import { chartsBackend } from "./chartsBackend";
import { compileDesignQuerySource } from "./designQueryChartDataReader";

/** "[Sales]" and "Sales" name the same measure. */
function bare(name: string): string {
  return name.startsWith("[") && name.endsWith("]") ? name.slice(1, -1) : name;
}

/**
 * The data-format rows of a design-query chart (none for any other source).
 * Rejects with the compiler's / the backend's sentence when the query cannot
 * be compiled (no connection, the model not loaded, a DSL error).
 */
export async function designQueryDataFormats(chartId: string, spec: ChartSpec): Promise<DataFormatField[]> {
  if (!isDesignQueryDataSource(spec.data)) return [];
  const request = await compileDesignQuerySource(spec.data, { chartId });
  const model = await chartsBackend.invoke<BiPivotModelInfo | null>("get_connection_bi_model", {
    connectionId: spec.data.connectionId,
  });
  const sourceFormatOf = new Map<string, string | null>();
  for (const m of model?.measures ?? []) sourceFormatOf.set(bare(m.name), m.formatString ?? null);

  const out: DataFormatField[] = [];
  const seen = new Set<string>();
  for (const f of request.valueFields) {
    const key = bare(f.measureName);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: f.customName && f.customName.trim() !== "" ? f.customName : key,
      format: spec.fieldFormats?.[key] ?? null,
      sourceFormat: sourceFormatOf.get(key) ?? null,
    });
  }
  return out;
}

//! FILENAME: app/extensions/Charts/components/pane/ChartPivotDataTab.tsx
// PURPOSE: The object pane's Data tab for a PIVOT-SOURCED chart: which
//          PivotTable it reads (read-only), whether its subtotal rows and its
//          grand total row are plotted, and a door to the PivotTable itself.
// CONTEXT: WP-C S9c (D-PANE: a pivot-sourced chart has Data | Format). The
//          chart's data IS the PivotTable's output, so the fields are edited on
//          the PivotTable ("Select PivotTable" -> lib/selectSourcePivot: a box
//          on a canvas page opens the object pane on its Fields; a worksheet
//          PivotTable is selected at its anchor cell, where the pivot-editor
//          pane takes over). The two toggles write `data.includeSubtotals` /
//          `data.includeGrandTotal` as ONE `updateChartSpec({ data })` in ONE
//          undo step (lib/chartDataCommit).
//
//          The grand total's default is not "off": a PivotTable with no row
//          fields has no data rows, and then its grand total IS the data
//          (pivotChartDataReader.extractChartData). The toggle says so while
//          the chart has made no choice of its own.

import React, { useEffect, useReducer, useState } from "react";
import { onRegionChange } from "@api/gridOverlays";
import { pivot } from "@api/pivot";
import type { ObjectPaneTabContext } from "@api/objectPane";
import type { ChartDefinition, PivotDataSource } from "../../types";
import { isPivotDataSource } from "../../types";
import { ChartEvents } from "../../lib/chartEvents";
import { commitChartDataPatch } from "../../lib/chartDataCommit";
import { selectSourcePivot } from "../../lib/selectSourcePivot";
import { CheckboxLabel, FieldGroup, Label } from "../CreateChartDialog.styles";

export interface ChartPivotDataTabProps {
  ctx: ObjectPaneTabContext;
  chartId: string;
  getChart(chartId: string): ChartDefinition | null;
  /** Take the reader to the PivotTable (default: lib/selectSourcePivot). Resolves to a refusal or null. */
  selectPivot?: (pivotId: string) => Promise<string | null>;
  /** The PivotTable's display name (default: the @api/pivot facade). */
  pivotName?: (pivotId: string) => Promise<string | null>;
}

/** The hint under the grand-total toggle while the chart has made no choice. */
export const GRAND_TOTAL_AUTOMATIC_HINT =
  "Automatic: the grand total is plotted when the PivotTable has no row fields.";

async function defaultPivotName(pivotId: string): Promise<string | null> {
  const info = await pivot.getInfo(pivotId);
  return info && typeof info.name === "string" && info.name !== "" ? info.name : null;
}

/** The data source with one toggle set (the whole source: one write, nothing merged away). */
export function pivotSourceWith(
  data: PivotDataSource,
  key: "includeSubtotals" | "includeGrandTotal",
  value: boolean,
): PivotDataSource {
  return { ...data, [key]: value };
}

export function ChartPivotDataTab({
  ctx,
  chartId,
  getChart,
  selectPivot = selectSourcePivot,
  pivotName = defaultPivotName,
}: ChartPivotDataTabProps): React.ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const onUpdated = (): void => bump();
    window.addEventListener(ChartEvents.CHART_UPDATED, onUpdated);
    const offRegions = onRegionChange(() => bump());
    return () => {
      window.removeEventListener(ChartEvents.CHART_UPDATED, onUpdated);
      offRegions();
    };
  }, []);

  const chart = getChart(chartId);
  const data = chart && isPivotDataSource(chart.spec.data) ? chart.spec.data : null;
  const pivotId = data?.pivotId ?? null;
  const readOnly = ctx.readOnly;

  const [name, setName] = useState<{ pivotId: string; name: string | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (pivotId === null) return;
    let live = true;
    pivotName(pivotId)
      .then((n) => {
        if (live) setName({ pivotId, name: n, failed: false });
      })
      .catch((err) => {
        console.error("[Charts] The Data tab could not read the PivotTable's name:", err);
        if (live) setName({ pivotId, name: null, failed: true });
      });
    return () => {
      live = false;
    };
  }, [pivotId, pivotName]);

  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!chart || !data || pivotId === null) {
    return (
      <div data-testid="chart-pivot-data-tab" style={{ padding: "8px 12px", fontSize: 12 }}>
        This chart does not read a PivotTable.
      </div>
    );
  }

  const known = name !== null && name.pivotId === pivotId ? name : null;
  const sourceText = known === null
    ? "PivotTable"
    : known.name !== null
      ? `PivotTable ${known.name}`
      : "PivotTable (not found)";

  const toggle = (key: "includeSubtotals" | "includeGrandTotal", value: boolean): void => {
    if (readOnly) return;
    setMessage(null);
    commitChartDataPatch(chartId, { data: pivotSourceWith(data, key, value) }).catch((err) => {
      setMessage(err instanceof Error ? err.message : String(err));
    });
  };

  const onSelectPivot = (): void => {
    setMessage(null);
    setBusy(true);
    selectPivot(pivotId)
      .then((refusal) => {
        if (refusal) setMessage(refusal);
      })
      .finally(() => setBusy(false));
  };

  const grandTotalAutomatic = data.includeGrandTotal === undefined;

  return (
    <div
      data-testid="chart-pivot-data-tab"
      data-tab-id={ctx.activeTabId}
      style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}
    >
      <FieldGroup>
        <Label>Source</Label>
        <div>
          <span style={{ fontWeight: 600 }}>Source: </span>
          <span data-testid="chart-pivot-source">{sourceText}</span>
        </div>
        <div style={{ marginTop: 6 }}>
          <button type="button" data-testid="chart-pivot-select" disabled={busy} onClick={onSelectPivot}>
            Select PivotTable
          </button>
        </div>
        <div style={{ color: "var(--text-secondary, #605e5c)", marginTop: 6 }}>
          The chart plots the PivotTable's values. Change its fields on the PivotTable.
        </div>
      </FieldGroup>

      <fieldset
        disabled={readOnly}
        title={readOnly ? (ctx.readOnlyReason ?? undefined) : undefined}
        style={{ border: "none", padding: 0, margin: 0, minWidth: 0 }}
      >
        <FieldGroup>
          <Label>Rows plotted</Label>
          <CheckboxLabel>
            <input
              type="checkbox"
              data-testid="chart-pivot-subtotals"
              checked={data.includeSubtotals === true}
              onChange={(e) => toggle("includeSubtotals", e.target.checked)}
            />
            Include subtotals
          </CheckboxLabel>
          <CheckboxLabel>
            <input
              type="checkbox"
              data-testid="chart-pivot-grandtotal"
              checked={data.includeGrandTotal === true}
              onChange={(e) => toggle("includeGrandTotal", e.target.checked)}
            />
            Include grand total
          </CheckboxLabel>
          {grandTotalAutomatic && (
            <div data-testid="chart-pivot-grandtotal-automatic" style={{ color: "var(--text-secondary, #605e5c)", fontSize: 11 }}>
              {GRAND_TOTAL_AUTOMATIC_HINT}
            </div>
          )}
        </FieldGroup>
      </fieldset>

      {message && (
        <div data-testid="chart-pivot-data-message" aria-live="polite" style={{ color: "var(--text-error, #c42b1c)", fontSize: 11 }}>
          {message}
        </div>
      )}
    </div>
  );
}

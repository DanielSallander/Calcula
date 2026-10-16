//! FILENAME: app/extensions/Charts/components/pane/ChartBuildPending.tsx
// PURPOSE: The FALLBACK body of a chart's build tab in the object pane: where
//          the chart's data comes from, and the door that edits it (the chart
//          dialog's Data tab).
// CONTEXT: The real build tabs are ChartDesignQueryBuild (Fields / Design of
//          a design-query chart) and ChartRangeDataTab / ChartPivotDataTab
//          (Data of a range or PivotTable chart), routed by
//          lib/chartObjectPane.ts. This body answers only when none of them
//          applies -- e.g. a chart that is gone or whose source the tab does
//          not recognise -- so the tab is never a dead blank.

import React from "react";
import type { ObjectPaneTabContext } from "@api/objectPane";

export interface ChartBuildPendingProps {
  ctx: ObjectPaneTabContext;
  /** What the chart reads ("A design query on connection 3", "Sheet1!A1:D10", "PivotTable"). */
  sourceText: string;
  /** Open the chart's existing data editor. */
  onEditData: () => void;
}

export function ChartBuildPending({ ctx, sourceText, onEditData }: ChartBuildPendingProps): React.ReactElement {
  return (
    <div
      data-testid="chart-build-pending"
      data-tab-id={ctx.activeTabId}
      style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}
    >
      <div>
        <span style={{ fontWeight: 600 }}>Source: </span>
        <span data-testid="chart-build-source">{sourceText}</span>
      </div>
      <div style={{ color: "var(--text-secondary, #605e5c)" }}>
        This tab will edit the chart's data here. Until then, edit it in the chart dialog.
      </div>
      <div>
        <button
          type="button"
          data-testid="chart-build-edit-data"
          disabled={ctx.readOnly}
          title={ctx.readOnly ? (ctx.readOnlyReason ?? undefined) : undefined}
          onClick={onEditData}
        >
          Edit data...
        </button>
      </div>
    </div>
  );
}

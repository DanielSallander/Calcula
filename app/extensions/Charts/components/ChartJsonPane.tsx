//! FILENAME: app/extensions/Charts/components/ChartJsonPane.tsx
// PURPOSE: The "Chart JSON" task pane — the selected chart's stored entry as
//          editable JSON, with Apply / Revert.
// CONTEXT: Before the Clusters redesign the Chart Design band's JSON button
//          opened a 420x400 `position: fixed` box pinned to the top right of
//          the window: it covered the grid, ignored the task pane, could not be
//          resized or moved, and followed no skin. The editor itself was fine,
//          so it moves unchanged into a real task pane (TaskPaneViewDefinition
//          `chart-json`, contextKeys ["chart"], registered by index.ts) and the
//          band's JSON hero now opens and closes THIS pane.
//
//          The subject is the published chart selection (@api/chartSelection),
//          the same fact the Format pane reads, so the two panes can never be
//          about different charts. The body is keyed by chart id: selecting
//          another chart remounts it and fetches that chart's JSON, instead of
//          leaving the previous chart's text under a new title where Apply
//          would write it onto the wrong object.
//
//          The load / apply / revert state machine is the shared one
//          (_shared/components/jsonToggle): this file only decides WHEN to load
//          (on mount, once per chart) and lays the editor out in the pane.

import React, { useEffect, useRef, useSyncExternalStore } from "react";
import { css } from "@emotion/css";
import type { TaskPaneViewProps } from "@api/uiTypes";
import { getChartSelection, onChartSelectionChanged } from "@api/chartSelection";
import { RibbonIcon } from "@api/ribbonIcons";
import {
  Button,
  StatusText,
  LT,
  FONT_FAMILY,
  GAP_SM,
  GAP_MD,
  HEADER_FONT_SIZE,
} from "@api/layout";
import { useJsonToggle, JsonToggleEditor } from "../../_shared/components/jsonToggle";

/** Task pane view id of the Chart JSON pane. */
export const CHART_JSON_PANE_ID = "chart-json";

// ============================================================================
// Styles (tokens only)
// ============================================================================

const root = css`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  height: 100%;
  font-family: ${FONT_FAMILY};
  color: ${LT.text};
`;

const header = css`
  display: flex;
  align-items: center;
  gap: ${GAP_SM}px;
  flex: none;
  padding: ${GAP_MD}px 12px;
  border-bottom: 1px solid ${LT.controlDivider};
  font-size: ${HEADER_FONT_SIZE}px;
  font-weight: 600;
  min-width: 0;
`;

const headerIcon = css`
  display: inline-flex;
  flex: none;
`;

const headerText = css`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const editorBox = css`
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
`;

const message = css`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: ${GAP_MD}px;
  padding: 12px;
`;

const empty = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: ${GAP_MD}px;
  flex: 1;
  padding: 24px;
  text-align: center;
  color: ${LT.textSecondary};
`;

// ============================================================================
// Pane
// ============================================================================

/**
 * The Chart JSON task pane. With no chart selected it invites the reader to
 * select one (the pane stays open across a deselect, like the Format pane).
 */
export function ChartJsonPane(_props: TaskPaneViewProps): React.ReactElement {
  const selection = useSyncExternalStore(
    onChartSelectionChanged,
    getChartSelection,
    getChartSelection,
  );
  const chartId = selection.chartId;

  if (chartId === null) {
    return (
      <div className={root} data-testid="chart-json-pane">
        <div className={empty}>
          <RibbonIcon.Code size={24} />
          <StatusText>Select a chart to edit its definition as JSON.</StatusText>
        </div>
      </div>
    );
  }

  return <ChartJsonBody key={chartId} chartId={chartId} chartName={selection.chartName} />;
}

/** One chart's JSON editor. Mounted per chart id (see the header). */
function ChartJsonBody({
  chartId,
  chartName,
}: {
  chartId: string;
  chartName: string | null;
}): React.ReactElement {
  const json = useJsonToggle("chart", chartId);
  const { toggle, isJsonMode } = json;

  // Load once on mount. `toggle` changes identity after the load (it closes
  // over isJsonMode), so the guard — not the dependency list — is what keeps
  // this from toggling straight back out of JSON mode.
  const requested = useRef(false);
  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    toggle();
  }, [toggle]);

  return (
    <div className={root} data-testid="chart-json-pane">
      <div className={header}>
        <span className={headerIcon} aria-hidden>
          <RibbonIcon.Code size={16} />
        </span>
        <span className={headerText}>{chartName ?? "Chart"}</span>
      </div>
      {isJsonMode ? (
        <div className={editorBox}>
          <JsonToggleEditor
            json={json.json}
            onChange={json.setJson}
            onApply={json.apply}
            onRevert={json.revert}
            dirty={json.dirty}
            error={json.error}
            loading={json.loading}
          />
        </div>
      ) : json.error !== null ? (
        <div className={message}>
          <StatusText title={json.error}>{json.error}</StatusText>
          <Button variant="outlined" data-testid="chart-json-retry" onClick={() => toggle()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className={message}>
          <StatusText>Loading chart JSON...</StatusText>
        </div>
      )}
    </div>
  );
}

//! FILENAME: app/extensions/Insights/components/InsightsPane.tsx
// PURPOSE: The "Insights" task pane — pick a source, press Analyse, read facts.
// CONTEXT: FOUR RULES THIS COMPONENT EXISTS TO KEEP.
//
//          1. IT NEVER ANALYSES ON SELECTION CHANGE. It only READS the selection
//             so it can show the range the button would send. A pane that
//             recomputes on every arrow key is a pane people close, and each
//             recompute is an IPC round trip over a rectangle still being
//             chosen.
//          2. NO MODEL, NO SWITCH. When the workbook has no BI connection the
//             source switch is not rendered at all. A permanently disabled
//             "Model" tab is a promise the workbook cannot keep, and it invites
//             the reader to hunt for the setting that would enable it.
//          3. AN EMPTY BUNDLE IS AN ANSWER. "Nothing stands out in this range."
//             is calm and true; an error box for a clean range would train the
//             reader to distrust the pane.
//          4. NOTES ARE NEVER HIDDEN. Sampling, excluded hidden rows, an
//             unreachable dimension — the caveats render as a footnote whenever
//             the bundle carries them, with no disclosure triangle in the way.

import React, { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { TaskPaneViewProps } from "@api/uiTypes";
import type { InsightEvidence } from "@api/insightsService";
import { ExtensionRegistry } from "@api/extensions";
import { getGridStateSnapshot, navigateToRange } from "@api/grid";
import { setActiveSheet } from "@api/lib";
import { showToast } from "@api/notifications";
import {
  analyzeCurrentSource,
  describeSelection,
  getState,
  setConnectionId,
  setSource,
  subscribe,
  toggleWhy,
  type SelectionTarget,
} from "../lib/store";
import { canSendToChat, sendBundleToChat } from "../lib/chatHandoff";
import { createReportSheet } from "../lib/backend";
import { InsightCard } from "./InsightCard";

// ============================================================================
// Styles
// ============================================================================

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  fontFamily: "Segoe UI, Tahoma, sans-serif",
  fontSize: 12,
  backgroundColor: "#FAFAFA",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid #E4E4E4",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const switchRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 4,
};

function switchButtonStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: "5px 8px",
    fontSize: 12,
    borderRadius: 4,
    cursor: "pointer",
    border: `1px solid ${active ? "#3A6EA5" : "#D5D5D5"}`,
    background: active ? "#EDF3FA" : "#FFF",
    color: active ? "#22456B" : "#555",
    fontWeight: active ? 600 : 400,
  };
}

const targetStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#666",
};

const targetStrongStyle: React.CSSProperties = {
  color: "#222",
  fontFamily: "Consolas, monospace",
};

const primaryButtonStyle: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 12,
  border: "1px solid #3A6EA5",
  borderRadius: 4,
  background: "#3A6EA5",
  color: "#FFF",
  cursor: "pointer",
};

const bodyStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const calmStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#555",
  padding: "8px 0",
};

const errorStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#8A2A2A",
  background: "#FCEFEF",
  border: "1px solid #F0CFCF",
  borderRadius: 4,
  padding: "8px 10px",
};

const droppedStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#777",
};

const notesStyle: React.CSSProperties = {
  borderTop: "1px solid #E4E4E4",
  paddingTop: 8,
  marginTop: 4,
  display: "flex",
  flexDirection: "column",
  gap: 3,
};

const noteItemStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#6A6A6A",
};

const footerStyle: React.CSSProperties = {
  borderTop: "1px solid #E4E4E4",
  padding: "8px 12px",
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
};

const footerButtonStyle: React.CSSProperties = {
  padding: "5px 9px",
  fontSize: 11,
  border: "1px solid #D5D5D5",
  borderRadius: 4,
  background: "#FFF",
  color: "#333",
  cursor: "pointer",
};

const selectStyle: React.CSSProperties = {
  fontSize: 12,
  padding: "4px 6px",
  border: "1px solid #D5D5D5",
  borderRadius: 4,
  background: "#FFF",
};

// ============================================================================
// Evidence navigation
// ============================================================================

/**
 * Select the cells a `range` evidence points at.
 *
 * The sheet switch has to happen FIRST and be awaited: `navigateToRange` emits a
 * navigation event against whatever sheet is active, so selecting a range on
 * sheet 3 while sheet 1 is showing would highlight the wrong cells.
 */
async function revealEvidence(evidence: InsightEvidence): Promise<void> {
  if (evidence.kind !== "range") return;
  const { sheetIndex, startRow, startCol, endRow, endCol } = evidence;
  if (
    startRow === undefined ||
    startCol === undefined ||
    endRow === undefined ||
    endCol === undefined
  ) {
    return;
  }
  const active = getGridStateSnapshot()?.sheetContext.activeSheetIndex;
  if (sheetIndex !== undefined && sheetIndex !== active) {
    try {
      await setActiveSheet(sheetIndex);
    } catch {
      // The sheet may have been deleted since the bundle was computed. Fall
      // through: selecting on the current sheet is wrong, so stop here instead.
      showToast("That sheet is no longer available", { variant: "warning" });
      return;
    }
  }
  navigateToRange(startRow, startCol, endRow, endCol);
}

// ============================================================================
// Component
// ============================================================================

export function InsightsPane(_props: TaskPaneViewProps): React.ReactElement {
  const state = useSyncExternalStore(subscribe, getState, getState);

  // The selection is READ, never subscribed-to-and-analysed. Keeping it in
  // local state (refreshed on the registry's selection event) is what lets the
  // button label stay honest without the pane ever recomputing facts.
  const [target, setTarget] = useState<SelectionTarget | null>(() => describeSelection());
  useEffect(() => {
    setTarget(describeSelection());
    return ExtensionRegistry.onSelectionChange(() => {
      setTarget(describeSelection());
    });
  }, []);

  const [busyReport, setBusyReport] = useState(false);

  const bundle = state.bundle;
  const modelAvailable = state.connections.length > 0;
  const isModel = state.source === "model" && modelAvailable;
  const running = state.status === "running";

  const onAnalyse = useCallback(() => {
    void analyzeCurrentSource();
  }, []);

  const onCopy = useCallback(() => {
    if (!bundle) return;
    const write = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (!write) {
      showToast("Copying is unavailable here", { variant: "warning" });
      return;
    }
    void write(bundle.markdown).then(
      () => showToast("Insights copied", { variant: "success" }),
      () => showToast("Could not copy the insights", { variant: "error" }),
    );
  }, [bundle]);

  const onSendToChat = useCallback(() => {
    if (!bundle) return;
    if (!sendBundleToChat(bundle, state.originLabel)) {
      showToast("The chat is not available", { variant: "warning" });
    }
  }, [bundle, state.originLabel]);

  const onCreateReport = useCallback(() => {
    const connectionId = state.connectionId;
    if (!connectionId) return;
    setBusyReport(true);
    void createReportSheet(connectionId)
      .then(async (created) => {
        await setActiveSheet(created.sheetIndex);
        showToast(`Report sheet "${created.sheetName}" created`, { variant: "success" });
      })
      .catch(() => showToast("The report sheet could not be created", { variant: "error" }))
      .finally(() => setBusyReport(false));
  }, [state.connectionId]);

  const onEvidenceClick = useCallback((evidence: InsightEvidence) => {
    void revealEvidence(evidence);
  }, []);

  // The "as of" line belongs to the model path: a model answer is only as fresh
  // as the last refresh behind it, while a range answer describes cells the
  // reader is looking at right now.
  const asOf = bundle && bundle.source === "model" ? state.computedAt : null;

  const analyseLabel = running ? "Analysing…" : "Analyse";
  const canAnalyse = !running && (isModel ? Boolean(state.connectionId) : Boolean(target));

  return (
    <div style={containerStyle} data-testid="insights-pane">
      <div style={headerStyle}>
        {modelAvailable && (
          <div style={switchRowStyle} role="group" aria-label="Insight source" data-testid="insights-source-switch">
            <button
              type="button"
              style={switchButtonStyle(state.source === "selection")}
              aria-pressed={state.source === "selection"}
              onClick={() => setSource("selection")}
            >
              Selection
            </button>
            <button
              type="button"
              style={switchButtonStyle(state.source === "model")}
              aria-pressed={state.source === "model"}
              onClick={() => setSource("model")}
            >
              Model
            </button>
          </div>
        )}

        {isModel && state.connections.length > 1 && (
          <select
            style={selectStyle}
            aria-label="Model connection"
            value={state.connectionId ?? ""}
            onChange={(e) => setConnectionId(e.target.value || null)}
          >
            {state.connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}

        <div style={targetStyle} data-testid="insights-target">
          {isModel ? (
            <>
              Will analyse the measures in{" "}
              <span style={targetStrongStyle}>
                {state.connections.find((c) => c.id === state.connectionId)?.name ??
                  "no connection"}
              </span>
              .
            </>
          ) : target ? (
            <>
              Will analyse <span style={targetStrongStyle}>{target.label}</span>
              {target.expanded ? ", expanded to the block around it." : "."}
            </>
          ) : (
            <>Select a range on the grid to analyse it.</>
          )}
        </div>

        <button
          type="button"
          style={{ ...primaryButtonStyle, opacity: canAnalyse ? 1 : 0.5 }}
          disabled={!canAnalyse}
          data-testid="insights-analyse"
          onClick={onAnalyse}
        >
          {analyseLabel}
        </button>
      </div>

      <div style={bodyStyle}>
        {state.status === "error" && state.error && (
          <div style={errorStyle} data-testid="insights-error">
            {state.error}
          </div>
        )}

        {state.status === "idle" && !bundle && (
          <div style={calmStyle} data-testid="insights-idle">
            Press Analyse to compute facts about this data. Nothing is sent to a model.
          </div>
        )}

        {bundle && bundle.insights.length === 0 && (
          <div style={calmStyle} data-testid="insights-empty">
            Nothing stands out in this range.
          </div>
        )}

        {bundle &&
          bundle.insights.map((insight) => (
            <InsightCard
              key={insight.id}
              insight={insight}
              asOf={asOf}
              whyExpanded={state.expandedWhy.includes(insight.id)}
              onToggleWhy={toggleWhy}
              onEvidenceClick={onEvidenceClick}
            />
          ))}

        {bundle && bundle.dropped > 0 && (
          <div style={droppedStyle} data-testid="insights-dropped">
            …and {bundle.dropped} more
          </div>
        )}

        {bundle && bundle.notes.length > 0 && (
          <div style={notesStyle} data-testid="insights-notes">
            {bundle.notes.map((note, i) => (
              <div key={i} style={noteItemStyle}>
                {note}
              </div>
            ))}
          </div>
        )}
      </div>

      {bundle && (
        <div style={footerStyle}>
          <button
            type="button"
            style={footerButtonStyle}
            data-testid="insights-copy"
            onClick={onCopy}
          >
            Copy as text
          </button>
          {canSendToChat() && (
            <button
              type="button"
              style={footerButtonStyle}
              data-testid="insights-send-to-chat"
              onClick={onSendToChat}
            >
              Send to chat
            </button>
          )}
          {isModel && (
            <button
              type="button"
              style={footerButtonStyle}
              disabled={busyReport || !state.connectionId}
              data-testid="insights-create-report"
              onClick={onCreateReport}
            >
              {busyReport ? "Creating…" : "Create report sheet"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

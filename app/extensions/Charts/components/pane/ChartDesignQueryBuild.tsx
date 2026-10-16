//! FILENAME: app/extensions/Charts/components/pane/ChartDesignQueryBuild.tsx
// PURPOSE: The ONE body behind a design-query chart's two build tabs in the
//          object pane (WP-C S9b): the connection select both tabs share,
//          then the Fields wells or the Design editor by the active tab.
// CONTEXT: The object pane keeps ONE instance across build tabs that return
//          the same component type (@api/objectPane ObjectPaneTab.render), so
//          this host is where state that must survive a tab switch lives: the
//          connection list, the loaded model, the Design tab's unapplied
//          draft and the last refusal. Every write goes through
//          `commitDesignQuery` (one validated write, one undo step); this
//          component holds no second copy of the query -- it re-reads the
//          stored chart on every CHART_UPDATED.

import React, { useCallback, useEffect, useState } from "react";
import type { ConnectionInfo } from "@api";
import type { ObjectPaneTabContext } from "@api/objectPane";
import type { BiPivotModelInfo } from "../../../_shared/components/types";
import type { ChartDefinition, DesignQueryDataSource } from "../../types";
import { isDesignQueryDataSource } from "../../types";
import { ChartEvents } from "../../lib/chartEvents";
import { chartsBackend } from "../../lib/chartsBackend";
import {
  DESIGN_QUERY_MODEL_NOT_LOADED,
  DESIGN_QUERY_NO_CONNECTION,
  commitDesignQuery,
  type DesignQueryCommitRequest,
} from "../../lib/designQueryCommit";
import type { GaugeIndexPatch } from "../../lib/designQueryWells";
import { ChartFieldsTab } from "./ChartFieldsTab";
import { ChartDesignTab } from "./ChartDesignTab";

/** The build tab id that shows the Design editor (anything else shows the wells). */
const DESIGN_TAB_ID = "design";

export interface ChartDesignQueryBuildProps {
  ctx: ObjectPaneTabContext;
  chartId: string;
  getChart(chartId: string): ChartDefinition | null;
}

type ModelState =
  | { status: "none" }
  | { status: "loading"; connectionId: string }
  | { status: "ready"; connectionId: string; model: BiPivotModelInfo }
  | { status: "failed"; connectionId: string; error: string };

/** Re-render on every chart update (an undo, an Apply, a script's edit). */
function useChartUpdates(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const onUpdated = () => setVersion((v) => v + 1);
    window.addEventListener(ChartEvents.CHART_UPDATED, onUpdated);
    return () => window.removeEventListener(ChartEvents.CHART_UPDATED, onUpdated);
  }, []);
  return version;
}

export function ChartDesignQueryBuild({ ctx, chartId, getChart }: ChartDesignQueryBuildProps): React.ReactElement {
  useChartUpdates();
  const chart = getChart(chartId);
  const source: DesignQueryDataSource | null =
    chart && isDesignQueryDataSource(chart.spec.data) ? chart.spec.data : null;
  const storedDsl = source?.dslText ?? "";
  const connectionId = source?.connectionId ?? "";

  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [modelState, setModelState] = useState<ModelState>({ status: "none" });
  const [draft, setDraft] = useState<{ text: string; base: string }>({ text: storedDsl, base: storedDsl });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The connection list for the select (non-fatal: an empty list still shows
  // the current connection by its id).
  useEffect(() => {
    let cancelled = false;
    chartsBackend
      .invoke<ConnectionInfo[]>("bi_get_connections", {})
      .then((c) => {
        if (!cancelled) setConnections(c ?? []);
      })
      .catch(() => {
        if (!cancelled) setConnections([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The model of the chart's connection (the field list and the wells' compile context).
  useEffect(() => {
    if (!connectionId) {
      setModelState({ status: "none" });
      return;
    }
    let cancelled = false;
    setModelState({ status: "loading", connectionId });
    chartsBackend
      .invoke<BiPivotModelInfo | null>("get_connection_bi_model", { connectionId })
      .then((m) => {
        if (cancelled) return;
        setModelState(
          m ? { status: "ready", connectionId, model: m } : { status: "failed", connectionId, error: DESIGN_QUERY_MODEL_NOT_LOADED },
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setModelState({ status: "failed", connectionId, error: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  // The stored query moved (an Apply landed, an undo, a wells edit): an
  // UNEDITED draft follows it; an edited one is the reader's work and stays.
  useEffect(() => {
    setDraft((d) => (d.text === d.base || d.text === storedDsl ? { text: storedDsl, base: storedDsl } : { ...d, base: storedDsl }));
  }, [storedDsl]);

  const commit = useCallback(
    async (request: DesignQueryCommitRequest): Promise<boolean> => {
      setBusy(true);
      try {
        const result = await commitDesignQuery(chartId, request);
        if (result.status === "refused") {
          setError(result.error);
          return false;
        }
        setError(null);
        return true;
      } finally {
        setBusy(false);
      }
    },
    [chartId],
  );

  const commitWells = useCallback(
    (dslText: string, markOptions: GaugeIndexPatch | null) => {
      void commit({ dslText, connectionId, markOptions });
    },
    [commit, connectionId],
  );

  const applyDraft = useCallback(() => {
    const text = draft.text;
    void commit({ dslText: text, connectionId }).then((ok) => {
      if (ok) setDraft((d) => (d.text === text ? { text, base: text } : d));
    });
  }, [commit, draft.text, connectionId]);

  if (!chart || !source) {
    return (
      <div data-testid="chart-design-query-build" style={{ padding: "8px 12px", fontSize: 12 }}>
        This chart does not run a design query.
      </div>
    );
  }

  const showDesign = ctx.activeTabId === DESIGN_TAB_ID;
  const known = connections.some((c) => c.id === connectionId);

  let body: React.ReactNode;
  if (showDesign) {
    body = (
      <ChartDesignTab
        value={draft.text}
        onChange={(text) => setDraft((d) => ({ ...d, text }))}
        connectionId={connectionId}
        dirty={draft.text !== storedDsl}
        busy={busy}
        readOnly={ctx.readOnly}
        readOnlyReason={ctx.readOnlyReason}
        onApply={applyDraft}
        onRevert={() => {
          setDraft({ text: storedDsl, base: storedDsl });
          setError(null);
        }}
      />
    );
  } else if (!connectionId) {
    body = <div style={{ padding: "0 12px", fontSize: 12 }}>{DESIGN_QUERY_NO_CONNECTION}</div>;
  } else if (modelState.status === "ready" && modelState.connectionId === connectionId) {
    body = (
      <ChartFieldsTab
        biModel={modelState.model}
        dslText={storedDsl}
        mark={chart.spec.mark}
        markOptions={chart.spec.markOptions}
        readOnly={ctx.readOnly}
        readOnlyReason={ctx.readOnlyReason}
        busy={busy}
        onCommit={commitWells}
        onError={setError}
      />
    );
  } else if (modelState.status === "failed") {
    body = (
      <div data-testid="chart-fields-model-error" style={{ padding: "0 12px", fontSize: 12 }}>
        {modelState.error}
      </div>
    );
  } else {
    body = <div style={{ padding: "0 12px", fontSize: 12 }}>Loading the model...</div>;
  }

  return (
    <div
      data-testid="chart-design-query-build"
      data-tab-id={ctx.activeTabId}
      style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 0", fontSize: 12, minHeight: 0 }}
    >
      <label style={{ display: "flex", flexDirection: "column", gap: 2, padding: "0 12px" }}>
        <span style={{ fontWeight: 600 }}>Connection</span>
        <select
          data-testid="chart-pane-connection"
          value={connectionId}
          disabled={ctx.readOnly || busy}
          title={ctx.readOnly ? (ctx.readOnlyReason ?? undefined) : undefined}
          onChange={(e) => {
            const next = e.target.value;
            if (next === connectionId) return;
            void commit({ dslText: storedDsl, connectionId: next });
          }}
        >
          {!connectionId && <option value="">Select a BI connection</option>}
          {connectionId && !known && <option value={connectionId}>{connectionId}</option>}
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {error !== null && (
        <div
          data-testid="chart-pane-error"
          role="alert"
          style={{ margin: "0 12px", whiteSpace: "pre-wrap", color: "var(--text-error, #c42b1c)", fontSize: 11 }}
        >
          {error}
        </div>
      )}
      {body}
    </div>
  );
}

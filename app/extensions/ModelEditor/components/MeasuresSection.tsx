// FILENAME: app/extensions/ModelEditor/components/MeasuresSection.tsx
// PURPOSE: Model Editor panel section (ME-1): pick a BI connection, list its
//          model's measures with lineage, and add/edit/delete them via the
//          Monaco editor dialog.

import React, { useCallback, useEffect, useState } from "react";
import type { PanelSectionProps } from "@api/uiTypes";
import {
  biGetConnections,
  biModelGetMeasures,
  biModelDeleteMeasure,
  biModelMeasureLineage,
  emitAppEvent,
  onAppEvent,
  recalcWithCube,
  showDialog,
} from "@api";
import type { ConnectionInfo, MeasureLineage, ModelMeasureInfo } from "@api";
import { MEASURE_EDITOR_DIALOG_ID } from "../manifest";

const sectionStyle: React.CSSProperties = {
  padding: "8px",
  fontSize: "12px",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};
const selectStyle: React.CSSProperties = {
  padding: "4px 6px", border: "1px solid #ccc", borderRadius: "3px", fontSize: "12px",
};
const rowStyle: React.CSSProperties = {
  padding: "4px 6px",
  borderRadius: "3px",
  cursor: "pointer",
};
const mutedStyle: React.CSSProperties = { opacity: 0.65 };

export function MeasuresSection(_props: PanelSectionProps): React.ReactElement {
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [measures, setMeasures] = useState<ModelMeasureInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [lineage, setLineage] = useState<MeasureLineage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadConnections = useCallback(async () => {
    try {
      const conns = await biGetConnections();
      setConnections(conns);
      setConnectionId((prev) =>
        prev && conns.some((c) => c.id === prev) ? prev : (conns[0]?.id ?? ""),
      );
    } catch (err: unknown) {
      setError(String(err));
    }
  }, []);

  const loadMeasures = useCallback(async (connId: string) => {
    if (!connId) {
      setMeasures([]);
      return;
    }
    try {
      setMeasures(await biModelGetMeasures(connId));
      setError(null);
    } catch (err: unknown) {
      setMeasures([]);
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  useEffect(() => {
    setSelected(null);
    setLineage(null);
    void loadMeasures(connectionId);
  }, [connectionId, loadMeasures]);

  useEffect(() => {
    const off = onAppEvent("bi:model-changed", () => {
      void loadMeasures(connectionId);
      void loadConnections();
    });
    return off;
  }, [connectionId, loadMeasures, loadConnections]);

  useEffect(() => {
    if (!selected || !connectionId) {
      setLineage(null);
      return;
    }
    let cancelled = false;
    void biModelMeasureLineage(connectionId, selected)
      .then((l) => {
        if (!cancelled) setLineage(l);
      })
      .catch(() => {
        if (!cancelled) setLineage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, connectionId, measures]);

  const handleDelete = useCallback(async () => {
    if (!selected || !connectionId) return;
    if (!window.confirm(`Delete measure '${selected}' from the model?`)) return;
    try {
      setMeasures(await biModelDeleteMeasure(connectionId, selected));
      setSelected(null);
      setError(null);
      emitAppEvent("bi:model-changed", { connectionId });
      void recalcWithCube();
    } catch (err: unknown) {
      setError(String(err));
    }
  }, [selected, connectionId]);

  const selectedMeasure = measures.find((m) => m.name === selected);

  return (
    <div style={sectionStyle}>
      <div>
        <div style={{ fontWeight: 600, marginBottom: "4px" }}>Model (connection)</div>
        <select
          style={{ ...selectStyle, width: "100%" }}
          value={connectionId}
          onChange={(e) => setConnectionId(e.target.value)}
        >
          {connections.length === 0 && <option value="">No BI connections</option>}
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.tableCount} tables)
            </option>
          ))}
        </select>
      </div>

      {error && <div style={{ color: "#c0392b" }}>{error}</div>}

      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
          <span style={{ fontWeight: 600, flex: 1 }}>Measures ({measures.length})</span>
          <button
            disabled={!connectionId}
            onClick={() => showDialog(MEASURE_EDITOR_DIALOG_ID, { connectionId })}
          >
            New
          </button>
          <button
            disabled={!selectedMeasure}
            onClick={() =>
              selectedMeasure &&
              showDialog(MEASURE_EDITOR_DIALOG_ID, { connectionId, measure: selectedMeasure })
            }
          >
            Edit
          </button>
          <button disabled={!selectedMeasure} onClick={() => void handleDelete()}>
            Delete
          </button>
        </div>
        {measures.length === 0 && (
          <div style={mutedStyle}>
            {connectionId
              ? "This model has no measures yet — create one with New."
              : "Load a model via External Data > Get Data first."}
          </div>
        )}
        {measures.map((m) => (
          <div
            key={m.name}
            style={{
              ...rowStyle,
              background: m.name === selected ? "rgba(100, 148, 237, 0.18)" : undefined,
            }}
            onClick={() => setSelected(m.name)}
            onDoubleClick={() => showDialog(MEASURE_EDITOR_DIALOG_ID, { connectionId, measure: m })}
            title={m.formula}
          >
            <div>
              <strong>{m.name}</strong>
              <span style={mutedStyle}> — {m.table}</span>
              {m.isHidden && <span style={mutedStyle}> (hidden)</span>}
            </div>
            <div style={{ ...mutedStyle, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {m.formula}
            </div>
          </div>
        ))}
      </div>

      {selectedMeasure && lineage && (
        <div>
          <div style={{ fontWeight: 600, marginBottom: "4px" }}>Lineage: {selectedMeasure.name}</div>
          {lineage.columns.length > 0 && (
            <div>
              <span style={mutedStyle}>Columns: </span>
              {lineage.columns.map((c) => `${c.table}[${c.column}]`).join(", ")}
            </div>
          )}
          {lineage.measures.length > 0 && (
            <div>
              <span style={mutedStyle}>Uses measures: </span>
              {lineage.measures.join(", ")}
            </div>
          )}
          {lineage.referencedBy.length > 0 && (
            <div>
              <span style={mutedStyle}>Referenced by: </span>
              {lineage.referencedBy.join(", ")}
            </div>
          )}
          {lineage.columns.length === 0 &&
            lineage.measures.length === 0 &&
            lineage.referencedBy.length === 0 && (
              <div style={mutedStyle}>No dependencies.</div>
            )}
        </div>
      )}
    </div>
  );
}

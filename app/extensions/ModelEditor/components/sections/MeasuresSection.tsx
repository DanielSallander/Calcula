// FILENAME: app/extensions/ModelEditor/components/sections/MeasuresSection.tsx
// PURPOSE: Measures section of the Model Editor window: list the model's
//          measures with lineage for the selection, and add/edit/delete them
//          through the Monaco measure modal. Ported from the old panel section.

import React, { useEffect, useState } from "react";
import { biModelDeleteMeasure, biModelMeasureLineage } from "@api";
import type { MeasureLineage, ModelMeasureInfo } from "@api";
import { SELECTION_BG, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";
import { MeasureEditorModal } from "./MeasureEditorModal";

export function MeasuresSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyMeasures, reportError } = ctx;
  const measures = overview.measures;

  const [selected, setSelected] = useState<string | null>(null);
  const [lineage, setLineage] = useState<MeasureLineage | null>(null);
  const [editing, setEditing] = useState<{ measure: ModelMeasureInfo | null } | null>(null);

  useEffect(() => {
    setSelected(null);
    setEditing(null);
  }, [connectionId]);

  const selectedMeasure = measures.find((m) => m.name === selected);

  useEffect(() => {
    if (!selected || !connectionId || !measures.some((m) => m.name === selected)) {
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

  const handleDelete = async () => {
    if (!selectedMeasure) return;
    if (!window.confirm(`Delete measure '${selectedMeasure.name}' from the model?`)) return;
    try {
      applyMeasures(await biModelDeleteMeasure(connectionId, selectedMeasure.name));
      setSelected(null);
    } catch (err: unknown) {
      reportError(err);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>Measures ({measures.length})</span>
        <button
          style={styles.btn}
          disabled={readOnly}
          onClick={() => setEditing({ measure: null })}
        >
          New
        </button>
        <button
          style={styles.btn}
          disabled={readOnly || !selectedMeasure}
          onClick={() => selectedMeasure && setEditing({ measure: selectedMeasure })}
        >
          Edit
        </button>
        <button
          style={styles.btn}
          disabled={readOnly || !selectedMeasure}
          onClick={() => void handleDelete()}
        >
          Delete
        </button>
      </div>

      <div style={{ ...styles.card, flex: 1, overflowY: "auto", padding: 4 }}>
        {measures.length === 0 && (
          <div style={{ ...styles.muted, padding: 8 }}>
            This model has no measures yet — create one with New.
          </div>
        )}
        {measures.map((m) => (
          <div
            key={m.name}
            style={{
              ...styles.listRow,
              background: m.name === selected ? SELECTION_BG : undefined,
            }}
            onClick={() => setSelected(m.name)}
            onDoubleClick={() => {
              if (!readOnly) setEditing({ measure: m });
            }}
            title={m.formula}
          >
            <div>
              <strong>{m.name}</strong>
              <span style={styles.muted}> — {m.table}</span>
              {m.isHidden && <span style={styles.muted}> (hidden)</span>}
            </div>
            <div
              style={{
                ...styles.muted,
                fontSize: 12,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {m.formula}
            </div>
          </div>
        ))}
      </div>

      {selectedMeasure && lineage && (
        <div style={{ ...styles.card, fontSize: 12, flexShrink: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Lineage: {selectedMeasure.name}
          </div>
          {lineage.columns.length > 0 && (
            <div>
              <span style={styles.muted}>Columns: </span>
              {lineage.columns.map((c) => `${c.table}[${c.column}]`).join(", ")}
            </div>
          )}
          {lineage.measures.length > 0 && (
            <div>
              <span style={styles.muted}>Uses measures: </span>
              {lineage.measures.join(", ")}
            </div>
          )}
          {lineage.referencedBy.length > 0 && (
            <div>
              <span style={styles.muted}>Referenced by: </span>
              {lineage.referencedBy.join(", ")}
            </div>
          )}
          {lineage.columns.length === 0 &&
            lineage.measures.length === 0 &&
            lineage.referencedBy.length === 0 && (
              <div style={styles.muted}>No dependencies.</div>
            )}
        </div>
      )}

      {editing && (
        <MeasureEditorModal
          connectionId={connectionId}
          existing={editing.measure}
          onClose={() => setEditing(null)}
          onSaved={(list) => {
            applyMeasures(list);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

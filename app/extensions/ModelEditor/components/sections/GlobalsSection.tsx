// FILENAME: app/extensions/ModelEditor/components/sections/GlobalsSection.tsx
// PURPOSE: Global Variables section of the Model Editor window: list model
//          global variables (reusable named scalar/QUERY expressions bound to a
//          table) and add/edit/delete them (name, host table, expression).

import React, { useState } from "react";
import { biModelDeleteGlobalVariable, biModelUpsertGlobalVariable } from "@api";
import type { ModelGlobalVariableInfo, ModelOverview } from "@api";
import { Badge, Field, Modal, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";

export function GlobalsSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const [editing, setEditing] = useState<{ original: ModelGlobalVariableInfo | null } | null>(
    null,
  );

  const handleDelete = async (g: ModelGlobalVariableInfo) => {
    if (!window.confirm(`Delete global variable '${g.name}'?`)) return;
    try {
      applyOverview(await biModelDeleteGlobalVariable(connectionId, g.name));
    } catch (err: unknown) {
      reportError(err);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>
          Global Variables ({overview.globalVariables.length})
        </span>
        <button style={styles.btn} disabled={readOnly} onClick={() => setEditing({ original: null })}>
          New
        </button>
      </div>
      <div style={{ ...styles.card, flex: 1, overflowY: "auto", padding: 4 }}>
        {overview.globalVariables.length === 0 && (
          <div style={{ ...styles.muted, padding: 8 }}>
            No global variables defined — create one with New.
          </div>
        )}
        {overview.globalVariables.map((g) => (
          <div
            key={g.name}
            style={{ ...styles.listRow, cursor: "default", display: "flex", alignItems: "center", gap: 8 }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <strong>{g.name}</strong>
                <Badge tone="neutral">{g.isQuery ? "QUERY" : "scalar"}</Badge>
                <span style={styles.muted}>{" "}— {g.table}</span>
              </div>
              <div
                style={{
                  ...styles.muted,
                  fontFamily: "Consolas, 'Cascadia Code', monospace",
                  fontSize: 12,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {g.expression}
              </div>
            </div>
            <button style={styles.smallBtn} disabled={readOnly} onClick={() => setEditing({ original: g })}>
              Edit
            </button>
            <button style={styles.smallBtn} disabled={readOnly} onClick={() => void handleDelete(g)}>
              Delete
            </button>
          </div>
        ))}
      </div>

      {editing && (
        <GlobalVariableModal
          connectionId={connectionId}
          overview={overview}
          original={editing.original}
          onClose={() => setEditing(null)}
          onSaved={(o) => {
            applyOverview(o);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Add/edit modal
// ============================================================================

function GlobalVariableModal({
  connectionId,
  overview,
  original,
  onClose,
  onSaved,
}: {
  connectionId: string;
  overview: ModelOverview;
  original: ModelGlobalVariableInfo | null;
  onClose: () => void;
  onSaved: (overview: ModelOverview) => void;
}): React.ReactElement {
  const [name, setName] = useState(original?.name ?? "");
  const [table, setTable] = useState(original?.table ?? "");
  const [expression, setExpression] = useState(original?.expression ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim() !== "" && table !== "" && expression.trim() !== "";

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await biModelUpsertGlobalVariable({
          connectionId,
          originalName: original?.name ?? null,
          name: name.trim(),
          table,
          expression: expression.trim(),
        }),
      );
    } catch (err: unknown) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={original ? `Edit Global Variable: ${original.name}` : "New Global Variable"}
      width={560}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.primaryBtn} disabled={busy || !canSave} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <Field label="Name">
        <input
          style={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="total_revenue"
        />
      </Field>

      <Field label="Table">
        <select style={styles.input} value={table} onChange={(e) => setTable(e.target.value)}>
          <option value="">(select table)</option>
          {overview.tables.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Expression"
        hint="DAX-like scalar, e.g. SUM(fact[amount]); or a table global QUERY(SUM(fact[amount]) AS Amt BY dim[city])"
      >
        <textarea
          style={styles.textarea}
          rows={4}
          value={expression}
          onChange={(e) => setExpression(e.target.value)}
        />
      </Field>
      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}

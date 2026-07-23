// FILENAME: app/extensions/ModelEditor/components/sections/ContextsSection.tsx
// PURPOSE: Contexts section of the Model Editor window. A context is a named,
//          composable filter transformation referenced by measures via
//          using(expr, context). Contexts are AUTHORED AS EXPRESSIONS in the
//          engine's CONTEXT syntax — e.g.
//            KEEP(dim_date, dim_date[year] = 2024), CLEAR(Sales[region])
//          — edited in the shared ExpressionWorkspace, validated through the
//          engine parser (positioned markers), and installed via
//          bi_model_upsert_context. The structured operations still arrive in
//          the overview DTO and drive the list's summary badges. (Context
//          COLUMNS are edited as dynamic calculated columns under the Tables
//          tab — the backend routes a column by whether its formula references
//          a measure.)

import React, { useCallback, useRef, useState } from "react";
import {
  biModelDeleteContext,
  biModelUpsertContext,
  biModelValidateContext,
} from "@api";
import type { ModelContextInfo, ModelOverview } from "@api";
import { Badge, Field, Modal, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";
import {
  ExpressionWorkspace,
  type ExpressionWorkspaceHandle,
} from "./ExpressionWorkspace";

// ============================================================================
// Section
// ============================================================================

export function ContextsSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const [editingCtx, setEditingCtx] = useState<{ original: ModelContextInfo | null } | null>(null);

  const deleteContext = async (c: ModelContextInfo) => {
    if (!window.confirm(`Delete context '${c.name}'?`)) return;
    try {
      applyOverview(await biModelDeleteContext(connectionId, c.name));
    } catch (err: unknown) {
      reportError(err);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, flex: 1, minHeight: 0, overflowY: "auto" }}>
      {/* Contexts */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={styles.sectionHeader}>
          <span style={styles.sectionTitle}>Contexts ({overview.contexts.length})</span>
          <button style={styles.btn} disabled={readOnly} onClick={() => setEditingCtx({ original: null })}>
            New
          </button>
        </div>
        <div style={{ ...styles.card, padding: 4 }}>
          {overview.contexts.length === 0 && (
            <div style={{ ...styles.muted, padding: 8 }}>
              No contexts defined — a context is a reusable filter expression applied via
              using(expr, context), e.g. KEEP(dim_date, dim_date[year] = 2024).
            </div>
          )}
          {overview.contexts.map((c) => (
            <div
              key={c.name}
              style={{ ...styles.listRow, cursor: "default", display: "flex", alignItems: "center", gap: 8 }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{c.name}</strong>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 3, alignItems: "center" }}>
                  {c.operations.map((op, i) => (
                    <Badge key={i}>{op.type}</Badge>
                  ))}
                </div>
                <div
                  style={{
                    ...styles.muted,
                    fontFamily: "monospace",
                    fontSize: 11,
                    marginTop: 3,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  title={c.expression}
                >
                  {c.expression}
                </div>
              </div>
              <button style={styles.smallBtn} disabled={readOnly} onClick={() => setEditingCtx({ original: c })}>
                Edit
              </button>
              <button style={styles.smallBtn} disabled={readOnly} onClick={() => void deleteContext(c)}>
                Delete
              </button>
            </div>
          ))}
        </div>
      </div>

      {editingCtx && (
        <ContextEditorModal
          connectionId={connectionId}
          overview={overview}
          original={editingCtx.original}
          onClose={() => setEditingCtx(null)}
          onSaved={(o) => {
            applyOverview(o);
            setEditingCtx(null);
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Context add/edit modal — name + the shared expression workspace.
// ============================================================================

function ContextEditorModal({
  connectionId,
  overview,
  original,
  onClose,
  onSaved,
}: {
  connectionId: string;
  overview: ModelOverview;
  original: ModelContextInfo | null;
  onClose: () => void;
  onSaved: (overview: ModelOverview) => void;
}): React.ReactElement {
  const [name, setName] = useState(original?.name ?? "");
  const [expression, setExpression] = useState(original?.expression ?? "");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const workspaceRef = useRef<ExpressionWorkspaceHandle>(null);

  const handleValidate = useCallback(async () => {
    setError(null);
    setStatus(null);
    try {
      const result = await biModelValidateContext(
        connectionId,
        name,
        expression,
        original?.name ?? null,
      );
      if (result.ok) {
        workspaceRef.current?.setMarker(null, null);
        setStatus("Context definition is valid.");
      } else {
        workspaceRef.current?.setMarker(result.position, result.message);
        setError(result.message ?? "Invalid context definition");
      }
    } catch (err: unknown) {
      setError(String(err));
    }
  }, [connectionId, name, expression, original]);

  const handleSave = useCallback(async () => {
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      onSaved(
        await biModelUpsertContext({
          connectionId,
          originalName: original?.name ?? null,
          name: name.trim(),
          expression,
        }),
      );
    } catch (err: unknown) {
      setError(String(err));
      setBusy(false);
    }
  }, [connectionId, original, name, expression, onSaved]);

  return (
    <Modal
      title={original ? `Edit Context: ${original.name}` : "New Context"}
      width={1280}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.btn} onClick={() => void handleValidate()}>
            Validate
          </button>
          <button
            style={styles.primaryBtn}
            onClick={() => void handleSave()}
            disabled={busy || !name.trim() || !expression.trim() || !connectionId}
          >
            {busy ? "Saving…" : "Save Context"}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 10 }}>
        A context is a reusable filter transformation. Measures apply it by name —
        SUM(Sales[amount], {name.trim() || "ctx_name"}) — or via USING(). Compose contexts by
        naming another context as an operation.
      </div>

      <Field label="Name">
        <input
          style={{ ...styles.input, maxWidth: 340 }}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="bikes_2024"
        />
      </Field>

      <ExpressionWorkspace
        ref={workspaceRef}
        overview={overview}
        value={expression}
        onChange={setExpression}
        label="Definition"
        hint="Comma-separated operations: KEEP, CLEAR, CLEAR_INNER/OUTER, RESET(_INNER/_OUTER), USERELATIONSHIP, or a context name to inherit."
        hintTitle={
          'Examples:\n' +
          'KEEP(dim_date, dim_date[year] = 2024) — add filters (values may be USERNAME() / CUSTOMDATA())\n' +
          'KEEP(fact, fact[productid] IN premium[id]) — membership in a table variable (also NOT IN)\n' +
          'CLEAR(Sales[region]), CLEAR(dim_date) — remove filters on a column / table\n' +
          'CLEAR_INNER(...) / CLEAR_OUTER(...) — clear only group-by / only query-level filters\n' +
          'RESET(), RESET_INNER(), RESET_OUTER() — remove all filters for the scope\n' +
          'USERELATIONSHIP("ShipDate") — activate an inactive relationship\n' +
          'other_context — inherit all of another context’s operations'
        }
      />

      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
      {status && <div style={{ color: "green", marginBottom: 8, fontSize: 12 }}>{status}</div>}
    </Modal>
  );
}

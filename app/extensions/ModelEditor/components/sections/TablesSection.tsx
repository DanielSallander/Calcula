// FILENAME: app/extensions/ModelEditor/components/sections/TablesSection.tsx
// PURPOSE: Tables section of the Model Editor window: master list of model
//          tables, per-table metadata form, and the columns grid with
//          physical-column editing plus calculated-column add/edit/delete.

import React, { useEffect, useState } from "react";
import { biModelDeleteCalcColumn, biModelUpdateTable } from "@api";
import type { ModelColumnInfo, ModelOverview, ModelTableInfo } from "@api";
import { Badge, Field, SELECTION_BG, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";
import { CalcColumnModal, PhysicalColumnModal } from "./TableColumnModals";

export function TablesSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const tables = overview.tables;

  const [selectedName, setSelectedName] = useState<string | null>(tables[0]?.name ?? null);
  const [physicalEdit, setPhysicalEdit] = useState<ModelColumnInfo | null>(null);
  const [calcEdit, setCalcEdit] = useState<{ existing: ModelColumnInfo | null } | null>(null);

  useEffect(() => {
    setSelectedName((prev) =>
      prev && tables.some((t) => t.name === prev) ? prev : (tables[0]?.name ?? null),
    );
  }, [tables]);

  const table = tables.find((t) => t.name === selectedName) ?? null;

  const deleteCalcColumn = async (col: ModelColumnInfo) => {
    if (!window.confirm(`Delete calculated column '${col.name}'?`)) return;
    try {
      applyOverview(await biModelDeleteCalcColumn(connectionId, col.name));
    } catch (err: unknown) {
      reportError(err);
    }
  };

  return (
    <div style={{ display: "flex", gap: 12, flex: 1, minHeight: 0 }}>
      {/* Master: table list */}
      <div style={{ ...styles.card, width: 260, flexShrink: 0, overflowY: "auto", padding: 4 }}>
        {tables.length === 0 && (
          <div style={{ ...styles.muted, padding: 8 }}>
            No tables in this model — import some under Import.
          </div>
        )}
        {tables.map((t) => (
          <div
            key={t.name}
            style={{
              ...styles.listRow,
              background: t.name === selectedName ? SELECTION_BG : undefined,
            }}
            onClick={() => setSelectedName(t.name)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <strong>{t.name}</strong>
              {t.isHidden && <Badge tone="warn">hidden</Badge>}
              <Badge tone={t.bound ? "ok" : "neutral"}>{t.bound ? "bound" : "unbound"}</Badge>
            </div>
            <div style={{ ...styles.muted, fontSize: 11 }}>
              {t.displayName ? `${t.displayName} · ` : ""}
              {t.storageMode} · {t.columns.length} columns
            </div>
          </div>
        ))}
      </div>

      {/* Detail */}
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
        {!table && <div style={styles.muted}>Select a table.</div>}
        {table && (
          <>
            <TableMetaForm
              connectionId={connectionId}
              table={table}
              readOnly={readOnly}
              applyOverview={applyOverview}
              reportError={reportError}
            />

            <div style={{ ...styles.sectionHeader, marginTop: 12, marginBottom: 8 }}>
              <span style={styles.sectionTitle}>Columns ({table.columns.length})</span>
              <button
                style={styles.btn}
                disabled={readOnly}
                onClick={() => setCalcEdit({ existing: null })}
              >
                Add calculated column
              </button>
            </div>
            <div style={{ ...styles.card, padding: 0, overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    <th style={styles.th}>Name</th>
                    <th style={styles.th}>Type</th>
                    <th style={styles.th}>Display name</th>
                    <th style={styles.th}>Description</th>
                    <th style={styles.th}>Hidden</th>
                    <th style={styles.th}>Formula</th>
                    <th style={styles.th}></th>
                  </tr>
                </thead>
                <tbody>
                  {table.columns.map((c) => (
                    <tr key={c.name}>
                      <td style={styles.td}>
                        <strong>{c.name}</strong>{" "}
                        {c.isCalculated && <Badge tone="ok">calc</Badge>}
                      </td>
                      <td style={styles.td}>{c.dataType}</td>
                      <td style={styles.td}>{c.displayName ?? ""}</td>
                      <td style={styles.td}>{c.description ?? ""}</td>
                      <td style={styles.td}>{c.isHidden ? "Yes" : ""}</td>
                      <td
                        style={{
                          ...styles.td,
                          fontFamily: "Consolas, 'Cascadia Code', monospace",
                          maxWidth: 240,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={c.formula ?? undefined}
                      >
                        {c.formula ?? ""}
                      </td>
                      <td style={{ ...styles.td, whiteSpace: "nowrap", textAlign: "right" }}>
                        {c.isCalculated ? (
                          <>
                            <button
                              style={styles.smallBtn}
                              disabled={readOnly}
                              onClick={() => setCalcEdit({ existing: c })}
                            >
                              Edit
                            </button>{" "}
                            <button
                              style={styles.smallBtn}
                              disabled={readOnly}
                              onClick={() => void deleteCalcColumn(c)}
                            >
                              Delete
                            </button>
                          </>
                        ) : (
                          <button
                            style={styles.smallBtn}
                            disabled={readOnly}
                            onClick={() => setPhysicalEdit(c)}
                          >
                            Edit
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {table && physicalEdit && (
        <PhysicalColumnModal
          connectionId={connectionId}
          table={table.name}
          column={physicalEdit}
          onClose={() => setPhysicalEdit(null)}
          onSaved={(o) => {
            applyOverview(o);
            setPhysicalEdit(null);
          }}
        />
      )}
      {table && calcEdit && (
        <CalcColumnModal
          connectionId={connectionId}
          table={table.name}
          existing={calcEdit.existing}
          onClose={() => setCalcEdit(null)}
          onSaved={(o) => {
            applyOverview(o);
            setCalcEdit(null);
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Table metadata form (displayName / description / isHidden)
// ============================================================================

function TableMetaForm({
  connectionId,
  table,
  readOnly,
  applyOverview,
  reportError,
}: {
  connectionId: string;
  table: ModelTableInfo;
  readOnly: boolean;
  applyOverview: (overview: ModelOverview) => void;
  reportError: (err: unknown) => void;
}): React.ReactElement {
  const [displayName, setDisplayName] = useState(table.displayName ?? "");
  const [description, setDescription] = useState(table.description ?? "");
  const [isHidden, setIsHidden] = useState(table.isHidden);
  const [busy, setBusy] = useState(false);

  // Reseed the form when the selection (or a saved overview) changes.
  useEffect(() => {
    setDisplayName(table.displayName ?? "");
    setDescription(table.description ?? "");
    setIsHidden(table.isHidden);
  }, [table]);

  const save = async () => {
    setBusy(true);
    try {
      applyOverview(
        await biModelUpdateTable({
          connectionId,
          table: table.name,
          displayName: displayName.trim() || null,
          description: description.trim() || null,
          isHidden,
        }),
      );
    } catch (err: unknown) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.card}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>
        {table.name} <Badge>{table.storageMode}</Badge>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Field label="Display name" flex={1}>
          <input
            style={styles.input}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={table.name}
          />
        </Field>
        <Field label="Description" flex={2}>
          <input
            style={styles.input}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={isHidden}
            onChange={(e) => setIsHidden(e.target.checked)}
          />
          Hidden
        </label>
        <div style={{ flex: 1 }} />
        <button
          style={styles.primaryBtn}
          disabled={readOnly || busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save table"}
        </button>
      </div>
    </div>
  );
}

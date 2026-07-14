// FILENAME: app/extensions/ModelEditor/components/sections/ImportSection.tsx
// PURPOSE: Import section of the Model Editor window: import table schemas
//          from the connection's source database, or create a new blank model
//          (embedded, path-less connection).

import React, { useEffect, useState } from "react";
import {
  biImportWritebackTables,
  biListWritebackTables,
  biModelImportSqlSource,
  biModelImportTables,
  biModelListSourceTables,
  biRefreshWritebackData,
} from "@api";
import type { ConnectionInfo, ModelOverview, SourceTableInfo, WritebackTableInfo } from "@api";
import { styles } from "../editorShared";
import { NewModelDialog } from "../NewModelDialog";
import { SqlEditorModal } from "../SqlEditorModal";

/** First non-empty line of a query, truncated for an inline preview. */
function firstLine(sql: string): string {
  const line = sql.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 58)}…` : line;
}

export function ImportSection({
  connectionId,
  readOnly,
  applyOverview,
  reportError,
  onModelCreated,
}: {
  connectionId: string;
  readOnly: boolean;
  applyOverview: (overview: ModelOverview) => void;
  reportError: (err: unknown) => void;
  onModelCreated: (connection: ConnectionInfo) => void;
}): React.ReactElement {
  // ── Import tables ─────────────────────────────────────────────────────────
  const [source, setSource] = useState<SourceTableInfo[] | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [listing, setListing] = useState(false);
  const [importing, setImporting] = useState(false);

  // ── SQL query source ──────────────────────────────────────────────────────
  const [sqlName, setSqlName] = useState("");
  const [sqlText, setSqlText] = useState("");
  const [sqlImporting, setSqlImporting] = useState(false);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [showSqlEditor, setShowSqlEditor] = useState(false);

  // ── Writeback datasets ────────────────────────────────────────────────────
  const [writeback, setWriteback] = useState<WritebackTableInfo[]>([]);
  const [wbChecked, setWbChecked] = useState<Set<string>>(new Set());
  const [wbImporting, setWbImporting] = useState(false);
  const [wbRefreshing, setWbRefreshing] = useState(false);
  const [wbError, setWbError] = useState<string | null>(null);

  // ── New model dialog ──────────────────────────────────────────────────────
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    setSource(null);
    setSourceError(null);
    setChecked(new Set());
    setSqlName("");
    setSqlText("");
    setSqlError(null);
    setShowSqlEditor(false);
    setWbChecked(new Set());
    setWbError(null);
  }, [connectionId]);

  // Writeback datasets are local registry reads (no database connection), so
  // list them automatically; an empty list hides the card entirely.
  useEffect(() => {
    let cancelled = false;
    biListWritebackTables(connectionId || undefined)
      .then((list) => {
        if (!cancelled) setWriteback(list);
      })
      .catch(() => {
        if (!cancelled) setWriteback([]);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  const keyOf = (t: { schema: string; name: string }): string => `${t.schema}.${t.name}`;

  const listTables = async () => {
    setListing(true);
    setSourceError(null);
    try {
      setSource(await biModelListSourceTables(connectionId));
    } catch (err: unknown) {
      setSource(null);
      setSourceError(String(err));
    } finally {
      setListing(false);
    }
  };

  const importChecked = async () => {
    const tables = (source ?? [])
      .filter((t) => !t.imported && checked.has(keyOf(t)))
      .map((t) => ({ schema: t.schema, name: t.name }));
    if (tables.length === 0) return;
    setImporting(true);
    try {
      applyOverview(await biModelImportTables(connectionId, tables));
      // Mark the imported tables locally instead of re-hitting the database.
      setSource(
        (prev) => prev?.map((t) => (checked.has(keyOf(t)) ? { ...t, imported: true } : t)) ?? null,
      );
      setChecked(new Set());
    } catch (err: unknown) {
      reportError(err);
    } finally {
      setImporting(false);
    }
  };

  const importSqlSource = async () => {
    if (!sqlName.trim() || !sqlText.trim()) return;
    setSqlImporting(true);
    setSqlError(null);
    try {
      applyOverview(await biModelImportSqlSource(connectionId, sqlName.trim(), sqlText));
      setSqlName("");
      setSqlText("");
    } catch (err: unknown) {
      setSqlError(String(err));
    } finally {
      setSqlImporting(false);
    }
  };

  const reloadWriteback = async () => {
    try {
      setWriteback(await biListWritebackTables(connectionId || undefined));
    } catch {
      setWriteback([]);
    }
  };

  const importWriteback = async () => {
    const ids = writeback
      .filter((w) => !w.alreadyImported && wbChecked.has(w.regionId))
      .map((w) => w.regionId);
    if (ids.length === 0) return;
    setWbImporting(true);
    setWbError(null);
    try {
      applyOverview(await biImportWritebackTables(connectionId, ids));
      setWbChecked(new Set());
      await reloadWriteback();
    } catch (err: unknown) {
      setWbError(String(err));
    } finally {
      setWbImporting(false);
    }
  };

  const refreshWriteback = async () => {
    setWbRefreshing(true);
    setWbError(null);
    try {
      await biRefreshWritebackData();
      await reloadWriteback();
    } catch (err: unknown) {
      setWbError(String(err));
    } finally {
      setWbRefreshing(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
      }}
    >
      {/* ── Card 1: Import tables ─────────────────────────────────────────── */}
      <div style={{ ...styles.card, maxWidth: 560 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Import tables</div>
        <div style={{ ...styles.hint, marginBottom: 8 }}>
          Pull table schemas from the current connection&apos;s source database into the model
          (introspect, append and bind).
        </div>
        <button
          style={styles.btn}
          disabled={!connectionId || listing}
          onClick={() => void listTables()}
        >
          {listing ? "Listing…" : "List source tables"}
        </button>
        {!connectionId && (
          <div style={{ ...styles.hint, marginTop: 6 }}>
            Select a connection first (or create a blank model below).
          </div>
        )}
        {sourceError && (
          <div style={{ marginTop: 8, fontSize: 12, color: "#a4262c" }}>
            <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{sourceError}</div>
            <div style={{ ...styles.hint, marginTop: 4 }}>
              Listing source tables requires a live database connection. Connect this connection via
              Data &gt; Connections in the main window, then try again.
            </div>
          </div>
        )}
        {source && (
          <div style={{ marginTop: 10 }}>
            {source.length === 0 && (
              <div style={styles.muted}>The source database exposes no tables.</div>
            )}
            {source.length > 0 && (
              <div
                style={{
                  maxHeight: 260,
                  overflowY: "auto",
                  border: "1px solid #eee",
                  borderRadius: 3,
                }}
              >
                {source.map((t) => {
                  const key = keyOf(t);
                  return (
                    <label
                      key={key}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "3px 8px",
                        fontSize: 12,
                        opacity: t.imported ? 0.55 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        disabled={t.imported}
                        checked={t.imported || checked.has(key)}
                        onChange={(e) => {
                          setChecked((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(key);
                            else next.delete(key);
                            return next;
                          });
                        }}
                      />
                      {key}
                      {t.imported && <span style={styles.hint}>(already imported)</span>}
                    </label>
                  );
                })}
              </div>
            )}
            {source.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <button
                  style={styles.primaryBtn}
                  disabled={readOnly || importing || checked.size === 0}
                  onClick={() => void importChecked()}
                >
                  {importing
                    ? "Importing…"
                    : checked.size > 0
                      ? `Import ${checked.size} table${checked.size === 1 ? "" : "s"}`
                      : "Import"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Card: Writeback data (only when the workbook can see any) ─────── */}
      {writeback.length > 0 && (
        <div style={{ ...styles.card, maxWidth: 560 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Writeback data</div>
          <div style={{ ...styles.hint, marginBottom: 8 }}>
            Collected writeback submissions as model tables (one row per submission) — query them,
            pivot them, build relationships to them. Publishers see every submission with review
            state; subscribers see their governed view. Data refreshes automatically after
            submit/approve/pull.
          </div>
          <div
            style={{
              maxHeight: 220,
              overflowY: "auto",
              border: "1px solid #eee",
              borderRadius: 3,
            }}
          >
            {writeback.map((w) => (
              <label
                key={w.regionId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "3px 8px",
                  fontSize: 12,
                  opacity: w.alreadyImported ? 0.55 : 1,
                }}
              >
                <input
                  type="checkbox"
                  disabled={w.alreadyImported}
                  checked={w.alreadyImported || wbChecked.has(w.regionId)}
                  onChange={(e) => {
                    setWbChecked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(w.regionId);
                      else next.delete(w.regionId);
                      return next;
                    });
                  }}
                />
                <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {w.displayName}
                </span>
                <span
                  title={
                    w.audience === "publisher"
                      ? "You hold this package's publisher key — all submissions, all states, review fields."
                      : "Your governed view — the same visibility/approval rules as GATHER."
                  }
                  style={{
                    fontSize: 10,
                    padding: "1px 6px",
                    borderRadius: 8,
                    background: w.audience === "publisher" ? "#e8f0fe" : "#f0f0f0",
                    color: w.audience === "publisher" ? "#1a5dab" : "#555",
                    whiteSpace: "nowrap",
                  }}
                >
                  {w.audience === "publisher" ? "Publisher — all submissions" : "My governed view"}
                </span>
                <span style={{ ...styles.muted, fontSize: 11, whiteSpace: "nowrap" }}>
                  {w.rowCount} row{w.rowCount === 1 ? "" : "s"}
                </span>
                {w.alreadyImported && <span style={styles.hint}>(imported)</span>}
              </label>
            ))}
          </div>
          {wbError && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#a4262c", whiteSpace: "pre-wrap" }}>
              {wbError}
            </div>
          )}
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button
              style={styles.primaryBtn}
              disabled={readOnly || !connectionId || wbImporting || wbChecked.size === 0}
              onClick={() => void importWriteback()}
            >
              {wbImporting
                ? "Importing…"
                : wbChecked.size > 0
                  ? `Import ${wbChecked.size} dataset${wbChecked.size === 1 ? "" : "s"}`
                  : "Import"}
            </button>
            <button
              style={styles.btn}
              disabled={wbRefreshing}
              onClick={() => void refreshWriteback()}
            >
              {wbRefreshing ? "Refreshing…" : "Refresh data"}
            </button>
          </div>
          {!connectionId && (
            <div style={{ ...styles.hint, marginTop: 6 }}>
              Select a connection to import into (or create a blank model below).
            </div>
          )}
        </div>
      )}

      {/* ── Card 2: SQL query source ──────────────────────────────────────── */}
      <div style={{ ...styles.card, maxWidth: 560 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>SQL query source</div>
        <div style={{ ...styles.hint, marginBottom: 8 }}>
          Define a table from a SQL <code>SELECT</code> instead of a physical table — e.g. to
          pre-filter rows, join, or import the same table twice under different names. Every
          downstream filter and measure composes on top of this query (the engine wraps it as a
          subquery). Loaded in-memory.
        </div>
        <input
          style={{ ...styles.input, marginBottom: 8 }}
          placeholder="Table name (e.g. RecentSales)"
          value={sqlName}
          disabled={!connectionId || readOnly || sqlImporting}
          onChange={(e) => setSqlName(e.target.value)}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <button
            style={styles.btn}
            disabled={!connectionId || readOnly || sqlImporting}
            onClick={() => setShowSqlEditor(true)}
          >
            {sqlText.trim() ? "Edit SQL query…" : "Write SQL query…"}
          </button>
          <span style={{ ...styles.muted, fontSize: 12, minWidth: 0, flex: 1 }}>
            {sqlText.trim() ? firstLine(sqlText) : "No query written yet."}
          </span>
        </div>
        {sqlError && (
          <div style={{ marginBottom: 8, fontSize: 12, color: "#a4262c", whiteSpace: "pre-wrap" }}>
            {sqlError}
          </div>
        )}
        <button
          style={styles.primaryBtn}
          disabled={!connectionId || readOnly || sqlImporting || !sqlName.trim() || !sqlText.trim()}
          onClick={() => void importSqlSource()}
        >
          {sqlImporting ? "Importing…" : "Import SQL source"}
        </button>
        {!connectionId && (
          <div style={{ ...styles.hint, marginTop: 6 }}>
            Select a connection first. A live database connection is required.
          </div>
        )}
      </div>

      {/* ── Card 3: New model ─────────────────────────────────────────────── */}
      <div style={{ ...styles.card, maxWidth: 560 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>New model</div>
        <div style={{ ...styles.hint, marginBottom: 8 }}>
          Create a model as a new connection — embedded in this workbook from birth, no model file
          on disk. Choose a data source (or start blank) in the dialog.
        </div>
        <button style={styles.primaryBtn} onClick={() => setShowNew(true)}>
          New model&hellip;
        </button>
      </div>

      {showNew && (
        <NewModelDialog
          onClose={() => setShowNew(false)}
          onCreated={(conn) => {
            setShowNew(false);
            onModelCreated(conn);
          }}
        />
      )}

      {showSqlEditor && (
        <SqlEditorModal
          title={sqlName.trim() ? `SQL source: ${sqlName.trim()}` : "SQL query source"}
          initialSql={sqlText}
          hint={
            "A single SELECT (or WITH …) that becomes the table's source. The engine wraps it as " +
            "(…) AS t, so every downstream filter and measure composes on top of it."
          }
          onClose={() => setShowSqlEditor(false)}
          onSave={(sql) => {
            setSqlText(sql);
            setSqlError(null);
            setShowSqlEditor(false);
          }}
        />
      )}
    </div>
  );
}

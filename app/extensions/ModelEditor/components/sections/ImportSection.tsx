// FILENAME: app/extensions/ModelEditor/components/sections/ImportSection.tsx
// PURPOSE: Import section of the Model Editor window: import table schemas
//          from the connection's source database, or create a new blank model
//          (embedded, path-less connection).

import React, { useEffect, useState } from "react";
import { biModelImportTables, biModelListSourceTables } from "@api";
import type { ConnectionInfo, ModelOverview, SourceTableInfo } from "@api";
import { styles } from "../editorShared";
import { NewModelDialog } from "../NewModelDialog";

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

  // ── New model dialog ──────────────────────────────────────────────────────
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    setSource(null);
    setSourceError(null);
    setChecked(new Set());
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
      setSource((prev) =>
        prev?.map((t) => (checked.has(keyOf(t)) ? { ...t, imported: true } : t)) ?? null,
      );
      setChecked(new Set());
    } catch (err: unknown) {
      reportError(err);
    } finally {
      setImporting(false);
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
          Pull table schemas from the current connection&apos;s source database
          into the model (introspect, append and bind).
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
              Listing source tables requires a live database connection. Connect
              this connection via Data &gt; Connections in the main window, then
              try again.
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

      {/* ── Card 2: New model ─────────────────────────────────────────────── */}
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
    </div>
  );
}

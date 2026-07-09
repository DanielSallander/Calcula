// FILENAME: app/extensions/ModelEditor/components/sections/ConnectionsSection.tsx
// PURPOSE: Connections section of the Model Editor: view/add/edit/connect the
//          model's persisted data-source catalog (engine v14) and see which
//          tables bind to which source. A model may bind different tables to
//          different sources (multi-source). Sources are secret-free
//          descriptors; credentials are supplied only when connecting and are
//          never stored in the model.

import React, { useState } from "react";
import {
  biModelConnectSource,
  biModelDeleteSource,
  biModelSetTableSourceBinding,
  biModelUpsertSource,
} from "@api";
import type { ModelSourceInfo, ModelTableInfo } from "@api";
import { Badge, Field, Modal, stripSchemaPrefix, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";

const KINDS = [
  { value: "postgres", label: "PostgreSQL" },
  { value: "sqlServer", label: "SQL Server" },
  { value: "csv", label: "CSV folder" },
  { value: "parquet", label: "Parquet folder" },
  { value: "inMemory", label: "In-memory" },
];
const AUTHS = [
  { value: "usernamePassword", label: "Username & password" },
  { value: "integrated", label: "Integrated / Windows" },
  { value: "environmentVariable", label: "Environment variable" },
];

// SSL mode presets map a single choice to (sslMode, trustServerCertificate).
// "Prefer" attempts TLS but falls back to plaintext (works with non-TLS
// servers); "Disable" never uses TLS; "Require" mandates TLS.
const SSL_MODES = [
  { value: "prefer", label: "Prefer TLS, else plaintext (default)", ssl: "", trust: false },
  { value: "disable", label: "Disable TLS (no encryption)", ssl: "disable", trust: false },
  { value: "require", label: "Require TLS", ssl: "require", trust: false },
  { value: "requireTrust", label: "Require TLS, trust certificate", ssl: "require", trust: true },
];

const isFileKind = (k: string) => k === "csv" || k === "parquet";
const isDbKind = (k: string) => k === "postgres" || k === "sqlServer";
const kindLabel = (k: string) => KINDS.find((o) => o.value === k)?.label ?? k;

/** Which SSL_MODES preset matches an (sslMode, trust) pair. */
function sslPresetValue(ssl: string, trust: boolean): string {
  if (ssl === "disable") return "disable";
  if (ssl === "require") return trust ? "requireTrust" : "require";
  return "prefer";
}

type SourceDraft = {
  original: ModelSourceInfo | null;
  id: string;
  kind: string;
  host: string;
  port: string;
  database: string;
  defaultSchema: string;
  trustServerCertificate: boolean;
  sslMode: string;
  preferredAuth: string;
  displayName: string;
};

function emptyDraft(): SourceDraft {
  return {
    original: null,
    id: "",
    kind: "postgres",
    host: "localhost",
    port: "5432",
    database: "",
    defaultSchema: "",
    trustServerCertificate: false,
    sslMode: "",
    preferredAuth: "usernamePassword",
    displayName: "",
  };
}

function draftFrom(s: ModelSourceInfo): SourceDraft {
  return {
    original: s,
    id: s.id,
    kind: s.kind,
    host: s.host,
    port: s.port == null ? "" : String(s.port),
    database: s.database,
    defaultSchema: s.defaultSchema ?? "",
    trustServerCertificate: false,
    sslMode: s.sslMode ?? "",
    preferredAuth: s.preferredAuth,
    displayName: s.displayName ?? "",
  };
}

export function ConnectionsSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const sources = overview.sources;
  const tables = overview.tables;
  const unbound = tables.filter((t) => !t.sourceId);

  const [edit, setEdit] = useState<SourceDraft | null>(null);
  const [connectFor, setConnectFor] = useState<ModelSourceInfo | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err: unknown) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  const deleteSource = (s: ModelSourceInfo) => {
    const n = s.tableCount;
    const warn = n > 0 ? ` ${n} table${n === 1 ? "" : "s"} bound to it will become unbound.` : "";
    if (!window.confirm(`Delete data source '${s.displayName ?? s.id}'?${warn}`)) return;
    void run(async () => applyOverview(await biModelDeleteSource(connectionId, s.id)));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>Connections ({sources.length})</span>
        <button
          style={styles.btn}
          disabled={readOnly || busy}
          onClick={() => setEdit(emptyDraft())}
        >
          New source
        </button>
      </div>

      <div style={styles.hint}>
        A model records where its tables come from (secret-free). Add sources, connect them with
        your credentials (never stored), and bind tables. Different tables can use different
        sources.
      </div>

      <div style={{ ...styles.card, flex: 1, minHeight: 0, overflowY: "auto" }}>
        {unbound.length > 0 && (
          <div
            style={{
              border: "1px solid #e2b04a",
              background: "#fdf6e3",
              borderRadius: 4,
              padding: "6px 10px",
              marginBottom: 10,
              fontSize: 12,
            }}
          >
            <strong>{unbound.length}</strong> unbound table{unbound.length === 1 ? "" : "s"}:{" "}
            {unbound.map((t) => t.name).join(", ")}. Bind them to a source below (or connect a
            source that provides them).
          </div>
        )}

        {sources.length === 0 && (
          <div style={styles.muted}>
            No data sources yet. Import tables (under Import) records a source automatically, or add
            one here.
          </div>
        )}

        {sources.map((s) => {
          const bound = tables.filter((t) => t.sourceId === s.id);
          const open = expanded === s.id;
          return (
            <div
              key={s.id}
              style={{ border: "1px solid #e4e4e4", borderRadius: 4, marginBottom: 8 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px" }}>
                <button
                  style={{ ...styles.smallBtn, width: 22, padding: 0 }}
                  title={open ? "Collapse" : "Show bound tables"}
                  onClick={() => setExpanded(open ? null : s.id)}
                >
                  {open ? "−" : "+"}
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <strong>{s.displayName ?? s.id}</strong>
                    <Badge>{kindLabel(s.kind)}</Badge>
                    <Badge tone={bound.length > 0 ? "ok" : "neutral"}>
                      {bound.length} table{bound.length === 1 ? "" : "s"}
                    </Badge>
                  </div>
                  <div style={{ ...styles.muted, fontSize: 12 }}>
                    {isFileKind(s.kind)
                      ? s.database || "(no path)"
                      : s.kind === "inMemory"
                        ? "in-process data (host-supplied)"
                        : `${s.host || "?"}${s.port ? `:${s.port}` : ""}/${s.database || "?"}`}
                  </div>
                </div>
                {s.kind !== "inMemory" && (
                  <button
                    style={styles.smallBtn}
                    disabled={readOnly || busy}
                    title="Connect this source with your credentials"
                    onClick={() => setConnectFor(s)}
                  >
                    Connect
                  </button>
                )}
                <button
                  style={styles.smallBtn}
                  disabled={readOnly || busy}
                  onClick={() => setEdit(draftFrom(s))}
                >
                  Edit
                </button>
                <button
                  style={{ ...styles.smallBtn, color: "#a4262c" }}
                  disabled={readOnly || busy}
                  onClick={() => deleteSource(s)}
                >
                  Delete
                </button>
              </div>

              {open && (
                <div style={{ borderTop: "1px solid #eee", padding: "6px 10px" }}>
                  {bound.length === 0 && (
                    <div style={{ ...styles.muted, fontSize: 12 }}>
                      No tables bound to this source.
                    </div>
                  )}
                  {bound.map((t) => (
                    <div
                      key={t.name}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        fontSize: 12,
                        padding: "2px 0",
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 0 }}>{t.name}</span>
                      <button
                        style={styles.smallBtn}
                        disabled={readOnly || busy}
                        title="Remove this table's binding to the source"
                        onClick={() =>
                          void run(async () =>
                            applyOverview(
                              await biModelSetTableSourceBinding(
                                connectionId,
                                t.name,
                                null,
                                "",
                                "",
                              ),
                            ),
                          )
                        }
                      >
                        Unbind
                      </button>
                    </div>
                  ))}
                  <BindRow
                    unbound={unbound}
                    defaultSchema={s.defaultSchema}
                    disabled={readOnly || busy}
                    onBind={(tableName, schema, sourceTable) =>
                      void run(async () =>
                        applyOverview(
                          await biModelSetTableSourceBinding(
                            connectionId,
                            tableName,
                            s.id,
                            schema,
                            sourceTable,
                          ),
                        ),
                      )
                    }
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {edit && (
        <SourceModal
          draft={edit}
          existingIds={sources.map((s) => s.id)}
          busy={busy}
          onClose={() => setEdit(null)}
          onSave={(d) =>
            void run(async () => {
              applyOverview(
                await biModelUpsertSource({
                  connectionId,
                  id: d.id.trim(),
                  kind: d.kind,
                  host: isDbKind(d.kind) ? d.host : null,
                  port: isDbKind(d.kind) && d.port.trim() ? Number(d.port) : null,
                  database: d.database || null,
                  defaultSchema: d.defaultSchema || null,
                  trustServerCertificate: d.trustServerCertificate,
                  sslMode: isDbKind(d.kind) ? d.sslMode || null : null,
                  preferredAuth: d.preferredAuth,
                  displayName: d.displayName || null,
                }),
              );
              setEdit(null);
            })
          }
        />
      )}

      {connectFor && (
        <ConnectModal
          source={connectFor}
          busy={busy}
          onClose={() => setConnectFor(null)}
          onConnect={(connStr) =>
            void run(async () => {
              applyOverview(await biModelConnectSource(connectionId, connectFor.id, connStr));
              setConnectFor(null);
            })
          }
        />
      )}
    </div>
  );
}

/** Inline "bind an unbound table to this source" row. */
function BindRow({
  unbound,
  defaultSchema,
  disabled,
  onBind,
}: {
  unbound: ModelTableInfo[];
  defaultSchema: string | null;
  disabled: boolean;
  onBind: (tableName: string, schema: string, sourceTable: string) => void;
}): React.ReactElement {
  const [table, setTable] = useState("");
  // Pre-filled from the source's default schema (set on the connection) so it
  // never has to be re-typed; still editable for a table in another schema.
  const [schema, setSchema] = useState(defaultSchema ?? "public");
  const [sourceTable, setSourceTable] = useState("");
  if (unbound.length === 0) return <></>;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
      <select
        style={{ ...styles.input, fontSize: 12 }}
        value={table}
        disabled={disabled}
        onChange={(e) => {
          setTable(e.target.value);
          // Guess the remote name from the model name, minus its schema prefix
          // ("BI.fact_sales" bound into schema BI must be just "fact_sales" —
          // the query engine adds the schema itself).
          if (!sourceTable) setSourceTable(stripSchemaPrefix(e.target.value, schema));
        }}
      >
        <option value="">Bind unbound table…</option>
        {unbound.map((t) => (
          <option key={t.name} value={t.name}>
            {t.name}
          </option>
        ))}
      </select>
      <input
        style={{ ...styles.input, fontSize: 12, width: 90 }}
        placeholder="schema"
        value={schema}
        disabled={disabled}
        onChange={(e) => setSchema(e.target.value)}
      />
      <input
        style={{ ...styles.input, fontSize: 12, width: 130 }}
        placeholder="source table"
        value={sourceTable}
        disabled={disabled}
        onChange={(e) => setSourceTable(e.target.value)}
      />
      <button
        style={styles.smallBtn}
        disabled={disabled || !table || !sourceTable.trim()}
        onClick={() => {
          onBind(table, schema.trim(), sourceTable.trim());
          setTable("");
          setSourceTable("");
        }}
      >
        Bind
      </button>
    </div>
  );
}

function SourceModal({
  draft,
  existingIds,
  busy,
  onClose,
  onSave,
}: {
  draft: SourceDraft;
  existingIds: string[];
  busy: boolean;
  onClose: () => void;
  onSave: (d: SourceDraft) => void;
}): React.ReactElement {
  const [d, setD] = useState<SourceDraft>(draft);
  const isEdit = draft.original !== null;
  const set = <K extends keyof SourceDraft>(k: K, v: SourceDraft[K]) =>
    setD((p) => ({ ...p, [k]: v }));
  const idClash = !isEdit && existingIds.includes(d.id.trim());
  const canSave = d.id.trim() !== "" && !idClash;

  return (
    <Modal
      title={isEdit ? `Edit source: ${draft.id}` : "New data source"}
      width={560}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.primaryBtn} disabled={busy || !canSave} onClick={() => onSave(d)}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div style={{ display: "flex", gap: 10 }}>
        <Field label="Source id" flex={1}>
          <input
            style={styles.input}
            value={d.id}
            disabled={isEdit}
            placeholder="e.g. sales_pg"
            onChange={(e) => set("id", e.target.value)}
          />
        </Field>
        <Field label="Kind" flex={1}>
          <select style={styles.input} value={d.kind} onChange={(e) => set("kind", e.target.value)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {idClash && (
        <div style={{ fontSize: 12, color: "#a4262c", marginBottom: 6 }}>
          A source with this id already exists.
        </div>
      )}

      <Field label="Display name">
        <input
          style={styles.input}
          value={d.displayName}
          placeholder="(optional) shown in the list"
          onChange={(e) => set("displayName", e.target.value)}
        />
      </Field>

      {isDbKind(d.kind) && (
        <>
          <div style={{ display: "flex", gap: 10 }}>
            <Field label="Host" flex={2}>
              <input
                style={styles.input}
                value={d.host}
                onChange={(e) => set("host", e.target.value)}
              />
            </Field>
            <Field label="Port" flex={1}>
              <input
                style={styles.input}
                value={d.port}
                onChange={(e) => set("port", e.target.value)}
              />
            </Field>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Field label="Database" flex={1}>
              <input
                style={styles.input}
                value={d.database}
                onChange={(e) => set("database", e.target.value)}
              />
            </Field>
            <Field label="Default schema" flex={1}>
              <input
                style={styles.input}
                value={d.defaultSchema}
                placeholder="e.g. public"
                onChange={(e) => set("defaultSchema", e.target.value)}
              />
            </Field>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Field label="Authentication" flex={1}>
              <select
                style={styles.input}
                value={d.preferredAuth}
                onChange={(e) => set("preferredAuth", e.target.value)}
              >
                {AUTHS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="TLS / SSL"
              flex={1}
              hint="Use Disable for a local server with no TLS support."
            >
              <select
                style={styles.input}
                value={sslPresetValue(d.sslMode, d.trustServerCertificate)}
                onChange={(e) => {
                  const preset = SSL_MODES.find((m) => m.value === e.target.value) ?? SSL_MODES[0];
                  set("sslMode", preset.ssl);
                  set("trustServerCertificate", preset.trust);
                }}
              >
                {SSL_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </>
      )}

      {isFileKind(d.kind) && (
        <Field label="Folder path" hint="Directory containing the data files.">
          <input
            style={styles.input}
            value={d.database}
            placeholder="C:\\data\\sales"
            onChange={(e) => set("database", e.target.value)}
          />
        </Field>
      )}

      {d.kind === "inMemory" && (
        <div style={{ ...styles.muted, fontSize: 12 }}>
          In-memory sources hold host-supplied data and cannot be reconnected from the model; they
          are recorded for reference only.
        </div>
      )}

      <div style={{ ...styles.muted, fontSize: 12, marginTop: 8 }}>
        No credentials are stored — you supply them when connecting.
      </div>
    </Modal>
  );
}

function ConnectModal({
  source,
  busy,
  onClose,
  onConnect,
}: {
  source: ModelSourceInfo;
  busy: boolean;
  onClose: () => void;
  onConnect: (connectionString: string) => void;
}): React.ReactElement {
  const fileKind = isFileKind(source.kind);
  const template = fileKind
    ? ""
    : `host=${source.host || "localhost"} port=${source.port ?? 5432} dbname=${source.database || ""} user= password=`;
  const [connStr, setConnStr] = useState(template);

  return (
    <Modal
      title={`Connect: ${source.displayName ?? source.id}`}
      width={560}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.primaryBtn} disabled={busy} onClick={() => onConnect(connStr)}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </>
      }
    >
      {fileKind ? (
        <div style={{ ...styles.muted, fontSize: 13 }}>
          {kindLabel(source.kind)} sources connect using the folder path in the descriptor — no
          credentials needed. Click Connect.
        </div>
      ) : (
        <Field
          label="Connection string"
          hint="Credentials are used only to connect and are never saved in the model. The host/database come from the source descriptor."
        >
          <textarea
            style={{ ...styles.textarea, minHeight: 60, fontFamily: "monospace" }}
            value={connStr}
            spellCheck={false}
            onChange={(e) => setConnStr(e.target.value)}
          />
        </Field>
      )}
    </Modal>
  );
}

// FILENAME: app/extensions/ModelEditor/components/NewModelDialog.tsx
// PURPOSE: Source-type-first "New Model" dialog. Step 1 picks a data source
//          type; step 2 shows a form tailored to that type and assembles the
//          engine connection string. Only PostgreSQL is wired today; the other
//          connectors are shown as disabled placeholders so the roadmap is
//          visible. "Blank model" creates an empty model with no source.

import React, { useState } from "react";
import { biModelConnect, biModelCreateBlank, biModelTestConnection } from "@api";
import type { ConnectionInfo } from "@api";
import { ACCENT, Field, Modal, styles } from "./editorShared";

interface SourceType {
  id: string;
  label: string;
  desc: string;
  enabled: boolean;
  /** A short glyph for the card. */
  glyph: string;
}

const SOURCE_TYPES: SourceType[] = [
  { id: "postgres", label: "PostgreSQL", desc: "Connect to a PostgreSQL database", enabled: true, glyph: "🐘" },
  { id: "sqlserver", label: "SQL Server", desc: "Coming soon", enabled: false, glyph: "🗄" },
  { id: "csv", label: "CSV files", desc: "Coming soon", enabled: false, glyph: "📄" },
  { id: "parquet", label: "Parquet files", desc: "Coming soon", enabled: false, glyph: "🗃" },
  { id: "blank", label: "Blank model", desc: "Empty model — add a data source later", enabled: true, glyph: "✎" },
];

export function NewModelDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (connection: ConnectionInfo) => void;
}): React.ReactElement {
  const [step, setStep] = useState<"source" | "configure">("source");
  const [sourceId, setSourceId] = useState<string>("");

  const [name, setName] = useState("");
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState("5432");
  const [database, setDatabase] = useState("");
  const [schema, setSchema] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the model was created but its auto-connect failed: the model
  // exists (never re-created), and the dialog shows a warning + "Open model".
  const [createdConn, setCreatedConn] = useState<ConnectionInfo | null>(null);
  const [connectWarning, setConnectWarning] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  // The connection string the last test ran against — the result banner hides
  // automatically once the form no longer matches it.
  const [testedConnStr, setTestedConnStr] = useState<string>("");

  const source = SOURCE_TYPES.find((s) => s.id === sourceId) ?? null;

  const pick = (s: SourceType) => {
    if (!s.enabled) return;
    setSourceId(s.id);
    setError(null);
    // Seed a sensible default model name from the source type.
    if (!name.trim() && s.id !== "blank") setName("");
    setStep("configure");
  };

  // Build the engine connection string (key=value; the backend also accepts
  // postgresql:// URLs). A password containing whitespace is not supported by
  // the key=value format — rare for DB passwords; noted in the hint.
  const buildConnectionString = (): string | undefined => {
    if (sourceId !== "postgres") return undefined;
    const parts = [
      `host=${host.trim()}`,
      `port=${port.trim() || "5432"}`,
      `dbname=${database.trim()}`,
      `user=${username.trim()}`,
    ];
    if (password) parts.push(`password=${password}`);
    if (schema.trim()) parts.push(`schema=${schema.trim()}`);
    return parts.join(" ");
  };

  const canCreate =
    name.trim() !== "" &&
    (sourceId === "blank" ||
      (sourceId === "postgres" &&
        host.trim() !== "" &&
        database.trim() !== "" &&
        username.trim() !== ""));

  const canTest = sourceId === "postgres" && host.trim() !== "" && database.trim() !== "" && username.trim() !== "";

  const test = async () => {
    const cs = buildConnectionString() ?? "";
    setTesting(true);
    setTestResult(null);
    setTestedConnStr(cs);
    try {
      const msg = await biModelTestConnection(cs);
      setTestResult({ ok: true, message: msg });
    } catch (err: unknown) {
      setTestResult({ ok: false, message: String(err) });
    } finally {
      setTesting(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    setConnectWarning(null);
    try {
      const conn = await biModelCreateBlank(name.trim(), buildConnectionString());
      // Best-effort auto-connect for DB sources so Import works immediately.
      // A connect failure is non-fatal — the model IS created; surface a
      // warning and let the user open it (they can fix creds via Test and
      // connect later under Data ▸ Connections).
      if (sourceId === "postgres") {
        try {
          onCreated(await biModelConnect(conn.id));
          return;
        } catch (connErr: unknown) {
          setCreatedConn(conn);
          setConnectWarning(String(connErr));
          setBusy(false);
          return;
        }
      }
      onCreated(conn);
    } catch (err: unknown) {
      setError(String(err));
      setBusy(false);
    }
  };

  // ── Step 1: source-type picker ──────────────────────────────────────────
  if (step === "source") {
    return (
      <Modal
        title="New Model — choose a data source"
        width={640}
        onClose={onClose}
        footer={
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
        }
      >
        <div style={{ ...styles.hint, marginBottom: 10 }}>
          Pick the kind of data source this model connects to. You can add more sources or import
          tables later.
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 10,
          }}
        >
          {SOURCE_TYPES.map((s) => (
            <button
              key={s.id}
              disabled={!s.enabled}
              onClick={() => pick(s)}
              style={{
                textAlign: "left",
                border: `1px solid ${s.enabled ? "#ccd3dd" : "#e6e6e6"}`,
                borderRadius: 6,
                padding: "12px 14px",
                background: s.enabled ? "#fff" : "#f6f6f7",
                cursor: s.enabled ? "pointer" : "not-allowed",
                opacity: s.enabled ? 1 : 0.6,
                display: "flex",
                flexDirection: "column",
                gap: 4,
                fontFamily: "inherit",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 18 }}>{s.glyph}</span>
                <span style={{ fontWeight: 600, color: s.enabled ? ACCENT : "#888" }}>{s.label}</span>
              </div>
              <div style={{ ...styles.hint }}>{s.desc}</div>
            </button>
          ))}
        </div>
      </Modal>
    );
  }

  // ── Step 2: configure ───────────────────────────────────────────────────
  return (
    <Modal
      title={`New Model — ${source?.label ?? ""}`}
      width={560}
      onClose={onClose}
      footer={
        createdConn ? (
          // Created, but auto-connect failed: the only forward action is to
          // open the (not-yet-connected) model.
          <button style={styles.primaryBtn} onClick={() => onCreated(createdConn)}>
            Open model
          </button>
        ) : (
          <>
            {sourceId === "postgres" && (
              <button style={styles.btn} disabled={testing || !canTest} onClick={() => void test()}>
                {testing ? "Testing…" : "Test connection"}
              </button>
            )}
            <div style={{ flex: 1 }} />
            <button style={styles.btn} onClick={() => setStep("source")}>
              Back
            </button>
            <button style={styles.btn} onClick={onClose}>
              Cancel
            </button>
            <button style={styles.primaryBtn} disabled={busy || !canCreate} onClick={() => void create()}>
              {busy ? "Creating…" : "Create model"}
            </button>
          </>
        )
      }
    >
      <Field label="Model name">
        <input
          style={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Sales Model"
          autoFocus
        />
      </Field>

      {sourceId === "postgres" && (
        <>
          <div style={{ ...styles.label, marginTop: 4, marginBottom: 6 }}>
            PostgreSQL connection
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Field label="Host" flex={2}>
              <input style={styles.input} value={host} onChange={(e) => setHost(e.target.value)} />
            </Field>
            <Field label="Port" flex={1}>
              <input style={styles.input} value={port} onChange={(e) => setPort(e.target.value)} />
            </Field>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Field label="Database" flex={1}>
              <input
                style={styles.input}
                value={database}
                onChange={(e) => setDatabase(e.target.value)}
                placeholder="sales"
              />
            </Field>
            <Field label="Schema (optional)" flex={1}>
              <input
                style={styles.input}
                value={schema}
                onChange={(e) => setSchema(e.target.value)}
                placeholder="public"
              />
            </Field>
          </div>
          <Field label="Username">
            <input
              style={styles.input}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="postgres"
            />
          </Field>
          <Field
            label="Password"
            hint="Stored with the connection. Import tables after creating via Import ▸ List source tables (connect the model first under Data ▸ Connections)."
          >
            <input
              style={styles.input}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </>
      )}

      {sourceId === "blank" && (
        <div style={{ ...styles.hint, marginTop: 4 }}>
          Creates an empty model embedded in this workbook. Add tables, measures and other objects
          from the editor, or attach a data source later.
        </div>
      )}

      {testResult && testedConnStr === (buildConnectionString() ?? "") && (
        <div
          style={{
            marginTop: 8,
            padding: "6px 10px",
            borderRadius: 4,
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: testResult.ok ? "#e2f4e5" : "#fdecea",
            color: testResult.ok ? "#1e7a34" : "#a4262c",
            border: `1px solid ${testResult.ok ? "#b7e0bf" : "#f3c1c4"}`,
          }}
        >
          {testResult.message}
        </div>
      )}

      {connectWarning && (
        <div
          style={{
            marginTop: 8,
            padding: "8px 10px",
            borderRadius: 4,
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: "#fff3cd",
            color: "#7a5b00",
            border: "1px solid #ecdfa8",
          }}
        >
          <strong>Model created, but it couldn&apos;t connect.</strong>
          <div style={{ marginTop: 3 }}>{connectWarning}</div>
          <div style={{ marginTop: 4 }}>
            Open the model and connect it later under Data ▸ Connections, or fix the details and use
            Test connection.
          </div>
        </div>
      )}

      {error && <div style={{ color: "red", marginTop: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}

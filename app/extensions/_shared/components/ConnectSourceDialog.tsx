// FILENAME: app/extensions/_shared/components/ConnectSourceDialog.tsx
// PURPOSE: Floating credentials window for connecting a BI data source.
// CONTEXT: Replaces the old window.prompt/window.alert flow (which connected
// as the OS user and dumped raw driver errors into a native message box).
// A themed, movable, resizable window with an explicit username field, inline
// error display, and a "Remember on this machine" opt-out. Rendered inline by
// callers (Pivot connection banner, Subscribe flow) — no dialog registry.

import React, { useEffect, useRef, useState } from "react";
import { useDialogWindow } from "@api/dialogWindow";

/** Everything the user confirmed in the window, ready to build a connection. */
export interface ConnectSourceFields {
  server: string;
  database: string;
  username: string;
  password: string;
  remember: boolean;
}

export interface ConnectSourceDialogProps {
  /** Display name of the connection/model being connected. */
  connectionName: string;
  /** Prefill for the (editable) server field. */
  server: string;
  /** Prefill for the (editable) database field — packages may ship without
   *  one, and connecting with an empty dbname silently targets the user's
   *  default database, so the user must be able to correct it here. */
  database: string;
  /** Prefill for the username field. */
  initialUsername?: string;
  onCancel: () => void;
  /**
   * Attempt the connection with the entered fields; reject with an error to
   * display it inline. Resolving closes the window (caller unmounts).
   */
  onConnect: (fields: ConnectSourceFields) => Promise<void>;
}

export function ConnectSourceDialog({
  connectionName,
  server: initialServer,
  database: initialDatabase,
  initialUsername,
  onCancel,
  onConnect,
}: ConnectSourceDialogProps): React.ReactElement {
  const win = useDialogWindow({ minWidth: 380, minHeight: 360 });
  const [server, setServer] = useState(initialServer);
  const [database, setDatabase] = useState(initialDatabase);
  const [username, setUsername] = useState(initialUsername ?? "");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    (initialUsername ? passwordRef : usernameRef).current?.focus();
  }, [initialUsername]);

  const handleConnect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConnect({
        server: server.trim(),
        database: database.trim(),
        username: username.trim(),
        password,
        remember,
      });
    } catch (err: unknown) {
      setError(String(err));
      setBusy(false);
    }
  };

  const windowStyle: React.CSSProperties = {
    position: "fixed",
    left: "50%",
    top: "18%",
    transform: "translateX(-50%)",
    width: "400px",
    zIndex: 1060,
    display: "flex",
    flexDirection: "column",
    background: "var(--panel-bg)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-default)",
    borderRadius: "8px",
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: "13px",
  };
  const headerStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "8px 12px",
    flexShrink: 0,
    cursor: "grab",
    userSelect: "none",
    borderBottom: "1px solid var(--border-default)",
  };
  const closeButtonStyle: React.CSSProperties = {
    background: "transparent",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    padding: "2px 8px",
    borderRadius: "4px",
    fontSize: "14px",
    lineHeight: 1,
  };
  const bodyStyle: React.CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: "12px 16px",
  };
  const footerStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "10px 16px",
    flexShrink: 0,
    borderTop: "1px solid var(--border-default)",
  };
  const fieldStyle: React.CSSProperties = {
    display: "flex", flexDirection: "column", gap: "4px", marginBottom: "8px",
  };
  const inputStyle: React.CSSProperties = {
    padding: "4px 6px",
    border: "1px solid var(--border-default)",
    borderRadius: "3px",
    fontSize: "13px",
    background: "var(--bg-surface)",
    color: "var(--text-primary)",
  };
  const infoStyle: React.CSSProperties = {
    fontSize: "12px",
    color: "var(--text-secondary)",
    margin: "0 0 10px 0",
    lineHeight: 1.5,
  };

  return (
    <div
      ref={win.ref}
      style={{ ...windowStyle, ...win.style }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div style={headerStyle} onMouseDown={win.onHeaderMouseDown}>
        <span style={{ fontWeight: 600 }}>Connect to {connectionName}</span>
        <button style={closeButtonStyle} onClick={onCancel} aria-label="Close" title="Close">
          ✕
        </button>
      </div>

      <div style={bodyStyle}>
        <p style={infoStyle}>
          Credentials stay on this machine — they are never stored in the
          workbook or in distributed packages.
        </p>

        <div style={fieldStyle}>
          <label>Server</label>
          <input
            style={inputStyle}
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder="localhost"
            disabled={busy}
          />
        </div>
        <div style={fieldStyle}>
          <label>Database</label>
          <input
            style={inputStyle}
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
            placeholder="database name"
            disabled={busy}
          />
        </div>
        <div style={fieldStyle}>
          <label>Username</label>
          <input
            ref={usernameRef}
            style={inputStyle}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="postgres"
            disabled={busy}
          />
        </div>
        <div style={fieldStyle}>
          <label>Password</label>
          <input
            ref={passwordRef}
            style={inputStyle}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleConnect();
            }}
            disabled={busy}
          />
        </div>
        <div style={{ ...fieldStyle, flexDirection: "row", alignItems: "center", gap: "6px" }}>
          <input
            id="connect-source-remember"
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            disabled={busy}
          />
          <label htmlFor="connect-source-remember" style={{ cursor: "pointer" }}>
            Remember on this machine (connect automatically next time)
          </label>
        </div>

        {error && (
          <div style={{
            color: "var(--text-error, #d33)",
            margin: "8px 0 0 0",
            fontSize: "12px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}>
            {error}
          </div>
        )}
      </div>

      <div style={footerStyle}>
        <button onClick={onCancel} disabled={busy}>Cancel</button>
        <button onClick={() => void handleConnect()} disabled={busy} style={{ fontWeight: 600 }}>
          {busy ? "Connecting..." : "Connect"}
        </button>
      </div>

      {win.resizeHandles}
    </div>
  );
}

//! FILENAME: app/extensions/ModelEditor/components/ModelEditorApp.tsx
// PURPOSE: Root component for the standalone Model Editor window. Hosts the
//          connection picker, the section nav (measures, tables,
//          relationships, hierarchies, KPIs, roles, calculation groups,
//          import) and the cross-window bridge back to the main window.
// CONTEXT: Mounted by src/modelEditorMain.tsx in the "model-editor" Tauri
//          window. The grid lives in the OTHER window — after every model
//          mutation we emit model-changed so the main window recalcs CUBE.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  biGetConnections,
  biModelExportToFile,
  biModelGetOverview,
  biModelImportFromFile,
  biModelRedo,
  biModelUndo,
  biModelUndoState,
} from "@api";
import type {
  ConnectionInfo,
  ModelMeasureInfo,
  ModelOverview,
  ModelUndoState,
} from "@api";
import {
  emitEditorReady,
  emitModelChanged,
  onOpenWithConnection,
} from "../lib/crossWindowEvents";
import { ACCENT, ErrorBanner, styles } from "./editorShared";
import type { SectionCtx } from "./editorShared";
import { MeasuresSection } from "./sections/MeasuresSection";
import { TablesSection } from "./sections/TablesSection";
import { RelationshipsSection } from "./sections/RelationshipsSection";
import { ConnectionsSection } from "./sections/ConnectionsSection";
import { HierarchiesSection } from "./sections/HierarchiesSection";
import { KpisSection } from "./sections/KpisSection";
import { RolesSection } from "./sections/RolesSection";
import { PerspectivesSection } from "./sections/PerspectivesSection";
import { TranslationsSection } from "./sections/TranslationsSection";
import { CalcGroupsSection } from "./sections/CalcGroupsSection";
import { ImportSection } from "./sections/ImportSection";
import { OverviewSection } from "./sections/OverviewSection";
import { ContextsSection } from "./sections/ContextsSection";
import { GlobalsSection } from "./sections/GlobalsSection";
import { TableVariablesSection } from "./sections/TableVariablesSection";
import { ScriptFunctionsSection } from "./sections/ScriptFunctionsSection";
import { SettingsSection } from "./sections/SettingsSection";
import { TestingGroundSection } from "./sections/TestingGroundSection";
import { LineageSection } from "./sections/LineageSection";
import { NewModelDialog } from "./NewModelDialog";
import { CommandPanel } from "./CommandPanel";
import { CliReferencePane } from "./CliReferencePane";

// ============================================================================
// Navigation
// ============================================================================

type SectionId =
  | "overview"
  | "tables"
  | "connections"
  | "relationships"
  | "hierarchies"
  | "measures"
  | "contexts"
  | "kpis"
  | "calcGroups"
  | "globals"
  | "tableVariables"
  | "scriptFunctions"
  | "roles"
  | "perspectives"
  | "translations"
  | "lineage"
  | "testing"
  | "settings"
  | "import";

const NAV: Array<{ id: SectionId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "tables", label: "Tables" },
  { id: "connections", label: "Connections" },
  { id: "relationships", label: "Relationships" },
  { id: "hierarchies", label: "Hierarchies" },
  { id: "measures", label: "Measures" },
  { id: "contexts", label: "Contexts" },
  { id: "kpis", label: "KPIs" },
  { id: "calcGroups", label: "Calculation Groups" },
  { id: "globals", label: "Calculated Tables" },
  { id: "tableVariables", label: "Table Variables" },
  { id: "scriptFunctions", label: "Script Functions" },
  { id: "roles", label: "Security Roles" },
  { id: "perspectives", label: "Perspectives" },
  { id: "translations", label: "Translations" },
  { id: "lineage", label: "Lineage" },
  { id: "testing", label: "Testing Ground" },
  { id: "settings", label: "Settings" },
  { id: "import", label: "Import" },
];

// ============================================================================
// Styles
// ============================================================================

const appStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  background: "#f4f5f7",
  color: "#222",
  fontFamily: "'Segoe UI', system-ui, sans-serif",
  fontSize: 13,
  overflow: "hidden",
};

const topBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 12px",
  background: "#fff",
  borderBottom: "1px solid #ddd",
  flexShrink: 0,
};

const readOnlyBannerStyle: React.CSSProperties = {
  padding: "5px 12px",
  background: "#fff3cd",
  color: "#7a5b00",
  fontSize: 12,
  borderBottom: "1px solid #ecdfa8",
  flexShrink: 0,
};

const navStyle: React.CSSProperties = {
  width: 170,
  flexShrink: 0,
  borderRight: "1px solid #ddd",
  background: "#eef0f2",
  paddingTop: 8,
  overflowY: "auto",
};

const navItemStyle = (active: boolean): React.CSSProperties => ({
  padding: "7px 14px",
  fontSize: 12,
  cursor: "pointer",
  userSelect: "none",
  color: active ? ACCENT : "#333",
  fontWeight: active ? 600 : 400,
  background: active ? "#fff" : "transparent",
  borderLeft: active ? `3px solid ${ACCENT}` : "3px solid transparent",
});

const contentStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  padding: 12,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

// ============================================================================
// App
// ============================================================================

export function ModelEditorApp(): React.ReactElement {
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [overview, setOverview] = useState<ModelOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<SectionId>("overview");
  const [undoState, setUndoState] = useState<ModelUndoState>({ canUndo: false, canRedo: false });
  const [showNewModel, setShowNewModel] = useState(false);
  const [showCli, setShowCli] = useState(
    () => localStorage.getItem("calcula.modelEditor.cli.open") === "1",
  );
  const [showCliRef, setShowCliRef] = useState(
    () => localStorage.getItem("calcula.modelEditor.cliRef.open") === "1",
  );

  const toggleCli = useCallback(() => {
    setShowCli((prev) => {
      localStorage.setItem("calcula.modelEditor.cli.open", prev ? "0" : "1");
      return !prev;
    });
  }, []);

  const toggleCliRef = useCallback(() => {
    setShowCliRef((prev) => {
      localStorage.setItem("calcula.modelEditor.cliRef.open", prev ? "0" : "1");
      return !prev;
    });
  }, []);

  // VSCode-style Ctrl+` toggles the command panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "Backquote") {
        e.preventDefault();
        toggleCli();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleCli]);

  const connectionIdRef = useRef(connectionId);
  connectionIdRef.current = connectionId;

  const refreshUndoState = useCallback(async (connId: string) => {
    if (!connId) {
      setUndoState({ canUndo: false, canRedo: false });
      return;
    }
    try {
      setUndoState(await biModelUndoState(connId));
    } catch {
      setUndoState({ canUndo: false, canRedo: false });
    }
  }, []);

  // Monotonic sequence for overview installs. Every code path that installs
  // an overview bumps it first; an async refresh may only apply its result if
  // the sequence it captured is still current. This stops a slow background
  // biModelGetOverview from clobbering a newer mutation's overview.
  const overviewSeqRef = useRef(0);

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

  const refreshOverview = useCallback(async (connId: string) => {
    const seq = ++overviewSeqRef.current;
    if (!connId) {
      setOverview(null);
      return;
    }
    setLoading(true);
    try {
      const o = await biModelGetOverview(connId);
      if (connectionIdRef.current === connId && overviewSeqRef.current === seq) {
        setOverview(o);
      }
    } catch (err: unknown) {
      if (connectionIdRef.current === connId && overviewSeqRef.current === seq) {
        setOverview(null);
        setError(String(err));
      }
    } finally {
      if (connectionIdRef.current === connId) setLoading(false);
    }
  }, []);

  // Background refresh after a measure mutation (renames can affect KPIs).
  // Captures the sequence at launch: the result applies only if no newer
  // overview was installed meanwhile, and errors are IGNORED so a transient
  // failure never blanks the editor mid-edit.
  const refreshOverviewInBackground = useCallback(async (connId: string) => {
    const seq = overviewSeqRef.current;
    try {
      const o = await biModelGetOverview(connId);
      if (connectionIdRef.current === connId && overviewSeqRef.current === seq) {
        overviewSeqRef.current += 1;
        setOverview(o);
      }
    } catch {
      // Ignored: keep the patched overview already on screen.
    }
  }, []);

  // Initial connection list.
  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  // Reload the overview whenever the connection changes. Clear it FIRST so
  // the sections (and any open modal) unmount instead of operating on the
  // previous model under the new connectionId (cross-model write hazard).
  useEffect(() => {
    setError(null);
    setOverview(null);
    void refreshOverview(connectionId);
    void refreshUndoState(connectionId);
  }, [connectionId, refreshOverview, refreshUndoState]);

  // Cross-window bridge: register the listener FIRST, then announce
  // readiness so the main window can hand over the initial connection.
  useEffect(() => {
    const openPromise = onOpenWithConnection(({ connectionId: requested }) => {
      void loadConnections().then(() => {
        if (requested) setConnectionId(requested);
      });
    });
    void openPromise.then(() => emitEditorReady());
    return () => {
      void openPromise.then((unlisten) => unlisten());
    };
  }, [loadConnections]);

  // ── Mutation plumbing ────────────────────────────────────────────────────
  // Every mutation endpoint returns the fresh ModelOverview: one setter keeps
  // all sections in sync, and the main window is notified (it recalcs CUBE).

  const applyOverview = useCallback(
    (o: ModelOverview) => {
      overviewSeqRef.current += 1;
      setOverview(o);
      setError(null);
      const id = connectionIdRef.current;
      if (id) {
        void emitModelChanged(id);
        void refreshUndoState(id);
      }
      // Refresh the connection list so the top-bar table/measure counts stay
      // current after a mutation that changes them (e.g. importing tables).
      void loadConnections();
    },
    [refreshUndoState, loadConnections],
  );

  // The measure endpoints return only the measure list — patch it in, then
  // refresh the full overview in the background (renames can affect KPIs).
  const applyMeasures = useCallback(
    (measures: ModelMeasureInfo[]) => {
      overviewSeqRef.current += 1;
      setOverview((prev) => (prev ? { ...prev, measures } : prev));
      setError(null);
      const id = connectionIdRef.current;
      if (id) {
        void emitModelChanged(id);
        void refreshOverviewInBackground(id);
        void refreshUndoState(id);
      }
    },
    [refreshOverviewInBackground, refreshUndoState],
  );

  const handleUndo = useCallback(async () => {
    const id = connectionIdRef.current;
    if (!id) return;
    try {
      applyOverview(await biModelUndo(id));
    } catch (err: unknown) {
      setError(String(err));
    }
  }, [applyOverview]);

  const handleRedo = useCallback(async () => {
    const id = connectionIdRef.current;
    if (!id) return;
    try {
      applyOverview(await biModelRedo(id));
    } catch (err: unknown) {
      setError(String(err));
    }
  }, [applyOverview]);

  const reportError = useCallback((err: unknown) => {
    setError(String(err));
  }, []);

  const handleModelCreated = useCallback(
    (conn: ConnectionInfo) => {
      void loadConnections().then(() => setConnectionId(conn.id));
      void emitModelChanged(conn.id);
    },
    [loadConnections],
  );

  // Export the current model to a standalone file (workbook copy for
  // sharing/versioning); the model still lives in — and saves with — the
  // workbook. Import brings a model file in as a new workbook-embedded model.
  const [ioBusy, setIoBusy] = useState(false);
  const currentModelName =
    connections.find((c) => c.id === connectionId)?.name ?? overview?.modelName ?? "model";

  const handleExportModel = useCallback(async () => {
    if (!connectionId) return;
    setIoBusy(true);
    try {
      await biModelExportToFile(connectionId, currentModelName);
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setIoBusy(false);
    }
  }, [connectionId, currentModelName]);

  const handleImportModel = useCallback(async () => {
    setIoBusy(true);
    try {
      const conn = await biModelImportFromFile();
      if (conn) handleModelCreated(conn);
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setIoBusy(false);
    }
  }, [handleModelCreated]);

  // ── Render ───────────────────────────────────────────────────────────────

  const readOnly = overview ? !overview.editable : true;

  const renderSection = (): React.ReactNode => {
    if (active === "import") {
      return (
        <ImportSection
          connectionId={connectionId}
          readOnly={readOnly}
          applyOverview={applyOverview}
          reportError={reportError}
          onModelCreated={handleModelCreated}
        />
      );
    }
    if (!connectionId) {
      return (
        <div style={{ ...styles.muted, padding: 8 }}>
          No BI connection. Load a model via Data &gt; Connections in the main
          window, or{" "}
          <button style={styles.btn} onClick={() => setShowNewModel(true)}>
            create a model
          </button>
        </div>
      );
    }
    if (!overview) {
      return (
        <div style={{ ...styles.muted, padding: 8 }}>
          {loading ? "Loading model…" : "Could not load the model overview for this connection."}
        </div>
      );
    }
    const ctx: SectionCtx = {
      connectionId,
      overview,
      readOnly,
      applyOverview,
      applyMeasures,
      reportError,
    };
    switch (active) {
      case "overview":
        return <OverviewSection ctx={ctx} />;
      case "measures":
        return <MeasuresSection ctx={ctx} />;
      case "tables":
        return <TablesSection ctx={ctx} />;
      case "connections":
        return <ConnectionsSection ctx={ctx} />;
      case "relationships":
        return <RelationshipsSection ctx={ctx} />;
      case "hierarchies":
        return <HierarchiesSection ctx={ctx} />;
      case "contexts":
        return <ContextsSection ctx={ctx} />;
      case "kpis":
        return <KpisSection ctx={ctx} />;
      case "calcGroups":
        return <CalcGroupsSection ctx={ctx} />;
      case "globals":
        return <GlobalsSection ctx={ctx} />;
      case "tableVariables":
        return <TableVariablesSection ctx={ctx} />;
      case "scriptFunctions":
        return <ScriptFunctionsSection ctx={ctx} />;
      case "roles":
        return <RolesSection ctx={ctx} />;
      case "perspectives":
        return <PerspectivesSection ctx={ctx} />;
      case "translations":
        return <TranslationsSection ctx={ctx} />;
      case "lineage":
        return <LineageSection ctx={ctx} />;
      case "testing":
        return <TestingGroundSection ctx={ctx} />;
      case "settings":
        return <SettingsSection ctx={ctx} />;
    }
  };

  return (
    // spellCheck is inheritable: disabling it here stops the WebView underlining
    // formula tokens / identifiers (e.g. __column) in every input/textarea below.
    <div style={appStyle} spellCheck={false}>
      <div style={topBarStyle}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Model Editor</span>
        <select
          style={{ ...styles.input, fontSize: 12, minWidth: 260 }}
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
        <button style={styles.btn} onClick={() => setShowNewModel(true)}>
          New Model&hellip;
        </button>
        <button
          style={styles.btn}
          disabled={ioBusy}
          title="Import a model from a file (.json / Studio ModelBundle) as a new workbook model"
          onClick={() => void handleImportModel()}
        >
          Import&hellip;
        </button>
        <button
          style={styles.btn}
          disabled={ioBusy || !connectionId}
          title="Export this model to a standalone file (it still saves with the workbook)"
          onClick={() => void handleExportModel()}
        >
          Export&hellip;
        </button>
        <button
          style={styles.btn}
          disabled={!undoState.canUndo || readOnly}
          title="Undo the last model edit"
          onClick={() => void handleUndo()}
        >
          Undo
        </button>
        <button
          style={styles.btn}
          disabled={!undoState.canRedo || readOnly}
          title="Redo"
          onClick={() => void handleRedo()}
        >
          Redo
        </button>
        <button
          style={{
            ...styles.btn,
            ...(showCli ? { background: ACCENT, color: "#fff" } : {}),
          }}
          title="Toggle the command line panel (Ctrl+`)"
          onClick={toggleCli}
        >
          Command Line
        </button>
        <div style={{ flex: 1 }} />
        {loading && <span style={{ ...styles.muted, fontSize: 12 }}>Loading&hellip;</span>}
        {/* Models have no separate file: edits live in this workbook and are
            written to disk when the workbook is saved. Surfaced so users don't
            hunt for a "Save model" action that doesn't exist. */}
        <span
          style={{ ...styles.muted, fontSize: 12, whiteSpace: "nowrap" }}
          title="Model changes are kept in this workbook and written to disk when you save the workbook (Ctrl+S). There is no separate model file to save."
        >
          Changes save with the workbook (Ctrl+S)
        </span>
      </div>

      {overview?.readOnlyReason && (
        <div style={readOnlyBannerStyle}>Read-only: {overview.readOnlyReason}</div>
      )}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <nav style={navStyle}>
          {NAV.map((item) => (
            <div
              key={item.id}
              style={navItemStyle(item.id === active)}
              onClick={() => setActive(item.id)}
            >
              {item.label}
            </div>
          ))}
        </nav>
        <main style={contentStyle}>{renderSection()}</main>
        {showCliRef && <CliReferencePane onClose={toggleCliRef} />}
      </div>

      {showCli && (
        <CommandPanel
          connectionId={connectionId}
          overview={overview}
          readOnly={readOnly}
          onApplyOverview={applyOverview}
          onClose={toggleCli}
          referenceOpen={showCliRef}
          onToggleReference={toggleCliRef}
        />
      )}

      {showNewModel && (
        <NewModelDialog
          onClose={() => setShowNewModel(false)}
          onCreated={(conn) => {
            setShowNewModel(false);
            handleModelCreated(conn);
          }}
        />
      )}
    </div>
  );
}

//! FILENAME: app/extensions/ModelEditor/components/ModelEditorApp.tsx
// PURPOSE: Root component for the standalone Model Editor window. Hosts the
//          connection picker, the section nav (measures, tables,
//          relationships, hierarchies, KPIs, roles, calculation groups,
//          import) and the cross-window bridge back to the main window.
// CONTEXT: Mounted by src/modelEditorMain.tsx in the "model-editor" Tauri
//          window. The grid lives in the OTHER window — after every model
//          mutation we emit model-changed so the main window recalcs CUBE.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  biGetConnections,
  biModelExportToFile,
  biModelGetOverview,
  biModelImportFromFile,
  biModelRedo,
  biModelUndo,
  biModelUndoState,
  isModelRecordingArmed,
  listenTauriEvent,
  MACRO_RECORDING_ARMED_EVENT,
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
import type { SectionCtx, SectionId } from "./editorShared";
import { useSectionRoute } from "../lib/useSectionRoute";
import { useRememberWindowGeometry } from "../lib/useRememberWindowGeometry";
import { MeasuresSection } from "./sections/MeasuresSection";
import { TablesSection } from "./sections/TablesSection";
import { RelationshipsSection } from "./sections/RelationshipsSection";
import { ConnectionsSection } from "./sections/ConnectionsSection";
import { HierarchiesSection } from "./sections/HierarchiesSection";
import { KpisSection } from "./sections/KpisSection";
import { StrategySection } from "./sections/StrategySection";
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
import { TopBarMenu } from "./TopBarMenu";
import { NAV_ICONS } from "./navIcons";
import { SearchPalette } from "./SearchPalette";
import { ProblemsChip, ProblemsDrawer } from "./ProblemsDrawer";
import { useProblems } from "../lib/useProblems";
import { problemsBySection } from "../lib/problems";
import { createSession, executeRun, planRun } from "../cli/execute";
import { createLiveGateway } from "../cli/gateway";
import { CommandPanel } from "./CommandPanel";
import { CliReferencePane } from "./CliReferencePane";
import { FONT, ME, RADIUS, SIZE, SPACE, TABULAR } from "./theme";

// ============================================================================
// Navigation
// ============================================================================

// The rail was 20 flat items in DTO order — a mirror of the `ModelOverview`
// struct rather than a model of the work. Grouping costs nothing and turns one
// undifferentiated list into six short ones a reader can skip between. The
// groups are the destination IA's; the MERGES that shrink 20 to 16
// (Overview+Settings, Connections+Import, KPIs onto measures) are a later
// stage, so every current section still has a slot.
interface NavItem {
  id: SectionId;
  label: string;
  /** Objects of this kind in the model, shown right-aligned. Omitted for the
   *  sections that are tools rather than lists. */
  count?: (o: ModelOverview) => number;
}

interface NavGroup {
  /** Null renders the group with no heading (the first, always-visible band). */
  title: string | null;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: null,
    items: [
      { id: "overview", label: "Overview" },
      { id: "connections", label: "Connections", count: (o) => o.sources.length },
      { id: "import", label: "Import" },
      { id: "settings", label: "Settings" },
    ],
  },
  {
    title: "Structure",
    items: [
      { id: "tables", label: "Tables", count: (o) => o.tables.length },
      { id: "relationships", label: "Relationships", count: (o) => o.relationships.length },
      { id: "hierarchies", label: "Hierarchies", count: (o) => o.hierarchies.length },
      { id: "lineage", label: "Lineage" },
    ],
  },
  {
    title: "Calculations",
    items: [
      { id: "measures", label: "Measures", count: (o) => o.measures.length },
      { id: "calcGroups", label: "Calculation Groups", count: (o) => o.calculationGroups.length },
      { id: "scriptFunctions", label: "Script Functions", count: (o) => o.scriptFunctions.length },
    ],
  },
  {
    title: "Derived",
    items: [
      { id: "globals", label: "Calculated Tables", count: (o) => o.globalVariables.length },
      { id: "tableVariables", label: "Table Variables", count: (o) => o.tableVariables.length },
      { id: "contexts", label: "Contexts", count: (o) => o.contexts.length },
    ],
  },
  {
    title: "Governance",
    items: [
      { id: "roles", label: "Security Roles", count: (o) => o.securityRoles.length },
      { id: "perspectives", label: "Perspectives", count: (o) => o.perspectives.length },
      { id: "translations", label: "Translations", count: (o) => o.cultures.length },
    ],
  },
  {
    title: "Meaning",
    // A KPI states the goal; the strategy states what a movement towards it
    // MEANS, and layers on the same metadata.
    items: [
      { id: "kpis", label: "KPIs", count: (o) => o.kpis.length },
      { id: "strategy", label: "Strategy" },
    ],
  },
  {
    title: "Tools",
    items: [{ id: "testing", label: "Testing Ground" }],
  },
];

/** Flat, in rail order — the sequence Up/Down arrow keys walk. */
const NAV_ORDER: SectionId[] = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));

// ============================================================================
// Styles
// ============================================================================

const appStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  background: ME.canvas,
  color: ME.text,
  fontFamily: ME.font,
  fontSize: FONT.base,
  overflow: "hidden",
};

const topBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: SPACE.sm,
  height: SIZE.topBar,
  padding: `0 ${SPACE.md}px`,
  background: ME.surface,
  borderBottom: `1px solid ${ME.borderSubtle}`,
  flexShrink: 0,
};

const statusStripStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: SPACE.md,
  height: SIZE.statusStrip,
  flexShrink: 0,
  padding: `0 ${SPACE.md}px`,
  borderTop: `1px solid ${ME.border}`,
  background: ME.surface,
  color: ME.text3,
  fontSize: FONT.xs,
  whiteSpace: "nowrap",
};

const readOnlyBannerStyle: React.CSSProperties = {
  padding: `${SPACE.sm}px ${SPACE.md}px`,
  background: ME.warnBg,
  color: ME.warnFg,
  fontSize: FONT.sm,
  borderBottom: `1px solid ${ME.warnFg}`,
  flexShrink: 0,
};

/** Breathing room down each side, so the active pill floats in the rail
 *  instead of butting against its edges. */
const RAIL_GUTTER = 8;

const navStyle: React.CSSProperties = {
  width: SIZE.railWidth,
  flexShrink: 0,
  borderRight: `1px solid ${ME.border}`,
  background: ME.sunken,
  paddingTop: SPACE.xs,
  paddingBottom: SPACE.md,
  paddingLeft: RAIL_GUTTER,
  paddingRight: RAIL_GUTTER,
  overflowY: "auto",
};

// The group heading is a LABEL, not a row: quieter than any item under it, and
// separated by space above rather than a rule. A rule here would draw six lines
// across the rail and make the groups look like six panels.
const navGroupTitleStyle: React.CSSProperties = {
  padding: `${SPACE.lg}px ${SPACE.sm}px ${SPACE.xs}px`,
  fontSize: FONT.xs,
  fontWeight: 600,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: ME.text3,
  userSelect: "none",
};

// ONE STATE, ONE EMPHASIS — and the emphasis is now a PILL.
//
// The active item once carried four signals at once: accent text, bold weight,
// a white background and a left bar. That went down to a surface step plus a
// bar; this takes it to a single rounded fill, which is what every rail people
// use daily settles on. The bar is gone with it: a bar and a fill say the same
// thing twice, and the bar has to touch the rail's edge, which is exactly what
// stops a rail looking composed.
//
// The icon does the work the weight used to. It is `text2` at rest and `text`
// when active, so the row gains contrast without gaining boldness — a rail
// where the current item is the only bold line reads as shouting.
const navItemStyle = (active: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: SPACE.sm,
  width: "100%",
  boxSizing: "border-box",
  minHeight: SIZE.railRow,
  padding: `0 ${SPACE.sm}px`,
  borderRadius: RADIUS.control,
  fontSize: FONT.base,
  fontFamily: "inherit",
  textAlign: "left",
  cursor: "pointer",
  userSelect: "none",
  border: "none",
  color: active ? ME.text : ME.text2,
  fontWeight: active ? 600 : 400,
  background: active ? ME.select : "transparent",
});

/** The icon's colour tracks the row's state; the label is what it labels. */
const navIconStyle = (active: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  color: active ? ME.accent : ME.text3,
});

/** Counts are tabular so the column does not shimmer as they change. */
const navCountStyle: React.CSSProperties = {
  marginLeft: "auto",
  fontSize: FONT.sm,
  color: ME.text3,
  ...TABULAR,
};

/** The label truncates rather than wrapping: a two-line rail row breaks the
 *  rhythm of every row under it, and "Calculation Groups" is one character from
 *  the edge at 190px. */
const navLabelStyle: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

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
  const { route, navigate } = useSectionRoute(connectionId);
  const active = route.section;
  useRememberWindowGeometry();
  const { problems, coverage: problemCoverage, busy: problemsBusy, recheck } =
    useProblems(connectionId, overview);
  const sectionSeverity = problemsBySection(problems);
  const [undoState, setUndoState] = useState<ModelUndoState>({ canUndo: false, canRedo: false });
  const [showNewModel, setShowNewModel] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  // A handed-over command carries a nonce so the SAME text sent twice still
  // lands in the prompt (see CliPanel.prefill).
  const [cliPrefill, setCliPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const prefillNonce = useRef(0);

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

  // Window-level shortcuts. Ctrl+` (the command panel) was the ONLY one in this
  // window; undo and redo were buttons you had to reach for with the mouse in
  // an editor whose every action is undoable.
  const undoRef = useRef<() => void>(() => {});
  const redoRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // `/` opens the palette when focus is not in a text surface — the
      // convention every search-first tool uses. Checked BEFORE the ctrl gate
      // because it carries no modifier. `typing` is reused by the undo/redo
      // arm below for the same reason: Monaco must keep its own keys.
      const el = document.activeElement;
      const typing =
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable ||
          el.closest(".monaco-editor") !== null);
      if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key === "/" && !typing) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (!e.ctrlKey || e.altKey) return;
      if (!e.shiftKey && e.code === "KeyK") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (!e.shiftKey && e.code === "Backquote") {
        e.preventDefault();
        toggleCli();
        return;
      }
      // Ctrl+1..7 jump to the first item of each rail group.
      if (!e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        const group = NAV_GROUPS[Number(e.code.slice(5)) - 1];
        if (group) {
          e.preventDefault();
          navigate(group.items[0].id);
        }
        return;
      }
      // Monaco owns undo inside an editor; only take the key when focus is not
      // in a text surface, or a half-typed measure would lose its edit history
      // to a model-level undo. Same `typing` test the `/` shortcut uses.
      if (typing) return;
      if (!e.shiftKey && e.code === "KeyZ") {
        e.preventDefault();
        undoRef.current();
      } else if (e.code === "KeyY" || (e.shiftKey && e.code === "KeyZ")) {
        e.preventDefault();
        redoRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleCli, navigate]);

  // Macro-recording pill: edits made HERE are captured by the recorder in the
  // MAIN window while it is armed — without this, recording in the Model
  // Editor would be invisible in the Model Editor.
  const [macroRecording, setMacroRecording] = useState(false);
  useEffect(() => {
    let disposed = false;
    void isModelRecordingArmed()
      .then((armed) => {
        if (!disposed) setMacroRecording(armed);
      })
      .catch(() => {});
    const unlisten = listenTauriEvent<{ armed: boolean }>(
      MACRO_RECORDING_ARMED_EVENT,
      (p) => setMacroRecording(Boolean(p?.armed)),
    );
    return () => {
      disposed = true;
      void unlisten.then((un) => un());
    };
  }, []);

  const connectionIdRef = useRef(connectionId);
  connectionIdRef.current = connectionId;

  // Same live-ref pattern: `runCommand` is handed to every section through the
  // ctx and must see the CURRENT model, not the one captured when the callback
  // was created — a stale overview would make wildcard expansion and
  // read-modify-write carry operate on objects that no longer exist.
  const overviewRef = useRef<ModelOverview | null>(overview);
  overviewRef.current = overview;

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

  // Written during render, matching this file's existing `connectionIdRef`
  // precedent: the keydown listener is registered once and must not be torn
  // down and rebuilt every time these callbacks change identity.
  undoRef.current = () => void handleUndo();
  redoRef.current = () => void handleRedo();

  const reportError = useCallback((err: unknown) => {
    setError(String(err));
  }, []);

  // The single write path for multi-object edits. A fresh session per run, as
  // the CLI panel does, so wildcard expansion and read-modify-write carry
  // operate on the overview at run entry rather than on a stale capture.
  const cliGateway = useMemo(createLiveGateway, []);
  const runCommand = useCallback(
    async (text: string): Promise<string[]> => {
      const o = overviewRef.current;
      if (!o) throw new Error("No model loaded for this connection.");
      const session = createSession(connectionIdRef.current, o, !o.editable, cliGateway);
      const plan = planRun(text, session);
      const lines: string[] = [];
      const outcome = await executeRun(plan, session, {
        print: (t: string) => lines.push(t),
        clear: () => {
          lines.length = 0;
        },
      });
      if (outcome.overview) applyOverview(outcome.overview);
      if (!outcome.ok) throw new Error(lines.join("\n") || "The command failed.");
      return lines;
    },
    [cliGateway, applyOverview],
  );

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

  // Up/Down/Home/End walk the rail and MOVE the section, matching the ARIA
  // "automatic activation" tabs pattern — the panels are cheap to switch and
  // it is what a keyboard user expects from a vertical tablist. Focus follows
  // so the roving tabindex stays on the item you are standing on.
  const onNavKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      const at = NAV_ORDER.indexOf(active);
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? NAV_ORDER.length - 1
            : e.key === "ArrowDown"
              ? (at + 1) % NAV_ORDER.length
              : (at - 1 + NAV_ORDER.length) % NAV_ORDER.length;
      const id = NAV_ORDER[next];
      navigate(id);
      e.currentTarget.querySelector<HTMLElement>(`[data-nav-item="${id}"]`)?.focus();
    },
    [active, navigate],
  );

  // ── Render ───────────────────────────────────────────────────────────────

  const readOnly = overview ? !overview.editable : true;

  const renderSection = (): React.ReactNode => {
    if (active === "import") {
      return (
        <ImportSection
          connectionId={connectionId}
          overview={overview}
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
      navigate,
      runCommand,
      selection: route.selection,
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
      case "strategy":
        return <StrategySection ctx={ctx} />;
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
        {/* The model-FILE verbs live in here. They were three of seven equal
            buttons, and two of them ("Import…"/"Export…") collided outright
            with the Import SECTION, which imports source TABLES — two
            unrelated meanings of one word inside one chrome. Naming them
            "…Model File…" kills the collision at the point of collision. */}
        <TopBarMenu
          label="Model"
          items={[
            { label: "New Model…", onSelect: () => setShowNewModel(true) },
            {
              label: "Open Model File…",
              disabled: ioBusy,
              title:
                "Import a model from a file (.json / Studio ModelBundle) as a new workbook model",
              onSelect: () => void handleImportModel(),
              separatorBefore: true,
            },
            {
              label: "Save Model Copy…",
              disabled: ioBusy || !connectionId,
              title: "Export this model to a standalone file (it still saves with the workbook)",
              onSelect: () => void handleExportModel(),
            },
          ]}
        />
        <select
          style={{ ...styles.input, fontSize: 12, minWidth: 240 }}
          aria-label="Model"
          data-testid="topbar-connection"
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

        {/* A button that LOOKS like a field. The palette owns the real input,
            so a second live input here would be two places to type with two
            selection models; this is the affordance, not the control. */}
        <button
          type="button"
          style={{
            ...styles.input,
            fontSize: FONT.sm,
            flex: 1,
            maxWidth: 380,
            minWidth: 120,
            textAlign: "left",
            color: ME.text3,
            cursor: "text",
            display: "flex",
            alignItems: "center",
            gap: SPACE.sm,
          }}
          aria-label="Search the model"
          data-testid="topbar-search"
          onClick={() => setPaletteOpen(true)}
        >
          <span aria-hidden="true">⌕</span>
          <span>Search the model…</span>
          <span style={{ marginLeft: "auto", ...TABULAR }}>Ctrl+K</span>
        </button>

        <button
          style={{ ...styles.btn, padding: "4px 9px" }}
          disabled={!undoState.canUndo || readOnly}
          title="Undo the last model edit (Ctrl+Z)"
          aria-label="Undo"
          data-testid="topbar-undo"
          onClick={() => void handleUndo()}
        >
          <span aria-hidden="true">↶</span>
        </button>
        <button
          style={{ ...styles.btn, padding: "4px 9px" }}
          disabled={!undoState.canRedo || readOnly}
          title="Redo (Ctrl+Y)"
          aria-label="Redo"
          data-testid="topbar-redo"
          onClick={() => void handleRedo()}
        >
          <span aria-hidden="true">↷</span>
        </button>
        <button
          style={{
            ...styles.btn,
            ...(showCli ? { background: ACCENT, color: ME.onAccent, borderColor: ACCENT } : {}),
          }}
          title="Toggle the command line panel (Ctrl+`)"
          aria-pressed={showCli}
          data-testid="topbar-cli"
          onClick={toggleCli}
        >
          Command Line
        </button>
        <ProblemsChip
          problems={problems}
          open={problemsOpen}
          onClick={() => setProblemsOpen((v) => !v)}
        />
        <div style={{ flex: 1 }} />
        {macroRecording && (
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: ME.onAccent,
              background: ME.recordingBg,
              borderRadius: 10,
              padding: "2px 10px",
              whiteSpace: "nowrap",
            }}
            title="A macro is being recorded in the main window. Model edits made here are captured into the macro (privileged areas like roles and sources record as not-replayable notes)."
          >
            ● Recording macro
          </span>
        )}
        {loading && <span style={{ ...styles.muted, fontSize: 12 }}>Loading&hellip;</span>}
      </div>

      {overview?.readOnlyReason && (
        <div style={readOnlyBannerStyle}>Read-only: {overview.readOnlyReason}</div>
      )}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* role="tablist" with a roving tabindex: the rail was 20 <div>s with
            no role, no tabindex and no focus ring, so it was mouse-only and
            invisible to a screen reader. Only the active item is tabbable;
            arrows move within the rail, which is the ARIA tabs pattern. */}
        <nav
          style={navStyle}
          role="tablist"
          aria-orientation="vertical"
          aria-label="Model sections"
          data-testid="model-editor-nav"
          onKeyDown={onNavKeyDown}
        >
          {NAV_GROUPS.map((group) => (
            <React.Fragment key={group.title ?? "_"}>
              {group.title && <div style={navGroupTitleStyle}>{group.title}</div>}
              {group.items.map((item) => {
                const isActive = item.id === active;
                const count = overview && item.count ? item.count(overview) : null;
                // A dot on the rail is what makes a problem noticeable without
                // opening anything — the reason the old "Validate model" button
                // on a page you visit once surfaced nothing in practice.
                const severity = sectionSeverity.get(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    aria-current={isActive ? "page" : undefined}
                    tabIndex={isActive ? 0 : -1}
                    data-nav-item={item.id}
                    data-testid={`nav-${item.id}`}
                    style={navItemStyle(isActive)}
                    onClick={() => navigate(item.id)}
                  >
                    <span style={navIconStyle(isActive)}>
                      {React.createElement(NAV_ICONS[item.id])}
                    </span>
                    <span style={navLabelStyle}>{item.label}</span>
                    {severity && (
                      <span
                        aria-label={`${severity} in ${item.label}`}
                        data-testid={`nav-dot-${item.id}`}
                        title={`${severity === "error" ? "Errors" : "Findings"} in ${item.label}`}
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: RADIUS.pill,
                          flexShrink: 0,
                          background:
                            severity === "error"
                              ? ME.dangerFg
                              : severity === "warning"
                                ? ME.warnFg
                                : ME.infoFg,
                        }}
                      />
                    )}
                    {count !== null && <span style={navCountStyle}>{count}</span>}
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </nav>
        <main style={contentStyle}>{renderSection()}</main>
        {showCliRef && <CliReferencePane onClose={toggleCliRef} />}
        {problemsOpen && (
          <ProblemsDrawer
            problems={problems}
            coverage={problemCoverage}
            busy={problemsBusy}
            onNavigate={navigate}
            onRecheck={recheck}
            onClose={() => setProblemsOpen(false)}
          />
        )}
      </div>

      {/* Status strip. The save-location note used to sit in the top bar,
          competing with the action buttons for the eye every time you looked
          for one. It is a persistent FACT about the document, not a control,
          so it belongs at the bottom edge where a status line lives. */}
      <div style={statusStripStyle}>
        <span
          title="Model changes are kept in this workbook and written to disk when you save the workbook (Ctrl+S). There is no separate model file to save."
          data-testid="status-save-location"
        >
          Changes save with the workbook (Ctrl+S)
        </span>
        <div style={{ flex: 1 }} />
        {overview && (
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {overview.tables.length} tables · {overview.measures.length} measures
          </span>
        )}
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
          prefill={cliPrefill}
        />
      )}

      {paletteOpen && (
        <SearchPalette
          overview={overview}
          onNavigate={navigate}
          onRunCommand={(text) => {
            // Hand off, never execute here: `planRun`'s confirmation card for a
            // multi-object write lives in the CLI panel, and a second executor
            // would either skip it or duplicate it.
            prefillNonce.current += 1;
            setCliPrefill({ text, nonce: prefillNonce.current });
            if (!showCli) toggleCli();
          }}
          onClose={() => setPaletteOpen(false)}
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

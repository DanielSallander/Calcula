// FILENAME: app/extensions/ModelEditor/components/CommandPanel.tsx
// PURPOSE: The Model Editor's VSCode-style bottom command panel: a Monaco
//          prompt (history, live completion) or a multi-line script editor, an
//          output log, and a confirmation step for wildcard / multi-object
//          edits. Runs commands through the SAME @api gateway as the visual
//          sections; multi-write runs execute as one undo step via the
//          backend edit batch and roll back wholesale on error.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import type { ModelOverview } from "@api";
import { styles } from "./editorShared";
import { createSession, executeRun, planRun } from "../cli/execute";
import type { CliIo, CliSession, RunPlan } from "../cli/execute";
import { createLiveGateway } from "../cli/gateway";
import { CliError } from "../cli/lex";
import { CLI_LANGUAGE_ID, registerCliLanguage, setCliLanguageContext } from "../cli/cliLanguage";

// Same defensive Monaco worker setup as ExpressionWorkspace (either module may
// load first; never clobber a handler another editor installed).
const prevGetWorker = self.MonacoEnvironment?.getWorker;
self.MonacoEnvironment = {
  getWorker(id: string, label: string) {
    if (prevGetWorker) {
      return prevGetWorker(id, label);
    }
    return new editorWorker();
  },
};
loader.config({ monaco });

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const HEIGHT_KEY = "calcula.modelEditor.cli.height";
const HISTORY_KEY = "calcula.modelEditor.cli.history";
const SCRIPTS_KEY = "calcula.modelEditor.cli.scripts";
const MAX_HISTORY = 100;

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Persistence is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Output log
// ---------------------------------------------------------------------------

type EntryCls = "cmd" | "out" | "err" | "info";

interface LogEntry {
  id: number;
  cls: EntryCls;
  text: string;
}

const ENTRY_COLOR: Record<EntryCls, string> = {
  cmd: "#0b5cad",
  out: "#222",
  err: "#b3261e",
  info: "#6b7280",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface PendingRun {
  plan: RunPlan;
  session: CliSession;
}

export interface CommandPanelProps {
  connectionId: string;
  overview: ModelOverview | null;
  readOnly: boolean;
  /** Install a fresh overview in the app after a run changed the model. */
  onApplyOverview: (o: ModelOverview) => void;
  onClose: () => void;
}

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 600;

export function CommandPanel({
  connectionId,
  overview,
  readOnly,
  onApplyOverview,
  onClose,
}: CommandPanelProps): React.ReactElement {
  const [height, setHeight] = useState<number>(() =>
    Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, loadJson(HEIGHT_KEY, 220))),
  );
  const [mode, setMode] = useState<"prompt" | "script">("prompt");
  const [promptText, setPromptText] = useState("");
  const [scriptText, setScriptText] = useState("");
  const [entries, setEntries] = useState<LogEntry[]>([
    { id: 0, cls: "info", text: "Model Editor command line — type 'help' to get started." },
  ]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingRun | null>(null);
  const [scripts, setScripts] = useState<Record<string, string>>(() => loadJson(SCRIPTS_KEY, {}));
  const [selectedScript, setSelectedScript] = useState("");

  const nextId = useRef(1);
  const outputRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const promptModeKey = useRef<monaco.editor.IContextKey<boolean> | null>(null);
  const gateway = useMemo(createLiveGateway, []);

  // History (prompt mode): ↑/↓ cycles; the in-progress draft is kept.
  const history = useRef<string[]>(loadJson(HISTORY_KEY, []));
  const historyIdx = useRef<number>(-1);
  const draft = useRef("");

  // Live refs so Monaco commands (registered once) see current state.
  const stateRef = useRef({ mode, promptText, busy, connectionId, overview, readOnly });
  stateRef.current = { mode, promptText, busy, connectionId, overview, readOnly };

  useEffect(() => setCliLanguageContext(overview), [overview]);
  useEffect(() => saveJson(HEIGHT_KEY, height), [height]);

  const pushEntry = useCallback((cls: EntryCls, text: string) => {
    setEntries((prev) => [...prev, { id: nextId.current++, cls, text }]);
  }, []);

  // Follow the output tail.
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, pending]);

  const io: CliIo = useMemo(
    () => ({
      print: (text, cls) => pushEntry(cls ?? "out", text),
      clear: () => setEntries([]),
    }),
    [pushEntry],
  );

  const execute = useCallback(
    async (plan: RunPlan, session: CliSession) => {
      setBusy(true);
      try {
        const outcome = await executeRun(plan, session, io);
        if (outcome.overview) onApplyOverview(outcome.overview);
      } finally {
        setBusy(false);
      }
    },
    [io, onApplyOverview],
  );

  const run = useCallback(
    (text: string) => {
      const st = stateRef.current;
      if (st.busy || text.trim() === "") return;
      setPending(null);
      pushEntry("cmd", text.trim());
      if (st.mode === "prompt") {
        history.current = [...history.current.filter((h) => h !== text), text].slice(-MAX_HISTORY);
        saveJson(HISTORY_KEY, history.current);
        historyIdx.current = -1;
        setPromptText("");
      }
      if (!st.overview) {
        pushEntry("err", "No model loaded for this connection.");
        return;
      }
      const session = createSession(st.connectionId, st.overview, st.readOnly, gateway);
      let plan: RunPlan;
      try {
        plan = planRun(text, session);
      } catch (e) {
        const line = e instanceof CliError && e.line !== null ? `line ${e.line}: ` : "";
        pushEntry("err", `${line}${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (plan.needsConfirm) {
        setPending({ plan, session });
        return;
      }
      void execute(plan, session);
    },
    [execute, gateway, pushEntry],
  );

  const runRef = useRef(run);
  runRef.current = run;

  // ── History navigation ────────────────────────────────────────────────────

  const historyStep = useCallback((dir: -1 | 1) => {
    const h = history.current;
    if (h.length === 0) return;
    if (historyIdx.current === -1) {
      if (dir === 1) return;
      draft.current = stateRef.current.promptText;
      historyIdx.current = h.length - 1;
    } else {
      const next = historyIdx.current + dir;
      if (next >= h.length) {
        historyIdx.current = -1;
        setPromptText(draft.current);
        return;
      }
      historyIdx.current = Math.max(0, next);
    }
    const text = h[historyIdx.current];
    setPromptText(text);
    // Cursor to the end after the controlled value lands.
    requestAnimationFrame(() => {
      const ed = editorRef.current;
      if (ed) {
        const model = ed.getModel();
        if (model) {
          const last = model.getLineCount();
          ed.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
        }
      }
    });
  }, []);

  // ── Monaco wiring ─────────────────────────────────────────────────────────

  const handleMount: OnMount = useCallback(
    (editor) => {
      editorRef.current = editor;
      promptModeKey.current = editor.createContextKey<boolean>("cliPromptMode", true);
      editor.addCommand(
        monaco.KeyCode.Enter,
        () => runRef.current(editor.getValue()),
        "cliPromptMode && !suggestWidgetVisible",
      );
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
        () => runRef.current(editor.getValue()),
      );
      editor.addCommand(
        monaco.KeyCode.UpArrow,
        () => historyStep(-1),
        "cliPromptMode && !suggestWidgetVisible",
      );
      editor.addCommand(
        monaco.KeyCode.DownArrow,
        () => historyStep(1),
        "cliPromptMode && !suggestWidgetVisible",
      );
      editor.focus();
    },
    [historyStep],
  );

  useEffect(() => {
    promptModeKey.current?.set(mode === "prompt");
    editorRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    registerCliLanguage();
  }, []);

  // ── Resize handle ─────────────────────────────────────────────────────────

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = height;
      const move = (ev: MouseEvent): void => {
        setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startH + (startY - ev.clientY))));
      };
      const up = (): void => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [height],
  );

  // ── Saved scripts ─────────────────────────────────────────────────────────

  const saveScript = useCallback(() => {
    const name = window.prompt("Script name:", selectedScript || "my-script");
    if (!name) return;
    const next = { ...scripts, [name]: scriptText };
    setScripts(next);
    setSelectedScript(name);
    saveJson(SCRIPTS_KEY, next);
  }, [scripts, scriptText, selectedScript]);

  const loadScript = useCallback(
    (name: string) => {
      setSelectedScript(name);
      if (name && scripts[name] !== undefined) setScriptText(scripts[name]);
    },
    [scripts],
  );

  const deleteScript = useCallback(() => {
    if (!selectedScript || !window.confirm(`Delete saved script '${selectedScript}'?`)) return;
    const next = { ...scripts };
    delete next[selectedScript];
    setScripts(next);
    setSelectedScript("");
    saveJson(SCRIPTS_KEY, next);
  }, [scripts, selectedScript]);

  // ── Render ────────────────────────────────────────────────────────────────

  const editorOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
    minimap: { enabled: false },
    lineNumbers: mode === "script" ? "on" : "off",
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: 4,
    lineNumbersMinChars: 3,
    renderLineHighlight: "none",
    scrollBeyondLastLine: false,
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    wordWrap: mode === "script" ? "on" : "off",
    fontSize: 12,
    fontFamily: "Consolas, 'Courier New', monospace",
    scrollbar: { vertical: mode === "script" ? "auto" : "hidden", horizontal: "hidden" },
    fixedOverflowWidgets: true,
    automaticLayout: true,
    suggest: { showWords: false },
    quickSuggestions: { other: true, strings: false, comments: false },
    tabCompletion: "on",
  };

  return (
    <div
      style={{
        height,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        borderTop: "1px solid #ccc",
        background: "#fff",
        minHeight: 0,
      }}
    >
      <div
        onMouseDown={onDragStart}
        title="Drag to resize"
        style={{ height: 4, cursor: "ns-resize", background: "transparent", flexShrink: 0 }}
      />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "2px 8px 4px 10px",
          borderBottom: "1px solid #eee",
          flexShrink: 0,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 12 }}>Command Line</span>
        <div style={{ display: "flex", border: "1px solid #ccc", borderRadius: 3, overflow: "hidden" }}>
          {(["prompt", "script"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                border: "none",
                padding: "2px 10px",
                fontSize: 11,
                cursor: "pointer",
                background: mode === m ? "#0b5cad" : "#f4f5f7",
                color: mode === m ? "#fff" : "#333",
              }}
            >
              {m === "prompt" ? "Prompt" : "Script"}
            </button>
          ))}
        </div>
        {mode === "script" && (
          <>
            <button
              style={styles.btn}
              disabled={busy || scriptText.trim() === ""}
              title="Run the whole script (Ctrl+Enter)"
              onClick={() => run(scriptText)}
            >
              Run
            </button>
            <select
              style={{ ...styles.input, fontSize: 11, maxWidth: 160 }}
              value={selectedScript}
              onChange={(e) => loadScript(e.target.value)}
              title="Saved scripts (stored on this machine)"
            >
              <option value="">— saved scripts —</option>
              {Object.keys(scripts)
                .sort()
                .map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
            </select>
            <button style={styles.btn} onClick={saveScript} title="Save the script text under a name">
              Save…
            </button>
            <button style={styles.btn} disabled={!selectedScript} onClick={deleteScript}>
              Delete
            </button>
          </>
        )}
        {readOnly && <span style={{ fontSize: 11, color: "#7a5b00" }}>read-only model — edits disabled</span>}
        <div style={{ flex: 1 }} />
        {busy && <span style={{ fontSize: 11, color: "#6b7280" }}>Running…</span>}
        <button style={styles.btn} onClick={() => setEntries([])} title="Clear the output log">
          Clear
        </button>
        <button style={styles.btn} onClick={onClose} title="Close the panel (Ctrl+`)">
          ✕
        </button>
      </div>

      <div
        ref={outputRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "4px 10px",
          fontFamily: "Consolas, 'Courier New', monospace",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        {entries.map((e) => (
          <pre
            key={e.id}
            style={{
              margin: "1px 0",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: ENTRY_COLOR[e.cls],
              fontWeight: e.cls === "cmd" ? 600 : 400,
            }}
          >
            {e.cls === "cmd" ? "> " + e.text : e.text}
          </pre>
        ))}
        {pending && (
          <div
            style={{
              margin: "4px 0",
              padding: "6px 8px",
              border: "1px solid #e0c060",
              borderRadius: 3,
              background: "#fff9e8",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              This run makes {pending.plan.writeLabels.length} edit
              {pending.plan.writeLabels.length === 1 ? "" : "s"}
              {pending.plan.writeLabels.length > 1 ? " (one undo step, all-or-nothing)" : ""}:
            </div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>
              {pending.plan.writeLabels.slice(0, 40).join("\n")}
              {pending.plan.writeLabels.length > 40
                ? `\n… and ${pending.plan.writeLabels.length - 40} more`
                : ""}
            </pre>
            <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
              <button
                style={{ ...styles.btn, background: "#0b5cad", color: "#fff" }}
                disabled={busy}
                onClick={() => {
                  const p = pending;
                  setPending(null);
                  if (p) void execute(p.plan, p.session);
                }}
              >
                Run
              </button>
              <button
                style={styles.btn}
                onClick={() => {
                  setPending(null);
                  pushEntry("info", "Cancelled.");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div
        style={{
          flexShrink: 0,
          borderTop: "1px solid #eee",
          display: "flex",
          alignItems: "stretch",
          gap: 0,
          height: mode === "script" ? 150 : 30,
        }}
      >
        <span
          style={{
            width: 22,
            display: "flex",
            alignItems: mode === "script" ? "flex-start" : "center",
            justifyContent: "center",
            paddingTop: mode === "script" ? 6 : 0,
            color: "#0b5cad",
            fontFamily: "Consolas, monospace",
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          {">"}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Editor
            language={CLI_LANGUAGE_ID}
            value={mode === "prompt" ? promptText : scriptText}
            onChange={(v) => (mode === "prompt" ? setPromptText(v ?? "") : setScriptText(v ?? ""))}
            onMount={handleMount}
            options={editorOptions}
            height="100%"
          />
        </div>
      </div>
    </div>
  );
}

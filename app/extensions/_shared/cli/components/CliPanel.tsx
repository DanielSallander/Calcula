// FILENAME: app/extensions/_shared/cli/components/CliPanel.tsx
// PURPOSE: THE command panel of the fused CLI, shared by both windows: a
//          Monaco prompt (history, live completion) or a multi-line script
//          editor, an output log, and a confirmation step for wildcard /
//          multi-object runs. Domain-blind — a CliPanelDriver supplies
//          planning/execution and the Monaco language; the wrappers
//          (ModelEditor CommandPanel, main-window AppCliPanel) supply the
//          window-specific session/engine lifecycle and storage prefix.
// CONTEXT: Generalized VERBATIM from the Model Editor's CommandPanel (the
//          proven design); its visuals and keybindings are unchanged.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { enforceLfLineEndings } from "../../lib/monacoLineEndings";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { confirmAsync, promptAsync } from "@api/dialogs";
import { CliError } from "../lex";
import type { CliIo } from "../registry";
import { applyModelEditorTheme as applyCalculaMonacoTheme } from "../../lib/monacoTheme";

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
// Stored text is LF on every platform. Monaco defaults a model created from
// EMPTY text to the OS ending (CRLF here), and @monaco-editor/react creates the
// model before an async document arrives — see _shared/lib/monacoLineEndings.ts.
enforceLfLineEndings(monaco);

// ---------------------------------------------------------------------------
// Driver contract
// ---------------------------------------------------------------------------

/** One planned run, ready to execute. */
export interface CliPanelPlan {
  writeLabels: string[];
  needsConfirm: boolean;
  /** Confirm-card wording for a batched run ("one undo step, …"), or null. */
  confirmNote: string | null;
  execute(io: CliIo): Promise<void>;
}

/** What a window supplies to host the panel. */
export interface CliPanelDriver {
  /** Monaco language id (registered by the wrapper via registerCliLanguage). */
  languageId: string;
  /** localStorage key prefix, e.g. "calcula.modelEditor.cli" — the model
   *  editor's historical keys keep users' history/scripts. */
  storagePrefix: string;
  /** First log line shown on mount. */
  banner: string;
  /** Non-null shows the read-only chip and its wording. */
  readOnlyNote: string | null;
  /** Plan a run. Throws CliError (with line) on parse/lookup errors. */
  plan(text: string): CliPanelPlan;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

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
  cmd: "var(--tone-info-fg, #0b5cad)",
  out: "var(--text-primary, #222)",
  err: "var(--tone-danger-fg, #b3261e)",
  info: "var(--text-secondary, #6b7280)",
};

const BTN: React.CSSProperties = {
  border: `1px solid ${"var(--border-default, #ccc)"}`,
  background: "var(--panel-bg, #f4f5f7)",
  borderRadius: 3,
  padding: "2px 10px",
  fontSize: 11,
  cursor: "pointer",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface CliPanelProps {
  driver: CliPanelDriver;
  onClose: () => void;
  /** Optional reference-pane toggle (the model editor has one). */
  referenceOpen?: boolean;
  onToggleReference?: () => void;
  /** Extra header content (e.g. the main window's connection picker). */
  headerExtra?: React.ReactNode;
  /** Title shown in the close button's tooltip ("Ctrl+`", "Ctrl+Shift+P"). */
  closeShortcut?: string;
  /**
   * Text to drop into the prompt from outside — the Model Editor's search
   * palette hands a typed command over rather than executing it itself, so
   * there stays exactly ONE executor and one confirmation card for a
   * multi-object write.
   *
   * Carries a `nonce` because the same text handed over twice must still land:
   * comparing the string alone would silently swallow the second attempt.
   * Optional, so the main window's Command Line is unaffected.
   */
  prefill?: { text: string; nonce: number } | null;
}

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 600;

export function CliPanel({
  driver,
  onClose,
  referenceOpen,
  onToggleReference,
  headerExtra,
  closeShortcut,
  prefill,
}: CliPanelProps): React.ReactElement {
  const HEIGHT_KEY = `${driver.storagePrefix}.height`;
  const HISTORY_KEY = `${driver.storagePrefix}.history`;
  const SCRIPTS_KEY = `${driver.storagePrefix}.scripts`;

  const [height, setHeight] = useState<number>(() =>
    Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, loadJson(HEIGHT_KEY, 220))),
  );
  const [mode, setMode] = useState<"prompt" | "script">("prompt");
  const [promptText, setPromptText] = useState("");
  const [scriptText, setScriptText] = useState("");
  const [entries, setEntries] = useState<LogEntry[]>([
    { id: 0, cls: "info", text: driver.banner },
  ]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<CliPanelPlan | null>(null);
  const [scripts, setScripts] = useState<Record<string, string>>(() => loadJson(SCRIPTS_KEY, {}));
  const [selectedScript, setSelectedScript] = useState("");

  const nextId = useRef(1);
  const outputRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const promptModeKey = useRef<monaco.editor.IContextKey<boolean> | null>(null);

  // History (prompt mode): ↑/↓ cycles; the in-progress draft is kept.
  const history = useRef<string[]>(loadJson(HISTORY_KEY, []));
  const historyIdx = useRef<number>(-1);
  const draft = useRef("");

  // Live refs so Monaco commands (registered once) see current state.
  const stateRef = useRef({ mode, promptText, busy, driver });
  stateRef.current = { mode, promptText, busy, driver };

  // Adopt an externally handed-over command at RENDER time (this config bans
  // setState inside an effect). It switches to prompt mode deliberately: a
  // handed-over line is a single command, and dropping it into a script buffer
  // would bury it under whatever was already there.
  const lastPrefill = useRef<number>(-1);
  if (prefill && prefill.nonce !== lastPrefill.current) {
    lastPrefill.current = prefill.nonce;
    setMode("prompt");
    setPromptText(prefill.text);
  }

  // Focusing is a DOM effect, not state, so it belongs in one.
  useEffect(() => {
    if (!prefill) return;
    const ed = editorRef.current;
    if (!ed) return;
    ed.focus();
    const model = ed.getModel();
    if (model) ed.setPosition(model.getFullModelRange().getEndPosition());
  }, [prefill]);

  useEffect(() => saveJson(HEIGHT_KEY, height), [HEIGHT_KEY, height]);

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
    async (plan: CliPanelPlan) => {
      setBusy(true);
      try {
        await plan.execute(io);
      } finally {
        setBusy(false);
      }
    },
    [io],
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
      let plan: CliPanelPlan;
      try {
        plan = st.driver.plan(text);
      } catch (e) {
        const line = e instanceof CliError && e.line !== null ? `line ${e.line}: ` : "";
        pushEntry("err", `${line}${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (plan.needsConfirm) {
        setPending(plan);
        return;
      }
      void execute(plan);
    },
    [HISTORY_KEY, execute, pushEntry],
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
    (editor, monacoApi) => {
      // The panel ran the stock light "vs" theme, so a dark window had a
      // brilliant white prompt sitting in it. Shared with the main window, so
      // this fixes both command lines at once.
      applyCalculaMonacoTheme(monacoApi);
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

  const saveScript = useCallback(async () => {
    const name = await promptAsync("Script name:", {
      title: "Save script",
      defaultValue: selectedScript || "my-script",
    });
    if (!name) return;
    const next = { ...scripts, [name]: scriptText };
    setScripts(next);
    setSelectedScript(name);
    saveJson(SCRIPTS_KEY, next);
  }, [SCRIPTS_KEY, scripts, scriptText, selectedScript]);

  const loadScript = useCallback(
    (name: string) => {
      setSelectedScript(name);
      if (name && scripts[name] !== undefined) setScriptText(scripts[name]);
    },
    [scripts],
  );

  const deleteScript = useCallback(async () => {
    if (!selectedScript) return;
    if (!(await confirmAsync(`Delete saved script '${selectedScript}'?`))) return;
    const next = { ...scripts };
    delete next[selectedScript];
    setScripts(next);
    setSelectedScript("");
    saveJson(SCRIPTS_KEY, next);
  }, [SCRIPTS_KEY, scripts, selectedScript]);

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
        borderTop: `1px solid ${"var(--border-default, #ccc)"}`,
        background: "var(--bg-surface, #ffffff)",
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
        <div style={{ display: "flex", border: `1px solid ${"var(--border-default, #ccc)"}`, borderRadius: 3, overflow: "hidden" }}>
          {(["prompt", "script"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                border: "none",
                padding: "2px 10px",
                fontSize: 11,
                cursor: "pointer",
                background: mode === m ? "var(--tone-info-fg, #0b5cad)" : "var(--panel-bg, #f4f5f7)",
                color: mode === m ? "var(--bg-surface, #ffffff)" : "var(--text-primary, #333)",
              }}
            >
              {m === "prompt" ? "Prompt" : "Script"}
            </button>
          ))}
        </div>
        {mode === "script" && (
          <>
            <button
              style={BTN}
              disabled={busy || scriptText.trim() === ""}
              title="Run the whole script (Ctrl+Enter)"
              onClick={() => run(scriptText)}
            >
              Run
            </button>
            <select
              style={{ ...BTN, cursor: "auto", maxWidth: 160 }}
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
            <button style={BTN} onClick={() => void saveScript()} title="Save the script text under a name">
              Save…
            </button>
            <button style={BTN} disabled={!selectedScript} onClick={() => void deleteScript()}>
              Delete
            </button>
          </>
        )}
        {driver.readOnlyNote && (
          <span style={{ fontSize: 11, color: "var(--tone-warn-fg, #7a5b00)" }}>{driver.readOnlyNote}</span>
        )}
        {headerExtra}
        <div style={{ flex: 1 }} />
        {busy && <span style={{ fontSize: 11, color: "var(--text-secondary, #6b7280)" }}>Running…</span>}
        {onToggleReference && (
          <button
            style={{ ...BTN, ...(referenceOpen ? { background: "var(--tone-info-fg, #0b5cad)", color: "var(--bg-surface, #ffffff)" } : {}) }}
            onClick={onToggleReference}
            title="Open the full command reference guide in a side pane"
          >
            Reference
          </button>
        )}
        <button style={BTN} onClick={() => setEntries([])} title="Clear the output log">
          Clear
        </button>
        <button
          style={BTN}
          onClick={onClose}
          title={closeShortcut ? `Close the panel (${closeShortcut})` : "Close the panel"}
        >
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
              background: "var(--tone-warn-bg, #fff9e8)",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              This run makes {pending.writeLabels.length} edit
              {pending.writeLabels.length === 1 ? "" : "s"}
              {pending.confirmNote ? ` (${pending.confirmNote})` : ""}:
            </div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>
              {pending.writeLabels.slice(0, 40).join("\n")}
              {pending.writeLabels.length > 40
                ? `\n… and ${pending.writeLabels.length - 40} more`
                : ""}
            </pre>
            <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
              <button
                style={{ ...BTN, background: "var(--tone-info-fg, #0b5cad)", color: "var(--bg-surface, #ffffff)" }}
                disabled={busy}
                onClick={() => {
                  const p = pending;
                  setPending(null);
                  if (p) void execute(p);
                }}
              >
                Run
              </button>
              <button
                style={BTN}
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
            color: "var(--tone-info-fg, #0b5cad)",
            fontFamily: "Consolas, monospace",
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          {">"}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Editor
            language={driver.languageId}
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

//! FILENAME: app/extensions/CommandLine/components/AppCliPanel.tsx
// PURPOSE: The main-window CLI panel — a bottom-docked strip with an output
//          log, a one-line prompt (history + Tab completion) and the
//          multi-write confirmation card. Drives the shared CLI engine with
//          the APP domain; deliberately Monaco-free (the grid window's panel
//          stays light — the Model Editor keeps its Monaco panel).
// CONTEXT: Registered through the dialog service; renders nothing while
//          closed. Storage keys are calcula.app.cli.* (the model editor's
//          calcula.modelEditor.cli.* keys are untouched).

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { hideDialog, showDialog } from "@api";
import { createCliEngine } from "../../_shared/cli/engine";
import type { CliEngine, RunPlan } from "../../_shared/cli/engine";
import { CliError } from "../../_shared/cli/lex";
import type { CliIo } from "../../_shared/cli/registry";
import { createAppDomain } from "../cli/appDomain";
import { createAppCliSession } from "../cli/appSession";
import type { AppCliSession } from "../cli/appSession";
import { createLiveAppGateway } from "../cli/appGateway";

const DIALOG_ID = "command-line-panel";
const HISTORY_KEY = "calcula.app.cli.history";
const MAX_HISTORY = 100;

// ---------------------------------------------------------------------------
// Open/close toggle (used by the command + keybinding + menu item)
// ---------------------------------------------------------------------------

let panelOpen = false;

export function toggleAppCliPanel(): void {
  if (panelOpen) hideDialog(DIALOG_ID);
  else showDialog(DIALOG_ID);
}

// ---------------------------------------------------------------------------
// Log model
// ---------------------------------------------------------------------------

interface LogEntry {
  text: string;
  cls: "out" | "err" | "info" | "cmd";
}

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveHistory(history: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-MAX_HISTORY)));
  } catch {
    // Best-effort persistence.
  }
}

// ---------------------------------------------------------------------------
// Completion (lightweight positional: verbs, kinds, then live names)
// ---------------------------------------------------------------------------

function suggestionsFor(engine: CliEngine, session: AppCliSession, input: string): string[] {
  // Only complete the simple single-line prefix case; anything after an
  // option assignment or a formula tail is left alone.
  if (input.includes("=")) return [];
  const parts = input.split(/\s+/);
  const current = parts[parts.length - 1] ?? "";
  const wordIndex = parts.length - 1;
  const vocab = engine.parser.vocabulary;
  const lc = current.toLowerCase();

  if (wordIndex === 0) {
    return vocab.verbs.filter((v) => v.startsWith(lc) && v !== current).slice(0, 8);
  }
  const verb = vocab.verbAliases[parts[0].toLowerCase()];
  if (!verb) return [];
  if (wordIndex === 1 && !vocab.kindless.has(verb)) {
    return vocab.kinds.filter((k) => k.startsWith(lc) && k !== current).slice(0, 8);
  }
  // Word ≥ 2: live object names for the named kind.
  const kind = engine.parser.normalizeKind(parts[1] ?? "");
  if (!kind) return [];
  const spec = engine.bindings
    .flatMap((b) => b.domain.kinds)
    .find((k) => k.kind === kind);
  const names = spec?.nameSuggestions?.(session) ?? [];
  return names
    .map((n) => n.insert)
    .filter((n) => n.toLowerCase().startsWith(lc) && n !== current)
    .slice(0, 8);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function AppCliPanel(props: { isOpen: boolean; onClose: () => void }): React.ReactElement | null {
  const { isOpen, onClose } = props;

  const [log, setLog] = useState<LogEntry[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<RunPlan | null>(null);
  const [running, setRunning] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // One session+engine per mount; the session's caches refresh on open and
  // after every run so completion stays live.
  const sessionRef = useRef<AppCliSession | null>(null);
  const engineRef = useRef<CliEngine | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = createAppCliSession(createLiveAppGateway());
    engineRef.current = createCliEngine(
      [{ domain: createAppDomain(), session: sessionRef.current }],
      "app",
    );
  }
  const session = sessionRef.current;
  const engine = engineRef.current!;

  useEffect(() => {
    panelOpen = isOpen;
    if (isOpen) {
      void session.refresh();
      inputRef.current?.focus();
    }
  }, [isOpen, session]);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  const io: CliIo = useMemo(
    () => ({
      print(text, cls) {
        setLog((prev) => [...prev, { text, cls: cls ?? "out" }]);
      },
      clear() {
        setLog([]);
      },
    }),
    [],
  );

  const execute = useCallback(
    async (plan: RunPlan): Promise<void> => {
      setRunning(true);
      try {
        await engine.executeRun(plan, io);
      } finally {
        setRunning(false);
        void session.refresh();
        inputRef.current?.focus();
      }
    },
    [engine, io, session],
  );

  const run = useCallback(
    (text: string): void => {
      const trimmed = text.trim();
      if (trimmed === "" || running) return;
      setLog((prev) => [...prev, { text: `> ${trimmed}`, cls: "cmd" }]);
      setHistory((prev) => {
        const next = [...prev.filter((h) => h !== trimmed), trimmed].slice(-MAX_HISTORY);
        saveHistory(next);
        return next;
      });
      setHistoryIndex(null);
      setInput("");
      try {
        const plan = engine.planRun(trimmed);
        if (plan.needsConfirm) {
          setPending(plan);
          return;
        }
        void execute(plan);
      } catch (e) {
        const line = e instanceof CliError && e.line !== null ? `line ${e.line}: ` : "";
        io.print(`Error — ${line}${e instanceof Error ? e.message : String(e)}`, "err");
      }
    },
    [engine, execute, io, running],
  );

  const suggestions = useMemo(
    () => (input.trim() === "" || pending ? [] : suggestionsFor(engine, session, input)),
    [engine, session, input, pending],
  );

  const acceptSuggestion = useCallback(
    (s: string): void => {
      const parts = input.split(/(\s+)/); // keep separators
      // Replace the last non-space chunk with the suggestion.
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].trim() !== "") {
          parts[i] = s;
          break;
        }
      }
      setInput(parts.join("") + " ");
      inputRef.current?.focus();
    },
    [input],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === "Enter") {
        e.preventDefault();
        run(input);
        return;
      }
      if (e.key === "Tab" && suggestions.length > 0) {
        e.preventDefault();
        acceptSuggestion(suggestions[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (pending) setPending(null);
        else onClose();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHistoryIndex((prev) => {
          const next = prev === null ? history.length - 1 : Math.max(0, prev - 1);
          if (prev === null) setDraft(input);
          if (next >= 0 && history[next] !== undefined) setInput(history[next]);
          return next;
        });
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHistoryIndex((prev) => {
          if (prev === null) return null;
          const next = prev + 1;
          if (next >= history.length) {
            setInput(draft);
            return null;
          }
          setInput(history[next]);
          return next;
        });
      }
    },
    [acceptSuggestion, draft, history, input, onClose, pending, run, suggestions],
  );

  if (!isOpen) return null;

  return (
    <div style={styles.strip}>
      <div style={styles.header}>
        <span style={styles.title}>Command Line</span>
        <span style={styles.hint}>
          Enter runs · Tab completes · Up/Down history · type &quot;help&quot; to start
        </span>
        <div style={{ flex: 1 }} />
        <button style={styles.headerBtn} onClick={() => io.clear()} title="Clear the output log">
          Clear
        </button>
        <button style={styles.headerBtn} onClick={onClose} title="Close (Ctrl+Shift+P)">
          ×
        </button>
      </div>

      <div ref={logRef} style={styles.log}>
        {log.length === 0 && (
          <div style={styles.empty}>
            Try: <code>ls sheets</code> · <code>set cell B2 = =SUM(A:A)</code> ·{" "}
            <code>add sheet Report</code> · <code>goto Report!A1</code> · <code>help</code>
          </div>
        )}
        {log.map((entry, i) => (
          <pre key={i} style={{ ...styles.entry, ...clsStyle[entry.cls] }}>
            {entry.text}
          </pre>
        ))}
      </div>

      {pending && (
        <div style={styles.confirm}>
          <div style={styles.confirmTitle}>
            This run makes {pending.writeLabels.length} change
            {pending.writeLabels.length === 1 ? "" : "s"}
            {pending.confirmNote ? ` (${pending.confirmNote})` : ""}:
          </div>
          <ul style={styles.confirmList}>
            {pending.writeLabels.slice(0, 40).map((label, i) => (
              <li key={i}>{label}</li>
            ))}
            {pending.writeLabels.length > 40 && (
              <li>…and {pending.writeLabels.length - 40} more</li>
            )}
          </ul>
          <div style={styles.confirmButtons}>
            <button
              style={styles.runBtn}
              onClick={() => {
                const plan = pending;
                setPending(null);
                void execute(plan);
              }}
            >
              Run
            </button>
            <button style={styles.headerBtn} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {suggestions.length > 0 && !pending && (
        <div style={styles.suggestions}>
          {suggestions.map((s) => (
            <button key={s} style={styles.chip} onClick={() => acceptSuggestion(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      <div style={styles.promptRow}>
        <span style={styles.promptMark}>&gt;</span>
        <input
          ref={inputRef}
          style={styles.input}
          value={input}
          disabled={running || pending !== null}
          placeholder={running ? "Running…" : "Type a command (help for the guide)"}
          onChange={(e) => {
            setInput(e.target.value);
            setHistoryIndex(null);
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles (bottom-docked strip above the status bar)
// ---------------------------------------------------------------------------

const MONO = "Consolas, 'Cascadia Mono', monospace";

const styles: Record<string, React.CSSProperties> = {
  strip: {
    position: "fixed",
    left: 0,
    right: 0,
    bottom: 26,
    height: 280,
    display: "flex",
    flexDirection: "column",
    background: "#ffffff",
    borderTop: "1px solid #c8c8c8",
    boxShadow: "0 -2px 8px rgba(0,0,0,0.08)",
    zIndex: 900,
    fontSize: 12,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "4px 8px",
    borderBottom: "1px solid #e4e4e4",
    background: "#f7f7f7",
  },
  title: { fontWeight: 600 },
  hint: { color: "#888" },
  headerBtn: {
    border: "1px solid #d0d0d0",
    background: "#fff",
    borderRadius: 3,
    padding: "1px 8px",
    cursor: "pointer",
    fontSize: 12,
  },
  runBtn: {
    border: "1px solid #2b6cb0",
    background: "#2b6cb0",
    color: "#fff",
    borderRadius: 3,
    padding: "2px 14px",
    cursor: "pointer",
    fontSize: 12,
  },
  log: { flex: 1, overflow: "auto", padding: "4px 8px", fontFamily: MONO },
  empty: { color: "#999", padding: 8 },
  entry: { margin: 0, whiteSpace: "pre-wrap", fontFamily: MONO, lineHeight: 1.45 },
  confirm: {
    borderTop: "1px solid #e4c96b",
    background: "#fdf6df",
    padding: "6px 10px",
    maxHeight: 140,
    overflow: "auto",
  },
  confirmTitle: { fontWeight: 600, marginBottom: 4 },
  confirmList: { margin: "0 0 6px 18px", padding: 0 },
  confirmButtons: { display: "flex", gap: 8 },
  suggestions: {
    display: "flex",
    gap: 6,
    padding: "3px 8px",
    borderTop: "1px solid #eee",
    flexWrap: "wrap",
  },
  chip: {
    border: "1px solid #cfd8e3",
    background: "#eef3f9",
    borderRadius: 10,
    padding: "0 8px",
    cursor: "pointer",
    fontFamily: MONO,
    fontSize: 12,
  },
  promptRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 8px",
    borderTop: "1px solid #e4e4e4",
  },
  promptMark: { fontFamily: MONO, color: "#2b6cb0", fontWeight: 700 },
  input: {
    flex: 1,
    border: "none",
    outline: "none",
    fontFamily: MONO,
    fontSize: 13,
    background: "transparent",
  },
};

const clsStyle: Record<LogEntry["cls"], React.CSSProperties> = {
  out: {},
  err: { color: "#b3261e" },
  info: { color: "#666", fontStyle: "italic" },
  cmd: { color: "#2b6cb0", fontWeight: 600 },
};

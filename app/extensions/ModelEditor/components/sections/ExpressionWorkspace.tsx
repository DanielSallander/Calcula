// FILENAME: app/extensions/ModelEditor/components/sections/ExpressionWorkspace.tsx
// PURPOSE: The shared "editor front-and-centre" workspace used by every model
//          expression editor (measures, calculated tables, calculation-group
//          items): a Monaco editor flanked by two collapsible / resizable /
//          swappable side blades — the model's tables & columns tree and the
//          function reference. The blade arrangement persists in localStorage
//          and is shared by all editors, so the workspace feels like ONE
//          surface everywhere.
//
//   ┌──────────┬────────────────────────────────────────┬──────────┐
//   │ Tables & │        Expression editor (fills)       │ Function │
//   │ columns  │                                        │ reference│
//   │ (blade)  │                                        │ (blade)  │
//   └──────────┴────────────────────────────────────────┴──────────┘

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import type { FunctionDocDto, ModelOverview } from "@api";
import { biModelFunctionCatalog, biModelFunctionDocs } from "@api";
import { styles } from "../editorShared";
import { Chevron } from "../treeKit";
import { FunctionDocsPanel } from "./FunctionDocsPanel";
import {
  MEASURE_LANGUAGE_ID,
  registerMeasureLanguage,
  setMeasureLanguageContext,
} from "../../lib/measureLanguage";

// Preserve any prior worker handler so this editor never clobbers another
// Monaco setup living in the same window.
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

const MARKER_OWNER = "calcula-model-expression-editor";

// Window-lifetime cache of the engine's function docs — they are embedded at
// engine BUILD time, so one fetch per window is enough.
let docsCache: FunctionDocDto[] | null = null;

/** The engine reports parse positions as UTF-8 BYTE offsets; Monaco's
 * getPositionAt wants UTF-16 code-unit offsets. Diverges on non-ASCII
 * (å/ä/ö in table or measure names would misplace the marker). */
function byteToUtf16Offset(text: string, byteOffset: number): number {
  return new TextDecoder().decode(new TextEncoder().encode(text).subarray(0, byteOffset)).length;
}

// ===========================================================================
// Blade layout (collapsible / resizable / swappable side panes) + persistence
// ===========================================================================

type BladeSide = "left" | "right";

interface BladeLayout {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  leftWidth: number;
  rightWidth: number;
  /** false = tree on the left / docs on the right (the default). */
  swapped: boolean;
}

// One arrangement shared by ALL model-expression editors (measures,
// calculated tables, calculation groups) — moving a blade in one editor
// moves it everywhere.
const LAYOUT_KEY = "calcula.modelEditor.workspace.layout.v2";
const LEFT_MIN = 160;
const LEFT_MAX = 480;
const RIGHT_MIN = 220;
const RIGHT_MAX = 560;
const WORKSPACE_HEIGHT = "clamp(300px, 58vh, 640px)";

const DEFAULT_LAYOUT: BladeLayout = {
  leftCollapsed: false,
  // The function reference starts as a collapsed rail — the editor is the
  // star; expand the blade (or drag/double-click functions out of it) when
  // reference material is wanted.
  rightCollapsed: true,
  leftWidth: 240,
  rightWidth: 360,
  swapped: false,
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Coerce a (possibly corrupt / out-of-range / wrong-typed) persisted layout into
 *  a valid one, so state is ALWAYS clamped — otherwise a bad stored width would
 *  load into state and get re-persisted unclamped, only masked by the render's
 *  defensive clamp. */
function normalizeLayout(l: Partial<BladeLayout>): BladeLayout {
  const width = (v: unknown, def: number, lo: number, hi: number): number =>
    typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : def;
  return {
    leftCollapsed: Boolean(l.leftCollapsed),
    rightCollapsed: Boolean(l.rightCollapsed),
    leftWidth: width(l.leftWidth, DEFAULT_LAYOUT.leftWidth, LEFT_MIN, LEFT_MAX),
    rightWidth: width(l.rightWidth, DEFAULT_LAYOUT.rightWidth, RIGHT_MIN, RIGHT_MAX),
    swapped: Boolean(l.swapped),
  };
}

function loadLayout(): BladeLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    return normalizeLayout(JSON.parse(raw) as Partial<BladeLayout>);
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

function saveLayout(layout: BladeLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // localStorage may be unavailable (private mode / quota) — layout just
    // won't persist; not worth surfacing.
  }
}

const iconBtnStyle: React.CSSProperties = {
  border: "1px solid transparent",
  background: "transparent",
  color: "#666",
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1,
  padding: "2px 5px",
  borderRadius: 3,
};

/** Draggable divider between a side pane and the centre editor. Lives as a
 *  sibling in the workspace row (not inside the pane) so the pane's rounded
 *  overflow never clips it and it always presents a full grab target. Dragging
 *  away from the centre grows the pane; the parent clamps the resulting width. */
function ResizeHandle({
  side,
  width,
  onWidthChange,
}: {
  side: BladeSide;
  width: number;
  onWidthChange: (next: number) => void;
}): React.ReactElement {
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startW: width };
      const move = (ev: MouseEvent): void => {
        const d = dragRef.current;
        if (!d) return;
        // The left pane's divider is on its right edge (drag right -> wider); the
        // right pane's is on its left edge (drag left -> wider).
        const delta = side === "left" ? ev.clientX - d.startX : d.startX - ev.clientX;
        onWidthChange(d.startW + delta);
      };
      const up = (): void => {
        dragRef.current = null;
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [side, width, onWidthChange],
  );
  return (
    <div
      onMouseDown={onDown}
      title="Drag to resize"
      style={{
        flexShrink: 0,
        width: 7,
        cursor: "col-resize",
        alignSelf: "stretch",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div style={{ width: 1, height: "100%", background: "#ddd" }} />
    </div>
  );
}

/** A collapsible side pane. Collapsed it becomes a thin rail with a rotated
 *  label; expanded it shows a title bar (swap + collapse controls) over the pane
 *  content. Its width is driven by the parent and changed by a sibling
 *  <ResizeHandle>. */
function Blade({
  side,
  title,
  collapsed,
  onToggleCollapsed,
  width,
  onSwap,
  children,
}: {
  side: BladeSide;
  title: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  width: number;
  onSwap: () => void;
  children: React.ReactNode;
}): React.ReactElement {

  if (collapsed) {
    return (
      <div
        onClick={onToggleCollapsed}
        title={`Expand ${title}`}
        style={{
          width: 30,
          flexShrink: 0,
          cursor: "pointer",
          border: "1px solid #ddd",
          borderRadius: 4,
          background: "#f2f3f5",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
          padding: "8px 0",
        }}
      >
        <span style={{ fontSize: 12, color: "#888" }}>{side === "left" ? "▸" : "◂"}</span>
        <span
          style={{
            writingMode: "vertical-rl",
            transform: "rotate(180deg)",
            fontSize: 11,
            fontWeight: 600,
            color: "#555",
            whiteSpace: "nowrap",
            letterSpacing: 0.3,
          }}
        >
          {title}
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        width,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        border: "1px solid #ddd",
        borderRadius: 4,
        background: "#fafafa",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: "4px 4px 4px 8px",
          borderBottom: "1px solid #eee",
          background: "#f2f3f5",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontWeight: 600,
            fontSize: 12,
            color: "#555",
            flex: 1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </span>
        <button style={iconBtnStyle} onClick={onSwap} title="Move to the other side">
          ⇄
        </button>
        <button
          style={iconBtnStyle}
          onClick={onToggleCollapsed}
          title={`Collapse ${title}`}
        >
          {side === "left" ? "◂" : "▸"}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {children}
      </div>
    </div>
  );
}

// ===========================================================================
// The workspace itself
// ===========================================================================

/** Imperative surface for the host dialog: insert text at the cursor and
 *  place/clear the engine's positioned parse marker. */
export interface ExpressionWorkspaceHandle {
  insert: (text: string) => void;
  /** position = UTF-8 byte offset from the engine; null/null clears. */
  setMarker: (position: number | null, message: string | null) => void;
  focus: () => void;
}

export const ExpressionWorkspace = forwardRef<
  ExpressionWorkspaceHandle,
  {
    /** The current model — feeds the blades and the editor's autocomplete /
     *  hover / signature help. */
    overview: ModelOverview;
    value: string;
    onChange: (value: string) => void;
    /** Heading over the editor (default "Formula"). */
    label?: string;
    /** One-line hint next to the heading. */
    hint?: string;
    /** Tooltip for the hint (longer guidance). */
    hintTitle?: string;
  }
>(function ExpressionWorkspace(
  { overview, value, onChange, label = "Formula", hint, hintTitle },
  ref,
): React.ReactElement {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  // Side-pane arrangement (collapsed / widths / swapped), persisted across
  // sessions and shared by every editor that hosts this workspace.
  const [layout, setLayout] = useState<BladeLayout>(() => loadLayout());
  useEffect(() => {
    saveLayout(layout);
  }, [layout]);

  const toggleCollapsed = useCallback((s: BladeSide) => {
    setLayout((l) =>
      s === "left"
        ? { ...l, leftCollapsed: !l.leftCollapsed }
        : { ...l, rightCollapsed: !l.rightCollapsed },
    );
  }, []);
  const setBladeWidth = useCallback((s: BladeSide, w: number) => {
    setLayout((l) =>
      s === "left"
        ? { ...l, leftWidth: clamp(w, LEFT_MIN, LEFT_MAX) }
        : { ...l, rightWidth: clamp(w, RIGHT_MIN, RIGHT_MAX) },
    );
  }, []);
  const toggleSwap = useCallback(() => setLayout((l) => ({ ...l, swapped: !l.swapped })), []);

  // Function-reference (wiki) pane — lazily loaded the first time the docs
  // blade is visible, then cached for the window's lifetime (the docs are
  // embedded in the engine at build time, so they never change at runtime; the
  // cache also spares remounted workspaces — e.g. switching calc-group items —
  // a refetch). `null` = not loaded yet; guarding the fetch on the STATE (not
  // a ref) keeps this correct under React StrictMode's double-invoked effects:
  // a cancelled first fetch simply retries, instead of a ref guard suppressing
  // the retry and leaving the spinner on forever.
  const [docs, setDocs] = useState<FunctionDocDto[] | null>(docsCache);
  const docsSideCollapsed = layout.swapped ? layout.leftCollapsed : layout.rightCollapsed;
  useEffect(() => {
    if (docsSideCollapsed || docs !== null) return;
    let cancelled = false;
    void biModelFunctionDocs()
      .then((d) => {
        docsCache = d;
        if (!cancelled) setDocs(d);
      })
      .catch(() => {
        // Not cached — a later mount retries.
        if (!cancelled) setDocs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [docsSideCollapsed, docs]);

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
    registerMeasureLanguage();
  };

  // Feed the language its live context: the engine function catalog (static)
  // plus this model's tables/columns/measures. Refreshes if the model changes.
  useEffect(() => {
    let cancelled = false;
    const context = {
      tables: overview.tables.map((t) => ({
        name: t.name,
        columns: t.columns.map((c) => c.name),
      })),
      measures: overview.measures.map((m) => m.name),
    };
    biModelFunctionCatalog()
      .then((cat) => {
        if (!cancelled) setMeasureLanguageContext(cat, context);
      })
      .catch(() => {
        if (!cancelled) setMeasureLanguageContext([], context);
      });
    return () => {
      cancelled = true;
    };
  }, [overview]);

  const setMarker = useCallback((position: number | null, message: string | null) => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    if (position === null || message === null) {
      monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
      return;
    }
    const offset = byteToUtf16Offset(model.getValue(), position);
    const start = model.getPositionAt(offset);
    const end = model.getPositionAt(Math.min(offset + 1, model.getValueLength()));
    monaco.editor.setModelMarkers(model, MARKER_OWNER, [
      {
        severity: monaco.MarkerSeverity.Error,
        message,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
    ]);
  }, []);

  // Insert a reference (from the tree) into the editor — at a drop position
  // when dropped, otherwise replacing the current selection / at the cursor.
  const insertRef = useCallback(
    (text: string, at?: monaco.IPosition) => {
      const editor = editorRef.current;
      if (!editor) return;
      const range = at
        ? new monaco.Range(at.lineNumber, at.column, at.lineNumber, at.column)
        : (editor.getSelection() ?? new monaco.Range(1, 1, 1, 1));
      editor.executeEdits("tree-insert", [{ range, text, forceMoveMarkers: true }]);
      editor.pushUndoStop();
      editor.focus();
      onChange(editor.getValue());
      setMarker(null, null);
    },
    [onChange, setMarker],
  );

  useImperativeHandle(
    ref,
    () => ({
      insert: (text: string) => insertRef(text),
      setMarker,
      focus: () => editorRef.current?.focus(),
    }),
    [insertRef, setMarker],
  );

  const handleEditorDrop = useCallback(
    (e: React.DragEvent) => {
      const text = e.dataTransfer.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      const editor = editorRef.current;
      const target = editor?.getTargetAtClientPoint(e.clientX, e.clientY);
      insertRef(text, target?.position ?? undefined);
    },
    [insertRef],
  );

  // Render one side pane. Which content it holds depends on `swapped`; the
  // collapsed/width state is tracked per physical side (left/right).
  const renderBlade = (side: BladeSide): React.ReactElement => {
    const isTree = side === (layout.swapped ? "right" : "left");
    const collapsed = side === "left" ? layout.leftCollapsed : layout.rightCollapsed;
    const width =
      side === "left"
        ? clamp(layout.leftWidth, LEFT_MIN, LEFT_MAX)
        : clamp(layout.rightWidth, RIGHT_MIN, RIGHT_MAX);
    return (
      <Blade
        side={side}
        title={isTree ? "Tables & columns" : "Function reference"}
        collapsed={collapsed}
        onToggleCollapsed={() => toggleCollapsed(side)}
        width={width}
        onSwap={toggleSwap}
      >
        {isTree ? (
          <ModelTreeContent overview={overview} onInsert={insertRef} />
        ) : (
          <FunctionDocsPanel
            docs={docs ?? []}
            loading={docs === null}
            onInsert={(text) => insertRef(text)}
          />
        )}
      </Blade>
    );
  };

  return (
    <div
      style={{
        height: WORKSPACE_HEIGHT,
        display: "flex",
        gap: 6,
        alignItems: "stretch",
        marginBottom: 10,
      }}
    >
      {renderBlade("left")}
      {!layout.leftCollapsed && (
        <ResizeHandle
          side="left"
          width={clamp(layout.leftWidth, LEFT_MIN, LEFT_MAX)}
          onWidthChange={(w) => setBladeWidth("left", w)}
        />
      )}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#444" }}>{label}</span>
          {hint && (
            <span
              style={{
                ...styles.hint,
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={hintTitle ?? hint}
            >
              {hint}
            </span>
          )}
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 120,
            border: "1px solid #ccc",
            borderRadius: 3,
            overflow: "hidden",
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleEditorDrop}
        >
          <Editor
            height="100%"
            language={MEASURE_LANGUAGE_ID}
            value={value}
            onChange={(v) => {
              onChange(v ?? "");
              setMarker(null, null);
            }}
            onMount={handleMount}
            options={{
              minimap: { enabled: false },
              lineNumbers: "off",
              fontSize: 13,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              automaticLayout: true,
            }}
          />
        </div>
      </div>
      {!layout.rightCollapsed && (
        <ResizeHandle
          side="right"
          width={clamp(layout.rightWidth, RIGHT_MIN, RIGHT_MAX)}
          onWidthChange={(w) => setBladeWidth("right", w)}
        />
      )}
      {renderBlade("right")}
    </div>
  );
});

/** Explorable tree of the model's tables/columns/measures. Click a leaf to
 *  insert its reference at the cursor, or drag it onto the editor. Frameless:
 *  it fills the "Tables & columns" blade, which supplies the title bar. */
function ModelTreeContent({
  overview,
  onInsert,
}: {
  overview: ModelOverview;
  onInsert: (ref: string) => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const onDragRef = (e: React.DragEvent, text: string) => {
    e.dataTransfer.setData("text/plain", text);
    e.dataTransfer.effectAllowed = "copy";
  };
  const subHeaderStyle: React.CSSProperties = {
    padding: "4px 8px",
    fontWeight: 600,
    color: "#555",
    borderBottom: "1px solid #eee",
    borderTop: "1px solid #eee",
    position: "sticky",
    top: 0,
    background: "#f2f2f2",
  };
  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "2px 6px",
    cursor: "grab",
    userSelect: "none",
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        fontSize: 12,
        background: "#fafafa",
      }}
    >
      {overview.tables.length === 0 && (
        <div style={{ padding: "6px 8px", color: "#999" }}>No tables yet.</div>
      )}
      {overview.tables.map((t) => {
        const open = expanded.has(t.name);
        return (
          <div key={t.name}>
            <div
              style={{ ...rowStyle, cursor: "pointer", fontWeight: 600 }}
              draggable
              onDragStart={(e) => onDragRef(e, t.name)}
              onClick={() => toggle(t.name)}
              title="Click to expand; drag to insert the table name"
            >
              <Chevron open={open} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.name}
              </span>
            </div>
            {open &&
              t.columns.map((c) => (
                <div
                  key={c.name}
                  style={{ ...rowStyle, paddingLeft: 24 }}
                  draggable
                  onDragStart={(e) => onDragRef(e, `${t.name}[${c.name}]`)}
                  onClick={() => onInsert(`${t.name}[${c.name}]`)}
                  title={`Insert ${t.name}[${c.name}]`}
                >
                  <span style={{ color: c.isCalculated ? "#2f6fce" : "#aaa" }}>
                    {c.isCalculated ? "ƒ" : "▪"}
                  </span>
                  <span
                    style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {c.name}
                  </span>
                  <span style={{ marginLeft: "auto", color: "#bbb", fontSize: 10, flexShrink: 0 }}>
                    {c.dataType}
                  </span>
                </div>
              ))}
          </div>
        );
      })}
      {overview.measures.length > 0 && (
        <>
          <div style={subHeaderStyle}>Measures</div>
          {overview.measures.map((m) => (
            <div
              key={m.name}
              style={rowStyle}
              draggable
              onDragStart={(e) => onDragRef(e, `[${m.name}]`)}
              onClick={() => onInsert(`[${m.name}]`)}
              title={`Insert [${m.name}]`}
            >
              <span style={{ color: "#8a5cf6" }}>∑</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {m.name}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

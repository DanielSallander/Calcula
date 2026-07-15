// FILENAME: app/extensions/ModelEditor/components/sections/MeasureEditorModal.tsx
// PURPOSE: Monaco-based modal for ONE model measure (add or edit) inside the
//          Model Editor window. Validates through the engine parser
//          (positioned markers) and installs the edit via
//          bi_model_upsert_measure on save. Ported from the old main-window
//          MeasureEditorDialog.
//
// LAYOUT: a workspace-style modal that puts the FORMULA editor front and centre.
//   ┌ Name ───────────┐ ┌ Description ────────────────────────────┐
//   ├─────────────────────────────────────────────────────────────┤
//   │ Tables & │        Formula editor (fills)          │ Function │
//   │ columns  │                                        │ reference│
//   │ (blade)  │                                        │ (blade)  │
//   ├─────────────────────────────────────────────────────────────┤
//   │ ▸ More options (Folder, Format, Dynamic format, Detail rows) │
//   └─────────────────────────────────────────────────────────────┘
//   The two side "blades" are independently collapsible, resizable (drag the
//   inner edge) and can be swapped left/right; the chosen arrangement persists
//   in localStorage so it survives across sessions. The default is the arrangement
//   drawn above.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import type { FunctionDocDto, ModelMeasureInfo, ModelOverview } from "@api";
import {
  biModelFunctionCatalog,
  biModelFunctionDocs,
  biModelUpsertMeasure,
  biModelValidateMeasure,
} from "@api";
import { Field, Modal, styles } from "../editorShared";
import { NUMBER_FORMAT_PRESETS } from "../../../_shared/components/NumberFormatModal";
import {
  folderDepth,
  folderPathsWithAncestors,
  normalizeFolderPath,
  splitFolderPath,
} from "../../lib/measureFolders";
import { FunctionDocsPanel } from "./FunctionDocsPanel";
import {
  MEASURE_LANGUAGE_ID,
  registerMeasureLanguage,
  setMeasureLanguageContext,
} from "../../lib/measureLanguage";

/** Best-effort preview of a number-format code applied to a sample value.
 *  Covers the common cases (decimals, thousands grouping, %, currency prefix);
 *  the authoritative formatting still happens in the engine. */
function previewFormat(value: number, fmt: string): string {
  const f = fmt.trim();
  if (!f) return String(value); // General
  const isPercent = f.includes("%");
  const n = isPercent ? value * 100 : value;
  const dot = f.indexOf(".");
  const decimals = dot >= 0 ? (f.slice(dot + 1).match(/[0#]/g)?.length ?? 0) : 0;
  const grouping = f.replace(/\[[^\]]*\]/g, "").includes(",");
  let prefix = "";
  const cur = /\[\$([^\]]+)\]/.exec(f);
  if (cur) prefix = `${cur[1].split("-")[0].trim()} `;
  else if (f.includes("$")) prefix = "$";
  const body = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: grouping,
  }).format(n);
  return `${prefix}${body}${isPercent ? "%" : ""}`;
}

/** Preset dropdown + custom code + live preview for a measure's number format. */
function FormatField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  const isPreset = NUMBER_FORMAT_PRESETS.some((p) => p.value === value);
  const [custom, setCustom] = useState(!isPreset && value !== "");
  const sample = value.includes("%") ? 0.1235 : 1234.567;
  return (
    <Field label="Format (optional)">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select
          style={{ ...styles.input, maxWidth: 340 }}
          value={custom ? "__custom__" : value}
          onChange={(e) => {
            if (e.target.value === "__custom__") {
              setCustom(true);
            } else {
              setCustom(false);
              onChange(e.target.value);
            }
          }}
        >
          {NUMBER_FORMAT_PRESETS.map((p) => (
            <option key={p.value || "general"} value={p.value}>
              {p.label}
            </option>
          ))}
          <option value="__custom__">Custom…</option>
        </select>
        {custom && (
          <input
            style={{ ...styles.input, flex: 1, minWidth: 120, fontFamily: "monospace" }}
            value={value}
            placeholder="#,##0.00"
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        <span style={{ ...styles.muted, fontSize: 12, whiteSpace: "nowrap" }}>
          Preview: <strong style={{ color: "#222" }}>{previewFormat(sample, value)}</strong>
        </span>
      </div>
    </Field>
  );
}

/** Folder (measure-group) picker: choose an existing folder, none, or type a
 *  new one. Groups measures into folders in the measures list; the group ships
 *  with the model when it is published as a package. */
function FolderField({
  value,
  onChange,
  groups,
}: {
  value: string;
  onChange: (v: string) => void;
  groups: string[];
}): React.ReactElement {
  const known = groups.includes(value);
  const [custom, setCustom] = useState(value !== "" && !known);
  // If a name typed as "new" turns out to be a real folder (e.g. it was added
  // in another window while this modal was open), stop showing it as new so the
  // dropdown reflects the actual selection. Converges: once custom is false the
  // condition is false too.
  if (custom && value !== "" && known) {
    setCustom(false);
  }
  return (
    <Field label="Folder (optional)">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select
          style={{ ...styles.input, maxWidth: 340 }}
          value={custom ? "__new__" : value}
          onChange={(e) => {
            if (e.target.value === "__new__") {
              setCustom(true);
            } else {
              setCustom(false);
              onChange(e.target.value);
            }
          }}
        >
          <option value="">(No folder)</option>
          {groups.map((g) => (
            <option key={g} value={g} title={g}>
              {`${"  ".repeat(folderDepth(g))}${splitFolderPath(g).slice(-1)[0]}`}
            </option>
          ))}
          <option value="__new__">New folder…</option>
        </select>
        {custom && (
          <input
            style={{ ...styles.input, flex: 1, minWidth: 160 }}
            value={value}
            placeholder="e.g. Sales\KPIs"
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </div>
    </Field>
  );
}

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

const MARKER_OWNER = "calcula-measure-editor";

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

const LAYOUT_KEY = "calcula.measureEditor.layout.v1";
const LEFT_MIN = 160;
const LEFT_MAX = 480;
const RIGHT_MIN = 220;
const RIGHT_MAX = 560;
const WORKSPACE_HEIGHT = "clamp(300px, 58vh, 640px)";

const DEFAULT_LAYOUT: BladeLayout = {
  leftCollapsed: false,
  rightCollapsed: false,
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

export function MeasureEditorModal({
  connectionId,
  existing,
  overview,
  onClose,
  onSaved,
}: {
  connectionId: string;
  existing: ModelMeasureInfo | null;
  /** The current model — feeds the editor's function/table/column/measure
   *  autocomplete + hover + signature help. */
  overview: ModelOverview;
  onClose: () => void;
  onSaved: (measures: ModelMeasureInfo[]) => void;
}): React.ReactElement {
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [formatString, setFormatString] = useState(existing?.formatString ?? "");
  const [formatStringExpression, setFormatStringExpression] = useState(
    existing?.formatStringExpression ?? "",
  );
  const [detailRows, setDetailRows] = useState(
    (existing?.detailRows ?? []).join(", "),
  );
  const [group, setGroup] = useState(normalizeFolderPath(existing?.group ?? ""));
  const [formula, setFormula] = useState(existing?.formula ?? "");

  // The secondary attributes live in a collapsible "More options" section under
  // the editor. Open it up-front when editing a measure that already sets any of
  // them, so those values are not hidden behind a click.
  const [advancedOpen, setAdvancedOpen] = useState(
    Boolean(
      (existing?.group ?? "") ||
        (existing?.formatString ?? "") ||
        (existing?.formatStringExpression ?? "") ||
        (existing?.detailRows?.length ?? 0),
    ),
  );

  // Existing folders in this model (including intermediate/nested ones) — offered
  // in the folder dropdown so the user can file this measure into a folder that
  // already exists.
  const existingGroups = useMemo(
    () => folderPathsWithAncestors(overview.measures.map((m) => m.group)),
    [overview.measures],
  );
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  // Side-pane arrangement (collapsed / widths / swapped), persisted across sessions.
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

  // Function-reference (wiki) pane — lazily loaded from the engine's docs the
  // first time the docs blade is visible, then kept for the life of the dialog.
  const [docs, setDocs] = useState<FunctionDocDto[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const docsLoadedRef = useRef(false);
  // Guards the lazy docs fetch (kicked off from an effect) against resolving
  // after the dialog has already closed.
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // The docs pane occupies whichever side is NOT holding the tree.
  const docsSideCollapsed = layout.swapped ? layout.leftCollapsed : layout.rightCollapsed;
  useEffect(() => {
    if (docsSideCollapsed || docsLoadedRef.current) return;
    docsLoadedRef.current = true;
    setDocsLoading(true);
    void biModelFunctionDocs()
      .then((d) => {
        if (mountedRef.current) setDocs(d);
      })
      .catch(() => {
        if (mountedRef.current) setDocs([]);
      })
      .finally(() => {
        if (mountedRef.current) setDocsLoading(false);
      });
  }, [docsSideCollapsed]);

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
      setFormula(editor.getValue());
      setMarker(null, null);
    },
    [setMarker],
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

  const handleValidate = useCallback(async () => {
    setError(null);
    setStatus(null);
    try {
      const result = await biModelValidateMeasure(
        connectionId,
        name,
        formula,
        existing?.name ?? null,
      );
      if (result.ok) {
        setMarker(null, null);
        setStatus("Formula is valid.");
      } else {
        setMarker(result.position, result.message);
        setError(result.message ?? "Invalid formula");
      }
    } catch (err: unknown) {
      setError(String(err));
    }
  }, [connectionId, name, formula, existing, setMarker]);

  const handleSave = useCallback(async () => {
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      const measures = await biModelUpsertMeasure({
        connectionId,
        originalName: existing?.name ?? null,
        name,
        formula,
        description: description.trim() || null,
        formatString: formatString.trim() || null,
        formatStringExpression: formatStringExpression.trim() || null,
        detailRows: detailRows
          .split(",")
          .map((r) => r.trim())
          .filter((r) => r.length > 0),
        group: group.trim() || null,
      });
      // The parent applies the fresh measure list and notifies the main
      // window (which recalcs CUBE) — the grid lives in the other window.
      onSaved(measures);
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [
    connectionId,
    existing,
    name,
    formula,
    description,
    formatString,
    formatStringExpression,
    detailRows,
    group,
    onSaved,
  ]);

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
          <MeasureTreeContent overview={overview} onInsert={insertRef} />
        ) : (
          <FunctionDocsPanel docs={docs} loading={docsLoading} />
        )}
      </Blade>
    );
  };

  return (
    <Modal
      title={existing ? `Edit Measure: ${existing.name}` : "New Measure"}
      width={1280}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.btn} onClick={() => void handleValidate()}>
            Validate
          </button>
          <button
            style={styles.primaryBtn}
            onClick={() => void handleSave()}
            // An empty formula is allowed — it saves as a BLANK() placeholder.
            disabled={busy || !name.trim() || !connectionId}
          >
            {busy ? "Saving…" : "Save Measure"}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 10 }}>
        Model measures are part of the connection&apos;s model — they persist in this workbook and
        ship when the model is published as a package.
      </div>
      {existing && !existing.hasSource && (
        <div
          style={{
            fontSize: 12,
            padding: "6px 8px",
            marginBottom: 8,
            backgroundColor: "#fff3cd",
            borderRadius: 4,
          }}
        >
          This formula was reconstructed from the stored model (no original text). If you save
          without changing it, the stored definition is kept as-is; edit it only if you intend to
          redefine the measure.
        </div>
      )}

      {/* Identity row — Name and Description stay on top. */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <Field label="Name" flex={1}>
          <input
            style={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Revenue"
          />
        </Field>
        <Field label="Description (optional)" flex={2}>
          <input
            style={styles.input}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>

      {/* Workspace: editor front-and-centre, flanked by the two blades. */}
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
            <span style={{ fontSize: 12, fontWeight: 600, color: "#444" }}>Formula</span>
            <span
              style={{
                ...styles.hint,
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title="Leave empty for a BLANK() placeholder. Reference other measures as [Name], columns as Table[column]; add notes with /* … */ or // comments. Use GVAR for a query-scoped value — e.g. GVAR grand = SUM(Sales[amount]) RETURN DIVIDE(SUM(Sales[amount]), grand)."
            >
              Reference measures as [Name], columns as Table[column]. Drag from the tree to insert.
            </span>
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
              value={formula}
              onChange={(v) => {
                setFormula(v ?? "");
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

      {/* Secondary attributes — hidden by default, expandable on click. */}
      <div style={{ border: "1px solid #e5e5e5", borderRadius: 4, marginBottom: 8 }}>
        <button
          onClick={() => setAdvancedOpen((o) => !o)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "8px 10px",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
            color: "#444",
            textAlign: "left",
          }}
        >
          <span style={{ color: "#888", width: 10 }}>{advancedOpen ? "▾" : "▸"}</span>
          More options
          {!advancedOpen && (
            <span style={{ ...styles.hint, fontWeight: 400 }}>
              Folder, Format, Dynamic format, Detail rows
            </span>
          )}
        </button>
        {advancedOpen && (
          <div style={{ padding: "4px 12px 8px", borderTop: "1px solid #f0f0f0" }}>
            <FolderField value={group} onChange={setGroup} groups={existingGroups} />
            <FormatField value={formatString} onChange={setFormatString} />
            <Field
              label="Dynamic format (optional)"
              hint='An expression evaluated once per query under the active filters, returning the format string — e.g. IF([SelectedCurrency] = "EUR", "#,##0.00 €", "$#,##0.00"). Overrides the static format when it yields a value.'
            >
              <input
                style={styles.input}
                value={formatStringExpression}
                onChange={(e) => setFormatStringExpression(e.target.value)}
                placeholder='IF(SUM(fact[amount]) > 1000000, "#,##0,,\"M\"", "#,##0")'
              />
            </Field>
            <Field
              label="Detail rows (optional)"
              hint="Drill-through projection: comma-separated Table[column] references returned when a user drills a cell of this measure. Fact-table columns become the detail columns; other tables' columns are looked up beside each row. Leave empty for the default projection."
            >
              <input
                style={styles.input}
                value={detailRows}
                onChange={(e) => setDetailRows(e.target.value)}
                placeholder="Sales[order_id], Sales[amount], Customer[name]"
              />
            </Field>
          </div>
        )}
      </div>

      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
      {status && <div style={{ color: "green", marginBottom: 8, fontSize: 12 }}>{status}</div>}
    </Modal>
  );
}

/** Explorable tree of the model's tables/columns/measures. Click a leaf to
 *  insert its reference at the cursor, or drag it onto the editor. Frameless:
 *  it fills the "Tables & columns" blade, which supplies the title bar. */
function MeasureTreeContent({
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
              <span style={{ width: 12, color: "#888" }}>{open ? "▾" : "▸"}</span>
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

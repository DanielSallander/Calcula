//! FILENAME: app/extensions/Pivot/components/DrillThroughBehaviorDialog.tsx
// PURPOSE: Configure a BI pivot's drill-through behavior: Built-in (raw fact
//          rows with related dimension attributes), Custom (a declarative
//          query override: which attributes, a row cap), Script (the pivot's
//          onDrillThrough script) or -- docs/design/model-drillthrough.md 2.9
//          -- a DESIGN QUERY: a design-query DSL plus the presentation its
//          result takes (a table or a chart of some mark), hosted in the
//          shared editor. Persists via set_pivot_drill_behavior; the config
//          travels in .calp so subscribers get the publisher's drill. A
//          present `designQuery` WINS over `kind` (2.1), so the radio derives
//          from it first; saving it keeps the previous kind (and its query
//          override) beside the definition, and saving another radio drops it.
// CONTEXT: Opened from the pivot context menu "Drill-through behavior..."
//          action, or READ-ONLY from "View drill-through behavior..." on a
//          subscribed sheet or page (`data.readOnly`): a subscriber must be
//          able to READ what a publisher's drill will query (wave3 12.1: a
//          not-code artifact is transparent because it is listed), never edit
//          it -- Save is absent and every control is disabled. The modal
//          widens to 720 px while the Design query radio is active (the
//          Monaco editor and its inline assist need the room; spec: at least
//          640). The editor's model comes from `get_connection_bi_model` (the
//          LIVE engine: hierarchies, calculation groups, cultures, strategy),
//          falling back to the pivot's cached tables / measures when the
//          connection is ZERO (after a .cala load, until the user reconnects)
//          or cannot be read. Only a connection whose LIVE model was read is
//          handed to the editor -- its inline assist dry-runs against it, and a
//          ZERO id is told, never queried (spec 2.2) -- so on the cached model
//          the assist is absent and one muted line says why. The editor does
//          no IPC of its own: its dry run goes out over this extension's bound
//          channel (`pivotBackend`).

import React, { useState, useEffect, useCallback } from "react";
import { css } from "@emotion/css";
import { showToast, type DrillThroughDefinition } from "@api";
import { useDialogWindow } from "@api/dialogWindow";
import { DrillThroughDefinitionEditor } from "../../_shared/drillThrough/DrillThroughDefinitionEditor";
import type { BiPivotModelInfo as EditorModelInfo } from "../../_shared/components/types";
import { noteDrillBehaviorSaved } from "../handlers/selectionHandler";
import { pivotBackend } from "../lib/pivotBackend";
import {
  getConnectionBiModel,
  getPivotBiMetadata,
  getPivotDrillBehavior,
  getPivotTableInfo,
  setPivotDrillBehavior,
  type DrillThroughBehavior,
  type DrillThroughKind,
  type DrillColumnRef,
} from "../lib/pivot-api";

export interface DrillThroughBehaviorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  data?: Record<string, unknown>;
}

interface AttrOption {
  table: string;
  column: string;
  /** "table.column" — stable key for selection. */
  key: string;
}

/** The radio: the three kinds, plus the design-query drill (a present `designQuery` WINS over `kind`). */
export type DrillBehaviorMode = DrillThroughKind | "designQuery";

/** What the Design query radio starts from when the pivot has no definition yet. */
export const EMPTY_DRILL_DEFINITION: DrillThroughDefinition = { dslText: "", presentation: { kind: "table" } };

/** The modal's width while the Design query radio is active (spec 2.9: at least 640 px). */
export const WIDE_MODAL_WIDTH = 720;

/**
 * The muted line over the editor when it runs on the pivot's CACHED model
 * (no live connection was read): why the describe-a-query assist is absent.
 */
export const CACHED_MODEL_NOTE =
  "The model's connection is not open: the editor uses this PivotTable's saved fields, " +
  "and drafting a query from a description needs the connection.";

const NIL_UUID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;

/**
 * A connection id that names no live connection: absent, "0", or the ZERO
 * `EntityId` (serialised as the nil UUID), which a .cala load leaves on a BI
 * pivot until the user reconnects.
 */
export function isZeroConnection(connectionId: string | null | undefined): boolean {
  if (!connectionId) return true;
  return connectionId === "0" || NIL_UUID.test(connectionId);
}

/** The radio a stored behaviour opens on: Design query when it carries a definition (it WINS), else its kind, else Built-in. */
export function drillModeOf(behavior: DrillThroughBehavior | null | undefined): DrillBehaviorMode {
  if (behavior?.designQuery) return "designQuery";
  return behavior?.kind ?? "builtin";
}

/**
 * The behaviour a Design-query Save writes: the previous kind (`kind` keeps
 * whatever it was, spec 2.1) and its query override when it had one -- so
 * the Custom radio's columns survive a design-query save -- with the
 * definition beside them.
 */
export function designQueryBehavior(
  previous: DrillThroughBehavior | null | undefined,
  designQuery: DrillThroughDefinition,
): DrillThroughBehavior {
  return {
    kind: previous?.kind ?? "builtin",
    ...(previous?.query ? { query: previous.query } : {}),
    designQuery,
  };
}

function failureText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const styles = {
  overlay: css`
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  `,
  modal: css`
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    width: 460px;
    max-width: 90vw;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    border-bottom: 1px solid #e0e0e0;
  `,
  title: css`
    font-size: 15px;
    font-weight: 600;
  `,
  closeBtn: css`
    border: none;
    background: none;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    color: #666;
    &:hover {
      color: #000;
    }
  `,
  body: css`
    padding: 16px 18px;
    overflow-y: auto;
  `,
  muted: css`
    color: #888;
    padding: 8px 0;
  `,
  radioRow: css`
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 6px 0;
    cursor: pointer;
    span {
      line-height: 1.4;
    }
  `,
  customSection: css`
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid #eee;
  `,
  sectionLabel: css`
    font-weight: 600;
    margin-bottom: 6px;
  `,
  attrList: css`
    max-height: 220px;
    overflow-y: auto;
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    padding: 6px;
  `,
  attrItem: css`
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 3px 0;
    cursor: pointer;
  `,
  limitRow: css`
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 12px;
  `,
  limitInput: css`
    width: 100px;
    padding: 4px 6px;
    border: 1px solid #ccc;
    border-radius: 4px;
  `,
  footer: css`
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 18px;
    border-top: 1px solid #e0e0e0;
  `,
  btnSecondary: css`
    padding: 6px 14px;
    border: 1px solid #ccc;
    background: #fff;
    border-radius: 4px;
    cursor: pointer;
  `,
  btnPrimary: css`
    padding: 6px 14px;
    border: none;
    background: #0a7a55;
    color: #fff;
    border-radius: 4px;
    cursor: pointer;
    &:disabled {
      opacity: 0.5;
      cursor: default;
    }
  `,
};

function DrillThroughBehaviorDialog({
  isOpen,
  onClose,
  data,
}: DrillThroughBehaviorDialogProps): React.ReactElement | null {
  const pivotId = (data?.pivotId as string) ?? "";
  /** A subscriber's view of a publisher's behaviour: shown, never saved. */
  const readOnly = data?.readOnly === true;

  // Movable + resizable dialog window (shared @api hook)
  const win = useDialogWindow({ minWidth: 340, minHeight: 280 });

  const [loading, setLoading] = useState(false);
  const [isBi, setIsBi] = useState(true);
  const [mode, setMode] = useState<DrillBehaviorMode>("builtin");
  const [attrOptions, setAttrOptions] = useState<AttrOption[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState<string>("");
  const [saving, setSaving] = useState(false);
  /** The behaviour as loaded: a design-query save keeps its kind and query override. */
  const [previous, setPrevious] = useState<DrillThroughBehavior | null>(null);
  const [designQuery, setDesignQuery] = useState<DrillThroughDefinition>(EMPTY_DRILL_DEFINITION);
  /** The connection handed to the editor: the pivot's only when its LIVE model was read, else "". */
  const [connectionId, setConnectionId] = useState("");
  const [editorModel, setEditorModel] = useState<EditorModelInfo | null>(null);
  /** The editor runs on the pivot's CACHED model (no live connection): said in one muted line. */
  const [usingCachedModel, setUsingCachedModel] = useState(false);
  const [pivotName, setPivotName] = useState("");

  useEffect(() => {
    if (!isOpen || !pivotId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [model, behavior, info] = await Promise.all([
          getPivotBiMetadata(pivotId),
          getPivotDrillBehavior(pivotId),
          // The name is a courtesy (the editor's "Drill-through from ..." line): a failed read costs nothing.
          Promise.resolve()
            .then(() => getPivotTableInfo(pivotId))
            .catch(() => null),
        ]);
        if (cancelled) return;
        setPivotName(info?.name ?? "");
        if (!model) {
          setIsBi(false);
          return;
        }
        setIsBi(true);
        // Candidate dimension attributes = columns from tables OTHER than the
        // fact (the fact's own columns already come back via the detail rows).
        const factTable = model.measures[0]?.table ?? "";
        const opts: AttrOption[] = [];
        for (const t of model.tables) {
          if (t.name === factTable) continue;
          for (const c of t.columns) {
            opts.push({ table: t.name, column: c.name, key: `${t.name}.${c.name}` });
          }
        }
        setAttrOptions(opts);
        setPrevious(behavior ?? null);
        setMode(drillModeOf(behavior));
        // The Custom radio's seed rides along whatever radio opens: a
        // design-query behaviour keeps its kind's query override.
        setSelected(
          new Set((behavior?.query?.dimensionColumns ?? []).map((d) => `${d.table}.${d.column}`)),
        );
        setLimit(behavior?.query?.limit != null ? String(behavior.query.limit) : "");
        setDesignQuery(behavior?.designQuery ?? EMPTY_DRILL_DEFINITION);

        // The editor's model: the LIVE connection's when it can be read,
        // else the pivot's cached tables / measures (a ZERO connection after
        // a .cala load; an unknown or deleted id; a read that fails).
        //
        // Only a connection whose LIVE model was read is handed to the
        // editor: its inline assist dry-runs queries against that id, and
        // spec 2.2 says a ZERO id is told, never queried. With "" the assist
        // does not mount (DesignQueryEditor gates it on the id), and the
        // editor's DSL context compiles locally against the cached model.
        const pivotConnection = model.connectionId ?? "";
        let forEditor: EditorModelInfo = model;
        let liveConnection = "";
        if (!isZeroConnection(pivotConnection)) {
          try {
            const live = await getConnectionBiModel(pivotConnection);
            if (live) {
              forEditor = live;
              liveConnection = pivotConnection;
            }
          } catch (err) {
            console.warn("[Pivot] get_connection_bi_model failed; the editor uses the pivot's cached model:", err);
          }
        }
        if (cancelled) return;
        setConnectionId(liveConnection);
        setUsingCachedModel(liveConnection === "");
        setEditorModel(forEditor);
      } catch (err) {
        console.error("[Pivot] Failed to load drill behavior:", err);
        showToast(`Could not read the drill-through behavior: ${failureText(err)}`, { variant: "error" });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, pivotId]);

  const toggleAttr = useCallback(
    (key: string) => {
      if (readOnly) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
    },
    [readOnly],
  );

  const handleSave = useCallback(async () => {
    if (readOnly) return;
    setSaving(true);
    try {
      let saved: DrillThroughBehavior | null;
      if (mode === "builtin") {
        saved = null;
      } else if (mode === "script") {
        saved = { kind: "script" };
      } else if (mode === "designQuery") {
        saved = designQueryBehavior(previous, designQuery);
      } else {
        const dimensionColumns: DrillColumnRef[] = attrOptions
          .filter((o) => selected.has(o.key))
          .map((o) => ({ table: o.table, column: o.column }));
        const parsedLimit = limit.trim() ? Number(limit) : undefined;
        saved = {
          kind: "query",
          query: {
            dimensionColumns,
            ...(parsedLimit != null && Number.isFinite(parsedLimit) && parsedLimit > 0
              ? { limit: parsedLimit }
              : {}),
          },
        };
      }
      await setPivotDrillBehavior(pivotId, saved);
      // The value-cell menu's label reads the cached region: it learns the save at once.
      noteDrillBehaviorSaved(pivotId, saved);
      onClose();
    } catch (err) {
      console.error("[Pivot] Failed to save drill behavior:", err);
      showToast(`Could not save the drill-through behavior: ${failureText(err)}`, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }, [readOnly, mode, previous, designQuery, pivotId, attrOptions, selected, limit, onClose]);

  if (!isOpen) return null;

  const wide = isBi && !loading && mode === "designQuery";
  const designQueryBlank = designQuery.dslText.trim() === "";
  const sourceLabel = pivotName ? `the PivotTable "${pivotName}"` : "this PivotTable";

  const radio = (value: DrillBehaviorMode, title: string, text: string): React.ReactElement => (
    <label className={styles.radioRow} key={value}>
      <input
        type="radio"
        name="drillMode"
        checked={mode === value}
        onChange={() => setMode(value)}
        disabled={readOnly}
        data-testid={`pivot-drill-mode-${value}`}
      />
      <span>
        <strong>{title}</strong> - {text}
      </span>
    </label>
  );

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        ref={win.ref}
        className={styles.modal}
        data-testid="pivot-drill-behavior-dialog"
        data-wide={wide ? "true" : "false"}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          ...(wide ? { width: WIDE_MODAL_WIDTH, maxWidth: "95vw" } : {}),
          ...win.style,
        }}
      >
        <div className={styles.header} onMouseDown={win.onHeaderMouseDown}>
          <span className={styles.title}>Drill-through behavior</span>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            X
          </button>
        </div>
        <div className={styles.body}>
          {loading ? (
            <div className={styles.muted}>Loading...</div>
          ) : !isBi ? (
            <div className={styles.muted}>
              Drill-through customization is available for BI-backed pivots only.
            </div>
          ) : (
            <>
              {radio("builtin", "Built-in", "raw fact rows with related dimension attributes (default)")}
              {radio("query", "Custom", "choose the dimension attributes and row cap")}
              {radio("script", "Script", "run this pivot's onDrillThrough script (advanced)")}
              {radio(
                "designQuery",
                "Design query",
                "run a design query filtered to the clicked cell's members, shown as a table or a chart on a temporary sheet",
              )}

              {mode === "query" && (
                <div className={styles.customSection}>
                  <div className={styles.sectionLabel}>Dimension attributes to show</div>
                  {attrOptions.length === 0 ? (
                    <div className={styles.muted}>No related dimension columns found.</div>
                  ) : (
                    <div className={styles.attrList}>
                      {attrOptions.map((o) => (
                        <label key={o.key} className={styles.attrItem}>
                          <input
                            type="checkbox"
                            checked={selected.has(o.key)}
                            disabled={readOnly}
                            onChange={() => toggleAttr(o.key)}
                          />
                          <span>
                            {o.table}.{o.column}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                  <div className={styles.limitRow}>
                    <span>Max rows</span>
                    <input
                      className={styles.limitInput}
                      type="number"
                      min={1}
                      value={limit}
                      placeholder="default"
                      disabled={readOnly}
                      onChange={(e) => setLimit(e.target.value)}
                    />
                  </div>
                </div>
              )}

              {mode === "script" && (
                <div className={styles.customSection}>
                  <div className={styles.muted}>
                    On double-click, this pivot's sandboxed onDrillThrough(ctx) script runs with the
                    clicked cell. Author it as the pivot's object script (it needs the bi.query
                    capability and writes its own result). It is consented + audited and travels in
                    .calp.
                  </div>
                </div>
              )}

              {mode === "designQuery" && (
                <div className={styles.customSection} data-testid="pivot-drill-design-query">
                  {usingCachedModel && !readOnly && (
                    // The missing assist is EXPLAINED, never silent.
                    <div className={styles.muted} data-testid="pivot-drill-cached-model-note">
                      {CACHED_MODEL_NOTE}
                    </div>
                  )}
                  <DrillThroughDefinitionEditor
                    value={designQuery}
                    onChange={setDesignQuery}
                    connectionId={connectionId}
                    biModel={editorModel}
                    invoke={pivotBackend.invoke}
                    readOnly={readOnly}
                    sourceLabel={sourceLabel}
                  />
                </div>
              )}
            </>
          )}
        </div>
        <div className={styles.footer}>
          <button className={styles.btnSecondary} onClick={onClose} disabled={saving}>
            {readOnly ? "Close" : "Cancel"}
          </button>
          {!readOnly && (
            <button
              className={styles.btnPrimary}
              onClick={handleSave}
              disabled={saving || loading || !isBi || (mode === "designQuery" && designQueryBlank)}
              data-testid="pivot-drill-save"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          )}
        </div>
        {win.resizeHandles}
      </div>
    </div>
  );
}

export default DrillThroughBehaviorDialog;

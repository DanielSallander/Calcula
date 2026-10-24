//! FILENAME: app/extensions/Charts/components/DrillThroughBehaviorDialog.tsx
// PURPOSE: A design-query chart's "Drill-through behavior..." dialog
//          (docs/design/model-drillthrough.md 2.9): radios None | Design query,
//          the Design query radio hosting the SHARED definition editor
//          (`_shared/drillThrough/DrillThroughDefinitionEditor`), Save writing
//          `ChartSpec.drillThrough` as ONE undo step. Opened read-only ("View
//          drill-through...") on a subscribed page or sheet: a subscriber must
//          be able to READ what a publisher's drill will query, so the query is
//          shown as text, every control is disabled, and Save and None are
//          absent.
// CONTEXT: The pivot's dialog of the same name is the precedent for the shape
//          (radios in a movable window); the WRITE mirrors lib/designQueryCommit
//          line for line -- validated against the schema's own
//          DrillThroughDefinition sub-schema (the script door's bounds: the
//          store write validates nothing) and against the connection's model, an
//          unchanged definition writes nothing, otherwise `updateChartSpec` +
//          invalidate + regions + CHART_UPDATED + the debounced save FLUSHED
//          inside `runInUndoTransaction("Edit drill-through")`, so the step
//          closes with its write inside it. The model comes over the Charts
//          channel (`get_connection_bi_model`); the shared editor does no IPC of
//          its own and takes `chartsBackend.invoke` for its dry run.
//
//          THE DEFINITION IS WRITTEN CLEAR-THEN-SET. The store's deep merge
//          folds a patch object into the stored one field by field, so
//          `{ presentation: { kind: "table" } }` written over
//          `{ kind: "chart", mark: "bar" }` would KEEP the mark -- a table with
//          a stray mark, which the closed schema refuses at the script door.
//          Clearing the key first (an explicitly-undefined key clears) and then
//          setting it, in the same step, writes exactly the definition shown.
//
//          RE-SHOW WITHOUT REMOUNT. DialogContainer keys by dialog id, so a
//          second "Drill-through behavior..." while the box is open updates its
//          props without remounting (see DataPointFormatDialog's header); the
//          state is therefore re-seeded on every show (`data.__openCount`) and
//          on a chart change, never only at mount.

import React, { useCallback, useEffect, useState } from "react";
import type { DialogProps } from "@api";
import type { DrillThroughDefinition } from "@api/drillThrough";
import { runInUndoTransaction } from "@api/objectGeometry";
import { useDialogWindow } from "@api/dialogWindow";
import { LT } from "@api/layout";
import { formatNumber } from "@api/locale";
import type { BiPivotModelInfo } from "../../_shared/components/types";
import { DrillThroughDefinitionEditor } from "../../_shared/drillThrough/DrillThroughDefinitionEditor";
import { invalidateChartCache } from "../rendering/chartRenderer";
import { ChartEvents } from "../lib/chartEvents";
import { chartsBackend } from "../lib/chartsBackend";
import { DESIGN_QUERY_MODEL_NOT_LOADED, designQueryRefusal } from "../lib/designQueryCommit";
import { CHART_DRILL_THROUGH_DSL_MAX_CHARS, CHART_DRILL_THROUGH_NAME_MAX_CHARS } from "../lib/chartSpecSchema";
import { validateDrillThroughDefinition } from "../lib/chartSpecValidate";
import {
  flushPendingChartSavesQuietly,
  getChartById,
  reportChartFailures,
  syncChartRegions,
  updateChartSpec,
} from "../lib/chartStore";
import { isDesignQueryDataSource, type ChartDefinition } from "../types";

/** The undo label of a definition edit. */
export const DRILL_THROUGH_UNDO_LABEL = "Edit drill-through";
/** The dialog's title: the pivot's existing string, hyphenated like every UI string. */
export const DRILL_THROUGH_DIALOG_TITLE = "Drill-through behavior";
/** The refusal for a Design query radio with nothing to run. */
export const DRILL_THROUGH_EMPTY_QUERY = "Enter a design query for the drill-through.";
/** Shown for a chart that reads cells or a pivot: the drill is a model feature. */
export const DRILL_THROUGH_NOT_DESIGN_QUERY = "Drill-through is available for design-query charts (charts that read a model) only.";

type DrillMode = "none" | "designQuery";

/**
 * The definition as it is STORED: the name trimmed and absent when blank,
 * `keepFilters` present only when false (absent = true, `drillKeepsFilters`).
 */
export function normalizeDrillDefinition(draft: DrillThroughDefinition): DrillThroughDefinition {
  const name = (draft.name ?? "").trim();
  const def: DrillThroughDefinition = { dslText: draft.dslText, presentation: draft.presentation };
  if (name) def.name = name;
  if (draft.keepFilters === false) def.keepFilters = false;
  return def;
}

/** Whether writing `next` would change what the chart stores (an unchanged definition writes nothing). */
export function sameDrillDefinition(
  stored: DrillThroughDefinition | undefined,
  next: DrillThroughDefinition | undefined,
): boolean {
  return JSON.stringify(stored ?? null) === JSON.stringify(next ?? null);
}

/**
 * The draft a NEW definition starts from: the chart's own query, so the
 * common drill -- the same measures at a finer grain -- is one ROWS edit away;
 * a table, the presentation that needs no further choice.
 */
export function startingDrillDraft(chart: ChartDefinition | undefined): DrillThroughDefinition {
  const dslText = chart && isDesignQueryDataSource(chart.spec.data) ? chart.spec.data.dslText : "";
  return { dslText, presentation: { kind: "table" } };
}

/**
 * Why `def` cannot be stored, or null when it can: the definition checked
 * against the schema's OWN `DrillThroughDefinition` sub-schema
 * (`validateDrillThroughDefinition`), so the query, name and presentation
 * bounds come from the one gate the script door applies -- never a re-typed
 * bound. The store write itself validates nothing, and a definition the
 * schema refuses would make EVERY later script write to the chart fail (the
 * store service validates the whole merged spec). A query or a name past its
 * length bound gets a sentence naming the limit (in the app locale).
 */
export function drillDefinitionRefusal(def: DrillThroughDefinition): string | null {
  const violations = validateDrillThroughDefinition(def);
  if (violations.length === 0) return null;
  const limit = (n: number) => formatNumber(n, { grouping: true });
  if (typeof def.dslText === "string" && [...def.dslText].length > CHART_DRILL_THROUGH_DSL_MAX_CHARS) {
    return `The design query is longer than ${limit(CHART_DRILL_THROUGH_DSL_MAX_CHARS)} characters. Shorten it to save the drill-through.`;
  }
  if (typeof def.name === "string" && [...def.name].length > CHART_DRILL_THROUGH_NAME_MAX_CHARS) {
    return `The drill-through's name is longer than ${limit(CHART_DRILL_THROUGH_NAME_MAX_CHARS)} characters. Shorten it to save the drill-through.`;
  }
  return `This drill-through cannot be saved:\n${violations.slice(0, 5).join("\n")}`;
}

/**
 * THE one write of a chart's drill-through definition (see the file header):
 * `undefined` removes it; a definition is written clear-then-set; then the
 * applySpec choreography and the flush, inside one undo step. A definition the
 * schema refuses is refused FIRST (it throws with the sentence, nothing is
 * written and no undo step opens). Throws with the backend's reason when the
 * save was refused (the store has rolled the chart back and the chart is
 * repainted from what it now holds).
 */
export async function commitDrillThroughDefinition(
  chartId: string,
  def: DrillThroughDefinition | undefined,
): Promise<void> {
  if (def) {
    const refusal = drillDefinitionRefusal(def);
    if (refusal !== null) throw new Error(refusal);
  }
  await runInUndoTransaction(DRILL_THROUGH_UNDO_LABEL, async () => {
    updateChartSpec(chartId, { drillThrough: undefined });
    if (def) updateChartSpec(chartId, { drillThrough: def });
    invalidateChartCache(chartId);
    syncChartRegions();
    window.dispatchEvent(new Event(ChartEvents.CHART_UPDATED));
    const failures = await flushPendingChartSavesQuietly();
    const mine = failures.filter((f) => f.chartId === chartId);
    const other = failures.filter((f) => f.chartId !== chartId);
    if (other.length > 0) void reportChartFailures(other);
    if (mine.length > 0) {
      // The store rolled the chart back; repaint what it now holds.
      invalidateChartCache(chartId);
      syncChartRegions();
      window.dispatchEvent(new Event(ChartEvents.CHART_UPDATED));
      throw new Error(mine.map((f) => f.reason).filter((r) => r !== "").join(" ") || "The chart could not be saved.");
    }
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============================================================================
// Styles (the layout tokens; nothing hardcoded)
// ============================================================================

const s = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0, 0, 0, 0.35)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10000,
  } as React.CSSProperties,
  card: {
    position: "relative",
    background: LT.surface,
    color: LT.text,
    borderRadius: LT.radiusPopover,
    boxShadow: LT.shadowRaised,
    width: "min(760px, 94vw)",
    maxHeight: "88vh",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    fontSize: 13,
  } as React.CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 18px",
    borderBottom: `1px solid ${LT.border}`,
    cursor: "move",
    flexShrink: 0,
  } as React.CSSProperties,
  title: { fontSize: 15, fontWeight: 600 } as React.CSSProperties,
  closeBtn: {
    border: "none",
    background: "none",
    fontSize: 16,
    lineHeight: 1,
    cursor: "pointer",
    color: LT.textSecondary,
  } as React.CSSProperties,
  body: { padding: "14px 18px", overflowY: "auto", minHeight: 0, display: "flex", flexDirection: "column", gap: 8 } as React.CSSProperties,
  muted: { color: LT.textSecondary, padding: "6px 0" } as React.CSSProperties,
  radioRow: { display: "flex", gap: 8, alignItems: "flex-start", padding: "5px 0", cursor: "pointer" } as React.CSSProperties,
  editorSection: { marginTop: 8, paddingTop: 10, borderTop: `1px solid ${LT.controlDivider}` } as React.CSSProperties,
  error: { color: LT.dangerFg, fontSize: 12, whiteSpace: "pre-wrap", padding: "8px 18px 0", flexShrink: 0 } as React.CSSProperties,
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 18px",
    borderTop: `1px solid ${LT.border}`,
    flexShrink: 0,
  } as React.CSSProperties,
  btn: {
    padding: "6px 14px",
    borderRadius: LT.radiusControl,
    border: `1px solid ${LT.controlBorder}`,
    background: LT.surface,
    color: LT.text,
    cursor: "pointer",
    fontSize: 13,
  } as React.CSSProperties,
  btnPrimary: {
    padding: "6px 14px",
    borderRadius: LT.radiusControl,
    border: "1px solid transparent",
    background: LT.accentColor,
    color: LT.onAccent,
    cursor: "pointer",
    fontSize: 13,
  } as React.CSSProperties,
};

// ============================================================================
// Component
// ============================================================================

export function DrillThroughBehaviorDialog({ isOpen, onClose, data }: DialogProps): React.ReactElement | null {
  const chartId = typeof data?.chartId === "string" ? data.chartId : "";
  const readOnly = data?.readOnly === true;
  const openCount = data?.__openCount;

  // Movable + resizable window (the shared @api hook); wide enough for the
  // DSL editor beside its inline assist.
  const win = useDialogWindow({ minWidth: 560, minHeight: 360 });

  const [chart, setChart] = useState<ChartDefinition | undefined>(undefined);
  const [stored, setStored] = useState<DrillThroughDefinition | undefined>(undefined);
  const [mode, setMode] = useState<DrillMode>("none");
  const [draft, setDraft] = useState<DrillThroughDefinition>({ dslText: "", presentation: { kind: "table" } });
  const [biModel, setBiModel] = useState<BiPivotModelInfo | null>(null);
  const [modelNote, setModelNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed from the chart on every show (see the header: a re-show does not remount).
  useEffect(() => {
    if (!isOpen) return;
    const c = getChartById(chartId) ?? undefined;
    const def = c && isDesignQueryDataSource(c.spec.data) ? c.spec.drillThrough : undefined;
    setChart(c);
    setStored(def);
    setMode(def ? "designQuery" : "none");
    setDraft(def ?? startingDrillDraft(c));
    setSaving(false);
    setError(null);
  }, [isOpen, chartId, openCount]);

  const isDesignQuery = !!chart && isDesignQueryDataSource(chart.spec.data);
  const connectionId = chart && isDesignQueryDataSource(chart.spec.data) ? String(chart.spec.data.connectionId ?? "") : "";

  // The connection's model: the editor's completions and the compile context.
  useEffect(() => {
    if (!isOpen) return;
    if (!connectionId) {
      setBiModel(null);
      setModelNote(isDesignQuery ? DESIGN_QUERY_MODEL_NOT_LOADED : null);
      return;
    }
    let cancelled = false;
    setBiModel(null);
    setModelNote(null);
    chartsBackend
      .invoke<BiPivotModelInfo | null>("get_connection_bi_model", { connectionId })
      .then((m) => {
        if (cancelled) return;
        setBiModel(m);
        setModelNote(m ? null : DESIGN_QUERY_MODEL_NOT_LOADED);
      })
      .catch((err: unknown) => {
        if (!cancelled) setModelNote(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, connectionId, isDesignQuery]);

  const handleSave = useCallback(async () => {
    if (readOnly || !chart || !isDesignQuery) return;
    setError(null);
    let next: DrillThroughDefinition | undefined;
    if (mode === "designQuery") {
      next = normalizeDrillDefinition(draft);
      if (!next.dslText.trim()) {
        setError(DRILL_THROUGH_EMPTY_QUERY);
        return;
      }
      // The schema's own bounds on the DEFINITION (a too-long query, a mark
      // createChart would refuse, options the mark does not have), whether or
      // not the model is at hand: without the model nothing else checks the
      // text. Never the merged spec (see validateDrillThroughDefinition).
      const invalid = drillDefinitionRefusal(next);
      if (invalid !== null) {
        setError(invalid);
        return;
      }
      // Validated against the model when it is at hand -- a definition that
      // can never run is refused with the compiler's sentences. Without the
      // model (the connection is closed) the text is kept as written.
      if (biModel) {
        const refusal = designQueryRefusal(next.dslText, connectionId, biModel);
        if (refusal !== null) {
          setError(refusal);
          return;
        }
      }
    }
    if (sameDrillDefinition(stored, next)) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await commitDrillThroughDefinition(chart.chartId, next);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }, [readOnly, chart, isDesignQuery, mode, draft, biModel, connectionId, stored, onClose]);

  if (!isOpen) return null;

  const chartLabel = chart?.spec.title ?? chart?.name ?? "Chart";
  const sourceLabel = `the chart "${chartLabel}"`;
  const showEditor = mode === "designQuery" && isDesignQuery;

  return (
    <div style={s.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={win.ref} style={{ ...s.card, ...win.style }} data-testid="drill-through-dialog" data-readonly={readOnly ? "true" : "false"}>
        <div style={s.header} onMouseDown={win.onHeaderMouseDown}>
          <span style={s.title}>{DRILL_THROUGH_DIALOG_TITLE}</span>
          <button style={s.closeBtn} onClick={onClose} aria-label="Close" data-testid="drill-through-close">
            X
          </button>
        </div>

        <div style={s.body}>
          {!chart ? (
            <div style={s.muted}>The chart no longer exists.</div>
          ) : !isDesignQuery ? (
            <div style={s.muted} data-testid="drill-through-not-design-query">
              {DRILL_THROUGH_NOT_DESIGN_QUERY}
            </div>
          ) : (
            <>
              {readOnly ? (
                <div style={s.muted} data-testid="drill-through-view-only">
                  {stored
                    ? "This definition came with the application. You can run it from the chart's right-click menu; only its publisher can change it."
                    : "This chart has no drill-through."}
                </div>
              ) : (
                <>
                  <label style={s.radioRow}>
                    <input
                      type="radio"
                      name="chartDrillMode"
                      checked={mode === "none"}
                      onChange={() => setMode("none")}
                      data-testid="drill-through-mode-none"
                    />
                    <span>
                      <strong>None</strong> - a right-click on a bar, slice, point or legend entry offers no drill-through
                    </span>
                  </label>
                  <label style={s.radioRow}>
                    <input
                      type="radio"
                      name="chartDrillMode"
                      checked={mode === "designQuery"}
                      onChange={() => setMode("designQuery")}
                      data-testid="drill-through-mode-designQuery"
                    />
                    <span>
                      <strong>Design query</strong> - run a design query for the clicked member and show the result on a
                      temporary sheet
                    </span>
                  </label>
                </>
              )}

              {showEditor && (
                <div style={s.editorSection}>
                  {modelNote && (
                    <div style={{ ...s.muted, paddingTop: 0 }} data-testid="drill-through-model-note">
                      {modelNote}
                    </div>
                  )}
                  <DrillThroughDefinitionEditor
                    value={draft}
                    onChange={setDraft}
                    connectionId={connectionId}
                    biModel={biModel}
                    invoke={chartsBackend.invoke}
                    readOnly={readOnly}
                    sourceLabel={sourceLabel}
                  />
                </div>
              )}
            </>
          )}
        </div>

        {error && (
          <div style={s.error} data-testid="drill-through-error">
            {error}
          </div>
        )}

        <div style={s.footer}>
          {readOnly ? (
            <button style={s.btn} onClick={onClose} data-testid="drill-through-cancel">
              Close
            </button>
          ) : (
            <>
              <button style={s.btn} onClick={onClose} disabled={saving} data-testid="drill-through-cancel">
                Cancel
              </button>
              <button
                style={{ ...s.btnPrimary, opacity: saving || !isDesignQuery ? 0.5 : 1 }}
                onClick={() => void handleSave()}
                disabled={saving || !isDesignQuery}
                data-testid="drill-through-save"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </>
          )}
        </div>
        {win.resizeHandles}
      </div>
    </div>
  );
}

export default DrillThroughBehaviorDialog;

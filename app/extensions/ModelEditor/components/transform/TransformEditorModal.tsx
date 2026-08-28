// FILENAME: app/extensions/ModelEditor/components/transform/TransformEditorModal.tsx
// PURPOSE: The per-table transformation ("applied steps") editor: a modal
//          holding a DRAFT pipeline, a live derived schema, and a sampled
//          preview as of the selected step. Committing is one explicit action.
//
// Why a modal and not a nav section: a pipeline is per-TABLE state, and the
// Tables section already owns the table list — a section would have to
// duplicate that list to be usable at all.
//
// Two rules the rest of this file exists to honour:
//   * `biModelTransformSet` is ONE model edit, so it is ONE undo entry. The
//     draft therefore never writes per-keystroke; the author commits with
//     "Apply steps".
//   * A preview is a SAMPLE. When the backend reports `sampled`, the numbers on
//     screen are indicative and must be presented that way, never as the total
//     a refresh will produce.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  biModelCancelQuery,
  biModelTransformDeriveSchema,
  biModelTransformPreview,
  biModelTransformSet,
  biModelTransformToScript,
} from "@api";
import type {
  ModelColumnInfo,
  ModelOverview,
  ModelTableInfo,
  TransformDiagnosticDto,
  TransformPreviewResult,
  TransformSchemaResult,
  TransformStepDto,
} from "@api";
import { confirmAsync } from "@api/dialogs";
import { Badge, Modal, styles } from "../editorShared";
import { PreviewGrid } from "./PreviewGrid";
import { SOURCE_ROW, StepList } from "./StepList";
import { StepConfigForm } from "./StepConfigForms";
import { ScriptPane } from "./ScriptPane";
import { defaultStep, describeStep } from "./stepKit";

/** The backend caps a preview at 500 rows; asking for that much keeps the
 *  `truncated` flag meaningful without turning the editor into a report. */
const PREVIEW_ROW_LIMIT = 200;
/** Deriving a schema is pure (no I/O), so it can chase the keystrokes closely. */
const SCHEMA_DEBOUNCE_MS = 250;
/** A preview hits the data source, so it waits for the author to stop typing. */
const PREVIEW_DEBOUNCE_MS = 500;
/** How many distinct values one "detect" sample may declare for a pivot step. */
const MAX_DETECTED_VALUES = 100;

function newQueryId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `q-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

function sameSteps(a: TransformStepDto[], b: TransformStepDto[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function TransformEditorModal({
  connectionId,
  table,
  overview,
  readOnly,
  onClose,
  onApplied,
}: {
  connectionId: string;
  /** The table whose pipeline this edits. Its `transformSteps` seed the draft
   *  and its `sourceColumns` are the pipeline's input — the overview already
   *  carries both, so nothing is fetched to open the editor. */
  table: ModelTableInfo;
  /** The model, for the expression editor's completion and hover. */
  overview: ModelOverview;
  readOnly: boolean;
  onClose: () => void;
  /** The fresh overview `biModelTransformSet` returned. */
  onApplied: (overview: ModelOverview) => void;
}): React.ReactElement {
  // A pipeline lives on the table's SOURCE BINDING, which is exactly what
  // `sourceId` reports. (`bound` is looser — it is also true for a live app
  // binding that carries no pipeline.)
  const bound = table.sourceId !== null;

  // A table with no pipeline yet has no separately recorded source schema: its
  // current columns ARE what the source delivers. Same fallback the backend's
  // deriveSchema uses, so the two never disagree about the Source row.
  const sourceColumns = useMemo<ModelColumnInfo[]>(
    () => (table.sourceColumns.length > 0 ? table.sourceColumns : table.columns),
    [table.sourceColumns, table.columns],
  );

  const [steps, setSteps] = useState<TransformStepDto[]>(table.transformSteps);
  const [savedSteps, setSavedSteps] = useState<TransformStepDto[]>(table.transformSteps);
  const [selected, setSelected] = useState<number>(
    table.transformSteps.length > 0 ? table.transformSteps.length - 1 : SOURCE_ROW,
  );

  const [schema, setSchema] = useState<TransformSchemaResult | null>(null);
  const [inputColumns, setInputColumns] = useState<ModelColumnInfo[]>(sourceColumns);
  const [schemaError, setSchemaError] = useState<string | null>(null);

  const [preview, setPreview] = useState<TransformPreviewResult | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);

  // EVERY backend query this modal has in flight, by id — the preview AND the
  // pivot "detect values" sample. Both hold the backend engine, so both must be
  // reachable from unmount and from the Cancel button; the detect sample used
  // to mint a query id nothing ever recorded, so closing the modal mid-sample
  // left it running.
  const runningQueryIds = useRef<Set<string>>(new Set());
  // The in-flight PREVIEW specifically. A newer preview supersedes it — which
  // must not disturb a detect sample running alongside it.
  const runningPreviewId = useRef<string | null>(null);

  /** Register a new query id as in flight, with its own de-registration. */
  const startQuery = useCallback((): { queryId: string; done: () => void } => {
    const queryId = newQueryId();
    runningQueryIds.current.add(queryId);
    return {
      queryId,
      done: () => {
        runningQueryIds.current.delete(queryId);
      },
    };
  }, []);

  /** Best-effort cancel of one in-flight query, and forget it. */
  const cancelQuery = useCallback((queryId: string) => {
    runningQueryIds.current.delete(queryId);
    void biModelCancelQuery(queryId).catch(() => undefined);
  }, []);

  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyNote, setApplyNote] = useState<string | null>(null);

  const dirty = !sameSteps(steps, savedSteps);

  // ── Derived schema (cheap, no I/O — runs on every draft change) ───────────
  // Two derivations per pass: the WHOLE pipeline (the resulting-columns rail
  // and the step diagnostics) and the PREFIX before the selected step (the
  // columns its pickers must offer).
  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(() => {
      const prefix = selected >= 0 ? steps.slice(0, selected) : [];
      void Promise.all([
        biModelTransformDeriveSchema(connectionId, table.name, steps),
        selected >= 0
          ? biModelTransformDeriveSchema(connectionId, table.name, prefix)
          : Promise.resolve(null),
      ])
        .then(([whole, upToSelected]) => {
          if (cancelled) return;
          setSchema(whole);
          setInputColumns(upToSelected ? upToSelected.columns : sourceColumns);
          setSchemaError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setSchemaError(String(err));
        });
    }, SCHEMA_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [connectionId, table.name, steps, selected, sourceColumns]);

  // ── Preview (hits the source; debounced, cancellable) ─────────────────────
  useEffect(() => {
    if (!bound) return undefined;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      const previous = runningPreviewId.current;
      if (previous) cancelQuery(previous);
      const { queryId, done } = startQuery();
      runningPreviewId.current = queryId;
      setPreviewBusy(true);
      setPreviewError(null);
      void biModelTransformPreview({
        connectionId,
        table: table.name,
        steps,
        // -1 is the Source row; step i is previewed AFTER it has run.
        asOfStep: selected === SOURCE_ROW ? SOURCE_ROW : selected + 1,
        rowLimit: PREVIEW_ROW_LIMIT,
        queryId,
      })
        .then((result) => {
          if (!cancelled) setPreview(result);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(String(err));
        })
        .finally(() => {
          done();
          if (runningPreviewId.current === queryId) runningPreviewId.current = null;
          if (!cancelled) setPreviewBusy(false);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [connectionId, table.name, steps, selected, previewNonce, bound, startQuery, cancelQuery]);

  // Closing mid-sample must not leave ANY query running on the connection —
  // the preview or a detect sample. The ref's Set identity never changes, so
  // capturing it here is safe for the cleanup that runs at unmount.
  useEffect(() => {
    const ids = runningQueryIds.current;
    return () => {
      for (const id of ids) void biModelCancelQuery(id).catch(() => undefined);
      ids.clear();
    };
  }, []);

  // ── Draft edits ───────────────────────────────────────────────────────────

  const addStep = (type: string) => {
    // A new step is appended, so the columns it sees are the pipeline's output.
    const columnsAtEnd = schema?.columns ?? sourceColumns;
    setSteps((prev) => [...prev, defaultStep(type, columnsAtEnd)]);
    setSelected(steps.length);
    setApplyNote(null);
  };

  const removeStep = (index: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
    setSelected((prev) => {
      if (prev === index) return index - 1;
      return prev > index ? prev - 1 : prev;
    });
    setApplyNote(null);
  };

  const moveStep = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    setSteps((prev) => {
      const next = [...prev];
      const moved = next[index];
      next[index] = next[target];
      next[target] = moved;
      return next;
    });
    setSelected(target);
    setApplyNote(null);
  };

  const updateStep = (index: number, next: TransformStepDto) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? next : s)));
    setApplyNote(null);
  };

  // ── Pivot value detection ─────────────────────────────────────────────────
  // The engine derives a pivot step's output schema without reading data, so
  // its value names are DECLARED. This samples the rows reaching the step and
  // offers what it found — the step editor's job, per the engine's own docs.
  const detectPivotValues = async (nameColumn: string): Promise<string[]> => {
    if (selected < 0) return [];
    if (!nameColumn) throw new Error("Choose the column whose values become columns first.");
    // Registered like the preview, so Cancel and unmount reach this sample too.
    const { queryId, done } = startQuery();
    let result: TransformPreviewResult;
    try {
      result = await biModelTransformPreview({
        connectionId,
        table: table.name,
        // Only the prefix, so a later step that is still mid-edit cannot fail
        // the sample.
        steps: steps.slice(0, selected),
        asOfStep: null,
        rowLimit: PREVIEW_ROW_LIMIT,
        queryId,
      });
    } finally {
      done();
    }
    if (result.diagnostics.length > 0) {
      throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    }
    const column = result.columns.indexOf(nameColumn);
    if (column < 0) throw new Error(`The sample has no column named '${nameColumn}'.`);
    const found: string[] = [];
    for (const row of result.rows) {
      const value = row[column];
      if (value !== null && !found.includes(value)) found.push(value);
      if (found.length >= MAX_DETECTED_VALUES) break;
    }
    return found;
  };

  // ── Commit / discard ──────────────────────────────────────────────────────

  const diagnostics: TransformDiagnosticDto[] = useMemo(
    () => [...(schema?.diagnostics ?? []), ...(preview?.diagnostics ?? [])],
    [schema, preview],
  );
  const schemaHasErrors = (schema?.diagnostics ?? []).some((d) => d.severity === "error");

  const apply = async () => {
    setApplying(true);
    setApplyError(null);
    setApplyNote(null);
    try {
      const applied = steps;
      const result = await biModelTransformSet(connectionId, table.name, applied);
      setSavedSteps(applied);
      setApplyNote(
        applied.length === 0
          ? "Pipeline cleared. One undo step."
          : `Applied ${applied.length} step${applied.length === 1 ? "" : "s"}. One undo step.`,
      );
      onApplied(result);
    } catch (err: unknown) {
      setApplyError(String(err));
    } finally {
      setApplying(false);
    }
  };

  const requestClose = async () => {
    if (dirty && !(await confirmAsync("Discard the unapplied transformation steps?"))) return;
    onClose();
  };

  /** Cancel everything this modal has in flight — the preview and any sample. */
  const cancelRunningQueries = async () => {
    const ids = [...runningQueryIds.current];
    runningQueryIds.current.clear();
    runningPreviewId.current = null;
    await Promise.all(
      ids.map((id) =>
        biModelCancelQuery(id).catch(() => {
          /* best-effort */
        }),
      ),
    );
  };

  // ── Script view ───────────────────────────────────────────────────────────
  //
  // The same pipeline, as text. Entering renders the DRAFT (not the last thing
  // applied), and the buffer compiles back into the draft on every pause, so
  // the preview, the resulting-columns rail and Apply all keep working off one
  // set of steps whichever view is on screen.
  const [mode, setMode] = useState<"steps" | "script">("steps");
  const [scriptSeed, setScriptSeed] = useState<string | null>(null);
  const [scriptSeedError, setScriptSeedError] = useState<string | null>(null);
  const [scriptParses, setScriptParses] = useState(true);

  const enterScript = useCallback(() => {
    setScriptSeed(null);
    setScriptSeedError(null);
    setMode("script");
    void biModelTransformToScript(connectionId, table.name, steps)
      .then((result) => setScriptSeed(result.script))
      .catch((err: unknown) => setScriptSeedError(String(err)));
  }, [connectionId, table.name, steps]);

  const enterSteps = useCallback(() => {
    setMode("steps");
    setScriptParses(true);
    // The draft already holds the last good parse, so nothing is lifted here.
    // Keep the selection in range: the script may have removed steps.
    setSelected((current) => (current >= steps.length ? steps.length - 1 : current));
  }, [steps.length]);

  const onScriptParsed = useCallback((next: TransformStepDto[]) => {
    setSteps((current) => (sameSteps(current, next) ? current : next));
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  const selectedStep = selected >= 0 && selected < steps.length ? steps[selected] : null;
  const previewTitle =
    selected === SOURCE_ROW
      ? "Preview — Source (before any step)"
      : `Preview as of step ${selected + 1}${selectedStep ? ` — ${describeStep(selectedStep)}` : ""}`;

  const resultColumns = schema?.columns ?? [];

  return (
    <Modal
      title={`Transform ${table.name}`}
      width={1120}
      onClose={() => void requestClose()}
      footer={
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, alignSelf: "center" }}>
            {applyError && (
              <span style={{ color: "#a4262c", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {applyError}
              </span>
            )}
            {!applyError && applyNote && <span style={styles.muted}>{applyNote}</span>}
            {!applyError && !applyNote && dirty && (
              <span style={styles.muted}>Unapplied changes.</span>
            )}
          </div>
          <button style={styles.btn} disabled={applying} onClick={() => void requestClose()}>
            {dirty ? "Discard" : "Close"}
          </button>
          <button
            style={styles.primaryBtn}
            disabled={
              readOnly || applying || !dirty || !bound || schemaHasErrors || !scriptParses
            }
            title={
              !bound
                ? "Bind this table to a data source before giving it steps"
                : !scriptParses
                  ? "The script does not read yet — fix it before applying"
                  : schemaHasErrors
                    ? "Fix the step the diagnostic points at first"
                    : "Replace this table's pipeline — one model edit, one undo step"
            }
            onClick={() => void apply()}
          >
            {applying ? "Applying…" : "Apply steps"}
          </button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", height: "70vh", minHeight: 0 }}>
        {readOnly && (
          <div style={{ ...styles.hint, marginBottom: 6 }}>
            This model does not accept edits — the pipeline is shown for inspection only.
          </div>
        )}
        {!bound && (
          <div
            style={{
              ...styles.card,
              border: "1px solid #e2b04a",
              background: "#fdf6e3",
              padding: 8,
              marginBottom: 8,
              fontSize: 12,
            }}
          >
            <strong>Not bound to a data source.</strong> Steps turn the rows a connector returns
            into the rows the table declares, so this table has nothing to transform yet. Bind it
            under the table&apos;s detail pane first.
          </div>
        )}
        {bound && steps.length > 0 && (
          <div style={{ ...styles.hint, marginBottom: 6 }}>
            A table with steps is loaded in memory — the steps run over the rows the source
            returns, so DirectQuery is not available for it.
          </div>
        )}
        {schemaError && (
          <div
            style={{
              fontSize: 12,
              color: "#a4262c",
              marginBottom: 6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {schemaError}
          </div>
        )}

        {/* The two views of one pipeline. The steps are the same either way —
            the script is a rendering of them, compiled back before anything is
            stored — so switching is not an edit. */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
          <div style={{ display: "flex", border: "1px solid #ccc", borderRadius: 4 }}>
            <button
              style={{
                ...styles.smallBtn,
                border: "none",
                borderRadius: "3px 0 0 3px",
                background: mode === "steps" ? "#0b5cad" : "transparent",
                color: mode === "steps" ? "#fff" : undefined,
              }}
              onClick={enterSteps}
            >
              Steps
            </button>
            <button
              style={{
                ...styles.smallBtn,
                border: "none",
                borderRadius: "0 3px 3px 0",
                background: mode === "script" ? "#0b5cad" : "transparent",
                color: mode === "script" ? "#fff" : undefined,
              }}
              onClick={enterScript}
              title="Edit the whole pipeline as text — copy it between tables, diff it, paste one you were sent"
            >
              Script
            </button>
          </div>
          <span style={styles.hint}>
            {mode === "steps"
              ? "One step at a time, with a form for each."
              : "The whole pipeline as text. The steps stay the stored form; this is a rendering of them."}
          </span>
        </div>

        <div style={{ display: "flex", gap: 12, flex: 1, minHeight: 0 }}>
          {/* Rail 1: the pipeline — the step list, or the script buffer */}
          {mode === "script" ? (
            <div
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
              }}
            >
              {scriptSeedError !== null && (
                <div style={{ fontSize: 12, color: "#a4262c", marginBottom: 6 }}>
                  {scriptSeedError}
                </div>
              )}
              {scriptSeed === null && scriptSeedError === null && (
                <div style={styles.hint}>Rendering the pipeline…</div>
              )}
              {scriptSeed !== null && (
                <ScriptPane
                  connectionId={connectionId}
                  tableName={table.name}
                  initialScript={scriptSeed}
                  sourceColumns={sourceColumns}
                  readOnly={readOnly}
                  onParsed={onScriptParsed}
                  onParseStateChange={setScriptParses}
                />
              )}
            </div>
          ) : (
          <div
            style={{
              width: 280,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <StepList
              steps={steps}
              selected={selected}
              diagnostics={diagnostics}
              readOnly={readOnly}
              onSelect={(index) => setSelected(index)}
              onAdd={addStep}
              onRemove={removeStep}
              onMove={moveStep}
            />
          </div>
          )}

          {/* Rail 2: the selected step's form, over its preview. In Script mode
              the form is gone (the text IS the form) but the preview stays —
              seeing the rows change is the point of editing either way. */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              gap: 8,
            }}
          >
            <div
              style={{
                ...styles.card,
                padding: 10,
                maxHeight: "48%",
                overflowY: "auto",
                flexShrink: 0,
                display: mode === "script" ? "none" : undefined,
              }}
            >
              {selectedStep === null ? (
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>Source</div>
                  <div style={{ ...styles.hint, marginBottom: 8 }}>
                    The rows the connector returns, before any step runs. Everything below is
                    derived from these {sourceColumns.length} column
                    {sourceColumns.length === 1 ? "" : "s"}.
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {sourceColumns.map((c) => (
                      <span
                        key={c.name}
                        style={{
                          fontSize: 11,
                          border: "1px solid #ddd",
                          borderRadius: 3,
                          padding: "1px 6px",
                          background: "#fafafa",
                        }}
                        title={c.dataType}
                      >
                        {c.name}
                      </span>
                    ))}
                    {sourceColumns.length === 0 && (
                      <span style={styles.hint}>No source columns recorded yet.</span>
                    )}
                  </div>
                </div>
              ) : (
                <StepConfigForm
                  step={selectedStep}
                  index={selected}
                  inputColumns={inputColumns}
                  overview={overview}
                  tableName={table.name}
                  readOnly={readOnly}
                  onChange={(next) => updateStep(selected, next)}
                  onDetectPivotValues={detectPivotValues}
                />
              )}
            </div>

            <div
              style={{
                ...styles.card,
                padding: 10,
                flex: 1,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <PreviewGrid
                title={previewTitle}
                result={preview}
                busy={previewBusy}
                error={previewError}
                disabledReason={
                  bound ? null : "A preview needs a bound data source to sample from."
                }
                onRefresh={() => setPreviewNonce((n) => n + 1)}
                onCancel={() => void cancelRunningQueries()}
              />
            </div>
          </div>

          {/* Rail 3: the columns the whole pipeline produces */}
          <div
            style={{
              width: 210,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <div style={{ ...styles.label, marginBottom: 4 }}>
              Resulting columns{resultColumns.length > 0 ? ` (${resultColumns.length})` : ""}
            </div>
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: "auto",
                border: "1px solid #ddd",
                borderRadius: 4,
                background: "#fff",
                padding: "2px 0",
              }}
            >
              {resultColumns.length === 0 && (
                <div style={{ ...styles.hint, padding: "4px 8px" }}>
                  {schemaHasErrors
                    ? "The pipeline does not derive a schema yet."
                    : "Nothing derived yet."}
                </div>
              )}
              {resultColumns.map((c) => (
                <div
                  key={c.name}
                  style={{
                    padding: "2px 8px",
                    fontSize: 12,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={c.name}
                  >
                    {c.name}
                  </span>
                  <span style={{ ...styles.muted, fontSize: 10, whiteSpace: "nowrap" }}>
                    {c.dataType}
                  </span>
                </div>
              ))}
            </div>
            {schemaHasErrors && (
              <div style={{ marginTop: 4 }}>
                <Badge tone="warn">up to the failing step</Badge>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

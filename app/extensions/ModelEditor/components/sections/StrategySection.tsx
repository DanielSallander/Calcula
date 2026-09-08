// FILENAME: app/extensions/ModelEditor/components/sections/StrategySection.tsx
// PURPOSE: The Strategy tab — where a person turns an inferred draft into a
//          strategy they trust. Three grids (measures, tables+columns, rules),
//          a findings strip, and the four actions: Validate, Run tests, Save,
//          Infer.
// CONTEXT: Four properties are the design, not decoration.
//
//          (1) CONFIRMED vs INFERRED IS THE TAB. An entry with
//          `reviewed: false` is a machine's guess and renders muted with an
//          "inferred" chip; a confirmed one renders plainly. That contrast is
//          the whole reason this surface exists, so the styling is derived
//          from `reviewed` in ONE place (`rowTone`) rather than sprinkled.
//
//          (2) NOTHING WRITES UNTIL SAVE. Every edit lands in local state.
//          Save calls `op: "set"`, and a REFUSED write comes back
//          `{ written: false, findings }` on a RESOLVED promise — so the save
//          handler branches on `written`, never on try/catch. Treating a
//          refusal as a thrown error would report success and discard the
//          reasons in the same breath.
//
//          (3) THE SCOPE EDITOR CANNOT TAKE A TYPED COLUMN NAME. The column is
//          a <select> over the model's own columns, and `buildRuleFromDraft`
//          re-checks every scope column against the model before the rule is
//          accepted. A typo in a scope is not a broken rule — it is a rule that
//          silently NEVER FIRES, which looks exactly like a rule that was never
//          needed.
//
//          (4) INFER DISCARDS. It replaces the draft wholesale, including
//          unconfirmed edits, so it asks first with `confirmAsync` and AWAITS
//          the answer (the Tauri shim returns a Promise; an un-awaited
//          `if (!confirm(...))` tests `!Promise` and never fires).

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelOverview } from "@api";
import { confirmAsync } from "@api/dialogs";
import { Badge, Field, Modal, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";
import {
  strategyGet,
  strategyRunTests,
  strategySet,
  strategyValidate,
} from "../../lib/strategyBackend";
import {
  ADDITIVITIES,
  CADENCES,
  DIRECTIONS,
  ROLES,
  TABLE_KINDS,
  UNITS,
  confirmAll,
  emptyStrategyDoc,
  findingsAtPath,
  formatMaterialitySpec,
  formatTargetSpec,
  hasErrors,
  inferStrategyDraft,
  measureEntry,
  measurePath,
  modelColumnRefs,
  modelHasColumn,
  parseMaterialitySpec,
  parseTargetSpec,
  rulePath,
  tableEntry,
  tablePath,
  withColumn,
  withMeasure,
  withRule,
  withTable,
  withoutRule,
} from "../../lib/strategyTypes";
import type {
  AttributeSet,
  Additivity,
  Cadence,
  Direction,
  Finding,
  Materiality,
  Role,
  Rule,
  Scope,
  ScopeValue,
  StrategyDoc,
  TableKind,
  Target,
  Unit,
} from "../../lib/strategyTypes";

// ===========================================================================
// Rule drafts (the modal's editable shape) and the guard that accepts one
// ===========================================================================

/** One scope clause while it is being edited. */
export interface ScopeClauseDraft {
  /** `Table[Column]`, chosen from the model — never typed. */
  column: string;
  kind: "members" | "dateRange";
  /** Comma-separated members, for kind "members". */
  members: string;
  from: string;
  to: string;
}

export interface RuleDraft {
  id: string;
  measure: string;
  scope: ScopeClauseDraft[];
  direction: string;
  target: string;
  materiality: string;
  cadence: string;
  suppress: string;
  rankWeight: string;
  note: string;
}

export function emptyRuleDraft(): RuleDraft {
  return {
    id: "",
    measure: "",
    scope: [],
    direction: "",
    target: "",
    materiality: "",
    cadence: "",
    suppress: "",
    rankWeight: "",
    note: "",
  };
}

export function ruleToDraft(rule: Rule): RuleDraft {
  return {
    id: rule.id,
    measure: rule.measure,
    scope: Object.entries(rule.scope ?? {}).map(([column, value]) =>
      Array.isArray(value)
        ? { column, kind: "members" as const, members: value.join(", "), from: "", to: "" }
        : {
            column,
            kind: "dateRange" as const,
            members: "",
            from: value.from,
            // An absent end bound is "onwards"; the editor shows it as blank.
            to: value.to ?? "",
          },
    ),
    direction: rule.set.direction ?? "",
    target: formatTargetSpec(rule.set.target),
    materiality: formatMaterialitySpec(rule.set.materiality),
    cadence: rule.set.cadence ?? "",
    suppress: (rule.set.suppress ?? []).join(", "),
    rankWeight: rule.set.rankWeight !== undefined ? String(rule.set.rankWeight) : "",
    note: rule.note ?? "",
  };
}

/**
 * Turn a draft into a rule, or say why it cannot be one.
 *
 * The column check is the load-bearing one and is deliberately duplicated from
 * the <select> that produced the value: a scope naming a column the model does
 * not have is a rule that never fires, and nothing downstream would ever
 * mention it — `validate` reports it, but only once it has been SAVED.
 */
export function buildRuleFromDraft(
  overview: ModelOverview,
  draft: RuleDraft,
): { ok: true; rule: Rule } | { ok: false; error: string } {
  const id = draft.id.trim();
  if (id === "") return { ok: false, error: "A rule needs an id — findings name the rule that produced them." };
  if (draft.measure === "") return { ok: false, error: "A rule must annotate a measure." };
  if (!overview.measures.some((m) => m.name === draft.measure)) {
    return { ok: false, error: `'${draft.measure}' is not a measure in this model.` };
  }

  const scope: Scope = {};
  for (const clause of draft.scope) {
    if (clause.column === "") return { ok: false, error: "Every scope row needs a column." };
    if (!modelHasColumn(overview, clause.column)) {
      return { ok: false, error: `'${clause.column}' is not a column in this model.` };
    }
    if (scope[clause.column] !== undefined) {
      return { ok: false, error: `'${clause.column}' is constrained twice; a column may appear once.` };
    }
    if (clause.kind === "members") {
      const members = clause.members
        .split(",")
        .map((m) => m.trim())
        .filter((m) => m !== "");
      if (members.length === 0) {
        return { ok: false, error: `'${clause.column}' is constrained to no members, so the scope is empty.` };
      }
      scope[clause.column] = members;
    } else {
      if (clause.from === "") {
        return { ok: false, error: `'${clause.column}' needs a from date.` };
      }
      // The end bound is OPTIONAL: "the Nordics floor took effect in 2025" has
      // no end, and inventing one would make the rule stop firing next year.
      scope[clause.column] =
        clause.to === "" ? { from: clause.from } : { from: clause.from, to: clause.to };
    }
  }

  const set: AttributeSet = {};
  if (draft.direction !== "") set.direction = draft.direction as Direction;
  if (draft.cadence !== "") set.cadence = draft.cadence as Cadence;

  const target = parseTargetSpec(draft.target);
  if (!target.ok) return { ok: false, error: target.error };
  if (target.target !== undefined) set.target = target.target;

  const materiality = parseMaterialitySpec(draft.materiality);
  if (!materiality.ok) return { ok: false, error: materiality.error };
  if (materiality.materiality !== undefined) set.materiality = materiality.materiality;

  const suppress = draft.suppress
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (suppress.length > 0) set.suppress = suppress;

  if (draft.rankWeight.trim() !== "") {
    const weight = Number(draft.rankWeight);
    if (!Number.isFinite(weight)) {
      return { ok: false, error: `Rank weight must be a number (got '${draft.rankWeight}').` };
    }
    set.rankWeight = weight;
  }

  const note = draft.note.trim();
  return {
    ok: true,
    rule: { id, measure: draft.measure, scope, set, note: note === "" ? undefined : note },
  };
}

// ===========================================================================
// Small presentation helpers
// ===========================================================================

/** The ONE place `reviewed` becomes a look. Muted + an "inferred" chip. */
function rowTone(reviewed: boolean): React.CSSProperties {
  return reviewed
    ? { color: "#222", background: "transparent" }
    : { color: "#8a8a8a", background: "#fbfaf5", fontStyle: "italic" };
}

const cellStyle: React.CSSProperties = { ...styles.td, whiteSpace: "nowrap" };

const smallInput: React.CSSProperties = { ...styles.input, fontSize: 12, padding: "2px 4px" };

function selectOf<T extends string>(
  value: T | "",
  options: readonly T[],
  onChange: (v: T | "") => void,
  disabled: boolean,
  width = 128,
): React.ReactElement {
  return (
    <select
      style={{ ...smallInput, width }}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T | "")}
    >
      <option value="">—</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

/**
 * A text cell whose content is a compact SPEC (a target, a materiality).
 *
 * It commits only what parses. An unreadable value keeps the typed text and
 * turns the border red rather than silently reverting, because a value that
 * vanishes on blur reads as "accepted".
 */
function SpecInput<T>({
  value,
  parse,
  onCommit,
  disabled,
  placeholder,
  width = 118,
}: {
  value: string;
  parse: (text: string) => { ok: true; value: T | undefined } | { ok: false; error: string };
  onCommit: (value: T | undefined) => void;
  disabled: boolean;
  placeholder: string;
  width?: number;
}): React.ReactElement {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(value);
    setError(null);
  }, [value]);
  return (
    <input
      style={{
        ...smallInput,
        width,
        borderColor: error ? "#a4262c" : "#ccc",
      }}
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      title={error ?? placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => {
        const parsed = parse(e.target.value);
        if (!parsed.ok) {
          setError(parsed.error);
          return;
        }
        setError(null);
        onCommit(parsed.value);
      }}
    />
  );
}

/** Chips of `Table[Column]` refs with an add-from-the-model picker. */
function ColumnRefList({
  refs,
  options,
  onChange,
  disabled,
}: {
  refs: string[];
  options: string[];
  onChange: (refs: string[]) => void;
  disabled: boolean;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", minWidth: 220 }}>
      {refs.map((r) => (
        <span
          key={r}
          style={{
            background: "#eef0f2",
            borderRadius: 3,
            padding: "1px 4px",
            fontSize: 11,
            whiteSpace: "nowrap",
          }}
        >
          {r}
          <button
            style={{ ...styles.smallBtn, marginLeft: 4, padding: "0 4px" }}
            disabled={disabled}
            title={`Remove ${r}`}
            onClick={() => onChange(refs.filter((x) => x !== r))}
          >
            &times;
          </button>
        </span>
      ))}
      <select
        style={{ ...smallInput, width: 150 }}
        value=""
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === "") return;
          if (!refs.includes(e.target.value)) onChange([...refs, e.target.value]);
        }}
      >
        <option value="">add column…</option>
        {options
          .filter((o) => !refs.includes(o))
          .map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
      </select>
    </div>
  );
}

/** The per-row finding marker: how many findings this row's path carries. */
function RowFindings({ findings }: { findings: Finding[] }): React.ReactElement | null {
  if (findings.length === 0) return null;
  const worst = hasErrors(findings) ? "error" : "warning";
  return (
    <span title={findings.map((f) => `${f.code}: ${f.message}`).join("\n")}>
      <Badge tone={worst === "error" ? "warn" : "neutral"}>
        {worst === "error" ? "error" : "warning"}
        {findings.length > 1 ? ` ×${findings.length}` : ""}
      </Badge>
    </span>
  );
}

/** Confirmed / inferred, with the Confirm action beside it. */
function ReviewedCell({
  reviewed,
  onConfirm,
  disabled,
  label,
}: {
  reviewed: boolean;
  onConfirm: () => void;
  disabled: boolean;
  label: string;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {reviewed ? (
        <Badge tone="ok">confirmed</Badge>
      ) : (
        <>
          <Badge tone="warn">inferred</Badge>
          <button
            style={styles.smallBtn}
            disabled={disabled}
            title={`Confirm ${label} — mark it as agreed by a human`}
            onClick={onConfirm}
          >
            Confirm
          </button>
        </>
      )}
    </div>
  );
}

// ===========================================================================
// The section
// ===========================================================================

export function StrategySection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, reportError } = ctx;

  const [doc, setDoc] = useState<StrategyDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ original: Rule | null } | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // A slow load for a connection the user has already left must not install
  // its document over the newer one.
  const loadSeq = useRef(0);
  useEffect(() => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setDoc(null);
    setFindings([]);
    setStatus(null);
    void strategyGet(connectionId)
      .then((stored) => {
        if (loadSeq.current !== seq) return;
        setDoc(stored ?? emptyStrategyDoc());
        setStatus(stored ? null : "This model has no strategy yet — Infer proposes a draft.");
      })
      .catch((err: unknown) => {
        if (loadSeq.current !== seq) return;
        setDoc(emptyStrategyDoc());
        reportError(err);
      })
      .finally(() => {
        if (loadSeq.current === seq) setLoading(false);
      });
  }, [connectionId, reportError]);

  /** Every local edit goes through here. Findings are cleared, because a
   *  finding describes the document that produced it and an edited document
   *  has not been judged yet — a stale error would keep Save locked over a
   *  problem the user just fixed. */
  const edit = useCallback((next: StrategyDoc) => {
    setDoc(next);
    setFindings([]);
    setStatus(null);
  }, []);

  const columnRefs = useMemo(() => modelColumnRefs(overview), [overview]);
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.length - errorCount;
  const disabled = readOnly || busy || doc === null;

  const run = useCallback(
    async (what: string, fn: (d: StrategyDoc) => Promise<void>) => {
      if (!doc) return;
      setBusy(true);
      setStatus(null);
      try {
        await fn(doc);
      } catch (err: unknown) {
        reportError(err);
        setStatus(`${what} failed.`);
      } finally {
        setBusy(false);
      }
    },
    [doc, reportError],
  );

  const onValidate = useCallback(
    () =>
      run("Validate", async (d) => {
        const result = await strategyValidate(connectionId, d);
        setFindings(result.findings);
        setStatus(
          result.findings.length === 0
            ? "Valid — no findings."
            : `${result.findings.length} finding(s).`,
        );
      }),
    [run, connectionId],
  );

  const onRunTests = useCallback(
    () =>
      run("Run tests", async (d) => {
        const result = await strategyRunTests(connectionId, d);
        setFindings(result.findings);
        setStatus(
          result.findings.length === 0
            ? `All ${d.tests?.length ?? 0} inline test(s) pass.`
            : `${result.findings.length} test failure(s).`,
        );
      }),
    [run, connectionId],
  );

  const onSave = useCallback(
    () =>
      run("Save", async (d) => {
        const result = await strategySet(connectionId, d);
        setFindings(result.findings);
        // A refusal RESOLVES. Reporting success here on anything but
        // `written === true` is the bug this branch exists to prevent.
        setStatus(
          result.written
            ? `Saved${result.findings.length > 0 ? ` with ${result.findings.length} warning(s)` : ""}.`
            : "Not saved — the strategy was refused. See the findings below.",
        );
      }),
    [run, connectionId],
  );

  const onInfer = useCallback(async () => {
    // AWAITED: the Tauri shim returns a Promise, so an un-awaited confirm is
    // always truthy and the draft would be replaced without asking.
    const agreed = await confirmAsync(
      "Replace the strategy with a freshly inferred draft?\n\n" +
        "Every entry comes back unconfirmed, and edits you have not saved are discarded.",
    );
    if (!agreed) return;
    setDoc(inferStrategyDraft(overview));
    setFindings([]);
    setStatus("Inferred a fresh draft — nothing is written until you press Save.");
  }, [overview]);

  const onConfirmAll = useCallback(() => {
    if (!doc) return;
    edit(
      confirmAll(
        doc,
        overview.measures.map((m) => m.name),
        overview.tables.map((t) => t.name),
      ),
    );
  }, [doc, edit, overview]);

  if (loading || !doc) {
    return (
      <div style={{ ...styles.muted, padding: 8 }}>
        {loading ? "Loading strategy…" : "No strategy document."}
      </div>
    );
  }

  const saveLabel =
    errorCount > 0
      ? `Save — fix ${errorCount} error${errorCount === 1 ? "" : "s"} first`
      : "Save";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>
          Strategy ({overview.measures.length} measures, {doc.rules?.length ?? 0} rules)
        </span>
        <button style={styles.btn} disabled={busy} onClick={() => void onValidate()}>
          Validate
        </button>
        <button style={styles.btn} disabled={busy} onClick={() => void onRunTests()}>
          Run tests
        </button>
        <button
          style={styles.primaryBtn}
          disabled={disabled || errorCount > 0}
          title={
            errorCount > 0
              ? "The strategy has errors; the backend refuses a document that would make the engine lie."
              : "Store the strategy on the model"
          }
          onClick={() => void onSave()}
        >
          {saveLabel}
        </button>
        <button
          style={styles.btn}
          disabled={disabled}
          title="Replace the draft with a freshly inferred one (asks first)"
          onClick={() => void onInfer()}
        >
          Infer
        </button>
      </div>

      <div style={{ ...styles.hint, display: "flex", gap: 10, alignItems: "center" }}>
        <span>Nothing is written until you press Save.</span>
        {status && <span style={{ color: "#444" }}>{status}</span>}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
        <MeasuresGrid
          doc={doc}
          overview={overview}
          findings={findings}
          selectedPath={selectedPath}
          columnRefs={columnRefs}
          disabled={disabled}
          onEdit={edit}
          onConfirmAll={onConfirmAll}
        />
        <TablesGrid
          doc={doc}
          overview={overview}
          findings={findings}
          selectedPath={selectedPath}
          disabled={disabled}
          onEdit={edit}
        />
        <RulesGrid
          doc={doc}
          findings={findings}
          selectedPath={selectedPath}
          disabled={disabled}
          onAdd={() => setEditing({ original: null })}
          onEditRule={(rule) => setEditing({ original: rule })}
          onDelete={(id) => edit(withoutRule(doc, id))}
        />
        <FindingsStrip findings={findings} onSelect={setSelectedPath} selectedPath={selectedPath} />
      </div>

      {editing && (
        <RuleModal
          overview={overview}
          original={editing.original}
          onClose={() => setEditing(null)}
          onSave={(rule) => {
            edit(withRule(doc, rule));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

// ===========================================================================
// Measures grid
// ===========================================================================

function MeasuresGrid({
  doc,
  overview,
  findings,
  selectedPath,
  columnRefs,
  disabled,
  onEdit,
  onConfirmAll,
}: {
  doc: StrategyDoc;
  overview: ModelOverview;
  findings: Finding[];
  selectedPath: string | null;
  columnRefs: string[];
  disabled: boolean;
  onEdit: (doc: StrategyDoc) => void;
  onConfirmAll: () => void;
}): React.ReactElement {
  return (
    <section>
      <div style={styles.sectionHeader}>
        <span style={{ ...styles.sectionTitle, fontSize: 13 }}>Measures</span>
        <button style={styles.smallBtn} disabled={disabled} onClick={onConfirmAll}>
          Confirm all
        </button>
      </div>
      <div style={{ ...styles.card, padding: 0, overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              {[
                "measure",
                "direction",
                "aggregation",
                "unit",
                "target",
                "materiality",
                "cadence",
                "priority",
                "analysis dimensions",
                "reviewed",
              ].map((h) => (
                <th key={h} style={styles.th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {overview.measures.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={10}>
                  <span style={styles.muted}>This model has no measures.</span>
                </td>
              </tr>
            )}
            {overview.measures.map((m) => {
              const entry = measureEntry(doc, m.name);
              const path = measurePath(m.name);
              const rowFindings = findingsAtPath(findings, path);
              return (
                <tr
                  key={m.name}
                  data-strategy-path={path}
                  data-unconfirmed={entry.reviewed ? "false" : "true"}
                  style={{
                    ...rowTone(entry.reviewed),
                    outline: selectedPath === path ? "2px solid #2f6fce" : "none",
                  }}
                >
                  <td style={cellStyle}>
                    <strong>{m.name}</strong> <span style={styles.hint}>{m.table}</span>{" "}
                    <RowFindings findings={rowFindings} />
                  </td>
                  <td style={cellStyle}>
                    {selectOf<Direction>(
                      entry.direction ?? "",
                      DIRECTIONS,
                      (v) => onEdit(withMeasure(doc, m.name, { direction: v === "" ? undefined : v })),
                      disabled,
                    )}
                  </td>
                  <td style={cellStyle}>
                    {selectOf<Additivity>(
                      entry.aggregation?.default ?? "",
                      ADDITIVITIES,
                      (v) =>
                        onEdit(
                          withMeasure(doc, m.name, {
                            aggregation: v === "" ? undefined : { default: v },
                          }),
                        ),
                      disabled,
                    )}
                  </td>
                  <td style={cellStyle}>
                    {selectOf<Unit>(
                      entry.unit ?? "",
                      UNITS,
                      (v) => onEdit(withMeasure(doc, m.name, { unit: v === "" ? undefined : v })),
                      disabled,
                      98,
                    )}
                  </td>
                  <td style={cellStyle}>
                    <SpecInput<Target>
                      value={formatTargetSpec(entry.target)}
                      placeholder="1000 | kpi | measure:Budget | band:0.8,1.2"
                      disabled={disabled}
                      parse={(t) => {
                        const r = parseTargetSpec(t);
                        return r.ok ? { ok: true, value: r.target } : r;
                      }}
                      onCommit={(target) => onEdit(withMeasure(doc, m.name, { target }))}
                    />
                  </td>
                  <td style={cellStyle}>
                    <SpecInput<Materiality>
                      value={formatMaterialitySpec(entry.materiality)}
                      placeholder="1000 | 2%"
                      disabled={disabled}
                      width={90}
                      parse={(t) => {
                        const r = parseMaterialitySpec(t);
                        return r.ok ? { ok: true, value: r.materiality } : r;
                      }}
                      onCommit={(materiality) => onEdit(withMeasure(doc, m.name, { materiality }))}
                    />
                  </td>
                  <td style={cellStyle}>
                    {selectOf<Cadence>(
                      entry.cadence ?? "",
                      CADENCES,
                      (v) => onEdit(withMeasure(doc, m.name, { cadence: v === "" ? undefined : v })),
                      disabled,
                      104,
                    )}
                  </td>
                  <td style={cellStyle}>
                    <input
                      type="number"
                      style={{ ...smallInput, width: 62 }}
                      disabled={disabled}
                      value={entry.priority !== undefined ? String(entry.priority) : ""}
                      onChange={(e) =>
                        onEdit(
                          withMeasure(doc, m.name, {
                            priority: e.target.value === "" ? undefined : Number(e.target.value),
                          }),
                        )
                      }
                    />
                  </td>
                  <td style={styles.td}>
                    <ColumnRefList
                      refs={entry.analysisDimensions ?? []}
                      options={columnRefs}
                      disabled={disabled}
                      onChange={(refs) =>
                        onEdit(withMeasure(doc, m.name, { analysisDimensions: refs }))
                      }
                    />
                  </td>
                  <td style={cellStyle}>
                    <ReviewedCell
                      reviewed={entry.reviewed}
                      disabled={disabled}
                      label={m.name}
                      onConfirm={() => onEdit(withMeasure(doc, m.name, { reviewed: true }))}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ===========================================================================
// Tables + columns grid
// ===========================================================================

function TablesGrid({
  doc,
  overview,
  findings,
  selectedPath,
  disabled,
  onEdit,
}: {
  doc: StrategyDoc;
  overview: ModelOverview;
  findings: Finding[];
  selectedPath: string | null;
  disabled: boolean;
  onEdit: (doc: StrategyDoc) => void;
}): React.ReactElement {
  return (
    <section>
      <div style={styles.sectionHeader}>
        <span style={{ ...styles.sectionTitle, fontSize: 13 }}>Tables and columns</span>
      </div>
      <div style={{ ...styles.card, padding: 0, overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              {["table / column", "kind / role", "label column / priority", "reviewed"].map((h) => (
                <th key={h} style={styles.th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {overview.tables.map((t) => {
              const entry = tableEntry(doc, t.name);
              const path = tablePath(t.name);
              return (
                <React.Fragment key={t.name}>
                  <tr
                    data-strategy-path={path}
                    data-unconfirmed={entry.reviewed ? "false" : "true"}
                    style={{
                      ...rowTone(entry.reviewed),
                      outline: selectedPath === path ? "2px solid #2f6fce" : "none",
                    }}
                  >
                    <td style={cellStyle}>
                      <strong>{t.name}</strong> <RowFindings findings={findingsAtPath(findings, path)} />
                    </td>
                    <td style={cellStyle}>
                      {selectOf<TableKind>(
                        entry.kind ?? "",
                        TABLE_KINDS,
                        (v) => onEdit(withTable(doc, t.name, { kind: v === "" ? undefined : v })),
                        disabled,
                        112,
                      )}
                    </td>
                    <td style={cellStyle}>
                      <select
                        style={{ ...smallInput, width: 168 }}
                        disabled={disabled}
                        value={entry.labelColumn ?? ""}
                        title="The column a reader recognises a row by"
                        onChange={(e) =>
                          onEdit(
                            withTable(doc, t.name, {
                              labelColumn: e.target.value === "" ? undefined : e.target.value,
                            }),
                          )
                        }
                      >
                        <option value="">(no label column)</option>
                        {t.columns.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={cellStyle}>
                      <ReviewedCell
                        reviewed={entry.reviewed}
                        disabled={disabled}
                        label={t.name}
                        onConfirm={() => onEdit(withTable(doc, t.name, { reviewed: true }))}
                      />
                    </td>
                  </tr>
                  {t.columns.map((c) => {
                    const col = entry.columns?.[c.name];
                    return (
                      <tr key={`${t.name}.${c.name}`} data-strategy-path={`${path}.columns['${c.name}']`}>
                        <td style={{ ...cellStyle, paddingLeft: 28 }}>
                          {c.name} <span style={styles.hint}>{c.dataType}</span>
                        </td>
                        <td style={cellStyle}>
                          {selectOf<Role>(
                            col?.role ?? "",
                            ROLES,
                            (v) =>
                              onEdit(withColumn(doc, t.name, c.name, { role: v === "" ? "ignore" : v })),
                            disabled,
                            112,
                          )}
                        </td>
                        <td style={cellStyle}>
                          <input
                            type="number"
                            style={{ ...smallInput, width: 62 }}
                            disabled={disabled}
                            value={col?.priority !== undefined ? String(col.priority) : ""}
                            onChange={(e) =>
                              onEdit(
                                withColumn(doc, t.name, c.name, {
                                  role: col?.role ?? "ignore",
                                  priority:
                                    e.target.value === "" ? undefined : Number(e.target.value),
                                }),
                              )
                            }
                          />
                        </td>
                        <td style={cellStyle} />
                      </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ===========================================================================
// Rules grid
// ===========================================================================

function describeSet(set: AttributeSet): string {
  const parts: string[] = [];
  if (set.direction) parts.push(`direction=${set.direction}`);
  if (set.target !== undefined) parts.push(`target=${formatTargetSpec(set.target)}`);
  if (set.materiality !== undefined) parts.push(`materiality=${formatMaterialitySpec(set.materiality)}`);
  if (set.cadence) parts.push(`cadence=${set.cadence}`);
  if (set.aggregation) parts.push(`aggregation=${set.aggregation.default}`);
  if (set.suppress && set.suppress.length > 0) parts.push(`suppress=${set.suppress.join(",")}`);
  if (set.rankWeight !== undefined) parts.push(`rankWeight=${set.rankWeight}`);
  return parts.length === 0 ? "(nothing — the rule has no effect)" : parts.join(", ");
}

function describeScope(scope: Scope | undefined): string {
  const entries = Object.entries(scope ?? {});
  if (entries.length === 0) return "(everywhere)";
  return entries
    .map(([col, v]: [string, ScopeValue]) =>
      Array.isArray(v)
        ? `${col} = ${v.join(", ")}`
        : // No end bound means "onwards", which is how the rule was written.
          `${col} = ${v.from}${v.to ? `..${v.to}` : " onwards"}`,
    )
    .join("; ");
}

function RulesGrid({
  doc,
  findings,
  selectedPath,
  disabled,
  onAdd,
  onEditRule,
  onDelete,
}: {
  doc: StrategyDoc;
  findings: Finding[];
  selectedPath: string | null;
  disabled: boolean;
  onAdd: () => void;
  onEditRule: (rule: Rule) => void;
  onDelete: (id: string) => void;
}): React.ReactElement {
  const rules = doc.rules ?? [];
  return (
    <section>
      <div style={styles.sectionHeader}>
        <span style={{ ...styles.sectionTitle, fontSize: 13 }}>Rules</span>
        <button style={styles.smallBtn} disabled={disabled} onClick={onAdd}>
          Add rule
        </button>
      </div>
      <div style={{ ...styles.card, padding: 0, overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              {["id", "measure", "scope", "sets", "note", ""].map((h, i) => (
                <th key={i} style={styles.th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={6}>
                  <span style={styles.muted}>
                    No rules. A rule annotates facts in a scope; it never generates one.
                  </span>
                </td>
              </tr>
            )}
            {rules.map((r, i) => {
              const path = rulePath(i);
              return (
                <tr
                  key={r.id + String(i)}
                  data-strategy-path={path}
                  style={{ outline: selectedPath === path ? "2px solid #2f6fce" : "none" }}
                >
                  <td style={cellStyle}>
                    <strong>{r.id}</strong> <RowFindings findings={findingsAtPath(findings, path)} />
                  </td>
                  <td style={cellStyle}>{r.measure}</td>
                  <td style={styles.td}>{describeScope(r.scope)}</td>
                  <td style={styles.td}>{describeSet(r.set)}</td>
                  <td style={styles.td}>{r.note ?? ""}</td>
                  <td style={cellStyle}>
                    <button style={styles.smallBtn} disabled={disabled} onClick={() => onEditRule(r)}>
                      Edit
                    </button>{" "}
                    <button style={styles.smallBtn} disabled={disabled} onClick={() => onDelete(r.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ===========================================================================
// Findings strip
// ===========================================================================

function FindingsStrip({
  findings,
  selectedPath,
  onSelect,
}: {
  findings: Finding[];
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
}): React.ReactElement {
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  return (
    <section data-testid="strategy-findings">
      <div style={styles.sectionHeader}>
        <span style={{ ...styles.sectionTitle, fontSize: 13 }}>
          Findings ({errors.length} error{errors.length === 1 ? "" : "s"}, {warnings.length} warning
          {warnings.length === 1 ? "" : "s"})
        </span>
      </div>
      <div style={{ ...styles.card, padding: 6 }}>
        {findings.length === 0 && (
          <div style={{ ...styles.muted, fontSize: 12 }}>
            No findings — press Validate to judge the strategy against this model.
          </div>
        )}
        {[
          ["error", errors] as const,
          ["warning", warnings] as const,
        ].map(([severity, list]) =>
          list.length === 0 ? null : (
            <div key={severity} style={{ marginBottom: 6 }}>
              <div style={{ ...styles.label, color: severity === "error" ? "#a4262c" : "#7a5b00" }}>
                {severity === "error" ? "Errors — these refuse the document" : "Warnings — stale or unfinished"}
              </div>
              {list.map((f, i) => (
                <div
                  key={`${severity}-${i}`}
                  data-finding-severity={severity}
                  style={{
                    display: "flex",
                    gap: 8,
                    padding: "3px 4px",
                    fontSize: 12,
                    background: selectedPath !== null && f.path === selectedPath ? "#eef3fb" : "transparent",
                  }}
                >
                  <button
                    style={{ ...styles.smallBtn, minWidth: 150, textAlign: "left" }}
                    title="Highlight the row this finding names"
                    onClick={() => onSelect(f.path === selectedPath ? null : f.path)}
                  >
                    {f.path === "" ? "(document)" : f.path}
                  </button>
                  <span style={{ fontFamily: "Consolas, monospace", color: "#666" }}>{f.code}</span>
                  <span>{f.message}</span>
                </div>
              ))}
            </div>
          ),
        )}
      </div>
    </section>
  );
}

// ===========================================================================
// Rule modal
// ===========================================================================

function RuleModal({
  overview,
  original,
  onClose,
  onSave,
}: {
  overview: ModelOverview;
  original: Rule | null;
  onClose: () => void;
  onSave: (rule: Rule) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState<RuleDraft>(() =>
    original ? ruleToDraft(original) : emptyRuleDraft(),
  );
  const [error, setError] = useState<string | null>(null);
  const columnRefs = useMemo(() => modelColumnRefs(overview), [overview]);

  const patch = (p: Partial<RuleDraft>): void => setDraft((d) => ({ ...d, ...p }));
  const patchClause = (index: number, p: Partial<ScopeClauseDraft>): void =>
    setDraft((d) => ({
      ...d,
      scope: d.scope.map((c, i) => (i === index ? { ...c, ...p } : c)),
    }));

  const save = (): void => {
    const built = buildRuleFromDraft(overview, draft);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    onSave(built.rule);
  };

  return (
    <Modal
      title={original ? `Edit rule: ${original.id}` : "New rule"}
      width={620}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.primaryBtn} onClick={save}>
            OK
          </button>
        </>
      }
    >
      <div style={{ display: "flex", gap: 8 }}>
        <Field label="Id" flex={1}>
          <input
            style={styles.input}
            value={draft.id}
            placeholder="refunds-dept"
            onChange={(e) => patch({ id: e.target.value })}
          />
        </Field>
        <Field label="Measure" flex={1}>
          <select
            style={styles.input}
            value={draft.measure}
            onChange={(e) => patch({ measure: e.target.value })}
          >
            <option value="">(select measure)</option>
            {overview.measures.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div style={styles.field}>
        <label style={styles.label}>Scope</label>
        <div style={styles.hint}>
          A column absent from the scope is unconstrained. Columns are picked from the model — a
          typed name would produce a rule that silently never fires.
        </div>
        {draft.scope.map((clause, i) => (
          <div
            key={i}
            data-testid="scope-clause"
            style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}
          >
            <select
              aria-label="Scope column"
              data-testid="scope-column"
              style={{ ...styles.input, flex: 2, minWidth: 0 }}
              value={clause.column}
              onChange={(e) => patchClause(i, { column: e.target.value })}
            >
              <option value="">(select column)</option>
              {columnRefs.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              aria-label="Scope kind"
              style={{ ...styles.input, width: 110 }}
              value={clause.kind}
              onChange={(e) => patchClause(i, { kind: e.target.value as "members" | "dateRange" })}
            >
              <option value="members">members</option>
              <option value="dateRange">date range</option>
            </select>
            {clause.kind === "members" ? (
              <input
                aria-label="Scope members"
                style={{ ...styles.input, flex: 2, minWidth: 0 }}
                value={clause.members}
                placeholder="Refunds, Retail"
                onChange={(e) => patchClause(i, { members: e.target.value })}
              />
            ) : (
              <>
                <input
                  aria-label="Scope from"
                  style={{ ...styles.input, width: 118 }}
                  value={clause.from}
                  placeholder="2025-01-01"
                  onChange={(e) => patchClause(i, { from: e.target.value })}
                />
                <input
                  aria-label="Scope to"
                  style={{ ...styles.input, width: 118 }}
                  value={clause.to}
                  placeholder="2025-06-30"
                  onChange={(e) => patchClause(i, { to: e.target.value })}
                />
              </>
            )}
            <button
              style={styles.smallBtn}
              onClick={() => setDraft((d) => ({ ...d, scope: d.scope.filter((_, j) => j !== i) }))}
            >
              Remove
            </button>
          </div>
        ))}
        <div style={{ marginTop: 4 }}>
          <button
            style={styles.smallBtn}
            onClick={() =>
              setDraft((d) => ({
                ...d,
                scope: [
                  ...d.scope,
                  { column: "", kind: "members", members: "", from: "", to: "" },
                ],
              }))
            }
          >
            Add scope column
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <Field label="Direction" flex={1}>
          <select
            style={styles.input}
            value={draft.direction}
            onChange={(e) => patch({ direction: e.target.value })}
          >
            <option value="">(leave as inherited)</option>
            {DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Cadence" flex={1}>
          <select
            style={styles.input}
            value={draft.cadence}
            onChange={(e) => patch({ cadence: e.target.value })}
          >
            <option value="">(leave as inherited)</option>
            {CADENCES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <Field label="Target" hint="1000 | kpi | measure:Budget | band:0.8,1.2" flex={1}>
          <input
            style={styles.input}
            value={draft.target}
            onChange={(e) => patch({ target: e.target.value })}
          />
        </Field>
        <Field label="Materiality" hint="1000 or 2%" flex={1}>
          <input
            style={styles.input}
            value={draft.materiality}
            onChange={(e) => patch({ materiality: e.target.value })}
          />
        </Field>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <Field label="Suppress" hint="fact kinds to withhold here, e.g. outlier,trend" flex={1}>
          <input
            style={styles.input}
            value={draft.suppress}
            onChange={(e) => patch({ suppress: e.target.value })}
          />
        </Field>
        <Field label="Rank weight" hint="multiplier on this measure's ranking here" flex={1}>
          <input
            style={styles.input}
            value={draft.rankWeight}
            onChange={(e) => patch({ rankWeight: e.target.value })}
          />
        </Field>
      </div>

      <Field label="Note" hint="Prose. It reaches wording only — never which facts exist.">
        <input style={styles.input} value={draft.note} onChange={(e) => patch({ note: e.target.value })} />
      </Field>

      {error && <div style={{ color: "#a4262c", marginBottom: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}

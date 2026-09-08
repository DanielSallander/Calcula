// FILENAME: app/extensions/ModelEditor/components/sections/StrategySection.tsx
// PURPOSE: The Strategy tab — where a person turns an inferred draft into a
//          strategy they trust. Three grids (measures, tables+columns, rules),
//          a findings strip, and the four actions: Validate, Run tests, Save,
//          Infer.
// CONTEXT: Six properties are the design, not decoration.
//
//          (1) THE ROW STATE IS FOUR-VALUED, NOT TWO. `reviewed` alone cannot
//          tell a row nobody has touched from a row a machine guessed, so both
//          rendered identically and every row offered a Confirm button over an
//          empty "—". Confirming nothing is a no-op that teaches people to
//          click Confirm without reading. The state comes from `entryState`
//          (empty | inferred | authored | confirmed) and becomes a look in ONE
//          place (`rowTone` + `ReviewedCell`). `data-unconfirmed` still mirrors
//          `reviewed` exactly — it is a different axis, and tests read both.
//
//          (2) NOTHING WRITES UNTIL SAVE. Every edit lands in local state.
//          Save calls `op: "set"`, and a REFUSED write comes back
//          `{ written: false, findings }` on a RESOLVED promise — so the save
//          handler branches on `written`, never on try/catch. Treating a
//          refusal as a thrown error would report success and discard the
//          reasons in the same breath.
//
//          (3) INFER-FIRST, NEVER A BLANK FORM. A model with no stored
//          strategy opens on the backend's inferred draft (`op: "infer"`, which
//          walks the measure ASTs and the workbook's own usage) so the first
//          view is a draft to correct. It is a DRAFT: nothing is auto-saved,
//          and a stored document is never auto-inferred over or merged into.
//          The tab unmounts on every section switch, so a naive auto-infer on
//          each mount would silently throw away confirmations the user had not
//          saved — `unsavedDrafts` remembers the working draft per connection
//          and is consulted ONLY on the no-stored-document path.
//
//          (4) THE SCOPE EDITOR CANNOT TAKE A TYPED COLUMN NAME. The column is
//          a <select> over the model's own columns, and `buildRuleFromDraft`
//          re-checks every scope column against the model before the rule is
//          accepted. A typo in a scope is not a broken rule — it is a rule that
//          silently NEVER FIRES, which looks exactly like a rule that was never
//          needed.
//
//          (5) INFER DISCARDS. It replaces the draft wholesale, including
//          unconfirmed edits, so it asks first with `confirmAsync` and AWAITS
//          the answer (the Tauri shim returns a Promise; an un-awaited
//          `if (!confirm(...))` tests `!Promise` and never fires).
//
//          (6) AGGREGATION IS PER DIMENSION. Additivity is not a flat enum:
//          headcount is additive over Department and last-value over Date. The
//          cell was a bare <select> that wrote `{ default: v }`, and because
//          `withMeasure` merges shallowly that REPLACED the whole spec and
//          destroyed any `byDimension` map — invisible before it was destroyed,
//          because the cell only ever showed `.default`. No `AggregationSpec`
//          literal is constructed in this file any more; every write goes
//          through `withAggregationDefault` / `withAggregationException`.
//
//          (7) AN EMPTY CELL IS NOT AN ABSENT ANSWER. The grid used to render
//          the RAW DOCUMENT, so a measure whose direction and target are
//          already fully determined by the model's own KPI showed two blank
//          dropdowns — which reads as "nobody has decided this" and invites a
//          person to type a SECOND answer beside the KPI's. That is the drift a
//          reviewer sees when they say the strategy layer duplicates the KPI.
//          The resolver has always read the KPI as its base layer; `preview`
//          (`strategyPreview`) hands back what each measure actually resolves
//          to plus each attribute's `source`, and an empty control shows that
//          value greyed, NAMING the KPI or rule it came from. Choosing a real
//          option is what writes a literal — the explicit override. NOTHING
//          here re-derives a resolved value: no band ordering, no KPI lookup,
//          no direction inference. One implementation decides, and it is the
//          Rust resolver. The preview is best-effort: a failure is SILENT, the
//          tab keeps working without inheritance, and it never gates an edit.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelOverview, ModelTableInfo } from "@api";
import { confirmAsync } from "@api/dialogs";
import { Badge, Field, Modal, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";
import { Chevron } from "../treeKit";
import {
  strategyGet,
  strategyInfer,
  strategyPreview,
  strategyRunTests,
  strategySet,
  strategyValidate,
} from "../../lib/strategyBackend";
import type {
  Applied,
  AttrSource,
  ResolvedMeasure,
  StrategyPreviewMeasure,
} from "../../lib/strategyBackend";
import {
  ADDITIVITIES,
  CADENCES,
  DIRECTIONS,
  ROLES,
  TABLE_KINDS,
  UNITS,
  aggregationDimensionOptions,
  compareColumnsByRole,
  confirmAll,
  emptyStrategyDoc,
  entryState,
  findingsAtPath,
  formatAggregationSpec,
  formatMaterialitySpec,
  formatTargetSpec,
  hasErrors,
  measureEntry,
  measureHasValues,
  measurePath,
  modelColumnRefs,
  modelHasColumn,
  parseMaterialitySpec,
  parseTargetSpec,
  rulePath,
  tableEntry,
  tableHasValues,
  tablePath,
  withAggregationDefault,
  withAggregationException,
  withColumn,
  withMeasure,
  withRule,
  withTable,
  withoutRule,
} from "../../lib/strategyTypes";
import type {
  AttributeSet,
  Additivity,
  AggregationSpec,
  Cadence,
  Direction,
  EntryState,
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
// The per-connection working draft
// ===========================================================================

/**
 * The unsaved draft for each connection.
 *
 * The tab is unmounted on every section switch, so without this the mount
 * effect would re-infer and the user's unsaved confirmations would vanish
 * between two clicks with no message and no undo. A STORED document always
 * wins — this is read only when the model has none, and is never merged over
 * one.
 */
const unsavedDrafts = new Map<string, StrategyDoc>();

/** Drop every remembered draft. Exists so a test can start from a cold cache;
 *  the map is module state and would otherwise leak between cases. */
export function forgetUnsavedDrafts(): void {
  unsavedDrafts.clear();
}

const DRAFT_STATUS =
  "No stored strategy — this is an inferred draft. Nothing is written until you press Save.";
const RESUMED_STATUS =
  "Showing your unsaved draft — nothing is written until you press Save.";
const NO_DRAFT_STATUS = "This model has no strategy yet — Infer proposes a draft.";

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
// Inheritance — reading what the RESOLVER decided, never deciding it here
// ===========================================================================

/** How long an edit rests before the preview is re-fetched. */
const PREVIEW_DEBOUNCE_MS = 300;

/** The rule id, when a rule is what decided this attribute. */
export function sourceRuleId(source: AttrSource): string | null {
  return typeof source === "object" && "rule" in source ? source.rule : null;
}

/** The KPI name, when a model KPI is what supplied this attribute. */
export function sourceKpiName(source: AttrSource): string | null {
  return typeof source === "object" && "kpi" in source ? source.kpi : null;
}

/**
 * The source as a short token, for the "why" list: `attribute: value (source)`.
 *
 * A KPI and a rule are NAMED. "inherited" is not an answer anybody can go and
 * check; "KPI 'Margin % KPI'" is one they can open.
 */
export function sourceLabel(source: AttrSource): string {
  const kpi = sourceKpiName(source);
  if (kpi !== null) return kpi === "" ? "the model's KPI" : `KPI '${kpi}'`;
  const rule = sourceRuleId(source);
  if (rule !== null) return `rule '${rule}'`;
  return source as "base" | "inferred" | "strategy";
}

/**
 * The source as a phrase for a control that is showing an inherited value.
 *
 * The empty-KPI case is real rather than defensive: the resolver stamps
 * `Kpi(name)` from an `Option`, so a KPI with no name arrives as `{"kpi": ""}`
 * and "from KPI ''" would read as a bug in the tab rather than a gap in the
 * model.
 */
export function inheritedFrom(source: AttrSource): string {
  const kpi = sourceKpiName(source);
  if (kpi !== null) return kpi === "" ? "from the model's KPI" : `from KPI '${kpi}'`;
  const rule = sourceRuleId(source);
  if (rule !== null) return `from rule '${rule}'`;
  switch (source) {
    case "base":
      return "from the model";
    case "inferred":
      return "inferred from the model";
    default:
      return "from this measure's entry";
  }
}

/**
 * What an empty control says instead of a blank: the value it already
 * inherits, and where from — "higherIsBetter — from KPI 'Margin % KPI'".
 *
 * `null` when nothing is inherited, which is the only case where a blank is
 * the truth.
 */
export function inheritedOption<T>(
  applied: Applied<T> | undefined,
  format: (value: T) => string,
): string | null {
  if (applied === undefined) return null;
  const text = format(applied.value);
  if (text === "") return null;
  return `${text} — ${inheritedFrom(applied.source)}`;
}

/**
 * What an EMPTY control should say — or null when the document itself carries
 * the value, in which case the control shows the document, which is what it
 * edits.
 */
export function inheritedFor<T>(
  carried: T | undefined,
  applied: Applied<T> | undefined,
  format: (value: T) => string,
): string | null {
  if (carried !== undefined) return null;
  return inheritedOption(applied, format);
}

/**
 * The rule that OVERRIDES a value the document carries, if there is one.
 *
 * Only meaningful where the document states something: a rule that supplied an
 * absent value is already named in the inherited note, and saying it twice in
 * two spellings is how one of them comes to be wrong.
 */
export function overridingRule<T>(
  carried: T | undefined,
  applied: Applied<T> | undefined,
): string | null {
  if (carried === undefined || applied === undefined) return null;
  return sourceRuleId(applied.source);
}

/**
 * The whole resolved measure, one attribute per line, with provenance.
 *
 * The SUPPRESSIONS are here because "no favourability here, because rule X
 * disagrees" is the single most confusing thing the engine can do, and this
 * tooltip is the only place a person can learn it. A suppressed attribute has
 * no value to show anywhere else — that is what suppression means.
 */
export function whyLines(resolved: ResolvedMeasure): string[] {
  const lines: string[] = [];
  function add<T>(
    attribute: string,
    applied: Applied<T> | undefined,
    format: (value: T) => string,
  ): void {
    if (applied === undefined) return;
    const text = format(applied.value);
    lines.push(`${attribute}: ${text === "" ? "(none)" : text} (${sourceLabel(applied.source)})`);
  }
  add("direction", resolved.direction, (d) => d);
  add("aggregation", resolved.aggregation, (a) => formatAggregationSpec(a));
  add("unit", resolved.unit, (u) => u);
  add("target", resolved.target, (t) => formatTargetSpec(t));
  add("materiality", resolved.materiality, (m) => formatMaterialitySpec(m));
  add("cadence", resolved.cadence, (c) => c);
  add("priority", resolved.priority, (p) => String(p));
  add("rankWeight", resolved.rankWeight, (w) => String(w));
  if (resolved.analysisDimensions.length > 0) {
    lines.push(`analysis dimensions: ${resolved.analysisDimensions.join(", ")}`);
  }
  if (resolved.neverSliceBy.length > 0) {
    lines.push(`never slice by: ${resolved.neverSliceBy.join(", ")}`);
  }
  if (resolved.suppressedKinds.length > 0) {
    lines.push(`suppressed fact kinds: ${resolved.suppressedKinds.join(", ")}`);
  }
  for (const s of resolved.suppressions) {
    lines.push(`${s.attribute}: WITHHELD by rule '${s.rule}' — ${s.reason}`);
  }
  if (lines.length === 0) {
    lines.push("Nothing is decided for this measure — not by the model, not by the strategy.");
  }
  return lines;
}

/** The per-row "why": everything the resolver decided, as a tooltip.
 *
 *  Deliberately NOT a popover. The question it answers ("where did this number
 *  come from?") is asked while looking at one cell, and a panel that has to be
 *  opened and closed is a worse answer than one that is already there. */
function WhyCell({
  measure,
  resolved,
}: {
  measure: string;
  resolved: ResolvedMeasure;
}): React.ReactElement {
  return (
    <span
      data-testid={`why-${measure}`}
      title={`What ${measure} resolves to today, and who decided each part:\n\n${whyLines(
        resolved,
      ).join("\n")}`}
      style={{
        marginLeft: 6,
        fontSize: 11,
        color: "#2f6fce",
        borderBottom: "1px dotted #2f6fce",
        cursor: "help",
      }}
    >
      why
    </span>
  );
}

/**
 * The marker on a cell whose value is NOT what applies.
 *
 * The document carries a value here, but the resolver reports a scoped rule
 * decided this attribute — so the cell is showing something the rule overrides.
 * Without the marker the two disagree in silence.
 */
function RuleOverrideMark({
  measure,
  attribute,
  ruleId,
}: {
  measure: string;
  attribute: string;
  ruleId: string;
}): React.ReactElement {
  return (
    <span
      data-testid={`rule-override-${attribute}-${measure}`}
      style={{ marginLeft: 4 }}
      title={`rule '${ruleId}' decides ${attribute} for ${measure}, so what this cell says is not what applies where that rule reaches.`}
    >
      <Badge tone="warn">rule</Badge>
    </span>
  );
}

// ===========================================================================
// Small presentation helpers
// ===========================================================================

/**
 * The ONE place a row state becomes a look.
 *
 * Only `inferred` is muted-and-italic, because only an inferred row is a
 * machine's sentence. `empty` is quiet but upright — there is nothing there to
 * doubt — and `authored` reads as plainly as `confirmed`, since the words are
 * the user's own; the difference between them is the badge, not the type.
 */
function rowTone(state: EntryState): React.CSSProperties {
  switch (state) {
    case "inferred":
      return { color: "#8a8a8a", background: "#fbfaf5", fontStyle: "italic" };
    case "empty":
      return { color: "#9a9a9a", background: "transparent" };
    default:
      return { color: "#222", background: "transparent" };
  }
}

const cellStyle: React.CSSProperties = { ...styles.td, whiteSpace: "nowrap" };

const smallInput: React.CSSProperties = { ...styles.input, fontSize: 12, padding: "2px 4px" };

/**
 * A picker whose EMPTY option carries the inherited value rather than a dash.
 *
 * `inherited` is the resolver's answer for this attribute, already formatted
 * ("higherIsBetter — from KPI 'Margin % KPI'"). A blank where a KPI has already
 * decided the answer is what invites a person to type a competing one, so the
 * empty option shows what is in force and reads as greyed. Choosing a real
 * option is the explicit override — and only that writes to the document.
 */
function selectOf<T extends string>(
  value: T | "",
  options: readonly T[],
  onChange: (v: T | "") => void,
  disabled: boolean,
  width = 128,
  inherited: string | null = null,
): React.ReactElement {
  const showingInherited = value === "" && inherited !== null;
  return (
    <select
      style={{
        ...smallInput,
        width,
        ...(showingInherited ? { color: "#6a6a6a", fontStyle: "italic" } : {}),
      }}
      value={value}
      disabled={disabled}
      title={
        inherited === null
          ? undefined
          : `Inherited: ${inherited}. Picking a value here overrides it in the document.`
      }
      onChange={(e) => onChange(e.target.value as T | "")}
    >
      <option value="">{inherited ?? "—"}</option>
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
  hint,
  width = 118,
}: {
  value: string;
  parse: (text: string) => { ok: true; value: T | undefined } | { ok: false; error: string };
  onCommit: (value: T | undefined) => void;
  disabled: boolean;
  /** What an EMPTY field says. The inherited value when there is one, so the
   *  cell answers "what applies here?" rather than showing a blank. */
  placeholder: string;
  /** The accepted spellings, for the tooltip. Separate from `placeholder`
   *  because when the placeholder is carrying an inherited value the format
   *  hint still has to reach the person who is about to type over it. */
  hint?: string;
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
      title={error ?? (hint === undefined ? placeholder : `${placeholder}\n${hint}`)}
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
  title,
  addLabel = "add column…",
}: {
  refs: string[];
  options: string[];
  onChange: (refs: string[]) => void;
  disabled: boolean;
  /** What the list MEANS. A column list's name rarely carries its purpose. */
  title?: string;
  addLabel?: string;
}): React.ReactElement {
  return (
    <div
      title={title}
      style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", minWidth: 220 }}
    >
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
        <option value="">{addLabel}</option>
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

/**
 * The row's state, with the Confirm action beside it.
 *
 * An `empty` row keeps the button but DISABLES it: confirming a row that says
 * nothing agrees to nothing, and a live Confirm over four "—" cells is how a
 * person learns to confirm without reading. The title says why rather than
 * leaving a dead control unexplained.
 */
function ReviewedCell({
  state,
  onConfirm,
  disabled,
  label,
}: {
  state: EntryState;
  onConfirm: () => void;
  disabled: boolean;
  label: string;
}): React.ReactElement {
  if (state === "confirmed") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Badge tone="ok">confirmed</Badge>
      </div>
    );
  }
  const empty = state === "empty";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {empty && <Badge tone="neutral">not set</Badge>}
      {state === "inferred" && <Badge tone="warn">inferred</Badge>}
      {state === "authored" && <Badge tone="neutral">set by you</Badge>}
      <button
        style={styles.smallBtn}
        disabled={disabled || empty}
        title={
          empty
            ? `Nothing to confirm — the strategy says nothing about ${label} yet. Set a value, or press Infer for a draft.`
            : `Confirm ${label} — mark it as agreed by a human`
        }
        onClick={onConfirm}
      >
        Confirm
      </button>
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
  /** What each measure RESOLVES to, by measure name. Empty until the preview
   *  arrives, and empty forever if it never does — inheritance is an extra the
   *  grid can do without, never a precondition for editing. */
  const [preview, setPreview] = useState<Map<string, StrategyPreviewMeasure>>(() => new Map());

  // A slow load for a connection the user has already left must not install
  // its document over the newer one.
  const loadSeq = useRef(0);
  /** The load this connection's FIRST preview was fetched for. The first one
   *  is immediate — the grid's first paint is exactly where a blank cell would
   *  mislead — and only later document edits are debounced. */
  const previewedSeq = useRef(-1);
  useEffect(() => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setDoc(null);
    setFindings([]);
    setStatus(null);
    // Another model's inheritance is worse than none: it would name a KPI this
    // model does not have.
    setPreview(new Map());

    void (async (): Promise<void> => {
      let next: StrategyDoc = emptyStrategyDoc();
      let note: string | null = null;
      try {
        const stored = await strategyGet(connectionId);
        if (loadSeq.current !== seq) return;
        if (stored) {
          // A stored document is the authority. It is never auto-inferred over
          // and a draft is never merged into it.
          unsavedDrafts.delete(connectionId);
          next = stored;
        } else {
          const remembered = unsavedDrafts.get(connectionId);
          if (remembered) {
            // Coming BACK to the tab. Re-inferring here would discard whatever
            // the user confirmed before they switched sections.
            next = remembered;
            note = RESUMED_STATUS;
          } else {
            try {
              next = await strategyInfer(connectionId);
              if (loadSeq.current !== seq) return;
              unsavedDrafts.set(connectionId, next);
              note = DRAFT_STATUS;
            } catch {
              // A draft that could not be built is not an error condition — the
              // tab still works, it just opens empty and says so.
              next = emptyStrategyDoc();
              note = NO_DRAFT_STATUS;
            }
          }
        }
      } catch (err: unknown) {
        if (loadSeq.current !== seq) return;
        next = emptyStrategyDoc();
        reportError(err);
      }
      if (loadSeq.current !== seq) return;
      setDoc(next);
      setStatus(note);
      setLoading(false);
    })();
  }, [connectionId, reportError]);

  /**
   * Keep the inheritance in step with the document being edited.
   *
   * The IN-MEMORY document is what is previewed, so raising a materiality shows
   * its effect before Save rather than after — that is the whole point of
   * sending a payload at all. Debounced, because every keystroke that commits a
   * spec produces a new document.
   *
   * A failure is SILENT and total: the catch swallows it, the map stays as it
   * was, and every control falls back to the blank it showed before this
   * existed. Nothing here can block or refuse an edit.
   */
  useEffect(() => {
    if (doc === null) return undefined;
    // The SAME guard the mount effect uses: a preview for a connection the user
    // has already left must not overwrite the newer one.
    const seq = loadSeq.current;
    let cancelled = false;
    const fetchPreview = (): void => {
      void (async (): Promise<void> => {
        try {
          const result = await strategyPreview(connectionId, doc);
          if (cancelled || loadSeq.current !== seq) return;
          const next = new Map<string, StrategyPreviewMeasure>();
          for (const m of result.measures) next.set(m.measure, m);
          setPreview(next);
        } catch {
          // Deliberately silent. The tab works without inheritance; a toast for
          // a decoration would train people to dismiss the ones that matter.
        }
      })();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (previewedSeq.current === seq) {
      timer = setTimeout(fetchPreview, PREVIEW_DEBOUNCE_MS);
    } else {
      previewedSeq.current = seq;
      fetchPreview();
    }
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [connectionId, doc]);

  /** Every local edit goes through here. Findings are cleared, because a
   *  finding describes the document that produced it and an edited document
   *  has not been judged yet — a stale error would keep Save locked over a
   *  problem the user just fixed. */
  const edit = useCallback(
    (next: StrategyDoc) => {
      unsavedDrafts.set(connectionId, next);
      setDoc(next);
      setFindings([]);
      setStatus(null);
    },
    [connectionId],
  );

  const columnRefs = useMemo(() => modelColumnRefs(overview), [overview]);
  const errorCount = findings.filter((f) => f.severity === "error").length;
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
        if (result.written) unsavedDrafts.delete(connectionId);
        setStatus(
          result.written
            ? `Saved${result.findings.length > 0 ? ` with ${result.findings.length} warning(s)` : ""}.`
            : "Not saved — the strategy was refused. See the findings below.",
        );
      }),
    [run, connectionId],
  );

  // The button and the mount-time draft call the SAME backend inference, so
  // the two can never disagree about what "inferred" means here.
  const onInfer = useCallback(async () => {
    // AWAITED: the Tauri shim returns a Promise, so an un-awaited confirm is
    // always truthy and the draft would be replaced without asking.
    const agreed = await confirmAsync(
      "Replace the strategy with a freshly inferred draft?\n\n" +
        "Every entry comes back unconfirmed, and edits you have not saved are discarded.",
    );
    if (!agreed) return;
    setBusy(true);
    setStatus(null);
    try {
      const drafted = await strategyInfer(connectionId);
      unsavedDrafts.set(connectionId, drafted);
      setDoc(drafted);
      setFindings([]);
      setStatus("Inferred a fresh draft — nothing is written until you press Save.");
    } catch (err: unknown) {
      reportError(err);
      setStatus("Infer failed.");
    } finally {
      setBusy(false);
    }
  }, [connectionId, reportError]);

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
        {status && (
          <span data-testid="strategy-status" style={{ color: "#444" }}>
            {status}
          </span>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
        <MeasuresGrid
          doc={doc}
          overview={overview}
          findings={findings}
          preview={preview}
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

const MEASURE_HEADERS = [
  "measure",
  "direction",
  "aggregation",
  "unit",
  "target",
  "materiality",
  "cadence",
  "priority",
  "analysis dimensions",
  "never slice by",
  "reviewed",
];

/** The accepted spellings for the two spec cells.
 *
 *  Constants because the placeholder is no longer always the hint: an empty
 *  cell shows what it INHERITS instead, and the format then has to reach the
 *  tooltip. Two spellings of one grammar drift. */
const TARGET_HINT = "1000 | kpi | measure:Budget | band:0.8,1.2";
const MATERIALITY_HINT = "1000 | 2%";

const NEVER_SLICE_TITLE =
  "Columns this measure must never be broken down by — a slice that is structurally valid but " +
  "semantically misleading (an average sliced by a key, a headcount sliced by an order line). " +
  "The engine cannot detect these, and inference deliberately proposes none, so this list only " +
  "ever comes from a person.";

function MeasuresGrid({
  doc,
  overview,
  findings,
  preview,
  selectedPath,
  columnRefs,
  disabled,
  onEdit,
  onConfirmAll,
}: {
  doc: StrategyDoc;
  overview: ModelOverview;
  findings: Finding[];
  preview: Map<string, StrategyPreviewMeasure>;
  selectedPath: string | null;
  columnRefs: string[];
  disabled: boolean;
  onEdit: (doc: StrategyDoc) => void;
  onConfirmAll: () => void;
}): React.ReactElement {
  /** The measure whose aggregation editor is open, or null. */
  const [aggregating, setAggregating] = useState<string | null>(null);

  // Entries naming a measure the model no longer has. They come from the
  // preview because the grid iterates the MODEL's measures — which is exactly
  // why an orphan was invisible until now, in a document where it is the one
  // thing that needs doing.
  const orphans = [...preview.values()].filter((p) => !p.inModel && p.hasEntry);

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
              {MEASURE_HEADERS.map((h) => (
                <th key={h} style={styles.th} title={h === "never slice by" ? NEVER_SLICE_TITLE : undefined}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {overview.measures.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={MEASURE_HEADERS.length}>
                  <span style={styles.muted}>This model has no measures.</span>
                </td>
              </tr>
            )}
            {overview.measures.map((m) => {
              const entry = measureEntry(doc, m.name);
              const state = entryState(entry, measureHasValues(entry));
              const path = measurePath(m.name);
              const rowFindings = findingsAtPath(findings, path);
              // The resolver's answer for this measure — absent when no preview
              // has arrived, which every cell below treats as "show a blank",
              // exactly as the grid behaved before inheritance existed.
              const resolved = preview.get(m.name)?.resolved;
              const inh = {
                direction: inheritedFor(entry.direction, resolved?.direction, (d) => d),
                unit: inheritedFor(entry.unit, resolved?.unit, (u) => u),
                cadence: inheritedFor(entry.cadence, resolved?.cadence, (c) => c),
                target: inheritedFor(entry.target, resolved?.target, (t) => formatTargetSpec(t)),
                materiality: inheritedFor(entry.materiality, resolved?.materiality, (v) =>
                  formatMaterialitySpec(v),
                ),
              };
              const ruled = {
                direction: overridingRule(entry.direction, resolved?.direction),
                unit: overridingRule(entry.unit, resolved?.unit),
                cadence: overridingRule(entry.cadence, resolved?.cadence),
                target: overridingRule(entry.target, resolved?.target),
                materiality: overridingRule(entry.materiality, resolved?.materiality),
              };
              return (
                <tr
                  key={m.name}
                  data-strategy-path={path}
                  data-unconfirmed={entry.reviewed ? "false" : "true"}
                  data-strategy-state={state}
                  style={{
                    ...rowTone(state),
                    outline: selectedPath === path ? "2px solid #2f6fce" : "none",
                  }}
                >
                  <td style={cellStyle}>
                    <strong>{m.name}</strong> <span style={styles.hint}>{m.table}</span>{" "}
                    <RowFindings findings={rowFindings} />
                    {resolved && <WhyCell measure={m.name} resolved={resolved} />}
                  </td>
                  <td style={cellStyle}>
                    {selectOf<Direction>(
                      entry.direction ?? "",
                      DIRECTIONS,
                      (v) => onEdit(withMeasure(doc, m.name, { direction: v === "" ? undefined : v })),
                      disabled,
                      128,
                      inh.direction,
                    )}
                    {ruled.direction !== null && (
                      <RuleOverrideMark
                        measure={m.name}
                        attribute="direction"
                        ruleId={ruled.direction}
                      />
                    )}
                  </td>
                  <td style={cellStyle}>
                    <AggregationCell
                      measure={m.name}
                      spec={entry.aggregation}
                      disabled={disabled}
                      onOpen={() => setAggregating(m.name)}
                    />
                  </td>
                  <td style={cellStyle}>
                    {selectOf<Unit>(
                      entry.unit ?? "",
                      UNITS,
                      (v) => onEdit(withMeasure(doc, m.name, { unit: v === "" ? undefined : v })),
                      disabled,
                      98,
                      inh.unit,
                    )}
                    {ruled.unit !== null && (
                      <RuleOverrideMark measure={m.name} attribute="unit" ruleId={ruled.unit} />
                    )}
                  </td>
                  <td style={cellStyle}>
                    <SpecInput<Target>
                      value={formatTargetSpec(entry.target)}
                      placeholder={inh.target ?? TARGET_HINT}
                      hint={TARGET_HINT}
                      disabled={disabled}
                      parse={(t) => {
                        const r = parseTargetSpec(t);
                        return r.ok ? { ok: true, value: r.target } : r;
                      }}
                      onCommit={(target) => onEdit(withMeasure(doc, m.name, { target }))}
                    />
                    {ruled.target !== null && (
                      <RuleOverrideMark measure={m.name} attribute="target" ruleId={ruled.target} />
                    )}
                  </td>
                  <td style={cellStyle}>
                    <SpecInput<Materiality>
                      value={formatMaterialitySpec(entry.materiality)}
                      placeholder={inh.materiality ?? MATERIALITY_HINT}
                      hint={MATERIALITY_HINT}
                      disabled={disabled}
                      width={90}
                      parse={(t) => {
                        const r = parseMaterialitySpec(t);
                        return r.ok ? { ok: true, value: r.materiality } : r;
                      }}
                      onCommit={(materiality) => onEdit(withMeasure(doc, m.name, { materiality }))}
                    />
                    {ruled.materiality !== null && (
                      <RuleOverrideMark
                        measure={m.name}
                        attribute="materiality"
                        ruleId={ruled.materiality}
                      />
                    )}
                  </td>
                  <td style={cellStyle}>
                    {selectOf<Cadence>(
                      entry.cadence ?? "",
                      CADENCES,
                      (v) => onEdit(withMeasure(doc, m.name, { cadence: v === "" ? undefined : v })),
                      disabled,
                      104,
                      inh.cadence,
                    )}
                    {ruled.cadence !== null && (
                      <RuleOverrideMark
                        measure={m.name}
                        attribute="cadence"
                        ruleId={ruled.cadence}
                      />
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
                      title="Columns worth breaking this measure down by."
                      onChange={(refs) =>
                        onEdit(withMeasure(doc, m.name, { analysisDimensions: refs }))
                      }
                    />
                  </td>
                  <td style={styles.td} data-testid={`never-slice-${m.name}`}>
                    <ColumnRefList
                      refs={entry.neverSliceBy ?? []}
                      options={columnRefs}
                      disabled={disabled}
                      title={NEVER_SLICE_TITLE}
                      addLabel="never slice by…"
                      onChange={(refs) => onEdit(withMeasure(doc, m.name, { neverSliceBy: refs }))}
                    />
                  </td>
                  <td style={cellStyle}>
                    <ReviewedCell
                      state={state}
                      disabled={disabled}
                      label={m.name}
                      onConfirm={() => onEdit(withMeasure(doc, m.name, { reviewed: true }))}
                    />
                  </td>
                </tr>
              );
            })}
            {/* Orphans last, and NOT as editable rows: an entry whose measure
                the model no longer has is the thing to clean up, and offering
                dropdowns over it invites someone to keep tending a row that can
                never resolve to anything. */}
            {orphans.map((p) => (
              <tr
                key={`orphan-${p.measure}`}
                data-strategy-path={measurePath(p.measure)}
                data-strategy-orphan="true"
                style={{ color: "#7a5b00", background: "#fffaf0" }}
              >
                <td style={cellStyle}>
                  <strong>{p.measure}</strong>{" "}
                  <Badge tone="warn">not in the model</Badge>{" "}
                  <RowFindings findings={findingsAtPath(findings, measurePath(p.measure))} />
                </td>
                <td style={styles.td} colSpan={MEASURE_HEADERS.length - 1}>
                  The strategy has an entry for &lsquo;{p.measure}&rsquo;, but this model has no
                  such measure — it was renamed or deleted. Nothing here can apply to anything;
                  remove the entry, or bring the measure back under its old name.
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {aggregating !== null && (
        <AggregationEditor
          measure={aggregating}
          overview={overview}
          doc={doc}
          disabled={disabled}
          onClose={() => setAggregating(null)}
          onEdit={onEdit}
        />
      )}
    </section>
  );
}

// ===========================================================================
// Aggregation — the collapsed cell and its editor
// ===========================================================================

/**
 * The collapsed cell.
 *
 * It shows the WHOLE spec, exceptions included ("additive (Date: last value)"),
 * because the previous cell showed only `.default` — so a per-dimension
 * exception was invisible right up to the moment an edit destroyed it.
 */
function AggregationCell({
  measure,
  spec,
  disabled,
  onOpen,
}: {
  measure: string;
  spec: AggregationSpec | undefined;
  disabled: boolean;
  onOpen: () => void;
}): React.ReactElement {
  const text = formatAggregationSpec(spec);
  return (
    <button
      data-testid={`aggregation-${measure}`}
      style={{ ...styles.smallBtn, minWidth: 128, textAlign: "left" }}
      disabled={disabled}
      title={`Additivity of ${measure}: the default, plus any per-dimension exception`}
      onClick={onOpen}
    >
      {text === "" ? "—" : text}
    </button>
  );
}

/**
 * The per-dimension additivity editor.
 *
 * Additivity is a property of the measure PER DIMENSION — headcount is additive
 * over Department and last-value over Date — so a flat enum forces a wrong
 * answer on exactly the semi-additive measures that most need a right one. The
 * dimension picker is a closed list from the model: a typo would produce an
 * exception the engine never looks up, which reads as "the exception did not
 * apply" rather than as a mistake.
 */
function AggregationEditor({
  measure,
  overview,
  doc,
  disabled,
  onClose,
  onEdit,
}: {
  measure: string;
  overview: ModelOverview;
  doc: StrategyDoc;
  disabled: boolean;
  onClose: () => void;
  onEdit: (doc: StrategyDoc) => void;
}): React.ReactElement {
  const [newDimension, setNewDimension] = useState("");
  const [newValue, setNewValue] = useState<Additivity>("lastValue");

  const spec = measureEntry(doc, measure).aggregation;
  // The dimensions on offer depend on where the measure LIVES — its own table
  // plus the tables one active relationship away from it.
  const measureTable = overview.measures.find((m) => m.name === measure)?.table ?? "";
  const dimensionOptions = aggregationDimensionOptions(overview, measureTable);
  // Dimension order, not insertion order — the same order the collapsed cell
  // prints, so the two readings of one spec cannot disagree.
  const exceptions = Object.entries(spec?.byDimension ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const taken = new Set(exceptions.map(([d]) => d));

  /** The ONE write path. No `AggregationSpec` literal is built in this file. */
  const write = (next: AggregationSpec | undefined): void =>
    onEdit(withMeasure(doc, measure, { aggregation: next }));

  const onSetDefault = (value: Additivity | undefined): void =>
    write(withAggregationDefault(spec, value));
  const onSetException = (dimension: string, value: Additivity | undefined): void =>
    write(withAggregationException(spec, dimension, value));

  return (
    <Modal
      title={`Aggregation: ${measure}`}
      width={520}
      onClose={onClose}
      footer={
        <button style={styles.primaryBtn} onClick={onClose}>
          Close
        </button>
      }
    >
      <Field
        label="Default"
        hint="How this measure aggregates unless a dimension below says otherwise. Clearing it erases the exceptions too — an exception needs something to be an exception TO."
      >
        <select
          data-testid="aggregation-default"
          style={styles.input}
          disabled={disabled}
          value={spec?.default ?? ""}
          onChange={(e) =>
            onSetDefault(e.target.value === "" ? undefined : (e.target.value as Additivity))
          }
        >
          <option value="">—</option>
          {ADDITIVITIES.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </Field>

      <div style={styles.field}>
        <label style={styles.label}>Exceptions</label>
        <div style={styles.hint}>
          A dimension this measure does NOT aggregate the default way. A balance is additive across
          Department and last-value across Date; naming only one of the two answers is what makes a
          semi-additive measure lie.
        </div>
        {spec === undefined && (
          <div style={{ ...styles.hint, marginTop: 4 }}>
            Set a default first — an exception is a departure FROM one, and the stored shape has no
            way to hold the second without the first.
          </div>
        )}
        {spec !== undefined && exceptions.length === 0 && (
          <div style={{ ...styles.hint, marginTop: 4 }}>
            No exceptions — the default applies over every dimension.
          </div>
        )}
        {exceptions.map(([dimension, value]) => (
          <div
            key={dimension}
            data-testid="aggregation-exception"
            style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}
          >
            <span style={{ ...styles.input, flex: 2, minWidth: 0, background: "#f6f7f8" }}>
              {dimension}
            </span>
            <select
              aria-label={`Additivity over ${dimension}`}
              style={{ ...styles.input, width: 150 }}
              disabled={disabled}
              value={value}
              onChange={(e) => onSetException(dimension, e.target.value as Additivity)}
            >
              {ADDITIVITIES.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <button
              style={styles.smallBtn}
              disabled={disabled}
              title={`Remove the ${dimension} exception`}
              onClick={() => onSetException(dimension, undefined)}
            >
              &times;
            </button>
          </div>
        ))}

        <div
          style={{
            display: spec === undefined ? "none" : "flex",
            gap: 6,
            alignItems: "center",
            marginTop: 8,
          }}
        >
          <select
            aria-label="Exception dimension"
            data-testid="aggregation-new-dimension"
            style={{ ...styles.input, flex: 2, minWidth: 0 }}
            disabled={disabled}
            value={newDimension}
            onChange={(e) => setNewDimension(e.target.value)}
          >
            <option value="">(add a dimension…)</option>
            {dimensionOptions
              .filter((d) => !taken.has(d))
              .map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
          </select>
          <select
            aria-label="Exception additivity"
            style={{ ...styles.input, width: 150 }}
            disabled={disabled}
            value={newValue}
            onChange={(e) => setNewValue(e.target.value as Additivity)}
          >
            {ADDITIVITIES.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <button
            style={styles.smallBtn}
            disabled={disabled || newDimension === ""}
            onClick={() => {
              onSetException(newDimension, newValue);
              setNewDimension("");
            }}
          >
            Add exception
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ===========================================================================
// Tables + columns grid
// ===========================================================================

type ModelColumn = ModelTableInfo["columns"][number];

/**
 * Order a table's columns by what they are FOR, then by name.
 *
 * `BI.dim_customer` renders eleven columns, and after inference ten of them are
 * `ignore`; model order gives the one column that carries a decision the same
 * eleventh of the screen as the ten that carry none.
 */
function orderedColumns(
  columns: ModelColumn[],
  roleOf: (name: string) => Role | undefined,
): ModelColumn[] {
  // `compareColumnsByRole` owns both the role order and the name tiebreak, so
  // the CLI can print this same order without a second opinion about it.
  return [...columns].sort((a, b) =>
    compareColumnsByRole(
      { name: a.name, role: roleOf(a.name) },
      { name: b.name, role: roleOf(b.name) },
    ),
  );
}

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
  /** Tables whose ignored columns are currently disclosed. Same idiom as the
   *  other sections' trees (a Set of names + `Chevron`). */
  const [showIgnored, setShowIgnored] = useState<Set<string>>(new Set());
  const toggleIgnored = (name: string): void =>
    setShowIgnored((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

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
              const state = entryState(entry, tableHasValues(entry));
              const path = tablePath(t.name);
              const roleOf = (name: string): Role | undefined => entry.columns?.[name]?.role;
              const ordered = orderedColumns(t.columns, roleOf);
              // An UNSET column is not an ignored one: nobody has said it is
              // uninteresting, so hiding it would hide the whole grid of a model
              // whose draft failed to build.
              const ignored = ordered.filter((c) => roleOf(c.name) === "ignore");
              const shown = ordered.filter((c) => roleOf(c.name) !== "ignore");
              const open = showIgnored.has(t.name);
              const columnRow = (c: ModelColumn): React.ReactElement => {
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
              };
              return (
                <React.Fragment key={t.name}>
                  <tr
                    data-strategy-path={path}
                    data-unconfirmed={entry.reviewed ? "false" : "true"}
                    data-strategy-state={state}
                    style={{
                      ...rowTone(state),
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
                        state={state}
                        disabled={disabled}
                        label={t.name}
                        onConfirm={() => onEdit(withTable(doc, t.name, { reviewed: true }))}
                      />
                    </td>
                  </tr>
                  {shown.map(columnRow)}
                  {ignored.length > 0 && (
                    <tr data-testid={`ignored-summary-${t.name}`}>
                      <td style={{ ...cellStyle, paddingLeft: 28 }} colSpan={4}>
                        {/* A DISCLOSURE, not a filter: the summary is always
                            visible so a count that changes is legible, and the
                            columns behind it stay fully editable. */}
                        <button
                          style={{ ...styles.smallBtn, display: "inline-flex", alignItems: "center", gap: 4 }}
                          title="Columns marked 'ignore' — still editable, just not in the way of the ones that carry a decision"
                          onClick={() => toggleIgnored(t.name)}
                        >
                          <Chevron open={open} />
                          {open ? "hide " : "show "}
                          {ignored.length} ignored column{ignored.length === 1 ? "" : "s"}
                        </button>
                      </td>
                    </tr>
                  )}
                  {open && ignored.map(columnRow)}
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
  // The WHOLE spec: a rule that sets a per-dimension exception must not read
  // here as though it set only the default.
  if (set.aggregation) parts.push(`aggregation=${formatAggregationSpec(set.aggregation)}`);
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

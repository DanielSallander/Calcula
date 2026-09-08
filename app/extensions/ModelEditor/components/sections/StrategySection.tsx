// FILENAME: app/extensions/ModelEditor/components/sections/StrategySection.tsx
// PURPOSE: The Strategy tab — where a person turns an inferred draft into a
//          strategy they trust. Three grids (measures, tables+columns, rules),
//          a findings strip, and the four actions: Validate, Run tests, Save,
//          Infer.
// CONTEXT: Eleven properties are the design, not decoration.
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
//
//          (8) THE BULK CONFIRM CANNOT LAUNDER A WARNING. `Confirm` is the
//          signal a HUMAN vouched for a value, and the decomposition engine
//          trusts it downstream. `Confirm all` used to convert every proposal
//          into reviewed truth in one click, findings included — the one
//          gesture in this tab that could turn a warning into a confirmation
//          without anybody reading it. It now SKIPS any row carrying a finding
//          (and any `empty` row, for the same reason per-row Confirm is
//          disabled on those), and SAYS how many it skipped and why: a silent
//          skip is its own lie when the button is called "Confirm all". The
//          skip also has to stay VISIBLE, which is why this one write does not
//          clear the findings the way every other edit does — the badges are
//          the evidence for the sentence. Per-row Confirm is untouched: a
//          person looking at one warned row and confirming it anyway has made
//          a decision; the bulk gesture has not.
//
//          (9) THE MODEL BLOCK IS AUTHORABLE. `ModelStrategy` carries
//          `defaultTimeAxis`, `fiscalYearStart`, `reportingCurrency` and
//          `priority`, and none of them had a control anywhere — so the axis
//          every time-series fact is computed against could only ever be the
//          one inference guessed from the marked date table. The axis is a
//          <select> over the model's own columns for the same reason a scope
//          column is (see (4)): a typo there is not a broken axis, it is an
//          axis that silently disables every time fact. `fiscalYearStart` is
//          `MM-DD` and is refused at the keystroke that commits it rather than
//          at Save, because a fiscal year START RECURS — the commonest wrong
//          answer is a full date.
//
//          (10) TWO OF THOSE FOUR FIELDS ARE STORED AND READ BY NOTHING, AND
//          SAY SO ON SCREEN. `reportingCurrency` has no consumer anywhere;
//          `fiscalYearStart` has none outside its own format check — the
//          planner buckets by cadence and never asks where the fiscal year
//          starts. Someone will type SEK into an ordinary-looking box and
//          reasonably expect a downstream effect, so each of the two carries a
//          VISIBLE note (`NotYetConsulted`) rather than a tooltip: a tooltip is
//          not a promise anyone reads before typing. Both stay EDITABLE — the
//          value is stored, travels with the model, and matters the moment
//          something reads it, so disabling would discard authored intent and
//          buy nothing. `defaultTimeAxis` and `priority` carry no note because
//          both are read. This is the same overstatement that was just taken
//          out of the Rust validator's comment (`insights/strategy/validate.rs`
//          used to claim "every period bucket in every fact is derived from
//          this"), reappearing somewhere a user can see it; when one of these
//          fields acquires a reader, DELETE its note — a stale "nothing reads
//          this" is the same lie pointed the other way.
//
//          (11) THE RULES SECTION HAS TO INVITE ITS OWN ACTION. `Add rule` was
//          a `smallBtn` beside a 13px heading and the empty state read "No
//          rules. A rule annotates facts in a scope; it never generates one." —
//          theory with no call to action. A reviewer read that, missed the
//          button entirely, and concluded rules could not be authored at all;
//          nobody then exercised the rules path, and a 100% path mismatch in
//          its findings went unnoticed. Undiscoverable UI and untested code are
//          the same territory. So the empty state names what a rule DOES in
//          concrete terms and carries the action itself, and a disabled add
//          control states WHY in the same place (`addRuleBlockedReason`) — a
//          read-only subscribed model and a document that has not loaded are
//          different answers, and a grey button with no sentence is what made
//          this invisible in the first place.
//
//          (12) A BAND DIRECTION IS A STATEMENT IN TWO HALVES. Picking
//          `targetBand` used to produce no further input at all, so a person
//          could assert a band-based direction with no band — and the two sit
//          in ONE dropdown looking equally settable. The bounds go in the
//          EXISTING target control rather than a new field, because a document
//          holding `direction: targetBand` beside `target: 1000` has two
//          answers and nothing saying which wins: choosing `targetBand`
//          switches that one control into low/high mode (each bound with its
//          own inclusivity) and CLEARS a target that is not a band, saying so
//          in the status line rather than dropping it silently. The backend
//          validator is what makes the incomplete state impossible; this only
//          makes it hard to reach, and its refusal lands on the row like every
//          other finding.
//
//          (13) CONFIRM IS REVERSIBLE, AND AN EDIT REVOKES IT. Confirm was
//          one-way, and `Confirm all` makes it a one-click claim across a whole
//          grid — an irreversible assertion a mis-click can make is a bad pair,
//          so the CONFIRMED BADGE IS ITSELF the un-confirm control. Worse, an
//          edit used to leave `reviewed: true` standing while re-stamping
//          `source: "authored"`, so a confirmed row could assert a value no
//          human had ever seen. `authoringStamp` (strategyTypes) now drops the
//          confirmation with the same act that re-stamps the source, and
//          Confirm / un-confirm still author nothing.
//
//          (14) A CONFIRMATION CAN BE OVERTAKEN BY INFERENCE. A column is
//          added, a measure renamed, calendar detection flips — and a row
//          confirmed last week now disagrees with what inference would propose
//          today. The divergence is detected LIVE: the tab keeps the draft
//          `strategyInfer` returns (model-only, no engine lock, no query) and
//          diffs it against what the document says, so a row can say both
//          answers and offer inference's. NOTHING IS AUTO-APPLIED. Only rows
//          carrying a human decision are marked — an inferred row that
//          disagrees with today's inference is a stale draft, not a decision.
//
//          (15) THE MODEL PANEL HAS PROVENANCE TOO. `defaultTimeAxis` shows a
//          value guessed from a calendar that was itself guessed, and the panel
//          had no badge to say so — the one place where a person would actually
//          accept that guess was the one place it did not announce itself. The
//          panel carries the same badge, Confirm and un-confirm as a row, at
//          PANEL granularity (`ModelStrategy.reviewed` / `.source`), because
//          there is no row here to confirm one field at a time.

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
  bandDirectionIsIncomplete,
  bandExistsAnywhere,
  bandHighInclusive,
  bandLowInclusive,
  bandTarget,
  compareColumnsByRole,
  emptyStrategyDoc,
  entryState,
  findingsAtPath,
  formatAggregationSpec,
  formatMaterialitySpec,
  formatTargetSpec,
  hasErrors,
  inferenceTakePatch,
  measureDivergences,
  measureEntry,
  measureHasValues,
  measurePath,
  modelColumnRefs,
  modelDivergences,
  modelEntry,
  modelHasColumn,
  modelHasValues,
  parseMaterialitySpec,
  parseTargetSpec,
  rulePath,
  stateIsHumanDecision,
  tableDivergences,
  tableEntry,
  tableHasValues,
  tablePath,
  withAggregationDefault,
  withAggregationException,
  withColumn,
  withMeasure,
  withModel,
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
  Divergence,
  EntryState,
  Finding,
  Materiality,
  MeasureStrategy,
  ModelStrategy,
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
  /** The document the rule is going INTO. Only the band check reads it, and it
   *  has to: whether a `targetBand` direction has a band to land on is a
   *  question about the whole document, not about this rule alone. */
  doc: StrategyDoc,
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

  // A rule that narrows a measure to a BAND direction needs a band SOMEWHERE
  // for that direction to land on. The Rust rules loop never inspected
  // `set.direction` at all, so this was the same silent loss of favourability
  // as on a measure entry with no finding anywhere to say so. The measure grid
  // makes the state hard to reach by switching its target control; the modal's
  // target is one text field, so the refusal is here — and it is scope-blind in
  // exactly the way the validator is, or it would refuse a rule the backend
  // accepts, which is worse than not checking at all.
  if (
    set.direction === "targetBand" &&
    set.target?.type !== "band" &&
    !bandExistsAnywhere(doc, draft.measure, id)
  ) {
    return {
      ok: false,
      error:
        "A targetBand direction needs a band to judge against, and measure '" +
        draft.measure +
        "' has none — not on its entry and not on any other rule. Write this rule's target as band:0.8,1.2 (band:[0.8,1.2) for an exclusive high bound), or give the measure a band. Without one the direction takes the measure's favourability away in this scope and puts nothing back.",
    };
  }

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
// Confirm all — the bulk gesture, and the two things it refuses to confirm
// ===========================================================================

/** What one `Confirm all` actually did, in the terms the person who pressed
 *  it needs to hear them. */
export interface BulkConfirm {
  doc: StrategyDoc;
  /** Rows this click marked as agreed by a human. */
  confirmed: number;
  /** Rows left unconfirmed BECAUSE they carry a finding. */
  warned: number;
  /** Rows left unconfirmed because they state nothing to agree to. */
  empty: number;
}

/**
 * Confirm every measure and table entry EXCEPT the ones a human still has to
 * read.
 *
 * Two exclusions, for two different reasons:
 *
 * A row with a FINDING is the whole point. `reviewed` is what the
 * decomposition engine reads as "a person vouched for this", so a bulk gesture
 * that swept a warned row into it would turn the validator's objection into a
 * human's endorsement — the one place in this tab where that conversion is
 * possible. Per-row Confirm still takes a warned row, because there the person
 * is looking at the warning while they press it.
 *
 * A row in the `empty` state is excluded for the reason per-row Confirm is
 * already disabled on one: confirming an entry with no values states nothing.
 * (`entryState` also refuses to PAINT such a row confirmed, so the old bulk
 * confirm was writing `reviewed: true` into rows the grid then kept drawing as
 * "not set" — a flag with no reader.)
 *
 * Findings are matched with `findingsAtPath`, the same function that renders
 * the badge on the row, so what the skip means and what the row shows cannot
 * drift apart.
 */
export function confirmAllUnwarned(
  doc: StrategyDoc,
  measures: string[],
  tables: string[],
  findings: Finding[],
): BulkConfirm {
  let next = doc;
  const counted = { confirmed: 0, warned: 0, empty: 0 };

  const consider = (
    path: string,
    entry: { reviewed: boolean },
    state: EntryState,
    apply: (d: StrategyDoc) => StrategyDoc,
  ): void => {
    // Already agreed: nothing to do and nothing to report. Counting it as a
    // fresh confirmation would inflate the number the message stands on.
    if (entry.reviewed) return;
    if (state === "empty") {
      counted.empty += 1;
      return;
    }
    if (findingsAtPath(findings, path).length > 0) {
      counted.warned += 1;
      return;
    }
    next = apply(next);
    counted.confirmed += 1;
  };

  for (const name of measures) {
    const entry = measureEntry(doc, name);
    consider(measurePath(name), entry, entryState(entry, measureHasValues(entry)), (d) =>
      withMeasure(d, name, { reviewed: true }),
    );
  }
  for (const name of tables) {
    const entry = tableEntry(doc, name);
    consider(tablePath(name), entry, entryState(entry, tableHasValues(entry)), (d) =>
      withTable(d, name, { reviewed: true }),
    );
  }
  return { doc: next, ...counted };
}

/**
 * What the tab says after a bulk confirm.
 *
 * It always leads with the number confirmed, even when that number is zero —
 * "Confirmed 0 rows." beside two skip sentences is the honest reading of a
 * click that looked like it did everything.
 */
export function describeBulkConfirm(result: BulkConfirm): string {
  const rows = (n: number): string => `${n} row${n === 1 ? "" : "s"}`;
  const parts = [`Confirmed ${rows(result.confirmed)}.`];
  if (result.warned > 0) {
    parts.push(
      `Skipped ${rows(result.warned)} carrying a finding — read the finding and confirm that row itself.`,
    );
  }
  if (result.empty > 0) {
    parts.push(
      `Skipped ${result.empty} empty row${result.empty === 1 ? "" : "s"} — an entry with no values states nothing to agree to.`,
    );
  }
  return parts.join(" ");
}

// ===========================================================================
// The model-wide block
// ===========================================================================

/** One group of columns in the time-axis picker. */
export interface TimeAxisGroup {
  label: string;
  refs: string[];
}

/** Is this column's type one a time series can be plotted against? */
function isDateish(dataType: string): boolean {
  // The backend sends `format!("{:?}", data_type)`, so the two temporal
  // variants of engine-core's `DataType` arrive as exactly these words. This
  // is ORDERING ONLY, never a decision: a type this misses lands in the last
  // group and is still pickable, which is the difference between this and the
  // frontend inference ladder that was deleted for matching `dataType` against
  // exact strings and quietly mis-classifying every `Decimal(38, 10)` column.
  const t = dataType.trim().toLowerCase();
  return t === "date" || t === "timestamp";
}

/**
 * Every column the model has, ordered so the plausible time axes come first.
 *
 * PREFERENCE, NOT A FILTER. The validator errors on an axis that is not a
 * column at all and only WARNS when the axis sits outside the marked date
 * table — a model with no marked date table, or one whose time axis genuinely
 * lives on the fact table, is a real model and must be authorable here. So the
 * marked date table leads, date-typed columns elsewhere follow, and everything
 * else is still on offer underneath.
 *
 * The first group is the whole marked date table rather than its date-TYPED
 * columns, because that is the rule the validator actually applies (it compares
 * the axis's table, not its type) and because a calendar's key column is
 * routinely an integer — filtering by type would demote the very column
 * inference itself picks first.
 */
export function timeAxisGroups(overview: ModelOverview): TimeAxisGroup[] {
  const dateType = new Map<string, string>();
  for (const t of overview.tables) {
    for (const c of t.columns) dateType.set(`${t.name}[${c.name}]`, c.dataType);
  }
  // The same universe the scope editor picks from — one spelling of "the
  // model's columns", so the two pickers cannot come to disagree about it.
  const all = modelColumnRefs(overview);
  const marked = overview.dateTable;
  const inDateTable = (ref: string): boolean =>
    marked !== null && ref.startsWith(`${marked}[`);

  const groups: TimeAxisGroup[] = [
    { label: `marked date table — ${marked ?? ""}`, refs: all.filter(inDateTable) },
    {
      label: "date-typed columns elsewhere",
      refs: all.filter((r) => !inDateTable(r) && isDateish(dateType.get(r) ?? "")),
    },
    {
      label: "every other column",
      refs: all.filter((r) => !inDateTable(r) && !isDateish(dateType.get(r) ?? "")),
    },
  ];
  return groups.filter((g) => g.refs.length > 0);
}

const FISCAL_YEAR_START_HINT =
  "MM-DD — 04-01 for an April fiscal year. Leave empty for the calendar year.";

/**
 * Read a fiscal year start, or say why it is not one.
 *
 * A fiscal year start RECURS, so it carries no year: `2026-04-01` is the
 * commonest wrong answer. Nothing reads the field yet (see property (10)), so
 * today a malformed value is a stored trap rather than a wrong report — which
 * is exactly why the check earns its keep: the trap springs on whoever wires
 * the field up, long after the person who typed it has gone. This comment used
 * to say "every period bucket in every fact is derived from this"; it was not
 * true, and it is the overstatement the field's own on-screen note exists to
 * stop repeating.
 *
 * The month/day ranges mirror the Rust validator
 * (`insights/strategy/validate.rs`) EXACTLY, `02-31` included. That is
 * deliberate: the backend is the authority, and a tab that refused something
 * Save would have accepted would be a second, stricter rule nobody wrote down.
 * This copy exists only to say so at the keystroke rather than at Save.
 */
export function parseFiscalYearStart(
  text: string,
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  const raw = text.trim();
  if (raw === "") return { ok: true, value: undefined };
  const parts = /^(\d{2})-(\d{2})$/.exec(raw);
  const month = parts ? Number(parts[1]) : NaN;
  const day = parts ? Number(parts[2]) : NaN;
  if (!parts || month < 1 || month > 12 || day < 1 || day > 31) {
    return {
      ok: false,
      error: `'${raw}' is not a fiscal year start. Write MM-DD — a fiscal year starts on the same day every year, so it carries no year (04-01, not 2026-04-01).`,
    };
  }
  return { ok: true, value: raw };
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
  applied: Applied<T> | null | undefined,
  format: (value: T) => string,
): string | null {
  // `== null`, deliberately, and the same at every other site that takes an
  // `Applied`. The resolver's `Option<Applied<T>>` fields carry no
  // `skip_serializing_if`, so an attribute nothing decided arrives as an
  // explicit `null`. This read `=== undefined` and crashed the Model Editor on
  // the first measure with no KPI and no strategy entry — which is most
  // measures of most models.
  if (applied == null) return null;
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
  applied: Applied<T> | null | undefined,
  format: (value: T) => string,
): string | null {
  // `carried` comes from the DOCUMENT, whose fields do skip when absent, so
  // `undefined` is the right test for it — the asymmetry with `applied` is real
  // and is why both spellings appear in one function.
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
  applied: Applied<T> | null | undefined,
): string | null {
  if (carried === undefined || applied == null) return null;
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
    applied: Applied<T> | null | undefined,
    format: (value: T) => string,
  ): void {
    if (applied == null) return;
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

/**
 * The target control in BAND mode: two bounds, each with its own inclusivity.
 *
 * It replaces the ordinary target field rather than sitting beside it (property
 * (12)). A band and a literal are two answers to one question, and a document
 * holding both says nothing about which applies — so there is one control, and
 * what it edits depends on the direction.
 *
 * NOTHING PARTIAL IS EVER WRITTEN. A band needs both bounds to mean anything,
 * so a half-filled pair commits `undefined` and the document simply carries no
 * target: the incomplete state lives in the UI, where it is visible and
 * fixable, never in the saved document, where the validator would have to catch
 * it. The boxes are NOT cleared when that happens — the person is mid-edit, and
 * a field that empties itself as you type is how a value that was accepted
 * comes to look rejected.
 */
function BandTargetCell({
  measure,
  band,
  disabled,
  onCommit,
}: {
  measure: string;
  band: Extract<Target, { type: "band" }> | undefined;
  disabled: boolean;
  onCommit: (target: Target | undefined) => void;
}): React.ReactElement {
  const [low, setLow] = useState(band === undefined ? "" : String(band.low));
  const [high, setHigh] = useState(band === undefined ? "" : String(band.high));
  const [lowIn, setLowIn] = useState(band === undefined ? true : bandLowInclusive(band));
  const [highIn, setHighIn] = useState(band === undefined ? true : bandHighInclusive(band));

  // Install a band that arrived from OUTSIDE this control — Infer, "Use
  // inference", a reload. An absent band is deliberately not installed: it is
  // what this control writes while a person is half way through typing one,
  // and resetting the boxes then would delete the bound they had just entered.
  useEffect(() => {
    if (band === undefined) return;
    setLow(String(band.low));
    setHigh(String(band.high));
    setLowIn(bandLowInclusive(band));
    setHighIn(bandHighInclusive(band));
  }, [band]);

  const commit = (l: string, h: string, li: boolean, hi: boolean): void => {
    const lowValue = Number(l.trim());
    const highValue = Number(h.trim());
    if (l.trim() === "" || h.trim() === "" || !Number.isFinite(lowValue) || !Number.isFinite(highValue)) {
      onCommit(undefined);
      return;
    }
    onCommit(bandTarget(lowValue, highValue, li, hi));
  };

  const boundInput = (
    which: "low" | "high",
    value: string,
    setValue: (v: string) => void,
  ): React.ReactElement => (
    <input
      data-testid={`band-${which}-${measure}`}
      aria-label={`${which} bound of ${measure}'s band`}
      style={{ ...smallInput, width: 54 }}
      value={value}
      disabled={disabled}
      placeholder={which === "low" ? "0.8" : "1.2"}
      onChange={(e) => setValue(e.target.value)}
      onBlur={(e) =>
        which === "low" ? commit(e.target.value, high, lowIn, highIn) : commit(low, e.target.value, lowIn, highIn)
      }
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        const typed = (e.target as HTMLInputElement).value;
        if (which === "low") commit(typed, high, lowIn, highIn);
        else commit(low, typed, lowIn, highIn);
      }}
    />
  );

  return (
    <div
      data-testid={`band-${measure}`}
      style={{ display: "flex", gap: 3, alignItems: "center" }}
      title="The acceptable range this measure is judged against. Each bound says whether the bound itself counts as on target."
    >
      <select
        data-testid={`band-low-op-${measure}`}
        aria-label={`low bound inclusivity of ${measure}'s band`}
        style={{ ...smallInput, width: 44 }}
        disabled={disabled}
        value={lowIn ? "inclusive" : "exclusive"}
        onChange={(e) => {
          const next = e.target.value === "inclusive";
          setLowIn(next);
          commit(low, high, next, highIn);
        }}
      >
        <option value="inclusive">&ge;</option>
        <option value="exclusive">&gt;</option>
      </select>
      {boundInput("low", low, setLow)}
      <select
        data-testid={`band-high-op-${measure}`}
        aria-label={`high bound inclusivity of ${measure}'s band`}
        style={{ ...smallInput, width: 44 }}
        disabled={disabled}
        value={highIn ? "inclusive" : "exclusive"}
        onChange={(e) => {
          const next = e.target.value === "inclusive";
          setHighIn(next);
          commit(low, high, lowIn, next);
        }}
      >
        <option value="inclusive">&le;</option>
        <option value="exclusive">&lt;</option>
      </select>
      {boundInput("high", high, setHigh)}
    </div>
  );
}

/**
 * The sentence under a band that is only half stated.
 *
 * It mirrors the Rust validator rather than adding a rule of its own: the
 * backend REFUSES a `targetBand` direction with no band, so this says at the
 * keystroke what Save would otherwise say a minute later. Saying it here does
 * not make it true — the validator does — which is why the wording points at
 * the refusal rather than pretending to be one.
 */
function BandIncomplete({ measure }: { measure: string }): React.ReactElement {
  return (
    <div
      data-testid={`band-incomplete-${measure}`}
      style={{ fontSize: 11, color: "#a4262c", marginTop: 2, whiteSpace: "normal", maxWidth: 200 }}
    >
      A band direction needs both bounds. Until it has them this measure has no favourability and
      no variance, and the strategy is refused on Save.
    </div>
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
 * What a row says today beside what inference would propose now, and the one
 * action that resolves it.
 *
 * BOTH VALUES, ALWAYS. "This is out of date" is not something a person can act
 * on; "you confirmed lowerIsBetter, inference now proposes higherIsBetter" is.
 * The verb follows the row's state, because "you confirmed" about a row nobody
 * ever confirmed is a small lie that costs the whole notice its credibility.
 *
 * There is no auto-apply and no dismiss: applying would overwrite a human
 * decision silently, and dismissing would store a "I have seen this" flag that
 * goes stale the next time the model changes. The divergence simply stops being
 * true once either side is changed.
 */
function DivergenceNote({
  id,
  label,
  state,
  divergences,
  disabled,
  onTake,
}: {
  /** The row's own name, for the test ids. Separate from `label` because the
   *  model block's label is a phrase and a test id is not. */
  id: string;
  label: string;
  state: EntryState;
  divergences: Divergence[];
  disabled: boolean;
  onTake: () => void;
}): React.ReactElement | null {
  if (divergences.length === 0) return null;
  const verb = state === "confirmed" ? "You confirmed" : "You set";
  return (
    <div
      data-testid={`divergence-${id}`}
      style={{ fontSize: 11, color: "#7a5b00", marginTop: 3, whiteSpace: "normal", maxWidth: 260 }}
    >
      {divergences.map((d) => (
        <div key={d.field}>
          {/* An entry that says NOTHING about a field is the commonest half of
              this pair — a column was added, and the confirmed row predates it.
              "(nothing)" is the honest word for that; an empty string reads as
              a rendering bug. */}
          {`${verb} ${d.field} ${d.yours === "" ? "(nothing)" : `'${d.yours}'`}; inference now proposes '${d.inference}'.`}
        </div>
      ))}
      <button
        data-testid={`take-inference-${id}`}
        style={{ ...styles.smallBtn, marginTop: 2 }}
        disabled={disabled}
        title={`Replace ${label}'s diverging values with what inference proposes today. The row goes back to being a proposal — nobody has confirmed the new values yet.`}
        onClick={onTake}
      >
        Use inference
      </button>
    </div>
  );
}

/**
 * The row's state, with the Confirm action beside it — and the way back.
 *
 * An `empty` row keeps the button but DISABLES it: confirming a row that says
 * nothing agrees to nothing, and a live Confirm over four "—" cells is how a
 * person learns to confirm without reading. The title says why rather than
 * leaving a dead control unexplained.
 *
 * A CONFIRMED row's badge IS the un-confirm control. Confirm is the claim that
 * a human vouched for a value and `Confirm all` can make it across a whole grid
 * in one click, so leaving no way back pairs an irreversible assertion with a
 * gesture a mis-click can perform. Putting it on the badge rather than only in
 * a bulk action means the way back is where the claim is.
 */
function ReviewedCell({
  id,
  state,
  onConfirm,
  onUnconfirm,
  disabled,
  label,
}: {
  /** The row's own name, for the test ids — see `DivergenceNote`. */
  id: string;
  state: EntryState;
  onConfirm: () => void;
  onUnconfirm: () => void;
  disabled: boolean;
  label: string;
}): React.ReactElement {
  if (state === "confirmed") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          data-testid={`unconfirm-${id}`}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            cursor: disabled ? "default" : "pointer",
          }}
          disabled={disabled}
          title={`Un-confirm ${label} — it goes back to whatever it was before a human agreed to it. The values are not changed.`}
          onClick={onUnconfirm}
        >
          <Badge tone="ok">confirmed &times;</Badge>
        </button>
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
// The model-wide panel
// ===========================================================================

/**
 * `fiscalYearStart`, with the refusal where the typing happened.
 *
 * Same commit-on-blur discipline as `SpecInput` — an unreadable value keeps the
 * typed text rather than reverting, because a value that vanishes reads as
 * "accepted". It is a separate component because the refusal here is a SENTENCE
 * ("a fiscal year carries no year"), and a sentence does not fit in the red
 * border and tooltip a dense grid cell has room for.
 */
function FiscalYearStartField({
  value,
  disabled,
  onCommit,
}: {
  value: string;
  disabled: boolean;
  onCommit: (value: string | undefined) => void;
}): React.ReactElement {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(value);
    setError(null);
  }, [value]);
  const commit = (raw: string): void => {
    const parsed = parseFiscalYearStart(raw);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    onCommit(parsed.value);
  };
  return (
    <>
      <input
        data-testid="model-fiscal-year-start"
        style={{ ...styles.input, borderColor: error ? "#a4262c" : "#ccc" }}
        value={text}
        disabled={disabled}
        placeholder="04-01"
        title={FISCAL_YEAR_START_HINT}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
        }}
      />
      {error !== null && (
        <div
          data-testid="model-fiscal-year-start-error"
          style={{ color: "#a4262c", fontSize: 11, marginTop: 2 }}
        >
          {error}
        </div>
      )}
    </>
  );
}

/**
 * The exact sentence a stored-but-unread field says about itself.
 *
 * "Saved" and "nothing reads it" both have to be in it. Half of that sentence
 * on its own is a new lie in the other direction: "nothing reads this" alone
 * reads as "typing here is pointless", and the value IS kept, travels with the
 * model, and is the thing whoever wires the feature up will find waiting.
 */
const NOT_YET_CONSULTED =
  "Saved with the strategy and carried with the model — but nothing reads it yet, so setting it changes no insight today.";

/**
 * The visible note on a control whose value is stored and consulted by nothing.
 *
 * See property (10). It is a `<div>` under the input rather than a `title`
 * because a tooltip is not a promise anybody reads before typing, and the whole
 * objection here is that an ordinary-looking box quietly promises a downstream
 * effect it does not have. `field` is the document key, so the marker a test
 * enumerates is the same string the field is called in `ModelStrategy` — a note
 * that outlived its field would then be findable rather than merely wrong.
 */
function NotYetConsulted({ field }: { field: keyof ModelStrategy }): React.ReactElement {
  return (
    <div
      data-testid={`model-not-consulted-${field}`}
      data-inert-field={field}
      style={{ fontSize: 11, color: "#7a5b00", marginTop: 2 }}
    >
      {NOT_YET_CONSULTED}
    </div>
  );
}

/**
 * The four model-wide fields, above the grids they set the defaults for.
 *
 * `defaultTimeAxis` leads because it is the load-bearing one: it is the axis
 * every time-series fact is computed against, and until this panel existed the
 * only way it could be set was whatever inference guessed from the marked date
 * table.
 *
 * NOTHING HERE SHOWS AN INHERITED VALUE the way a measure cell does, and that
 * is a limit rather than an oversight: `strategyPreview` resolves MEASURES, so
 * there is no model-level resolved answer to read. The empty option therefore
 * says that inference decides, without pretending to know what it will decide.
 *
 * IT DOES CARRY PROVENANCE (property (15)). `defaultTimeAxis` shows a value
 * guessed from a calendar that was itself guessed; the insights output already
 * announces that guess, and until now the one place a person could actually
 * ACCEPT it said nothing. The badge, Confirm, un-confirm and the divergence
 * notice are the same four things a row has, at panel granularity — there is no
 * per-field row here to confirm, and four badges over four boxes would say less
 * than one.
 */
function ModelPanel({
  doc,
  overview,
  findings,
  inferredModel,
  disabled,
  onEdit,
}: {
  doc: StrategyDoc;
  overview: ModelOverview;
  findings: Finding[];
  /** What inference proposes for the model block TODAY, or undefined when no
   *  draft could be built. Diffed live against the stored block. */
  inferredModel: ModelStrategy | undefined;
  disabled: boolean;
  onEdit: (doc: StrategyDoc) => void;
}): React.ReactElement {
  const model = modelEntry(doc);
  const state = entryState(model, modelHasValues(model));
  const divergences = stateIsHumanDecision(state)
    ? modelDivergences(model, inferredModel)
    : [];
  const groups = useMemo(() => timeAxisGroups(overview), [overview]);
  const axis = model.defaultTimeAxis ?? "";
  // An axis the model no longer has must stay SELECTED and say so. A <select>
  // whose value matches no option silently renders as blank, which would read
  // as "nobody set an axis" and would erase the setting on the next edit —
  // exactly the orphan case the measures grid spells out rather than hides.
  const axisIsOrphan = axis !== "" && !groups.some((g) => g.refs.includes(axis));
  const priority = model.priority ?? [];

  return (
    <section data-testid="model-panel" data-strategy-state={state}>
      <div style={styles.sectionHeader}>
        <span style={{ ...styles.sectionTitle, fontSize: 13 }}>Model</span>
        <RowFindings findings={findingsAtPath(findings, "model")} />
        {/* The whole panel is one entry, so it confirms as one. The label is
            "the model block" rather than a name, because the sentence a
            disabled Confirm has to say ("the strategy says nothing about …
            yet") needs a subject a person recognises. */}
        <ReviewedCell
          id="model"
          state={state}
          disabled={disabled}
          label="the model block"
          onConfirm={() => onEdit(withModel(doc, { reviewed: true }))}
          onUnconfirm={() => onEdit(withModel(doc, { reviewed: false }))}
        />
      </div>
      <DivergenceNote
        id="model"
        label="the model block"
        state={state}
        divergences={divergences}
        disabled={disabled}
        onTake={() => {
          if (inferredModel === undefined) return;
          onEdit(withModel(doc, inferenceTakePatch(inferredModel, divergences)));
        }}
      />
      <div
        style={{
          ...styles.card,
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "flex-start",
        }}
      >
        <Field
          label="Default time axis"
          hint="The column every time-series fact is computed against."
          flex={2}
        >
          <select
            data-testid="model-default-time-axis"
            style={{ ...styles.input, minWidth: 220 }}
            disabled={disabled}
            value={axis}
            title="Picked from the model's own columns — a typed name would be an axis that silently disables every time fact."
            onChange={(e) =>
              onEdit(
                withModel(doc, {
                  defaultTimeAxis: e.target.value === "" ? undefined : e.target.value,
                }),
              )
            }
          >
            <option value="">(none — inference picks one from the marked date table)</option>
            {axisIsOrphan && (
              <option value={axis}>{axis} — not a column in this model</option>
            )}
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.refs.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <FieldFindings findings={findingsAtPath(findings, "model.defaultTimeAxis")} />
        </Field>

        <Field label="Fiscal year start" hint={FISCAL_YEAR_START_HINT} flex={1}>
          <FiscalYearStartField
            value={model.fiscalYearStart ?? ""}
            disabled={disabled}
            onCommit={(fiscalYearStart) => onEdit(withModel(doc, { fiscalYearStart }))}
          />
          {/* Editable, and honest about being inert — property (10). The format
              is still refused at the keystroke, because a value stored
              malformed is a trap for whoever eventually reads it. */}
          <NotYetConsulted field="fiscalYearStart" />
          <FieldFindings findings={findingsAtPath(findings, "model.fiscalYearStart")} />
        </Field>

        <Field label="Reporting currency" hint="A short code — SEK, EUR." flex={1}>
          <input
            data-testid="model-reporting-currency"
            style={styles.input}
            disabled={disabled}
            value={model.reportingCurrency ?? ""}
            placeholder="SEK"
            onChange={(e) =>
              onEdit(
                withModel(doc, {
                  reportingCurrency: e.target.value === "" ? undefined : e.target.value,
                }),
              )
            }
          />
          {/* This is the field the objection was actually about: somebody types
              SEK here and reasonably expects a currency to appear downstream.
              Nothing anywhere reads `reportingCurrency`. */}
          <NotYetConsulted field="reportingCurrency" />
        </Field>

        <Field
          label="Priority"
          hint="Measure names, most important first. Ranking ties break by this order."
          flex={2}
        >
          {/* READ-ONLY on purpose: reordering is a drag-and-drop list this panel
              does not have. Showing the order is what makes it reviewable, and
              clearing it is the one edit that needs no ordering gesture. */}
          <div data-testid="model-priority" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {priority.length === 0 ? (
              <span style={{ ...styles.muted, fontSize: 12 }}>
                (no order — ranking breaks its own ties)
              </span>
            ) : (
              <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                {priority.map((name, i) => (
                  <li key={`${name}-${String(i)}`}>{name}</li>
                ))}
              </ol>
            )}
            <button
              style={styles.smallBtn}
              disabled={disabled || priority.length === 0}
              title="Drop the priority order entirely. Reordering it is not built here — clear it, or edit the order elsewhere."
              onClick={() => onEdit(withModel(doc, { priority: undefined }))}
            >
              Clear order
            </button>
          </div>
          <FieldFindings findings={findingsAtPath(findings, "model.priority")} />
        </Field>
      </div>
    </section>
  );
}

/** The findings a model field carries, spelled out — there is no row here to
 *  hang a badge on, and the panel has the width to say them. */
function FieldFindings({ findings }: { findings: Finding[] }): React.ReactElement | null {
  if (findings.length === 0) return null;
  return (
    <div style={{ fontSize: 11, marginTop: 2 }}>
      {findings.map((f, i) => (
        <div
          key={`${f.code}-${String(i)}`}
          data-finding-severity={f.severity}
          style={{ color: f.severity === "error" ? "#a4262c" : "#7a5b00" }}
        >
          {f.code}: {f.message}
        </div>
      ))}
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
  /**
   * What inference proposes for THIS model right now — the other half of the
   * divergence check (property (14)).
   *
   * It is fetched on every load, including when a stored document exists, which
   * is the one call the tab did not use to make. Inference is model-only (no
   * engine lock, no query), and the alternative — a hash of the values stored
   * at the moment of confirmation — would need maintaining on every edit, would
   * go stale in its own way, and would say nothing at all about a document
   * written before it existed. `null` means no draft could be built, and then
   * no row claims a divergence.
   */
  const [inferred, setInferred] = useState<StrategyDoc | null>(null);

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
    setInferred(null);

    void (async (): Promise<void> => {
      // ONE inference per load, started beside the read rather than after it.
      // It has two consumers — the draft a model with no stored strategy opens
      // on, and the live divergence check every stored row is diffed against —
      // and asking twice would be two answers to one question as well as two
      // round trips. A draft that cannot be built is not an error: the tab
      // simply has no draft and no divergences.
      const drafting = strategyInfer(connectionId).then(
        (d) => d,
        () => null,
      );
      let next: StrategyDoc = emptyStrategyDoc();
      let note: string | null = null;
      let draft: StrategyDoc | null = null;
      try {
        const stored = await strategyGet(connectionId);
        if (loadSeq.current !== seq) return;
        draft = await drafting;
        if (loadSeq.current !== seq) return;
        if (stored) {
          // A stored document is the authority. It is never auto-inferred over
          // and a draft is never merged into it — the draft fetched above is
          // read ONLY to say where the two disagree.
          unsavedDrafts.delete(connectionId);
          next = stored;
        } else {
          const remembered = unsavedDrafts.get(connectionId);
          if (remembered) {
            // Coming BACK to the tab. Installing the draft here would discard
            // whatever the user confirmed before they switched sections.
            next = remembered;
            note = RESUMED_STATUS;
          } else if (draft) {
            next = draft;
            unsavedDrafts.set(connectionId, next);
            note = DRAFT_STATUS;
          } else {
            next = emptyStrategyDoc();
            note = NO_DRAFT_STATUS;
          }
        }
      } catch (err: unknown) {
        if (loadSeq.current !== seq) return;
        next = emptyStrategyDoc();
        reportError(err);
      }
      if (loadSeq.current !== seq) return;
      setDoc(next);
      setInferred(draft);
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

  /** Install a new working draft. The ONE write path for a local edit: it
   *  remembers the draft for this connection so leaving the tab does not
   *  discard it. */
  const applyDraft = useCallback(
    (next: StrategyDoc, opts: { keepFindings: boolean; status: string | null }) => {
      unsavedDrafts.set(connectionId, next);
      setDoc(next);
      if (!opts.keepFindings) setFindings([]);
      setStatus(opts.status);
    },
    [connectionId],
  );

  /** Every local edit goes through here. Findings are cleared, because a
   *  finding describes the document that produced it and an edited document
   *  has not been judged yet — a stale error would keep Save locked over a
   *  problem the user just fixed.
   *
   *  `note` is for the rare edit that does something to the document BESIDES
   *  what was asked — today only switching a direction to `targetBand`, which
   *  clears a target that is not a band. Silent collateral damage is what the
   *  aggregation cell's data-loss bug was made of, so the one place that does
   *  it says so out loud. */
  const edit = useCallback(
    (next: StrategyDoc, note: string | null = null) =>
      applyDraft(next, { keepFindings: false, status: note }),
    [applyDraft],
  );

  const columnRefs = useMemo(() => modelColumnRefs(overview), [overview]);
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const disabled = readOnly || busy || doc === null;
  // Computed from the SAME three inputs `disabled` is, so the sentence and the
  // grey cannot come apart: a control that is dead for a reason nobody states
  // is what made the Rules section read as unbuilt (property (11)).
  const addRuleBlocked = addRuleBlockedReason({
    readOnly,
    readOnlyReason: overview.readOnlyReason,
    loaded: doc !== null,
    busy,
  });

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
      // The divergence reference moves with the draft. Leaving the old one
      // behind would leave rows claiming to disagree with an inference that has
      // just been overwritten by this very one.
      setInferred(drafted);
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
    const result = confirmAllUnwarned(
      doc,
      overview.measures.map((m) => m.name),
      overview.tables.map((t) => t.name),
      findings,
    );
    // KEEPS THE FINDINGS, alone among the edits. They are the evidence for the
    // sentence this write puts on screen — clearing them would leave "skipped 3
    // rows carrying a finding" above a grid where nothing is warned any more,
    // which is a worse lie than the silent skip it replaced. Confirming a row
    // can only retire an unreviewed-entry warning, never raise a new finding,
    // so what survives here is at worst stale in the safe direction and
    // Validate refreshes it.
    applyDraft(result.doc, { keepFindings: true, status: describeBulkConfirm(result) });
  }, [doc, findings, applyDraft, overview]);

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
        <ModelPanel
          doc={doc}
          overview={overview}
          findings={findings}
          inferredModel={inferred?.model}
          disabled={disabled}
          onEdit={edit}
        />
        <MeasuresGrid
          doc={doc}
          overview={overview}
          findings={findings}
          preview={preview}
          inferred={inferred}
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
          inferred={inferred}
          selectedPath={selectedPath}
          disabled={disabled}
          onEdit={edit}
        />
        <RulesGrid
          doc={doc}
          findings={findings}
          selectedPath={selectedPath}
          disabled={disabled}
          blockedReason={addRuleBlocked}
          onAdd={() => setEditing({ original: null })}
          onEditRule={(rule) => setEditing({ original: rule })}
          onDelete={(id) => edit(withoutRule(doc, id))}
        />
        <FindingsStrip findings={findings} onSelect={setSelectedPath} selectedPath={selectedPath} />
      </div>

      {editing && (
        <RuleModal
          overview={overview}
          doc={doc}
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
// The bracket spelling is in the hint because it is the only place the
// exclusive form is discoverable from a text field: the measures grid gives a
// band direction its own two-bound control, but a band on any OTHER direction,
// and every band in a rule, is still typed.
const TARGET_HINT = "1000 | kpi | measure:Budget | band:0.8,1.2 | band:[0.8,1.2)";
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
  inferred,
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
  /** Today's inference draft, for the live divergence check. Null when none
   *  could be built — then no row claims a disagreement. */
  inferred: StrategyDoc | null;
  selectedPath: string | null;
  columnRefs: string[];
  disabled: boolean;
  /** `note` is shown in the status line when an edit does something besides
   *  what was asked — see the section's `edit`. */
  onEdit: (doc: StrategyDoc, note?: string | null) => void;
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
        <button
          style={styles.smallBtn}
          disabled={disabled}
          title="Confirm every measure and table that is ready — rows carrying a finding are left for you to read, and rows that state nothing have nothing to agree to."
          onClick={onConfirmAll}
        >
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
              // What inference proposes for this measure TODAY, diffed against
              // what the row says. Only a row a human has a stake in can be
              // OVERTAKEN: an inferred row that disagrees with today's
              // inference is a stale draft, not a decision worth interrupting
              // anyone over.
              const proposed = inferred?.measures?.[m.name];
              const divergences = stateIsHumanDecision(state)
                ? measureDivergences(entry, proposed)
                : [];
              // Computed BEFORE the direction changes, because it is the target
              // that is about to be cleared and its old text is what the
              // message has to name.
              const nonBandTarget =
                entry.target !== undefined && entry.target.type !== "band"
                  ? formatTargetSpec(entry.target)
                  : "";
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
                      (v) => {
                        const patch: Partial<MeasureStrategy> = {
                          direction: v === "" ? undefined : v,
                        };
                        // `targetBand` and a literal target are two answers to
                        // one question. The band goes in the SAME control, so
                        // choosing this direction takes the other answer away
                        // rather than leaving the document holding both with
                        // nothing to say which wins — and says it did.
                        const clearing = v === "targetBand" && nonBandTarget !== "";
                        if (clearing) patch.target = undefined;
                        onEdit(
                          withMeasure(doc, m.name, patch),
                          clearing
                            ? `Cleared ${m.name}'s target '${nonBandTarget}' — a band direction is judged against a low and a high, which you now set in the target cell.`
                            : null,
                        );
                      },
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
                    {/* ONE control, two modes. A band direction is judged
                        against bounds, so the target cell becomes the bounds —
                        it does not grow a second field beside a first one that
                        would then contradict it. */}
                    {entry.direction === "targetBand" ? (
                      <BandTargetCell
                        measure={m.name}
                        band={entry.target?.type === "band" ? entry.target : undefined}
                        disabled={disabled}
                        onCommit={(target) => onEdit(withMeasure(doc, m.name, { target }))}
                      />
                    ) : (
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
                    )}
                    {bandDirectionIsIncomplete(entry) && <BandIncomplete measure={m.name} />}
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
                      id={m.name}
                      state={state}
                      disabled={disabled}
                      label={m.name}
                      onConfirm={() => onEdit(withMeasure(doc, m.name, { reviewed: true }))}
                      onUnconfirm={() => onEdit(withMeasure(doc, m.name, { reviewed: false }))}
                    />
                    <DivergenceNote
                      id={m.name}
                      label={m.name}
                      state={state}
                      divergences={divergences}
                      disabled={disabled}
                      onTake={() => {
                        if (proposed === undefined) return;
                        onEdit(
                          withMeasure(doc, m.name, inferenceTakePatch(proposed, divergences)),
                        );
                      }}
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
  inferred,
  selectedPath,
  disabled,
  onEdit,
}: {
  doc: StrategyDoc;
  overview: ModelOverview;
  findings: Finding[];
  /** Today's inference draft, for the live divergence check. */
  inferred: StrategyDoc | null;
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
              const proposed = inferred?.tables?.[t.name];
              const divergences = stateIsHumanDecision(state)
                ? tableDivergences(entry, proposed)
                : [];
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
                        id={t.name}
                        state={state}
                        disabled={disabled}
                        label={t.name}
                        onConfirm={() => onEdit(withTable(doc, t.name, { reviewed: true }))}
                        onUnconfirm={() => onEdit(withTable(doc, t.name, { reviewed: false }))}
                      />
                      <DivergenceNote
                        id={t.name}
                        label={t.name}
                        state={state}
                        divergences={divergences}
                        disabled={disabled}
                        onTake={() => {
                          if (proposed === undefined) return;
                          onEdit(withTable(doc, t.name, inferenceTakePatch(proposed, divergences)));
                        }}
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

/**
 * What a rule is FOR, in the terms of the thing a person came here to do.
 *
 * The old empty state said "A rule annotates facts in a scope; it never
 * generates one." — true, and unactionable: it names a category, not a job, and
 * a reader who does not already know what a scope is learns nothing from it.
 * The clause about not GENERATING facts survives because it is the one thing
 * people get wrong about rules, but it now comes after the job rather than
 * instead of it.
 */
const RULE_INVITATION =
  "A rule scopes one answer to part of the model: a direction, a target, a materiality or a " +
  "cadence that applies only to certain members of a column, or only from a certain date — " +
  "leaving every other slice as it was. It annotates the facts inside that scope; it never " +
  "generates one.";

/**
 * Why `Add rule` is grey, or null when it is not.
 *
 * A disabled control with no sentence beside it is what let a reviewer conclude
 * rules could not be authored at all (property (11)), so the answer has to be
 * specific: a read-only model is a DIFFERENT problem from a document that has
 * not arrived, and only one of the two is going to fix itself.
 *
 * `readOnlyReason` is preferred over any sentence written here, because the
 * host already knows why this model refuses edits (a subscribed copy is the
 * usual answer, not the only one) and a second guess in this file would be a
 * second source of truth that drifts from the banner above it.
 */
export function addRuleBlockedReason(opts: {
  readOnly: boolean;
  readOnlyReason: string | null;
  loaded: boolean;
  busy: boolean;
}): string | null {
  // Order matters: an unloaded document is also `disabled`, and answering
  // "read-only" for it would send someone to look for a subscription that is
  // not there.
  if (!opts.loaded) {
    return "The strategy has not loaded yet — Add rule wakes up as soon as this model's strategy arrives.";
  }
  if (opts.readOnly) {
    const reason = (opts.readOnlyReason ?? "").trim();
    return reason === ""
      ? "This model is read-only — it is a subscribed copy, so its rules are authored where the model is published, not here."
      : `This model is read-only, so rules cannot be authored here: ${reason}`;
  }
  if (opts.busy) {
    return "Another strategy action is still running — Add rule comes back when it finishes.";
  }
  return null;
}

/** The sentence under a disabled add control. Rendered in ONE place at a time —
 *  beside whichever add control the section is currently showing — so a test
 *  that finds two of these has found a duplicated explanation. */
function AddRuleBlocked({ reason }: { reason: string }): React.ReactElement {
  return (
    <div
      data-testid="rules-add-blocked"
      style={{ fontSize: 11, color: "#7a5b00", marginTop: 4 }}
    >
      {reason}
    </div>
  );
}

function RulesGrid({
  doc,
  findings,
  selectedPath,
  disabled,
  blockedReason,
  onAdd,
  onEditRule,
  onDelete,
}: {
  doc: StrategyDoc;
  findings: Finding[];
  selectedPath: string | null;
  disabled: boolean;
  /** Why the add control is grey, or null when it is live. */
  blockedReason: string | null;
  onAdd: () => void;
  onEditRule: (rule: Rule) => void;
  onDelete: (id: string) => void;
}): React.ReactElement {
  const rules = doc.rules ?? [];
  const empty = rules.length === 0;
  return (
    <section>
      <div style={styles.sectionHeader}>
        <span style={{ ...styles.sectionTitle, fontSize: 13 }}>Rules</span>
        <button
          style={styles.smallBtn}
          disabled={disabled}
          title={blockedReason ?? RULE_INVITATION}
          onClick={onAdd}
        >
          Add rule
        </button>
      </div>
      {/* When the grid is empty the explanation belongs beside the empty
          state's own button, which is the add control a person is actually
          looking at. Never both — one sentence, wherever the live affordance
          is. */}
      {blockedReason !== null && !empty && <AddRuleBlocked reason={blockedReason} />}
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
            {empty && (
              <tr>
                <td style={styles.td} colSpan={6}>
                  {/* The action lives HERE as well as in the header. The header
                      button is an 11px control beside a 13px heading; a reader
                      who has just been told what a rule is for should not have
                      to go and find it. */}
                  <div data-testid="rules-empty" style={{ maxWidth: 720 }}>
                    <div style={{ fontSize: 12, color: "#444", marginBottom: 6 }}>
                      No rules yet. {RULE_INVITATION}
                    </div>
                    <button
                      data-testid="rules-empty-add"
                      style={styles.btn}
                      disabled={disabled}
                      title={blockedReason ?? RULE_INVITATION}
                      onClick={onAdd}
                    >
                      Add the first rule
                    </button>
                    {blockedReason !== null && <AddRuleBlocked reason={blockedReason} />}
                  </div>
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
  doc,
  original,
  onClose,
  onSave,
}: {
  overview: ModelOverview;
  /** The document the rule joins — read only by the band check, which is a
   *  question about the whole document rather than about this rule. */
  doc: StrategyDoc;
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
    const built = buildRuleFromDraft(overview, draft, doc);
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
        <Field
          label="Target"
          hint={
            draft.direction === "targetBand"
              ? // A rule that scopes a band direction must scope the band with
                // it, or it takes the measure's favourability away in that
                // scope and puts nothing back. `buildRuleFromDraft` refuses the
                // rule; this says so before OK is pressed.
                "A band is required by this direction: band:0.8,1.2 (or band:[0.8,1.2) for an exclusive high bound)"
              : TARGET_HINT
          }
          flex={1}
        >
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

// FILENAME: app/extensions/ModelEditor/components/sections/strategy/RuleModal.tsx
// PURPOSE: The rule editor.
// CONTEXT: Implements properties (4) and (18). The scope column is a <select>
//          over the model's own columns — a typo in a scope is a rule that
//          silently NEVER FIRES, which looks exactly like a rule that was never
//          needed — and `suppress` is a closed set of checkboxes because a
//          near-miss is not a suppression that does nothing, it is a document
//          that fails serde and makes the backend discard the WHOLE strategy.
//          See ../StrategySection.tsx.

import React, { useMemo, useState } from "react";
import type { ModelOverview, ModelTableInfo } from "@api";

import {
  Field,
  Modal,
  styles,
} from "../../editorShared";
import { Chevron, FolderIcon, TREE_INDENT } from "../../treeKit";
import {
  ME,
} from "../../theme";
import { buildRuleFromDraft, emptyRuleDraft, ruleToDraft } from "./ruleDraft";
import type { RuleDraft, ScopeClauseDraft } from "./ruleDraft";

import { buildFolderTree, splitFolderPath, FOLDER_SEP } from "../../../lib/measureFolders";
import type {
  Applied,
  AttrSource,
  ResolvedMeasure,
  StrategyPreviewMeasure,
} from "../../../lib/strategyBackend";
import {
  CADENCES,
  DIRECTIONS,
  SUPPRESSIBLE_FACT_KINDS,
  modelColumnRefs,
  parseSuppressSpec,
} from "../../../lib/strategyTypes";
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
  TableKindOrigin,
  Target,
  Unit,
} from "../../../lib/strategyTypes";
import {
  TARGET_HINT,
} from "./constants";
import type { MeasureColumnGroup, MeasureRowFilter } from "./constants";
import {
  inheritedFor,
  inheritedFrom,
  inheritedOption,
  overridingRule,
  sourceKpiName,
  sourceLabel,
  sourceRuleId,
  whyLines,
} from "./inheritance";
import {
  BandIncomplete,
  BandTargetCell,
  ColumnRefList,
  DivergenceNote,
  KindOriginBadge,
  ReviewedCell,
  RowFindings,
  RuleOverrideMark,
  SpecInput,
  STICKY_CONFIRM,
  WhyCell,
  cellStyle,
  rowTone,
  selectOf,
  smallInput,
  stickyConfirmCell,
  stickyHeaderStyle,
} from "./cells";

// ===========================================================================

/**
 * The eight fact kinds, as toggles over the draft's comma-separated string.
 *
 * IT KEEPS THE STRING because that is what `RuleDraft` stores and what survives
 * an unsaved draft round trip; what changes is that nothing can put a
 * ninth value into it. The order is `SUPPRESSIBLE_FACT_KINDS`, i.e. the Rust
 * variant order, so a person reading a rule beside the type sees the same list
 * in the same sequence.
 *
 * A checkbox each, not a multi-select: a `<select multiple>` hides how many
 * options exist behind a scroll box and needs ctrl-click to deselect, and there
 * are only eight of them.
 */
export function SuppressPicker({
  value,
  onChange,
}: {
  /** The draft's comma-separated spelling. */
  value: string;
  onChange: (next: string) => void;
}): React.ReactElement {
  // Whatever the draft holds, read through the parser: an older unsaved draft
  // can carry a spelling this control can no longer produce, and it must not
  // render as "nothing selected" and then be silently kept on save.
  const parsed = parseSuppressSpec(value);
  const chosen = new Set(parsed.ok ? parsed.kinds : []);
  return (
    <div data-testid="suppress-picker" style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px" }}>
      {SUPPRESSIBLE_FACT_KINDS.map((kind) => (
        <label
          key={kind}
          style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}
        >
          <input
            type="checkbox"
            data-testid={`suppress-${kind}`}
            checked={chosen.has(kind)}
            onChange={() => {
              const next = new Set(chosen);
              if (next.has(kind)) next.delete(kind);
              else next.add(kind);
              // Emitted in vocabulary order rather than click order, so the
              // same set of kinds always writes the same string.
              onChange(SUPPRESSIBLE_FACT_KINDS.filter((k) => next.has(k)).join(","));
            }}
          />
          {kind}
        </label>
      ))}
    </div>
  );
}

export function RuleModal({
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
                {/* Free text rather than `type="date"` on purpose: the bounds
                    are ISO-8601 TEXT the backend compares as text, and a
                    native date picker renders in the browser's locale, which
                    would show a person `2025-01-06` as `06/01/2025` and invite
                    them to type it back that way. The FORM is refused instead,
                    by `buildRuleFromDraft` — against the real calendar, so
                    `2026-02-31` does not reach a document that would then fail
                    to deserialize wholesale. */}
                <input
                  aria-label="Scope from"
                  style={{ ...styles.input, width: 118 }}
                  value={clause.from}
                  placeholder="2025-01-01"
                  title="YYYY-MM-DD. The date the rule starts applying."
                  onChange={(e) => patchClause(i, { from: e.target.value })}
                />
                <input
                  aria-label="Scope to"
                  style={{ ...styles.input, width: 118 }}
                  value={clause.to}
                  placeholder="2025-06-30"
                  title="YYYY-MM-DD, or empty for a rule with no end date."
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
        {/*
          THE VOCABULARY IS THE CONTROL NOW, NOT A HINT UNDER A TEXT BOX. This
          was a free-text field whose hint used to read "e.g. outlier,trend" —
          and `outlier` is a kind nothing emits under any spelling. Since
          `suppress` became `Vec<SuppressibleFactKind>` the cost of a near-miss
          is no longer "this suppression does nothing": the document fails
          serde, and the backend answers that by discarding the WHOLE strategy
          and running on the default. A box that can type an unsaveable value
          into a document that big is worse than the untyped version it
          replaced, so the eight kinds are the only things clickable.
        */}
        <Field
          label="Suppress"
          hint="fact kinds to withhold here — it can only take facts away"
          flex={1}
        >
          <SuppressPicker
            value={draft.suppress}
            onChange={(next) => patch({ suppress: next })}
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

      {error && <div style={{ color: ME.dangerFg, marginBottom: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}

// FILENAME: app/extensions/ModelEditor/components/sections/strategy/ModelPanel.tsx
// PURPOSE: The model-wide block: default time axis, fiscal year start and
//          priority order.
// CONTEXT: Implements properties (9), (10) and (15). The axis is a <select>
//          over the model's own columns because a typo there silently disables
//          every time fact; the inert fields carry a VISIBLE note rather than a
//          tooltip; and the panel carries the same badge, Confirm and
//          un-confirm as a row, at PANEL granularity — there is no row here to
//          confirm one field at a time. See ../StrategySection.tsx.

import React, { useEffect, useMemo, useState } from "react";
import type { ModelOverview, ModelTableInfo } from "@api";

import {
  Field,
  styles,
} from "../../editorShared";
import { Chevron, FolderIcon, TREE_INDENT } from "../../treeKit";
import {
  ME,
} from "../../theme";
import { parseFiscalYearStart, timeAxisGroups } from "./timeAxis";

import { buildFolderTree, splitFolderPath, FOLDER_SEP } from "../../../lib/measureFolders";
import type {
  Applied,
  AttrSource,
  ResolvedMeasure,
  StrategyPreviewMeasure,
} from "../../../lib/strategyBackend";
import {
  entryState,
  findingsAtPath,
  inferenceTakePatch,
  modelDivergences,
  modelEntry,
  modelHasValues,
  stateIsHumanDecision,
  withModel,
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
  FISCAL_YEAR_START_HINT,
  NOT_YET_CONSULTED,
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
  DivergenceNote,
  ReviewedCell,
  RowFindings,
} from "./cells";

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
export function FiscalYearStartField({
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
        style={{ ...styles.input, borderColor: error ? ME.dangerFg : ME.ctlBorder }}
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
          style={{ color: ME.dangerFg, fontSize: 11, marginTop: 2 }}
        >
          {error}
        </div>
      )}
    </>
  );
}

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
export function NotYetConsulted({ field }: { field: keyof ModelStrategy }): React.ReactElement {
  return (
    <div
      data-testid={`model-not-consulted-${field}`}
      data-inert-field={field}
      style={{ fontSize: 11, color: ME.warnFg, marginTop: 2 }}
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
export function ModelPanel({
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
export function FieldFindings({ findings }: { findings: Finding[] }): React.ReactElement | null {
  if (findings.length === 0) return null;
  return (
    <div style={{ fontSize: 11, marginTop: 2 }}>
      {findings.map((f, i) => (
        <div
          key={`${f.code}-${String(i)}`}
          data-finding-severity={f.severity}
          style={{ color: f.severity === "error" ? ME.dangerFg : ME.warnFg }}
        >
          {f.code}: {f.message}
        </div>
      ))}
    </div>
  );
}

// ===========================================================================
// The section

// FILENAME: app/extensions/ModelEditor/components/sections/strategy/TablesGrid.tsx
// PURPOSE: The tables-and-columns grid, as a tree of tables disclosing their
//          columns.
// CONTEXT: Implements properties (1), (16), (17) and (19). `kind` is not
//          decoration: it overrides the backend's own table classification and
//          decides which table is the calendar, so the cell says WHOSE answer
//          it is showing and the options that would be a Save-blocking error
//          are disabled with the reason on them. See ../StrategySection.tsx.

import React, { useRef, useState } from "react";
import type { ModelOverview, ModelTableInfo } from "@api";

import {
  styles,
} from "../../editorShared";
import {
  Chevron,
} from "../../treeKit";
import {
  ME,
  TABULAR,
} from "../../theme";
import { CollapseAllButton, pathCovers, useScrollSelectedIntoView } from "./tree";
import type { TreeDisclosure } from "./tree";

import { buildFolderTree, splitFolderPath, FOLDER_SEP } from "../../../lib/measureFolders";
import type {
  Applied,
  AttrSource,
  ResolvedMeasure,
  StrategyPreviewMeasure,
} from "../../../lib/strategyBackend";
import {
  ROLES,
  TABLE_KINDS,
  compareColumnsByRole,
  effectiveTableKind,
  entryState,
  findingsAtPath,
  inferenceTakePatch,
  stateIsHumanDecision,
  tableDivergences,
  tableEntry,
  tableHasValues,
  tableKindOrigin,
  tableKindIsInert,
  tableKindTopologyRefusal,
  tablePath,
  withColumn,
  withTable,
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
  DRAFT_STATUS,
  FISCAL_YEAR_START_HINT,
  MATERIALITY_HINT,
  MEASURE_COLUMN_GROUPS,
  MEASURE_GROUP_COLUMNS,
  MEASURE_HEADERS,
  MONTH_DAY_MAX,
  NEVER_SLICE_TITLE,
  NO_DRAFT_STATUS,
  NOT_YET_CONSULTED,
  NOT_YET_CONSULTED_MEASURE_FIELDS,
  PREVIEW_DEBOUNCE_MS,
  RESUMED_STATUS,
  RULE_INVITATION,
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
  DivergenceNote,
  KindOriginBadge,
  ReviewedCell,
  RowFindings,
  STICKY_CONFIRM,
  cellStyle,
  rowTone,
  selectOf,
  smallInput,
  stickyConfirmCell,
  stickyHeaderStyle,
} from "./cells";

// ===========================================================================

export type ModelColumn = ModelTableInfo["columns"][number];

/**
 * Order a table's columns by what they are FOR, then by name.
 *
 * `BI.dim_customer` renders eleven columns, and after inference ten of them are
 * `ignore`; model order gives the one column that carries a decision the same
 * eleventh of the screen as the ten that carry none.
 */
export function orderedColumns(
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

export function TablesGrid({
  doc,
  overview,
  findings,
  inferred,
  selectedPath,
  disabled,
  tables,
  onClearSelection,
  onEdit,
}: {
  doc: StrategyDoc;
  overview: ModelOverview;
  findings: Finding[];
  /** Today's inference draft, for the live divergence check. */
  inferred: StrategyDoc | null;
  selectedPath: string | null;
  disabled: boolean;
  /** Owned by the section so switching views does not re-open every table. */
  tables: TreeDisclosure;
  /** Drop the finding highlight — see MeasuresGrid. */
  onClearSelection: () => void;
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

  const cardRef = useRef<HTMLDivElement>(null);
  useScrollSelectedIntoView(cardRef, selectedPath);

  // ---- the table tree ----------------------------------------------------
  //
  // Tables start OPEN, and the button beside the title shuts them all at once.
  // The other way round — collapsed by default — would make the view smaller
  // by making the column roles, the one decision this grid exists to collect,
  // invisible on arrival. "Make the list smaller" is a gesture the user asks
  // for, not a state they should have to undo.
  const tableKeys = overview.tables.map((t) => t.name);
  // A finding on a COLUMN has a path under its table's, so a prefix test is
  // what reopens the right table — `tables['Sales'].columns['Note']` must open
  // Sales, not look for a table called that.
  const tableRevealed = (name: string): boolean =>
    selectedPath !== null && pathCovers(tablePath(name), selectedPath);
  const tableIsOpen = (name: string): boolean => tableRevealed(name) || !tables.isClosed(name);
  /** See MeasuresGrid's toggleFolder: acting on the tree dismisses the
   *  highlight, or the chevron is inert for as long as a finding inside the
   *  table is selected. */
  const toggleTable = (name: string): void => {
    if (tableRevealed(name)) {
      onClearSelection();
      tables.setClosed(name, true);
      return;
    }
    tables.toggle(name);
  };

  return (
    <section>
      <div style={styles.sectionHeader}>
        <span style={{ ...styles.sectionTitle, fontSize: 13 }}>Tables and columns</span>
        <div style={{ flex: 1 }} />
        {overview.tables.length > 0 && (
          <CollapseAllButton
            allClosed={tables.allClosed(tableKeys)}
            onSetAll={(closed) => tables.setAll(tableKeys, closed)}
            what="tables"
          />
        )}
      </div>
      <div ref={cardRef} style={{ ...styles.card, padding: 0, overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              {["table / column", "kind / role", "label column / priority", "reviewed"].map((h) => (
                <th
                  key={h}
                  style={h === "reviewed" ? stickyHeaderStyle : styles.th}
                  data-sticky={h === "reviewed" ? "reviewed" : undefined}
                >
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
              // WHOSE ANSWER IS IN FORCE. An authored kind stands in for the
              // backend's own classification wholesale; a kind the drafting op
              // wrote is stamped `inferred` and is DISREGARDED — re-derived
              // from today's relationship graph — so showing the two the same
              // way tells a person the engine is using a value it is not.
              const detectedKind = proposed?.kind;
              const kindOrigin = tableKindOrigin(entry, detectedKind);
              const shownKind = effectiveTableKind(entry, detectedKind);
              const roleOf = (name: string): Role | undefined => entry.columns?.[name]?.role;
              const ordered = orderedColumns(t.columns, roleOf);
              // An UNSET column is not an ignored one: nobody has said it is
              // uninteresting, so hiding it would hide the whole grid of a model
              // whose draft failed to build.
              const ignored = ordered.filter((c) => roleOf(c.name) === "ignore");
              const shown = ordered.filter((c) => roleOf(c.name) !== "ignore");
              const open = showIgnored.has(t.name);
              const openTable = tableIsOpen(t.name);
              // Columns this document has actually said something about — the
              // evidence behind the table row's own state, and the number the
              // summary reports so a collapsed row explains its own tone.
              const decidedColumns = t.columns.filter(
                (c) => entry.columns?.[c.name] !== undefined,
              ).length;
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
                    {/* A column row has nothing to confirm — the confirmation
                        is the TABLE's — but the cell still has to be pinned and
                        opaque, or the scrolled columns show through the gap the
                        rows above and below are covering. */}
                    <td style={{ ...cellStyle, ...STICKY_CONFIRM, background: ME.surface }} />
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
                      outline: selectedPath === path ? `2px solid ${ME.accent}` : "none",
                    }}
                  >
                    <td style={cellStyle}>
                      {/* The chevron lives INSIDE the name cell rather than in
                          a column of its own: the header is four literals and
                          the ignored-columns summary spans four, so a fifth
                          column would have to be added in three places that no
                          test compares against each other. */}
                      <button
                        type="button"
                        data-testid={`table-disclosure-${t.name}`}
                        aria-expanded={openTable}
                        onClick={() => toggleTable(t.name)}
                        title={openTable ? `Hide ${t.name}'s columns` : `Show ${t.name}'s columns`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          background: "none",
                          border: "none",
                          padding: 0,
                          font: "inherit",
                          color: "inherit",
                          cursor: "pointer",
                        }}
                      >
                        <Chevron open={openTable} />
                        <strong>{t.name}</strong>
                      </button>{" "}
                      {/* WHAT THE CHEVRON IS HIDING, said on the row that hides
                          it. A table's own four-valued state can be produced
                          entirely by its column map (`tableHasValues` counts
                          it), so a shut table could show an authored tone with
                          every cell on the row blank and nothing to explain it.
                          The second number is that evidence. */}
                      <span style={{ ...styles.hint, ...TABULAR }} data-testid={`table-columns-${t.name}`}>
                        {t.columns.length} column{t.columns.length === 1 ? "" : "s"}
                        {decidedColumns > 0 ? ` · ${decidedColumns} set` : ""}
                      </span>{" "}
                      <RowFindings findings={findingsAtPath(findings, path)} />
                    </td>
                    <td style={cellStyle} data-testid={`table-kind-${t.name}`} data-kind-origin={kindOrigin}>
                      {selectOf<TableKind>(
                        entry.kind ?? "",
                        TABLE_KINDS,
                        (v) => onEdit(withTable(doc, t.name, { kind: v === "" ? undefined : v })),
                        disabled,
                        112,
                        // The DETECTED kind in the empty option, greyed, exactly
                        // as an inherited direction is. A blank here reads as
                        // "nobody has decided", which for `kind` has stopped
                        // being true: the backend classifies every table anyway,
                        // and the blank was hiding whose answer is in force.
                        detectedKind === undefined ? null : `${detectedKind} — detected`,
                        // Two reasons an option cannot be chosen, in the order a
                        // person meets them. The topology refusal first:
                        // `calendar` on a table nothing looks up is a
                        // Save-blocking ERROR, so making the state hard to reach
                        // beats explaining it afterwards. Then the inert kinds,
                        // which the backend ACCEPTS and ignores — a control that
                        // takes a value nothing will read is the defect this
                        // feature has now corrected three times.
                        (k) =>
                          tableKindTopologyRefusal(overview, t.name, k) ?? tableKindIsInert(k),
                      )}{" "}
                      <KindOriginBadge provenance={kindOrigin} table={t.name} kind={shownKind} />{" "}
                      <RowFindings findings={findingsAtPath(findings, `${path}.kind`)} />
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
                    <td style={stickyConfirmCell(state)} data-sticky="reviewed">
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
                  {openTable && shown.map(columnRow)}
                  {openTable && ignored.length > 0 && (
                    <tr data-testid={`ignored-summary-${t.name}`}>
                      <td style={{ ...cellStyle, paddingLeft: 28 }} colSpan={3}>
                        {/* A DISCLOSURE, not a filter: the summary is visible
                            whenever its table is open, so a count that changes
                            is legible, and the columns behind it stay fully
                            editable. It is the INNER of two disclosures now —
                            shutting the table takes this row with it, which is
                            right: the summary is a fact about columns, and a
                            shut table is not showing columns. */}
                        <button
                          style={{ ...styles.smallBtn, display: "inline-flex", alignItems: "center", gap: 4 }}
                          aria-expanded={open}
                          title="Columns marked 'ignore' — still editable, just not in the way of the ones that carry a decision"
                          onClick={() => toggleIgnored(t.name)}
                        >
                          <Chevron open={open} />
                          {open ? "hide " : "show "}
                          {ignored.length} ignored column{ignored.length === 1 ? "" : "s"}
                        </button>
                      </td>
                      {/* Pinned and opaque for the reason the column rows are
                          (property 17): this spanned four columns and left a
                          hole in the pinned column that the scrolled cells
                          showed straight through. */}
                      <td style={{ ...cellStyle, ...STICKY_CONFIRM, background: ME.surface }} />
                    </tr>
                  )}
                  {openTable && open && ignored.map(columnRow)}
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

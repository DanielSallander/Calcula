// FILENAME: app/extensions/ModelEditor/components/sections/strategy/MeasuresGrid.tsx
// PURPOSE: The measures grid — eleven columns, a folder tree, a row filter and
//          the aggregation editor.
// CONTEXT: Implements properties (1), (6), (7), (12), (17) and (19). Its three
//          hiding layers — the row filter, the column groups and folder
//          collapse — are three of the four ways a Strategy row can be absent
//          from the DOM, which is why a selection defeats all of them. No
//          `AggregationSpec` literal is constructed here: every write goes
//          through `withAggregationDefault` / `withAggregationException`,
//          because a shallow merge once destroyed a whole `byDimension` map
//          that the cell was never showing. See ../StrategySection.tsx.

import React, { useRef, useState } from "react";
import type { ModelOverview, ModelTableInfo } from "@api";

import { Badge, Field, Modal, styles } from "../../editorShared";
import { Chevron, FolderIcon, TREE_INDENT } from "../../treeKit";
import { FONT, ME, SPACE, TABULAR } from "../../theme";
import {
  CollapseAllButton,
  MeasureFolderRow,
  measureNamePad,
  measureTreeRows,
  revealedFolders,
  useScrollSelectedIntoView,
} from "./tree";
import type { MeasureBodyRow, TreeDisclosure } from "./tree";

import {
  buildFolderTree,
} from "../../../lib/measureFolders";
import type {
  Applied,
  AttrSource,
  ResolvedMeasure,
  StrategyPreviewMeasure,
} from "../../../lib/strategyBackend";
import {
  ADDITIVITIES,
  CADENCES,
  DIRECTIONS,
  UNITS,
  aggregationDimensionOptions,
  bandDirectionIsIncomplete,
  entryState,
  findingsAtPath,
  formatAggregationSpec,
  formatMaterialitySpec,
  formatTargetSpec,
  inferenceTakePatch,
  measureDivergences,
  measureEntry,
  measureHasValues,
  measurePath,
  parseMaterialitySpec,
  parseTargetSpec,
  stateIsHumanDecision,
  withAggregationDefault,
  withAggregationException,
  withMeasure,
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
  MATERIALITY_HINT,
  MEASURE_COLUMN_GROUPS,
  MEASURE_HEADERS,
  NEVER_SLICE_TITLE,
  NOT_YET_CONSULTED,
  NOT_YET_CONSULTED_MEASURE_FIELDS,
  TARGET_HINT,
} from "./constants";
import type { MeasureColumnGroup, MeasureRowFilter } from "./constants";
import {
  inheritedFor,
  overridingRule,
} from "./inheritance";
import {
  BandIncomplete,
  BandTargetCell,
  ColumnRefList,
  DivergenceNote,
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

export function MeasuresGrid({
  doc,
  overview,
  findings,
  preview,
  inferred,
  selectedPath,
  columnRefs,
  disabled,
  folders,
  onClearSelection,
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
  /** Owned by the section so switching views does not re-open every folder. */
  folders: TreeDisclosure;
  /** Drop the finding highlight. Called when the user works the tree by hand,
   *  so a folder held open by a selection becomes closable again. */
  onClearSelection: () => void;
  /** `note` is shown in the status line when an edit does something besides
   *  what was asked — see the section's `edit`. */
  onEdit: (doc: StrategyDoc, note?: string | null) => void;
  onConfirmAll: () => void;
}): React.ReactElement {
  /** The measure whose aggregation editor is open, or null. */
  const [aggregating, setAggregating] = useState<string | null>(null);
  const [columnGroup, setColumnGroup] = useState<MeasureColumnGroup>("meaning");
  const [rowFilter, setRowFilter] = useState<MeasureRowFilter>("needsReview");
  const cardRef = useRef<HTMLDivElement>(null);
  useScrollSelectedIntoView(cardRef, selectedPath);

  // The rows this filter would show. Computed before the empty-state check so
  // "12 of 300" can be honest about both numbers.
  const unconfirmed = overview.measures.filter((m) => {
    const e = measureEntry(doc, m.name);
    return !stateIsHumanDecision(entryState(e, measureHasValues(e)));
  });
  const shownMeasures = rowFilter === "all" ? overview.measures : unconfirmed;

  // ---- the display-folder tree -------------------------------------------
  //
  // The folders are the ones authored in the MEASURES tab (`measure.group`, a
  // backslash path) — this grid reads that axis, it does not invent a second
  // one. `group` is model metadata, not part of the frozen strategy attribute
  // surface (§13.8), so grouping by it adds no authorable field here.
  //
  // A model with no display folders at all produces no folder rows and this
  // grid renders exactly as it did before — a flat list in model order. That
  // is deliberate: a tree over a model that has no tree is one more row of
  // chrome per measure and nothing gained.
  const { roots, ungrouped } = buildFolderTree(overview.measures, []);
  const hasFolders = roots.length > 0;
  // A SELECTION DEFEATS THE FILTER, for exactly one row. The default filter
  // keeps only unconfirmed rows, so a finding on a CONFIRMED measure — a stale
  // target, a direction the validator disagrees with — pointed at a row the
  // grid was not rendering, and clicking it did nothing. Collapse is only one
  // of the three ways a row can be missing; property (19) is about all of them.
  const shownNames = new Set(shownMeasures.map((m) => m.name));
  if (selectedPath !== null) {
    const picked = overview.measures.find((m) => measurePath(m.name) === selectedPath);
    if (picked) shownNames.add(picked.name);
  }
  // Which folders must open regardless of what the user shut: the ones holding
  // the row a finding named. Computed as a value rather than pushed into state
  // — a folder forced open by a selection closes again on its own when the
  // selection moves, and nothing has to remember to undo it.
  const revealed = revealedFolders(overview.measures, selectedPath);
  const folderIsOpen = (path: string): boolean => revealed.has(path) || !folders.isClosed(path);
  // ACTING ON THE TREE DISMISSES THE HIGHLIGHT. Openness is `revealed OR not
  // closed`, so while a selection is forcing a folder open the chevron had no
  // visible effect at all — it wrote to the closed set and the OR overrode it,
  // twice, in both directions. A disclosure that does nothing is worse than an
  // absent one. Clearing the selection first makes the click mean what it looks
  // like it means, and the highlight is a transient "look here" marker anyway:
  // the moment you start opening and shutting things yourself, it has done its
  // job.
  const toggleFolder = (path: string): void => {
    if (revealed.has(path)) {
      // The row is open BECAUSE of the selection, so the click means "shut it".
      // `toggle` would answer a different question — it flips membership of the
      // CLOSED set, which for a folder the user had already shut means REMOVING
      // it, so the folder stays open once the reveal goes away and the click
      // reads as having done nothing.
      onClearSelection();
      folders.setClosed(path, true);
      return;
    }
    folders.toggle(path);
  };

  // The body, in render order. Folders first, then the measures that belong to
  // no folder — matching the Measures tab, and matching Power BI, where a
  // display folder groups a subset and the rest stay at the top level. Without
  // any folders at all this is just the filtered list, in model order, which is
  // exactly what this grid rendered before.
  const treeRows = hasFolders ? measureTreeRows(roots, shownNames, folderIsOpen) : [];
  const measureBodyRows: MeasureBodyRow[] = hasFolders
    ? [
        ...treeRows,
        ...ungrouped
          .filter((m) => shownNames.has(m.name))
          .map((m) => ({ kind: "measure" as const, measure: m, depth: 0 })),
      ]
    : overview.measures
        .filter((m) => shownNames.has(m.name))
        .map((m) => ({ kind: "measure" as const, measure: m, depth: 0 }));

  // Collapse-all acts on the folders that are ON SCREEN, not on every folder
  // the model has. With a filter active some folders are not rendered at all,
  // and counting those made `allClosed` false while every visible folder was
  // shut — so the button offered to "Collapse all folders" a second time and
  // appeared to do nothing.
  const visibleFolderKeys = treeRows
    .filter((r): r is Extract<MeasureBodyRow, { kind: "folder" }> => r.kind === "folder")
    .map((r) => r.node.path);

  // Entries naming a measure the model no longer has. They come from the
  // preview because the grid iterates the MODEL's measures — which is exactly
  // why an orphan was invisible until now, in a document where it is the one
  // thing that needs doing.
  const orphans = [...preview.values()].filter((p) => !p.inModel && p.hasEntry);

  /**
   * One measure's row.
   *
   * Hoisted out of the JSX because there are now two callers — the flat list
   * a model with no display folders gets, and the folder tree. Two copies of
   * a 240-line row would drift on the first change to a cell, and the drift
   * would show up as one column behaving differently in one of the two
   * shapes, which is exactly the kind of defect nobody reproduces.
   */
  const renderMeasureRow = (
    m: ModelOverview["measures"][number],
    depth: number,
  ): React.ReactElement => {
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
                outline: selectedPath === path ? `2px solid ${ME.accent}` : "none",
              }}
            >
              {/* Indented only when there is a tree to indent under. A model
                  with no display folders keeps the cell's own padding, so its
                  grid is pixel-for-pixel what it was before folders existed. */}
              <td style={depth === 0 ? cellStyle : { ...cellStyle, paddingLeft: measureNamePad(depth) }}>
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
              <td style={stickyConfirmCell(state)} data-sticky="reviewed">
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
  };

  return (
    <section>
      <div style={{ ...styles.sectionHeader, flexWrap: "wrap", gap: SPACE.sm }}>
        <label style={{ display: "flex", alignItems: "center", gap: SPACE.xs, fontSize: FONT.sm }}>
          Show
          <select
            style={{ ...styles.input, fontSize: FONT.sm }}
            data-testid="measure-row-filter"
            value={rowFilter}
            onChange={(e) => setRowFilter(e.target.value as MeasureRowFilter)}
          >
            <option value="needsReview">Needs review</option>
            <option value="all">All measures</option>
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: SPACE.xs, fontSize: FONT.sm }}>
          Columns
          <select
            style={{ ...styles.input, fontSize: FONT.sm }}
            data-testid="measure-column-group"
            value={columnGroup}
            onChange={(e) => setColumnGroup(e.target.value as MeasureColumnGroup)}
          >
            {MEASURE_COLUMN_GROUPS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <span style={{ ...styles.hint, ...TABULAR }} data-testid="measure-row-count">
          {unconfirmed.length} of {overview.measures.length} unconfirmed
        </span>
        <div style={{ flex: 1 }} />
        {/* Only when there is something to collapse. A control that does
            nothing is worse than an absent one: it invites a click and answers
            with no change, which reads as a broken button. */}
        {hasFolders && (
          <CollapseAllButton
            allClosed={folders.allClosed(visibleFolderKeys)}
            onSetAll={(closed) => folders.setAll(visibleFolderKeys, closed)}
            what="folders"
          />
        )}
        <button
          style={styles.smallBtn}
          disabled={disabled}
          title="Confirm every measure and table that is ready — rows carrying a finding are left for you to read, and rows that state nothing have nothing to agree to."
          onClick={onConfirmAll}
        >
          Confirm all
        </button>
      </div>
      <div ref={cardRef} style={{ ...styles.card, padding: 0, overflowX: "auto" }}>
        <table
          style={{ borderCollapse: "collapse", width: "100%" }}
          data-cols={columnGroup}
          data-testid="measures-grid"
        >
          <thead>
            <tr>
              {MEASURE_HEADERS.map((h) => (
                <th
                  key={h}
                  style={h === "reviewed" ? stickyHeaderStyle : styles.th}
                  data-sticky={h === "reviewed" ? "reviewed" : undefined}
                  title={
                    h === "never slice by"
                      ? NEVER_SLICE_TITLE
                      : NOT_YET_CONSULTED_MEASURE_FIELDS.includes(h)
                        ? NOT_YET_CONSULTED
                        : undefined
                  }
                >
                  {h}
                  {/* SAID ONCE, IN THE HEADER, NOT ONCE PER ROW. `unit` and
                      `cadence` are stored, validated and resolved, and READ BY
                      NOTHING — `unit` waits on narration that formats a value
                      ("rose by 12" vs "12%" vs "12,000 SEK" are different
                      sentences) and `cadence` on period bucketing and
                      seasonality lag selection. Both have a designed reader
                      coming, which is why they were kept where
                      `reportingCurrency` was deleted; until one arrives they
                      must not present as ordinary settable attributes. A note
                      per cell would be forty copies of one sentence. */}
                  {NOT_YET_CONSULTED_MEASURE_FIELDS.includes(h) && (
                    <span
                      data-testid={`measure-not-consulted-${h}`}
                      data-inert-field={h}
                      style={{ color: ME.warnFg, fontWeight: 400, marginLeft: 4 }}
                    >
                      *
                    </span>
                  )}
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
            {overview.measures.length > 0 && shownMeasures.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={MEASURE_HEADERS.length}>
                  {/* Says WHICH filter is hiding them and offers the way out —
                      an empty grid with 300 measures in the model behind it is
                      otherwise indistinguishable from a broken one. */}
                  <span style={styles.muted}>
                    Every measure is confirmed.{" "}
                    <button
                      type="button"
                      data-testid="measure-show-all"
                      onClick={() => setRowFilter("all")}
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        font: "inherit",
                        color: ME.accent,
                        cursor: "pointer",
                        textDecoration: "underline",
                      }}
                    >
                      Show all {overview.measures.length}
                    </button>
                  </span>
                </td>
              </tr>
            )}
            {measureBodyRows.map((r) =>
              r.kind === "folder" ? (
                <MeasureFolderRow
                  key={`folder-${r.node.path}`}
                  node={r.node}
                  depth={r.depth}
                  open={r.open}
                  count={r.count}
                  onToggle={() => toggleFolder(r.node.path)}
                />
              ) : (
                renderMeasureRow(r.measure, r.depth)
              ),
            )}
            {/* Orphans last, and NOT as editable rows: an entry whose measure
                the model no longer has is the thing to clean up, and offering
                dropdowns over it invites someone to keep tending a row that can
                never resolve to anything. */}
            {orphans.map((p) => (
              <tr
                key={`orphan-${p.measure}`}
                data-strategy-path={measurePath(p.measure)}
                data-strategy-orphan="true"
                style={{ color: ME.warnFg, background: ME.warnBg }}
              >
                <td style={cellStyle}>
                  <strong>{p.measure}</strong>{" "}
                  <Badge tone="warn">not in the model</Badge>{" "}
                  <RowFindings findings={findingsAtPath(findings, measurePath(p.measure))} />
                </td>
                <td style={styles.td} colSpan={MEASURE_HEADERS.length - 2}>
                  The strategy has an entry for &lsquo;{p.measure}&rsquo;, but this model has no
                  such measure — it was renamed or deleted. Nothing here can apply to anything;
                  remove the entry, or bring the measure back under its old name.
                </td>
                {/* Pinned and opaque, for the reason every other row's is
                    (property 17): this row spanned through the pinned column
                    and left a hole in it that the scrolled cells showed
                    straight through. There is nothing to confirm on an orphan —
                    the cell is empty — but the column still has to be
                    continuous. */}
                <td style={{ ...cellStyle, ...STICKY_CONFIRM, background: ME.warnBg }} />
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
export function AggregationCell({
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
export function AggregationEditor({
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
            <span style={{ ...styles.input, flex: 2, minWidth: 0, background: ME.sunken }}>
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

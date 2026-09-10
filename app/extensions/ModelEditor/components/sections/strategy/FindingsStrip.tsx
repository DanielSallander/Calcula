// FILENAME: app/extensions/ModelEditor/components/sections/strategy/FindingsStrip.tsx
// PURPOSE: The findings strip — every finding the document carries, grouped by
//          severity.
// CONTEXT: The one surface that survives every view, every filter and every
//          collapse, which is why property (19) is about it: selecting a row
//          here must SWITCH to its view, open whatever is hiding it, defeat the
//          filter for it and scroll to it. Anything less makes this a list of
//          dead links. See ../StrategySection.tsx.

import React from "react";
import type { ModelOverview, ModelTableInfo } from "@api";

import {
  styles,
} from "../../editorShared";
import { Chevron, FolderIcon, TREE_INDENT } from "../../treeKit";
import {
  ME,
} from "../../theme";

import { buildFolderTree, splitFolderPath, FOLDER_SEP } from "../../../lib/measureFolders";
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
  ROLES,
  SUPPRESSIBLE_FACT_KINDS,
  TABLE_KINDS,
  UNITS,
  aggregationDimensionOptions,
  bandDirectionIsIncomplete,
  bandExistsAnywhere,
  bandHighInclusive,
  bandLowInclusive,
  bandTarget,
  compareColumnsByRole,
  effectiveTableKind,
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
  parseIsoDate,
  parseMaterialitySpec,
  parseSuppressSpec,
  parseTargetSpec,
  rulePath,
  stateIsHumanDecision,
  tableDivergences,
  tableEntry,
  tableHasValues,
  tableKindOrigin,
  tableKindIsInert,
  tableKindTopologyRefusal,
  tablePath,
  withAggregationDefault,
  withAggregationException,
  withColumn,
  withMeasure,
  withModel,
  withRule,
  withTable,
  withoutRule,
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

export function FindingsStrip({
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
              <div style={{ ...styles.label, color: severity === "error" ? ME.dangerFg : ME.warnFg }}>
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
                    background: selectedPath !== null && f.path === selectedPath ? ME.accentSoft : "transparent",
                  }}
                >
                  <button
                    style={{ ...styles.smallBtn, minWidth: 150, textAlign: "left" }}
                    title="Highlight the row this finding names"
                    onClick={() => onSelect(f.path === selectedPath ? null : f.path)}
                  >
                    {f.path === "" ? "(document)" : f.path}
                  </button>
                  <span style={{ fontFamily: "Consolas, monospace", color: ME.text2 }}>{f.code}</span>
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

// FILENAME: app/extensions/ModelEditor/components/sections/strategy/RulesGrid.tsx
// PURPOSE: The rules grid and why `Add rule` might be grey.
// CONTEXT: Implements property (11). The empty state names what a rule DOES in
//          concrete terms and carries the action itself, because a reviewer
//          once read a sentence of theory, missed the button entirely, and
//          concluded rules could not be authored at all — after which nobody
//          exercised the rules path and a 100% path mismatch in its findings
//          went unnoticed. Undiscoverable UI and untested code are the same
//          territory. See ../StrategySection.tsx.

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
  findingsAtPath,
  formatAggregationSpec,
  formatMaterialitySpec,
  formatTargetSpec,
  rulePath,
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
  RULE_INVITATION,
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
  RowFindings,
  cellStyle,
} from "./cells";

// ===========================================================================

export function describeSet(set: AttributeSet): string {
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

export function describeScope(scope: Scope | undefined): string {
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
export function AddRuleBlocked({ reason }: { reason: string }): React.ReactElement {
  return (
    <div
      data-testid="rules-add-blocked"
      style={{ fontSize: 11, color: ME.warnFg, marginTop: 4 }}
    >
      {reason}
    </div>
  );
}

export function RulesGrid({
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
                    <div style={{ fontSize: 12, color: ME.text2, marginBottom: 6 }}>
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
                  style={{ outline: selectedPath === path ? `2px solid ${ME.accent}` : "none" }}
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

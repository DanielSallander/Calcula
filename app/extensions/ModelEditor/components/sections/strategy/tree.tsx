// FILENAME: app/extensions/ModelEditor/components/sections/strategy/tree.tsx
// PURPOSE: The disclosure machinery both Strategy trees share, and the
//          measure folder header row.
// CONTEXT: Implements property (19). Collapse state is a Set of the CLOSED
//          keys, so a folder or table nobody has touched is OPEN and nothing is
//          ever born hidden. The reveal is DERIVED from the selection rather
//          than written into that Set, so a folder held open by a finding shuts
//          again on its own — and acting on the tree by hand dismisses the
//          highlight, or the chevron would be inert while a selection held it
//          open. See ../StrategySection.tsx.

import React, { useEffect, useState } from "react";
import type { ModelOverview, ModelTableInfo } from "@api";

import {
  styles,
} from "../../editorShared";
import { Chevron, FolderIcon, TREE_INDENT } from "../../treeKit";
import {
  ME,
  TABULAR,
} from "../../theme";
import type { FolderNode } from "../../../lib/measureFolders";
import {
  splitFolderPath,
  FOLDER_SEP,
} from "../../../lib/measureFolders";
import type {
  Applied,
  AttrSource,
  ResolvedMeasure,
  StrategyPreviewMeasure,
} from "../../../lib/strategyBackend";
import {
  measurePath,
  tablePath,
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
  MEASURE_HEADERS,
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
  STICKY_CONFIRM,
  cellStyle,
} from "./cells";

// ===========================================================================

/**
 * Collapse state as a Set of the CLOSED keys.
 *
 * The polarity is the whole design. A NEGATIVE set means a key nobody has
 * touched is OPEN — so a table that appears after a refresh, or a folder that
 * appears the moment someone types a display folder in the Measures tab, shows
 * its contents rather than hiding them behind a chevron the user never closed.
 * A positive `expanded` set gets that backwards and would make every new thing
 * arrive invisible. It is also the idiom the rest of this extension already
 * uses (`MeasuresSection`, `CalcGroupsSection`).
 *
 * Deliberately NOT persisted. The only per-connection store in this tab is the
 * unsaved strategy DRAFT, which is sent verbatim to the backend on Save —
 * putting view state in there would make "which folders are shut" part of the
 * document. Nothing else in this extension persists tree state either, so
 * collapse resets when the TAB unmounts, exactly as the row filter and the
 * column group already do.
 *
 * It must NOT reset when the VIEW changes, though, which is why the state is
 * held by the section and handed to the grid rather than owned by the grid.
 * The grids are conditionally rendered, so a grid-owned Set would be thrown
 * away every time someone looked at Rules — and re-shutting fourteen tables
 * after each glance is worse than never having shut them.
 *
 * The KEYS stay with the grid: only it knows what its own tree contains, so
 * `setAll` and `allClosed` take them rather than the hook holding a second
 * copy that could go stale.
 */
export interface TreeDisclosure {
  isClosed: (key: string) => boolean;
  toggle: (key: string) => void;
  /** Set one key's state outright. Needed because `toggle` answers the question
   *  "is this key in the closed set", and while a SELECTION is forcing a row
   *  open that is not the same question as "is this row open on screen" — a
   *  toggle there flips the hidden half and leaves the visible half unchanged. */
  setClosed: (key: string, closed: boolean) => void;
  setAll: (keys: string[], closed: boolean) => void;
  allClosed: (keys: string[]) => boolean;
}

export function useTreeDisclosure(): TreeDisclosure {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const setClosed = (key: string, closed: boolean): void =>
    setCollapsed((prev) => {
      if (prev.has(key) === closed) return prev;
      const next = new Set(prev);
      if (closed) next.add(key);
      else next.delete(key);
      return next;
    });
  return {
    isClosed: (key) => collapsed.has(key),
    toggle: (key) => setClosed(key, !collapsed.has(key)),
    setClosed,
    setAll: (keys, closed) => setCollapsed(closed ? new Set(keys) : new Set()),
    allClosed: (keys) => keys.length > 0 && keys.every((k) => collapsed.has(k)),
  };
}

/** The one-click "shut everything / open everything" control. Label flips, so
 *  it is one button rather than two, and it says what pressing it WILL do. */
export function CollapseAllButton({
  allClosed,
  onSetAll,
  what,
}: {
  allClosed: boolean;
  onSetAll: (closed: boolean) => void;
  /** Plural noun for the thing being opened or shut ("tables", "folders"). */
  what: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      style={styles.smallBtn}
      data-testid={`collapse-all-${what}`}
      // NO `aria-pressed`. The label itself flips, so the accessible name is
      // already the state — and a toggle that announces "Expand all folders,
      // pressed" is telling a listener two contradictory things at once. A
      // control whose name changes is a button, not a switch.
      title={
        allClosed
          ? `Open every ${what.replace(/s$/, "")} again`
          : `Shut every ${what.replace(/s$/, "")} so the list is one row each`
      }
      onClick={() => onSetAll(!allClosed)}
    >
      {allClosed ? `Expand all ${what}` : `Collapse all ${what}`}
    </button>
  );
}

/** The ground a folder header sits on. Named once because the row and its
 *  pinned trailing cell must agree — a sticky cell floats over the columns
 *  sliding beneath it, so a mismatch shows as a moving seam, not as a colour. */
export const FOLDER_ROW_BG = ME.sunken;

/**
 * A display-folder header row.
 *
 * ELEVEN CELLS, THE SAME AS EVERY OTHER ROW — no colSpan.
 *
 * The obvious shape is a spanning name cell plus a pinned trailing one, and it
 * was wrong: a `colspan` is counted in DECLARED columns, but the column groups
 * hide cells with `display: none`, so the folder row asked the table for
 * eleven column slots while the header and the value rows occupied six, five or
 * four. Measured in a real browser, that pushed the folder's pinned cell 24px
 * (Meaning), 44px (Aggregation) and 45px (Slicing) to the RIGHT of the
 * `reviewed` column it was supposed to sit on — aligning only under "All
 * columns", which is the one group nobody works in. Property (17) asks for the
 * pinned column to be continuous down the grid; a cell beside it is not that.
 *
 * With eleven ordinary cells the group rules apply to this row exactly as they
 * do to the rows above and below it, and the arithmetic cannot drift: column 1
 * (the folder name) and column 11 (pinned) are in every group by construction,
 * and the nine in between are empty and hide alongside their neighbours.
 *
 * The chevron is a real <button> with `aria-expanded`, not a clickable <div>.
 * Every other tree in this extension is a div and is therefore unreachable by
 * keyboard; the one disclosure already in THIS file is a button, and matching
 * the neighbour beats matching the extension.
 */
export function MeasureFolderRow({
  node,
  depth,
  open,
  count,
  onToggle,
}: {
  node: FolderNode;
  depth: number;
  open: boolean;
  /** Measures shown UNDER this folder, subfolders included — the number that
   *  matches what opening it reveals. A count of direct children only would
   *  say "0" on a parent holding twelve, which is the one number a collapsed
   *  row must not get wrong. */
  count: number;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <tr data-tree-row="folder" data-folder-path={node.path} style={{ background: FOLDER_ROW_BG }}>
      <td style={{ ...cellStyle, paddingLeft: 6 + depth * TREE_INDENT }}>
        <button
          type="button"
          data-testid={`measure-folder-${node.path}`}
          aria-expanded={open}
          onClick={onToggle}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            background: "none",
            border: "none",
            padding: 0,
            font: "inherit",
            fontWeight: 600,
            color: ME.text2,
            cursor: "pointer",
          }}
        >
          <Chevron open={open} />
          <FolderIcon />
          {node.name}
          <span style={{ ...styles.hint, ...TABULAR }}>{count}</span>
        </button>
      </td>
      {/* Columns 2..10, empty. They exist so the group rules have the same
          number of cells to count on this row as on the rows around it — that
          is the whole reason the pinned cell below lands ON the `reviewed`
          column instead of beside it. */}
      {MEASURE_HEADERS.slice(1, -1).map((h) => (
        <td key={h} style={cellStyle} />
      ))}
      <td style={{ ...cellStyle, ...STICKY_CONFIRM, background: FOLDER_ROW_BG }} />
    </tr>
  );
}

/** Where a measure's name sits when it is nested `depth` folders deep. The
 *  extra 18px lines the name up past its folder's chevron+icon rather than
 *  flush under them, which is the difference between a tree and a list with
 *  headings in it. */
export function measureNamePad(depth: number): number {
  return 6 + depth * TREE_INDENT + 18;
}

/** One row of the measures body: a folder header, or a measure. */
export type MeasureBodyRow =
  | { kind: "folder"; node: FolderNode; depth: number; open: boolean; count: number }
  | { kind: "measure"; measure: ModelOverview["measures"][number]; depth: number };

/**
 * Flatten the folder tree into the row order the tbody renders.
 *
 * A <tr> cannot nest, so the tree becomes a flat sequence carrying its own
 * depth. Three rules do the work:
 *
 *  - a folder whose subtree shows NOTHING is not rendered at all, so the row
 *    filter cannot leave a trail of empty headers behind it;
 *  - a folder's count is its whole SUBTREE, not its direct children — a parent
 *    holding twelve measures in subfolders and none of its own would otherwise
 *    read "0" while collapsed, which is the one number a shut row must not get
 *    wrong;
 *  - a closed folder is not recursed into, which is what makes collapsing a
 *    parent take its descendants with it.
 */
export function measureTreeRows(
  roots: FolderNode[],
  shown: Set<string>,
  isOpen: (path: string) => boolean,
  depth = 0,
): MeasureBodyRow[] {
  const out: MeasureBodyRow[] = [];
  for (const node of roots) {
    const count = shownInSubtree(node, shown);
    if (count === 0) continue;
    const open = isOpen(node.path);
    out.push({ kind: "folder", node, depth, open, count });
    if (!open) continue;
    for (const m of node.measures) {
      if (shown.has(m.name)) out.push({ kind: "measure", measure: m, depth: depth + 1 });
    }
    out.push(...measureTreeRows(node.children, shown, isOpen, depth + 1));
  }
  return out;
}

/** How many of a folder's measures — its own and its descendants' — the current
 *  filter is showing. */
export function shownInSubtree(node: FolderNode, shown: Set<string>): number {
  let n = node.measures.filter((m) => shown.has(m.name)).length;
  for (const child of node.children) n += shownInSubtree(child, shown);
  return n;
}

/**
 * Does `rowPath` name the row that `path` belongs to?
 *
 * The SAME rule `findingsAtPath` uses to decide which badge goes on which row,
 * because the two must agree: a row that displays a finding must also be the
 * row that finding reveals and scrolls to.
 */
export function pathCovers(rowPath: string, path: string): boolean {
  return path === rowPath || path.startsWith(`${rowPath}.`) || path.startsWith(`${rowPath}[`);
}

/**
 * The ROW a selected path belongs to.
 *
 * THE VALIDATOR ANCHORS BELOW THE ROW. Most measure findings come back at
 * `measures['Profit'].target`, `.direction`, `.aggregation`, `.neverSliceBy[0]`
 * — not at `measures['Profit']` — and column findings at
 * `tables['Sales'].columns['Note']` and deeper. Every consumer of a selection
 * wants the row: the outline, the scroll, and the reveal that opens whatever is
 * hiding it.
 *
 * So the prefix rule lives HERE, once, and everything downstream compares row
 * paths for equality as it always did. The first version of this feature put
 * the rule in the tables grid only and used equality in the measures grid,
 * which made the reveal dead for the commonest kind of finding there is —
 * exactly the "list of dead links" property (19) exists to forbid, shipped
 * inside the change that introduced the property.
 */
export function rowPathFor(overview: ModelOverview, path: string | null): string | null {
  if (!path) return null;
  for (const t of overview.tables) {
    const tp = tablePath(t.name);
    if (!pathCovers(tp, path)) continue;
    // A column row is a row in its own right, so prefer it over its table.
    for (const c of t.columns) {
      const cp = `${tp}.columns['${c.name}']`;
      if (pathCovers(cp, path)) return cp;
    }
    return tp;
  }
  for (const m of overview.measures) {
    const mp = measurePath(m.name);
    if (pathCovers(mp, path)) return mp;
  }
  // Rules and the document-level path have nothing to normalise to.
  return path;
}

/**
 * The folder paths that must be open for `selectedRow` to be on screen — the
 * folder holding that measure, and every ancestor of it.
 *
 * Without this, clicking a finding for a measure inside a shut folder outlines
 * a row that is not in the DOM: nothing happens at all, and the findings strip
 * — which is the one surface that survives every view and every filter —
 * becomes a list of dead links.
 */
export function revealedFolders(
  measures: ModelOverview["measures"],
  selectedRow: string | null,
): Set<string> {
  const out = new Set<string>();
  if (!selectedRow) return out;
  const hit = measures.find((m) => measurePath(m.name) === selectedRow);
  if (!hit?.group) return out;
  const segs = splitFolderPath(hit.group);
  for (let i = 0; i < segs.length; i++) out.add(segs.slice(0, i + 1).join(FOLDER_SEP));
  return out;
}

/**
 * Scroll the row a finding names into view.
 *
 * Revealing a collapsed row is not enough on its own: opening a folder can put
 * a hundred rows above the one that was clicked, so the outline lands somewhere
 * the user is not looking and the control reads as dead — which is what it did
 * before collapse existed too, only then the row was at least in the DOM.
 *
 * Matches by READING the attribute rather than by putting `selectedPath` into a
 * selector: a path is `measures['Margin %']`, quotes and all, and `CSS.escape`
 * is undefined in jsdom — a selector-based version passes in a browser and
 * throws in the suite.
 */
export function useScrollSelectedIntoView(
  root: React.RefObject<HTMLElement | null>,
  selectedPath: string | null,
): void {
  useEffect(() => {
    if (!selectedPath) return;
    for (const candidate of root.current?.querySelectorAll("[data-strategy-path]") ?? []) {
      if (candidate.getAttribute("data-strategy-path") !== selectedPath) continue;
      // jsdom does not implement scrollIntoView at all, so this is a typeof
      // check rather than an optional call — `?.()` still throws on a
      // property that exists and is not callable.
      const node = candidate as HTMLElement;
      if (typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
      return;
    }
  }, [root, selectedPath]);
}

//! FILENAME: app/src/api/layout/primitives/containers.tsx
// PURPOSE: Orientation-aware container primitives: Group, Stack, ControlRow,
//          ControlGrid, Grow, ActionRow, StatusText.
// CONTEXT: Composition building blocks that read SurfaceLayoutContext, so one
//          JSX tree renders as a horizontal ribbon group or a vertical sidebar
//          block. See @api/layout/context.ts for the geometry contract and
//          ../tokens.ts for THE FILL RULE these containers lay out against:
//          a cluster's content box is 61px, filled either by one tall row or
//          by two 28px rows with a 5px gap (28 + 5 + 28 = 61). ControlGrid's
//          defaults ARE that second form, which is why its row gap is ROW_GAP
//          and not the in-row gap: with 4px between rows the pair is 60px and
//          sits a pixel off-centre in every cluster that uses it.
//
//          Colours come only from LT (../theme).

import React from "react";
import { useSurfaceLayout } from "../context";
import { LT } from "../theme";
import {
  BAND_MAX_CONTENT_HEIGHT,
  FONT_FAMILY,
  GAP_MD,
  GAP_SM,
  GAP_XS,
  GROUP_LABEL_FONT_SIZE,
  HEADER_FONT_SIZE,
  LABEL_FONT_SIZE,
  ROW_GAP,
} from "../tokens";
import { Segmented } from "./Segmented";

// ============================================================================
// Group — sub-grouping inside a section
// ============================================================================

export interface GroupProps {
  label: string;
  children: React.ReactNode;
}

/**
 * A labeled sub-group. Band: a mini column with the caption below it, in the
 * same 11px/500 recipe as a cluster caption. Panel/popover: the ONE header
 * recipe (12px/600, sentence case) above a vertical block — the same header
 * a sidebar section and a side-panel title use, so a pane does not mix three
 * header styles.
 */
export function Group({ label, children }: GroupProps): React.ReactElement {
  const layout = useSurfaceLayout();

  if (layout.container === "band") {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          boxSizing: "border-box",
          minWidth: 0,
        }}
      >
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          {children}
        </div>
        <div
          style={{
            fontSize: GROUP_LABEL_FONT_SIZE,
            fontWeight: 500,
            lineHeight: "13px",
            color: LT.groupLabel,
            textAlign: "center",
            marginTop: 2,
            fontFamily: FONT_FAMILY,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {label}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: GAP_XS }}>
      <div
        style={{
          fontSize: HEADER_FONT_SIZE,
          fontWeight: 600,
          lineHeight: 1.3,
          color: LT.text,
          fontFamily: FONT_FAMILY,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

// ============================================================================
// Stack — cross-axis stack
// ============================================================================

export interface StackProps {
  gap?: number;
  children: React.ReactNode;
}

/**
 * Vertical stack everywhere. In the band it caps at the cluster's content box
 * and column-wraps, so rows pack into side-by-side columns Excel-style instead
 * of overflowing the card.
 */
export function Stack({ gap = GAP_XS, children }: StackProps): React.ReactElement {
  const layout = useSurfaceLayout();
  const band = layout.container === "band";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap,
        ...(band
          ? {
              flexWrap: "wrap" as const,
              maxHeight: layout.maxContentHeight ?? BAND_MAX_CONTENT_HEIGHT,
              alignContent: "flex-start",
              columnGap: GAP_SM * 2,
            }
          : {}),
      }}
    >
      {children}
    </div>
  );
}

// ============================================================================
// ControlRow — a row of small controls
// ============================================================================

export interface ControlRowProps {
  gap?: number;
  /** Cross-axis alignment; "stretch" lets full-height children (e.g. a
   *  CommandButton next to a ControlGrid) fill the band. Default "center". */
  align?: "center" | "stretch";
  children: React.ReactNode;
}

/**
 * A horizontal row of compact controls (buttons, toggles, readouts, scrubbers).
 * Band: single row, never wraps. Panel/popover: toolbar row that wraps.
 */
export function ControlRow({ gap = GAP_SM, align = "center", children }: ControlRowProps): React.ReactElement {
  const layout = useSurfaceLayout();
  const band = layout.container === "band";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: band && align === "stretch" ? "stretch" : "center",
        gap,
        flexWrap: band ? "nowrap" : "wrap",
        minWidth: 0,
        ...(band && align === "stretch" ? { height: "100%" } : {}),
      }}
    >
      {children}
    </div>
  );
}

// ============================================================================
// ControlGrid — compact controls that stack into band rows
// ============================================================================

/**
 * Explicit row break inside a ControlGrid: children before/after it land on
 * separate band rows (curated rows, Excel-style — e.g. font pickers above the
 * format toggles). Renders nothing itself; ignored in the panel, where the
 * grid is a single wrapping row anyway.
 */
export function ControlGridBreak(): null {
  return null;
}

export interface ControlGridProps {
  /** Gap between controls within a row (default GAP_XS, 4). */
  gap?: number;
  /** Gap between band rows, and between wrapped lines in a panel
   *  (default ROW_GAP, 5: two 28px rows then fill the 61px content box). */
  rowGap?: number;
  /** Rows to pack into in the band (default 2). Ignored when the children
   *  contain explicit ControlGridBreak markers. */
  bandRows?: number;
  /** Minimum child count before band splitting kicks in (default 5) —
   *  splitting a tiny group saves no width and just looks ragged. */
  splitAt?: number;
  /**
   * Names the Segmented pill a child belongs to, or undefined for a
   * free-standing control. Rows are chunked FIRST, exactly as without it;
   * then, within each row, consecutive children with the same segment are
   * wrapped in one `<Segmented ariaLabel={segment}>`. Segmenting therefore
   * never moves a control to another row — a run that straddles a row break
   * becomes two pills — and a grid gains pills without re-curating its rows.
   */
  segmentOf?: (child: React.ReactElement) => string | undefined;
  children: React.ReactNode;
}

/** Wrap each run of consecutive same-segment children in a Segmented. */
function segmentRow(
  row: readonly React.ReactNode[],
  segmentOf: ControlGridProps["segmentOf"],
): React.ReactNode[] {
  if (!segmentOf) return [...row];
  const out: React.ReactNode[] = [];
  let run: React.ReactElement[] = [];
  let runSegment: string | undefined;

  const flush = () => {
    if (run.length > 0 && runSegment !== undefined) {
      out.push(
        <Segmented key={`segment:${runSegment}:${String(run[0].key)}`} ariaLabel={runSegment}>
          {run}
        </Segmented>,
      );
    }
    run = [];
    runSegment = undefined;
  };

  for (const node of row) {
    const segment = React.isValidElement(node) ? segmentOf(node) : undefined;
    if (segment === undefined) {
      flush();
      out.push(node);
      continue;
    }
    if (segment !== runSegment) flush();
    runSegment = segment;
    run.push(node as React.ReactElement);
  }
  flush();
  return out;
}

/**
 * A set of compact controls that uses the band's height instead of its width:
 * in the ribbon band the children chunk row-major into up to `bandRows`
 * stacked rows (halving the group's footprint, Excel-style); in the
 * panel/popover they flow as one wrapping toolbar row. Reading order is
 * preserved (left-to-right, then next row). Place ControlGridBreak children
 * to curate exactly where band rows split, and pass `segmentOf` to join
 * related controls into pills.
 */
export function ControlGrid({
  gap = GAP_XS,
  rowGap = ROW_GAP,
  bandRows = 2,
  splitAt = 5,
  segmentOf,
  children,
}: ControlGridProps): React.ReactElement {
  const layout = useSurfaceLayout();
  const all = React.Children.toArray(children);
  const isBreak = (node: React.ReactNode): boolean =>
    React.isValidElement(node) && node.type === ControlGridBreak;
  const items = all.filter((node) => !isBreak(node));

  if (layout.container === "band") {
    let rows: React.ReactNode[][];
    if (all.some(isBreak)) {
      // Curated rows: split exactly at the markers.
      rows = [[]];
      for (const node of all) {
        if (isBreak(node)) {
          if (rows[rows.length - 1].length > 0) rows.push([]);
        } else {
          rows[rows.length - 1].push(node);
        }
      }
      if (rows[rows.length - 1].length === 0) rows.pop();
      if (rows.length === 0) rows = [[]];
    } else {
      const rowCount =
        items.length >= splitAt ? Math.max(1, Math.min(bandRows, items.length)) : 1;
      const perRow = Math.ceil(items.length / rowCount);
      rows = [];
      for (let i = 0; i < items.length; i += perRow) {
        rows.push(items.slice(i, i + perRow));
      }
    }

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: rowGap,
          height: "100%",
          minWidth: 0,
        }}
      >
        {rows.map((row, idx) => (
          <div
            key={idx}
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap,
              flexWrap: "nowrap",
            }}
          >
            {segmentRow(row, segmentOf)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        columnGap: gap,
        rowGap,
        flexWrap: "wrap",
        minWidth: 0,
      }}
    >
      {segmentOf ? segmentRow(items, segmentOf) : children}
    </div>
  );
}

/** Marks a ControlRow child (e.g. a scrubber) as taking the remaining width. */
export function Grow({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ flex: 1, minWidth: 40, display: "flex", alignItems: "center" }}>
      {children}
    </div>
  );
}

// ============================================================================
// ActionRow — command buttons + status text
// ============================================================================

export interface ActionRowProps {
  gap?: number;
  children: React.ReactNode;
}

/**
 * A row of action buttons with optional trailing status text. Same flow as
 * ControlRow; exists as a named archetype so sections read declaratively.
 */
export function ActionRow({ gap = GAP_MD, children }: ActionRowProps): React.ReactElement {
  const layout = useSurfaceLayout();
  const band = layout.container === "band";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap,
        flexWrap: band ? "nowrap" : "wrap",
        minWidth: 0,
      }}
    >
      {children}
    </div>
  );
}

/** Ellipsizing inline status message for ActionRow/ControlRow tails. */
export function StatusText({ children, title }: { children: React.ReactNode; title?: string }): React.ReactElement {
  return (
    <span
      style={{
        fontSize: LABEL_FONT_SIZE,
        color: LT.textSecondary,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        minWidth: 0,
        fontFamily: FONT_FAMILY,
      }}
      title={title}
    >
      {children}
    </span>
  );
}

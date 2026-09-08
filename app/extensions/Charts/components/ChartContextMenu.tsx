//! FILENAME: app/extensions/Charts/components/ChartContextMenu.tsx
// PURPOSE: General context menu for right-clicking a chart object.
// CONTEXT: Shown for any right-click on a chart that is not an axis hit (axes
//          have their own AxisContextMenu). A chart right-click must show
//          object actions only — never the grid's cell context menu.

import React, { useEffect, useRef, useSyncExternalStore } from "react";
import { css } from "@emotion/css";
import type { OverlayProps } from "@api/uiTypes";
import { emitAppEvent, showDialog } from "@api";
import {
  getChartContextMenuContributions,
  onChartContextMenuContributionsChange,
  type ChartContextMenuContribution,
} from "@api/chartContextMenu";

import { getChartById } from "../lib/chartStore";
import { ChartEvents } from "../lib/chartEvents";
import { CHART_DIALOG_ID } from "../manifest";
import { isPivotDataSource } from "../types";

// ============================================================================
// Contributed items (from @api/chartContextMenu)
// ============================================================================

/**
 * A STABLE snapshot of the contributed items.
 *
 * `getChartContextMenuContributions()` sorts into a fresh array on every call.
 * `useSyncExternalStore` compares snapshots with `Object.is`, so handing it that
 * getter directly means "changed" on every single render — React re-renders
 * forever and the menu never paints. This repo has been bitten by exactly that
 * before (see AIChat's `runningJobs` memoisation), so the array is built once
 * per actual change and the same reference is returned until the registry
 * notifies us.
 *
 * The cache is also invalidated on (re)subscribe: while no menu is open nothing
 * is listening, so a contributor that registered in the meantime would otherwise
 * be missing from the next menu.
 */
let cachedContributions: ChartContextMenuContribution[] = [];
let contributionsCacheValid = false;

function subscribeToContributions(onStoreChange: () => void): () => void {
  contributionsCacheValid = false;
  return onChartContextMenuContributionsChange(() => {
    contributionsCacheValid = false;
    onStoreChange();
  });
}

function contributionsSnapshot(): ChartContextMenuContribution[] {
  if (!contributionsCacheValid) {
    cachedContributions = getChartContextMenuContributions();
    contributionsCacheValid = true;
  }
  return cachedContributions;
}

/**
 * Items this chart should show. A contributor's `visible` predicate is foreign
 * code running inside our render, so a throw is treated as "not applicable"
 * rather than being allowed to take the whole menu — and with it Delete Chart —
 * down with it.
 */
function visibleFor(
  items: readonly ChartContextMenuContribution[],
  chartId: string,
): ChartContextMenuContribution[] {
  return items.filter((item) => {
    if (!item.visible) return true;
    try {
      return item.visible(chartId);
    } catch (err) {
      console.warn(`[Charts] Context-menu contribution "${item.id}" threw in visible():`, err);
      return false;
    }
  });
}

// ============================================================================
// Styles (matches AxisContextMenu)
// ============================================================================

const styles = {
  menu: css`
    position: fixed;
    z-index: 10000;
    background: #fff;
    border: 1px solid #ccc;
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
    min-width: 180px;
    padding: 4px 0;
    font-size: 12px;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  `,
  item: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 16px;
    cursor: pointer;
    white-space: nowrap;
    color: #333;

    &:hover {
      background: #e8f0fe;
    }
  `,
  divider: css`
    border-top: 1px solid #e8e8e8;
    margin: 4px 0;
  `,
  header: css`
    padding: 4px 16px 2px;
    font-size: 10px;
    font-weight: 600;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
};

// ============================================================================
// Component
// ============================================================================

export function ChartContextMenu({ onClose, data }: OverlayProps): React.ReactElement | null {
  const chartId = data?.chartId as string | undefined;
  const screenX = data?.screenX as number | undefined;
  const screenY = data?.screenY as number | undefined;

  const menuRef = useRef<HTMLDivElement>(null);

  const chart = chartId != null ? getChartById(chartId) : undefined;

  // Contributed items, re-read when a contributor activates or deactivates — an
  // extension can register AFTER this menu already exists.
  const contributions = useSyncExternalStore(subscribeToContributions, contributionsSnapshot);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    setTimeout(() => document.addEventListener("mousedown", handler, true), 50);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [onClose]);

  if (!chart || chartId == null || screenX == null || screenY == null) return null;

  const chartLabel = chart.spec?.title ?? chart.name ?? "Chart";

  const editChart = () => {
    onClose();
    // Re-open the chart dialog in edit mode (Data / Design / Spec tabs) —
    // same entry point as the ribbon's "Edit Chart" action.
    if (isPivotDataSource(chart.spec.data)) {
      showDialog(CHART_DIALOG_ID, { pivotId: chart.spec.data.pivotId, editChartId: chartId });
    } else {
      showDialog(CHART_DIALOG_ID, { editChartId: chartId });
    }
  };

  const editScript = () => {
    onClose();
    emitAppEvent("scriptable-objects:edit-script", {
      objectType: "chart",
      instanceId: String(chartId),
      objectName: chartLabel,
    });
  };

  const deleteChart = () => {
    onClose();
    // Routed through index.ts so deletion runs the exact same sequence as the
    // Delete key (deselect, store removal, cache, regions, events).
    window.dispatchEvent(
      new CustomEvent(ChartEvents.CHART_DELETE_REQUEST, { detail: { chartId } }),
    );
  };

  return (
    <div
      ref={menuRef}
      className={styles.menu}
      style={{
        left: Math.min(screenX, window.innerWidth - 200),
        top: Math.min(screenY, window.innerHeight - 96),
      }}
    >
      <div className={styles.header}>{chartLabel}</div>

      <div className={styles.item} onClick={editChart}>
        Edit Chart...
      </div>

      <div className={styles.item} onClick={editScript}>
        Edit Script...
      </div>

      {visibleFor(contributions, chartId).map((item) => (
        <div
          key={item.id}
          className={styles.item}
          onClick={() => {
            // Close FIRST: a contribution that opens a dialog or a task pane must
            // not have to fight this menu for the dropdown layer, and a throw
            // from foreign code must not leave the menu stuck on screen.
            onClose();
            try {
              item.onSelect(chartId);
            } catch (err) {
              console.warn(`[Charts] Context-menu contribution "${item.id}" threw:`, err);
            }
          }}
        >
          {item.label}
        </div>
      ))}

      <div className={styles.divider} />

      <div className={styles.item} onClick={deleteChart}>
        Delete Chart
      </div>
    </div>
  );
}

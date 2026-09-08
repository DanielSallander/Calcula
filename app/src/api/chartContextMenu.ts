//! FILENAME: app/src/api/chartContextMenu.ts
// PURPOSE: Let another extension add an item to a chart's right-click menu.
// CONTEXT: The chart context menu is hard-coded — Edit Chart, Edit Script,
//          Delete — with no contribution point at all, so "Explain this chart"
//          had nowhere to live. The grid already has
//          `gridExtensions.registerContextMenuItem`; this is the same idea for
//          charts, and it points the same way: `@api` imports no extension,
//          Charts READS the registered items, and a contributor WRITES them.

export interface ChartContextMenuContribution {
  id: string;
  label: string;
  /** Lower sorts first. Built-in items occupy the low numbers. */
  order?: number;
  /** Hide the item for charts it cannot act on. Absent means always shown. */
  visible?(chartId: string): boolean;
  onSelect(chartId: string): void;
}

const contributions = new Map<string, ChartContextMenuContribution>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Add an item. Returns the removal function for a cleanup list. */
export function registerChartContextMenuContribution(
  contribution: ChartContextMenuContribution,
): () => void {
  contributions.set(contribution.id, contribution);
  notify();
  return () => {
    // Only remove it if it is still OURS: a re-registration under the same id
    // must not be deleted by the previous owner's stale cleanup.
    if (contributions.get(contribution.id) === contribution) {
      contributions.delete(contribution.id);
      notify();
    }
  };
}

/** Every contributed item, in display order. */
export function getChartContextMenuContributions(): ChartContextMenuContribution[] {
  return [...contributions.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/**
 * Subscribe to changes.
 *
 * The menu is rendered by Charts and contributed to by others, so it has to
 * re-render when a contributor activates or deactivates after the menu already
 * exists.
 */
export function onChartContextMenuContributionsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Test/reset hook. */
export function resetChartContextMenuContributions(): void {
  contributions.clear();
  notify();
}

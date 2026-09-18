//! FILENAME: app/src/api/chartQuickActions.ts
// PURPOSE: The seam another extension uses to put a button in a selected
//          chart's quick-access strip — the little column of buttons that
//          floats to the right of a chart the reader has clicked.
// CONTEXT: The strip was a hard-coded array of three buttons inside Charts
//          (elements, styles, filters), drawn straight onto the grid canvas.
//          Insights needs two of its own there — "points of interest" and its
//          snapshot — and the Facade Rule forbids Charts importing Insights or
//          Insights importing Charts, so the strip needs a seam, and this is it
//          (docs/design/insight-overlays.md, the Seam Rule in CLAUDE.md).
//
//          THE SEAM SAYS WHAT, CHARTS DECIDES HOW. A contributor declares an
//          id, an icon from a CLOSED set, a tooltip and what to do; Charts
//          decides the size, the position, the hover and pressed look, the hit
//          area and the pixels of the icon itself. Nothing here names a pixel,
//          and no `draw(ctx)` callback is accepted: a contributor handed the
//          grid's canvas could paint anywhere on it, and the strip's buttons
//          would drift apart the first time one of them was styled by hand.
//
//          THE ICON SET IS CLOSED for the same reason the cue vocabulary is
//          (§4.2): every icon is drawn by the painter, so an icon that is not
//          in the set is one nothing knows how to draw. Adding one is a
//          deliberate change in two places, not a string a caller invents.
//
//          EVERY PREDICATE IS ASKED PER CHART, at paint time. "Points of
//          interest" is a toggle whose label and pressed state depend on the
//          chart in front of the reader, and a registry that cached either
//          would show the wrong one on the second chart.

/** The icons the Charts painter knows how to draw. Closed on purpose. */
export type ChartQuickActionIcon = "insight" | "camera";

export interface ChartQuickAction {
  /** Stable, unique, namespaced by its owner (e.g. "insights.pointsOfInterest"). */
  id: string;
  icon: ChartQuickActionIcon;
  /** Lower first. The built-in three occupy the top of the strip regardless. */
  order: number;
  /** The tooltip for THIS chart — a toggle says "Show…" or "Hide…". */
  tooltip: (chartId: string) => string;
  /** Absent means always. A button that cannot act must not be drawn. */
  visible?: (chartId: string) => boolean;
  /** Drawn pressed, the way an open popup is. Absent means never pressed. */
  active?: (chartId: string) => boolean;
  onSelect: (chartId: string) => void;
}

const actions = new Map<string, ChartQuickAction>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

/**
 * Add a button to every selected chart's strip. Returns the unregister.
 *
 * Registering the same id twice REPLACES the first: an extension reactivated
 * after a hot reload must not leave a dead button behind that calls into a
 * torn-down module.
 */
export function registerChartQuickAction(action: ChartQuickAction): () => void {
  actions.set(action.id, action);
  notify();
  return () => {
    if (actions.delete(action.id)) notify();
  };
}

/**
 * The actions to draw for one chart, in order.
 *
 * A `visible` predicate that throws is treated as "no": a contributor's bad
 * day must not take the whole strip — including the built-in buttons — down
 * with it.
 */
export function chartQuickActionsFor(chartId: string): ChartQuickAction[] {
  const out: ChartQuickAction[] = [];
  for (const a of actions.values()) {
    let shown = true;
    try {
      shown = a.visible === undefined || a.visible(chartId);
    } catch {
      shown = false;
    }
    if (shown) out.push(a);
  }
  return out.sort((x, y) => (x.order === y.order ? x.id.localeCompare(y.id) : x.order - y.order));
}

/** Every registered action, visible or not — for the editor and for tests. */
export function listChartQuickActions(): ChartQuickAction[] {
  return [...actions.values()].sort((x, y) => (x.order === y.order ? x.id.localeCompare(y.id) : x.order - y.order));
}

/** Subscribe to registration changes, so a painter can redraw the strip. */
export function onChartQuickActionsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drop everything (test teardown; never called in the running app). */
export function resetChartQuickActions(): void {
  if (actions.size === 0) return;
  actions.clear();
  notify();
}

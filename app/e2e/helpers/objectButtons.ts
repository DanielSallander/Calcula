/**
 * Button helpers for the live journey (`moving-objects.spec.ts` steps 14, 15
 * and 16, BUG-0258 design phases 4b and 4c): a canvas pivot box's +/- icons, a
 * chart's quick-access buttons and a run-mode floating button are CONTENT that
 * acts on RELEASE over the same button.
 *
 * Everything here READS through the running app's own modules (the same
 * instance the app loaded, so the stores are the live ones), and every point
 * comes from what the product itself painted -- the box's painted record,
 * confirmed by the box's OWN chrome hit test (`hitPivotVisualChrome`, the one
 * the zone answer and the release read), and the chart renderer's cached
 * quick-access buttons -- never a copy of a layout.
 */
import type { Page } from "@playwright/test";
import { MOD, installAppImport } from "./pivot-live";

const PIVOT_VISUAL_HITS = "/extensions/Pivot/lib/pivotVisualHits.ts";
const BUTTON_SERVICE = "/src/api/buttonControlService.ts";
const DESIGN_MODE = "/src/api/designMode.ts";
const APP_EVENTS = "/src/api/events.ts";
const QUICK_ACCESS = "/extensions/Charts/rendering/quickAccessButtons.ts";
const API_GRID = "/src/api/grid.ts";

/** A +/- icon of a canvas pivot box, as the box painted it. */
export interface PivotIconPoint {
  /** CLIENT px at the icon's centre. */
  x: number;
  y: number;
  /** The icon's key in the box's chrome bounds (it names the view cell). */
  key: string;
  viewRow: number;
  isExpanded: boolean;
}

/**
 * The CLIENT point of the first ROW +/- icon of pivot box `pivotId` that is
 * `expanded` ('-') or not ('+'), or `withKey` when given -- inside the box, and
 * confirmed by the box's own hit test to be THAT icon. Null when the box has
 * not painted one (yet).
 */
export async function pivotBoxIconPoint(
  page: Page,
  pivotId: string,
  opts: { expanded?: boolean; withKey?: string } = {},
): Promise<PivotIconPoint | null> {
  await installAppImport(page);
  return page.evaluate(
    async ({ pivotId, opts, mods }) => {
      const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, (...a: unknown[]) => unknown>> };
      const hits = await w.__appImport(mods.hits);
      const grid = await w.__appImport(mods.grid);
      type Rect = { x: number; y: number; width: number; height: number };
      type Icon = Rect & { row: number; isExpanded: boolean; isRow: boolean };
      const record = hits.getPivotVisualRecord(pivotId) as
        | { box: Rect; bounds: { expandCollapseIcons: Map<string, Icon> } | null }
        | undefined;
      if (!record?.bounds) return null;
      const area = (document.querySelector("[data-grid-area]") as HTMLElement).getBoundingClientRect();
      const zoom = ((grid.getGridStateSnapshot() as { zoom?: number } | null)?.zoom ?? 1) as number;
      for (const [key, icon] of record.bounds.expandCollapseIcons) {
        if (!icon.isRow) continue;
        if (opts.withKey !== undefined && key !== opts.withKey) continue;
        if (opts.expanded !== undefined && icon.isExpanded !== opts.expanded) continue;
        const cx = record.box.x + icon.x + icon.width / 2;
        const cy = record.box.y + icon.y + icon.height / 2;
        const b = record.box;
        if (cx < b.x + 2 || cy < b.y + 2 || cx > b.x + b.width - 2 || cy > b.y + b.height - 2) continue;
        const hit = hits.hitPivotVisualChrome(record, cx, cy) as { kind: string; key?: string } | null;
        if (hit?.kind !== "icon" || hit.key !== key) continue;
        return { x: area.left + cx * zoom, y: area.top + cy * zoom, key, viewRow: icon.row, isExpanded: icon.isExpanded };
      }
      return null;
    },
    { pivotId, opts, mods: { hits: PIVOT_VISUAL_HITS, grid: API_GRID } },
  );
}

/**
 * The CLIENT point at the centre of a SELECTED chart's quick-access button of
 * `type` ('elements', 'styles', 'filters'), from the renderer's own cache (the
 * buttons it painted and hit-tests). Null when the chart shows none.
 */
export async function chartQuickAccessPoint(page: Page, chartId: string, type = "elements"): Promise<{ x: number; y: number } | null> {
  await installAppImport(page);
  return page.evaluate(
    async ({ chartId, type, mods }) => {
      const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, (...a: unknown[]) => unknown>> };
      const renderer = await w.__appImport(mods.renderer);
      const grid = await w.__appImport(mods.grid);
      type Btn = { type: string; x: number; y: number; width: number; height: number };
      const d = renderer.getCachedChartData(chartId) as { quickAccessButtons?: Btn[] } | null | undefined;
      const b = d?.quickAccessButtons?.find((q) => q.type === type);
      if (!b) return null;
      const area = (document.querySelector("[data-grid-area]") as HTMLElement).getBoundingClientRect();
      const zoom = ((grid.getGridStateSnapshot() as { zoom?: number } | null)?.zoom ?? 1) as number;
      return { x: area.left + (b.x + b.width / 2) * zoom, y: area.top + (b.y + b.height / 2) * zoom };
    },
    { chartId, type, mods: { renderer: MOD.CHART_RENDERER, grid: API_GRID } },
  );
}

/** The chart quick-access popup the store says is open (null = none). */
export async function activeQuickAccessPopup(page: Page): Promise<{ chartId: string; buttonType: string } | null> {
  await installAppImport(page);
  return page.evaluate(
    async ({ mod }) => {
      const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, (...a: unknown[]) => unknown>> };
      const qa = await w.__appImport(mod);
      const p = qa.getActivePopup() as { chartId: string; buttonType: string } | null;
      return p ? { chartId: p.chartId, buttonType: p.buttonType } : null;
    },
    { mod: QUICK_ACCESS },
  );
}

/**
 * A floating button at an exact sheet-px position, through the Controls seam
 * (`requireButtonControlProvider().createButton`: the recipe a button inserted
 * from the ribbon gets -- caption key `text`, unpinned, registered and
 * painted). Resolves to the control's instance id (its region id).
 */
export async function createFloatingButton(
  page: Page,
  req: { sheetIndex: number; x: number; y: number; width: number; height: number; label: string },
): Promise<{ instanceId: string; row: number; col: number }> {
  await installAppImport(page);
  return page.evaluate(
    async ({ mod, req }) => {
      const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, (...a: unknown[]) => unknown>> };
      const m = await w.__appImport(mod);
      const provider = m.requireButtonControlProvider() as {
        createButton: (r: unknown) => Promise<{ instanceId: string; row: number; col: number }>;
      };
      const h = await provider.createButton(req);
      return { instanceId: h.instanceId, row: h.row, col: h.col };
    },
    { mod: BUTTON_SERVICE, req },
  );
}

/** Turn Design Mode on or off (the flag the Developer menu toggles), then let the controls republish. */
export async function setDesignMode(page: Page, on: boolean): Promise<void> {
  await installAppImport(page);
  await page.evaluate(
    async ({ mod, on }) => {
      const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, (...a: unknown[]) => unknown>> };
      (await w.__appImport(mod)).setDesignMode(on);
    },
    { mod: DESIGN_MODE, on },
  );
  await page.waitForTimeout(200);
}

/**
 * Count app events named `name` (e.g. `button:clicked`) from now on, through
 * the running app's own event bus (`onAppEvent`, the same instance the
 * extensions emit on). A second call restarts the count at 0.
 */
export async function startAppEventCounter(page: Page, name: string): Promise<void> {
  await installAppImport(page);
  await page.evaluate(
    async ({ mod, name }) => {
      type W = {
        __appImport: (m: string) => Promise<Record<string, (...a: unknown[]) => unknown>>;
        __e2eAppEventCounts?: Record<string, { n: number; off: () => void }>;
      };
      const w = window as unknown as W;
      w.__e2eAppEventCounts ??= {};
      w.__e2eAppEventCounts[name]?.off();
      const events = await w.__appImport(mod);
      const entry = { n: 0, off: () => {} };
      entry.off = events.onAppEvent(name, () => {
        entry.n += 1;
      }) as () => void;
      w.__e2eAppEventCounts[name] = entry;
    },
    { mod: APP_EVENTS, name },
  );
}

/** How many `name` app events arrived since `startAppEventCounter`. */
export async function appEventCount(page: Page, name: string): Promise<number> {
  return page.evaluate((name) => {
    const w = window as unknown as { __e2eAppEventCounts?: Record<string, { n: number }> };
    const entry = w.__e2eAppEventCounts?.[name];
    if (!entry) throw new Error(`no counter for ${name}: call startAppEventCounter first`);
    return entry.n;
  }, name);
}

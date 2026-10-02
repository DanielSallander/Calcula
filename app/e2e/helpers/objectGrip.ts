/**
 * Grip helpers for the live journey (`moving-objects.spec.ts` steps 17, 18, 20
 * and 23, BUG-0258 design phase 5: Core's six-dot grip on an object with no
 * header or title, shown while it is hovered or selected).
 *
 * Every rectangle here comes from the product's OWN grip geometry
 * (src/core/lib/floatingGrip.ts `floatingGripOf`, the function Core's painter
 * and Core's press both read), at the live painted gutters, scroll, zoom and
 * page -- never a copy of the layout -- reached through the running app's own
 * module instance (`__appImport`). `shown` is the product's own visibility
 * answer (`floatingGripShown`) at that moment.
 */
import type { Page } from "@playwright/test";
import { installAppImport } from "./pivot-live";

const FLOATING_GRIP = "/src/core/lib/floatingGrip.ts";
const GRID_OVERLAYS = "/src/api/gridOverlays.ts";
const LAYOUT_SURFACE = "/src/core/lib/layoutSurface.ts";
const API_GRID = "/src/api/grid.ts";

/** Where an object's grip sits, in CLIENT px, and whether the product shows it now. */
export interface GripRect {
  /** The hit square, in CLIENT px. */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * "above" the object, "below" it where there is no room above, or "left":
   * beside the left edge of an object too narrow for either (level with its
   * top edge -- the M7 review moved it there from the top-left corner).
   */
  placement: "above" | "below" | "left";
  /** The product's own answer: is the grip visible right now? */
  shown: boolean;
  /** What the family publishes: `"hover"` (a header-less / title-less object asks for a hover grip) or null. */
  flag: string | null;
  /** The CLIENT point at the grip's centre. */
  centre: { x: number; y: number };
}

/**
 * The grip of the published region `regionId` (e.g. `slicer-<id>`,
 * `timeline-slicer-<id>`, `fr-<id>`), whether or not it shows -- so a test can
 * sample the place it WOULD be painted. Throws when the region is not
 * published or has no room for a grip.
 */
export async function gripRect(page: Page, regionId: string): Promise<GripRect> {
  await installAppImport(page);
  const r = await page.evaluate(
    async ({ regionId, mods }) => {
      const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, (...a: unknown[]) => unknown>> };
      const grip = await w.__appImport(mods.grip);
      const overlays = await w.__appImport(mods.overlays);
      const layout = await w.__appImport(mods.layout);
      const grid = await w.__appImport(mods.grid);
      type Region = { id: string; floating?: unknown; data?: Record<string, unknown> };
      const region = (overlays.getGridRegions() as Region[]).find((x) => x.id === regionId);
      if (!region) return { error: `no published region ${regionId}` };
      const geo = overlays.currentFloatingHitGeometry() as
        | { rowHeaderWidth: number; colHeaderHeight: number; scrollX: number; scrollY: number }
        | null;
      if (!geo) return { error: "the grid is not mounted" };
      const snap = grid.getGridStateSnapshot() as { zoom?: number; sheetContext: { activeSheetIndex: number } } | null;
      const zoom = (snap?.zoom ?? 1) || 1;
      const surface = layout.getLayoutSurface(snap?.sheetContext.activeSheetIndex ?? 0) as { page: { width: number; height: number } | null } | null;
      const g = grip.floatingGripOf(
        region,
        { rowHeaderWidth: geo.rowHeaderWidth, colHeaderHeight: geo.colHeaderHeight },
        { scrollX: geo.scrollX, scrollY: geo.scrollY },
        zoom,
        surface?.page ?? null,
      ) as { placement: "above" | "below" | "left"; hit: { x: number; y: number; width: number; height: number } } | null;
      if (!g) return { error: `region ${regionId} has no room for a grip` };
      const area = (document.querySelector("[data-grid-area]") as HTMLElement).getBoundingClientRect();
      const x = area.left + g.hit.x * zoom;
      const y = area.top + g.hit.y * zoom;
      const width = g.hit.width * zoom;
      const height = g.hit.height * zoom;
      return {
        x,
        y,
        width,
        height,
        placement: g.placement,
        shown: grip.floatingGripShown(region) === true,
        flag: typeof region.data?.grip === "string" ? region.data.grip : null,
        centre: { x: x + width / 2, y: y + height / 2 },
      };
    },
    { regionId, mods: { grip: FLOATING_GRIP, overlays: GRID_OVERLAYS, layout: LAYOUT_SURFACE, grid: API_GRID } },
  );
  if ("error" in r) throw new Error(`gripRect: ${String(r.error)}`);
  return r as GripRect;
}

/** Core's hovered floating region (core/lib/objectHover.ts), through the facade's re-export. */
export async function hoveredRegionId(page: Page): Promise<string | null> {
  await installAppImport(page);
  return page.evaluate(async (mod) => {
    const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, () => unknown>> };
    const overlays = await w.__appImport(mod);
    return (overlays.getHoveredFloatingRegionId() as string | null) ?? null;
  }, GRID_OVERLAYS);
}

/**
 * Count, from now on, the window CustomEvents named `name` (e.g.
 * `floatingObject:gripClick`) -- a plain window listener installed in the page.
 * Calling it again resets the count.
 */
export async function startWindowEventCounter(page: Page, name: string): Promise<void> {
  await page.evaluate((name) => {
    const w = window as unknown as { __m7Counters?: Record<string, { n: number; off: () => void }> };
    w.__m7Counters ??= {};
    w.__m7Counters[name]?.off();
    const entry = { n: 0, off: () => {} };
    const on = () => {
      entry.n++;
    };
    window.addEventListener(name, on);
    entry.off = () => window.removeEventListener(name, on);
    w.__m7Counters[name] = entry;
  }, name);
}

/** How many `name` events reached the window since `startWindowEventCounter`. */
export async function windowEventCount(page: Page, name: string): Promise<number> {
  return page.evaluate((name) => {
    const w = window as unknown as { __m7Counters?: Record<string, { n: number }> };
    return w.__m7Counters?.[name]?.n ?? -1;
  }, name);
}

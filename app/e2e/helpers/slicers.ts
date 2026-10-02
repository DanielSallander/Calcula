/**
 * Slicer helpers for the live journeys (`moving-objects.spec.ts` steps 11-13,
 * BUG-0258 design phase 4: a slicer's items, "Select all", the lit clear
 * button and the scrollbar are CONTENT).
 *
 * Everything here READS through the running app's own modules (the same
 * instance the app loaded, so the stores are the live ones) or the BACKEND,
 * and, for points, asks the extension's OWN hit test and thumb geometry
 * (`getSlicerHitDetail`, `slicerScrollTrack` / `slicerScrollThumb` in
 * extensions/Slicer/rendering/slicerRenderer.ts -- the functions the painter,
 * the zone answer and the content gesture read) -- never a copy of its layout,
 * so a point returned here is where the product itself says that part is.
 */
import type { Page } from "@playwright/test";
import { MOD, callModule, eventually, installAppImport, invoke } from "./pivot-live";

/** A slicer as the BACKEND holds it (`get_all_slicers`; sheet px). */
export interface SlicerRow {
  id: string;
  sheetIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The committed selection; null = every item (no filter). */
  selectedItems: string[] | null;
}

/** The slicer's PERSISTED row, from the backend. */
export async function slicerRow(page: Page, sid: string): Promise<SlicerRow> {
  const all = await invoke<SlicerRow[]>(page, "get_all_slicers");
  const s = all.find((r) => r.id === sid);
  if (!s) throw new Error(`the backend holds no slicer ${sid}`);
  return s;
}

/** The slicer's item values in the order it shows them (the live store's cache). */
export async function slicerItemValues(page: Page, sid: string): Promise<string[]> {
  const items = await callModule<Array<{ value: string }> | undefined>(page, MOD.SLICER_STORE, "getCachedItems", [sid]);
  return (items ?? []).map((i) => i.value);
}

/** Wait until no slicer click is still landing its undo step (the store's own flag). */
export async function slicerLanded(page: Page): Promise<void> {
  await eventually(
    () => callModule<boolean>(page, MOD.SLICER_STORE, "isSlicerGestureLanding", []),
    (v) => v === false,
    "the slicer selection never landed",
    15_000,
  );
  await page.waitForTimeout(300);
}

/**
 * The CLIENT point at the centre of the item `value`'s painted button, found by
 * the slicer's own hit test (an item is its painted button; the gaps between
 * buttons are frame). Throws when the item has no visible hit area.
 */
export async function slicerItemPoint(page: Page, sid: string, value: string): Promise<{ x: number; y: number }> {
  await installAppImport(page);
  const r = await page.evaluate(
    async ({ sid, value, mods }) => {
      const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, (...a: unknown[]) => unknown>> };
      const renderer = await w.__appImport(mods.renderer);
      const geo = await w.__appImport(mods.geo);
      const store = await w.__appImport(mods.store);
      const grid = await w.__appImport(mods.grid);
      const s = store.getSlicerById(sid) as { x: number; y: number; width: number; height: number } | undefined;
      if (!s) return { error: `no slicer ${sid}` };
      const b = geo.slicerCanvasBounds(s) as { x: number; y: number; width: number; height: number } | null;
      if (!b) return { error: "no bounds" };
      const xs: number[] = [];
      const ys: number[] = [];
      const seen = new Set<string>();
      for (let y = b.y + 1; y < b.y + b.height; y += 2) {
        for (let x = b.x + 1; x < b.x + b.width; x += 2) {
          const h = renderer.getSlicerHitDetail(x, y, b, sid) as { type: string; itemValue?: string } | null;
          if (!h) continue;
          seen.add(h.type === "item" ? `item:${h.itemValue}` : h.type);
          if (h.type === "item" && h.itemValue === value) {
            xs.push(x);
            ys.push(y);
          }
        }
      }
      if (xs.length === 0) return { error: `item "${value}" has no visible hit area; seen: ${[...seen].join(",")}` };
      xs.sort((a, b) => a - b);
      ys.sort((a, b) => a - b);
      const area = (document.querySelector("[data-grid-area]") as HTMLElement).getBoundingClientRect();
      const zoom = ((grid.getGridStateSnapshot() as { zoom?: number } | null)?.zoom ?? 1) as number;
      return { x: area.left + xs[Math.floor(xs.length / 2)] * zoom, y: area.top + ys[Math.floor(ys.length / 2)] * zoom };
    },
    { sid, value, mods: { renderer: MOD.SLICER_RENDERER, geo: MOD.SLICER_CANVAS_GEO, store: MOD.SLICER_STORE, grid: "/src/api/grid.ts" } },
  );
  if ("error" in r) throw new Error(`slicerItemPoint: ${r.error}`);
  return r as { x: number; y: number };
}

/**
 * The CLIENT point on the slicer's PAINTED scrollbar thumb, `along` of the
 * way down it (0 = its start, 1 = its end), across the middle of the track.
 * The thumb comes from the renderer's own `slicerScrollThumb` at the scroll
 * offset the slicer is painted at. Throws when the slicer does not scroll.
 */
export async function slicerThumbPoint(page: Page, sid: string, along = 0.3): Promise<{ x: number; y: number; length: number }> {
  await installAppImport(page);
  const r = await page.evaluate(
    async ({ sid, along, mods }) => {
      const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, (...a: unknown[]) => unknown>> };
      const renderer = await w.__appImport(mods.renderer);
      const geo = await w.__appImport(mods.geo);
      const store = await w.__appImport(mods.store);
      const grid = await w.__appImport(mods.grid);
      const s = store.getSlicerById(sid) as { x: number; y: number; width: number; height: number } | undefined;
      if (!s) return { error: `no slicer ${sid}` };
      const items = (store.getCachedItems(sid) as unknown[] | undefined) ?? [];
      const b = geo.slicerCanvasBounds(s) as { x: number; y: number; width: number; height: number } | null;
      if (!b) return { error: "no bounds" };
      const track = renderer.slicerScrollTrack(s, items, b) as {
        axis: "x" | "y";
        x: number;
        y: number;
        width: number;
        height: number;
        start: number;
        length: number;
        contentExtent: number;
      } | null;
      if (!track) return { error: "the slicer does not scroll: it has no scrollbar" };
      const max = renderer.getMaxScrollOffset(sid) as number;
      const scroll = Math.min(renderer.getScrollOffset(sid) as number, max);
      const thumb = renderer.slicerScrollThumb(track.start, track.length, track.contentExtent, scroll) as { start: number; length: number };
      const pos = thumb.start + thumb.length * along;
      const cx = track.axis === "y" ? b.x + track.x + track.width / 2 : b.x + pos;
      const cy = track.axis === "y" ? b.y + pos : b.y + track.y + track.height / 2;
      const area = (document.querySelector("[data-grid-area]") as HTMLElement).getBoundingClientRect();
      const zoom = ((grid.getGridStateSnapshot() as { zoom?: number } | null)?.zoom ?? 1) as number;
      return { x: area.left + cx * zoom, y: area.top + cy * zoom, length: thumb.length };
    },
    { sid, along, mods: { renderer: MOD.SLICER_RENDERER, geo: MOD.SLICER_CANVAS_GEO, store: MOD.SLICER_STORE, grid: "/src/api/grid.ts" } },
  );
  if ("error" in r) throw new Error(`slicerThumbPoint: ${r.error}`);
  return r as { x: number; y: number; length: number };
}

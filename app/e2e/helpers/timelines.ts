/**
 * Timeline helpers shared by the live journeys (`fixall-pivot.spec.ts` F,
 * `moving-objects.spec.ts`). Extracted from fixall-pivot.spec.ts unchanged
 * (M5 T6); `timelineZonePoint` is new.
 *
 * Everything here READS through the running app's own modules (the same
 * instance the app loaded, so the stores are the live ones) and, for points,
 * asks the extension's OWN hit test / zone table -- never a copy of its
 * geometry -- so a point it returns is where the product itself says that
 * part is.
 */
import type { Page } from "@playwright/test";
import { MOD, callModule, eventually } from "./pivot-live";

/** The timeline's zone view over the live store (`timelineZoneAtCanvas`). */
const TIMELINE_VIEW = "/extensions/TimelineSlicer/lib/timelineView.ts";

/** A timeline as the frontend store holds it (dates as ISO strings, sheet px). */
export interface TimelineRow {
  id: string;
  selectionStart: string | null;
  selectionEnd: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function timelineRow(page: Page, id: string): Promise<TimelineRow | null> {
  return (await callModule<TimelineRow | undefined>(page, MOD.TIMELINE_STORE, "getTimelineById", [id])) ?? null;
}

/** The committed range as "yyyy-mm..yyyy-mm", or "all" when unfiltered. */
export async function timelineRange(page: Page, id: string): Promise<string> {
  const t = await timelineRow(page, id);
  return t?.selectionStart ? `${t.selectionStart.slice(0, 7)}..${(t.selectionEnd ?? "").slice(0, 7)}` : "all";
}

/**
 * The CLIENT point of the centre of the timeline period starting `yyyymm`
 * ("2026-02"), found by the extension's own hit test.
 */
export async function periodPoint(page: Page, tid: string, yyyymm: string): Promise<{ x: number; y: number }> {
  const r = await page.evaluate(
    async ({ tid, yyyymm, mods }) => {
      const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, (...a: unknown[]) => unknown>> };
      const renderer = await w.__appImport(mods.renderer);
      const geo = await w.__appImport(mods.geo);
      const store = await w.__appImport(mods.store);
      const grid = await w.__appImport(mods.grid);
      const tl = store.getTimelineById(tid) as { x: number } | undefined;
      const data = store.getCachedTimelineData(tid) as { periods: Array<{ startDate: string }> } | undefined;
      if (!tl || !data) return { error: "no timeline or no data" };
      const k = data.periods.findIndex((p) => p.startDate.startsWith(yyyymm));
      if (k < 0) return { error: `no period ${yyyymm}: ${data.periods.map((p) => p.startDate).join(",")}` };
      const b = geo.timelineCanvasBounds(tl) as { x: number; y: number; width: number; height: number } | null;
      if (!b) return { error: "no bounds" };
      const xs: number[] = [];
      const ys: number[] = [];
      for (let y = b.y; y < b.y + b.height; y += 2) {
        for (let x = b.x; x < b.x + b.width; x += 2) {
          const h = renderer.getTimelineHitDetail(x, y, b, tid) as { type: string; periodIndex?: number } | null;
          if (h && h.type === "period" && h.periodIndex === k) {
            xs.push(x);
            ys.push(y);
          }
        }
      }
      if (xs.length === 0) return { error: `period ${k} has no hit area` };
      xs.sort((a, b) => a - b);
      ys.sort((a, b) => a - b);
      const cx = xs[Math.floor(xs.length / 2)];
      const cy = ys[Math.floor(ys.length / 2)];
      const area = (document.querySelector("[data-grid-area]") as HTMLElement).getBoundingClientRect();
      const zoom = ((grid.getGridStateSnapshot() as { zoom?: number } | null)?.zoom ?? 1) as number;
      return { x: area.left + cx * zoom, y: area.top + cy * zoom };
    },
    { tid, yyyymm, mods: { renderer: MOD.TIMELINE_RENDERER, geo: MOD.TIMELINE_CANVAS_GEO, store: MOD.TIMELINE_STORE, grid: "/src/api/grid.ts" } },
  );
  if ("error" in r) throw new Error(`periodPoint: ${r.error}`);
  return r as { x: number; y: number };
}

/** A real mouse click on a timeline period. */
export async function clickPeriod(page: Page, tid: string, yyyymm: string): Promise<void> {
  const p = await periodPoint(page, tid, yyyymm);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/** Wait until no timeline selection is still landing (the store's own flag). */
export async function timelineLanded(page: Page): Promise<void> {
  await eventually(() => callModule<boolean>(page, MOD.TIMELINE_STORE, "isTimelineGestureLanding", []), (v) => v === false, "the timeline selection never landed", 15_000);
  await page.waitForTimeout(300);
}

/** A part of a timeline, as its zone table names it (lib/timelineZones.ts). */
export type TimelineZonePart =
  | "header"
  | "clearButton"
  | "yearStrip"
  | "period"
  | "rangeStart"
  | "rangeEnd"
  | "empty"
  | "levelButton"
  | "levelGap"
  | "scrollbar";

/**
 * The CLIENT point at the centre of a timeline zone -- the median of every
 * sampled point the timeline's OWN zone table (`timelineZoneAtCanvas`, the
 * answer Core's press and pointer are derived from) calls `part` -- keeping
 * `inset` px clear of the object's edges, where Core's corner resize zones
 * sit. Throws when the timeline has no such zone.
 */
export async function timelineZonePoint(
  page: Page,
  tid: string,
  part: TimelineZonePart,
  opts: { inset?: number } = {},
): Promise<{ x: number; y: number }> {
  const inset = opts.inset ?? 12;
  const r = await page.evaluate(
    async ({ tid, part, inset, mods }) => {
      const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, (...a: unknown[]) => unknown>> };
      const view = await w.__appImport(mods.view);
      const geo = await w.__appImport(mods.geo);
      const store = await w.__appImport(mods.store);
      const grid = await w.__appImport(mods.grid);
      const tl = store.getTimelineById(tid) as { x: number; y: number; width: number; height: number } | undefined;
      if (!tl) return { error: `no timeline ${tid}` };
      const b = geo.timelineCanvasBounds(tl) as { x: number; y: number; width: number; height: number } | null;
      if (!b) return { error: "no bounds" };
      const xs: number[] = [];
      const ys: number[] = [];
      const seen = new Set<string>();
      for (let y = b.y + 1; y < b.y + b.height; y += 2) {
        for (let x = b.x + inset; x < b.x + b.width - inset; x += 2) {
          const z = view.timelineZoneAtCanvas(tid, x, y, b) as { part: string } | null;
          if (!z) continue;
          seen.add(z.part);
          if (z.part === part) {
            xs.push(x);
            ys.push(y);
          }
        }
      }
      if (xs.length === 0) return { error: `no "${part}" zone; seen: ${[...seen].join(",")}` };
      xs.sort((a, b) => a - b);
      ys.sort((a, b) => a - b);
      const area = (document.querySelector("[data-grid-area]") as HTMLElement).getBoundingClientRect();
      const zoom = ((grid.getGridStateSnapshot() as { zoom?: number } | null)?.zoom ?? 1) as number;
      return { x: area.left + xs[Math.floor(xs.length / 2)] * zoom, y: area.top + ys[Math.floor(ys.length / 2)] * zoom };
    },
    {
      tid,
      part,
      inset,
      mods: { view: TIMELINE_VIEW, geo: MOD.TIMELINE_CANVAS_GEO, store: MOD.TIMELINE_STORE, grid: "/src/api/grid.ts" },
    },
  );
  if ("error" in r) throw new Error(`timelineZonePoint: ${r.error}`);
  return r as { x: number; y: number };
}

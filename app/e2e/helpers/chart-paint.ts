/**
 * What a chart (or any canvas painter) actually WROTE, for the live journeys.
 *
 * Lifted out of `journeys/canvas-powerbi.spec.ts` (2026-10-15, WP-D S12) so the
 * object-bindings journey reads the same instruments instead of a second copy:
 *
 *   * `startTextRecorder` wraps `fillText` on the 2D context prototypes (on-
 *     and off-screen) and records every string written from now on. A chart
 *     paints into an off-screen bitmap once and is then blitted, so the recorder
 *     must be in place BEFORE the paint it is meant to see: what it records is
 *     what the painter wrote, which is what the user reads.
 *   * `recordedTexts` reads the record back.
 *   * `cachedData` is what the chart renderer last computed for a chart (its
 *     categories, series values and display strings) -- the renderer's own
 *     cache, read through the instance the app loaded.
 *
 * Nothing in here asserts. It reads; the spec decides.
 */
import type { Page } from "@playwright/test";
import { MOD, callModule } from "./canvas-live";

/**
 * Record every string a 2D context WRITES from now on (on- and off-screen
 * canvases). Calling it again forgets the earlier record and keeps recording.
 */
export async function startTextRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __e2eTexts?: string[] };
    w.__e2eTexts = [];
    const protos: Array<{ fillText: (...a: unknown[]) => void; __e2eWrapped?: boolean } | null> = [
      CanvasRenderingContext2D.prototype as unknown as { fillText: (...a: unknown[]) => void; __e2eWrapped?: boolean },
      typeof OffscreenCanvasRenderingContext2D !== "undefined"
        ? (OffscreenCanvasRenderingContext2D.prototype as unknown as { fillText: (...a: unknown[]) => void; __e2eWrapped?: boolean })
        : null,
    ];
    for (const p of protos) {
      if (!p || p.__e2eWrapped) continue;
      const original = p.fillText;
      p.fillText = function (this: unknown, ...args: unknown[]) {
        const list = (window as unknown as { __e2eTexts?: string[] }).__e2eTexts;
        if (list) {
          list.push(String(args[0]));
          if (list.length > 20_000) list.splice(0, 10_000);
        }
        return original.apply(this, args);
      };
      p.__e2eWrapped = true;
    }
  });
}

/** Every string written since the last `startTextRecorder`. */
export async function recordedTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((window as unknown as { __e2eTexts?: string[] }).__e2eTexts ?? [])]);
}

/** The data the chart renderer last computed for one chart. */
export interface CachedData {
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
  displayValues?: string[][];
}

/** What the chart renderer last computed for `chartId`, or null when it has not painted. */
export async function cachedData(page: Page, chartId: string): Promise<CachedData | null> {
  const d = await callModule<{ data?: CachedData } | null>(page, MOD.CHART_RENDERER, "getCachedChartData", [chartId]);
  return d?.data ?? null;
}

//! FILENAME: app/extensions/Animation/lib/gifExporter.ts
// PURPOSE: Deterministic GIF export of an animation. Seeks each frame, waits for
//          the render to settle, captures pixels (chart raster or grid selection),
//          then Rust-encodes them to a GIF at a chosen path. Restores the model
//          afterwards (via engine.stop()).
import {
  getChartFrameImageData,
  captureGridRegion,
  awaitRenderSettled,
  type CaptureRange,
} from "@api";
import { setStatusBarText, clearStatusBarText } from "@api/grid";
import { save } from "@tauri-apps/plugin-dialog";
import { playbackEngine } from "./animationEngine";
import { exportGif, type GifFrame } from "./animationBackend";

const MAX_FRAMES = 300;
const MAX_PIXELS = 1_500_000; // ~1224x1224 per frame

/** GIF frame delay (centiseconds) for a target fps; clamped to a sane minimum. */
export function delayCsForFps(fps: number): number {
  return Math.max(2, Math.round(100 / Math.max(1, fps)));
}

export type ExportSource =
  | { kind: "chart"; chartId: string }
  | { kind: "selection"; range: CaptureRange };

export interface GifExportResult {
  ok: boolean;
  path?: string;
  error?: string;
}

const raf = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

/**
 * Capture the animation's frame range and write an animated GIF. Chart capture is
 * deterministic (version-gated render-settle); grid-selection capture is best-
 * effort (the grid re-fetches its viewport asynchronously, with no "painted"
 * signal — don't scroll while exporting). Always restores the model when done.
 */
export async function exportAnimationGif(
  source: ExportSource,
  defaultName = "animation",
): Promise<GifExportResult> {
  const st = playbackEngine.getState();
  if (st.frameCount === 0) return { ok: false, error: "No animation is loaded" };
  const start = st.rangeStart;
  const end = st.rangeEnd;
  const count = end - start + 1;
  if (count > MAX_FRAMES) {
    return {
      ok: false,
      error: `Too many frames (${count}); the cap is ${MAX_FRAMES}. Increase the step or shorten the range.`,
    };
  }
  const delayCs = delayCsForFps(st.fps);

  playbackEngine.pause(); // take control of seeking

  const frames: GifFrame[] = [];
  let width = 0;
  let height = 0;
  let captureError: string | null = null;

  try {
    for (let i = start; i <= end; i++) {
      await playbackEngine.seek(i);
      await awaitRenderSettled(source.kind === "chart" ? { chartId: source.chartId } : {});
      if (source.kind === "selection") {
        // Best-effort settle for the async grid viewport re-fetch.
        await raf();
        await new Promise<void>((r) => setTimeout(r, 40));
      }
      const img =
        source.kind === "chart"
          ? getChartFrameImageData(source.chartId)
          : captureGridRegion(source.range);
      if (!img) {
        captureError =
          source.kind === "chart"
            ? "The chart has no rendered frame to capture."
            : "Nothing to capture — the selection may be off-screen.";
        break;
      }
      if (i === start) {
        width = img.width;
        height = img.height;
        if (width * height > MAX_PIXELS) {
          captureError = `The region is too large (${width}x${height}px). Reduce the chart / selection size.`;
          break;
        }
      } else if (img.width !== width || img.height !== height) {
        captureError = "The captured size changed mid-export (avoid scrolling / resizing while exporting).";
        break;
      }
      frames.push({ rgba: Array.from(img.data), delayCs });
      setStatusBarText(`Exporting GIF… frame ${i - start + 1}/${count}`);
    }
  } finally {
    await playbackEngine.stop(); // restore the model regardless of outcome
    clearStatusBarText();
  }

  if (captureError) return { ok: false, error: captureError };
  if (frames.length === 0) return { ok: false, error: "No frames captured" };

  const path = await save({
    defaultPath: `${defaultName}.gif`,
    filters: [{ name: "GIF", extensions: ["gif"] }],
  });
  if (!path) return { ok: false, error: "cancelled" };

  try {
    await exportGif({ path, width, height, frames, repeat: st.loop });
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

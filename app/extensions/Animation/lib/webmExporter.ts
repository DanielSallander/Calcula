//! FILENAME: app/extensions/Animation/lib/webmExporter.ts
// PURPOSE: Export an animation as a WebM video by recording ONE live playback pass
//          of the main grid canvas via canvas.captureStream() + MediaRecorder.
// NOTE: Unlike the (deterministic, region-scoped) GIF export, WebM records the
//   whole grid viewport in real time — so it captures whatever is animating (cells
//   and/or charts). Near-zero deps; frontend-only. Viewers loop the clip themselves.
import { getGridCanvas } from "@api";
import { writeBinaryFile } from "@api/lib";
import { save } from "@tauri-apps/plugin-dialog";
import { playbackEngine } from "./animationEngine";

export interface WebmExportResult {
  ok: boolean;
  path?: string;
  error?: string;
}

const CANDIDATE_MIME_TYPES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

/** The best-supported WebM MIME type, or "" if none / MediaRecorder is unavailable. */
export function pickWebmMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return "";
  for (const t of CANDIDATE_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

/** True when live canvas recording is available in this runtime AND a grid is mounted. */
export function isWebmRecordingSupported(): boolean {
  if (typeof MediaRecorder === "undefined") return false;
  const canvas = getGridCanvas();
  return !!canvas && typeof canvas.captureStream === "function";
}

/** Start recording `canvas` to WebM; stop() finalizes and resolves the Blob. */
export function startCanvasRecording(canvas: HTMLCanvasElement, fps: number): { stop: () => Promise<Blob> } {
  const mimeType = pickWebmMimeType();
  const stream = canvas.captureStream(Math.max(1, Math.min(60, Math.round(fps))));
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<Blob>((resolve) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: mimeType || "video/webm" }));
  });
  rec.start();
  return {
    stop: () => {
      if (rec.state !== "inactive") rec.stop();
      return stopped;
    },
  };
}

function waitForPlaybackEnd(): Promise<void> {
  return new Promise((resolve) => {
    const un = playbackEngine.subscribe((s) => {
      if (s.status === "paused" || s.status === "idle") {
        un();
        resolve();
      }
    });
  });
}

/** Record one live playback pass of the grid canvas and save it as a .webm. */
export async function exportAnimationWebm(defaultName = "animation"): Promise<WebmExportResult> {
  if (typeof MediaRecorder === "undefined") {
    return { ok: false, error: "Video recording is not supported in this runtime" };
  }
  const canvas = getGridCanvas();
  if (!canvas || typeof canvas.captureStream !== "function") {
    return { ok: false, error: "The grid canvas is not available to record" };
  }
  const st = playbackEngine.getState();
  if (st.frameCount === 0) return { ok: false, error: "No animation is loaded" };

  // Record exactly one pass (a WebM is a linear clip; players loop it themselves).
  const wasLoop = st.loop;
  playbackEngine.setLoop(false);
  await playbackEngine.seek(st.rangeStart);

  const rec = startCanvasRecording(canvas, st.fps);
  playbackEngine.play(); // sets status = "playing" synchronously
  await waitForPlaybackEnd();

  const blob = await rec.stop();
  await playbackEngine.stop(); // restore the model
  playbackEngine.setLoop(wasLoop);

  const path = await save({
    defaultPath: `${defaultName}.webm`,
    filters: [{ name: "WebM Video", extensions: ["webm"] }],
  });
  if (!path) return { ok: false, error: "cancelled" };

  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await writeBinaryFile(path, Array.from(bytes));
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

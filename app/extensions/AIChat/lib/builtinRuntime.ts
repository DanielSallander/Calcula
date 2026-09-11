//! FILENAME: app/extensions/AIChat/lib/builtinRuntime.ts
// PURPOSE: The picker's side of the on-board runtime: read its status, word
//          the one consent sentence, run the download with progress, and say
//          in one line what state the built-in provider is in.
// CONTEXT: Owner decision D6 (2026-09-10): the engine ships in the installer,
//          the model is downloaded on first use "behind one consent sentence
//          naming size, licence and source". The sentence is built HERE from
//          the pin the backend reports — never typed twice — so what the user
//          agrees to is what `ai/builtin_model.rs` will refuse to deviate from.
//
//          NOTHING HERE DOWNLOADS WITHOUT THE CLICK. `downloadBuiltinModel` is
//          called by the picker after `confirmAsync` answered true, and the
//          backend command it invokes is on the governed denylist so no
//          third-party extension can reach it either.

import { listenTauriEvent } from "@api";
import { aiChatBackend } from "./aiChatBackend";
import {
  AI_BUILTIN_MODEL_PROGRESS_EVENT,
  type BuiltinModelPin,
  type BuiltinModelProgressEvent,
  type BuiltinStatus,
} from "./aiTypes";

/** Bytes as "1.04 GB" or "412 MB" — what a person compares against free disk space. */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024)).toLocaleString("en-US")} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** "huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF" from the source URL. */
function hostAndPath(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * The consent sentence (D6): size, licence, source, hash, destination, and
 * what will NOT happen. One paragraph, because a person has to be able to
 * read it in a native dialog before deciding.
 */
export function consentSentence(pin: BuiltinModelPin, downloadDir: string): string {
  const shortHash = `${pin.sha256.slice(0, 8)}…${pin.sha256.slice(-6)}`;
  return (
    `Calcula will download ${pin.label} — ${formatSize(pin.sizeBytes)}, licensed ${pin.licence} — ` +
    `from ${hostAndPath(pin.sourceUrl)} into ${downloadDir}, and will refuse the file unless its ` +
    `SHA-256 is ${shortHash}. Nothing else is sent or received. It runs on this computer's ` +
    `processor and you can delete it from this panel later. Download now?`
  );
}

export function readBuiltinStatus(): Promise<BuiltinStatus> {
  return aiChatBackend.invoke<BuiltinStatus>("ai_builtin_status");
}

/**
 * Download the model, reporting progress until the command returns.
 *
 * The listener is registered BEFORE the command is invoked and removed after
 * it settles, whatever way it settles: a listener that outlived the download
 * would report a later download's progress into a component that is gone.
 */
export async function downloadBuiltinModel(
  onProgress: (event: BuiltinModelProgressEvent) => void,
): Promise<BuiltinStatus> {
  const dispose = await listenTauriEvent<BuiltinModelProgressEvent>(
    AI_BUILTIN_MODEL_PROGRESS_EVENT,
    (event) => {
      if (event) onProgress(event);
    },
  );
  try {
    return await aiChatBackend.invoke<BuiltinStatus>("ai_builtin_ensure_model");
  } finally {
    dispose();
  }
}

export function cancelBuiltinDownload(): Promise<void> {
  return aiChatBackend.invoke<void>("ai_builtin_cancel_download");
}

export function stopBuiltinRuntime(): Promise<BuiltinStatus> {
  return aiChatBackend.invoke<BuiltinStatus>("ai_builtin_stop");
}

export function deleteBuiltinModel(): Promise<BuiltinStatus> {
  return aiChatBackend.invoke<BuiltinStatus>("ai_builtin_delete_model");
}

/** The word after the dash in the provider dropdown. */
export function builtinBadge(status: BuiltinStatus | null): string {
  if (!status) return "";
  if (!status.engine.present) return "not in this build";
  if (status.model.presence === "present") return status.running ? "running" : "ready";
  return "download needed";
}

/**
 * One line under the provider note: where the model is, whether the runtime
 * is up, and when it goes away. §10 of the local-model design: the user must
 * always be able to see what is running on their machine and why.
 */
export function describeBuiltin(status: BuiltinStatus): string {
  const idleMinutes = Math.round(status.idleUnloadSecs / 60);
  if (!status.engine.present) {
    return (
      "This installation does not include the on-board runtime, so the built-in model cannot run. " +
      `Looked in: ${status.engine.searched.join("; ")}. In a development tree, run: npm run fetch:llama-server.`
    );
  }
  const { model } = status;
  if (model.presence === "mismatch") {
    return (
      `The file at ${model.path} is ${formatSize(model.sizeOnDisk ?? 0)}, not the ` +
      `${formatSize(model.pin.sizeBytes)} of ${model.pin.label}. It will not be used.`
    );
  }
  if (model.presence === "absent") {
    return (
      `${model.pin.label} is not on this machine yet: a ${formatSize(model.pin.sizeBytes)} download, ` +
      `once. It is stored in ${model.downloadDir}.`
    );
  }
  const foundIn =
    model.foundIn === "bundled" ? "bundled with this installation" :
    model.foundIn === "dev" ? "from the development tree" : "downloaded";
  const where = `Model on disk: ${model.path} (${formatSize(model.sizeOnDisk ?? model.pin.sizeBytes)}, ${foundIn}).`;
  const engine = status.engine.build ? ` Runtime: llama.cpp ${status.engine.build}.` : "";
  const state = status.running
    ? ` Running on port ${status.running.port} (process ${status.running.pid}); stops after ${idleMinutes} minutes without a request.`
    : status.starting
      ? " Starting…"
      : ` Starts on the first request; stops after ${idleMinutes} minutes without one.`;
  return `${where}${engine}${state}`;
}

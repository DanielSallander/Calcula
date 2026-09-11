//! FILENAME: app/extensions/AIChat/lib/aiTypes.ts
// PURPOSE: The TypeScript mirror of Calcula's OWN chat shape
//          (app/src-tauri/src/ai/wire.rs). The extension speaks THIS; a Rust
//          provider renders it into whatever the selected vendor wants.
// CONTEXT: Until 2026-08-19 this extension built Anthropic's JSON directly —
//          `input_schema`, `stop_reason === "tool_use"`, `tool_use_id` blocks —
//          which put one vendor's schema inside an extension (against the Facade
//          Rule) and made "use a different model" a rewrite rather than a
//          setting. Design: docs/design/local-model-script-authoring.md §3c, §7a.
//
//          Field names are camelCase because the Rust structs carry
//          `#[serde(rename_all = "camelCase")]`, per the project's golden rule.

export type ChatRole = "user" | "assistant";

/** Mirrors `ChatBlock` — tagged by `type` so this discriminates cleanly. */
export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "toolUse"; id: string; name: string; input: unknown }
  | { type: "toolResult"; toolUseId: string; content: string; isError: boolean }
  /** Vendor reasoning, round-tripped verbatim. Never rendered as prose. */
  | { type: "reasoning"; raw: unknown };

export interface ChatMessage {
  role: ChatRole;
  content: ChatBlock[];
}

export interface ChatToolDef {
  name: string;
  description: string;
  /** JSON Schema. Calcula's spelling — the provider relocates it per vendor. */
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type StopReason = "endTurn" | "toolUse" | "maxTokens" | "other";

export interface ChatRequest {
  providerId: string;
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools: ChatToolDef[];
  maxTokens?: number;
  /** Sampling temperature. Omitted from the wire when undefined. */
  temperature?: number;
  /**
   * A JSON Schema the reply must conform to.
   *
   * Rendered per vendor by the Rust wire: a `response_format` on an
   * OpenAI-compatible endpoint, a single FORCED TOOL on Anthropic. Either way
   * the reply arrives as JSON text, so a caller here never branches on vendor.
   *
   * Use it for a request that wants a SHAPE — a formula proposal, an intent
   * classification — never for conversation.
   */
  responseSchema?: ResponseSchema;
  /**
   * A GBNF grammar, for runtimes that accept one (llama.cpp's own server).
   *
   * Constrains the CONTENT rather than the envelope, so a grammar-constrained
   * formula cannot be syntactically invalid. Ollama's compatible endpoint has no
   * such field and ignores it; set this only where the model profile says it is
   * honoured.
   */
  grammar?: string;
}

/** Mirrors `ResponseSchema` in `app/src-tauri/src/ai/wire.rs`. */
export interface ResponseSchema {
  /**
   * Names the schema for OpenAI and the forced tool for Anthropic. Keep it
   * stable: it is how the Rust side finds the reply to unwrap.
   */
  name: string;
  schema: Record<string, unknown>;
  /** OpenAI's strict mode. Ignored elsewhere. */
  strict?: boolean;
}

/**
 * Temperature for a turn that may call a tool.
 *
 * WHICH tool answers a request is not a creative decision, and Calcula was
 * sampling it: no temperature was ever sent, so every turn ran at the runtime's
 * default (0.8 for Ollama's qwen builds). Measured 2026-08-22 against a live
 * Ollama — the same prompt with the same 24 tools produced a different choice on
 * four consecutive runs, twice inventing a tool name outright.
 *
 * Zero rather than "low": there is a single best tool for a request, and the
 * repair loop is a far better recovery mechanism than a lucky sample.
 */
export const TOOL_USE_TEMPERATURE = 0;

export interface ChatResponse {
  blocks: ChatBlock[];
  stopReason: StopReason;
  model: string;
}

/** Mirrors `ProviderDef` + `ProviderStatus` (serde `flatten`). */
export interface ProviderStatus {
  id: string;
  label: string;
  kind: "anthropic" | "openAiCompat";
  baseUrl: string;
  requiresKey: boolean;
  /** Runs on this machine — drives the privacy copy and the picker ordering. */
  isLocal: boolean;
  note: string;
  /** A key is stored. Always true for a provider that needs none. */
  hasKey: boolean;
}

/** Mirrors `StreamEvent` + the envelope's `streamId` (serde `flatten`). */
export type StreamEvent =
  /**
   * The request is about to leave the process, naming the endpoint it is going
   * to. The first three variants exist because everything before the first token
   * — connect, accept, and on a local runtime the tens of seconds spent loading
   * a model into VRAM — used to render as a literal "…" with no way to tell a
   * loading model from a runtime that is not running.
   */
  | { streamId: string; type: "requested"; model: string; endpoint: string }
  /** The server accepted the request. The gap to the first delta is thinking. */
  | { streamId: string; type: "opened"; status: number }
  /**
   * Vendor "thinking" output. Rendered SEPARATELY from the answer and never
   * merged into it — it is not prose the model is saying to the user, and the
   * streamed answer is replaced wholesale by the authoritative blocks.
   */
  | { streamId: string; type: "reasoningDelta"; text: string }
  | { streamId: string; type: "textDelta"; text: string }
  | { streamId: string; type: "toolCallStarted"; id: string; name: string }
  | { streamId: string; type: "done"; response: ChatResponse }
  /**
   * The stream broke part-way. DISTINCT from `done` on purpose: a partial answer
   * must never be mistaken for a finished one and fed back to the model as if
   * the turn had completed.
   */
  | { streamId: string; type: "failed"; message: string };

/**
 * The error `ai_chat_complete_stream` rejects with when the user pressed Stop.
 *
 * MUST equal `STREAM_CANCELLED` in `app/src-tauri/src/ai/mod.rs`. Matched rather
 * than inferred so a stopped turn renders as a neutral status line instead of as
 * a failure the user has to worry about.
 */
export const STREAM_CANCELLED = "The turn was stopped.";

/** The Tauri event every stream chunk arrives on, correlated by `streamId`. */
export const AI_STREAM_EVENT = "ai:chat-stream";

export interface DiscoveredRuntime {
  providerId: string;
  label: string;
  baseUrl: string;
  /**
   * Models it reported. EMPTY IS A REAL STATE, not a failure: a freshly
   * installed runtime with nothing pulled yet answered the probe but has
   * nothing to offer, and the UI must say something different about that than
   * about "no runtime found".
   */
  models: string[];
}

// ---------------------------------------------------------------------------
// The on-board runtime (Tier 1) — mirrors app/src-tauri/src/ai/runtime.rs and
// ai/builtin_model.rs
// ---------------------------------------------------------------------------

/** `providers::BUILTIN_ID`: the one provider whose server Calcula runs itself. */
export const BUILTIN_PROVIDER_ID = "calcula-builtin";

/** Mirrors `ModelPin`. Everything the consent sentence names comes from here. */
export interface BuiltinModelPin {
  id: string;
  file: string;
  label: string;
  url: string;
  sourceUrl: string;
  licence: string;
  sizeBytes: number;
  sha256: string;
}

export type BuiltinModelPresence = "present" | "absent" | "mismatch";
/**
 * Which folder the copy was found in. Only a DOWNLOADED copy is ever deleted
 * by the app. The field is `foundIn`, not `origin`: a source-scan guard reads
 * `.origin === "…"` anywhere as a script trust origin compared to a string.
 */
export type BuiltinModelFoundIn = "bundled" | "downloaded" | "dev";

/** Mirrors `DownloadProgress`. */
export interface BuiltinDownloadProgress {
  bytes: number;
  total: number;
  /** The hashing pause after the last byte, which on a slow disk is visible. */
  verifying: boolean;
}

/** Mirrors `BuiltinStatus`, what every `ai_builtin_*` command returns. */
export interface BuiltinStatus {
  providerId: string;
  target: string;
  engine: {
    present: boolean;
    path: string | null;
    /** The llama.cpp build number from the stamp beside the executable. */
    build: string | null;
    searched: string[];
  };
  model: {
    pin: BuiltinModelPin;
    presence: BuiltinModelPresence;
    path: string | null;
    foundIn: BuiltinModelFoundIn | null;
    sizeOnDisk: number | null;
    downloadDir: string;
  };
  running: {
    port: number;
    baseUrl: string;
    pid: number;
    uptimeSecs: number;
    idleSecs: number;
    modelPath: string;
  } | null;
  /** True while a start holds the runtime lock (the health wait). */
  starting: boolean;
  download: BuiltinDownloadProgress | null;
  idleUnloadSecs: number;
}

/** Mirrors `RuntimeEvent`, on `AI_BUILTIN_RUNTIME_EVENT`. */
export type BuiltinRuntimeEvent =
  | { state: "starting"; model: string }
  | { state: "ready"; port: number; baseUrl: string; pid: number }
  | { state: "stopped"; reason: string };

/** Mirrors `ModelProgressEvent`, on `AI_BUILTIN_MODEL_PROGRESS_EVENT`. */
export type BuiltinModelProgressEvent =
  | { phase: "downloading"; bytes: number; total: number }
  | { phase: "verifying"; bytes: number; total: number }
  | { phase: "done"; path: string }
  | { phase: "failed"; message: string }
  | { phase: "cancelled"; bytes: number };

export const AI_BUILTIN_RUNTIME_EVENT = "ai:builtin-runtime";
export const AI_BUILTIN_MODEL_PROGRESS_EVENT = "ai:builtin-model-progress";

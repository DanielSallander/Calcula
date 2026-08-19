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
}

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

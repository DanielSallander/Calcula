//! FILENAME: app/src/api/aiCompletionService.ts
// PURPOSE: The feature-neutral seam through which a feature can ask "a model" a
//          question, without knowing that the AIChat extension owns the provider
//          registry, the model choice and the credential slots.
// CONTEXT: The sibling of `scriptAssistantService.ts`, and deliberately a
//          different shape. That seam is JOB-shaped — start an edit, cancel it,
//          show its UI — because a script rewrite is minutes of work a user
//          walks away from. This one is REQUEST-shaped, because a formula, an
//          intent classification or a narration is a few hundred tokens and the
//          caller waits for it.
//
// WHY A SEAM AT ALL, RATHER THAN READING THE SETTINGS. The provider and model
// live in AIChat's own extension-settings namespace under keys only AIChat
// should know. A second reader would hand-copy those keys and become a second
// source of truth that drifts on AIChat's first rename — and would then have to
// reimplement the credential lookup, the base-URL override and the per-provider
// wire translation. The seam answers `isConfigured()` and `modelLabel()` so a
// caller can explain itself without owning any of that.
//
// WHY THE FEATURE CANNOT JUST CALL THE BACKEND. `ai_chat_complete` is on the
// governed backend-command list (`backendCommands.ts`) behind an explicit
// capability, and every AI command is window-guarded to `main`. Routing through
// the extension that already holds that capability keeps the governance in one
// place instead of spreading it across every feature that wants a sentence.

/** A JSON Schema the reply must conform to. Mirrors the Rust `ResponseSchema`. */
export interface AiResponseSchema {
  /**
   * Names the schema for an OpenAI-compatible endpoint and the FORCED TOOL for
   * Anthropic. The Rust wire uses it to find the reply to unwrap, so a caller
   * that changes it must change nothing else.
   */
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface AiCompletionRequest {
  /** The system prompt. Keep it byte-stable across a session's turns so a provider's prefix cache hits. */
  system: string;
  /**
   * The conversation so far. A repair round APPENDS the previous answer and the
   * finding; it does not rewrite the first message, which would throw away both
   * the context and the cache.
   */
  messages: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  maxTokens?: number;
  /** Defaults to 0. Which formula answers a request is not a creative decision. */
  temperature?: number;
  /** Ask for a shape rather than prose. Ignored by a runtime that does not support it. */
  responseSchema?: AiResponseSchema;
  /**
   * A GBNF grammar the reply must match, for a runtime that honours one.
   *
   * Stronger than a schema and answers a different failure: a schema
   * constrains the ENVELOPE, a grammar constrains the CONTENT, so a
   * grammar-constrained query cannot name a column it was not shown. The reply
   * is then the bare text the grammar describes, not JSON — a caller that
   * sends a grammar reads it that way, and sends no `responseSchema` with it.
   *
   * Sent only where `honorsGrammar()` says so. The provider never forwards it
   * to a vendor that rejects unknown request fields.
   */
  grammar?: string;
}

export interface AiCompletionResult {
  text: string;
  /**
   * Whether the reply ended because the model finished or because it hit the
   * token limit.
   *
   * REPORTED, not swallowed, and the reason is measured: a truncated reply and a
   * model that writes half an answer are indistinguishable in the text, and
   * during M0 that ambiguity scored a working model at 1 out of 60 for twenty
   * minutes before a diagnostic settled it. A caller that cares can retry; one
   * that does not can ignore it. Neither can be misled.
   */
  truncated: boolean;
  /** The model that answered, for provenance in an audit row or a UI caption. */
  model: string;
  durationMs: number;
}

/**
 * One model a caller can switch to.
 *
 * `key` is OPAQUE. The provider encodes whatever identifies the model to it —
 * today a provider id, a model id and a base URL — and decodes it again in
 * `selectModel`. A caller shows the label, remembers the key, and hands it back
 * unchanged; it never parses it. That is what keeps `baseUrl`, a detail only a
 * custom endpoint or a non-default port cares about, out of this facade
 * entirely.
 */
export interface AiModelOption {
  key: string;
  /** The model as its runtime names it, e.g. "qwen3:8b". */
  model: string;
  /** Who serves it, for a caption: "Ollama", "Calcula built-in", "Anthropic". */
  providerLabel: string;
  /** Runs on this machine, so a caller may say so before sending column names. */
  isLocal: boolean;
  /**
   * Whether THIS model honours a GBNF grammar — measured where it has been
   * measured, the runtime's identity where it has not, `undefined` when neither
   * says. Per (provider, model) rather than per provider, because a measurement
   * overrides identity in both directions.
   */
  honorsGrammar: boolean | undefined;
}

export interface AiCompletionProvider {
  /**
   * False when no provider or model has been chosen.
   *
   * Gates nothing — it EXPLAINS. A disabled button with no reason is the failure
   * mode this whole programme has been fixing.
   */
  isConfigured(): boolean;
  /**
   * Every model that can answer RIGHT NOW, best first (local before cloud).
   *
   * READY ONLY. A provider whose key is missing, a local runtime that is not
   * running, a bundled model that has not been downloaded — none of them appear.
   * A picker that lists a model it cannot use is the "disabled control with no
   * reason" failure wearing a different hat, and setting those up costs consent
   * dialogs and credential slots that belong in the owning extension's own UI.
   *
   * Costs round trips (a loopback probe, one call per keyed cloud provider), so
   * call it when the user ASKS for the list — never on mount.
   */
  listModels(): Promise<readonly AiModelOption[]>;
  /**
   * The `key` of the current selection, or `""` when nothing is chosen.
   *
   * Comparable against `AiModelOption.key` and nothing else. It is not a label
   * and not a model id; `modelLabel()` remains the thing to show.
   */
  selectedModelKey(): string;
  /**
   * Switch models. The key must be one `listModels` issued.
   *
   * THIS IS AN APPLICATION PREFERENCE, so the change is global: every surface
   * that asks a model a question uses the new one, including the owning
   * extension's own panel. Callers that record which model answered a given
   * answer should read `AiCompletionResult.model` at the time, not this.
   *
   * Throws on a key the provider did not issue, rather than silently selecting
   * nothing — a selection that quietly failed reads exactly like one that
   * worked until the next request fails.
   */
  selectModel(key: string): void;
  /**
   * Raise the owning extension's full model UI — key entry, downloads, probes.
   *
   * The escape hatch for everything `listModels` deliberately omits. A caller
   * with an empty list offers this instead of pretending it can do setup.
   */
  openModelPicker(): void;
  /** e.g. "qwen2.5-coder:1.5b", for a caption. */
  modelLabel(): string;
  /** True when the model runs on this machine, so a caller can say so. */
  isLocal(): boolean;
  /**
   * Whether this model was measured to honour a reply schema.
   *
   * `undefined` means UNMEASURED, not "no". A caller should send the schema
   * anyway in that case: a runtime that ignores it returns ordinary prose, which
   * a tolerant extractor still reads.
   */
  honorsSchema(): boolean | undefined;
  /**
   * Whether the selected runtime honours a GBNF `grammar`.
   *
   * `undefined` means UNMEASURED. Today the answer is by runtime identity —
   * only llama.cpp's own server implements the field — and a probe that
   * measures it, the way `honorsSchema` is measured, arrives with the bundled
   * runtime. A caller sends a grammar only on `true`.
   */
  honorsGrammar(): boolean | undefined;
  complete(req: AiCompletionRequest, opts?: { signal?: AbortSignal }): Promise<AiCompletionResult>;
}

let provider: AiCompletionProvider | null = null;

/**
 * Register the completion provider. Called once by AIChat at activation;
 * returns the unregister function for its cleanup list.
 *
 * Last registration wins, and unregistering only clears the provider if it is
 * still the one that was registered — so a re-activation cannot leave a dead
 * provider installed.
 */
export function registerAiCompletionProvider(next: AiCompletionProvider): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = null;
  };
}

/** Whether a model can be reached at all. */
export function hasAiCompletionProvider(): boolean {
  return provider !== null;
}

/** The registered provider, or null. Prefer this to `require…` when the feature has a Tier-0 fallback. */
export function getAiCompletionProvider(): AiCompletionProvider | null {
  return provider;
}

/**
 * The registered provider.
 *
 * THROWS when none is registered. The caller turns the throw into a sentence a
 * user can read, rather than a control that silently does nothing.
 */
export function requireAiCompletionProvider(): AiCompletionProvider {
  if (!provider) {
    throw new Error(
      "No AI model is available: the AI Chat extension is not loaded. Enable it and try again.",
    );
  }
  return provider;
}

/** Test/reset hook: forget the registered provider. */
export function resetAiCompletionProvider(): void {
  provider = null;
}

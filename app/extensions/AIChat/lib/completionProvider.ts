//! FILENAME: app/extensions/AIChat/lib/completionProvider.ts
// PURPOSE: AIChat's implementation of `@api/aiCompletionService` — the seam a
//          feature uses to ask a model one question.
// CONTEXT: AIChat owns the provider registry, the model choice, the credential
//          slots and the capability that lets `ai_chat_complete` be called at
//          all. Everything else that wants a sentence from a model reaches
//          through the seam and stays ignorant of all four.
//
//          KEPT DELIBERATELY THIN. It reads the selection, reads the cached
//          profile, forwards the request and reports what came back. It runs no
//          repair loop and makes no judgement about the answer: whoever asked
//          the question owns the verification, because only they know what a
//          good answer looks like.

import {
  registerAiCompletionProvider,
  type AiCompletionProvider,
  type AiCompletionRequest,
  type AiCompletionResult,
} from "@api";

import { aiChatBackend } from "./aiChatBackend";
import type { ChatBlock, ChatResponse } from "./aiTypes";
import { readProfile } from "./probeRunner";
import { isComplete, readSelection } from "./providerSelection";

/** Default reply budget. Generous enough that truncation is rare, small enough to stay quick. */
const DEFAULT_MAX_TOKENS = 600;

interface ProviderStatus {
  id: string;
  isLocal: boolean;
}

/**
 * Which providers run on this machine, cached.
 *
 * Fetched rather than hard-coded: a list of local provider ids here would be a
 * second copy of `providers.rs` and would drift the first time one is added.
 * `isLocal()` answers false until the list arrives, which is the conservative
 * direction — a caption that fails to claim privacy is a smaller error than one
 * that claims it wrongly.
 */
let localIds: Set<string> | null = null;
let localIdsPending = false;

function refreshLocalIds(): void {
  if (localIds !== null || localIdsPending) return;
  localIdsPending = true;
  void aiChatBackend
    .invoke<ProviderStatus[]>("ai_providers_list", {})
    .then((list) => {
      localIds = new Set(list.filter((p) => p.isLocal).map((p) => p.id));
    })
    .catch(() => {
      // Leave it unknown rather than recording an empty set as fact; the next
      // call tries again.
      localIdsPending = false;
    });
}

/**
 * Runtimes KNOWN BY IDENTITY to implement the GBNF `grammar` field: llama.cpp's
 * own server, and the copy of it Calcula bundles. Ollama's compatible endpoint
 * has no such field and ignores it; every cloud vendor rejects an unknown key.
 *
 * Identity is the PRIOR, not the verdict. `honorsGrammar` below answers from
 * the probe's measurement first and falls back to this set only when the
 * model was never tested — so a proxy that strips the field is caught by the
 * measurement, and a runtime nobody named here can still earn a grammar by
 * answering the canary.
 */
const GRAMMAR_PROVIDERS: ReadonlySet<string> = new Set(["llamacpp", "calcula-builtin"]);

export function acceptsGrammar(providerId: string): boolean {
  return GRAMMAR_PROVIDERS.has(providerId);
}

/**
 * Whether the selected model honours a grammar: measured if it was measured,
 * identity if it was not, undefined when nothing is selected.
 */
export function grammarVerdict(): boolean | undefined {
  const sel = readSelection();
  if (!isComplete(sel)) return undefined;
  const measured = readProfile(sel.providerId, sel.model)?.honorsGrammar;
  if (measured !== undefined) return measured;
  return acceptsGrammar(sel.providerId) ? true : undefined;
}

function textOf(blocks: ChatBlock[]): string {
  return blocks
    .filter((b): b is Extract<ChatBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export function buildCompletionProvider(): AiCompletionProvider {
  return {
    isConfigured(): boolean {
      return isComplete(readSelection());
    },

    modelLabel(): string {
      return readSelection().model || "";
    },

    isLocal(): boolean {
      refreshLocalIds();
      const sel = readSelection();
      return localIds !== null && localIds.has(sel.providerId);
    },

    honorsSchema(): boolean | undefined {
      const sel = readSelection();
      if (!isComplete(sel)) return undefined;
      return readProfile(sel.providerId, sel.model)?.honorsSchema;
    },

    honorsGrammar(): boolean | undefined {
      return grammarVerdict();
    },

    async complete(
      req: AiCompletionRequest,
      opts?: { signal?: AbortSignal },
    ): Promise<AiCompletionResult> {
      const sel = readSelection();
      if (!isComplete(sel)) {
        throw new Error("No AI model is selected. Choose one in the AI Chat panel first.");
      }
      if (opts?.signal?.aborted) throw new Error("cancelled");

      const started = Date.now();
      const response = await aiChatBackend.invoke<ChatResponse>("ai_chat_complete", {
        request: {
          providerId: sel.providerId,
          model: sel.model,
          system: req.system,
          messages: req.messages.map((m) => ({
            role: m.role,
            content: [{ type: "text", text: m.text }],
          })),
          tools: [],
          maxTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          // Zero unless the caller says otherwise: which formula answers a
          // request is not a creative decision, and the same argument that
          // pinned the chat's tool-use temperature applies here.
          temperature: req.temperature ?? 0,
          ...(req.responseSchema ? { responseSchema: req.responseSchema } : {}),
          // FORWARDED ONLY WHERE IT IS HONOURED — measured true, or known by
          // identity and never measured. Ollama ignores an unknown key
          // (verified, ai/wire.rs), but a cloud vendor rejects one with a 400
          // before any inference, and a measured FALSE on a llama.cpp id means
          // something in front of it strips the field — so a grammar never
          // leaves for a runtime the verdict is not `true` for.
          ...(req.grammar && grammarVerdict() === true ? { grammar: req.grammar } : {}),
        },
        baseUrlOverride: sel.baseUrl || null,
      });

      return {
        text: textOf(response.blocks),
        // Surfaced rather than swallowed. A truncated reply and a model that
        // wrote half an answer read identically in the text, and telling them
        // apart is what stopped a measured 1-in-60 score from being believed.
        truncated: response.stopReason === "maxTokens",
        model: response.model || sel.model,
        durationMs: Date.now() - started,
      };
    },
  };
}

/** Register the provider. Returns the unregister function for a cleanup list. */
export function installCompletionProvider(): () => void {
  return registerAiCompletionProvider(buildCompletionProvider());
}

//! FILENAME: app/extensions/AIChat/__tests__/completionProvider.test.ts
// PURPOSE: The request-shaped seam forwards a GBNF grammar ONLY where the
//          verdict is `true` — measured first, identity as the prior — and
//          says so through `honorsGrammar()`.
// CONTEXT: 2026-09-10. Ollama's compatible endpoint ignores an unknown key;
//          a cloud vendor answers one with a 400 before any inference. A
//          grammar that leaked to the wrong provider would break every
//          design-query draft for that user with an error naming a field they
//          never typed. The probe now measures it (`honorsGrammar` on the
//          profile); llama.cpp's server and the bundled runtime are trusted by
//          identity until measured, and a measurement overrides identity in
//          both directions.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  selection: { providerId: "ollama", model: "qwen2.5-coder:1.5b", baseUrl: "" },
  profile: undefined as { honorsGrammar?: boolean; honorsSchema?: boolean } | undefined,
}));

vi.mock("@api", () => ({
  registerAiCompletionProvider: (p: unknown) => () => void p,
}));
vi.mock("../lib/aiChatBackend", () => ({
  aiChatBackend: { invoke: (...a: unknown[]) => h.invoke(...a) },
}));
vi.mock("../lib/providerSelection", () => ({
  readSelection: () => h.selection,
  isComplete: (s: { providerId: string; model: string }) => Boolean(s.providerId && s.model),
}));
vi.mock("../lib/probeRunner", () => ({
  readProfile: () => h.profile,
}));

const { acceptsGrammar, buildCompletionProvider, grammarVerdict } = await import("../lib/completionProvider");

beforeEach(() => {
  h.invoke.mockReset();
  h.invoke.mockResolvedValue({ blocks: [{ type: "text", text: "ok" }], stopReason: "endTurn", model: "m" });
  h.selection = { providerId: "ollama", model: "qwen2.5-coder:1.5b", baseUrl: "" };
  h.profile = undefined;
});

function sentRequest(): Record<string, unknown> {
  return (h.invoke.mock.calls[0][1] as { request: Record<string, unknown> }).request;
}

const GRAMMAR_REQUEST = { system: "s", messages: [{ role: "user" as const, text: "u" }], grammar: 'root ::= "OK"' };

describe("acceptsGrammar (the identity prior)", () => {
  it("names llama.cpp's server and the bundled copy of it, and nothing else", () => {
    expect(acceptsGrammar("llamacpp")).toBe(true);
    expect(acceptsGrammar("calcula-builtin")).toBe(true);
    for (const id of ["ollama", "lmstudio", "vllm", "openai", "anthropic", "openrouter", "custom-openai"]) {
      expect(acceptsGrammar(id), id).toBe(false);
    }
  });
});

describe("the verdict", () => {
  it("is identity when nothing was measured", () => {
    h.selection = { providerId: "llamacpp", model: "default", baseUrl: "" };
    expect(grammarVerdict()).toBe(true);
    h.selection = { providerId: "calcula-builtin", model: "qwen", baseUrl: "" };
    expect(grammarVerdict()).toBe(true);
    h.selection = { providerId: "ollama", model: "qwen", baseUrl: "" };
    expect(grammarVerdict(), "unmeasured and not known by identity: undecided, not false").toBeUndefined();
  });

  it("is the measurement when there is one, in both directions", () => {
    // A proxy in front of llama.cpp that strips the field: measured false wins.
    h.selection = { providerId: "llamacpp", model: "default", baseUrl: "" };
    h.profile = { honorsGrammar: false };
    expect(grammarVerdict()).toBe(false);
    // A runtime nobody named that answered the canary: measured true wins.
    h.selection = { providerId: "custom-openai", model: "m", baseUrl: "http://x" };
    h.profile = { honorsGrammar: true };
    expect(grammarVerdict()).toBe(true);
  });

  it("is undefined when no model is selected", () => {
    h.selection = { providerId: "", model: "", baseUrl: "" };
    expect(grammarVerdict()).toBeUndefined();
    expect(buildCompletionProvider().honorsGrammar()).toBeUndefined();
  });
});

describe("the completion provider", () => {
  it("forwards a grammar to llama.cpp by identity and reports that it honours one", async () => {
    h.selection = { providerId: "llamacpp", model: "default", baseUrl: "" };
    const p = buildCompletionProvider();
    expect(p.honorsGrammar()).toBe(true);
    await p.complete(GRAMMAR_REQUEST);
    expect(sentRequest().grammar).toBe('root ::= "OK"');
  });

  it("forwards a grammar to the bundled runtime", async () => {
    h.selection = { providerId: "calcula-builtin", model: "qwen2.5-coder-1.5b-instruct-q4_k_m", baseUrl: "" };
    await buildCompletionProvider().complete(GRAMMAR_REQUEST);
    expect(sentRequest().grammar).toBe('root ::= "OK"');
  });

  it("never forwards a grammar where the verdict is not true", async () => {
    for (const providerId of ["ollama", "openai", "anthropic"]) {
      h.invoke.mockClear();
      h.selection = { providerId, model: "m", baseUrl: "" };
      const p = buildCompletionProvider();
      expect(p.honorsGrammar(), providerId).not.toBe(true);
      await p.complete(GRAMMAR_REQUEST);
      expect(sentRequest().grammar, `${providerId} was sent a grammar`).toBeUndefined();
    }
  });

  it("withholds a grammar from a llama.cpp id that MEASURED false", async () => {
    h.selection = { providerId: "llamacpp", model: "behind-a-proxy", baseUrl: "" };
    h.profile = { honorsGrammar: false };
    const p = buildCompletionProvider();
    expect(p.honorsGrammar()).toBe(false);
    await p.complete(GRAMMAR_REQUEST);
    expect(sentRequest().grammar).toBeUndefined();
  });

  it("forwards a grammar to an unnamed runtime that MEASURED true", async () => {
    h.selection = { providerId: "custom-openai", model: "m", baseUrl: "http://x" };
    h.profile = { honorsGrammar: true };
    await buildCompletionProvider().complete(GRAMMAR_REQUEST);
    expect(sentRequest().grammar).toBe('root ::= "OK"');
  });

  it("forwards a response schema to every provider", async () => {
    h.selection = { providerId: "openai", model: "m", baseUrl: "" };
    await buildCompletionProvider().complete({
      system: "s", messages: [{ role: "user", text: "u" }],
      responseSchema: { name: "x", schema: { type: "object" } },
    });
    expect((sentRequest().responseSchema as { name: string }).name).toBe("x");
  });
});

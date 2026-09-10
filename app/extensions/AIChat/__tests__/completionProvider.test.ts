//! FILENAME: app/extensions/AIChat/__tests__/completionProvider.test.ts
// PURPOSE: The request-shaped seam forwards a GBNF grammar ONLY to a runtime
//          that honours one, and says so through `honorsGrammar()`.
// CONTEXT: 2026-09-10. Ollama's compatible endpoint ignores an unknown key;
//          a cloud vendor answers one with a 400 before any inference. A
//          grammar that leaked to the wrong provider would break every
//          design-query draft for that user with an error naming a field they
//          never typed. Identity-gated today; the bundled runtime brings a
//          probe that measures it instead.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  selection: { providerId: "ollama", model: "qwen2.5-coder:1.5b", baseUrl: "" },
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
  readProfile: () => undefined,
}));

const { acceptsGrammar, buildCompletionProvider } = await import("../lib/completionProvider");

beforeEach(() => {
  h.invoke.mockReset();
  h.invoke.mockResolvedValue({ blocks: [{ type: "text", text: "ok" }], stopReason: "endTurn", model: "m" });
  h.selection = { providerId: "ollama", model: "qwen2.5-coder:1.5b", baseUrl: "" };
});

function sentRequest(): Record<string, unknown> {
  return (h.invoke.mock.calls[0][1] as { request: Record<string, unknown> }).request;
}

describe("acceptsGrammar", () => {
  it("names llama.cpp's server and nothing else", () => {
    expect(acceptsGrammar("llamacpp")).toBe(true);
    for (const id of ["ollama", "lmstudio", "vllm", "openai", "anthropic", "openrouter", "custom-openai"]) {
      expect(acceptsGrammar(id), id).toBe(false);
    }
  });
});

describe("the completion provider", () => {
  it("forwards a grammar to llama.cpp and reports that it honours one", async () => {
    h.selection = { providerId: "llamacpp", model: "default", baseUrl: "" };
    const p = buildCompletionProvider();
    expect(p.honorsGrammar()).toBe(true);
    await p.complete({ system: "s", messages: [{ role: "user", text: "u" }], grammar: 'root ::= "OK"' });
    expect(sentRequest().grammar).toBe('root ::= "OK"');
  });

  it("never forwards a grammar to a runtime that has not been named as accepting one", async () => {
    for (const providerId of ["ollama", "openai", "anthropic"]) {
      h.invoke.mockClear();
      h.selection = { providerId, model: "m", baseUrl: "" };
      const p = buildCompletionProvider();
      expect(p.honorsGrammar(), providerId).toBe(false);
      await p.complete({ system: "s", messages: [{ role: "user", text: "u" }], grammar: 'root ::= "OK"' });
      expect(sentRequest().grammar, `${providerId} was sent a grammar`).toBeUndefined();
    }
  });

  it("forwards a response schema to every provider", async () => {
    h.selection = { providerId: "openai", model: "m", baseUrl: "" };
    await buildCompletionProvider().complete({
      system: "s", messages: [{ role: "user", text: "u" }],
      responseSchema: { name: "x", schema: { type: "object" } },
    });
    expect((sentRequest().responseSchema as { name: string }).name).toBe("x");
  });

  it("answers `undefined` for honorsGrammar when no model is selected", () => {
    h.selection = { providerId: "", model: "", baseUrl: "" };
    expect(buildCompletionProvider().honorsGrammar()).toBeUndefined();
  });
});

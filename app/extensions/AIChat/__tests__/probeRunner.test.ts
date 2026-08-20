//! FILENAME: app/extensions/AIChat/__tests__/probeRunner.test.ts
// PURPOSE: The picker's measured verdict — that it is cached per model, that a
//          partial run says so, and that a weak model is described as weak.
// CONTEXT: docs/design/local-model-script-authoring.md §4b, §10.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("../lib/aiChatBackend", () => ({ aiChatBackend: { invoke: (...a: unknown[]) => invoke(...a) } }));

const store = new Map<string, string>();
vi.mock("@api", () => ({
  getSetting: (ext: string, k: string, d: string) => store.get(`${ext}:${k}`) ?? d,
  setSetting: (ext: string, k: string, v: string) => void store.set(`${ext}:${k}`, String(v)),
}));

const { readProfile, writeProfile, runProbe, summarizeProfile } = await import("../lib/probeRunner");

const GOOD_REPLY = {
  blocks: [
    {
      type: "text",
      text: "```javascript\nexport function setup(context) {\n  context.expose('onClick', async () => {\n    await context.api.setCellValue(0, 0, 'hi');\n  });\n}\n```",
    },
  ],
  stopReason: "endTurn",
  model: "m",
};

beforeEach(() => {
  invoke.mockReset();
  store.clear();
  invoke.mockResolvedValue(GOOD_REPLY);
});

describe("the profile is remembered per model", () => {
  it("returns null before anything has been measured", () => {
    expect(readProfile("ollama", "qwen")).toBeNull();
  });

  it("round-trips a measured profile", async () => {
    const profile = await runProbe({ providerId: "ollama", model: "qwen" });
    expect(profile.tasksTotal).toBeGreaterThan(0);
    const read = readProfile("ollama", "qwen");
    expect(read?.model).toBe("qwen");
    expect(read?.canaryScore).toBe(profile.canaryScore);
  });

  it("keys on provider AND model, so two models never share a score", async () => {
    await runProbe({ providerId: "ollama", model: "qwen" });
    expect(readProfile("ollama", "llama")).toBeNull();
    expect(readProfile("openai", "qwen")).toBeNull();
  });

  it("treats a corrupt entry as never-probed rather than crashing the picker", () => {
    writeProfile({
      providerId: "p", model: "m", contextTokens: 8192, decodeTokensPerSec: 1,
      emitsFencedCode: true, canaryScore: 1, tasksScored: 1, tasksTotal: 1,
      measuredAt: "2026-08-20T00:00:00.000Z",
    });
    store.set("calcula.ai-chat:profile:p:m", "{not json");
    expect(readProfile("p", "m")).toBeNull();
  });
});

describe("the probe drives the real provider command", () => {
  it("asks for a completion per canary task, with no tools", async () => {
    const profile = await runProbe({ providerId: "ollama", model: "qwen" });
    expect(invoke).toHaveBeenCalledTimes(profile.tasksTotal);
    const [command, args] = invoke.mock.calls[0];
    expect(command).toBe("ai_chat_complete");
    expect((args as any).request.providerId).toBe("ollama");
    expect((args as any).request.model).toBe("qwen");
    expect((args as any).request.tools).toEqual([]);
  });

  it("reports progress so a minutes-long probe is not a frozen dialog", async () => {
    const seen: number[] = [];
    const profile = await runProbe({
      providerId: "p", model: "m",
      onProgress: (done) => seen.push(done),
    });
    expect(seen).toEqual(Array.from({ length: profile.tasksTotal }, (_, i) => i + 1));
  });

  it("stops when cancelled instead of finishing every task", async () => {
    let calls = 0;
    const profile = await runProbe({
      providerId: "p", model: "m",
      isCancelled: () => calls++ >= 2,
    });
    // Cancellation surfaces as a failed completion per task, which is NOT
    // counted as a model failure — so a cancelled probe reports a partial run.
    expect(profile.tasksScored).toBeLessThan(profile.tasksTotal);
  });
});

describe("the summary is honest about what it measured", () => {
  const profile = (over: Partial<Parameters<typeof summarizeProfile>[0] & object> = {}) => ({
    providerId: "ollama", model: "m", contextTokens: 8192, decodeTokensPerSec: 20,
    emitsFencedCode: true, canaryScore: 0.9, tasksScored: 12, tasksTotal: 12,
    measuredAt: "2026-08-20T10:00:00.000Z", ...over,
  });

  it("says so when nothing has been measured", () => {
    expect(summarizeProfile(null)).toBe("Not tested yet.");
  });

  it("names the measurement date, because a profile outlives the model file", () => {
    expect(summarizeProfile(profile())).toContain("measured 2026-08-20");
  });

  it("flags a partial run rather than passing it off as complete", () => {
    const text = summarizeProfile(profile({ tasksScored: 5 }));
    expect(text).toContain("Only 5 of 12 tasks completed");
    expect(text).toContain("partial");
  });

  it("says plainly that a weak model is weak", () => {
    // §10: a silent quality drop makes the user blame the product rather than
    // the model they chose.
    expect(summarizeProfile(profile({ canaryScore: 0.2 }))).toMatch(/struggles/);
  });

  it("does not cry wolf about a strong one", () => {
    expect(summarizeProfile(profile({ canaryScore: 0.95 }))).not.toMatch(/struggles/);
  });
});

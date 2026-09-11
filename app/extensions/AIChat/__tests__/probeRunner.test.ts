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

const { readProfile, writeProfile, runProbe, summarizeProfile, TOOL_SURFACE_REFUSED, GRAMMAR_CANARY } =
  await import("../lib/probeRunner");
const { TOOLS } = await import("../lib/chatTools");

/**
 * The pre-flight completions sent before the canary run:
 *   1. plain, no tools           — is the provider reachable at all?
 *   2. carrying the real surface — does it accept OUR tool schemas?
 *   3. one trivial tool, "call it" — does it emit a NATIVE tool call, or write
 *      one as text? (The failure a user hit on 2026-08-22.)
 *   4. a trivial reply SCHEMA    — does it honour structured output? This is
 *      what decides how the formula assistant asks it for anything.
 *   5. a trivial GRAMMAR         — does it honour one? This decides whether a
 *      drafted design query can name a column it was not shown.
 */
const PREFLIGHTS = 5;
/** The index of the native-tool-call probe among them. */
const TOOL_CALL_PROBE = 2;
/** The index of the reply-schema probe among them. */
const SCHEMA_PROBE = 3;
/** The index of the grammar probe among them. */
const GRAMMAR_PROBE = 4;

/** What `probeRunner` posts to `ai_chat_complete`, as far as these tests read it. */
interface CompleteArgs {
  request: {
    providerId?: string;
    model?: string;
    tools?: Array<{ inputSchema?: unknown }>;
    maxTokens?: number;
    grammar?: string;
  };
}

/** The second argument of the n-th `invoke` call, typed. */
function argsOf(call: number): CompleteArgs {
  return invoke.mock.calls[call][1] as CompleteArgs;
}

/** The calls a probe makes AFTER the pre-flight — i.e. the canary tasks. */
function canaryArgs(index: number): CompleteArgs {
  return argsOf(PREFLIGHTS + index);
}

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
    expect(invoke).toHaveBeenCalledTimes(PREFLIGHTS + profile.tasksTotal);
    expect(invoke.mock.calls[PREFLIGHTS][0]).toBe("ai_chat_complete");
    const args = canaryArgs(0);
    expect(args.request.providerId).toBe("ollama");
    expect(args.request.model).toBe("qwen");
    // The canary scores WRITTEN CODE. Handing it two dozen workbook tools would
    // measure something else entirely — a model that answers by calling
    // get_sheet_summary instead of emitting a fenced script is not a model that
    // failed the task. The tool surface is proved separately, below.
    expect(args.request.tools).toEqual([]);
  });

  it("measures whether the model honours a reply schema", async () => {
    // Asked with a SCHEMA and no tools, because the two capabilities are
    // independent: a runtime can emit native tool calls and ignore
    // `response_format`, or the reverse. Bundling them into one probe would
    // report a verdict about whichever happened to fail first.
    await runProbe({ providerId: "ollama", model: "qwen" });
    const args = argsOf(SCHEMA_PROBE);
    const schema = (args.request as { responseSchema?: { name?: string; schema?: unknown } })
      .responseSchema;
    expect(schema, "the schema probe must actually send a schema").toBeTruthy();
    expect(schema?.name).toBe("probe_answer");
    expect(args.request.tools).toEqual([]);
  });

  it("measures whether the runtime honours a GRAMMAR, with a question the grammar forbids answering", async () => {
    await runProbe({ providerId: "ollama", model: "qwen" });
    const args = argsOf(GRAMMAR_PROBE);
    expect(args.request.grammar, "the grammar probe must actually send a grammar").toBe(GRAMMAR_CANARY);
    expect(args.request.tools).toEqual([]);
    // GOOD_REPLY is a fenced script, not "OK": this runtime ignored the grammar.
    expect(readProfile("ollama", "qwen")?.honorsGrammar).toBe(false);
  });

  it("records true only for a reply that is exactly the grammar's one legal string", async () => {
    invoke.mockImplementation(async (_cmd: string, args: CompleteArgs) => {
      if (args.request.grammar) {
        return { blocks: [{ type: "text", text: "OK" }], stopReason: "endTurn", model: "m" };
      }
      return GOOD_REPLY;
    });
    const profile = await runProbe({ providerId: "llamacpp", model: "default" });
    expect(profile.honorsGrammar).toBe(true);
    expect(summarizeProfile(profile)).toContain("honours a reply grammar");
  });

  it("records FALSE when the server refuses the field, and NO verdict on a transport failure", async () => {
    // A cloud vendor: the plain pre-flight succeeds, the grammar request is a 400.
    invoke.mockImplementation(async (_cmd: string, args: CompleteArgs) => {
      if (args.request.grammar) throw new Error('OpenAI error 400: {"error":"Unrecognized request argument supplied: grammar"}');
      return GOOD_REPLY;
    });
    expect((await runProbe({ providerId: "openai", model: "gpt" })).honorsGrammar).toBe(false);
    // A dropped connection on that one request says nothing about the runtime.
    invoke.mockImplementation(async (_cmd: string, args: CompleteArgs) => {
      if (args.request.grammar) throw new Error("error sending request: connection reset");
      return GOOD_REPLY;
    });
    expect((await runProbe({ providerId: "openai", model: "gpt" })).honorsGrammar, "undecided, not false").toBeUndefined();
  });

  it("measures whether the model emits a NATIVE tool call", async () => {
    // The gap that let the reported bug through: the probe sent `tools: []`,
    // scored `emitsFencedCode` — which is TRUE for essentially every model and
    // is exactly the behaviour that breaks the chat — and called it healthy.
    const profile = await runProbe({ providerId: "ollama", model: "qwen" });
    const probeCall = argsOf(TOOL_CALL_PROBE);
    expect(probeCall.request.tools, "the probe must carry a tool to call").toHaveLength(1);
    // GOOD_REPLY is text only, so this model writes rather than emits.
    expect(profile.emitsNativeToolCalls).toBe(false);
    expect(readProfile("ollama", "qwen")?.emitsNativeToolCalls).toBe(false);
  });

  it("records true when the model does emit one", async () => {
    invoke.mockImplementation((_cmd: string, args: CompleteArgs) => {
      const tools = args.request.tools ?? [];
      if (tools.length === 1) {
        return Promise.resolve({
          blocks: [{ type: "toolUse", id: "c1", name: "probe_ping", input: {} }],
          stopReason: "toolUse", model: "m",
        });
      }
      return Promise.resolve(GOOD_REPLY);
    });
    const profile = await runProbe({ providerId: "ollama", model: "qwen" });
    expect(profile.emitsNativeToolCalls).toBe(true);
  });

  it("is ADVISORY: a model that fails it still gets a full profile", async () => {
    // A false negative must never lock out a model that works — Calcula now
    // recovers a textual call, so this is a warning, not a gate.
    const profile = await runProbe({ providerId: "ollama", model: "qwen" });
    expect(profile.emitsNativeToolCalls).toBe(false);
    expect(profile.tasksTotal).toBeGreaterThan(0);
    expect(profile.canaryScore).toBeGreaterThanOrEqual(0);
    expect(summarizeProfile(profile)).toContain("did NOT emit a native tool call");
  });

  it("records NO verdict when the probe request itself failed", async () => {
    // A transport blip must not be reported as "this model cannot call tools".
    let n = 0;
    invoke.mockImplementation((_cmd: string, args: CompleteArgs) => {
      n++;
      if ((args.request.tools ?? []).length === 1 && (args.request.tools ?? []).length !== TOOLS.length) {
        return Promise.reject(new Error("connection reset"));
      }
      return Promise.resolve(GOOD_REPLY);
    });
    const profile = await runProbe({ providerId: "ollama", model: "qwen" });
    expect(n).toBeGreaterThan(0);
    expect(profile.emitsNativeToolCalls, "undecided, not false").toBeUndefined();
    expect(summarizeProfile(profile)).not.toContain("did NOT emit");
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
      // Offset by the pre-flight, which polls the same flag: cancelling during
      // it would abort before a single task ran, which is a different case from
      // the partial run this test is about.
      isCancelled: () => calls++ >= PREFLIGHTS + 2,
    });
    // Cancellation surfaces as a failed completion per task, which is NOT
    // counted as a model failure — so a cancelled probe reports a partial run.
    expect(profile.tasksScored).toBeLessThan(profile.tasksTotal);
  });
});

describe("the probe proves the TOOL SURFACE, not just the model", () => {
  // §4b calls this probe "the only honest answer to 'will this model work for
  // Calcula?'". Until 2026-08-22 it sent `tools: []`, so it could not answer
  // that question at all: a running Ollama rejected every real chat message
  // (`cube_kpi` declared `enum: [1, 2, 3]`, which Ollama decodes into a Go
  // []string) while "Test this model" reported the model as perfectly healthy.
  // The chat sends every tool on every turn; a probe that sends none is
  // measuring a payload the product never produces.

  /** The first non-string enum member in a schema, or null. Ollama's rule. */
  function nonStringEnumMember(node: unknown): unknown {
    if (node === null || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = nonStringEnumMember(item);
        if (hit !== null) return hit;
      }
      return null;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.enum)) {
      const bad = obj.enum.find((v) => typeof v !== "string");
      if (bad !== undefined) return bad;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k === "enum") continue;
      const hit = nonStringEnumMember(v);
      if (hit !== null) return hit;
    }
    return null;
  }

  const OLLAMA_400 =
    'Ollama error 400: {"error":{"message":"json: cannot unmarshal number into Go struct ' +
    'field .tools.function.parameters.properties.enum of type string","type":"invalid_request_error"}}';

  /**
   * A backend double that decodes tool schemas the way Ollama does.
   *
   * Modelled on the REAL failure rather than on a generic throw: the whole point
   * is that the request dies at JSON-decode time, before inference, so a double
   * that fails for some other reason would prove nothing about this bug.
   */
  function ollamaLike(): void {
    invoke.mockImplementation(async (_cmd: string, args: CompleteArgs) => {
      for (const t of args.request.tools ?? []) {
        if (nonStringEnumMember(t.inputSchema) !== null) throw new Error(OLLAMA_400);
      }
      return GOOD_REPLY;
    });
  }

  it("sends the real tool surface in a pre-flight, before any canary task", async () => {
    await runProbe({ providerId: "ollama", model: "qwen" });
    const plain = argsOf(0);
    const withTools = argsOf(1);
    // Plain first: it is what makes the diagnosis a deduction rather than a
    // guess. Without it, a failure cannot be pinned on the tools.
    expect(plain.request.tools).toEqual([]);
    // ...and the second carries the surface VERBATIM. A trimmed or synthetic
    // copy would pass while the payload the chat actually sends still failed.
    expect(withTools.request.tools).toEqual(TOOLS);
    // Non-vacuity: `toEqual` against an empty surface would pass while proving
    // nothing about the payload the chat sends.
    expect(TOOLS.length).toBeGreaterThan(20);
  });

  it("the Ollama double has teeth (it rejects a numeric enum)", async () => {
    // Proved before it is relied upon: a double that accepted everything would
    // make the regression test below pass without testing anything.
    ollamaLike();
    await expect(
      invoke("ai_chat_complete", {
        request: { tools: [{ inputSchema: { properties: { p: { type: "integer", enum: [1, 2, 3] } } } }] },
      }),
    ).rejects.toThrow(/cannot unmarshal number/);
    // ...and it must reach a NESTED enum too, the way the real decoder does.
    await expect(
      invoke("ai_chat_complete", {
        request: {
          tools: [{ inputSchema: { properties: { a: { items: { properties: { p: { enum: [7] } } } } } } }],
        },
      }),
    ).rejects.toThrow(/cannot unmarshal number/);
  });

  it("today's tool surface survives an Ollama-strict provider end to end", async () => {
    // The regression, run through the REAL pre-flight against a decoder with the
    // real rule. This is what would have failed on 2026-08-22.
    ollamaLike();
    const profile = await runProbe({ providerId: "ollama", model: "qwen" });
    expect(profile.tasksScored).toBe(profile.tasksTotal);
  });

  it("names the tool surface when tools are the only thing that changed", async () => {
    // Plain request accepted, tools-laden one refused => the tools did it.
    let seen = 0;
    invoke.mockImplementation(async (_cmd: string, args: CompleteArgs) => {
      seen++;
      if ((args.request.tools ?? []).length > 0) throw new Error(OLLAMA_400);
      return GOOD_REPLY;
    });
    await expect(runProbe({ providerId: "ollama", model: "qwen" })).rejects.toThrow(
      TOOL_SURFACE_REFUSED,
    );
    // The server's own words are kept: the user needs the field name to fix it.
    await expect(runProbe({ providerId: "ollama", model: "qwen" })).rejects.toThrow(
      /cannot unmarshal number/,
    );
    // ...and it gave up at the SECOND pre-flight rather than burning a dozen
    // completions — the tool-surface refusal is fatal, so the native-tool-call,
    // schema and grammar probes after it never run either. Two calls per
    // attempt, two attempts.
    const CALLS_BEFORE_REFUSAL = 2;
    expect(seen).toBe(CALLS_BEFORE_REFUSAL * 2);
  });

  it("banks NO profile for a model whose tools were refused", async () => {
    invoke.mockImplementation(async (_cmd: string, args: CompleteArgs) => {
      if ((args.request.tools ?? []).length > 0) throw new Error(OLLAMA_400);
      return GOOD_REPLY;
    });
    await expect(runProbe({ providerId: "ollama", model: "qwen" })).rejects.toThrow();
    expect(
      readProfile("ollama", "qwen"),
      "a stored verdict for a model that never ran is the same lie in a more convincing shape",
    ).toBeNull();
  });

  it("blames the endpoint, NOT the tool surface, when nothing answers at all", async () => {
    // The deduction has to work in both directions. A runtime that is simply
    // down must not send the user hunting through JSON schemas.
    invoke.mockRejectedValue(new Error("error sending request: connection refused"));
    const failure = runProbe({ providerId: "ollama", model: "qwen" });
    await expect(failure).rejects.toThrow(/connection refused/);
    await expect(runProbe({ providerId: "ollama", model: "qwen" })).rejects.not.toThrow(
      TOOL_SURFACE_REFUSED,
    );
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

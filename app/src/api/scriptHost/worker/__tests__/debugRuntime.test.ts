//! FILENAME: app/src/api/scriptHost/worker/__tests__/debugRuntime.test.ts
// PURPOSE: The in-realm pause machine. The properties that matter are safety
//          properties: a pause always ends, a stop always resumes, and a region
//          the host is waiting on (a render) can never suspend.

import { describe, it, expect, vi, afterEach } from "vitest";
import { createDebugRuntime, parseStack } from "../debugRuntime";
import { DEBUG_GLOBAL, instrumentForDebug } from "../debugInstrument";
import { DEBUG_SNAPSHOT_MIN_INTERVAL_MS, type W2H } from "../../protocol";

function make(breakpoints: number[] = [], pauseOnEntry = false) {
  const posted: W2H[] = [];
  const rt = createDebugRuntime({ breakpoints, pauseOnEntry }, (m) => posted.push(m));
  const noLocals = () => [];
  return { rt, posted, noLocals };
}

describe("debug runtime — pausing", () => {
  it("runs straight through a line with no breakpoint", async () => {
    const { rt, posted, noLocals } = make([10]);
    await rt.h(5, noLocals);
    expect(posted).toEqual([]);
  });

  it("suspends at a breakpoint and resumes on continue", async () => {
    const { rt, posted, noLocals } = make([7]);
    let resumed = false;
    const pending = Promise.resolve(rt.h(7, noLocals)).then(() => {
      resumed = true;
    });
    await Promise.resolve();
    expect(posted.some((m) => m.t === "debugPaused")).toBe(true);
    expect(rt.isPaused()).toBe(true);
    expect(resumed).toBe(false);

    rt.control("continue");
    await pending;
    expect(resumed).toBe(true);
    expect(rt.isPaused()).toBe(false);
    expect(posted.some((m) => m.t === "debugResumed")).toBe(true);
  });

  it("reports the line, reason and locals of the pause", async () => {
    const { rt, posted } = make([12]);
    const pending = Promise.resolve(
      rt.h(12, () => [{ name: "total", type: "number", value: "42" }]),
    );
    await Promise.resolve();
    const paused = posted.find((m) => m.t === "debugPaused");
    expect(paused && paused.t === "debugPaused" && paused.state.line).toBe(12);
    expect(paused && paused.t === "debugPaused" && paused.state.reason).toBe("breakpoint");
    expect(paused && paused.t === "debugPaused" && paused.state.variables).toEqual([
      { name: "total", type: "number", value: "42" },
    ]);
    rt.control("continue");
    await pending;
  });

  it("pauses at the very next yield point after stepInto", async () => {
    const { rt, posted, noLocals } = make([3]);
    const first = Promise.resolve(rt.h(3, noLocals));
    await Promise.resolve();
    rt.control("stepInto");
    await first;

    const second = Promise.resolve(rt.h(99, noLocals)); // no breakpoint here
    await Promise.resolve();
    const pauses = posted.filter((m) => m.t === "debugPaused");
    expect(pauses.length).toBe(2);
    expect(pauses[1].t === "debugPaused" && pauses[1].state.line).toBe(99);
    expect(pauses[1].t === "debugPaused" && pauses[1].state.reason).toBe("step");
    rt.control("continue");
    await second;
  });

  it("pauses on entry when the session asked for it", async () => {
    const { rt, posted, noLocals } = make([], true);
    const pending = Promise.resolve(rt.h(1, noLocals));
    await Promise.resolve();
    const paused = posted.find((m) => m.t === "debugPaused");
    expect(paused && paused.t === "debugPaused" && paused.state.reason).toBe("entry");
    rt.control("continue");
    await pending;
  });

  it("joins a second execution to the existing pause instead of announcing a new line", async () => {
    const { rt, posted, noLocals } = make([4]);
    const a = Promise.resolve(rt.h(4, noLocals));
    await Promise.resolve();
    const b = Promise.resolve(rt.h(4, noLocals));
    await Promise.resolve();
    const pauses = posted.filter((m) => m.t === "debugPaused");
    // Same line, and the second report says one execution is waiting behind it.
    expect(pauses.length).toBe(2);
    expect(pauses[1].t === "debugPaused" && pauses[1].state.line).toBe(4);
    expect(pauses[1].t === "debugPaused" && pauses[1].state.waiting).toBe(1);
    rt.control("continue");
    await Promise.all([a, b]);
    expect(rt.isPaused()).toBe(false);
  });
});

describe("debug runtime — safety", () => {
  it("stop ALWAYS resumes every suspended execution", async () => {
    const { rt, noLocals } = make([2]);
    let resumedA = false;
    let resumedB = false;
    const a = Promise.resolve(rt.h(2, noLocals)).then(() => {
      resumedA = true;
    });
    await Promise.resolve();
    const b = Promise.resolve(rt.h(2, noLocals)).then(() => {
      resumedB = true;
    });
    await Promise.resolve();

    rt.control("stop");
    await Promise.all([a, b]);
    expect(resumedA && resumedB).toBe(true);
    expect(rt.isPaused()).toBe(false);
  });

  it("dispose resumes and disarms — later yield points do not suspend", async () => {
    const { rt, noLocals } = make([2]);
    const pending = Promise.resolve(rt.h(2, noLocals));
    await Promise.resolve();
    rt.dispose();
    await pending;
    // Every subsequent yield point must be a no-op.
    await rt.h(2, noLocals);
    expect(rt.isPaused()).toBe(false);
  });

  it("NEVER suspends inside a no-pause region (the render path)", async () => {
    const { rt, posted, noLocals } = make([8]);
    rt.beginNoPause();
    let resumed = false;
    await Promise.resolve(rt.h(8, noLocals)).then(() => {
      resumed = true;
    });
    rt.endNoPause();
    expect(resumed).toBe(true);
    expect(rt.isPaused()).toBe(false);
    // It still REPORTS the hit, so the breakpoint is not silently swallowed.
    expect(posted.some((m) => m.t === "debugSnapshot")).toBe(true);
  });

  it("suspends again once the no-pause region is left", async () => {
    const { rt, noLocals } = make([8]);
    rt.beginNoPause();
    await rt.h(8, noLocals);
    rt.endNoPause();
    const pending = Promise.resolve(rt.h(8, noLocals));
    await Promise.resolve();
    expect(rt.isPaused()).toBe(true);
    rt.control("stop");
    await pending;
  });
});

describe("debug runtime — synchronous-context hits", () => {
  it("reports a snapshot and keeps running", async () => {
    const { rt, posted } = make([6]);
    rt.s(6, () => [{ name: "x", type: "number", value: "1" }]);
    const snap = posted.find((m) => m.t === "debugSnapshot");
    expect(snap && snap.t === "debugSnapshot" && snap.state.line).toBe(6);
    expect(rt.isPaused()).toBe(false);
  });

  it("rate-limits a breakpoint inside a hot synchronous loop", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    try {
      const { rt, posted } = make([6]);
      for (let i = 0; i < 500; i++) rt.s(6, () => []);
      expect(posted.length).toBe(1);
      vi.setSystemTime(new Date(1_000_000 + DEBUG_SNAPSHOT_MIN_INTERVAL_MS + 1));
      rt.s(6, () => []);
      expect(posted.length).toBe(2);
      const second = posted[1];
      expect(second.t === "debugSnapshot" && second.state.suppressed).toBe(499);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("debug runtime — value previews", () => {
  it("stringifies inside the realm — no object graph crosses the channel", () => {
    const { rt } = make();
    const vars = rt.p([
      ["n", () => 42],
      ["s", () => "hello"],
      ["o", () => ({ a: 1, b: { deep: true } })],
      ["arr", () => [1, 2, 3]],
      ["f", () => function named() { /* body */ }],
      ["nul", () => null],
      ["und", () => undefined],
    ]);
    expect(vars.every((v) => typeof v.value === "string")).toBe(true);
    expect(vars.find((v) => v.name === "n")?.value).toBe("42");
    expect(vars.find((v) => v.name === "arr")?.type).toBe("array");
    // One shallow level only: the nested object collapses, so a deep or cyclic
    // graph can never be walked out of the realm through the debug channel.
    expect(vars.find((v) => v.name === "o")?.value).toBe("{a: 1, b: {…}}");
    expect(vars.find((v) => v.name === "f")?.value).toContain("named");
    expect(vars.find((v) => v.name === "nul")?.value).toBe("null");
  });

  it("caps a huge string instead of shipping it", () => {
    const { rt } = make();
    const [v] = rt.p([["big", () => "x".repeat(10_000)]]);
    expect(v.value.length).toBeLessThan(300);
  });

  it("survives a throwing getter", () => {
    const { rt } = make();
    const [v] = rt.p([
      ["boom", () => {
        throw new Error("nope");
      }],
    ]);
    expect(v.type).toBe("unavailable");
  });
});

describe("stack parsing", () => {
  it("keeps only the SCRIPT's frames, with the author's line numbers", () => {
    const stack = [
      "Error",
      // This runtime (worker bundle) — dropped.
      "    at Object.h (http://localhost/assets/worker-abc.js:900:11)",
      "    at hit (http://localhost/assets/worker-abc.js:880:3)",
      // The script's own blob module — kept.
      "    at validateRow (blob:null/abc:12:5)",
      "    at setup (blob:null/abc:40:9)",
      // Platform frames under it — dropped.
      "    at processTicksAndRejections (node:internal/process/task_queues:103:5)",
    ].join("\n");
    const frames = parseStack(stack);
    expect(frames.map((f) => f.functionName)).toEqual(["validateRow", "setup"]);
    expect(frames[0].line).toBe(12);
    expect(frames[1].line).toBe(40);
  });

  it("tolerates a missing stack", () => {
    expect(parseStack(undefined)).toEqual([]);
  });
});

// ============================================================================
// End to end: instrumented source + runtime, executed for real.
// ============================================================================

/** Run an instrumented source the way the worker's debug blob wrapper does. */
function runInstrumented(code: string, context: unknown): Promise<unknown> {
  const body =
    `return (async function(context) { ${code}\n` +
    `; return typeof setup === "function" ? setup(context) : undefined; })(arguments[0]);`;
  // eslint-disable-next-line no-new-func -- executing it is the point
  const fn = new Function(body) as (context: unknown) => Promise<unknown>;
  return fn(context);
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const SRC = [
  "function setup(context) {", // 1
  "  const a = 1;", // 2
  "  const b = a + 1;", // 3
  "  context.reached = b;", // 4
  "  return b;", // 5
  "}", // 6
].join("\n");

describe("instrumented source really pauses", () => {
  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>)[DEBUG_GLOBAL];
  });

  it("STOPS at the breakpoint (the statement after it has not run) and resumes", async () => {
    const posted: W2H[] = [];
    const rt = createDebugRuntime({ breakpoints: [4], pauseOnEntry: false }, (m) => posted.push(m));
    (globalThis as unknown as Record<string, unknown>)[DEBUG_GLOBAL] = rt;

    const result = instrumentForDebug(SRC);
    expect(result.ok).toBe(true);
    const context: { reached?: number } = {};
    const running = runInstrumented(result.code, context);
    await settle();

    expect(rt.isPaused()).toBe(true);
    const paused = posted.find((m) => m.t === "debugPaused");
    expect(paused && paused.t === "debugPaused" && paused.state.line).toBe(4);
    // The proof that this is a real pause and not a log: line 4 has NOT run.
    expect(context.reached).toBeUndefined();
    const names =
      paused && paused.t === "debugPaused" ? paused.state.variables.map((v) => v.name) : [];
    expect(names).toEqual(expect.arrayContaining(["a", "b", "context"]));

    rt.control("continue");
    await expect(running).resolves.toBe(2);
    expect(context.reached).toBe(2);
    expect(rt.isPaused()).toBe(false);
  });

  it("steps from one statement to the next", async () => {
    const posted: W2H[] = [];
    const rt = createDebugRuntime({ breakpoints: [2], pauseOnEntry: false }, (m) => posted.push(m));
    (globalThis as unknown as Record<string, unknown>)[DEBUG_GLOBAL] = rt;

    const result = instrumentForDebug(SRC);
    const context: { reached?: number } = {};
    const running = runInstrumented(result.code, context);
    await settle();

    rt.control("stepOver");
    await settle();
    rt.control("stepOver");
    await settle();

    const lines = posted
      .filter((m) => m.t === "debugPaused")
      .map((m) => (m as { state: { line: number } }).state.line);
    expect(lines).toEqual([2, 3, 4]);

    rt.control("continue");
    await expect(running).resolves.toBe(2);
  });

  it("a STOP mid-flight lets the script run to completion", async () => {
    const rt = createDebugRuntime({ breakpoints: [2] }, () => undefined);
    (globalThis as unknown as Record<string, unknown>)[DEBUG_GLOBAL] = rt;
    const result = instrumentForDebug(SRC);
    const context: { reached?: number } = {};
    const running = runInstrumented(result.code, context);
    await settle();
    expect(rt.isPaused()).toBe(true);

    rt.control("stop");

    await expect(running).resolves.toBe(2);
    expect(context.reached).toBe(2);
  });

  it("a breakpoint in a SYNCHRONOUS function reports but does not stop", async () => {
    const posted: W2H[] = [];
    const rt = createDebugRuntime({ breakpoints: [2] }, (m) => posted.push(m));
    (globalThis as unknown as Record<string, unknown>)[DEBUG_GLOBAL] = rt;
    const src = [
      "function helper(x) {", // 1
      "  const doubled = x * 2;", // 2 - synchronous body
      "  return doubled;", // 3
      "}", // 4
      "function setup(context) { return helper(21); }", // 5
    ].join("\n");
    const result = instrumentForDebug(src);
    expect(result.snapshotLines).toContain(2);

    const running = runInstrumented(result.code, {});
    await expect(running).resolves.toBe(42);
    expect(rt.isPaused()).toBe(false);
    const snap = posted.find((m) => m.t === "debugSnapshot");
    expect(snap && snap.t === "debugSnapshot" && snap.state.line).toBe(2);
    expect(posted.some((m) => m.t === "debugPaused")).toBe(false);
  });
});

describe("step over / into / out across a nested call", () => {
  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>)[DEBUG_GLOBAL];
  });

  const NESTED = [
    "async function inner(x) {", // 1
    "  const y = x + 1;", // 2
    "  return y;", // 3
    "}", // 4
    "async function setup(context) {", // 5
    "  const a = 1;", // 6
    "  const b = await inner(a);", // 7
    "  return b;", // 8
    "}", // 9
  ].join("\n");

  async function drive(actions: Array<"stepOver" | "stepInto" | "stepOut">): Promise<number[]> {
    const posted: W2H[] = [];
    const rt = createDebugRuntime({ breakpoints: [7], pauseOnEntry: false }, (m) => posted.push(m));
    (globalThis as unknown as Record<string, unknown>)[DEBUG_GLOBAL] = rt;
    const result = instrumentForDebug(NESTED);
    expect(result.ok).toBe(true);
    const running = runInstrumented(result.code, {});
    await settle();
    for (const action of actions) {
      rt.control(action);
      await settle();
    }
    rt.control("stop");
    await running;
    return posted
      .filter((m) => m.t === "debugPaused")
      .map((m) => (m as { state: { line: number } }).state.line);
  }

  it("step OVER does not descend into the callee", async () => {
    expect(await drive(["stepOver"])).toEqual([7, 8]);
  });

  it("step INTO stops on the callee's first statement", async () => {
    expect(await drive(["stepInto"])).toEqual([7, 2]);
  });

  it("step OUT returns to the caller", async () => {
    expect(await drive(["stepInto", "stepOut"])).toEqual([7, 2, 8]);
  });
});

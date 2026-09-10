// FILENAME: app/extensions/_shared/cli/__tests__/kernel.test.ts
// PURPOSE: The fused-CLI kernel under a toy TWO-domain fixture: vocabulary
//          merging, kind-uniqueness enforcement, dispatch rules, the
//          single-write-domain rule, per-domain batch strategies (true
//          rollback vs commit-partial), and undo/redo routing.

import { describe, expect, it } from "vitest";
import { createCliEngine } from "../engine";
import { CliError } from "../lex";
import { mergeVocabulary } from "../registry";
import type { CliDomain, CliIo } from "../registry";
import type { GenericCommand } from "../parse";

// ---------------------------------------------------------------------------
// Fixture: a "fruit" domain (rollback batches) and a "tool" domain
// (commit-partial batches), sharing the core verbs.
// ---------------------------------------------------------------------------

interface FixtureSession {
  log: string[];
  writable: boolean;
  failOn?: string;
}

function recordingIo(): CliIo & { out: string[] } {
  const out: string[] = [];
  return {
    out,
    print(text, cls) {
      out.push(`${cls ?? "out"}:${text}`);
    },
    clear() {
      out.push("cleared");
    },
  };
}

function makeDomain(
  id: string,
  kinds: string[],
  opts: {
    verbs?: Array<{ verb: string; kindless?: boolean }>;
    batch?: "rollback" | "keep" | null;
    undoRedo?: boolean;
    supportsWhere?: boolean;
  } = {},
): CliDomain<FixtureSession> {
  const label = id;
  return {
    id,
    label,
    kinds: kinds.map((k) => ({ kind: k })),
    verbs: opts.verbs,
    readVerbs: new Set(["ls", "show"]),
    async runRead(cmd: GenericCommand, s: FixtureSession) {
      s.log.push(`${id}:read:${cmd.verb}:${cmd.kind ?? "-"}`);
    },
    previewWrite(cmd: GenericCommand) {
      // Domain-specific verbs that are not writes (navigation-style).
      if (cmd.verb === "poke") return null;
      return { labels: [`${id} ${cmd.verb} ${cmd.kind ?? ""}`.trim()], wildcard: false };
    },
    async runWrite(cmd: GenericCommand, s: FixtureSession) {
      if (s.failOn === cmd.raw) throw new CliError(`boom on '${cmd.raw}'`, cmd.line);
      s.log.push(`${id}:write:${cmd.verb}:${cmd.kind ?? "-"}`);
    },
    supportsWhere: opts.supportsWhere ?? false,
    isWritable(s: FixtureSession) {
      return s.writable;
    },
    batch:
      opts.batch === null
        ? null
        : {
            confirmNote: opts.batch === "rollback" ? "all-or-nothing" : "kept-partial-note",
            async begin(s: FixtureSession) {
              s.log.push(`${id}:batchBegin`);
            },
            async end(s: FixtureSession) {
              s.log.push(`${id}:batchEnd`);
            },
            async onError(s: FixtureSession) {
              s.log.push(`${id}:batchError`);
              return opts.batch === "rollback" ? "rolled-back" : "kept-partial";
            },
          },
    undoRedo: opts.undoRedo
      ? {
          async undo(s: FixtureSession, io: CliIo) {
            s.log.push(`${id}:undo`);
            io.print("Undone.", "info");
          },
          async redo(s: FixtureSession, io: CliIo) {
            s.log.push(`${id}:redo`);
            io.print("Redone.", "info");
          },
        }
      : undefined,
    helpText(topic: string[]) {
      if (topic.length === 0) return `${id} help`;
      return kinds.includes(topic[0]) ? `${id} help ${topic[0]}` : null;
    },
  };
}

function makeEngine(overrides: {
  fruitBatch?: "rollback" | "keep" | null;
  toolBatch?: "rollback" | "keep" | null;
  failOn?: string;
  writable?: boolean;
} = {}) {
  const fruitSession: FixtureSession = {
    log: [],
    writable: overrides.writable ?? true,
    failOn: overrides.failOn,
  };
  const toolSession: FixtureSession = {
    log: [],
    writable: overrides.writable ?? true,
    failOn: overrides.failOn,
  };
  const fruit = makeDomain("fruit", ["apple", "pear"], {
    batch: overrides.fruitBatch ?? "rollback",
    undoRedo: true,
    verbs: [{ verb: "peel", kindless: true }, { verb: "poke", kindless: true }],
  });
  const tool = makeDomain("tool", ["hammer"], {
    batch: overrides.toolBatch ?? "keep",
  });
  const engine = createCliEngine(
    [
      { domain: fruit, session: fruitSession },
      { domain: tool, session: toolSession },
    ],
    "fruit",
  );
  return { engine, fruitSession, toolSession };
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe("vocabulary merging", () => {
  it("merges core verbs, domain verbs, kinds and aliases", () => {
    const v = mergeVocabulary([
      { id: "a", kinds: [{ kind: "apple", aliases: ["app"] }], verbs: [{ verb: "peel" }] },
      { id: "b", kinds: [{ kind: "hammer" }] },
    ]);
    expect(v.verbAliases["rm"]).toBe("delete");
    expect(v.verbAliases["peel"]).toBe("peel");
    expect(v.kindAliases["app"]).toBe("apple");
    expect(v.kinds).toEqual(["apple", "hammer"]);
    expect(v.kindless.has("undo")).toBe(true);
  });

  it("throws when two domains claim one kind", () => {
    expect(() =>
      mergeVocabulary([
        { id: "a", kinds: [{ kind: "table" }] },
        { id: "b", kinds: [{ kind: "table" }] },
      ]),
    ).toThrow(/globally unique/);
  });
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe("dispatch", () => {
  it("routes by kind to the owning domain", async () => {
    const { engine, fruitSession, toolSession } = makeEngine();
    const io = recordingIo();
    await engine.executeRun(engine.planRun("add hammer H1"), io);
    expect(toolSession.log).toContain("tool:write:add:hammer");
    expect(fruitSession.log).toHaveLength(0);
  });

  it("routes a kindless domain verb to its only contributor", async () => {
    const { engine, fruitSession } = makeEngine();
    await engine.executeRun(engine.planRun("peel"), recordingIo());
    expect(fruitSession.log).toContain("fruit:write:peel:-");
  });

  it("routes a core verb without a kind to the default domain", async () => {
    const { engine, fruitSession } = makeEngine();
    await engine.executeRun(engine.planRun("ls"), recordingIo());
    expect(fruitSession.log).toContain("fruit:read:ls:-");
  });

  it("undo/redo route to the default domain and must run alone", async () => {
    const { engine, fruitSession } = makeEngine();
    const io = recordingIo();
    await engine.executeRun(engine.planRun("undo"), io);
    expect(fruitSession.log).toContain("fruit:undo");
    expect(io.out).toContain("info:Undone.");
    expect(() => engine.planRun("undo\nadd apple A")).toThrow(/on their own/);
  });

  it("help composes across domains (other domain's kind topic answered)", async () => {
    const { engine } = makeEngine();
    const io = recordingIo();
    await engine.executeRun(engine.planRun("help hammer"), io);
    expect(io.out[0]).toContain("tool help hammer");
    const io2 = recordingIo();
    await engine.executeRun(engine.planRun("help"), io2);
    expect(io2.out[0]).toContain("fruit help");
  });
});

// ---------------------------------------------------------------------------
// The single-write-domain rule
// ---------------------------------------------------------------------------

describe("mixed-domain writes", () => {
  it("refuses a run mixing writes from two domains at PLAN time", () => {
    const { engine } = makeEngine();
    expect(() => engine.planRun("add apple A\nadd hammer H")).toThrow(
      /cannot mix fruit edits and tool edits/,
    );
  });

  it("allows reads from one domain alongside writes in another", () => {
    const { engine } = makeEngine();
    const plan = engine.planRun("ls hammers\nadd apple A\nadd apple B");
    expect(plan.writeLabels).toHaveLength(2);
    expect(plan.writeBinding?.domain.id).toBe("fruit");
  });

  it("non-write domain verbs (previewWrite null) never claim the write slot", () => {
    const { engine } = makeEngine();
    const plan = engine.planRun("poke\nadd hammer H");
    expect(plan.writeBinding?.domain.id).toBe("tool");
  });
});

// ---------------------------------------------------------------------------
// Batching + confirm metadata
// ---------------------------------------------------------------------------

describe("batching", () => {
  it("multi-write runs open and close the owning domain's batch", async () => {
    const { engine, fruitSession } = makeEngine();
    const plan = engine.planRun("add apple A\nadd apple B");
    expect(plan.needsConfirm).toBe(true);
    expect(plan.confirmNote).toBe("all-or-nothing");
    const { ok } = await engine.executeRun(plan, recordingIo());
    expect(ok).toBe(true);
    expect(fruitSession.log[0]).toBe("fruit:batchBegin");
    expect(fruitSession.log[fruitSession.log.length - 1]).toBe("fruit:batchEnd");
  });

  it("a single write is not batched and needs no confirm", async () => {
    const { engine, fruitSession } = makeEngine();
    const plan = engine.planRun("add apple A");
    expect(plan.needsConfirm).toBe(false);
    await engine.executeRun(plan, recordingIo());
    expect(fruitSession.log).toEqual(["fruit:write:add:apple"]);
  });

  it("a rollback strategy prints the all-rolled-back message on error", async () => {
    const { engine } = makeEngine({ failOn: "add apple B" });
    const io = recordingIo();
    const { ok } = await engine.executeRun(engine.planRun("add apple A\nadd apple B"), io);
    expect(ok).toBe(false);
    expect(io.out.some((l) => l.includes("rolled back"))).toBe(true);
  });

  it("a commit-partial strategy reports the kept edits honestly", async () => {
    const { engine, toolSession } = makeEngine({ failOn: "add hammer H2" });
    const io = recordingIo();
    const { ok } = await engine.executeRun(
      engine.planRun("add hammer H1\nadd hammer H2"),
      io,
    );
    expect(ok).toBe(false);
    expect(toolSession.log).toContain("tool:batchError");
    expect(io.out.some((l) => l.includes("kept as ONE undo step"))).toBe(true);
  });

  it("a read-only session never opens a batch", async () => {
    const { engine, fruitSession } = makeEngine({ writable: false });
    await engine.executeRun(engine.planRun("add apple A\nadd apple B"), recordingIo());
    expect(fruitSession.log).not.toContain("fruit:batchBegin");
  });

  it("errors carry their line number into the message", async () => {
    const { engine } = makeEngine({ failOn: "add apple B" });
    const io = recordingIo();
    await engine.executeRun(engine.planRun("add apple A\nadd apple B"), io);
    expect(io.out.some((l) => l.includes("line 2"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `where` — the fail-closed gate
// ---------------------------------------------------------------------------
// A `where` clause NARROWS a command. A domain that receives one it cannot
// evaluate does not run a narrower command — it runs the ORIGINAL, widened one.
// `delete measure * where folder="Archive"` becomes "delete every measure",
// reports success, and the confirmation card that should have listed three
// names lists three hundred. The kernel therefore refuses by DEFAULT and a
// domain must opt in.

describe("where clause gating", () => {
  function engineWith(supportsWhere: boolean) {
    const session: FixtureSession = { log: [], writable: true };
    const domain = makeDomain("fruit", ["apple", "pear"], { supportsWhere });
    return {
      engine: createCliEngine([{ domain, session }], "fruit"),
      session,
    };
  }

  it("refuses a clause when the domain has not opted in", () => {
    const { engine } = engineWith(false);
    expect(() => engine.planRun("delete apple * where colour=red")).toThrow(
      /`where` is not supported/,
    );
  });

  it("says WHY, so nobody removes the clause and reruns the widened command", () => {
    const { engine } = engineWith(false);
    try {
      engine.planRun("delete apple * where colour=red");
      throw new Error("should have thrown");
    } catch (e) {
      // The message has to warn that dropping the clause BROADENS the command;
      // "unsupported syntax" alone invites exactly the destructive retry.
      expect(String(e)).toMatch(/widen/i);
    }
  });

  it("lets the clause through once the domain opts in", () => {
    const { engine } = engineWith(true);
    expect(() => engine.planRun("delete apple * where colour=red")).not.toThrow();
  });

  it("never blocks a command with no clause", () => {
    const { engine } = engineWith(false);
    expect(() => engine.planRun("delete apple *")).not.toThrow();
  });
});

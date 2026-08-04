//! FILENAME: app/extensions/ScriptableObjects/lib/__tests__/liveModuleBuffer.test.ts
// PURPOSE: Pin the four rules that make "edits are live" safe rather than merely
//          convenient — debounce + coalescing, never writing unchanged bytes,
//          never letting transiently-broken text destroy the last good stored
//          version, and never rewriting the author's text on an idle pass.
// CONTEXT: These are the substance of the change, so they are tested here on the
//          engine directly instead of through a mounted editor: the interesting
//          cases (a write in flight while the author keeps typing, source that
//          does not compile) are hard to provoke reliably through a UI and
//          trivial to provoke here.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LiveModulePersister,
  LIVE_PERSIST_DEBOUNCE_MS,
  outcomeWroteNewBytes,
  type LivePersistOutcome,
} from "../liveModuleBuffer";
import type { ObjectScriptSaveGate } from "../authoringLanguage";

/** A gate that accepts JavaScript verbatim and refuses anything with "@@@". */
function plainGate(source: string): Promise<ObjectScriptSaveGate> {
  if (source.includes("@@@")) {
    return Promise.resolve({
      ok: false,
      detail: "Not saved — the script does not compile:\nLine 1:1 — Unexpected token (TS1109)",
      message: "The script does not compile: Unexpected token (line 1)",
    });
  }
  return Promise.resolve({ ok: true, javascript: source, transformed: false });
}

interface Harness {
  persister: LiveModulePersister;
  store: Map<string, string>;
  writes: string[];
  outcomes: Array<{ docId: string; outcome: LivePersistOutcome }>;
  /** Resolve the pending write, when the harness is built with a gated writer. */
  release: () => void;
}

function harness(options?: {
  gate?: (source: string, name: string) => Promise<ObjectScriptSaveGate>;
  slowWrites?: boolean;
}): Harness {
  const store = new Map<string, string>();
  const writes: string[] = [];
  const outcomes: Array<{ docId: string; outcome: LivePersistOutcome }> = [];
  // `slowWrites` holds every write open until `release()`; after that, writes
  // complete normally — so a test can watch what happens WHILE one is in flight.
  const blocked: Array<() => void> = [];
  let open = false;
  const persister = new LiveModulePersister({
    gate: options?.gate ?? ((source) => plainGate(source)),
    write: async (docId, javascript) => {
      writes.push(javascript);
      if (options?.slowWrites && !open) {
        await new Promise<void>((resolve) => {
          blocked.push(resolve);
        });
      }
      store.set(docId, javascript);
    },
    onOutcome: (docId, outcome) => outcomes.push({ docId, outcome }),
  });
  return {
    persister,
    store,
    writes,
    outcomes,
    release: () => {
      open = true;
      for (const resolve of blocked.splice(0)) resolve();
    },
  };
}

describe("LiveModulePersister — the idle debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the buffer through once the author stops typing", async () => {
    const h = harness();
    h.persister.track("m1", "Macro", "old");

    h.persister.note("m1", "Macro", "new source");
    expect(h.writes).toEqual([]); // not yet — this is the point of the window

    await vi.advanceTimersByTimeAsync(LIVE_PERSIST_DEBOUNCE_MS + 1);
    expect(h.store.get("m1")).toBe("new source");
    expect(h.writes).toEqual(["new source"]);
  });

  it("coalesces continuous typing into ONE write", async () => {
    const h = harness();
    h.persister.track("m1", "Macro", "");

    for (const text of ["a", "ab", "abc", "abcd"]) {
      h.persister.note("m1", "Macro", text);
      await vi.advanceTimersByTimeAsync(LIVE_PERSIST_DEBOUNCE_MS / 2);
    }
    await vi.advanceTimersByTimeAsync(LIVE_PERSIST_DEBOUNCE_MS + 1);

    expect(h.writes).toEqual(["abcd"]);
  });

  it("never writes text that is already stored", async () => {
    const h = harness();
    h.persister.track("m1", "Macro", "same");

    h.persister.note("m1", "Macro", "same");
    await vi.advanceTimersByTimeAsync(LIVE_PERSIST_DEBOUNCE_MS + 1);
    expect(h.writes).toEqual([]);

    // ...including after typing and undoing back to the stored text.
    h.persister.note("m1", "Macro", "different");
    h.persister.note("m1", "Macro", "same");
    await vi.advanceTimersByTimeAsync(LIVE_PERSIST_DEBOUNCE_MS + 1);
    expect(h.writes).toEqual([]);
  });

  it("a flush cancels the pending debounce rather than writing twice", async () => {
    const h = harness();
    h.persister.track("m1", "Macro", "old");
    h.persister.note("m1", "Macro", "typed");

    const outcome = await h.persister.flush("m1");
    expect(outcome.status).toBe("saved");
    await vi.advanceTimersByTimeAsync(LIVE_PERSIST_DEBOUNCE_MS + 1);
    expect(h.writes).toEqual(["typed"]);
  });

  it("forgets a deleted module rather than re-creating it from a stale timer", async () => {
    const h = harness();
    h.persister.track("m1", "Macro", "old");
    h.persister.note("m1", "Macro", "typed");
    h.persister.retain([]); // the listing says the module is gone

    await vi.advanceTimersByTimeAsync(LIVE_PERSIST_DEBOUNCE_MS + 1);
    expect(h.writes).toEqual([]);
  });
});

describe("LiveModulePersister — coalescing around an in-flight write", () => {
  it("never starts a second write while one is running, then catches up", async () => {
    const h = harness({ slowWrites: true });
    h.persister.track("m1", "Macro", "v0");

    // Write 1 starts and blocks inside the store.
    h.persister.note("m1", "Macro", "v1");
    const first = h.persister.flush("m1");
    await Promise.resolve();
    await Promise.resolve();
    expect(h.writes).toEqual(["v1"]);

    // The author keeps typing while it is in flight. No second write starts.
    h.persister.note("m1", "Macro", "v2");
    const second = h.persister.flush("m1");
    await Promise.resolve();
    expect(h.writes).toEqual(["v1"]);

    h.release();
    await first;
    await second;

    // Exactly one extra write, carrying the LATEST text — not one per edit.
    expect(h.writes).toEqual(["v1", "v2"]);
    expect(h.store.get("m1")).toBe("v2");
  });
});

describe("LiveModulePersister — text that does not compile", () => {
  it("keeps the last good stored version and reports the compiler error", async () => {
    const h = harness();
    h.persister.track("m1", "Macro", "function good() {}");
    await h.persister.flush("m1"); // nothing to do

    h.persister.note("m1", "Macro", "function broken( @@@");
    const outcome = await h.persister.flush("m1");

    expect(outcome.status).toBe("invalid");
    expect(outcome.status === "invalid" && outcome.detail).toContain("does not compile");
    // THE POINT: the store was not touched.
    expect(h.writes).toEqual([]);
    expect(h.persister.storedSource("m1")).toBe("function good() {}");
    expect(h.persister.hasUnsavedEdits("m1")).toBe(true);
  });

  it("recovers the moment the text compiles again", async () => {
    const h = harness();
    h.persister.track("m1", "Macro", "v0");
    h.persister.note("m1", "Macro", "@@@");
    expect((await h.persister.flush("m1")).status).toBe("invalid");

    h.persister.note("m1", "Macro", "v1");
    expect((await h.persister.flush("m1")).status).toBe("saved");
    expect(h.store.get("m1")).toBe("v1");
    expect(h.persister.hasUnsavedEdits("m1")).toBe(false);
  });

  it("reports a store that refuses the write, and does not claim the text is live", async () => {
    const store = new Map<string, string>();
    const persister = new LiveModulePersister({
      gate: (source) => plainGate(source),
      write: async () => {
        throw new Error("no backend");
      },
    });
    persister.track("m1", "Macro", "v0");
    persister.note("m1", "Macro", "v1");

    const outcome = await persister.flush("m1");
    expect(outcome.status).toBe("failed");
    expect(persister.storedSource("m1")).toBe("v0");
    expect(store.size).toBe(0);
  });
});

describe("LiveModulePersister — the idle pass never rewrites the author's text", () => {
  const compilingGate = (source: string): Promise<ObjectScriptSaveGate> =>
    Promise.resolve({
      ok: true,
      javascript: source.replace(": string", ""),
      transformed: source.includes(": string"),
    });

  it("DEFERS a TypeScript buffer on the idle path instead of storing other bytes", async () => {
    const h = harness({ gate: compilingGate });
    h.persister.track("m1", "Macro", "function f(a) {}");
    h.persister.note("m1", "Macro", "function f(a: string) {}");

    const idle = await h.persister.flush("m1", false);
    expect(idle.status).toBe("deferred");
    expect(h.writes).toEqual([]);
    expect(h.persister.storedSource("m1")).toBe("function f(a) {}");
  });

  it("compiles and stores on an explicit gesture, reporting the rewrite", async () => {
    const h = harness({ gate: compilingGate });
    h.persister.track("m1", "Macro", "function f(a) {}");
    h.persister.note("m1", "Macro", "function f(a: string) {}");

    const outcome = await h.persister.flush("m1", true);
    expect(outcome.status).toBe("compiled");
    expect(outcomeWroteNewBytes(outcome)).toBe(true);
    expect(h.store.get("m1")).toBe("function f(a) {}");
  });
});

describe("LiveModulePersister — baselines from elsewhere", () => {
  it("takes a fresh listing as the new stored baseline without touching the buffer", async () => {
    const h = harness();
    h.persister.track("m1", "Macro", "v0");
    h.persister.note("m1", "Macro", "mine");

    // Someone else saved the module while this window held an edit.
    h.persister.track("m1", "Macro", "theirs");
    expect(h.persister.storedSource("m1")).toBe("theirs");
    expect(h.persister.hasUnsavedEdits("m1")).toBe(true);

    await h.persister.flush("m1");
    expect(h.store.get("m1")).toBe("mine");
  });

  it("does not roll the baseline back underneath a write in flight", async () => {
    const h = harness({ slowWrites: true });
    h.persister.track("m1", "Macro", "v0");
    h.persister.note("m1", "Macro", "v1");
    const flush = h.persister.flush("m1");
    await Promise.resolve();
    await Promise.resolve();

    // A listing requested BEFORE the write started lands in the middle of it.
    h.persister.track("m1", "Macro", "v0");
    h.release();
    await flush;

    expect(h.persister.storedSource("m1")).toBe("v1");
    // ...and no redundant re-write of bytes the store already holds.
    expect(h.writes).toEqual(["v1"]);
  });
});

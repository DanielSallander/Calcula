//! FILENAME: app/extensions/AIChat/__tests__/authorJobs.test.ts
// PURPOSE: An authoring run must outlive the pane that started it, and must
//          publish enough progress that a slow local model never looks stuck.
// CONTEXT: 2026-08-24. The run lived in component state, so closing the task
//          pane abandoned a job that had already spent minutes of a CPU-bound
//          model's time — and the only progress it emitted was one line per
//          completed ROUND, which on a 7B is a blank screen for a minute or more
//          at a stretch.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const runAuthor = vi.fn();
vi.mock("../lib/authorRunner", () => ({ runAuthor: (...a: unknown[]) => runAuthor(...a) }));

const showToast = vi.fn();
vi.mock("@api", () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

const {
  startAuthorJob, cancelJob, subscribeToJobs, latestJob, runningJobs, allJobs,
  jobById, formatElapsed, shortIntent, __resetJobs,
} = await import("../lib/authorJobs");

const REQ = {
  intent: "colour each selected cell by its content",
  objectType: "button",
  providerId: "ollama",
  model: "qwen2.5:7b",
};

/** Let the job's internal async body run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  __resetJobs();
  runAuthor.mockReset();
  showToast.mockReset();
});

afterEach(() => __resetJobs());

describe("a job outlives whatever started it", () => {
  it("is registered synchronously and is immediately observable", () => {
    runAuthor.mockReturnValue(new Promise(() => {})); // never settles
    const id = startAuthorJob(REQ);
    // No await: a caller that had to wait would re-create the coupling this
    // module exists to remove.
    const job = jobById(id);
    expect(job?.state).toBe("running");
    expect(job?.intent).toBe(REQ.intent);
    expect(runningJobs()).toHaveLength(1);
  });

  it("keeps running when every subscriber has gone away", async () => {
    let finish: (v: unknown) => void = () => {};
    runAuthor.mockReturnValue(new Promise((r) => { finish = r; }));
    const unsub = subscribeToJobs(() => {});
    const id = startAuthorJob(REQ);

    // The pane closes.
    unsub();

    finish({ ok: true, source: "x", summary: "Done.", rounds: [], draftId: "draft-1" });
    await settle();

    expect(jobById(id)?.state, "the run must not have been abandoned").toBe("done");
    expect(jobById(id)?.result?.draftId).toBe("draft-1");
  });

  it("a subscriber attaching mid-run sees the CURRENT state", async () => {
    const phases: string[] = [];
    runAuthor.mockImplementation(async (r: { onPhase?: (p: string) => void }) => {
      r.onPhase?.("Writing the script");
      await Promise.resolve();
      return { ok: true, source: "x", summary: "Done.", rounds: [] };
    });
    const id = startAuthorJob(REQ);
    // Attaching AFTER the first phase already landed.
    subscribeToJobs(() => phases.push(jobById(id)!.phase));
    await settle();
    expect(jobById(id)!.steps.some((s) => s.text === "Writing the script")).toBe(true);
  });

  it("notifies subscribers as it progresses", async () => {
    let seen = 0;
    subscribeToJobs(() => { seen++; });
    runAuthor.mockImplementation(async (r: { onPhase?: (p: string) => void; onRound?: (x: unknown) => void }) => {
      r.onPhase?.("one");
      r.onPhase?.("two");
      r.onRound?.({ round: 0, ok: false, problems: ["nope"] });
      return { ok: true, source: "x", summary: "Done.", rounds: [] };
    });
    startAuthorJob(REQ);
    await settle();
    expect(seen, "start + 3 updates + completion, at least").toBeGreaterThanOrEqual(5);
  });

  it("a listener that unsubscribes during notification does not break the walk", async () => {
    // The set is copied before iteration; without that this throws.
    const off = subscribeToJobs(() => off());
    subscribeToJobs(() => {});
    runAuthor.mockResolvedValue({ ok: true, source: "", summary: "Done.", rounds: [] });
    expect(() => startAuthorJob(REQ)).not.toThrow();
    await settle();
  });
});

describe("progress is fine-grained enough to prove it is alive", () => {
  it("logs every phase, with the time it happened", async () => {
    runAuthor.mockImplementation(async (r: { onPhase?: (p: string, d?: string) => void }) => {
      r.onPhase?.("Loading Calcula's script API");
      r.onPhase?.("Writing the script with qwen2.5:7b (attempt 1 of 7)");
      r.onPhase?.("Running it against a copy of your workbook");
      return { ok: true, source: "x", summary: "Done.", rounds: [] };
    });
    const id = startAuthorJob(REQ);
    await settle();

    const texts = jobById(id)!.steps.map((s) => s.text);
    expect(texts).toContain("Loading Calcula's script API");
    expect(texts).toContain("Writing the script with qwen2.5:7b (attempt 1 of 7)");
    expect(texts).toContain("Running it against a copy of your workbook");
    // Every step is timestamped relative to the start, so a long gap is visible
    // AS a gap rather than as an absence of activity.
    for (const s of jobById(id)!.steps) expect(s.at).toBeGreaterThanOrEqual(0);
  });

  it("records rounds distinctly from phases, with their verdict", async () => {
    runAuthor.mockImplementation(async (r: { onRound?: (x: unknown) => void }) => {
      r.onRound?.({ round: 0, ok: false, problems: ["`context.formatCellBackgroundColor` is not part of the object-script API"] });
      r.onRound?.({ round: 1, ok: true, problems: [] });
      return { ok: true, source: "x", summary: "Done.", rounds: [] };
    });
    const id = startAuthorJob(REQ);
    await settle();

    const job = jobById(id)!;
    expect(job.rounds).toHaveLength(2);
    const bad = job.steps.find((s) => s.kind === "roundBad");
    expect(bad?.text).toContain("Attempt 1");
    expect(bad?.detail).toContain("formatCellBackgroundColor");
    expect(job.steps.some((s) => s.kind === "roundOk" && s.text.includes("Attempt 2"))).toBe(true);
  });

  it("exposes the CURRENT phase for the status bar", async () => {
    let mid: (v: unknown) => void = () => {};
    runAuthor.mockImplementation((r: { onPhase?: (p: string) => void }) => {
      r.onPhase?.("Writing the script with qwen2.5:7b (attempt 3 of 7)");
      return new Promise((res) => { mid = res; });
    });
    const id = startAuthorJob(REQ);
    await Promise.resolve();
    expect(jobById(id)!.phase).toBe("Writing the script with qwen2.5:7b (attempt 3 of 7)");
    mid({ ok: true, source: "", summary: "Done.", rounds: [] });
    await settle();
  });
});

describe("finishing", () => {
  it("marks done and toasts, because the user is elsewhere", async () => {
    runAuthor.mockResolvedValue({ ok: true, source: "x", summary: "Wrote it.", rounds: [], draftId: "draft-9" });
    const id = startAuthorJob(REQ);
    await settle();
    expect(jobById(id)!.state).toBe("done");
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(String(showToast.mock.calls[0][0])).toContain("ready for review");
  });

  it("says so when the model could not do it, without calling it a crash", async () => {
    runAuthor.mockResolvedValue({ ok: false, source: "half", summary: "Gave up.", rounds: [] });
    const id = startAuthorJob(REQ);
    await settle();
    const job = jobById(id)!;
    expect(job.state).toBe("done");
    expect(job.result?.ok).toBe(false);
    expect(String(showToast.mock.calls[0][0])).toContain("Could not write");
  });

  it("records a thrown failure as failed, with the message", async () => {
    runAuthor.mockRejectedValue(new Error("Ollama error 500"));
    const id = startAuthorJob(REQ);
    await settle();
    expect(jobById(id)!.state).toBe("failed");
    expect(jobById(id)!.error).toContain("Ollama error 500");
  });

  it("clears itself out of the running set whichever way it ends", async () => {
    runAuthor.mockRejectedValue(new Error("boom"));
    startAuthorJob(REQ);
    await settle();
    expect(runningJobs()).toHaveLength(0);
  });
});

describe("stopping", () => {
  it("asks the run to stop and reports it as cancelled, not failed", async () => {
    let isCancelled = () => false;
    let finish: (v: unknown) => void = () => {};
    runAuthor.mockImplementation((r: { isCancelled: () => boolean }) => {
      isCancelled = r.isCancelled;
      return new Promise((_res, rej) => { finish = () => rej(new Error("cancelled")); });
    });
    const id = startAuthorJob(REQ);
    expect(isCancelled()).toBe(false);

    cancelJob(id);
    expect(isCancelled(), "the running pipeline must see the flag").toBe(true);

    finish(undefined);
    await settle();
    const job = jobById(id)!;
    expect(job.state).toBe("cancelled");
    expect(job.error, "the user's own decision is not an error").toBeUndefined();
    expect(showToast, "and it does not nag about it").not.toHaveBeenCalled();
  });

  it("ignores a stop for a job that already finished", async () => {
    runAuthor.mockResolvedValue({ ok: true, source: "", summary: "Done.", rounds: [] });
    const id = startAuthorJob(REQ);
    await settle();
    expect(() => cancelJob(id)).not.toThrow();
    expect(jobById(id)!.state).toBe("done");
  });

  it("does not leak the cancel flag into the NEXT job", async () => {
    runAuthor.mockImplementation((r: { isCancelled: () => boolean }) =>
      Promise.reject(new Error("cancelled")).catch((e) => { throw e; }));
    const first = startAuthorJob(REQ);
    cancelJob(first);
    await settle();

    let secondFlag = () => true;
    runAuthor.mockImplementation((r: { isCancelled: () => boolean }) => {
      secondFlag = r.isCancelled;
      return Promise.resolve({ ok: true, source: "", summary: "Done.", rounds: [] });
    });
    startAuthorJob(REQ);
    await settle();
    expect(secondFlag(), "a recycled flag would stop the next job before it began").toBe(false);
  });
});

describe("several jobs", () => {
  it("keeps them all, newest first, with the latest addressable", async () => {
    runAuthor.mockResolvedValue({ ok: true, source: "", summary: "Done.", rounds: [] });
    startAuthorJob({ ...REQ, intent: "first" });
    await settle();
    const second = startAuthorJob({ ...REQ, intent: "second" });
    await settle();

    expect(allJobs().map((j) => j.intent)).toEqual(["second", "first"]);
    expect(latestJob()!.id).toBe(second);
  });
});

describe("formatting", () => {
  it("reads durations at a human scale", () => {
    expect(formatElapsed(900)).toBe("0s");
    expect(formatElapsed(4200)).toBe("4s");
    expect(formatElapsed(125_000)).toBe("2m 05s");
    expect(formatElapsed(-1)).toBe("");
  });

  it("trims an intent to fit a one-line toast", () => {
    expect(shortIntent("short one")).toBe("short one");
    const long = shortIntent("a".repeat(80));
    expect(long).toHaveLength(40);
    expect(long.endsWith("...")).toBe(true);
    expect(shortIntent("has\n  newlines   and spaces")).toBe("has newlines and spaces");
  });
});

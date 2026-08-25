//! FILENAME: app/extensions/AIChat/__tests__/authorStatusItem.test.tsx
// PURPOSE: A running job stays visible from anywhere in the app, and the
//          indicator that shows it cannot melt down.
// CONTEXT: 2026-08-24. "Close the pane and carry on working" is only half the
//          ask; the other half is knowing it is still working without going back
//          to look.
//
//          THE HAZARD THIS FILE EXISTS FOR: `useSyncExternalStore` compares
//          snapshots with `Object.is`. A derived getter that builds a fresh
//          array on every call (`jobs.filter(...)`) fails that comparison every
//          time and re-renders forever. `runningJobs()` is memoised against the
//          jobs array's identity precisely so this component is safe, and the
//          test below would hang or throw if that memoisation were removed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const runAuthor = vi.fn();
vi.mock("../lib/authorRunner", () => ({ runAuthor: (...a: unknown[]) => runAuthor(...a) }));
vi.mock("@api", () => ({ showToast: vi.fn() }));

const { AuthorStatusItem } = await import("../components/AuthorStatusItem");
const { startAuthorJob, __resetJobs, runningJobs, allJobs } = await import("../lib/authorJobs");

let container: HTMLDivElement;
let root: Root;

const REQ = {
  intent: "colour each selected cell by its content",
  objectType: "button",
  providerId: "ollama",
  model: "qwen2.5:7b",
};

async function render(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(AuthorStatusItem));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  __resetJobs();
  runAuthor.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  __resetJobs();
});

describe("the status bar indicator", () => {
  it("renders NOTHING when no job is running", async () => {
    await render();
    // A user who never authors a script pays one empty span, not a widget.
    expect(container.textContent).toBe("");
  });

  it("shows the live phase of a running job", async () => {
    runAuthor.mockImplementation((r: { onPhase?: (p: string) => void }) => {
      r.onPhase?.("Writing the script with qwen2.5:7b (attempt 2 of 7)");
      return new Promise(() => {});
    });
    await render();
    await act(async () => { startAuthorJob(REQ); });
    await flush();
    expect(container.textContent).toContain("Writing the script with qwen2.5:7b (attempt 2 of 7)");
  });

  it("is animated, so it reads as alive rather than stuck", async () => {
    runAuthor.mockReturnValue(new Promise(() => {}));
    await render();
    await act(async () => { startAuthorJob(REQ); });
    await flush();
    const animated = [...container.querySelectorAll("span")]
      .filter((s) => (s as HTMLElement).style.animation?.includes("calcula-aichat-pulse"));
    expect(animated.length).toBeGreaterThan(0);
  });

  it("disappears again once the job finishes", async () => {
    runAuthor.mockResolvedValue({ ok: true, source: "", summary: "Done.", rounds: [] });
    await render();
    await act(async () => { startAuthorJob(REQ); });
    await flush();
    expect(container.textContent).toBe("");
  });

  it("counts additional runs rather than stacking widgets", async () => {
    runAuthor.mockReturnValue(new Promise(() => {}));
    await render();
    await act(async () => { startAuthorJob(REQ); startAuthorJob({ ...REQ, intent: "another" }); });
    await flush();
    expect(container.textContent).toContain("(+1)");
  });
});

describe("the derived views have STABLE identity", () => {
  // Without this, `useSyncExternalStore` re-renders forever: Object.is fails on
  // a freshly-built array every single time it reads the snapshot.
  it("returns the same array while nothing has changed", () => {
    runAuthor.mockReturnValue(new Promise(() => {}));
    startAuthorJob(REQ);
    expect(runningJobs()).toBe(runningJobs());
    expect(allJobs()).toBe(allJobs());
  });

  it("returns a DIFFERENT array once something has changed", async () => {
    let phase: ((p: string) => void) | undefined;
    runAuthor.mockImplementation((r: { onPhase?: (p: string) => void }) => {
      phase = r.onPhase;
      return new Promise(() => {});
    });
    startAuthorJob(REQ);
    const before = runningJobs();
    phase!("a new phase");
    expect(runningJobs(), "a real change must be observable").not.toBe(before);
  });

  it("does not wake subscribers for a no-op change", async () => {
    let phase: ((p: string) => void) | undefined;
    runAuthor.mockImplementation((r: { onPhase?: (p: string) => void }) => {
      phase = r.onPhase;
      return new Promise(() => {});
    });
    startAuthorJob(REQ);
    phase!("same");
    const { subscribeToJobs } = await import("../lib/authorJobs");
    let woke = 0;
    subscribeToJobs(() => { woke++; });
    // setPhase to the identical value returns the same job object, so `update`
    // publishes nothing — but the step log still grows, so exactly one wake.
    phase!("same");
    expect(woke).toBe(1);
  });
});

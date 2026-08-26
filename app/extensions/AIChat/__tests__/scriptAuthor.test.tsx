//! FILENAME: app/extensions/AIChat/__tests__/scriptAuthor.test.tsx
// PURPOSE: The guided screen: two fields, a background job you can walk away
//          from, and a draft you can click through to.
// CONTEXT: 2026-08-24. The failure that motivated the screen is TOOL SELECTION,
//          not code generation, so it deletes the choice. The failure that
//          motivated the JOB is that the run lived in component state — closing
//          the pane abandoned minutes of a slow model's work — and that the only
//          progress shown was one line per round, which reads as a hang.
//
//          `authorJobs` is REAL here and `authorRunner` is doubled: the seam
//          worth testing is screen <-> job store, and the store's own suite
//          proves the rest.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const runAuthor = vi.fn();
vi.mock("../lib/authorRunner", () => ({ runAuthor: (...a: unknown[]) => runAuthor(...a) }));

const openDraftInEditor = vi.fn(async () => {});
const showToast = vi.fn();
vi.mock("@api", () => ({
  showToast: (...a: unknown[]) => showToast(...a),
  hasScriptEditorProvider: () => true,
  requireScriptEditorProvider: () => ({ openDraftInEditor, openMacroInEditor: async () => {} }),
}));

const { ScriptAuthor } = await import("../components/ScriptAuthor");
const { __resetJobs } = await import("../lib/authorJobs");

const GOOD_SOURCE = "export function setup(context) {\n  context.onClick(async () => {});\n}";

let container: HTMLDivElement;
let root: Root;

function btn(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")]
    .find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function click(text: string): Promise<void> {
  const b = btn(text);
  if (!b) throw new Error(`no button matching "${text}" — have: ${[...container.querySelectorAll("button")].map((x) => x.textContent).join(", ")}`);
  await act(async () => {
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

async function type(value: string): Promise<void> {
  const ta = container.querySelector("textarea")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(ta, value);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function render(props: Record<string, unknown> = {}): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(ScriptAuthor, {
      providerId: "ollama", model: "qwen2.5:7b", baseUrl: "http://127.0.0.1:11434/v1",
      onBackToChat: () => {},
      ...props,
    } as never));
  });
}

beforeEach(() => {
  __resetJobs();
  runAuthor.mockReset();
  openDraftInEditor.mockClear();
  showToast.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  __resetJobs();
});

describe("the screen asks only what the model cannot infer", () => {
  it("offers every object type the backend will accept", async () => {
    await render();
    const options = [...container.querySelectorAll("option")].map((o) => o.getAttribute("value"));
    expect(options).toContain("button");
    expect(options).toContain("sheet");
    expect(options.length).toBeGreaterThanOrEqual(16);
  });

  it("prefills from the chat's offer", async () => {
    await render({ initialIntent: "colour each selected cell", initialObjectType: "sheet" });
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("colour each selected cell");
    expect((container.querySelector("select") as HTMLSelectElement).value).toBe("sheet");
  });

  it("will not start on an empty intent", async () => {
    await render();
    expect(btn("Author the script")?.disabled).toBe(true);
  });

  it("passes the user's answers straight through to the pipeline", async () => {
    runAuthor.mockReturnValue(new Promise(() => {}));
    await render({ initialObjectType: "sheet" });
    await type("colour each selected cell by its content");
    await click("Author the script");
    const req = runAuthor.mock.calls[0][0] as Record<string, unknown>;
    expect(req.intent).toBe("colour each selected cell by its content");
    expect(req.objectType).toBe("sheet");
    expect(req.model).toBe("qwen2.5:7b");
  });
});

describe("the run is visible, and looks alive", () => {
  /** Start a run and hold it open at a given phase. */
  async function startAndHold(phase = "Writing the script with qwen2.5:7b (attempt 1 of 7)") {
    runAuthor.mockImplementation((r: { onPhase?: (p: string, d?: string) => void }) => {
      r.onPhase?.(phase);
      return new Promise(() => {});
    });
    await render();
    await type("colour the cells");
    await click("Author the script");
  }

  it("shows the current phase, not just finished rounds", async () => {
    await startAndHold();
    expect(container.textContent).toContain("Writing the script with qwen2.5:7b (attempt 1 of 7)");
  });

  it("renders an animated indicator while running", async () => {
    await startAndHold();
    // A CSS animation, so it keeps moving even while the main thread is busy —
    // which is exactly when a static label would look wedged.
    const animated = [...container.querySelectorAll("span")]
      .filter((s) => (s as HTMLElement).style.animation?.includes("calcula-aichat-pulse"));
    expect(animated.length, "the dot must actually be animated").toBeGreaterThan(0);
    expect(document.getElementById("calcula-aichat-activity-keyframes")).toBeTruthy();
  });

  it("logs each step with the time it happened", async () => {
    runAuthor.mockImplementation((r: { onPhase?: (p: string) => void; onRound?: (x: unknown) => void }) => {
      r.onPhase?.("Loading Calcula's script API");
      r.onPhase?.("Running it against a copy of your workbook");
      r.onRound?.({ round: 0, ok: false, problems: ["`context.formatCellBackgroundColor` is not part of the object-script API"] });
      return new Promise(() => {});
    });
    await render();
    await type("colour the cells");
    await click("Author the script");

    expect(container.textContent).toContain("Loading Calcula's script API");
    expect(container.textContent).toContain("Running it against a copy of your workbook");
    expect(container.textContent).toContain("Attempt 1");
    expect(container.textContent).toContain("formatCellBackgroundColor");
  });

  it("tells the user they can leave", async () => {
    await startAndHold();
    expect(container.textContent).toContain("close this pane and carry on working");
  });

  it("collapses the form once a run exists, so the log gets the room", async () => {
    // The reported layout problem: the form, the log and the result all fought
    // for one scrolling column and the result ended up in a two-line slot.
    await startAndHold();
    expect(container.querySelector("textarea"), "the form is out of the way").toBeNull();
    // ...and what was asked for is still on screen, compactly.
    expect(container.textContent).toContain("colour the cells");
    expect(container.textContent).toContain("attached to a button");
  });

  it("can be stopped", async () => {
    await startAndHold();
    await click("Stop");
    expect(container.textContent).toContain("Stop requested.");
  });
});

describe("a job survives the screen", () => {
  it("re-attaches to a run in flight when the pane is re-opened", async () => {
    // THE point of the job store. Unmounting is the pane closing.
    let phase: ((p: string) => void) | undefined;
    runAuthor.mockImplementation((r: { onPhase?: (p: string) => void }) => {
      phase = r.onPhase;
      r.onPhase?.("Writing the script with qwen2.5:7b (attempt 1 of 7)");
      return new Promise(() => {});
    });
    await render();
    await type("colour the cells");
    await click("Author the script");

    await act(async () => root.unmount());
    container.remove();

    // ...work continues while nothing is watching...
    phase!("Running it against a copy of your workbook");

    await render();
    await flush();
    expect(container.textContent, "the re-opened pane shows the CURRENT phase")
      .toContain("Running it against a copy of your workbook");
    expect(runAuthor, "and it was never restarted").toHaveBeenCalledTimes(1);
  });
});

describe("what the user gets at the end", () => {
  it("shows a click-through to the editor once the draft is queued", async () => {
    runAuthor.mockResolvedValue({ ok: true, source: GOOD_SOURCE, summary: "Wrote it in 2 rounds.", rounds: [], unexercisedHooks: [], draftId: "draft-abc123" });
    await render();
    await type("colour the cells");
    await click("Author the script");

    expect(container.textContent).toContain("Wrote it in 2 rounds.");
    await click("Open in Object Script Editor");
    expect(openDraftInEditor).toHaveBeenCalledWith("draft-abc123");
  });

  it("still shows the best attempt when authoring failed", async () => {
    runAuthor.mockResolvedValue({
      ok: false, source: "export function setup(context) { /* half-written */ }",
      summary: "qwen2.5:7b repeated the same mistake on 3 attempts in a row.", rounds: [], unexercisedHooks: [],
    });
    await render();
    await type("something hard");
    await click("Author the script");
    expect(container.textContent).toContain("repeated the same mistake");
    expect(container.textContent).toContain("Best attempt (not accepted)");
    expect(container.textContent).toContain("half-written");
  });

  it("separates 'the script is broken' from 'it could not be queued'", async () => {
    runAuthor.mockResolvedValue({
      ok: true, source: GOOD_SOURCE, summary: "Done.", rounds: [], unexercisedHooks: [],
      deliveryError: "Script Security refused",
    });
    await render();
    await type("colour the cells");
    await click("Author the script");
    expect(container.textContent).toContain("could not be queued for review");
    expect(container.textContent).toContain("Script Security refused");
    expect(container.textContent).toContain("Done.");
  });

  it("surfaces a pipeline failure rather than a silent dead end", async () => {
    runAuthor.mockRejectedValue(new Error("Ollama error 500"));
    await render();
    await type("colour the cells");
    await click("Author the script");
    expect(container.textContent).toContain("Ollama error 500");
  });

  it("offers a fresh start that brings the form back", async () => {
    runAuthor.mockResolvedValue({ ok: true, source: GOOD_SOURCE, summary: "Done.", rounds: [], unexercisedHooks: [], draftId: "d1" });
    await render();
    await type("colour the cells");
    await click("Author the script");
    expect(container.querySelector("textarea")).toBeNull();

    await click("New script");
    expect(container.querySelector("textarea"), "the form comes back").toBeTruthy();
    expect(btn("Start again")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// T17 — the amber box says the RIGHT thing about a zero
// ---------------------------------------------------------------------------

describe("what the result card says about a run that changed nothing", () => {
  async function showResult(over: Record<string, unknown>): Promise<void> {
    runAuthor.mockResolvedValue({
      ok: true, source: GOOD_SOURCE, summary: "Done.", rounds: [],
      unexercisedHooks: [], ...over,
    });
    await render();
    await type("colour the cells");
    await click("Author the script");
  }

  it("blames the preview, not the user's data, when a handler was never fired", async () => {
    await showResult({ changedNothing: true, unexercisedHooks: ["onSelectionChange"] });
    expect(container.textContent).toContain("onSelectionChange");
    expect(container.textContent).toContain("never fired");
    expect(
      container.textContent,
      "the open sheet had nothing to do with it",
    ).not.toContain("nothing for it to act on");
  });

  it("still says the old sentence when nothing was left unfired", async () => {
    // The control: without it the assertion above passes for a card that
    // renders no warning at all.
    await showResult({ changedNothing: true, unexercisedHooks: [] });
    expect(container.textContent).toContain("nothing for it to act on");
  });

  it("shows what the script DECLARES that it does not appear to use", async () => {
    await showResult({
      notices: ["`net.fetch` is declared but no call requiring it was found."],
    });
    expect(container.textContent).toContain("Check what it declares");
    expect(container.textContent).toContain("net.fetch");
  });

  it("shows no declaration box when the ladder raised no notice", async () => {
    await showResult({ notices: [] });
    expect(container.textContent).not.toContain("Check what it declares");
  });
});

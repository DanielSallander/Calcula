//! FILENAME: app/extensions/AIChat/__tests__/scriptAuthor.test.tsx
// PURPOSE: The guided path: two fields, the built pipeline, and a draft the user
//          can click through to.
// CONTEXT: 2026-08-24. Three rounds of trying to make free chat produce a script
//          on a local model established that the failure is TOOL SELECTION, not
//          code generation. This screen deletes the choice. `authorScript` (M7)
//          already did everything below it and had zero UI callers.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// --- Backend -----------------------------------------------------------------
const invoke = vi.fn();
vi.mock("../lib/aiChatBackend", () => ({
  aiChatBackend: { invoke: (...a: unknown[]) => invoke(...a) },
}));

// --- The pipeline, doubled ----------------------------------------------------
// `authorScript` is proved by its own suite and the eval corpus; what THIS file
// tests is that the screen drives it with the right inputs and renders what it
// returns. The real one needs a Worker realm jsdom does not have.
const authorScript = vi.fn();
const previewObjectScript = vi.fn(async () => ({ ok: true, applicable: true, totalChanges: 3 }));
vi.mock("@api/scriptHost/scriptAuthoring", () => ({ authorScript: (...a: unknown[]) => authorScript(...a) }));
vi.mock("@api/scriptHost/scriptPreview", () => ({ previewObjectScript: (...a: unknown[]) => previewObjectScript(...(a as [])) }));
vi.mock("@api/scriptHost/modelProfile", () => ({
  planFor: (p: { canaryScore: number }) => ({
    tier: p.canaryScore >= 0.5 ? "standard" : "assisted",
    surfaceBudgetTokens: 3686,
    repairRounds: p.canaryScore >= 0.5 ? 3 : 6,
    rationale: "test plan",
  }),
}));

const openDraftInEditor = vi.fn(async () => {});
const store = new Map<string, string>();
vi.mock("@api", () => ({
  getSetting: (ext: string, k: string, d: string) => store.get(`${ext}:${k}`) ?? d,
  setSetting: (ext: string, k: string, v: string) => void store.set(`${ext}:${k}`, String(v)),
  hasScriptEditorProvider: () => true,
  requireScriptEditorProvider: () => ({ openDraftInEditor, openMacroInEditor: async () => {} }),
}));

const { ScriptAuthor } = await import("../components/ScriptAuthor");

// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

const GOOD_SOURCE = "export function setup(context) {\n  context.onClick(async () => {});\n}";

function btn(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
}

async function click(text: string): Promise<void> {
  const b = btn(text);
  if (!b) throw new Error(`no button matching "${text}"`);
  await act(async () => {
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
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
  invoke.mockReset();
  authorScript.mockReset();
  openDraftInEditor.mockClear();
  store.clear();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
});

describe("the guided screen asks only what the model cannot infer", () => {
  it("offers every object type the backend will accept", async () => {
    await render();
    const options = [...container.querySelectorAll("option")].map((o) => o.getAttribute("value"));
    // The one input that decides which API slice the model is shown, and which
    // draftGate currently has to guess silently.
    expect(options).toContain("button");
    expect(options).toContain("sheet");
    expect(options).toContain("chart");
    expect(options.length).toBeGreaterThanOrEqual(16);
  });

  it("prefills from the chat's offer", async () => {
    await render({ initialIntent: "colour each selected cell by its content", initialObjectType: "sheet" });
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value)
      .toBe("colour each selected cell by its content");
    expect((container.querySelector("select") as HTMLSelectElement).value).toBe("sheet");
  });

  it("will not author an empty intent", async () => {
    await render();
    expect(btn("Author the script")?.disabled).toBe(true);
  });
});

describe("it drives the pipeline with the user's answers", () => {
  it("passes the intent, the object type, and a dry run at the MOUNTED tier", async () => {
    authorScript.mockResolvedValue({ ok: true, source: GOOD_SOURCE, report: { ok: true, findings: [] }, attempts: [], summary: "Done." });
    invoke.mockResolvedValue('Drafted object script "x" (id=draft-abc123) for button.');

    await render();
    await type("colour each selected cell by its content");
    await click("Author the script");

    expect(authorScript).toHaveBeenCalledTimes(1);
    const req = authorScript.mock.calls[0][0] as Record<string, unknown>;
    expect(req.intent).toBe("colour each selected cell by its content");
    expect(req.objectType).toBe("button");
    // Without this a script that mounts cleanly and does nothing scores as a
    // success — the quietest failure this system has.
    expect(req.expectsWrites).toBe(true);
    expect(req.dryRun, "L3 must be wired, or the loop cannot see a runtime failure").toBeTypeOf("function");

    // And the dry run must judge it at the tier a draft actually mounts at.
    await (req.dryRun as (s: string) => Promise<unknown>)(GOOD_SOURCE);
    expect(previewObjectScript.mock.calls[0][0]).toMatchObject({ tier: "restricted", objectType: "button" });
  });

  it("uses the ASSISTED plan for a model nobody has probed", async () => {
    authorScript.mockResolvedValue({ ok: true, source: GOOD_SOURCE, report: { ok: true, findings: [] }, attempts: [], summary: "Done." });
    invoke.mockResolvedValue("(id=draft-abc123)");
    await render();
    await type("do a thing");
    await click("Author the script");
    const plan = (authorScript.mock.calls[0][0] as { plan: { tier: string; repairRounds: number } }).plan;
    expect(plan.tier).toBe("assisted");
    expect(plan.repairRounds, "an unmeasured local model gets the most repair rounds").toBe(6);
  });

  it("delivers through the ordinary review path, not a second route", async () => {
    authorScript.mockResolvedValue({ ok: true, source: GOOD_SOURCE, report: { ok: true, findings: [] }, attempts: [], summary: "Done." });
    invoke.mockResolvedValue('Drafted object script "x" (id=draft-abc123) for button.');
    await render();
    await type("colour the cells");
    await click("Author the script");

    // draft_object_script through ai_chat_run_tool: same Rust store, same audit
    // entry, same "NOT mounted" invariant as any other draft.
    const call = invoke.mock.calls.find((c) => c[0] === "ai_chat_run_tool");
    expect(call, "the draft must go out the same door as every other one").toBeTruthy();
    expect((call![1] as { name: string }).name).toBe("draft_object_script");
    expect((call![1] as { input: { source: string } }).input.source).toBe(GOOD_SOURCE);
  });
});

describe("what the user sees", () => {
  it("shows a click-through to the editor once the draft is queued", async () => {
    authorScript.mockResolvedValue({ ok: true, source: GOOD_SOURCE, report: { ok: true, findings: [] }, attempts: [], summary: "Wrote it in 2 rounds." });
    invoke.mockResolvedValue('Drafted object script "x" (id=draft-abc123) for button.');
    await render();
    await type("colour the cells");
    await click("Author the script");

    expect(container.textContent).toContain("Wrote it in 2 rounds.");
    await click("Open in Object Script Editor");
    expect(openDraftInEditor).toHaveBeenCalledWith("draft-abc123");
  });

  it("reports each repair round as it lands, not only at the end", async () => {
    authorScript.mockImplementation(async (req: { onAttempt?: (r: number, rep: unknown) => void }) => {
      req.onAttempt?.(0, { findings: [{ severity: "error", message: "api.setCellValu does not exist" }] });
      req.onAttempt?.(1, { findings: [] });
      return { ok: true, source: GOOD_SOURCE, report: { ok: true, findings: [] }, attempts: [], summary: "Done." };
    });
    invoke.mockResolvedValue("(id=draft-abc123)");
    await render();
    await type("colour the cells");
    await click("Author the script");

    expect(container.textContent).toContain("round 1");
    expect(container.textContent).toContain("api.setCellValu does not exist");
    expect(container.textContent).toContain("round 2");
  });

  it("still shows the best attempt when authoring FAILED", async () => {
    // A script that is 90% right is worth showing; the editor is where a person
    // fixes the rest.
    authorScript.mockResolvedValue({
      ok: false, source: "export function setup(context) { /* half-written */ }",
      report: { ok: false, findings: [] }, attempts: [], summary: "Gave up after 6 rounds.",
    });
    await render();
    await type("something hard");
    await click("Author the script");
    expect(container.textContent).toContain("Gave up after 6 rounds.");
    expect(container.textContent).toContain("Best attempt (not accepted)");
    expect(container.textContent).toContain("half-written");
    // Nothing was queued for review.
    expect(invoke.mock.calls.some((c) => c[0] === "ai_chat_run_tool")).toBe(false);
  });

  it("separates 'the script is broken' from 'it could not be queued'", async () => {
    authorScript.mockResolvedValue({ ok: true, source: GOOD_SOURCE, report: { ok: true, findings: [] }, attempts: [], summary: "Done." });
    invoke.mockRejectedValue(new Error("Script Security refused"));
    await render();
    await type("colour the cells");
    await click("Author the script");
    expect(container.textContent).toContain("could not be queued for review");
    expect(container.textContent).toContain("Script Security refused");
    // The summary still reports success, because authoring DID succeed.
    expect(container.textContent).toContain("Done.");
  });

  it("surfaces a pipeline failure rather than a silent dead end", async () => {
    authorScript.mockRejectedValue(new Error("Ollama error 500"));
    await render();
    await type("colour the cells");
    await click("Author the script");
    expect(container.textContent).toContain("Ollama error 500");
  });
});

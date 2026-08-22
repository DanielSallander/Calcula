//! FILENAME: app/extensions/AIChat/__tests__/modelPickerSavedSelection.test.tsx
// PURPOSE: That re-opening the picker on an ALREADY-SAVED selection arrives with
//          that provider's models listed — and does not, for a first-run user,
//          start reaching out to providers nobody has chosen.
// CONTEXT: This shipped and was found in live use on 2026-08-22. The Model
//          select is `disabled: busy || models.length === 0`, and `models` was
//          only ever filled by the Provider dropdown's `onChange`. "Change model"
//          MOUNTS A FRESH PICKER, so a returning user got their provider restored
//          and correctly labelled ("Ollama — running") above a GREYED-OUT model
//          select — with their saved model rendering as "Select…", because no
//          matching <option> existed to hold the value. The only way out was to
//          switch provider and switch back, since re-picking the same value fires
//          no change event at all.
//
//          The bug is a fresh mount forgetting persisted state, so the tests are
//          written as MOUNTS, not as clicks: anything that drives the provider
//          dropdown first is exercising the path that already worked.
//
//          §11.1's three first-run rules are all load-bearing here and pull in
//          opposite directions — rule 3 (never interrupt a working setup) is what
//          demands the load, and rule 1 (a runtime already running is the SILENT
//          happy path) is what forbids doing it for a user who has chosen nothing.
//          A fix for one that breaks the other is not a fix.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DiscoveredRuntime, ProviderStatus } from "../lib/aiTypes";

const invoke = vi.fn();
vi.mock("../lib/aiChatBackend", () => ({
  aiChatBackend: { invoke: (...a: unknown[]) => invoke(...a) },
}));

const store = new Map<string, string>();
vi.mock("@api", () => ({
  getSetting: (ext: string, k: string, d: string) => store.get(`${ext}:${k}`) ?? d,
  setSetting: (ext: string, k: string, v: string) => void store.set(`${ext}:${k}`, String(v)),
}));

const { ModelPicker } = await import("../components/ModelPicker");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OLLAMA: ProviderStatus = {
  id: "ollama",
  label: "Ollama",
  kind: "openAiCompat",
  baseUrl: "http://127.0.0.1:11434/v1",
  requiresKey: false,
  isLocal: true,
  note: "Runs on this machine. Your workbook never leaves it.",
  hasKey: true,
};

const ANTHROPIC: ProviderStatus = {
  id: "anthropic",
  label: "Anthropic",
  kind: "anthropic",
  baseUrl: "https://api.anthropic.com",
  requiresKey: true,
  isLocal: false,
  note: "Claude models. Sends workbook content to Anthropic.",
  hasKey: false,
};

const RUNNING_OLLAMA: DiscoveredRuntime = {
  providerId: "ollama",
  label: "Ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  models: ["qwen3:8b", "llama3.2:3b"],
};

/** Persist a selection the way `providerSelection.writeSelection` does. */
function saveSelection(providerId: string, model: string, baseUrl = ""): void {
  store.set("calcula.ai-chat:providerId", providerId);
  store.set("calcula.ai-chat:model", model);
  store.set("calcula.ai-chat:baseUrl", baseUrl);
}

/**
 * Answer the picker's backend calls.
 *
 * `discovered` is what `ai_discover_local_runtimes` reports, `listed` what an
 * explicit `ai_list_models` returns — kept SEPARATE because the distinction is
 * the whole point of `fetchModels`, and a double that conflated them could not
 * tell a discovery hit from a fallback round-trip.
 */
function backend(opts: {
  providers?: ProviderStatus[];
  discovered?: DiscoveredRuntime[];
  listed?: string[] | Error;
}): void {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "ai_providers_list") return opts.providers ?? [OLLAMA, ANTHROPIC];
    if (cmd === "ai_discover_local_runtimes") return opts.discovered ?? [];
    if (cmd === "ai_list_models") {
      if (opts.listed instanceof Error) throw opts.listed;
      return opts.listed ?? [];
    }
    throw new Error(`unexpected command ${cmd}`);
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

/** Mount the picker and let its mount effect's awaits settle. */
async function mountPicker(embedded = true): Promise<void> {
  await act(async () => {
    root.render(React.createElement(ModelPicker, { onDone: () => {}, embedded }));
  });
  // The effect awaits two commands and then possibly a third; a single flush
  // resolves the first only, which would show a half-loaded picker and let a
  // broken fix pass.
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

/** The Model select — the second <select>, after Provider. */
function modelSelect(): HTMLSelectElement {
  const selects = container.querySelectorAll("select");
  expect(selects.length, "the Model select is not rendered at all").toBeGreaterThan(1);
  return selects[1] as HTMLSelectElement;
}

function optionValues(sel: HTMLSelectElement): string[] {
  return [...sel.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value);
}

function commandsCalled(): string[] {
  return invoke.mock.calls.map((c) => c[0] as string);
}

beforeEach(() => {
  invoke.mockReset();
  store.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// ---------------------------------------------------------------------------

describe("re-opening the picker on a saved selection", () => {
  it("arrives with the model list POPULATED and the select enabled", async () => {
    saveSelection("ollama", "qwen3:8b");
    backend({ discovered: [RUNNING_OLLAMA] });
    await mountPicker();

    const sel = modelSelect();
    expect(
      sel.disabled,
      "the Model select is greyed out on a saved selection — `models` is empty because " +
        "nothing loaded it, and the user cannot change model without switching provider and back",
    ).toBe(false);
    expect(optionValues(sel)).toEqual(["", "qwen3:8b", "llama3.2:3b"]);
  });

  it("shows the SAVED model as the chosen one, not \"Select…\"", async () => {
    // The second symptom of the same defect, and the one the user actually sees:
    // `value={sel.model}` against an empty option list renders as unselected, so
    // a saved model reads as no model at all.
    saveSelection("ollama", "llama3.2:3b");
    backend({ discovered: [RUNNING_OLLAMA] });
    await mountPicker();

    expect(modelSelect().value).toBe("llama3.2:3b");
  });

  it("prefers the discovery result over a second round-trip", async () => {
    saveSelection("ollama", "qwen3:8b");
    backend({ discovered: [RUNNING_OLLAMA] });
    await mountPicker();

    // Asserted alongside the population, never alone: "no call was made" is also
    // true of a picker that loads nothing at all, which is the bug itself.
    expect(optionValues(modelSelect())).toContain("qwen3:8b");
    expect(
      commandsCalled(),
      "discovery already listed this runtime's models; asking again is a wasted call",
    ).not.toContain("ai_list_models");
  });

  it("falls back to ai_list_models when discovery found nothing", async () => {
    // A runtime on a non-default port, or one that lost the 700 ms probe race.
    saveSelection("ollama", "mistral:7b");
    backend({ discovered: [], listed: ["mistral:7b"] });
    await mountPicker();

    expect(commandsCalled()).toContain("ai_list_models");
    expect(modelSelect().value).toBe("mistral:7b");
  });

  it("says why the list is empty when the runtime has stopped", async () => {
    // Silence is rule 1's posture for a user who has chosen nothing. This user
    // HAS chosen, so an empty greyed-out select with no explanation is precisely
    // the dead end being fixed.
    saveSelection("ollama", "qwen3:8b");
    backend({ discovered: [], listed: new Error("connection refused") });
    await mountPicker();

    expect(container.textContent).toContain("connection refused");
  });

  it("restores the stored probe verdict instead of reporting \"Not tested yet.\"", async () => {
    // §10: a weak model must SAY it is weak before the user relies on it. A
    // verdict that survives only until the panel is re-opened does not say it.
    // The key `probeRunner.writeProfile` writes: `profile:<provider>:<model>`.
    store.set(
      "calcula.ai-chat:profile:ollama:qwen3:8b",
      JSON.stringify({
        providerId: "ollama",
        model: "qwen3:8b",
        contextTokens: 8192,
        decodeTokensPerSec: 22,
        emitsFencedCode: true,
        canaryScore: 0.17,
        tasksScored: 6,
        tasksTotal: 6,
        measuredAt: "2026-08-20T10:00:00.000Z",
      }),
    );
    saveSelection("ollama", "qwen3:8b");
    backend({ discovered: [RUNNING_OLLAMA] });
    await mountPicker();

    expect(container.textContent).not.toContain("Not tested yet.");
    expect(container.textContent).toContain("2026-08-20");
  });
});

describe("first run is still the silent happy path (§11.1 rule 1)", () => {
  it("lists no models and contacts no provider when nothing has been chosen", async () => {
    backend({ discovered: [RUNNING_OLLAMA] });
    await mountPicker(false);

    expect(
      commandsCalled(),
      "nobody has picked a provider — reaching out to one is exactly the setup wall rule 1 forbids",
    ).not.toContain("ai_list_models");
    // With no provider selected the model block is not rendered at all.
    expect(container.querySelectorAll("select").length).toBe(1);
  });

  it("does not try to list a cloud provider whose key is still missing", async () => {
    saveSelection("anthropic", "claude-opus-5");
    backend({ providers: [OLLAMA, ANTHROPIC], discovered: [] });
    await mountPicker();

    expect(
      commandsCalled(),
      "a keyless provider can only answer 401; the picker must ask for the key instead",
    ).not.toContain("ai_list_models");
    expect(container.textContent).toContain("API key");
  });

  it("lists a cloud provider's models once its key is stored", async () => {
    saveSelection("anthropic", "claude-opus-5");
    backend({
      providers: [OLLAMA, { ...ANTHROPIC, hasKey: true }],
      discovered: [],
      listed: ["claude-opus-5", "claude-sonnet-5"],
    });
    await mountPicker();

    expect(commandsCalled()).toContain("ai_list_models");
    expect(modelSelect().value).toBe("claude-opus-5");
  });
});

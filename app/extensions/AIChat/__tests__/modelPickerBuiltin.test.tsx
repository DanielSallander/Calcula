//! FILENAME: app/extensions/AIChat/__tests__/modelPickerBuiltin.test.tsx
// PURPOSE: The built-in provider in the picker: preselected when nothing else
//          answers, a download that happens ONLY after the consent dialog
//          answered true, and honest states for a build without the runtime.
// CONTEXT: 2026-09-10, owner decision D6. The consent gate is doubled in the
//          TAURI shape (`mockReturnValue(Promise.resolve(false))`), because a
//          synchronous boolean double is what let six other gates fail open.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BuiltinStatus, DiscoveredRuntime, ProviderStatus } from "../lib/aiTypes";

const invoke = vi.fn();
vi.mock("../lib/aiChatBackend", () => ({
  aiChatBackend: { invoke: (...a: unknown[]) => invoke(...a) },
}));

const store = new Map<string, string>();
const confirmAsync = vi.fn();
vi.mock("@api", () => ({
  getSetting: (ext: string, k: string, d: string) => store.get(`${ext}:${k}`) ?? d,
  setSetting: (ext: string, k: string, v: string) => void store.set(`${ext}:${k}`, String(v)),
  confirmAsync: (...a: unknown[]) => confirmAsync(...a),
  listenTauriEvent: async () => () => undefined,
}));

const { ModelPicker } = await import("../components/ModelPicker");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BUILTIN: ProviderStatus = {
  id: "calcula-builtin",
  label: "Calcula built-in",
  kind: "openAiCompat",
  baseUrl: "http://127.0.0.1:0/v1",
  requiresKey: false,
  isLocal: true,
  note: "Bundled with Calcula.",
  hasKey: true,
};

const OLLAMA: ProviderStatus = {
  id: "ollama",
  label: "Ollama",
  kind: "openAiCompat",
  baseUrl: "http://127.0.0.1:11434/v1",
  requiresKey: false,
  isLocal: true,
  note: "Runs on this machine.",
  hasKey: true,
};

const RUNNING_OLLAMA: DiscoveredRuntime = {
  providerId: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", models: ["qwen3:8b"],
};

function status(over: { engine?: boolean; presence?: "present" | "absent" | "mismatch"; running?: boolean } = {}): BuiltinStatus {
  const presence = over.presence ?? "absent";
  return {
    providerId: "calcula-builtin",
    target: "aarch64-pc-windows-msvc",
    engine: over.engine === false
      ? { present: false, path: null, build: null, searched: ["C:\\nowhere"] }
      : { present: true, path: "C:\\app\\llama-server\\llama-server.exe", build: "b10897", searched: [] },
    model: {
      pin: {
        id: "qwen2.5-coder-1.5b-instruct-q4_k_m",
        file: "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
        label: "Qwen2.5-Coder 1.5B Instruct (Q4_K_M)",
        url: "https://huggingface.co/x/resolve/main/m.gguf",
        sourceUrl: "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF",
        licence: "Apache-2.0",
        sizeBytes: 1_117_320_768,
        sha256: "cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046",
      },
      presence,
      path: presence === "absent" ? null : "C:\\models\\m.gguf",
      foundIn: presence === "absent" ? null : "downloaded",
      sizeOnDisk: presence === "present" ? 1_117_320_768 : presence === "mismatch" ? 5 : null,
      downloadDir: "C:\\models",
    },
    running: over.running ? { port: 4321, baseUrl: "http://127.0.0.1:4321/v1", pid: 7, uptimeSecs: 1, idleSecs: 0, modelPath: "m" } : null,
    starting: false,
    download: null,
    idleUnloadSecs: 900,
  };
}

function backend(opts: { discovered?: DiscoveredRuntime[]; builtin?: BuiltinStatus | Error; afterDownload?: BuiltinStatus }): void {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "ai_providers_list") return [BUILTIN, OLLAMA];
    if (cmd === "ai_discover_local_runtimes") return opts.discovered ?? [];
    if (cmd === "ai_builtin_status") {
      if (opts.builtin instanceof Error) throw opts.builtin;
      return opts.builtin ?? status();
    }
    if (cmd === "ai_builtin_ensure_model") return opts.afterDownload ?? status({ presence: "present" });
    if (cmd === "ai_list_models") return ["qwen3:8b"];
    throw new Error(`unexpected command ${cmd}`);
  });
}

let container: HTMLDivElement;
let root: Root;

async function mountPicker(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(ModelPicker, { onDone: () => {}, embedded: true }));
  });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

function providerSelect(): HTMLSelectElement {
  return container.querySelector("select") as HTMLSelectElement;
}

function button(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith(text)) as
    | HTMLButtonElement
    | undefined;
}

function commandsCalled(): string[] {
  return invoke.mock.calls.map((c) => c[0] as string);
}

beforeEach(() => {
  invoke.mockReset();
  confirmAsync.mockReset();
  // The Tauri shape: a PROMISE of a boolean, refusing by default.
  confirmAsync.mockReturnValue(Promise.resolve(false));
  store.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("first run with nothing discovered", () => {
  it("preselects the built-in provider and offers the download, without downloading", async () => {
    backend({ discovered: [] });
    await mountPicker();
    expect(providerSelect().value).toBe("calcula-builtin");
    expect(store.get("calcula.ai-chat:providerId")).toBe("calcula-builtin");
    expect(button("Download model (1.04 GB)"), "the one button that fetches it").toBeTruthy();
    expect(commandsCalled()).not.toContain("ai_builtin_ensure_model");
    expect(container.textContent).toContain("download needed");
  });

  it("leaves a discovered runtime alone (rule 1 beats the preselection)", async () => {
    backend({ discovered: [RUNNING_OLLAMA] });
    await mountPicker();
    expect(providerSelect().value).toBe("");
    expect(store.get("calcula.ai-chat:providerId") ?? "").toBe("");
  });

  it("does not preselect a runtime this build does not carry", async () => {
    backend({ discovered: [], builtin: status({ engine: false }) });
    await mountPicker();
    expect(providerSelect().value).toBe("");
    // The pre-built-in wording: nothing here promises a runtime this build lacks.
    expect(container.textContent).toContain("install Ollama or LM Studio and it will appear here");
    expect(container.textContent).not.toContain("choose \"Calcula built-in\"");
  });

  it("survives a backend that cannot report the runtime at all", async () => {
    backend({ discovered: [], builtin: new Error("no such command") });
    await mountPicker();
    expect(providerSelect().value).toBe("");
    expect(container.querySelectorAll("select").length).toBe(1);
  });
});

describe("the consented download", () => {
  it("does NOTHING when the dialog is refused", async () => {
    backend({ discovered: [] });
    await mountPicker();
    await act(async () => {
      button("Download model")!.click();
      await Promise.resolve();
    });
    expect(confirmAsync).toHaveBeenCalledTimes(1);
    const sentence = confirmAsync.mock.calls[0][0] as string;
    expect(sentence).toContain("1.04 GB");
    expect(sentence).toContain("Apache-2.0");
    expect(sentence).toContain("huggingface.co");
    expect(commandsCalled(), "a refused dialog must not start a gigabyte download").not.toContain("ai_builtin_ensure_model");
  });

  it("downloads on consent and selects the verified model", async () => {
    confirmAsync.mockReturnValue(Promise.resolve(true));
    backend({ discovered: [] });
    await mountPicker();
    await act(async () => {
      button("Download model")!.click();
    });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(commandsCalled()).toContain("ai_builtin_ensure_model");
    expect(store.get("calcula.ai-chat:model")).toBe("qwen2.5-coder-1.5b-instruct-q4_k_m");
    const selects = container.querySelectorAll("select");
    expect((selects[1] as HTMLSelectElement).value).toBe("qwen2.5-coder-1.5b-instruct-q4_k_m");
    expect(container.textContent).toContain("Model on disk");
    const done = [...container.querySelectorAll("button")].find((b) => b.textContent === "Done") as HTMLButtonElement;
    expect(done.disabled).toBe(false);
  });

  it("reports a failed download and keeps the button", async () => {
    confirmAsync.mockReturnValue(Promise.resolve(true));
    backend({ discovered: [] });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_providers_list") return [BUILTIN, OLLAMA];
      if (cmd === "ai_discover_local_runtimes") return [];
      if (cmd === "ai_builtin_status") return status();
      if (cmd === "ai_builtin_ensure_model") throw new Error("The download stalled for 60 seconds");
      throw new Error(`unexpected command ${cmd}`);
    });
    await mountPicker();
    await act(async () => {
      button("Download model")!.click();
    });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain("stalled for 60 seconds");
    expect(button("Download model")).toBeTruthy();
    expect(store.get("calcula.ai-chat:model") ?? "").toBe("");
  });
});

describe("a saved built-in selection", () => {
  it("lists the one model from disk without a round-trip and shows the runtime state", async () => {
    store.set("calcula.ai-chat:providerId", "calcula-builtin");
    store.set("calcula.ai-chat:model", "qwen2.5-coder-1.5b-instruct-q4_k_m");
    backend({ discovered: [], builtin: status({ presence: "present", running: true }) });
    await mountPicker();
    expect(commandsCalled()).not.toContain("ai_list_models");
    const selects = container.querySelectorAll("select");
    expect((selects[1] as HTMLSelectElement).value).toBe("qwen2.5-coder-1.5b-instruct-q4_k_m");
    expect(container.textContent).toContain("port 4321");
    expect(button("Stop the runtime now")).toBeTruthy();
    expect(button("Delete downloaded model")).toBeTruthy();
    expect(container.textContent).toContain("Calcula built-in — running");
  });

  it("says plainly that the runtime is missing from this build", async () => {
    store.set("calcula.ai-chat:providerId", "calcula-builtin");
    backend({ discovered: [], builtin: status({ engine: false }) });
    await mountPicker();
    expect(container.textContent).toContain("does not include the on-board runtime");
    expect(container.textContent).toContain("C:\\nowhere");
    expect(button("Download model")).toBeUndefined();
  });

  it("offers to replace a wrong-sized file rather than use it", async () => {
    store.set("calcula.ai-chat:providerId", "calcula-builtin");
    backend({ discovered: [], builtin: status({ presence: "mismatch" }) });
    await mountPicker();
    expect(container.textContent).toContain("will not be used");
    expect(button("Replace and download")).toBeTruthy();
  });
});

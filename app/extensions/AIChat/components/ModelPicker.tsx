//! FILENAME: app/extensions/AIChat/components/ModelPicker.tsx
// PURPOSE: Choose the provider and model the chat talks to. Any vendor, local or
//          cloud, and it is the ONLY place a key is entered.
// CONTEXT: Owner decision 2026-08-19 — VS-Code-Copilot-style free choice.
//          Before M3 there was no picker at all: every request in the product
//          was `claude-opus-4-8`, because `ai_chat_complete` took a `model`
//          parameter the caller never passed.
//
//          FIRST-RUN POSTURE (§11.1), and all three rules are visible here:
//            1. A runtime already running is the SILENT happy path — discovery
//               runs on mount, its models populate the list, no copy appears.
//            2. Nothing found -> both routes, LOCAL FIRST, reason in one line.
//               Not a setup wall.
//            3. Never interrupt a working setup — a stored key is used and the
//               picker stays out of the way until asked for.

import React, { useCallback, useEffect, useState } from "react";
import { aiChatBackend } from "../lib/aiChatBackend";
import type { DiscoveredRuntime, ProviderStatus } from "../lib/aiTypes";
import { readSelection, writeSelection, type ProviderSelection } from "../lib/providerSelection";
import { readProfile, runProbe, summarizeProfile, type ModelProfile } from "../lib/probeRunner";

const h = React.createElement;

const wrap: React.CSSProperties = { padding: 12, display: "flex", flexDirection: "column", gap: 10, fontSize: 12 };
const label: React.CSSProperties = { fontWeight: 600, color: "#333" };
const select: React.CSSProperties = { padding: 5, border: "1px solid #CCC", borderRadius: 4, fontSize: 12 };
const input: React.CSSProperties = { padding: 5, border: "1px solid #CCC", borderRadius: 4, fontSize: 12 };
const btn: React.CSSProperties = { padding: "6px 12px", border: "none", borderRadius: 4, background: "#0078D4", color: "#FFF", cursor: "pointer" };
const subtle: React.CSSProperties = { color: "#666", margin: 0, lineHeight: 1.45 };
const linkBtn: React.CSSProperties = { background: "none", border: "none", color: "#0078D4", cursor: "pointer", padding: 0, fontSize: 11, textDecoration: "underline" };
const errorBox: React.CSSProperties = { background: "#FDECEA", border: "1px solid #F5C6C2", color: "#A1241B", padding: "6px 8px", borderRadius: 4 };

export interface ModelPickerProps {
  onDone: () => void;
  /** Rendered inside the chat as a settings view rather than a first-run gate. */
  embedded?: boolean;
}

/**
 * A provider's model list: discovery already knows it for a local runtime,
 * otherwise ask the backend.
 *
 * Module-level and taking `discovered` as an ARGUMENT rather than reading state,
 * because it has two callers whose knowledge differs: `loadModels` (below) holds
 * the discovery result in state, while the mount effect has only just awaited it
 * and its `[]`-dep closure would still see `null`. One function, no stale read.
 */
async function fetchModels(
  providerId: string,
  baseUrl: string,
  discovered: DiscoveredRuntime[] | null,
): Promise<string[]> {
  const hit = discovered?.find((d) => d.providerId === providerId);
  if (hit && hit.models.length > 0) return hit.models;
  return aiChatBackend.invoke<string[]>("ai_list_models", {
    providerId,
    baseUrlOverride: baseUrl || null,
  });
}

export function ModelPicker({ onDone, embedded }: ModelPickerProps): React.ReactElement {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredRuntime[] | null>(null);
  const [sel, setSel] = useState<ProviderSelection>(readSelection);
  const [models, setModels] = useState<string[]>([]);
  const [keyInput, setKeyInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Restored, not reset: the SAME fresh-mount amnesia that emptied `models`
  // also dropped the stored verdict, so re-opening the picker reported a model
  // measured as weak with `summarizeProfile(null)` — "Not tested yet." §10 says
  // a weak model must SAY it is weak before the user relies on it, and a verdict
  // that survives only until the panel is reopened does not say it.
  const [profile, setProfile] = useState<ModelProfile | null>(() =>
    sel.providerId && sel.model ? readProfile(sel.providerId, sel.model) : null,
  );
  const [probing, setProbing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const cancelRef = React.useRef(false);

  const provider = providers.find((p) => p.id === sel.providerId);

  /**
   * Read the provider list, probe for local runtimes, and — this is the part
   * that was missing — LIST THE MODELS OF AN ALREADY-SAVED SELECTION.
   *
   * Rule 1: probe quietly. Four loopback GETs; nothing is said if nothing is
   * there, and the result only ever ADDS options.
   *
   * Rule 3, never interrupt a working setup, is what the last block serves.
   * "Change model" MOUNTS A FRESH PICKER, so `models` starts empty — and an
   * empty list disables the Model select. The list was only ever filled by the
   * Provider dropdown's `onChange`, which means the one path that never filled
   * it was the one a returning user always takes: their saved provider was
   * restored and named correctly while their saved model sat behind a greyed-out
   * select, displaying as "Select…" because no matching option existed. The only
   * escape was to switch provider and switch back, since re-picking the same
   * value fires no change event.
   */
  useEffect(() => {
    void (async () => {
      let list: ProviderStatus[] = [];
      try {
        list = await aiChatBackend.invoke<ProviderStatus[]>("ai_providers_list");
        setProviders(list);
      } catch (e) {
        setError(`Could not read the provider list: ${e}`);
      }

      let found: DiscoveredRuntime[] = [];
      try {
        found = await aiChatBackend.invoke<DiscoveredRuntime[]>("ai_discover_local_runtimes");
      } catch {
        found = [];
      }
      setDiscovered(found);

      const saved = readSelection();
      const def = list.find((p) => p.id === saved.providerId);
      // No saved provider is FIRST RUN, and rule 1 governs there: say nothing,
      // load nothing. A provider still waiting for its key has nothing to list.
      if (!def || (def.requiresKey && !def.hasKey)) return;
      setBusy(true);
      try {
        setModels(await fetchModels(def.id, saved.baseUrl, found));
      } catch (e) {
        // Reported rather than swallowed: the user is standing in the picker
        // with a saved selection, and an empty list with no explanation is the
        // very failure this block exists to end.
        setModels([]);
        setError(`${e}`);
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  /** Models for the current provider. Discovery already has them for a local one. */
  const loadModels = useCallback(async (providerId: string, baseUrl: string) => {
    setBusy(true);
    setError(null);
    try {
      const list = await fetchModels(providerId, baseUrl, discovered);
      setModels(list);
      if (list.length === 0) {
        // Answered, but has nothing. A real state for a fresh local runtime, and
        // it must not read as "not found".
        setError("That provider answered but listed no models. For a local runtime, pull a model first.");
      }
    } catch (e) {
      setModels([]);
      setError(`${e}`);
    } finally {
      setBusy(false);
    }
  }, [discovered]);

  const chooseProvider = useCallback((providerId: string) => {
    const def = providers.find((p) => p.id === providerId);
    const baseUrl = def && def.id !== "custom-openai" ? "" : sel.baseUrl;
    const next = { providerId, model: "", baseUrl };
    setSel(next);
    writeSelection(next);
    setModels([]);
    setError(null);
    if (def && (!def.requiresKey || def.hasKey)) void loadModels(providerId, baseUrl);
  }, [providers, sel.baseUrl, loadModels]);

  const saveKey = useCallback(async () => {
    if (!provider) return;
    setBusy(true);
    setError(null);
    try {
      await aiChatBackend.invoke("ai_provider_set_key", { providerId: provider.id, key: keyInput.trim() });
      setKeyInput("");
      setProviders((prev) => prev.map((p) => (p.id === provider.id ? { ...p, hasKey: true } : p)));
      await loadModels(provider.id, sel.baseUrl);
    } catch (e) {
      setError(`Could not save the key: ${e}`);
    } finally {
      setBusy(false);
    }
  }, [provider, keyInput, sel.baseUrl, loadModels]);

  const chooseModel = useCallback((model: string) => {
    const next = { ...sel, model };
    setSel(next);
    writeSelection(next);
    setProfile(model ? readProfile(next.providerId, model) : null);
  }, [sel]);

  /**
   * Run the built-in tasks against the chosen model.
   *
   * §4b: this is the only honest answer to "will this model work for Calcula?"
   * — it runs OUR tasks through OUR validator, rather than reading a spec sheet
   * or a benchmark measured on something else.
   */
  const testModel = useCallback(async () => {
    if (!provider || !sel.model) return;
    setProbing(true);
    setProgress({ done: 0, total: 0 });
    setError(null);
    cancelRef.current = false;
    try {
      const result = await runProbe({
        providerId: provider.id,
        model: sel.model,
        baseUrl: sel.baseUrl,
        onProgress: (done, total) => setProgress({ done, total }),
        isCancelled: () => cancelRef.current,
      });
      setProfile(result);
    } catch (e) {
      setError(`${e}`);
    } finally {
      setProbing(false);
    }
  }, [provider, sel.model, sel.baseUrl]);

  const locals = providers.filter((p) => p.isLocal);
  const clouds = providers.filter((p) => !p.isLocal);
  const running = new Set((discovered ?? []).map((d) => d.providerId));
  const nothingLocalFound = discovered !== null && discovered.length === 0;

  return h("div", { style: wrap },
    embedded ? null : h("h3", { key: "t", style: { margin: 0 } }, "Choose a model"),

    // Rule 2: only when nothing answered. One line, not a setup wall.
    nothingLocalFound && !provider
      ? h("p", { key: "none", style: subtle },
          "No local model found. Calcula can run one so your workbook never leaves this machine — " +
          "install Ollama or LM Studio and it will appear here. Or connect a cloud provider below.")
      : null,

    h("label", { key: "pl", style: label }, "Provider"),
    h("select", {
      key: "p", style: select, value: sel.providerId,
      onChange: (e: React.ChangeEvent<HTMLSelectElement>) => chooseProvider(e.target.value),
    },
      h("option", { key: "", value: "" }, "Select…"),
      // Local first, always (§11.1) — and a running one says so.
      h("optgroup", { key: "l", label: "On this machine" },
        locals.map((p) => h("option", { key: p.id, value: p.id },
          running.has(p.id) ? `${p.label} — running` : p.label))),
      h("optgroup", { key: "c", label: "Cloud" },
        clouds.map((p) => h("option", { key: p.id, value: p.id },
          p.hasKey ? `${p.label} — key saved` : p.label))),
    ),

    provider ? h("p", { key: "note", style: subtle }, provider.note) : null,

    provider && provider.id === "custom-openai"
      ? h("input", {
          key: "url", style: input, placeholder: "https://your-endpoint/v1", value: sel.baseUrl,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
            const next = { ...sel, baseUrl: e.target.value };
            setSel(next);
            writeSelection(next);
          },
          onBlur: () => { if (sel.baseUrl) void loadModels(provider.id, sel.baseUrl); },
        })
      : null,

    provider && provider.requiresKey && !provider.hasKey
      ? h("div", { key: "key", style: { display: "flex", flexDirection: "column", gap: 6 } },
          h("label", { key: "kl", style: label }, `${provider.label} API key`),
          h("input", {
            key: "ki", type: "password", style: input, value: keyInput, placeholder: "Paste your key",
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => setKeyInput(e.target.value),
          }),
          h("p", { key: "kn", style: subtle },
            "Stored in your OS keychain, one slot per provider. It never reaches the workbook and is never shown again."),
          h("button", { key: "kb", style: btn, disabled: !keyInput.trim() || busy, onClick: () => void saveKey() },
            busy ? "Saving…" : "Save key"),
        )
      : null,

    provider && (!provider.requiresKey || provider.hasKey)
      ? h("div", { key: "m", style: { display: "flex", flexDirection: "column", gap: 6 } },
          h("label", { key: "ml", style: label }, "Model"),
          h("select", {
            key: "ms", style: select, value: sel.model, disabled: busy || models.length === 0,
            onChange: (e: React.ChangeEvent<HTMLSelectElement>) => chooseModel(e.target.value),
          },
            h("option", { key: "", value: "" }, busy ? "Loading…" : "Select…"),
            models.map((m) => h("option", { key: m, value: m }, m)),
          ),
        )
      : null,

    // The measured verdict. §10: a weak model must SAY it is weak before the
    // user relies on it, or they blame the product rather than the model.
    provider && sel.model
      ? h("div", { key: "probe", style: { display: "flex", flexDirection: "column", gap: 6 } },
          h("p", { key: "s", style: subtle }, summarizeProfile(profile)),
          probing
            ? h("div", { key: "p", style: { display: "flex", alignItems: "center", gap: 8 } },
                h("span", { key: "t", style: subtle },
                  progress.total > 0
                    ? `Testing ${progress.done}/${progress.total}…`
                    : "Testing…"),
                h("button", {
                  key: "c", style: linkBtn,
                  onClick: () => { cancelRef.current = true; },
                }, "Stop"),
              )
            : h("button", {
                key: "b", style: { ...btn, background: "#5A5A5A" },
                onClick: () => void testModel(),
              }, profile ? "Test again" : "Test this model"),
        )
      : null,

    error ? h("div", { key: "e", style: errorBox }, error) : null,

    h("button", {
      key: "done", style: { ...btn, opacity: sel.providerId && sel.model ? 1 : 0.5 },
      disabled: !sel.providerId || !sel.model,
      onClick: onDone,
    }, embedded ? "Done" : "Start chatting"),
  );
}

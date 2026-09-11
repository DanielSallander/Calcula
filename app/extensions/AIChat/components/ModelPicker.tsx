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
//
//          THE BUILT-IN PROVIDER (2026-09-10, owner decision D6). When nothing
//          answers discovery and this build carries the on-board runtime, the
//          built-in provider is PRESELECTED — that is rule 2's "local first"
//          with a concrete local to offer — and its section shows the one
//          consent sentence and a Download button. Nothing downloads until
//          `confirmAsync` answers true; the model select fills the moment the
//          verified file is in place. The runtime itself starts on the first
//          request and says so here while it runs.

import React, { useCallback, useEffect, useState } from "react";
import { confirmAsync, listenTauriEvent } from "@api";
import { aiChatBackend } from "../lib/aiChatBackend";
import {
  AI_BUILTIN_RUNTIME_EVENT, BUILTIN_PROVIDER_ID,
  type BuiltinModelProgressEvent, type BuiltinRuntimeEvent, type BuiltinStatus,
  type DiscoveredRuntime, type ProviderStatus,
} from "../lib/aiTypes";
import { readSelection, writeSelection, type ProviderSelection } from "../lib/providerSelection";
import { readProfile, runProbe, summarizeProfile, type ModelProfile } from "../lib/probeRunner";
import {
  builtinBadge, cancelBuiltinDownload, consentSentence, deleteBuiltinModel, describeBuiltin,
  downloadBuiltinModel, formatSize, readBuiltinStatus, stopBuiltinRuntime,
} from "../lib/builtinRuntime";

const h = React.createElement;

const wrap: React.CSSProperties = { padding: 12, display: "flex", flexDirection: "column", gap: 10, fontSize: 12 };
const label: React.CSSProperties = { fontWeight: 600, color: "#333" };
const select: React.CSSProperties = { padding: 5, border: "1px solid #CCC", borderRadius: 4, fontSize: 12 };
const input: React.CSSProperties = { padding: 5, border: "1px solid #CCC", borderRadius: 4, fontSize: 12 };
const btn: React.CSSProperties = { padding: "6px 12px", border: "none", borderRadius: 4, background: "#0078D4", color: "#FFF", cursor: "pointer" };
const subtle: React.CSSProperties = { color: "#666", margin: 0, lineHeight: 1.45 };
const linkBtn: React.CSSProperties = { background: "none", border: "none", color: "#0078D4", cursor: "pointer", padding: 0, fontSize: 11, textDecoration: "underline" };
const errorBox: React.CSSProperties = { background: "#FDECEA", border: "1px solid #F5C6C2", color: "#A1241B", padding: "6px 8px", borderRadius: 4 };
// Amber, not red: a model that has gone away is a choice to redo, not a fault.
const warnBox: React.CSSProperties = { background: "#FFF4CE", border: "1px solid #F2D57E", color: "#6B5200", padding: "6px 8px", borderRadius: 4, margin: 0, lineHeight: 1.45 };

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
  // The on-board runtime's state, or null when the backend could not say
  // (an older build, a guard refusal) — in which case the built-in provider
  // is listed like any other and simply reports nothing about itself.
  const [builtin, setBuiltin] = useState<BuiltinStatus | null>(null);
  const [downloading, setDownloading] = useState<BuiltinModelProgressEvent | null>(null);

  const provider = providers.find((p) => p.id === sel.providerId);

  const refreshBuiltin = useCallback(async (): Promise<BuiltinStatus | null> => {
    try {
      const status = await readBuiltinStatus();
      setBuiltin(status);
      return status;
    } catch {
      setBuiltin(null);
      return null;
    }
  }, []);

  /** The built-in provider's model list is a fact about disk, not a round-trip. */
  const builtinModels = (status: BuiltinStatus | null): string[] =>
    status && status.model.presence === "present" ? [status.model.pin.id] : [];

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

      // Cheap and local: three file checks and a lock probe. Read on every
      // mount so the badge on the built-in entry is current.
      let status: BuiltinStatus | null = null;
      try {
        status = await readBuiltinStatus();
        setBuiltin(status);
      } catch {
        status = null;
      }

      const saved = readSelection();
      const def = list.find((p) => p.id === saved.providerId);

      // First run with NOTHING answering discovery, in a build that carries
      // the on-board runtime: preselect it. Rule 2 says local first; this is
      // the local we can actually offer. It downloads nothing — the section
      // below asks first — and a discovered runtime still takes precedence,
      // because rule 1 says a working setup is left alone.
      if (!def && !saved.providerId && found.length === 0 && status?.engine.present) {
        const model = status.model.presence === "present" ? status.model.pin.id : "";
        const next = { providerId: BUILTIN_PROVIDER_ID, model, baseUrl: "" };
        setSel(next);
        writeSelection(next);
        setModels(builtinModels(status));
        if (model) setProfile(readProfile(BUILTIN_PROVIDER_ID, model));
        return;
      }

      // No saved provider is FIRST RUN, and rule 1 governs there: say nothing,
      // load nothing. A provider still waiting for its key has nothing to list.
      if (!def || (def.requiresKey && !def.hasKey)) return;
      if (def.id === BUILTIN_PROVIDER_ID) {
        setModels(builtinModels(status));
        return;
      }
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

  // The runtime announces itself (starting, ready, stopped after idling) and
  // the section below shows the current state rather than a stale one.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void listenTauriEvent<BuiltinRuntimeEvent>(AI_BUILTIN_RUNTIME_EVENT, () => {
      void refreshBuiltin();
    }).then((d) => {
      if (cancelled) d();
      else dispose = d;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [refreshBuiltin]);

  const chooseProvider = useCallback((providerId: string) => {
    const def = providers.find((p) => p.id === providerId);
    const baseUrl = def && def.id !== "custom-openai" ? "" : sel.baseUrl;
    // The built-in provider has one model, and whether it is on disk is
    // already known: no round-trip, and no "listed no models" complaint for
    // a runtime whose next step is a download button.
    const model = providerId === BUILTIN_PROVIDER_ID ? (builtinModels(builtin)[0] ?? "") : "";
    const next = { providerId, model, baseUrl };
    setSel(next);
    writeSelection(next);
    setModels(providerId === BUILTIN_PROVIDER_ID ? builtinModels(builtin) : []);
    setProfile(model ? readProfile(providerId, model) : null);
    setError(null);
    if (providerId === BUILTIN_PROVIDER_ID) return;
    if (def && (!def.requiresKey || def.hasKey)) void loadModels(providerId, baseUrl);
  }, [providers, sel.baseUrl, loadModels, builtin]);

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
   * The consented download (D6). The sentence names the size, the licence,
   * the source, the hash and the folder; `confirmAsync` is awaited and fails
   * CLOSED, so a dialog that cannot be shown is a refusal. The model becomes
   * the selection the moment the verified file is in place — there is exactly
   * one, and the person just agreed to fetch it.
   */
  const downloadModel = useCallback(async () => {
    if (!builtin) return;
    const ok = await confirmAsync(consentSentence(builtin.model.pin, builtin.model.downloadDir), {
      title: "Download the built-in model?",
      okLabel: "Download",
      cancelLabel: "Not now",
    });
    if (!ok) return;
    setError(null);
    setDownloading({ phase: "downloading", bytes: 0, total: builtin.model.pin.sizeBytes });
    try {
      const status = await downloadBuiltinModel((event) => setDownloading(event));
      setBuiltin(status);
      const models = builtinModels(status);
      setModels(models);
      if (models[0]) {
        const next = { providerId: BUILTIN_PROVIDER_ID, model: models[0], baseUrl: "" };
        setSel(next);
        writeSelection(next);
        setProfile(readProfile(BUILTIN_PROVIDER_ID, models[0]));
      }
    } catch (e) {
      setError(`${e}`);
      void refreshBuiltin();
    } finally {
      setDownloading(null);
    }
  }, [builtin, refreshBuiltin]);

  const stopDownload = useCallback(() => {
    void cancelBuiltinDownload().catch(() => undefined);
  }, []);

  const stopRuntime = useCallback(async () => {
    try {
      setBuiltin(await stopBuiltinRuntime());
    } catch (e) {
      setError(`${e}`);
    }
  }, []);

  /** Only a DOWNLOADED copy is offered for deletion; the backend refuses the rest anyway. */
  const deleteModel = useCallback(async () => {
    if (!builtin) return;
    const ok = await confirmAsync(
      `Delete the downloaded model (${formatSize(builtin.model.sizeOnDisk ?? builtin.model.pin.sizeBytes)}) ` +
        `from ${builtin.model.downloadDir}? The built-in provider will need the download again before it can answer.`,
      { title: "Delete the built-in model?", okLabel: "Delete", cancelLabel: "Keep it", kind: "warning" },
    );
    if (!ok) return;
    try {
      const status = await deleteBuiltinModel();
      setBuiltin(status);
      setModels(builtinModels(status));
      if (sel.providerId === BUILTIN_PROVIDER_ID) {
        const next = { ...sel, model: "" };
        setSel(next);
        writeSelection(next);
        setProfile(null);
      }
    } catch (e) {
      setError(`${e}`);
    }
  }, [builtin, sel]);

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

  /**
   * The saved model is gone — pulled, renamed, or removed since it was chosen.
   *
   * A `<select>` whose `value` matches no `<option>` renders as UNSELECTED, so
   * this used to show "Select…" while the setting still named the missing model
   * and "Done" stayed enabled: the user left the picker believing they had
   * chosen, and the chat failed on the next message against a model that no
   * longer exists.
   *
   * `models.length > 0` is the guard that keeps this honest. An empty list means
   * we know NOTHING — still loading, or the runtime stopped — and announcing a
   * model missing on that evidence would be a second lie in the other direction.
   * That case already has its own message from the load.
   */
  const savedModelGone = Boolean(sel.model) && models.length > 0 && !models.includes(sel.model);

  const isBuiltin = provider?.id === BUILTIN_PROVIDER_ID;
  const builtinHasEngine = Boolean(builtin?.engine.present);

  /**
   * The built-in provider's own block: what is on disk, what is running, and
   * the one button that fetches the model after the consent sentence.
   */
  function renderBuiltinSection(): React.ReactElement | null {
    if (!isBuiltin || !builtin) return null;
    if (!builtin.engine.present) {
      return h("p", { key: "bi-missing", style: warnBox }, describeBuiltin(builtin));
    }
    const { model } = builtin;
    const needsDownload = model.presence !== "present";
    return h("div", { key: "bi", style: { display: "flex", flexDirection: "column", gap: 6 } },
      h("p", { key: "d", style: model.presence === "mismatch" ? warnBox : subtle }, describeBuiltin(builtin)),
      needsDownload && downloading
        ? h("div", { key: "dl", style: { display: "flex", alignItems: "center", gap: 8 } },
            h("span", { key: "t", style: subtle },
              downloading.phase === "downloading"
                ? `Downloading… ${formatSize(downloading.bytes)} of ${formatSize(downloading.total)} ` +
                  `(${Math.floor((downloading.bytes / Math.max(1, downloading.total)) * 100)}%)`
                : downloading.phase === "verifying"
                  ? "Checking the file against its published hash…"
                  : "Finishing…"),
            downloading.phase === "downloading"
              ? h("button", { key: "c", style: linkBtn, onClick: stopDownload }, "Stop")
              : null,
          )
        : needsDownload
          ? h("button", {
              key: "dlb", style: btn, disabled: busy,
              onClick: () => void downloadModel(),
            }, `${model.presence === "mismatch" ? "Replace and download" : "Download model"} (${formatSize(model.pin.sizeBytes)})`)
          : h("div", { key: "ops", style: { display: "flex", gap: 12 } },
              builtin.running
                ? h("button", { key: "stop", style: linkBtn, onClick: () => void stopRuntime() }, "Stop the runtime now")
                : null,
              model.foundIn === "downloaded"
                ? h("button", { key: "del", style: linkBtn, onClick: () => void deleteModel() }, "Delete downloaded model")
                : null,
            ),
    );
  }

  return h("div", { style: wrap },
    embedded ? null : h("h3", { key: "t", style: { margin: 0 } }, "Choose a model"),

    // Rule 2: only when nothing answered. One line, not a setup wall — and
    // it names the built-in runtime first when this build carries one.
    nothingLocalFound && !provider
      ? h("p", { key: "none", style: subtle },
          builtinHasEngine
            ? "No local model found. Calcula includes a small on-board model (a 1.1 GB download the " +
              "first time) — choose \"Calcula built-in\" above. Or install Ollama or LM Studio, or " +
              "connect a cloud provider below."
            : "No local model found. Calcula can run one so your workbook never leaves this machine — " +
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
          p.id === BUILTIN_PROVIDER_ID
            ? (builtinBadge(builtin) ? `${p.label} — ${builtinBadge(builtin)}` : p.label)
            : running.has(p.id) ? `${p.label} — running` : p.label))),
      h("optgroup", { key: "c", label: "Cloud" },
        clouds.map((p) => h("option", { key: p.id, value: p.id },
          p.hasKey ? `${p.label} — key saved` : p.label))),
    ),

    provider ? h("p", { key: "note", style: subtle }, provider.note) : null,

    renderBuiltinSection(),

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
            // The missing model gets an option of its own so the select SHOWS
            // what is stored. Dropping it would leave the field reading
            // "Select…" — which is how a stale selection passed for no
            // selection at all.
            savedModelGone
              ? h("option", { key: sel.model, value: sel.model }, `${sel.model} — no longer available`)
              : null,
            models.map((m) => h("option", { key: m, value: m }, m)),
          ),
          savedModelGone
            ? h("p", { key: "gone", style: warnBox },
                `${provider.label} no longer offers "${sel.model}". It was pulled, renamed or removed ` +
                "since you chose it. Pick another model — this one cannot answer.")
            : null,
        )
      : null,

    // The measured verdict. §10: a weak model must SAY it is weak before the
    // user relies on it, or they blame the product rather than the model.
    // Withheld once the model is gone: a score for something that cannot run is
    // not a verdict, and "Test this model" would only buy a guaranteed failure.
    provider && sel.model && !savedModelGone
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

    // `savedModelGone` blocks the exit too. Letting the user leave on a model
    // that cannot answer is what turned this into a chat-time failure rather
    // than a picker-time one — and the list they need is on screen already.
    h("button", {
      key: "done", style: { ...btn, opacity: sel.providerId && sel.model && !savedModelGone ? 1 : 0.5 },
      disabled: !sel.providerId || !sel.model || savedModelGone,
      onClick: onDone,
    }, embedded ? "Done" : "Start chatting"),
  );
}

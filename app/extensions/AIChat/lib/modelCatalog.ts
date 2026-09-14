//! FILENAME: app/extensions/AIChat/lib/modelCatalog.ts
// PURPOSE: Enumerate the models that can answer RIGHT NOW, and encode/decode the
//          opaque key the `@api/aiCompletionService` seam hands around.
// CONTEXT: The seam promises callers a list they can act on without owning any
//          of AIChat's setup machinery. That promise has one hard edge:
//
//          READY ONLY. A cloud provider with no stored key, a local runtime that
//          is not running, the bundled model that has not been downloaded — none
//          of them appear here. Listing a model a caller cannot use recreates
//          the "disabled control with no reason" failure one layer up, and the
//          caller cannot fix any of those cases anyway: a key goes in the
//          Credential Manager and the bundled model is a consented 1.04 GB
//          download. Both live behind `openModelPicker()`.
//
//          WHY THE KEY IS OPAQUE. A selection is `{ providerId, model, baseUrl }`
//          and `baseUrl` matters for exactly two cases — `custom-openai`, whose
//          registry entry carries an empty base URL so the backend refuses
//          without one, and a local runtime on a non-default port. Spelling that
//          triple into the facade would put a detail two cases care about into
//          every caller. So the seam carries a string this module issues and
//          this module reads back.

import { aiChatBackend } from "./aiChatBackend";
import type { DiscoveredRuntime, ProviderStatus } from "./aiTypes";
import { readProfile } from "./probeRunner";
import { acceptsGrammar } from "./completionProvider";
import type { AiModelOption } from "@api";

/** The triple a key encodes. */
export interface CatalogEntry {
  providerId: string;
  model: string;
  baseUrl: string;
}

/**
 * Encode a selection as one string.
 *
 * A tab separator rather than a colon or a slash: model ids routinely contain
 * both (`qwen2.5-coder:1.5b`, `library/llama3`) and base URLs contain slashes
 * and colons by construction, while a tab appears in none of the three. A
 * separator that can occur in a field is a decoder that silently mis-splits,
 * which is how `"ThreeArrows||top"` once decoded as icon 0.
 */
export function encodeModelKey(entry: CatalogEntry): string {
  return [entry.providerId, entry.model, entry.baseUrl].join("\t");
}

/**
 * The inverse. THROWS on anything this module did not issue.
 *
 * Refusing beats returning a half-parsed entry: a selection that quietly failed
 * looks exactly like one that worked, right up until the next request errors
 * against a provider the user never chose.
 */
export function decodeModelKey(key: string): CatalogEntry {
  const parts = key.split("\t");
  if (parts.length !== 3 || parts[0].trim() === "" || parts[1].trim() === "") {
    throw new Error(`not a model key issued by this provider: ${JSON.stringify(key)}`);
  }
  return { providerId: parts[0], model: parts[1], baseUrl: parts[2] };
}

/**
 * A provider's model list: discovery already knows it for a local runtime,
 * otherwise ask the backend.
 *
 * Takes `discovered` as an ARGUMENT rather than reading state, because its
 * callers' knowledge differs — the same reason the copy in `ModelPicker` does,
 * which now calls this one so the two cannot drift.
 */
export async function fetchModels(
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

/**
 * Whether a given (provider, model) honours a grammar: the probe's measurement
 * where there is one, the runtime's identity where there is not.
 *
 * The per-model form of `completionProvider.grammarVerdict`, which can only
 * answer for the CURRENT selection. A picker has to answer for a model the user
 * has not chosen yet — that is the whole point of showing it.
 */
export function grammarVerdictFor(providerId: string, model: string): boolean | undefined {
  const measured = readProfile(providerId, model)?.honorsGrammar;
  if (measured !== undefined) return measured;
  return acceptsGrammar(providerId) ? true : undefined;
}

/**
 * Every model that can answer right now, local first.
 *
 * Local before cloud is not cosmetic: a caller is about to send it table and
 * column names, and the ordering is the one place this list can express that a
 * model on this machine is the safer default.
 *
 * FAILS SOFT, per provider. One unreachable runtime must not empty the list —
 * the user's other model still works, and an empty list would send them to set
 * up something that is already set up.
 */
export async function listReadyModels(): Promise<AiModelOption[]> {
  let providers: ProviderStatus[] = [];
  try {
    providers = await aiChatBackend.invoke<ProviderStatus[]>("ai_providers_list", {});
  } catch {
    return [];
  }

  let discovered: DiscoveredRuntime[] | null = null;
  try {
    discovered = await aiChatBackend.invoke<DiscoveredRuntime[]>("ai_discover_local_runtimes", {});
  } catch {
    discovered = [];
  }

  // A provider that still needs a key cannot answer, and asking it costs a
  // round trip that can only 401. `hasKey` is true for one that needs none.
  const usable = providers.filter((p) => p.hasKey);

  const lists = await Promise.all(
    usable.map(async (p) => {
      try {
        return { provider: p, models: await fetchModels(p.id, p.baseUrl, discovered) };
      } catch {
        return { provider: p, models: [] as string[] };
      }
    }),
  );

  const out: AiModelOption[] = [];
  for (const { provider, models } of lists) {
    for (const model of models) {
      out.push({
        key: encodeModelKey({ providerId: provider.id, model, baseUrl: provider.baseUrl }),
        model,
        providerLabel: provider.label,
        isLocal: provider.isLocal,
        honorsGrammar: grammarVerdictFor(provider.id, model),
      });
    }
  }

  out.sort((a, b) => {
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
    if (a.providerLabel !== b.providerLabel) return a.providerLabel.localeCompare(b.providerLabel);
    return a.model.localeCompare(b.model);
  });
  return out;
}

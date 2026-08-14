// FILENAME: app/extensions/_shared/cli/domainProviders.ts
// PURPOSE: Runtime registry through which one extension OFFERS a CLI domain
//          to another window's panel without any cross-extension import —
//          the ModelEditor registers a "model" provider here at activation,
//          and the main-window CommandLine panel discovers it, lists its
//          targets (BI connections) and mounts a binding. Both sides import
//          only this _shared module, honoring the Facade rule.
// CONTEXT: A provider is TARGETED: the model domain needs a connection to
//          bind to, so the panel shows a picker fed by listTargets().

import type { CliDomainBinding } from "./registry";

export interface CliDomainTarget {
  id: string;
  label: string;
}

export interface CliDomainProvider {
  /** Domain id ("model"). One provider per id; later registrations replace. */
  id: string;
  /** Picker group label ("Model"). */
  label: string;
  /** The targets a binding can be created for (BI connections). */
  listTargets(): Promise<CliDomainTarget[]>;
  /** Build a live binding for one target. Throws with a readable message
   *  when the target cannot be bound (no model loaded, …). */
  createBinding(targetId: string): Promise<CliDomainBinding>;
}

const providers = new Map<string, CliDomainProvider>();
const listeners = new Set<() => void>();

export function registerCliDomainProvider(provider: CliDomainProvider): () => void {
  providers.set(provider.id, provider);
  for (const l of listeners) l();
  return () => {
    if (providers.get(provider.id) === provider) {
      providers.delete(provider.id);
      for (const l of listeners) l();
    }
  };
}

export function getCliDomainProviders(): CliDomainProvider[] {
  return [...providers.values()];
}

/** Subscribe to provider registrations/unregistrations. */
export function onCliDomainProvidersChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

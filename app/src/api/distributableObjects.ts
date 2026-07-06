//! FILENAME: app/src/api/distributableObjects.ts
// PURPOSE: Distributable-object providers (distribution brick 4). The OPEN
//          channel that lets a third-party extension make its OWN object family
//          travel inside a .calp package — e.g. a custom pivot's definition, a
//          custom widget's config. An extension registers a provider that
//          (a) COLLECTS its objects' payloads at publish time and
//          (b) MATERIALIZES them from a pulled package.
// CONTEXT: The .calp core carries these as opaque JSON artifacts, integrity-
//          checked + signed exactly like every built-in object; it never
//          interprets the payload. Built-in families (cell types) travel the
//          same manifest channel but are materialized Rust-side; third-party
//          kinds flow through THIS registry. See docs/design/granular-bricks.md.
// SECURITY: A payload is opaque data — it is signed + SHA-256-verified on pull
//          like any artifact, so it cannot be tampered undetected. It is NOT
//          executable; a provider's materialize() runs trusted extension code
//          on already-verified data. (A package cannot smuggle behavior in a
//          custom object beyond what the receiving provider chooses to do with
//          the data.)

/** A custom object to publish (collected from a provider). */
export interface DistributableObjectPayload {
  /** The provider's kind (must match the provider's registered kind). */
  kind: string;
  /** Stable object id (idempotent across versions so refresh replaces it). */
  id: string;
  /** Human-readable name (shown in the package explorer / subscriber ledger). */
  name?: string;
  /** For per-sheet objects: the LOCAL sheet id (the backend maps it to the
   *  package sheet id at publish). Omit for workbook-scoped objects. */
  sheetId?: string;
  /** Opaque provider-owned JSON. */
  payload: Record<string, unknown>;
}

/** A pulled custom object handed back for materialization. */
export interface PulledDistributableObject {
  kind: string;
  id: string;
  name: string;
  /** LOCAL sheet index the object belongs to (the package sheet remapped), or
   *  undefined for workbook-scoped objects. */
  sheetIndex?: number;
  payload: Record<string, unknown>;
}

/** A registrable distributable-object provider for one kind. */
export interface DistributableObjectProvider {
  /** The object kind this provider owns (namespaced, e.g. "acme.customPivot"). */
  kind: string;
  /** Collect this kind's objects from the current workbook for publishing.
   *  Return an empty array when there is nothing to publish. */
  collect: () => Promise<DistributableObjectPayload[]> | DistributableObjectPayload[];
  /** Materialize pulled objects of this kind into the workbook. */
  materialize: (objects: PulledDistributableObject[]) => Promise<void> | void;
}

const providers = new Map<string, DistributableObjectProvider>();

/**
 * Register a distributable-object provider.
 * @returns Cleanup that unregisters it.
 */
export function registerDistributableObjectProvider(
  provider: DistributableObjectProvider
): () => void {
  providers.set(provider.kind, provider);
  return () => {
    if (providers.get(provider.kind) === provider) providers.delete(provider.kind);
  };
}

/** Kinds with a registered provider. */
export function distributableObjectKinds(): string[] {
  return [...providers.keys()];
}

/**
 * Collect every registered provider's objects for publishing (used by the
 * publish flow to fill `PublishParams.customObjects`). A provider that throws
 * is skipped (its objects simply don't travel) rather than failing the publish.
 */
export async function collectDistributableObjects(): Promise<DistributableObjectPayload[]> {
  const all: DistributableObjectPayload[] = [];
  for (const provider of providers.values()) {
    try {
      const objects = await provider.collect();
      for (const o of objects) all.push({ ...o, kind: provider.kind });
    } catch (error) {
      console.error(`[DistributableObjects] collect() of "${provider.kind}" failed:`, error);
    }
  }
  return all;
}

/**
 * Dispatch pulled custom objects to their providers' materialize() (used by
 * the pull flow with `PullResponse.customObjects`). Objects whose kind has no
 * registered provider are ignored (the package carried a kind this app does
 * not understand — safe, since payloads are inert data).
 */
export async function materializePulledObjects(
  objects: PulledDistributableObject[]
): Promise<void> {
  if (!objects.length) return;
  const byKind = new Map<string, PulledDistributableObject[]>();
  for (const o of objects) {
    const list = byKind.get(o.kind) ?? [];
    list.push(o);
    byKind.set(o.kind, list);
  }
  for (const [kind, list] of byKind) {
    const provider = providers.get(kind);
    if (!provider) continue;
    try {
      await provider.materialize(list);
    } catch (error) {
      console.error(`[DistributableObjects] materialize() of "${kind}" failed:`, error);
    }
  }
}

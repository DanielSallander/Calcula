//! FILENAME: app/src/api/packageKinds.ts
// PURPOSE: Pluggable .calp package KINDS (distribution brick 2). A kind labels
//          a package's intent (report / template / dataset / …) and travels in
//          the signed manifest as a plain string. Extensions can register
//          additional kinds so the publish picker — and the subscriber-facing
//          package inspection — show domain-specific kinds (e.g. "budget-model",
//          "forecast-template").
// CONTEXT: The `kind` string already flows end-to-end (publish → manifest →
//          pull → package explorer). This registry makes the SET of kinds
//          open. `refreshDefaults` is advisory metadata today: the refresh
//          pipeline is not yet kind-aware (it is not for the built-ins either),
//          so a kind's defaults describe intent and drive UI hints, not (yet)
//          engine behavior — that consumption is a documented follow-up.
// ARCHITECTURE: Pure frontend registry (like fillLists / chartMarks). No Rust
//          change: unknown kinds already round-trip (backend stores the string
//          and falls back to "report" semantics on anything it does not know).

/** Refresh-intent hints for a kind (advisory metadata; see note above). */
export interface PackageKindRefreshDefaults {
  refreshFormulas: boolean;
  refreshData: boolean;
  refreshStructure: boolean;
  preserveConsumerData: boolean;
}

/** A registrable package kind. */
export interface PackageKindDefinition {
  /** The manifest string (e.g. "report", "budget-model"). Stable + lowercase. */
  id: string;
  /** Human label for the publish picker. */
  label: string;
  /** One-line description of the kind's intent. */
  description?: string;
  /** Advisory refresh-intent metadata. */
  refreshDefaults?: PackageKindRefreshDefaults;
}

// The three built-ins, mirroring core/calp/src/package_kind.rs.
const BUILTIN_KINDS: PackageKindDefinition[] = [
  {
    id: "report",
    label: "Report",
    description: "Structure + formulas + data. The default.",
    refreshDefaults: {
      refreshFormulas: true,
      refreshData: true,
      refreshStructure: true,
      preserveConsumerData: false,
    },
  },
  {
    id: "template",
    label: "Template",
    description: "Structure + formulas; consumers supply their own data.",
    refreshDefaults: {
      refreshFormulas: true,
      refreshData: false,
      refreshStructure: true,
      preserveConsumerData: true,
    },
  },
  {
    id: "dataset",
    label: "Dataset",
    description: "Data only; structure stays stable.",
    refreshDefaults: {
      refreshFormulas: false,
      refreshData: true,
      refreshStructure: false,
      preserveConsumerData: false,
    },
  },
];

const registry = new Map<string, PackageKindDefinition>(
  BUILTIN_KINDS.map((k) => [k.id, k])
);

/**
 * Register (or override) a package kind. Built-in ids can be overridden to
 * relabel them, but the three built-ins are always present.
 * @returns Cleanup that removes a NON-builtin kind (built-ins are restored).
 */
export function registerPackageKind(def: PackageKindDefinition): () => void {
  const id = def.id.trim().toLowerCase();
  const installed = { ...def, id };
  registry.set(id, installed);
  return () => {
    // Only undo if OUR entry is still the live one. A later same-id
    // registration must not be clobbered by this (now stale) cleanup —
    // mirrors writebackValidators / distributableObjects identity guards.
    if (registry.get(id) !== installed) return;
    const builtin = BUILTIN_KINDS.find((k) => k.id === id);
    if (builtin) {
      registry.set(id, builtin);
    } else {
      registry.delete(id);
    }
  };
}

/** All registered kinds (built-ins first, then custom in registration order). */
export function listPackageKinds(): PackageKindDefinition[] {
  const builtins = BUILTIN_KINDS.map((k) => registry.get(k.id)!);
  const custom = [...registry.values()].filter(
    (k) => !BUILTIN_KINDS.some((b) => b.id === k.id)
  );
  return [...builtins, ...custom];
}

/** Look up one kind (null if unknown). */
export function getPackageKind(id: string): PackageKindDefinition | null {
  return registry.get(id.trim().toLowerCase()) ?? null;
}

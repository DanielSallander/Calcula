//! FILENAME: app/src/api/applicationKinds.ts
// PURPOSE: Pluggable .calp application KINDS (distribution brick 2). A kind labels
//          an application's intent (report / template / dataset / …) and travels
//          in the signed manifest as a plain string. Extensions can register
//          additional kinds so the publish picker — and the subscriber-facing
//          application inspection — show domain-specific kinds (e.g. "budget-model",
//          "forecast-template").
// CONTEXT: The `kind` string already flows end-to-end (publish → manifest →
//          pull → Application Explorer). This registry makes the SET of kinds
//          open. `refreshDefaults` is advisory metadata today: the refresh
//          pipeline is not yet kind-aware (it is not for the built-ins either),
//          so a kind's defaults describe intent and drive UI hints, not (yet)
//          engine behavior — that consumption is a documented follow-up.
// ARCHITECTURE: Pure frontend registry (like fillLists / chartMarks). No Rust
//          change: unknown kinds already round-trip (backend stores the string
//          and falls back to "report" semantics on anything it does not know).

/** Refresh-intent hints for a kind (advisory metadata; see note above). */
export interface ApplicationKindRefreshDefaults {
  refreshFormulas: boolean;
  refreshData: boolean;
  refreshStructure: boolean;
  preserveConsumerData: boolean;
}

/** A registrable application kind. */
export interface ApplicationKindDefinition {
  /** The manifest string (e.g. "report", "budget-model"). Stable + lowercase. */
  id: string;
  /** Human label for the publish picker. */
  label: string;
  /** One-line description of the kind's intent. */
  description?: string;
  /** Advisory refresh-intent metadata. */
  refreshDefaults?: ApplicationKindRefreshDefaults;
}

// The FOUR built-ins. The first three mirror `ApplicationKind` in
// core/calp/src/application_kind.rs; `library` deliberately does NOT — there is
// no `ApplicationKind::Library` variant, and `from_str("library")` falls through
// to `Report`. A library is carried as the manifest STRING `"library"`
// (`LIBRARY_KIND`, app/src-tauri/src/library_commands.rs), which is the only
// place it changes behaviour: an empty sheet selection publishes ZERO sheets
// instead of every sheet, so shipping a function library does not ship the
// author's workbook with it.
const BUILTIN_KINDS: ApplicationKindDefinition[] = [
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
  // The AUTHORING half of the script package manager. `library_commands.rs`
  // (LIBRARY_KIND) and @api/scriptLibraries (LIBRARY_PACKAGE_KIND) have always
  // been able to CONSUME a `kind: "library"` application, but no publish path could
  // emit one — so a library author could not actually ship. Listing it here is
  // what puts it in the publish picker; `calp_publish` treats it specially in
  // exactly one way (an empty sheet selection means ZERO sheets, not "all", so
  // publishing a function library does not ship the author's whole workbook).
  //
  // It is a built-in rather than an extension registration because the kind
  // string is already hard-coded in the Rust resolver: a library that only
  // existed while some extension was loaded would be an application whose kind
  // depended on the publisher's installed add-ins.
  {
    id: "library",
    label: "Script library",
    description:
      "Reusable script modules other workbooks import with `// @uses`. Ships code, not sheets.",
    refreshDefaults: {
      refreshFormulas: false,
      refreshData: false,
      refreshStructure: false,
      preserveConsumerData: true,
    },
  },
];

const registry = new Map<string, ApplicationKindDefinition>(
  BUILTIN_KINDS.map((k) => [k.id, k])
);

/**
 * Register (or override) an application kind. Built-in ids can be overridden to
 * relabel them, but the four built-ins are always present.
 * @returns Cleanup that removes a NON-builtin kind (built-ins are restored).
 */
export function registerApplicationKind(def: ApplicationKindDefinition): () => void {
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
export function listApplicationKinds(): ApplicationKindDefinition[] {
  const builtins = BUILTIN_KINDS.map((k) => registry.get(k.id)!);
  const custom = [...registry.values()].filter(
    (k) => !BUILTIN_KINDS.some((b) => b.id === k.id)
  );
  return [...builtins, ...custom];
}

/** Look up one kind (null if unknown). */
export function getApplicationKind(id: string): ApplicationKindDefinition | null {
  return registry.get(id.trim().toLowerCase()) ?? null;
}

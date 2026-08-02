//! FILENAME: app/src/api/scriptLibraries/types.ts
// PURPOSE: Shared types for the script package manager — the resolved-closure
//          shape returned by the `library_resolve` backend command, the
//          workbook lockfile shape, and the link-time diagnostics the UI shows.
// CONTEXT: See docs/design/script-package-manager.md. Every type here mirrors a
//          Rust struct in app/src-tauri/src/library_commands.rs (camelCase on
//          this side, snake_case + #[serde(rename_all = "camelCase")] there) or
//          is a purely frontend concept (lockfile, closure node, diagnostics).

import type { CapabilityId } from "../scriptHost/capabilityIds";

// ============================================================================
// Backend mirror types (library_commands.rs)
// ============================================================================

/** One "resolve this package at this pin" request. Mirrors `LibraryRequest`. */
export interface LibraryRequest {
  package: string;
  /** A calp VersionPin string: "1.2.3", "^1.2.0", "~1.2.0", "latest", "*". */
  pin: string;
  /**
   * The user was shown a CROSS-REGISTRY NAME CONFLICT for this package — the
   * same library name is already trusted from a different registry, under a
   * DIFFERENT publisher key — and accepted it explicitly.
   *
   * Absent/false is the safe default: an install that hits a conflict without
   * this flag FAILS with an explanation rather than pinning, so a caller that
   * forgets to ask fails closed.
   */
  acceptNameConflict?: boolean;
}

/** A module of a resolved library, with its integrity-verified source.
 *  Mirrors `ResolvedLibraryModule`. */
export interface ResolvedLibraryModule {
  id: string;
  name: string;
  description: string | null;
  source: string;
  /** SHA-256 of the signed module ARTIFACT bytes (registry integrity identity). */
  artifactSha256: string;
}

/** A resolved + signature-verified library package version.
 *  Mirrors `ResolvedLibrary`. */
export interface ResolvedLibrary {
  package: string;
  resolvedVersion: string;
  pin: string;
  description: string;
  author: string;
  publisherName: string;
  publisherKey: string;
  /** "firstUse" (key newly pinned) or "verified" (matched the prior TOFU pin). */
  trustStatus: string;
  modules: ResolvedLibraryModule[];
}

// ============================================================================
// Closure (what the frontend derives from the verified sources)
// ============================================================================

/** What one module's pragmas declare. Derived by trusted host code from the
 *  verified source — never from a manifest field a publisher could contradict. */
export interface ModulePragmas {
  /** `// @export <name>` — the ONLY names an importer can call. */
  exports: string[];
  /** `// @capability <id>` — the module's OWN declared ceiling (pre-intersection). */
  capabilities: CapabilityId[];
  /** `// @capability net.fetch <origin>` origins. */
  netOrigins: string[];
  /** `// @uses <alias> <package>@<pin>` — this module's own dependencies. */
  uses: LibraryUseDeclaration[];
}

/** One `// @uses` declaration parsed out of a script source. */
export interface LibraryUseDeclaration {
  /** The local alias the script binds the library to (`imports.<alias>`). */
  alias: string;
  package: string;
  pin: string;
  /** `// @uses-isolated` — force a realm private to this consumer (no shared
   *  module state with other consumers at the same ceiling). */
  isolated: boolean;
}

/** A node of the flattened dependency closure: a resolved package plus the
 *  pragma-derived facts about its modules. */
export interface LibraryClosureNode {
  library: ResolvedLibrary;
  /** Per-module pragmas, keyed by module id (same order as library.modules). */
  pragmas: Record<string, ModulePragmas>;
  /** The union of every module's declared capabilities — this package's own
   *  ceiling BEFORE intersection with any consumer. */
  declaredCapabilities: CapabilityId[];
  /** Union of every module's declared net.fetch origins. */
  declaredNetOrigins: string[];
  /** Packages that pulled this node in. Empty = requested directly by the user. */
  requiredBy: string[];
  /** Dependency edges declared by this package's modules. */
  uses: LibraryUseDeclaration[];
}

/** The full resolved closure for an install/update decision. */
export interface LibraryClosure {
  /** The registry the closure was resolved from. */
  registry: string;
  /** Topologically ordered (dependencies before dependents). */
  nodes: LibraryClosureNode[];
  /** The packages the user asked for (the closure roots). */
  roots: string[];
}

// ============================================================================
// Lockfile (.calcula/script-deps.json)
// ============================================================================

/** A locked module: the exact source the workbook will mount, by hash. */
export interface LockedModule {
  id: string;
  name: string;
  /** SHA-256 of the SOURCE text (the consent-store identity). */
  sourceHash: string;
  /** SHA-256 of the signed registry artifact (the registry identity). */
  artifactSha256: string;
  exports: string[];
  capabilities: CapabilityId[];
  /** Declared `net.fetch` origins. Intersected with the consumer's at link time
   *  so a library can never name a host its importer did not disclose. */
  netOrigins: string[];
}

/** One locked library package. */
export interface LockedLibrary {
  package: string;
  /** The pin as declared, retained so an update check can re-resolve it. */
  pin: string;
  /** The exact version this workbook is bound to. */
  resolved: string;
  /** The registry it was installed from (an update check re-resolves here). */
  registry: string;
  publisherKey: string;
  publisherName: string;
  modules: LockedModule[];
  /** Direct dependency edges, already present in this lockfile. */
  uses: Array<{ alias: string; package: string; pin: string; isolated: boolean }>;
  /** Packages that required this one; empty = a direct (user-requested) install. */
  requiredBy: string[];
  installedAt: string;
}

/** `.calcula/script-deps.json`. */
export interface LibraryLockfile {
  version: 1;
  libraries: LockedLibrary[];
}

// ============================================================================
// Link-time results
// ============================================================================

/** What happened when one alias was linked for a consumer script. */
export interface LinkedImport {
  alias: string;
  package: string;
  resolvedVersion: string;
  /** The library realm's broker scriptId (audit + transparency join key). */
  libraryScriptId: string;
  /** The exports actually bound on `imports.<alias>`. */
  exports: string[];
  /** effective = declared(library) INTERSECT effective(consumer). */
  effectiveCapabilities: CapabilityId[];
  /** Capabilities the library declared that the CONSUMER did not — dropped from
   *  the effective ceiling, so calls using them fail with PermissionDenied.
   *  Surfaced so the narrowing is visible instead of a mystery runtime error. */
  narrowedCapabilities: CapabilityId[];
  isolated: boolean;
}

/** Everything the linker produced for one consumer script. */
export interface LinkResult {
  /** The single-line prelude prepended to the consumer's source. Empty when the
   *  script declares no imports. */
  prelude: string;
  imports: LinkedImport[];
  /** Unmount callbacks for realms this link mounted (ref-counted). */
  release: () => void;
}

/** Thrown when a script cannot be linked. Never a silent `undefined`. */
export class LibraryLinkError extends Error {
  /** Machine-readable reason, for tests and UI branching. */
  reason:
    | "unresolved-alias"
    | "version-drift"
    | "integrity"
    | "consent-required"
    | "cycle"
    | "realm-budget"
    | "malformed";
  constructor(reason: LibraryLinkError["reason"], message: string) {
    super(message);
    this.name = "LibraryLinkError";
    this.reason = reason;
  }
}

/** One entry of an update check. */
export interface LibraryUpdateStatus {
  package: string;
  current: string;
  /** The version the pin resolves to NOW, or null when the registry is
   *  unreachable / the package is gone. */
  available: string | null;
  error: string | null;
  /** A module source differs from what was consented. */
  sourceChanged: boolean;
  /** The declared capability set differs from what was consented. */
  capabilityChanged: boolean;
  /** New capabilities the update would introduce. */
  addedCapabilities: CapabilityId[];
  /** Packages the update would ADD to this workbook's closure. A new transitive
   *  dependency is code the user never approved, so it re-prompts exactly like a
   *  source change — this field is what lets the UI say so before they click. */
  newDependencies: string[];
  /** The publisher's signing key changed (TOFU pin would have to move). */
  publisherKeyChanged: boolean;
}

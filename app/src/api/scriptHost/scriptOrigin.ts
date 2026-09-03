//! FILENAME: app/src/api/scriptHost/scriptOrigin.ts
// PURPOSE: The TRUST ORIGIN of a script, as a discriminated union rather than a
//          string. This is the single definition every gate, every trust
//          comparison and every provenance band reads. Leaf module: it imports
//          NOTHING, so the broker (broker.ts), the capability store
//          (capabilities.ts), the dialog registry (scriptDialogs.ts), the form
//          spec (scriptFormSpec.ts) and the trusted renderers can all agree on
//          one definition without forming an import cycle.
//
// WHY IT IS NOT A STRING
//
// `ScriptHandle.origin` used to be a `string` carrying two different things in
// one namespace: the sentinel `"local"` for workbook-authored scripts, and the
// PUBLISHER-CHOSEN application name for distributed ones. A publisher who named
// their application `local` therefore minted a handle indistinguishable from the
// user's own code, and FOUR security gates plus TWO provenance bands read that
// sentinel:
//
//   1. maybeRequestCapabilityGrant (host.ts) — a package named `local` got the
//      LOCAL JIT-prompt path, i.e. capabilities from a prompt in the moment
//      instead of from package consent, which is a deliberately higher bar.
//   2. restoreAndSyncGrants (capabilities.ts) — it would pick up capability
//      grants persisted for a LOCAL script with the same id and source hash.
//   3. persistAlwaysGrant (capabilities.ts) — it would PERSIST its own grants
//      into the local-script store, outside the package-consent record.
//   4. sameTrustOrigin (broker.ts) — it became same-origin with the user's own
//      scripts and could call their NON-PUBLIC exposed methods and open their
//      forms.
//   5/6. The ui.dialog band and the Permissions panel tag claimed it came from
//      this workbook.
//
// WHY A UNION AND NOT A PREFIX. `"pkg:" + name` would close the hole with less
// churn, but it leaves a STRING that still looks comparable: `handle.origin ===
// "local"` keeps compiling, `handle.origin === somePackageName` keeps compiling,
// and the next person to add a gate writes the same defect again with the same
// syntax. The union deletes the syntax. There is no value of type `ScriptOrigin`
// that a publisher can type, `origin === "local"` is a type error, and a new gate
// has to write `origin.kind === "local"` — where `kind` is a closed set of three
// literals that no manifest field feeds. The name survives only as `.name`, pure
// content, on the one variant that is already known not to be local.

/** Code authored in THIS workbook (object scripts, notebooks, UDF libraries). */
export interface LocalOrigin {
  readonly kind: "local";
}

/**
 * Code that arrived inside a distributed application (a `.calp`) or a
 * distributed extension bundle. `name` is publisher-chosen CONTENT — it is
 * displayed and compared package-to-package, and it can never select a `kind`.
 */
export interface PackageOrigin {
  readonly kind: "package";
  readonly name: string;
}

/**
 * A DRY RUN. Not mounted, registered nowhere, and same-origin with NOTHING —
 * including another preview. See `buildPreviewHandle` (broker.ts).
 */
export interface PreviewOrigin {
  readonly kind: "preview";
}

/** The origin of a script the workbook actually MOUNTS. Never a preview. */
export type MountOrigin = LocalOrigin | PackageOrigin;

/** Every trust origin a `ScriptHandle` can carry. */
export type ScriptOrigin = MountOrigin | PreviewOrigin;

/** The one local value. Frozen: a shared singleton must not be mutated into a
 *  package by a careless caller. */
export const LOCAL_ORIGIN: LocalOrigin = Object.freeze({ kind: "local" });

/** The one preview value. */
export const PREVIEW_ORIGIN: PreviewOrigin = Object.freeze({ kind: "preview" });

/**
 * The stand-in name for a distributed script whose definition carries no package
 * name. One spelling, so the trust handle, the identity band and the transparency
 * panel describe one publisher one way.
 */
export const UNKNOWN_PACKAGE_NAME = "(unknown package)";

/** Build a package origin. An empty/absent name falls back to the placeholder. */
export function packageOrigin(name?: string | null): PackageOrigin {
  return Object.freeze({ kind: "package", name: name || UNKNOWN_PACKAGE_NAME });
}

/**
 * The origin of a MOUNTED script, from its authoritative definition.
 *
 * Derived from `provenance` — the field the pull path stamps
 * (`core/calp/src/pull.rs`) — and NEVER from the package name, which stays pure
 * content. This is the only function that turns a definition into an origin, so
 * every mount path (object scripts, extension workers, UDF libraries) spells the
 * derivation once.
 */
export function scriptOriginForMount(definition: {
  provenance?: string;
  packageName?: string;
}): MountOrigin {
  return definition.provenance === "distributed"
    ? packageOrigin(definition.packageName)
    : LOCAL_ORIGIN;
}

/**
 * The origin of a STORED artifact, from the provenance ITS OWN RECORD carries.
 *
 * The sibling of `scriptOriginForMount`, for the other half of the store: an
 * object script arrives with a `provenance` string, while a MODULE script
 * arrives with `source_package` — the field `core/calp/src/pull.rs` stamps on
 * every module it materializes out of a `.calp`, and which
 * `materialize_distributed_scripts` (app/src-tauri/src/calp_commands.rs) writes
 * into the workbook script map verbatim. `get_script` returns it as
 * `sourcePackage`.
 *
 * That field is the ONLY authority on whether a module is the user's or a
 * publisher's. A run path that hard-codes an origin instead of reading it is
 * asserting provenance it did not derive — which is exactly how a distributed
 * module came to run with LOCAL provenance and the UNLOCKED tier.
 *
 * An empty or whitespace-only package name is not a package: it is a record
 * with nothing stamped on it, so it is local. A non-empty one can never select
 * the local kind, for the same reason a publisher-chosen name cannot anywhere
 * else in this module.
 */
export function scriptOriginForStoredRecord(record: {
  sourcePackage?: string | null;
}): MountOrigin {
  const name = typeof record.sourcePackage === "string" ? record.sourcePackage.trim() : "";
  return name === "" ? LOCAL_ORIGIN : packageOrigin(name);
}

/**
 * The tier a mount of `origin` may run at, given the tier the caller wanted.
 *
 * Distributed code is capped at `restricted` no matter what was asked for:
 * `unlocked` is what makes `context.api` non-null and gives a script the full
 * cross-sheet surface, and a publisher's module has never earned that. A local
 * script keeps the caller's choice, because for local code the tier IS the
 * user's decision.
 *
 * This is a CAP, not a check. A caller that explicitly asks for `unlocked` on a
 * package artifact has a bug, and the run paths refuse it out loud rather than
 * downgrading it behind the caller's back — see `runObjectScriptOnce`.
 */
export function accessLevelForOrigin(
  origin: MountOrigin,
  requested: "restricted" | "unlocked",
): "restricted" | "unlocked" {
  return origin.kind === "package" ? "restricted" : requested;
}

/**
 * The mount-definition fields (`provenance` / `packageName`) that an origin
 * corresponds to — the inverse of `scriptOriginForMount`.
 *
 * One spelling of the string `"distributed"` on the way IN, matching the one
 * spelling on the way out. Two call sites hand-writing `provenance: "local"`
 * is how this defect existed at all.
 */
export function mountProvenanceForOrigin(
  origin: MountOrigin,
): { provenance: string; packageName?: string } {
  return origin.kind === "package"
    ? { provenance: "distributed", packageName: origin.name }
    : { provenance: "local" };
}

/** True for code authored in this workbook. The ONLY sanctioned local test. */
export function isLocalOrigin(origin: ScriptOrigin): origin is LocalOrigin {
  return origin.kind === "local";
}

/**
 * The package an origin names, or null when it names none.
 *
 * For surfaces that DISPLAY the publisher's name (the transparency panel's
 * "from package X", the scheduled-job owner column). They keep showing the name,
 * never an internal encoding — the encoding is `kind`, and it never leaves.
 */
export function originPackageName(origin: ScriptOrigin): string | null {
  return origin.kind === "package" ? origin.name : null;
}

/**
 * The R7 origin half of the trust predicate (the tier half lives with it in
 * `sameTrustOrigin`, broker.ts).
 *
 *  * two local scripts share an origin,
 *  * two scripts from the same package share an origin,
 *  * a local script and ANY package script do not — including a package named
 *    `local`, which is the whole point of this module,
 *  * a preview shares an origin with nothing at all, not even another preview.
 */
export function sameScriptOrigin(a: ScriptOrigin, b: ScriptOrigin): boolean {
  if (a.kind === "preview" || b.kind === "preview") return false;
  if (a.kind === "local") return b.kind === "local";
  return b.kind === "package" && a.name === b.name;
}

/** Short tag for a transparency chip: "local", the package name, or "preview". */
export function originTagLabel(origin: ScriptOrigin): string {
  switch (origin.kind) {
    case "local":
      return "local";
    case "package":
      return origin.name;
    default:
      return "preview";
  }
}

/** Hover text for that chip. */
export function originTagTitle(origin: ScriptOrigin): string {
  switch (origin.kind) {
    case "local":
      return "Authored in this workbook";
    case "package":
      return `From package "${origin.name}"`;
    default:
      return "A preview run — not mounted in this workbook";
  }
}

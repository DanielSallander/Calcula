//! FILENAME: app/src/api/scriptLibraries/linker.ts
// PURPOSE: The import mechanism. Resolves a consuming script's `// @uses`
//          declarations against the WORKBOOK LOCKFILE, mounts each library in
//          its own worker realm at the INTERSECTED capability ceiling, and
//          generates the one-line `imports` prelude the consumer's source is
//          prefixed with.
// CONTEXT: docs/design/script-package-manager.md §5-§6. Called by
//          ObjectScriptManager.mountScript and by the Custom Functions library
//          installer — the two places that hand a source to hostMountScript.
//
// SECURITY — read this before changing anything here.
//
//  (1) THE IMPORT MAP IS HOST STATE, NOT SCRIPT INPUT. A script names an ALIAS;
//      trusted code here turns that alias into a realm, using the script's own
//      authoritative source and the workbook lockfile. A script can never name a
//      target the host did not resolve for it, and an alias that is not in the
//      lockfile is a MOUNT error — a script never starts with a dangling import.
//
//  (2) A LIBRARY CANNOT WIDEN ITS CONSUMER. Each realm is mounted with
//      `declaredCapabilities = declared(library) INTERSECT declared(consumer)`
//      (ceiling.ts). Enforcement is the existing R19 gate in the broker, which
//      denies anything outside that set BEFORE the grant check, so it is not
//      even JIT-promptable. Nothing here can be bypassed by the library's own
//      source, because buildHandleFromDefinition takes the ceiling from its
//      caller. A library that declares `net.fetch` and is imported by a consumer
//      that does not gets a realm WITHOUT `net.fetch`, and its fetch fails with
//      PermissionDenied naming the capability.
//
//  (3) CALL AUTHORIZATION IS CALLER IDENTITY. THERE IS NO CREDENTIAL.
//      The relay is `base.callImport` (allowlist.ts + host.ts + contextShims.ts).
//      A consumer names one of ITS OWN aliases; the host resolves that alias in
//      the import table registered for the CALLING script's mount id, which is
//      trusted state this module wrote from that script's own `// @uses`
//      pragmas. The consumer never learns — and never needs — the realm's
//      address. Consequences worth stating explicitly:
//        * A script that did not declare the alias has no table entry and is
//          refused. Nothing it could be told or given changes that.
//        * There is no bearer token any more. The previous design minted a
//          128-bit token per (realm, consumer) and baked it into the prelude;
//          that authorized possession rather than identity, so a consumer could
//          delegate its entire library reach by leaking a string, undetectably,
//          and the library could never be told who was really calling. Both of
//          this feature's documented residuals traced to that.
//        * The realm's entry point is exposed NON-public AND under
//          `HOST_ONLY_EXPOSED_PREFIX`, which `callExposed` refuses for every
//          script before it even looks the name up. `hostCallExposed` (trusted
//          host code) is the only door. The prefix rule is what closes the
//          same-origin case a `public: false` flag alone would not: a
//          distributed script shipped in package P is SAME-TRUST with a library
//          realm mounted for package P, and would otherwise have been allowed
//          straight past the host's authorization.
//        * Because the caller is known per call, the host can also cap the call
//          by the CALLER's own grants — see (6).
//
//  (4) REALM SHARING IS A COVERT CHANNEL, BOUNDED ON PURPOSE. Consumers with the
//      SAME effective ceiling and tier share one realm, so module-level state is
//      shared between them. That is strictly narrower than a `public: true`
//      export (which every script could reach) but it is not zero, so
//      `// @uses-isolated` forces a realm private to one consumer, and the total
//      realm count is capped rather than degrading silently.
//
//      THE SHARING KEY MUST CONTAIN EVERY AXIS OF THE CEILING, NOT JUST THE
//      CAPABILITY SET. `net.fetch` is granted per ORIGIN, and the origins are
//      intersected with the consumer's exactly as the capabilities are — so if
//      the key omitted them, the first consumer to mount a realm would fix its
//      origin allowlist for every later sharer. A consumer that declared only
//      `https://b.example` would then inherit a realm granted `https://a.example`
//      and reach a host it never disclosed: the same laundering (4) exists to
//      prevent, one axis over. `realmKey` therefore keys on the resolved origin
//      set as well.
//
//  (5) A LIBRARY'S OWN `// @uses` IS LINKED THE SAME WAY, ONE LEVEL NARROWER.
//      A dependency realm is mounted at `declared(dep) INTERSECT effective(parent)`
//      (ceiling.chainCeiling) with origins intersected against the PARENT's
//      resolved origins — never against the root consumer's. Intersecting a
//      depth-2 node against the root would silently re-widen whatever its parent
//      had already given up, which is the exact shape of a laundering chain
//      (a -> b -> c where b declares less than a but c declares more). The
//      dependency's realm is refcounted against its PARENT REALM's scriptId, so
//      releasing the last consumer of the parent cascades.
//
//  (6) THE CEILING IS INTERSECTED HERE; THE GRANTS ARE INTERSECTED PER CALL.
//      This module decides what a realm MAY hold (ceiling.ts) and mounts it with
//      exactly that. It cannot decide whether the CONSUMER has been granted the
//      same things, because at link time the consumer legitimately holds
//      nothing: grants are just-in-time, so the first USE is the prompt. That is
//      why the second half of the rule lives in host.ts's `authorizeImportCall`,
//      which runs on every call and requires the caller to hold — or be prompted
//      for — whatever the realm holds. What this module contributes to it is the
//      `capabilities`/`netOrigins` recorded on each binding below: they are the
//      realm's ACTUAL mounted set, so the per-call check is measured against
//      what the realm can really do, not against what the library asked for.

import {
  clearScriptImports,
  hostMountScript,
  hostUnmountScript,
  registerScriptImports,
  type LibraryImportBinding,
} from "../scriptHost/host";
import { HOST_ONLY_EXPOSED_PREFIX } from "../scriptHost/broker";
import { applyConsentedCapabilities } from "../scriptHost/capabilities";
import type { CapabilityId } from "../scriptHost/capabilityIds";
// TYPE-ONLY: scriptableObjects.ts imports this module (mountScript links before
// it mounts), so a value import here would close a runtime cycle. The api
// version is the same literal the sibling library installers pass.
import type { ScriptAccessLevel } from "../scriptableObjects";
import { loadConsents, isConsentCurrent } from "../distributedConsent";
import { consentKeyFor } from "./consentKey";
import {
  chainCeiling,
  intersectCeiling,
  intersectOrigins,
  type ConsumerCeiling,
  type EffectiveCeiling,
} from "./ceiling";
import { findLocked, loadLockfile, readLockedSource } from "./lockfile";
import { parseUses } from "./usesPragma";
import type {
  LibraryLockfile,
  LibraryUseDeclaration,
  LinkResult,
  LinkedImport,
  LockedLibrary,
} from "./types";
import { LibraryLinkError } from "./types";

/** Object type the library realms mount under. Reusing "workbook" (as the
 *  Custom Functions library already does) keeps them out of the object-script
 *  instance space; the reserved instanceId prefix keeps them out of each
 *  other's. */
const LIB_OBJECT_TYPE = "workbook";
/** Realm budget. A library imported at many distinct ceilings spawns many
 *  realms; fail the mount loudly rather than degrade silently. */
const MAX_REALMS = 24;

/** The name the generated prelude binds in the consumer's scope. */
export const IMPORTS_BINDING = "imports";

/**
 * The realm's single relay entry point. Named inside the host-only namespace so
 * `callExposed` refuses it for EVERY script (broker.ts), regardless of tier,
 * origin or the `public` flag — the host is the only caller, and that is what
 * makes `authorizeImportCall` unbypassable rather than merely usual.
 */
export const REALM_ENTRY_METHOD = `${HOST_ONLY_EXPOSED_PREFIX}callImport`;

// ============================================================================
// Realm registry
// ============================================================================

interface LibraryRealm {
  key: string;
  scriptId: string;
  instanceId: string;
  package: string;
  version: string;
  exports: string[];
  effective: EffectiveCeiling;
  /**
   * Consumers currently linked to this realm, each with the ALIASES it bound the
   * package under. A SET, not a count: one script may bind the same package
   * twice (`// @uses a acme.x` and `// @uses b acme.x`), and each alias is
   * released independently, so collapsing them would either unmount the realm
   * while one alias was still live or leak it after both were gone.
   *
   * A key here is either a CONSUMER SCRIPT's id or — for a transitive
   * dependency — the PARENT REALM's scriptId, so the refcount is uniform and a
   * dependency cannot outlive the realm that imported it.
   */
  consumers: Map<string, Set<string>>;
  /**
   * The realms this realm imports (its own `// @uses`), with the alias each was
   * bound under. Released when this realm's last consumer goes away, so a chain
   * a -> b -> c collapses in one pass instead of leaking b and c.
   */
  deps: Array<{ realm: LibraryRealm; alias: string }>;
  /** The net.fetch origins this realm was granted (transparency + key input). */
  netOrigins: string[];
}

const realms = new Map<string, LibraryRealm>();

/** Mounted library realms, for the transparency panel / tests. */
export function listLibraryRealms(): Array<{
  scriptId: string;
  package: string;
  version: string;
  exports: string[];
  capabilities: CapabilityId[];
  netOrigins: string[];
  tier: ScriptAccessLevel;
  consumers: string[];
  /** Packages this realm itself imports (transitive `// @uses`). */
  dependencies: string[];
}> {
  return [...realms.values()].map((r) => ({
    scriptId: r.scriptId,
    package: r.package,
    version: r.version,
    exports: [...r.exports],
    capabilities: [...r.effective.capabilities],
    netOrigins: [...r.netOrigins],
    tier: r.effective.tier,
    consumers: [...r.consumers.keys()],
    dependencies: r.deps.map((d) => d.realm.package),
  }));
}

/** Unmount every library realm (workbook close / test reset). */
export function resetScriptLibraryRealms(): void {
  for (const realm of realms.values()) {
    // The realm's OWN import table (its transitive deps) goes with it, or a
    // remounted realm reusing the id would inherit bindings to realms that no
    // longer exist.
    clearScriptImports(realm.scriptId);
    try {
      hostUnmountScript(realm.scriptId);
    } catch {
      /* best-effort */
    }
  }
  realms.clear();
  for (const consumerScriptId of preludes.keys()) {
    clearScriptImports(consumerScriptId);
  }
  preludes.clear();
}

// ============================================================================
// Id generation
// ============================================================================

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ============================================================================
// Generated sources
// ============================================================================

/**
 * The library realm's script source: every module of the package, each built in
 * its own function scope, behind ONE host-only dispatcher.
 *
 * Only names the module declared with `// @export` are routable, so "what can
 * this library be asked to do" is answerable from its source text — a function
 * the module returns but never declared is unreachable.
 *
 * The dispatcher takes NO credential. It does not need one and must not have
 * one: it is reachable only through `hostCallExposed`, and the host has already
 * established (a) that the calling script declared an import of this package and
 * (b) that the caller's own grants cover what this realm holds. A second check
 * inside the realm would be a check written by the SAME untrusted supply chain
 * the outer one exists to contain.
 */
export function generateLibraryRealmSource(
  modules: Array<{ id: string; exports: string[]; source: string }>,
): string {
  const built = modules
    .map(
      (m) =>
        `  MODULES.push({ id: ${JSON.stringify(m.id)}, exports: ${JSON.stringify(m.exports)}, build: function (context) {\n` +
        `${m.source}\n` +
        `    if (typeof library !== "function") { throw new Error("Calcula library module " + ${JSON.stringify(m.id)} + " must define function library(context)."); }\n` +
        `    return library(context) || {};\n` +
        `  } });`,
    )
    .join("\n");

  return (
    `function setup(context) {\n` +
    `  var MODULES = [];\n` +
    `${built}\n` +
    `  var apis = {};\n` +
    `  function apiFor(m) {\n` +
    `    if (!apis[m.id]) { apis[m.id] = m.build(context); }\n` +
    `    return apis[m.id];\n` +
    `  }\n` +
    // NON-public AND host-only-namespaced. Either alone would leave a hole:
    // `public: false` still admits a SAME-ORIGIN script (a distributed script
    // from the same package as the library), and the prefix rule is what makes
    // the refusal unconditional. See broker.ts HOST_ONLY_EXPOSED_PREFIX.
    `  context.expose(${JSON.stringify(REALM_ENTRY_METHOD)}, async function (method, args) {\n` +
    `    for (var i = 0; i < MODULES.length; i++) {\n` +
    `      var m = MODULES[i];\n` +
    `      if (m.exports.indexOf(method) < 0) continue;\n` +
    `      var api = apiFor(m);\n` +
    `      var fn = api ? api[method] : null;\n` +
    `      if (typeof fn !== "function") { throw new Error("Library module " + m.id + " declares export '" + method + "' but does not implement it."); }\n` +
    `      return await fn.apply(null, Array.isArray(args) ? args : []);\n` +
    `    }\n` +
    `    throw new Error("'" + method + "' is not an export of this library.");\n` +
    `  }, { public: false });\n` +
    `}\n`
  );
}

/**
 * The consumer prelude: binds `imports.<alias>.<export>(...)` to
 * `context.callImport(alias, export, args)`.
 *
 * WHAT IS NO LONGER IN IT. The realm's instanceId and the per-consumer bearer
 * token both used to be baked in here, because the prelude WAS the address book
 * and the credential. Neither is present now, and the difference is not
 * cosmetic: the prelude is injected into the consumer's own realm, so anything
 * it contains is readable BY the consumer's code and could be forwarded to a
 * peer. What remains is only the alias and the declared export names — facts the
 * script's own source already states — so there is nothing here whose disclosure
 * grants anything. The address and the authority both live host-side now.
 *
 * Emitted as ONE line so it does not shift the user's line numbers in stack
 * traces, and retrievable via `getGeneratedPrelude` so the transparency panel
 * can show exactly what was injected.
 *
 * `context` resolves to the worker bootstrap's wrapper parameter (bootstrap.ts
 * compiles `function (context) { <source>; return setup(context); }`), so the
 * prelude can bind at the source's top level without touching contextShims.
 */
export function generatePrelude(
  specs: Array<{ alias: string; package: string; exports: string[] }>,
): string {
  if (specs.length === 0) return "";
  const table = JSON.stringify(specs.map((s) => ({ a: s.alias, p: s.package, e: s.exports })));
  return (
    `const ${IMPORTS_BINDING} = (function (c) { var S = ${table}; var o = {}; ` +
    `for (var i = 0; i < S.length; i++) { (function (s) { var t = {}; ` +
    `for (var j = 0; j < s.e.length; j++) { (function (n) { t[n] = function () { ` +
    `return c.callImport(s.a, n, Array.prototype.slice.call(arguments)); ` +
    `}; })(s.e[j]); } ` +
    `o[s.a] = new Proxy(Object.freeze(t), { get: function (x, p) { if (typeof p !== "string" || p in x) return x[p]; ` +
    `throw new Error("Library '" + s.a + "' (" + s.p + ") does not export '" + String(p) + "'. Declared exports: " + s.e.join(", ") + "."); } }); ` +
    `})(S[i]); } ` +
    `return new Proxy(Object.freeze(o), { get: function (x, p) { if (typeof p !== "string" || p in x) return x[p]; ` +
    `throw new Error("This script did not declare a library aliased '" + String(p) + "' with a // @uses pragma."); } }); ` +
    `})(context);\n`
  );
}

// ============================================================================
// Linking
// ============================================================================

/** The consumer facts a link decision needs. Built from the script's
 *  authoritative definition by trusted host code. */
export interface LinkRequest {
  scriptId: string;
  scriptName: string;
  source: string;
  declaredCapabilities: readonly CapabilityId[];
  declaredNetOrigins?: readonly string[];
  accessLevel: ScriptAccessLevel;
}

const preludes = new Map<string, string>();

/** The prelude currently injected into a script (transparency panel / tests). */
export function getGeneratedPrelude(scriptId: string): string | null {
  return preludes.get(scriptId) ?? null;
}

/**
 * The realm-sharing key. EVERY axis of the effective ceiling must appear here:
 * the package + exact version, the capability set and tier (`effective.key`),
 * AND the resolved net.fetch origins. Omitting the origins would let the first
 * consumer to mount a realm fix its origin allowlist for every later sharer —
 * see SECURITY note (4).
 */
function realmKey(
  locked: LockedLibrary,
  effective: EffectiveCeiling,
  netOrigins: readonly string[],
  isolatedFor: string | null,
): string {
  return (
    `${locked.package}@${locked.resolved}|${effective.key}|net:${[...netOrigins].sort().join(",")}` +
    `${isolatedFor ? `|iso:${isolatedFor}` : ""}`
  );
}

/** The shared, per-link facts every resolution step needs. */
interface LinkContext {
  lockfile: LibraryLockfile;
  consents: Awaited<ReturnType<typeof loadConsents>>;
  /** Named in every error so the user knows which script failed to start. */
  consumerLabel: string;
}

/**
 * Resolve ONE `// @uses` declaration to a mounted realm, at the ceiling the
 * caller's `narrow` function computes.
 *
 * `narrow` is the single place the two intersection rules differ: a top-level
 * consumer passes `intersectCeiling(declared, consumer)`; a library resolving
 * its OWN dependency passes `chainCeiling(declared, parentEffective)`, so a
 * depth-2 node is capped by its parent rather than by the root.
 */
async function acquireRealm(
  ctx: LinkContext,
  use: LibraryUseDeclaration,
  narrow: (libraryDeclared: CapabilityId[]) => EffectiveCeiling,
  availableOrigins: readonly string[],
  isolationOwner: string,
  path: readonly string[],
): Promise<{ realm: LibraryRealm; effective: EffectiveCeiling; locked: LockedLibrary }> {
  const locked = findLocked(ctx.lockfile, use.package);
  if (!locked) {
    throw new LibraryLinkError(
      "unresolved-alias",
      `${ctx.consumerLabel} declares "// @uses ${use.alias} ${use.package}@${use.pin}", but "${use.package}" is not installed in this workbook. Install it from Scripts > Script Libraries.`,
    );
  }
  if (locked.pin !== use.pin) {
    throw new LibraryLinkError(
      "version-drift",
      `${ctx.consumerLabel} requires ${use.package}@${use.pin}, but this workbook is locked to ${use.package}@${locked.pin} (resolved ${locked.resolved}). Update the lockfile or the pragma — a silent version substitution is never made.`,
    );
  }

  // Consent must be CURRENT for the exact sources we are about to run: a source
  // swap or a capability expansion since the user approved this package must
  // stop the mount, not inherit the old approval. Checked for TRANSITIVE nodes
  // too — `applyInstall` records consent per package, so a dependency has its
  // own record and must satisfy it in its own right.
  const scripts: Array<{ id: string; source: string }> = [];
  for (const mod of locked.modules) {
    scripts.push({ id: mod.id, source: await readLockedSource(mod.sourceHash) });
  }
  if (!(await isConsentCurrent(ctx.consents, consentKeyFor(locked.package), scripts))) {
    throw new LibraryLinkError(
      "consent-required",
      `Library ${locked.package}@${locked.resolved} has changed since it was approved in this workbook. Review and re-approve it in Scripts > Script Libraries before ${ctx.consumerLabel} can run.`,
    );
  }

  const libraryDeclared = [...new Set(locked.modules.flatMap((m) => m.capabilities))];
  const effective = narrow(libraryDeclared);
  const netOrigins = intersectOrigins(
    locked.modules.flatMap((m) => m.netOrigins ?? []),
    availableOrigins,
  );
  const key = realmKey(locked, effective, netOrigins, use.isolated ? isolationOwner : null);
  const existing = realms.get(key);
  const realm = existing ?? (await mountRealm(ctx, locked, effective, netOrigins, key, path));
  return { realm, effective, locked };
}

/**
 * Record that `consumerId` holds this realm under `alias` (the refcount).
 *
 * Nothing is installed INTO the realm — there is no credential to install. The
 * realm does not know, and does not need to know, who its consumers are; the
 * host's import table is the authorization record, and this map exists only so
 * the realm is unmounted when the last alias that named it goes away.
 */
function linkConsumer(realm: LibraryRealm, consumerId: string, alias: string): void {
  const aliases = realm.consumers.get(consumerId) ?? new Set<string>();
  aliases.add(alias);
  realm.consumers.set(consumerId, aliases);
}

/** The host-side binding a consumer's `imports.<alias>` resolves through. */
function bindingFor(realm: LibraryRealm, alias: string): LibraryImportBinding {
  return {
    alias,
    package: realm.package,
    version: realm.version,
    libraryScriptId: realm.scriptId,
    objectType: LIB_OBJECT_TYPE,
    instanceId: realm.instanceId,
    entryMethod: REALM_ENTRY_METHOD,
    exports: [...realm.exports],
    // The realm's ACTUAL mounted ceiling, not the library's declaration: this is
    // what host.ts measures the caller's grants against per call.
    capabilities: [...realm.effective.capabilities],
    netOrigins: [...realm.netOrigins],
  };
}

async function mountRealm(
  ctx: LinkContext,
  locked: LockedLibrary,
  effective: EffectiveCeiling,
  netOrigins: string[],
  key: string,
  path: readonly string[],
): Promise<LibraryRealm> {
  // A lockfile written by `applyInstall` is cycle-free (resolveClosure rejects
  // cycles), but a hand-edited .cala is untrusted input — recursing on one would
  // hang the mount instead of failing it.
  if (path.includes(locked.package)) {
    throw new LibraryLinkError(
      "cycle",
      `Library dependency cycle: ${[...path, locked.package].join(" -> ")}.`,
    );
  }
  if (realms.size >= MAX_REALMS) {
    throw new LibraryLinkError(
      "realm-budget",
      `Too many distinct library realms are mounted (max ${MAX_REALMS}). Align the capability declarations of the importing scripts so they can share realms.`,
    );
  }

  const modules: Array<{ id: string; exports: string[]; source: string }> = [];
  const seenExports = new Map<string, string>();
  for (const mod of locked.modules) {
    const source = await readLockedSource(mod.sourceHash);
    for (const name of mod.exports) {
      const owner = seenExports.get(name);
      if (owner) {
        throw new LibraryLinkError(
          "malformed",
          `${locked.package}@${locked.resolved}: modules '${owner}' and '${mod.id}' both export '${name}'.`,
        );
      }
      seenExports.set(name, mod.id);
    }
    modules.push({ id: mod.id, exports: mod.exports, source });
  }

  const scriptId = `__calcula_lib__:${locked.package}@${locked.resolved}:${randomHex(8)}`;
  const instanceId = `__lib_${randomHex(16)}`;

  // ---- This library's OWN imports, one level narrower (SECURITY note (5)).
  // Mounted BEFORE this realm so its import table exists before any of its code
  // can run, and refcounted against THIS realm's scriptId so they cannot outlive
  // it.
  const deps: Array<{ realm: LibraryRealm; alias: string }> = [];
  const depSpecs: Array<{ alias: string; package: string; exports: string[] }> = [];
  const depBindings: LibraryImportBinding[] = [];
  const depLabel = `library ${locked.package}@${locked.resolved}`;
  const undoDeps = (): void => {
    clearScriptImports(scriptId);
    for (const { realm, alias } of deps) releaseRealm(realm, scriptId, alias);
  };
  try {
    for (const use of locked.uses) {
      const dep = await acquireRealm(
        { ...ctx, consumerLabel: depLabel },
        { alias: use.alias, package: use.package, pin: use.pin, isolated: use.isolated },
        (declared) => chainCeiling(declared, effective),
        netOrigins,
        key,
        [...path, locked.package],
      );
      linkConsumer(dep.realm, scriptId, use.alias);
      deps.push({ realm: dep.realm, alias: use.alias });
      depSpecs.push({
        alias: use.alias,
        package: dep.realm.package,
        exports: dep.realm.exports,
      });
      depBindings.push(bindingFor(dep.realm, use.alias));
    }
  } catch (e) {
    undoDeps();
    throw e;
  }

  // A library realm is a consumer too: its own `// @uses` resolve through the
  // SAME host-side table, keyed by this realm's scriptId. Registered before the
  // mount so no code of this realm can ever run against an absent table.
  registerScriptImports(scriptId, depBindings);

  // Grants for the realm: exactly the intersected ceiling. The consent record
  // for the package approved (at most) the library's own declared set; the
  // intersection can only narrow it further, never widen it.
  await applyConsentedCapabilities(scriptId, [...effective.capabilities], netOrigins);

  try {
    await hostMountScript({
      id: scriptId,
      name: `Library ${locked.package}@${locked.resolved}`,
      objectType: LIB_OBJECT_TYPE,
      instanceId,
      // The prelude binds `imports` in the wrapper scope the bootstrap compiles
      // (`function (context) { <source> }`), so every module body — which is
      // built inside `setup` — closes over it.
      source: generatePrelude(depSpecs) + generateLibraryRealmSource(modules),
      accessLevel: effective.tier,
      // "distributed" is the truth AND the safe choice: it gives the realm its own
      // trust origin (the library package) and suppresses JIT prompting, so the
      // realm can hold only what consent recorded. NOTE that the origin alone is
      // NOT what protects the relay entry point — a distributed script from the
      // same package would share this origin. The HOST_ONLY_EXPOSED_PREFIX rule
      // in broker.ts is what makes the entry point unreachable from any script.
      provenance: "distributed",
      packageName: locked.package,
      packageVersion: locked.resolved,
      declaredCapabilities: [...effective.capabilities],
      apiVersion: "1.0.0",
    });
  } catch (e) {
    undoDeps();
    throw e;
  }

  const realm: LibraryRealm = {
    key,
    scriptId,
    instanceId,
    package: locked.package,
    version: locked.resolved,
    exports: [...seenExports.keys()],
    effective,
    consumers: new Map(),
    deps,
    netOrigins,
  };
  realms.set(key, realm);
  return realm;
}

/**
 * Link one script's `// @uses` declarations. Returns the prelude to prepend and
 * a `release()` that revokes this consumer's import table (and unmounts realms
 * that no longer have a consumer).
 *
 * REVOCATION IS THE HOST TABLE, NOT THE REALM. `release()` deletes the script's
 * entry in host.ts's import map, and from that instant `imports.<alias>.x()`
 * from that script resolves to nothing — even if the realm is still mounted for
 * a different consumer, and even if the consumer's own code cached the bound
 * function. Under the retired token scheme revocation had to reach INTO the
 * realm to delete a string, which meant a realm that had crashed, hung or been
 * tampered with could keep honouring a credential the host had withdrawn.
 *
 * Throws `LibraryLinkError` — never returns a partially-linked result — when an
 * alias is unresolved, the lockfile drifted, a cached source fails its hash, or
 * consent for the package is not current.
 */
export async function linkScript(request: LinkRequest): Promise<LinkResult> {
  const parsed = parseUses(request.source);
  if (parsed.errors.length > 0) {
    throw new LibraryLinkError(
      "malformed",
      `Script "${request.scriptName}" has invalid import declarations:\n` + parsed.errors.join("\n"),
    );
  }
  if (parsed.uses.length === 0) {
    return { prelude: "", imports: [], release: () => undefined };
  }

  const ctx: LinkContext = {
    lockfile: await loadLockfile(),
    consents: await loadConsents(),
    consumerLabel: `Script "${request.scriptName}"`,
  };
  const consumer: ConsumerCeiling = {
    capabilities: request.declaredCapabilities,
    tier: request.accessLevel,
  };

  const specs: Array<{ alias: string; package: string; exports: string[] }> = [];
  const bindings: LibraryImportBinding[] = [];
  const imports: LinkedImport[] = [];
  const acquired: Array<{ realm: LibraryRealm; alias: string }> = [];

  const rollback = (): void => {
    // The table goes FIRST: while it exists the script can call, so a partial
    // link must stop being callable before its realms start being torn down.
    clearScriptImports(request.scriptId);
    for (const { realm, alias } of acquired) releaseRealm(realm, request.scriptId, alias);
    acquired.length = 0;
  };

  try {
    for (const use of parsed.uses) {
      const { realm, effective, locked } = await acquireRealm(
        ctx,
        use,
        (declared) => intersectCeiling(declared, consumer),
        request.declaredNetOrigins ?? [],
        request.scriptId,
        [],
      );
      linkConsumer(realm, request.scriptId, use.alias);
      acquired.push({ realm, alias: use.alias });

      specs.push({
        alias: use.alias,
        package: locked.package,
        exports: realm.exports,
      });
      bindings.push(bindingFor(realm, use.alias));
      imports.push({
        alias: use.alias,
        package: locked.package,
        resolvedVersion: locked.resolved,
        libraryScriptId: realm.scriptId,
        exports: [...realm.exports],
        effectiveCapabilities: [...effective.capabilities],
        narrowedCapabilities: [...effective.narrowed],
        isolated: use.isolated,
      });
    }
  } catch (e) {
    rollback();
    throw e;
  }

  // The authorization record. Everything above only decided WHAT the script may
  // reach; this is the only statement the host will act on at call time.
  registerScriptImports(request.scriptId, bindings);

  const prelude = generatePrelude(specs);
  preludes.set(request.scriptId, prelude);
  return {
    prelude,
    imports,
    release: () => {
      preludes.delete(request.scriptId);
      rollback();
    },
  };
}

function releaseRealm(realm: LibraryRealm, consumerScriptId: string, alias: string): void {
  const aliases = realm.consumers.get(consumerScriptId);
  if (!aliases || !aliases.delete(alias)) return;
  if (aliases.size === 0) realm.consumers.delete(consumerScriptId);
  if (realm.consumers.size === 0) {
    // Drop the registry entry FIRST: the cascade below re-enters this function,
    // and a cycle in a hand-edited lockfile must not become infinite recursion.
    realms.delete(realm.key);
    // This realm's own import table dies with it, so its dependencies stop being
    // reachable at the same instant they stop being refcounted.
    clearScriptImports(realm.scriptId);
    try {
      hostUnmountScript(realm.scriptId);
    } catch {
      /* best-effort */
    }
    const deps = realm.deps.splice(0, realm.deps.length);
    for (const dep of deps) releaseRealm(dep.realm, realm.scriptId, dep.alias);
  }
}

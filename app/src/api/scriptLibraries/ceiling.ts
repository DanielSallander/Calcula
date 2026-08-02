//! FILENAME: app/src/api/scriptLibraries/ceiling.ts
// PURPOSE: THE security rule of the script package manager, in one place:
//
//              effectiveCeiling(lib, consumer) = declared(lib) INTERSECT declared(consumer)
//              effectiveTier(lib, consumer)    = min(tier(lib), tier(consumer))
//              transitively: effective(dep)    = declared(dep) INTERSECT effective(parent)
//
//          A dependency can never do anything its importer could not have
//          declared for itself.
//
// WHY THE INTERSECTION AND NOT JUST THE LIBRARY'S OWN CEILING.
//          Without it you get a textbook confused deputy: a restricted consumer
//          that declared no `net.fetch` imports `acme.http`, which DOES declare
//          it, and calls `http.post(url, mySecrets)`. The library performs the
//          egress, the broker sees the LIBRARY's handle and allows it, and the
//          consumer has escaped its own ceiling purely by composition. That is
//          exactly how a supply-chain attack launders capability: nobody ever
//          consented to the consumer reaching the network, and the transitive
//          dependency did the reaching. Intersecting makes that call fail at the
//          library's own R19 gate, naming the missing capability, and the only
//          fix is for the CONSUMER to declare `net.fetch` in its own source —
//          which is the honest outcome, because that declaration is what the
//          transparency panel and the .calp consent prompt both read.
//
// WHAT THIS FILE COMPUTES, AND WHAT COMPLETES IT ELSEWHERE.
//          This file intersects DECLARED CEILINGS, not GRANTS, and it cannot do
//          otherwise: it runs at LINK time, and a consumer legitimately holds no
//          grants at link time — grants are just-in-time, so the first USE is
//          the prompt. Intersecting grants here would either deny every library
//          that needs anything or force a prompt before the script had done
//          anything at all.
//
//          The grant half of the rule therefore lives at CALL time, in
//          `authorizeImportCall` (scriptHost/host.ts), which the
//          `base.callImport` relay runs on every call:
//
//              a call through imports.<alias> is admitted only if the CALLER
//              holds a grant for every capability the realm was mounted with
//              (and, for net.fetch, for every origin it was granted) — with the
//              caller's own JIT prompt raised right there if it declared the
//              capability but was never asked.
//
//          Together: DECLARED(consumer) caps what the realm may hold, and
//          GRANTED(consumer) caps what any individual call may use. This closes
//          the residual Wave H documented here — a consumer that declared
//          `net.fetch` but had never been prompted causing egress through a
//          library the user approved at install time, skipping the consumer's
//          own prompt. It was unfixable then only because the bearer-token relay
//          could not tell the target who was calling; `base.callImport` resolves
//          the alias against host state keyed by the CALLING script's id, so the
//          caller is now known per call.
//
//          What this file's rule still does NOT say: a call is admitted on the
//          caller's grants for the realm's WHOLE capability set, not on the
//          capabilities that one export actually goes on to use. That is
//          deliberately conservative (it over-asks rather than under-asks) and
//          is a consequence of the realm being shared: per-call attribution
//          inside the realm would need the worker protocol to carry the calling
//          identity through to the realm's own outbound broker calls.
//
// WHY THE OTHER DIRECTION IS ALSO CLOSED.
//          The converse (a library borrowing the CONSUMER's grants) is closed by
//          construction, not by this file: grants are per-scriptId
//          (`getGrantSet`, scriptHost/broker.ts) and a library realm is mounted
//          under its own scriptId, so it holds only what its own consent
//          recorded. Intersecting the CEILING additionally caps what that
//          consent is even allowed to be.
//
// WHERE IT IS ENFORCED.
//          Nowhere in this file. This file only COMPUTES the set; the set is
//          handed to `hostMountScript` as `declaredCapabilities`, which
//          `buildHandleFromDefinition` (scriptHost/broker.ts) turns into
//          `handle.declaredCapabilities`, after which `checkPolicy` denies any
//          capability outside it with PermissionDenied *before* the grant check
//          — so it is not even JIT-promptable. A library's own source cannot
//          widen it, because `buildHandleFromDefinition` takes the ceiling from
//          its CALLER (this module, trusted host code) and never from the
//          script. The second enforcement point is the per-call grant check in
//          `authorizeImportCall` described above; the same computed set is what
//          the linker records on each import binding for it to measure against.

import type { CapabilityId } from "../scriptHost/capabilityIds";
import type { ScriptAccessLevel } from "../scriptableObjects";

/** The consumer side of the intersection: everything a link decision needs
 *  about the importing script. Built by trusted host code from the script's
 *  authoritative definition. */
export interface ConsumerCeiling {
  /** The consumer's R19 declared-capability ceiling. */
  capabilities: readonly CapabilityId[];
  /** The consumer's tier. */
  tier: ScriptAccessLevel;
}

/** The result of intersecting one library against one consumer. */
export interface EffectiveCeiling {
  capabilities: CapabilityId[];
  tier: ScriptAccessLevel;
  /** Capabilities the library declared that the consumer did not. Dropped from
   *  the ceiling — retained so the UI can SAY so instead of leaving the user
   *  with an unexplained PermissionDenied at runtime. */
  narrowed: CapabilityId[];
  /** A stable key for realm dedup: two consumers with the same key share a
   *  library realm (see linker.ts for the covert-channel trade-off). */
  key: string;
}

/** min() over the two-value tier lattice (restricted < unlocked). */
export function minTier(a: ScriptAccessLevel, b: ScriptAccessLevel): ScriptAccessLevel {
  return a === "unlocked" && b === "unlocked" ? "unlocked" : "restricted";
}

/**
 * Compute a library's effective ceiling against a consumer.
 *
 * `libraryDeclared` MUST be the pragma-derived set from the library's verified
 * source (parseModulePragmas), not a manifest field — a manifest that claims
 * less than the code declares would otherwise become a transparency lie.
 */
export function intersectCeiling(
  libraryDeclared: readonly CapabilityId[],
  consumer: ConsumerCeiling,
  libraryTier: ScriptAccessLevel = "restricted",
): EffectiveCeiling {
  const consumerSet = new Set<CapabilityId>(consumer.capabilities);
  const capabilities: CapabilityId[] = [];
  const narrowed: CapabilityId[] = [];
  for (const cap of new Set(libraryDeclared)) {
    if (consumerSet.has(cap)) capabilities.push(cap);
    else narrowed.push(cap);
  }
  capabilities.sort();
  narrowed.sort();
  const tier = minTier(libraryTier, consumer.tier);
  return { capabilities, tier, narrowed, key: `${tier}|${capabilities.join(",")}` };
}

/**
 * Chain the rule through a transitive dependency: `effective(dep) =
 * declared(dep) INTERSECT effective(parent)`. Written as an explicit function
 * (rather than "call intersectCeiling with the parent's set") so the transitive
 * case cannot be forgotten at a call site — a depth-2 dependency that was
 * intersected against the ROOT consumer instead of against its parent would
 * silently re-widen whatever the parent had already given up.
 */
export function chainCeiling(
  dependencyDeclared: readonly CapabilityId[],
  parentEffective: EffectiveCeiling,
): EffectiveCeiling {
  return intersectCeiling(
    dependencyDeclared,
    { capabilities: parentEffective.capabilities, tier: parentEffective.tier },
    parentEffective.tier,
  );
}

/**
 * The net.fetch origins a library realm may be granted: the library's own
 * declared origins INTERSECTED with the consumer's. An origin the consumer did
 * not declare is dropped for the same reason a capability is — a library must
 * not be able to name a host its importer never disclosed.
 */
export function intersectOrigins(
  libraryOrigins: readonly string[],
  consumerOrigins: readonly string[],
): string[] {
  const allowed = new Set(consumerOrigins);
  return [...new Set(libraryOrigins)].filter((o) => allowed.has(o)).sort();
}

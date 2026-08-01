//! FILENAME: app/src/shell/registries/extensionTrust.ts
// PURPOSE: Trust classification + declared-capability ceiling for extensions
//          (Wave 3 / S8-C7). Kept as a small, dependency-light module (only the
//          capability vocabulary) so the policy is unit-testable without pulling
//          in the full ExtensionManager and its UI-registry dependencies.

import { CAPABILITY_ID_SET, type CapabilityId } from "../../api/scriptHost/capabilityIds";
import {
  extensionReachableCapabilities,
  normalizeContributionDeclaration,
  type ExtContributionDeclaration,
} from "../../api/scriptHost/extensionProtocol";
import type { ExtensionTrust } from "../../api/extensionManager";

/**
 * `ExtensionTrust` is defined in @api (extensionManager) and re-exported here for
 * the shell-internal policy functions below.
 *  - "trusted": built-in / first-party (extensions/manifest.ts). Full host
 *    authority — not ceiling-bound.
 *  - "distributed": third-party bundle from the user's extensions directory.
 *    Bounded by a declared-capability CEILING (deny-by-default), and surfaced in
 *    the transparency panel. Untrusted code must run SANDBOXED in a worker realm
 *    (workerSupport:true); it is refused on the main thread, where it would get
 *    full ambient window/Tauri/@api authority that the broker/ceiling cannot
 *    bound (see mayActivateOnMainThread). Browser-fetch exfiltration is also
 *    contained by the app CSP connect-src allowlist.
 */
export type { ExtensionTrust };

/**
 * May an extension run on the MAIN thread (full ambient window/Tauri/@api
 * authority)? Only trusted built-ins. Distributed (untrusted) code that lacks
 * worker isolation is refused — a consent dialog must NOT be able to authorize
 * full machine access (the founding vision: "never with full machine access
 * like VBA macros"). Such an extension simply does not activate.
 *
 * DELIBERATELY UNCHANGED by the third-party add-in slice
 * (docs/design/third-party-addin-authoring.md). That work made the SANDBOX
 * capable — worksheet functions, ribbon buttons, shortcuts, cell styling, file
 * import — precisely so that this predicate never has to widen. A signature
 * proves WHO wrote code, not WHAT it does; it may raise the capability ceiling
 * and lower consent friction, but it must never change the execution realm. If
 * a future feature seems to need `trust === "publisher"` here, the feature is
 * wrong, not this line.
 */
export function mayActivateOnMainThread(trust: ExtensionTrust): boolean {
  return trust === "trusted";
}

/**
 * The R19 declared-capability ceiling for an extension.
 *  - trusted   -> [] by convention (full authority, not ceiling-bound).
 *  - distributed -> exactly the RECOGNIZED capabilities the manifest declared
 *    THAT A SANDBOXED EXTENSION CAN ACTUALLY USE; unknown ids are dropped and
 *    declaring nothing means deny-by-default.
 *
 * WHY THE SECOND FILTER EXISTS. A sandboxed extension reaches the broker through
 * `EXTENSION_BROKER_METHODS`, which is a strict subset of the shared ALLOWLIST —
 * so several capability ids in the vocabulary have no method a sandboxed
 * extension can call. Filtering only by "is this a real capability id" let three
 * of them (`ui.html`, `bi.connector`, and — added by the keyboard-shortcut work
 * — `ui.shortcut`) into the ceiling, into the grant set, and from there into the
 * consent prompt's "Capabilities it can use:" line, which named reach that did
 * not exist.
 *
 * That is the mirror image of the bug class this program has already shipped
 * four times (a capability id that was silently UNgrantable). It grants nothing,
 * so it is not an escalation — but it is a FALSE CONSENT STRING, and consent
 * that overstates is not a safe direction to be wrong in: it teaches the user
 * that the list is approximate, and the next list they wave through is the one
 * that mattered.
 *
 * Dropped ids are returned by {@link unreachableExtensionCapabilities} so the
 * caller can say so out loud instead of silently narrowing.
 */
export function computeExtensionCeiling(
  declared: CapabilityId[] | undefined,
  trust: ExtensionTrust,
): CapabilityId[] {
  if (trust === "trusted") return [];
  const reachable = extensionReachableCapabilities();
  return (declared ?? []).filter(
    (c): c is CapabilityId => CAPABILITY_ID_SET.has(c) && reachable.has(c),
  );
}

/**
 * The recognized capabilities a manifest declared that a sandboxed extension can
 * never exercise — i.e. what {@link computeExtensionCeiling} just dropped.
 *
 * Reported rather than swallowed: a publisher who declares `ui.html` has
 * misunderstood the sandbox and should find out, and a user reading the add-in's
 * details should see the same list the consent prompt was built from.
 */
export function unreachableExtensionCapabilities(
  declared: CapabilityId[] | undefined,
  trust: ExtensionTrust,
): CapabilityId[] {
  if (trust === "trusted") return [];
  const reachable = extensionReachableCapabilities();
  return (declared ?? []).filter(
    (c): c is CapabilityId => CAPABILITY_ID_SET.has(c) && !reachable.has(c),
  );
}

/**
 * The CONTRIBUTION ceiling for an extension: which host surfaces it may appear
 * in, and under which ids.
 *
 * WHY THIS IS NOT SIGNATURE-GATED THE WAY CAPABILITIES ARE. A capability grants
 * reach OUTSIDE the document (network, storage, BI, the user's attention), so an
 * unverifiable declaration of one must buy nothing — hence
 * `computeExtensionCeiling` is zeroed by the caller for an unsigned/invalid
 * sidecar. A contribution declaration grants nothing: it can only NARROW what
 * the bundle would otherwise register, and for an unsigned bundle the
 * declaration and the code have the same (unverified) author. What it always
 * buys is DISCLOSURE — the sidecar is read without executing the bundle, so the
 * exact set of functions, menu items and shortcuts an add-in will install is
 * knowable before it runs, and consent can show it. For a SIGNED bundle it
 * additionally becomes a real ceiling the publisher cannot widen after the fact.
 *
 * Worksheet functions stay effectively signature-gated regardless: they also
 * require the `formula.udf` capability, which IS zeroed without a good
 * signature — so an unsigned add-in cannot add worksheet functions no matter
 * what it declares here.
 *
 *  - trusted     -> {} by convention (built-ins are not ceiling-bound; they use
 *                   the full main-thread ExtensionContext).
 *  - distributed -> the normalized declaration (unknown kinds and non-string
 *                   entries dropped; declaring nothing means deny-by-default).
 */
export function computeContributionCeiling(
  declared: unknown,
  trust: ExtensionTrust,
): ExtContributionDeclaration {
  if (trust === "trusted") return {};
  return normalizeContributionDeclaration(declared);
}

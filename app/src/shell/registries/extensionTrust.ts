//! FILENAME: app/src/shell/registries/extensionTrust.ts
// PURPOSE: Trust classification + declared-capability ceiling for extensions
//          (Wave 3 / S8-C7). Kept as a small, dependency-light module (only the
//          capability vocabulary) so the policy is unit-testable without pulling
//          in the full ExtensionManager and its UI-registry dependencies.

import { CAPABILITY_ID_SET, type CapabilityId } from "../../api/scriptHost/capabilityIds";

/**
 * Trust class of an extension.
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
export type ExtensionTrust = "trusted" | "distributed";

/**
 * May an extension run on the MAIN thread (full ambient window/Tauri/@api
 * authority)? Only trusted built-ins. Distributed (untrusted) code that lacks
 * worker isolation is refused — a consent dialog must NOT be able to authorize
 * full machine access (the founding vision: "never with full machine access
 * like VBA macros"). Such an extension simply does not activate.
 */
export function mayActivateOnMainThread(trust: ExtensionTrust): boolean {
  return trust === "trusted";
}

/**
 * The R19 declared-capability ceiling for an extension.
 *  - trusted   -> [] by convention (full authority, not ceiling-bound).
 *  - distributed -> exactly the RECOGNIZED capabilities the manifest declared;
 *    unknown ids are dropped and declaring nothing means deny-by-default.
 */
export function computeExtensionCeiling(
  declared: CapabilityId[] | undefined,
  trust: ExtensionTrust,
): CapabilityId[] {
  if (trust === "trusted") return [];
  return (declared ?? []).filter((c): c is CapabilityId => CAPABILITY_ID_SET.has(c));
}

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
 *    the transparency panel. Runtime isolation of its direct Tauri access is
 *    Phase B (worker realm); browser-fetch exfiltration is already contained by
 *    the app CSP connect-src allowlist.
 */
export type ExtensionTrust = "trusted" | "distributed";

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

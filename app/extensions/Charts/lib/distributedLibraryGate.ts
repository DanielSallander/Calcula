//! FILENAME: app/extensions/Charts/lib/distributedLibraryGate.ts
// PURPOSE: Consent gate for a reserved SANDBOXED library (chart transforms, chart
//          marks) that arrived inside a DISTRIBUTED .calp package. The project
//          vision requires that "scripts arriving in distributed packages must not
//          run without explicit consent" — but the reserved libraries auto-mounted
//          on open regardless of provenance. This gate closes that hole by treating
//          the library as ONE "script" in the SHARED distributed-consent store
//          (@api/distributedConsent), keyed under a namespaced packageName so it
//          never collides with object-script consent for the same .calp.
// CONTEXT: Charts-extension code (it owns the open lifecycle + the consent dialog).
//          It is artifact-agnostic: transforms and marks both flow through it via a
//          LibraryGateDescriptor, so the two identical holes are closed once.

import {
  loadConsents,
  isConsentCurrent,
  recordConsent,
  applyConsentedCapabilities,
  describeCapability,
  type CapabilityGrant,
} from "@api";
import type { CapabilityId } from "@api";

/** A reserved distributed library to gate. The caller (Charts/index.ts) builds one
 *  per artifact kind (transform / mark) from the loaded library + provenance. */
export interface LibraryGateDescriptor {
  /** Stable consent-view script id (CHART_TRANSFORMS_SCRIPT_ID / CHART_MARKS_SCRIPT_ID). */
  scriptId: string;
  /** Consent store key — NAMESPACED ("chart-transforms:<pkg>") so it never clobbers
   *  the object-script consent record stored under the bare package name. */
  consentKey: string;
  /** The real .calp package name shown to the user (publisher identity). */
  displayPackage: string;
  /** Human label for the artifact kind, e.g. "chart transform" / "chart mark". */
  artifactLabel: string;
  /** Per-item display names (transform types / mark ids) listed in the prompt. */
  itemNames: string[];
  /** Capabilities the library declares (transforms: lib.capabilities; marks: []). */
  capabilities: CapabilityId[];
  /** The canonical consent source (cap pragmas + JSON for transforms; JSON for
   *  marks) — hashed by the store so any edit / capability expansion re-prompts. */
  syntheticSource: string;
  /** Mount the library (installConsentedChartTransforms / installChartMarkLibrary). */
  install: () => Promise<void>;
}

/** The one-script consent view the store checks/records for this library. */
function consentView(d: LibraryGateDescriptor): Array<{ id: string; source: string }> {
  return [{ id: d.scriptId, source: d.syntheticSource }];
}

/**
 * Whether a persisted consent already covers this EXACT library (same source hash
 * + same declared caps). Pure check, NO side effects — the caller mounts (via
 * {@link mountConsentedLibrary}) only after re-checking its own freshness (epoch),
 * so an in-flight workbook switch can't mount stale code.
 */
export async function isLibraryConsentCurrent(d: LibraryGateDescriptor): Promise<boolean> {
  return isConsentCurrent(await loadConsents(), d.consentKey, consentView(d));
}

/** Apply the library's consented capabilities and mount it (no persistence) — used
 *  when {@link isLibraryConsentCurrent} is already true. */
export async function mountConsentedLibrary(d: LibraryGateDescriptor): Promise<void> {
  await applyConsentedCapabilities(d.scriptId, d.capabilities, []);
  await d.install();
}

/**
 * Apply consent for a distributed library the user just approved: grant its
 * declared capabilities, mount it, and PERSIST the consent (durable once the .cala
 * is saved) so a later open does not re-prompt — keyed by source hash + granted
 * caps, so an upstream change or capability expansion re-prompts.
 */
export async function grantLibraryConsent(d: LibraryGateDescriptor): Promise<void> {
  const granted: CapabilityGrant[] = d.capabilities.map((c) => ({ capability: c }));
  // PERSIST BEFORE MOUNTING. The mount boundary asks the backend whether this
  // workbook has approved the application, and it reads the consent STORE — so a
  // grant that mounts first is asking about an approval it has not written yet.
  // The mount is refused, this function rejects, and line 78 never runs: nothing
  // is persisted, so the same prompt returns on the next open, forever. Recording
  // first is also what `grantCustomFunctionConsent` and the library installer do.
  //
  // A record that outlives a failed mount is the right way round: the user DID
  // approve this code, the approval is what the next open needs to mount it, and
  // the failure is surfaced to them by the caller rather than silently retried.
  await recordConsent(d.consentKey, consentView(d), granted);
  await mountConsentedLibrary(d);
}

/** Capability descriptors for the consent dialog (id + human description). */
export function requestedCapabilityDescriptors(
  caps: CapabilityId[],
): Array<{ capability: CapabilityId; description: string; origins: string[] }> {
  return caps.map((c) => ({ capability: c, description: describeCapability(c), origins: [] }));
}

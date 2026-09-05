//! FILENAME: app/src/api/scriptHost/mountConsentSurface.ts
// PURPOSE: The closed vocabulary of SURFACES distributed code can mount on —
//          the discriminant a mount sends to the Rust consent gate so it is
//          judged under ONE consent-store key, its own, instead of under every
//          key an application's name can be spelled with.
//
// CONTEXT: `.calcula/script-consent.json` has six writers and each namespaces
//          its records, so approving an application's chart marks neither
//          clobbers nor inherits the approval of its object scripts:
//
//              object-script          <application>                 (bare)
//              chart-marks            chart-marks:<application>
//              chart-transforms       chart-transforms:<application>
//              custom-functions       custom-functions:<application>
//              lib                    lib:<application>
//              writeback-validators   <application>::writeback-validators
//
//          The mount gate (`check_distributed_mount_consent`,
//          app/src-tauri/src/scripting/commands.rs) used to expand the name into
//          all six and admit the mount when ANY held a record — so approving a
//          REPORT application called `acme.stats` satisfied the floor for a
//          LIBRARY called `acme.stats`, the very collision `scriptLibraries/
//          consentKey.ts` exists to prevent. Each mount route now names its
//          surface and Rust narrows to that surface's key.
//
//          THIS IS A CLAIM THE RENDERER MAKES. A compromised renderer can name
//          whichever surface holds a record, which leaves it exactly where the
//          any-namespace floor already left it — no weaker, no stronger. Under
//          an honest renderer the separation is real. A mount that names no
//          surface, or one Rust does not know, is REFUSED — it does not fall
//          back to the coarse floor.
//
//          THE KEY MAPPING LIVES IN RUST (`CONSENT_SURFACES`), not here: the
//          TypeScript key-formers are six separate functions, each the ONE place
//          its key is spelled, and this union deliberately adds no seventh. The
//          drift test (`app/src/api/__tests__/mountConsentKeyDrift.test.ts`)
//          pins this union, the Rust table and every key-former against each
//          other, and pins that every mount route names a member.

/**
 * Which kind of distributed code a mount is, in the Rust gate's wire spelling.
 * A member per consent-store namespace; the bare key belongs to `object-script`
 * ONLY (object scripts and the module macros a `.calp` ships share one grant).
 */
export type MountConsentSurface =
  | "object-script"
  | "chart-marks"
  | "chart-transforms"
  | "custom-functions"
  | "lib"
  | "writeback-validators";

/**
 * One artifact a mount IS, as its surface's consent record lists it: the id the
 * record carries and the EXACT source the user approved — never the composed
 * realm source, which carries a host-generated prelude no record has seen.
 * For a surface whose consent identity is synthetic (a chart library's canonical
 * JSON, a UDF package's pragma-plus-canonical-functions string) it is that
 * string, produced by the same former that recorded it.
 */
export interface MountConsentArtifact {
  id: string;
  source: string;
}

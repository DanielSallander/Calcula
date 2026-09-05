//! FILENAME: app/src/api/scriptLibraries/consentKey.ts
// PURPOSE: The key a script library's consent record is stored under in
//          `.calcula/script-consent.json`.
// CONTEXT: Libraries reuse `@api/distributedConsent` unchanged — one consent
//          store for every distributed-code surface — so they need a key that
//          cannot collide with a REPORT package of the same name subscribed into
//          the same workbook. `lib:` namespaces it, mirroring how distributed
//          extensions namespace their TOFU pins as `ext:<id>`.
// SECURITY: A collision here would be a real hole: approving a report package
//           called "acme.stats" would otherwise silently satisfy the consent
//           check for a LIBRARY called "acme.stats", mounting code the user
//           never reviewed. Keep this as the ONE place the key is formed.
//
//           That separation is enforced in TWO places, and they are not equal.
//           The linker's own `isConsentCurrent` check reads this key and no
//           other. The Rust mount gate (`check_distributed_mount_consent`,
//           app/src-tauri/src/scripting/commands.rs) is told the mount's
//           SURFACE (`consentSurface: "lib"`) and narrows to `lib:<package>` —
//           but the surface is a claim the renderer makes, so under a
//           compromised renderer the Rust side is exactly as strong as an
//           any-namespace floor, and under an honest one the separation holds
//           on both sides. The Rust row for this key is pinned against the
//           literal below by app/src/api/__tests__/mountConsentKeyDrift.test.ts.

/** The consent-store key for a library package. */
export function consentKeyFor(packageName: string): string {
  return `lib:${packageName}`;
}

/** The package name behind a library consent key, or null if it is not one. */
export function packageFromConsentKey(key: string): string | null {
  return key.startsWith("lib:") ? key.slice(4) : null;
}

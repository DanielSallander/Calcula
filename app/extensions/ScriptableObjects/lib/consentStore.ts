//! FILENAME: app/extensions/ScriptableObjects/lib/consentStore.ts
// PURPOSE: Thin re-export shim. The durable distributed-script consent store was
//          PROMOTED to @api/distributedConsent so every distributed-code surface
//          (object scripts here, the sandboxed chart-transform/chart-mark
//          libraries in the Charts extension) shares ONE consent store + file
//          (.calcula/script-consent.json) rather than each inventing a parallel
//          one. This file re-exports it so existing ScriptableObjects imports +
//          tests are unchanged.

export {
  sha256Hex,
  loadConsents,
  recordConsent,
  isConsentCurrent,
  getChangedScripts,
} from "@api/distributedConsent";
export type {
  ConsentedScript,
  CapabilityGrant,
  ConsentRecord,
  ChangedScript,
} from "@api/distributedConsent";

//! FILENAME: app/extensions/ScriptableObjects/lib/consentStore.ts
// PURPOSE: Thin re-export shim. The durable distributed-script consent store was
//          PROMOTED to @api/distributedConsent so every distributed-code surface
//          (object scripts here, the sandboxed chart-transform/chart-mark
//          libraries in the Charts extension) shares ONE consent store + file
//          (.calcula/script-consent.json) rather than each inventing a parallel
//          one. This file re-exports it so existing ScriptableObjects imports +
//          tests are unchanged.
//          NOTE: this store is for DISTRIBUTED code only. A workbook's OWN local
//          scripts are governed by the per-workbook trust store in
//          @api/scriptSecurity, which is persisted on the local machine (never in
//          the file) precisely because it must NOT travel with a copy. Do not
//          conflate the two: package consent must survive a copy, run-trust must
//          not.

export {
  sha256Hex,
  loadConsents,
  recordConsent,
  isConsentCurrent,
  getChangedScripts,
  diffScriptSets,
  declaredCapabilitySet,
} from "@api/distributedConsent";
export type {
  ConsentedScript,
  CapabilityGrant,
  ConsentRecord,
  ChangedScript,
} from "@api/distributedConsent";

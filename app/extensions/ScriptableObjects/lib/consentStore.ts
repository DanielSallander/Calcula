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
//          the file). Package approvals ARE kept in the file, but each one is
//          sealed to the computer that made it (app/src-tauri/src/consent_seal.rs):
//          it counts only on that computer, and only for the exact bytes under
//          that application name, so a copy opened on another computer asks
//          again. Records this computer sealed can be copied between
//          workbooks -- a workbook sent away and back, or records lifted from
//          one this computer saved, count here again -- which re-uses the
//          user's own earlier approval of those bytes; it never forges one.

export {
  sha256Hex,
  loadConsents,
  loadConsentReport,
  recordConsent,
  isConsentCurrent,
  areScriptsConsented,
  getChangedScripts,
  diffScriptSets,
  declaredCapabilitySet,
} from "@api/distributedConsent";
export type {
  ConsentedScript,
  CapabilityGrant,
  ConsentRecord,
  ChangedScript,
  ConsentReport,
  IgnoredConsent,
  ConsentIgnoredReason,
} from "@api/distributedConsent";

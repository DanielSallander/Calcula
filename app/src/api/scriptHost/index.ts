//! FILENAME: app/src/api/scriptHost/index.ts
// PURPOSE: Facade for the script host (sandbox design §11 Phase 3): the
//          worker-realm mount path, validation, render blit providers, and
//          the policy/transparency surface.

export {
  hostMountScript,
  hostUnmountScript,
  hostIsMounted,
  hostResetAll,
  hostValidateScript,
  workerRealmAvailable,
  listFaultedScripts,
  // Cancellable workbook lifecycle (B5): the save/close verdict machinery.
  callWorkbookBeforeLifecycle,
  raceLifecycleVerdict,
  normalizeLifecycleVerdict,
  type WorkbookLifecycleVerdict,
  getShapeBitmap,
  hasShapeBitmapRenderer,
  getSlicerItemBitmap,
  hasSlicerItemBitmapRenderer,
  type HostMountDefinition,
} from "./host";

export {
  registerCellRenderCache,
  invalidateCellRenderCache,
  getCellRenderStats,
  clearBitmapCaches,
} from "./renderCache";

export { ALLOWLIST, SCRIPT_SUBSCRIBABLE_APP_EVENTS } from "./allowlist";
export type { MethodPolicy, Tier, CapabilityId, MethodClass } from "./allowlist";
// Single source of truth for the capability vocabulary (Wave 3 substrate).
export { ALL_CAPABILITY_IDS, CAPABILITY_ID_SET, isCapabilityId } from "./capabilityIds";
// Shared broker-error -> surface-failure mapping (UDF cell errors, ext status).
export {
  brokerErrorCode,
  brokerErrorToCellError,
  brokerErrorReason,
  type CellErrorText,
} from "./errorMap";
export { getAuditTail, getAuditTotal, onAudit, clearAudit } from "./auditRing";
export type { AuditEntry } from "./auditRing";
export {
  BrokerError,
  buildHandleFromDefinition,
  listMountedHandles,
  listExposed,
} from "./broker";
export type { ScriptHandle, RpcErrorCode } from "./broker";
export { PROTOCOL_VERSION } from "./protocol";

// Distributed-extension worker realm (Wave 3 / S8-C7 Phase B): sandboxed
// execution of opted-in third-party extensions.
export {
  mountWorkerExtension,
  unmountWorkerExtension,
  listWorkerExtensions,
  resetWorkerExtensions,
  type WorkerExtensionMountResult,
} from "./extensionWorkerHost";
export { EXTENSION_PROTOCOL_VERSION } from "./extensionProtocol";

// Capability grants (Phase 4): the JIT/consent dialog resolves requests here;
// the transparency panel reads + revokes grants.
export {
  resolveCapabilityRequest,
  getGrantedOrigins,
  getScriptGrants,
  revokeCapability,
} from "./capabilities";
export type { CapabilityRequestPayload, CapabilityDecision } from "./capabilities";
// Declared/consented capabilities (Phase 4.2a): pragma parse + grant chokepoint.
export { parseDeclaredCapabilities, applyConsentedCapabilities } from "./capabilities";
export type { DeclaredCapabilities } from "./capabilities";

// Persistent scheduled jobs (the `schedule` capability). The trusted-UI half is
// exported so the transparency panel can SHOW and CANCEL every job in the
// workbook — a persistent, self-starting job the user cannot see or stop would
// be exactly the thing that got VBA distrusted.
export {
  listAllScheduledJobs,
  cancelScheduledJob,
  setScheduledJobEnabled,
  syncPump as syncSchedulerPump,
  stopSchedulerPump,
} from "./scheduler";
export type { ScheduledJob } from "./scheduler";

// ui.dialog (B4): the trusted renderer picks requests up from the app event and
// answers them here. Everything else about a dialog is internal to the host.
export {
  resolveScriptDialog,
  dismissScriptDialog,
  getActiveScriptDialog,
  isScriptDialogMuted,
  resetScriptDialogs,
  MAX_CONSECUTIVE_DISMISSALS,
  SCRIPT_DIALOG_REQUEST_EVENT,
  SCRIPT_DIALOG_CANCELLED_EVENT,
} from "./scriptDialogs";
export type { ScriptDialogRequestPayload, ScriptDialogAnswer, ScriptDialogKind } from "./scriptDialogs";
export {
  DIALOG_FIELD_TYPES,
  MAX_DIALOG_FIELDS,
  normalizeDialogOption,
} from "./scriptDialogSpec";
export type {
  ScriptDialogField,
  ScriptDialogFieldType,
  ScriptDialogFormSpec,
  ScriptDialogOption,
  ScriptDialogPromptOptions,
  ScriptDialogTextOptions,
} from "./scriptDialogSpec";

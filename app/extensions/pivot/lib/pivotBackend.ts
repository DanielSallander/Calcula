//! FILENAME: app/extensions/Pivot/lib/pivotBackend.ts
// PURPOSE: Capability-scoped backend door for Pivot code outside ExtensionContext
//          (lib-api/store/components). Bound to ctx.invokeBackend in activate() (A3).
import { createBackendChannel } from "@api/backendCommands";

export const pivotBackend = createBackendChannel("Pivot");

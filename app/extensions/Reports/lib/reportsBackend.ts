//! FILENAME: app/extensions/Reports/lib/reportsBackend.ts
// PURPOSE: Capability-scoped backend door for Reports code outside ExtensionContext.
//          Bound to ctx.invokeBackend in activate() (A3).
import { createBackendChannel } from "@api/backendCommands";

export const reportsBackend = createBackendChannel("Reports");

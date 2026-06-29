//! FILENAME: app/extensions/Charts/lib/chartsBackend.ts
// PURPOSE: Capability-scoped backend door for Charts code outside ExtensionContext
//          (lib-api/store/components). Bound to ctx.invokeBackend in activate() (A3).
import { createBackendChannel } from "@api/backendCommands";

export const chartsBackend = createBackendChannel("Charts");

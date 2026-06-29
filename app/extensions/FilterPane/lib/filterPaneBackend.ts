//! FILENAME: app/extensions/FilterPane/lib/filterPaneBackend.ts
// PURPOSE: Capability-scoped backend door for FilterPane code outside ExtensionContext
//          (lib-api/store/components). Bound to ctx.invokeBackend in activate() (A3).
import { createBackendChannel } from "@api/backendCommands";
export const filterPaneBackend = createBackendChannel("FilterPane");

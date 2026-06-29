//! FILENAME: app/extensions/Controls/lib/controlsBackend.ts
// PURPOSE: Capability-scoped backend door for Controls code outside ExtensionContext
//          (lib-api/store/components). Bound to ctx.invokeBackend in activate() (A3).
import { createBackendChannel } from "@api/backendCommands";

export const controlsBackend = createBackendChannel("Controls");

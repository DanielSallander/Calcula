//! FILENAME: app/extensions/Slicer/lib/slicerBackend.ts
// PURPOSE: Capability-scoped backend door for Slicer code outside ExtensionContext
//          (lib-api/store/components). Bound to ctx.invokeBackend in activate() (A3).
import { createBackendChannel } from "@api/backendCommands";
export const slicerBackend = createBackendChannel("Slicer");

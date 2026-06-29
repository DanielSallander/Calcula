//! FILENAME: app/extensions/TimelineSlicer/lib/timelineBackend.ts
// PURPOSE: Capability-scoped backend door for TimelineSlicer code outside ExtensionContext
//          (lib-api/store/components). Bound to ctx.invokeBackend in activate() (A3).
import { createBackendChannel } from "@api/backendCommands";

export const timelineBackend = createBackendChannel("TimelineSlicer");

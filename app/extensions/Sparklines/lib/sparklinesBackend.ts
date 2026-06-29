//! FILENAME: app/extensions/Sparklines/lib/sparklinesBackend.ts
// PURPOSE: Capability-scoped backend door for Sparklines code outside ExtensionContext
//          (store). Bound to ctx.invokeBackend in activate() (A3).
import { createBackendChannel } from "@api/backendCommands";

export const sparklinesBackend = createBackendChannel("Sparklines");

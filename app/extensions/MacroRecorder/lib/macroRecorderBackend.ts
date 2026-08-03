//! FILENAME: app/extensions/MacroRecorder/lib/macroRecorderBackend.ts
// PURPOSE: Capability-scoped backend door for MacroRecorder code outside the
//          ExtensionContext (lib helpers). Bound to ctx.invokeBackend in
//          activate(); the raw @api/backend passthrough is denied to extensions.
import { createBackendChannel } from "@api/backendCommands";

export const macroRecorderBackend = createBackendChannel("MacroRecorder");

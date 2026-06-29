//! FILENAME: app/extensions/ScriptNotebook/lib/notebookBackend.ts
// PURPOSE: Capability-scoped backend door for ScriptNotebook code outside ExtensionContext
//          (lib-api/store/components). Bound to ctx.invokeBackend in activate() (A3).
import { createBackendChannel } from "@api/backendCommands";

export const notebookBackend = createBackendChannel("ScriptNotebook");

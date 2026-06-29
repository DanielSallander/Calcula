//! FILENAME: app/extensions/ScriptEditor/lib/scriptEditorBackend.ts
// PURPOSE: Capability-scoped backend door for ScriptEditor code outside ExtensionContext
//          (lib-api/store/components). Bound to ctx.invokeBackend in activate() (A3).
//          CROSS-WINDOW: scriptApi.ts is consumed both by the main window AND by the
//          standalone Monaco editor window (src/scriptEditorMain.tsx), which binds this
//          same channel instance with its own scoped invoker since activate() does not run there.
import { createBackendChannel } from "@api/backendCommands";

export const scriptEditorBackend = createBackendChannel("ScriptEditor");

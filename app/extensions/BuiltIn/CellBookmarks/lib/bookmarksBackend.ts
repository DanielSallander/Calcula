//! FILENAME: app/extensions/BuiltIn/CellBookmarks/lib/bookmarksBackend.ts
// PURPOSE: Capability-scoped backend door for CellBookmarks code outside ExtensionContext
//          (lib-api/store/components). Bound to ctx.invokeBackend in activate() (A3).
import { createBackendChannel } from "@api/backendCommands";

export const bookmarksBackend = createBackendChannel("CellBookmarks");

//! FILENAME: app/extensions/CsvImportExport/lib/csvBackend.ts
// PURPOSE: Capability-scoped backend door for CsvImportExport code outside
//          ExtensionContext (lib-api/store/components). Bound to
//          ctx.invokeBackend in activate() (A3).
import { createBackendChannel } from "@api/backendCommands";

export const csvBackend = createBackendChannel("CsvImportExport");
